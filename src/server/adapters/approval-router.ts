/**
 * Slack-backed approval router (issue #44): implements the policy
 * `ApprovalRouter` seam by posting an interactive approve/deny prompt to the
 * space channel and resolving the pending gate promise when a human clicks a
 * button (Bolt block actions `bottega_approve` / `bottega_deny`, both
 * carrying the request id).
 *
 * Pending requests live in an in-memory registry keyed by request id, per
 * space (the id is globally unique; entries record their space). The
 * registry is bounded — the oldest entry is evicted (denied) at capacity —
 * and every entry self-evicts on its timeout (policy
 * `approvals.timeout_minutes`, default 5 min) → deny, with the posted
 * message updated in place to show the outcome.
 *
 * The router never writes audit rows itself: the policy extension audits
 * `approval.requested` / `approval.resolved` around the `request()` call
 * (issue #33 vocabulary).
 */
import { randomUUID } from "node:crypto";
import type { ApprovalRequest, ApprovalResolution, ApprovalRouter } from "../../policy/approval-router";
import { redact } from "../../policy/audit";
import { DEFAULT_TIMEOUT_MINUTES } from "../../policy/config";
import { APPROVE_ACTION_ID, DENY_ACTION_ID, type SlackAction, type SlackAdapter } from "./slack";

/** Cap for the args summary rendered in the approval prompt (redacted first). */
export const ARGS_SUMMARY_MAX_CHARS = 2000;

/** Registry bound: at capacity the oldest pending request is evicted (denied). */
export const MAX_PENDING_REQUESTS = 64;

interface PendingRequest {
  id: string;
  spaceId: string;
  tool: string;
  /** Ts of the posted prompt; "" until the post resolves. */
  messageTs: string;
  timer: ReturnType<typeof setTimeout>;
  resolve: (r: ApprovalResolution) => void;
  settled: boolean;
  /** Outcome captured at settle time, replayed onto the message once its ts lands. */
  outcome?: { resolution: ApprovalResolution; label: string };
}

export interface SlackApprovalRouterDeps {
  /** Message surface: prompts go out via postMessage, outcomes via updateMessage. */
  adapter: Pick<SlackAdapter, "postMessage" | "updateMessage">;
  /** How long a request stays pending before it denies. Defaults to the policy default (5 min). */
  timeoutMs?: number;
  /** Bounded-registry cap; oldest entry evicted (denied) beyond this. Default {@link MAX_PENDING_REQUESTS}. */
  maxPending?: number;
  /** Observability seam; defaults to console.log. */
  log?: (line: string) => void;
}

/**
 * Renders the interactive approval prompt blocks: tool + reason + redacted
 * args summary, then Approve/Deny buttons carrying the request id. Pure so
 * the outbound rendering is testable without Slack.
 */
export function buildApprovalBlocks(d: ApprovalRequest, id: string): unknown[] {
  const argsText = redact(JSON.stringify(d.args) ?? "");
  const args =
    argsText.length > ARGS_SUMMARY_MAX_CHARS ? `${argsText.slice(0, ARGS_SUMMARY_MAX_CHARS)}...[truncated]` : argsText;
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: `*Approval required* — \`${d.tool}\`` },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Reason:* ${d.reason}\n*Args:* \`\`\`${args}\`\`\``,
      },
    },
    {
      type: "actions",
      block_id: "bottega_approval",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Approve" },
          action_id: APPROVE_ACTION_ID,
          value: id,
          style: "primary",
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Deny" },
          action_id: DENY_ACTION_ID,
          value: id,
          style: "danger",
        },
      ],
    },
  ];
}

/** Outcome line replacing the prompt message once a request settles. */
function outcomeText(entry: PendingRequest, r: ApprovalResolution, label: string): string {
  const verb = r.approved ? `Approved by <@${r.approver ?? "unknown"}>` : label;
  return `*Approval resolved* — \`${entry.tool}\`: ${verb}.`;
}

export class SlackApprovalRouter implements ApprovalRouter {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly adapter: Pick<SlackAdapter, "postMessage" | "updateMessage">;
  private readonly timeoutMs: number;
  private readonly maxPending: number;
  private readonly log: (line: string) => void;

  constructor(deps: SlackApprovalRouterDeps) {
    this.adapter = deps.adapter;
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MINUTES * 60_000;
    this.maxPending = deps.maxPending ?? MAX_PENDING_REQUESTS;
    this.log = deps.log ?? ((line) => console.log(line));
  }

  /** Number of unresolved pending requests (registry observability for tests). */
  get pendingCount(): number {
    return this.pending.size;
  }

  async request(d: ApprovalRequest): Promise<ApprovalResolution> {
    const id = randomUUID();
    if (this.pending.size >= this.maxPending) {
      const oldest = this.pending.values().next().value as PendingRequest | undefined;
      if (oldest !== undefined) {
        this.log(`[approvals] registry full — evicting request ${oldest.id}`);
        this.settle(oldest, { approved: false }, "evicted (registry full)");
      }
    }
    const { promise, resolve } = Promise.withResolvers<ApprovalResolution>();
    // Reserve the entry synchronously: the timeout clock starts when the
    // request lands (not when the post returns), the registry bound is
    // accurate under back-to-back requests, and a click that races the
    // post's response still finds its entry (the buttons can only be
    // clicked once the message exists, but tests drive the click
    // deterministically).
    const entry: PendingRequest = {
      id,
      spaceId: d.spaceId,
      tool: d.tool,
      messageTs: "",
      timer: setTimeout(() => {
        this.settle(entry, { approved: false }, "expired (no response within timeout)");
      }, this.timeoutMs),
      resolve,
      settled: false,
    };
    // Never hold the process open waiting for a button that may not come.
    entry.timer.unref?.();
    this.pending.set(id, entry);
    try {
      const messageTs = await this.adapter.postMessage(d.spaceId, `Approval required for ${d.tool}`, {
        blocks: buildApprovalBlocks(d, id),
      });
      if (messageTs === undefined) {
        // Fail closed: an unroutable prompt denies the request.
        this.log(`[approvals] postMessage returned no ts for request ${id} — denying`);
        this.settle(entry, { approved: false }, "post returned no message ts");
      } else {
        entry.messageTs = messageTs;
        // A click (or timeout) may have settled the entry while the post was
        // in flight — replay the outcome onto the message now that it exists.
        this.rewriteIfSettled(entry);
      }
    } catch (err) {
      this.log(`[approvals] postMessage failed for ${d.tool}: ${String(err)}`);
      this.settle(entry, { approved: false }, "post failed");
    }
    return promise;
  }

  /**
   * Resolves a pending request from a button click. Unknown request ids and
   * clicks from a different channel than the prompt are ignored (they can
   * only arrive via the buttons on the prompt message itself, so this is a
   * stale-message guard).
   */
  async handleAction(action: SlackAction): Promise<void> {
    const entry = this.pending.get(action.value);
    if (entry === undefined || entry.settled) {
      this.log(`[approvals] ignoring action ${action.actionId} for unknown request ${action.value}`);
      return;
    }
    if (entry.spaceId !== action.spaceId) {
      this.log(`[approvals] ignoring action for request ${entry.id} from foreign space ${action.spaceId}`);
      return;
    }
    const approved = action.actionId === APPROVE_ACTION_ID;
    this.settle(entry, { approved, approver: action.principal }, `Denied by <@${action.principal}>`);
  }

  /** Settles a request exactly once: resolve the gate, evict, rewrite the prompt. */
  private settle(entry: PendingRequest, resolution: ApprovalResolution, label: string): void {
    if (entry.settled) return;
    entry.settled = true;
    entry.outcome = { resolution, label };
    clearTimeout(entry.timer);
    this.pending.delete(entry.id);
    entry.resolve(resolution);
    this.rewriteIfSettled(entry);
  }

  /**
   * Rewrites the prompt message with the settled outcome. No-op until the
   * post resolved (a failed post never had a message on the wire).
   * Best-effort: a failed rewrite must not flip the already-resolved gate.
   */
  private rewriteIfSettled(entry: PendingRequest): void {
    if (!entry.settled || entry.messageTs === "") return;
    const { resolution, label } = entry.outcome!;
    void this.adapter
      .updateMessage(entry.spaceId, entry.messageTs, outcomeText(entry, resolution, label))
      .catch((err: unknown) => this.log(`[approvals] updateMessage failed for ${entry.id}: ${String(err)}`));
  }
}
