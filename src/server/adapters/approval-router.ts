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
import { z } from "zod";
import { randomUUID } from "node:crypto";
import type { ApprovalRequest, ApprovalResolution, ApprovalRouter } from "../../policy/approval-router";
import { redact, type AuditModule } from "../../policy/audit";
import { summarizeToolArgs } from "../../policy/gate";
import { DEFAULT_TIMEOUT_MINUTES } from "../../policy/config";
import { APPROVAL_NUDGED_EVENT } from "../../store/audit-events";
import {
  APPROVE_ACTION_ID,
  DENY_ACTION_ID,
  type SlackAction,
  type SlackAdapter,
  type SlackBlockPayload,
} from "./slack";
import { bestEffortMessageRewrite, resolveBlockAction } from "./block-flow";
import { emitToolStep, nextToolStepId, toolStepTitle, type ToolStepSink } from "../services/slack-turn-presenter";

/** Cap for the args summary text rendered in the approval prompt (redacted first). */
export const ARGS_SUMMARY_MAX_CHARS = 2000;

/** Per-row cap for an argument value rendered in the approval prompt. */
export const ARGS_ROW_VALUE_MAX = 300;

/** Rows rendered before a "… and N more fields" note on the approval prompt. */
export const ARGS_ROW_MAX = 12;

/** Registry bound: at capacity the oldest pending request is evicted (denied). */
export const MAX_PENDING_REQUESTS = 64;

/**
 * Default minutes a pending ask-human approval sits unanswered before ONE
 * nudge is posted to the approver channel (issue #109). Overridable per
 * org via `approvals.approval_nudge_minutes`.
 */
export const DEFAULT_NUDGE_MINUTES = 30;

/** Cap for the confirmed-write-failure memory; the oldest entry is evicted at capacity. */
export const FAILURE_MEMORY_MAX = 64;

/**
 * Slack section block `text` cap: a `section.text` string beyond this makes
 * Slack reject the whole message with `invalid_blocks`. The approval card is
 * rendered below it so a dense payload never auto-denies (issue #277).
 */
export const SLACK_SECTION_TEXT_MAX = 3000;

/** Budget for the humanized *Would-be write:* rows, leaving room for the heading + block overhead. */
export const ARGS_SECTION_TEXT_MAX = 2800;

/** Budget for the *Last confirmed write failed:* banner reason (block-safe). */
export const FAILURE_BANNER_REASON_MAX = 2800;

interface PendingRequest {
  id: string;
  spaceId: string;
  tool: string;
  /** Ts of the posted prompt; "" until the post resolves. */
  messageTs: string;
  timer: ReturnType<typeof setTimeout>;
  /** Nudge timer (issue #109): fires once at the nudge deadline to post ONE nudge. */
  nudgeTimer: ReturnType<typeof setTimeout>;
  /** True once the request has been nudged; a pending request is never nudged twice. */
  nudged: boolean;
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
  /** Complexity cap for the confirmed-write-failure memory. Default {@link FAILURE_MEMORY_MAX}. */
  maxFailures?: number;
  /**
   * Minutes a pending ask-human approval sits unanswered before ONE nudge
   * posts to the approver channel (issue #109). Default {@link DEFAULT_NUDGE_MINUTES}.
   */
  nudgeMinutes?: number;
  /**
   * Audit seam (issue #109): lets the router record `approval.nudged` when
   * it posts a nudge. Optional — a router without an audit seam still
   * nudges, just without the audit row.
   */
  audit?: AuditModule;
  /**
   * Presenter/step path (issue #277): when present, a confirmed write that
   * fails posts a failure step card through this sink — the SAME path tool
   * steps already use, never a parallel messaging API.
   */
  onToolStep?: ToolStepSink;
  /** Observability seam; defaults to console.log. */
  log?: (line: string) => void;
}

/** One human-readable row of a would-be-write payload. */
export interface ApprovalArgRow {
  label: string;
  value: string;
}

const approvalArgsSchema = z.object({}).passthrough();
type ApprovalArgs = z.infer<typeof approvalArgsSchema>;
const approvalArgTextSchema = z.string();
const approvalArgScalarSchema = z.union([z.number(), z.boolean()]);
const approvalSkillSummarySchema = z.object({
  name: z.string().optional(),
  expected_revision: z.string().optional(),
  document: z.object({ bytes: z.number(), sha256: z.string() }).optional(),
  companion_files: z
    .array(z.object({ path: z.string(), bytes: z.number(), sha256: z.string() }))
    .optional(),
});

/**
 * Humanizes an arg key: camelCase / snake_case / kebab-case become spaced
 * title words ('addTeams'/'due_date' → 'Add teams' / 'Due date').
 */
export function humanizeKey(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2") // camelCase → "camel Case"
    .replace(/[_-]+/g, " ") // snake/kebab → spaces
    .replace(/\s+/g, " ") // collapse whitespace
    .trim()
    .toLowerCase(); // 'addTeams' → 'add teams' (title-caps the first letter below)
  return words.length === 0 ? key : words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Humanizes a tool NAME for the #295 completed-action footer: strips a
 * dotted scope prefix ('github.search_issues' → 'search_issues') then runs
 * the shared {@link humanizeKey} ('search issues' → 'Search issues'). Reused
 * so the footer never prints an internal tool identifier to a human.
 */
export function humanizeToolName(name: string): string {
  const base = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : name;
  return humanizeKey(base);
}

/**
 * Humanized, redacted, capped rows for the would-be-write payload (issue
 * #277): keys become title words, empty values are elided, values are
 * redacted then capped, and the row list is capped.
 */
export function humanizeArgsRows(args: ApprovalArgs): ApprovalArgRow[] {
  const rows: ApprovalArgRow[] = [];
  for (const [key, value] of Object.entries(args)) {
    const textValue = approvalArgTextSchema.safeParse(value);
    const scalarValue = approvalArgScalarSchema.safeParse(value);
    const empty =
      value === null ||
      value === undefined ||
      (textValue.success && textValue.data === "") ||
      (Array.isArray(value) && value.length === 0) ||
      (value instanceof Set && value.size === 0) ||
      (value instanceof Map && value.size === 0) ||
      (!textValue.success &&
        !scalarValue.success &&
        !Array.isArray(value) &&
        !(value instanceof Set) &&
        !(value instanceof Map) &&
        Object.keys(Object(value)).length === 0);
    if (empty) continue;

    let text = textValue.success
      ? textValue.data
      : scalarValue.success
        ? String(scalarValue.data)
        : JSON.stringify(value) ?? "";
    text = redact(text);
    rows.push({
      label: humanizeKey(key),
      value: text.length > ARGS_ROW_VALUE_MAX ? `${text.slice(0, ARGS_ROW_VALUE_MAX)}…` : text,
    });
  }
  return rows;
}

/**
 * Skill mutation approvals show a content-safe replacement plan: paths,
 * byte counts, and hashes. Procedure/file bodies never reach Slack.
 */
export function approvalArgsRows(request: ApprovalRequest): ApprovalArgRow[] {
  if (request.tool !== "create_space_skill" && request.tool !== "update_space_skill") {
    const parsedArgs = approvalArgsSchema.safeParse(request.args);
    return parsedArgs.success ? humanizeArgsRows(parsedArgs.data) : [];
  }
  const parsed = approvalSkillSummarySchema.safeParse(
    JSON.parse(summarizeToolArgs(request.tool, request.args)),
  );
  if (!parsed.success) return [];
  const summary = parsed.data;
  const rows: ApprovalArgRow[] = [];
  if (summary.name !== undefined) rows.push({ label: "Skill", value: summary.name });
  if (summary.expected_revision !== undefined) {
    rows.push({ label: "Expected revision", value: summary.expected_revision });
  }
  if (summary.document !== undefined) {
    rows.push({
      label: "SKILL.md",
      value: `${request.tool === "create_space_skill" ? "add" : "replace"} ${summary.document.bytes} bytes (sha256 ${summary.document.sha256})`,
    });
  }
  if (summary.companion_files !== undefined) {
    rows.push({
      label: "Companion set",
      value:
        request.tool === "create_space_skill"
          ? `add ${summary.companion_files.length} declared file(s)`
          : `replace complete set with ${summary.companion_files.length} declared file(s); omitted old files are deleted`,
    });
    for (const file of summary.companion_files) {
      rows.push({
        label: `Companion ${file.path}`,
        value: `${request.tool === "create_space_skill" ? "add" : "replace"} ${file.bytes} bytes (sha256 ${file.sha256})`,
      });
    }
  }
  return rows;
}

/**
 * Mrkdwn lines for the humanized rows (issue #277): capped by row count
 * (ARGS_ROW_MAX) AND by a block-safe character budget (ARGS_SECTION_TEXT_MAX)
 * so a dense payload never pushes a section past Slack's 3000-char cap —
 * which would make Slack reject the whole card and the approval auto-deny.
 * Overshoot appends a "… and N more fields" note for the rows dropped.
 */
export function renderArgsRowsText(rows: readonly ApprovalArgRow[]): string {
  const lines: string[] = [];
  let used = 0;
  // Cap by row count (ARGS_ROW_MAX) AND by a block-safe character budget
  // (ARGS_SECTION_TEXT_MAX): a dense payload of many max-size values must
  // never push a section past Slack's 3000-char cap — Slack would reject the
  // whole card and the approval would auto-deny (issue #277).
  for (const row of rows) {
    if (lines.length >= ARGS_ROW_MAX) break;
    const line = `• *${row.label}:* ${row.value}`;
    const tail = rows.length > lines.length + 1 ? `… and ${rows.length - lines.length - 1} more fields` : "";
    if (used + line.length + tail.length > ARGS_SECTION_TEXT_MAX) break;
    lines.push(line);
    used += line.length + 1; // trailing newline
  }
  if (rows.length > lines.length) lines.push(`… and ${rows.length - lines.length} more fields`);
  return lines.join("\n");
}

/**
 * Redacted, capped, humanized args summary shared by the prompt's block and
 * text surfaces (issue #277): the payload a human approves — labeled rows,
 * never raw flat JSON.
 */
export function approvalArgsSummary(d: ApprovalRequest): string {
  const text = renderArgsRowsText(approvalArgsRows(d));
  return text.length > ARGS_SUMMARY_MAX_CHARS ? `${text.slice(0, ARGS_SUMMARY_MAX_CHARS)}...[truncated]` : text;
}

/**
 * Plain-text form of the approval prompt (the fallback under the blocks):
 * tool name + the redacted, humanized payload, so an approval decides the
 * actual call, not the tool name alone (issue #160/#277).
 */
export function approvalPromptText(d: ApprovalRequest): string {
  return `Approval required for ${d.tool} — ${approvalArgsSummary(d)}`;
}

/**
 * Bounded memory of confirmed-write failures per (space, tool): at most
 * {@link FAILURE_MEMORY_MAX} entries, evicting the OLDEST (insertion-ordered
 * Map, refreshed on record) at capacity — never unbounded. A later approval
 * card for the same tool surfaces 'last confirmed write failed: <reason>'.
 */
export class ApprovalFailureMemory {
  private readonly entries = new Map<string, string>();
  private readonly max: number;

  constructor(max = FAILURE_MEMORY_MAX) {
    this.max = max;
  }

  /** Number of remembered failures (observability for the bounded-memory test). */
  get size(): number {
    return this.entries.size;
  }

  record(spaceId: string, tool: string, reason: string): void {
    const key = `${spaceId}\u0000${tool}`;
    // Delete + re-set refreshes recency (oldest-first iteration order).
    this.entries.delete(key);
    this.entries.set(key, reason);
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  /** The last confirmed-write failure reason for (space, tool), if any. */
  lastFailure(spaceId: string, tool: string): string | undefined {
    return this.entries.get(`${spaceId}\u0000${tool}`);
  }
}

/**
 * Renders the interactive approval prompt blocks: tool + reason + the
 * humanized would-be-write payload (labeled rows), an optional
 * 'last confirmed write failed' banner, then Approve/Deny buttons carrying
 * the request id. Pure so the outbound rendering is testable without Slack.
 */
export function buildApprovalBlocks(
  d: ApprovalRequest,
  id: string,
  rememberedFailure?: string,
): SlackBlockPayload[] {
  const args = renderArgsRowsText(approvalArgsRows(d));
  const blocks: SlackBlockPayload[] = [
    {
      type: "section",
      text: { type: "mrkdwn", text: `*Approval required* — \`${d.tool}\`` },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: `*Reason:* ${d.reason}` },
    },
  ];
  if (args.length > 0) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*Would-be write:*\n${args}` },
    });
  }
  if (rememberedFailure !== undefined && rememberedFailure.length > 0) {
    // Block-safe: a long failure reason is truncated (after redaction) so the
    // banner section stays under Slack's cap (issue #277).
    const banner = redact(rememberedFailure).slice(0, FAILURE_BANNER_REASON_MAX);
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*Last confirmed write failed:* ${banner}` },
    });
  }
  blocks.push({
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
  });
  return blocks;
}

/**
 * Mrkdwn prefix of the outcome line posted once a request settles (issue #44).
 * Single source of truth (issue #242): the canary's rewrite predicate matches
 * this exact prefix, so consumers import it instead of copying a divergent
 * plain-text form.
 */
export const APPROVAL_OUTCOME_PREFIX = "*Approval resolved*";

/** Outcome line replacing the prompt message once a request settles. */
function outcomeText(entry: PendingRequest, r: ApprovalResolution, label: string): string {
  const verb = r.approved ? `Approved by <@${r.approver ?? "unknown"}>` : label;
  return `${APPROVAL_OUTCOME_PREFIX} — \`${entry.tool}\`: ${verb}.`;
}

export class SlackApprovalRouter implements ApprovalRouter {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly adapter: Pick<SlackAdapter, "postMessage" | "updateMessage">;
  private readonly timeoutMs: number;
  private readonly nudgeMinutes: number;
  private readonly maxPending: number;
  private readonly failures: ApprovalFailureMemory;
  private readonly onToolStep: ToolStepSink | undefined;
  private readonly audit: AuditModule | undefined;
  private readonly log: (line: string) => void;

  constructor(deps: SlackApprovalRouterDeps) {
    this.adapter = deps.adapter;
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MINUTES * 60_000;
    this.nudgeMinutes = deps.nudgeMinutes ?? DEFAULT_NUDGE_MINUTES;
    this.maxPending = deps.maxPending ?? MAX_PENDING_REQUESTS;
    this.failures = new ApprovalFailureMemory(deps.maxFailures ?? FAILURE_MEMORY_MAX);
    this.onToolStep = deps.onToolStep;
    this.audit = deps.audit;
    this.log = deps.log ?? ((line) => console.log(line));
  }

  /** Number of unresolved pending requests (registry observability for tests). */
  get pendingCount(): number {
    return this.pending.size;
  }

  /** Number of remembered confirmed-write failures (bounded-memory observability). */
  get failureMemorySize(): number {
    return this.failures.size;
  }

  /** Number of unresolved pending requests (registry observability for tests). */
  pendingPrompts(): ReadonlyArray<{ spaceId: string; tool: string }> {
    return [...this.pending.values()].map((entry) => ({ spaceId: entry.spaceId, tool: entry.tool }));
  }

  /**
   * The last confirmed-write failure reason for (space, tool), if any — the
   * bounded memory a later approval card surfaces (issue #277).
   */
  lastConfirmedWriteFailure(spaceId: string, tool: string): string | undefined {
    return this.failures.lastFailure(spaceId, tool);
  }

  /**
   * Records a confirmed write whose execution FAILED (issue #277): remembered
   * per (space, tool) in the BOUNDED memory, and — when a step sink is wired —
   * posted back into the thread as a failure step card through the existing
   * presenter/step path (never a parallel messaging API). The step is opened
   * as in_progress then completed with a SHARED taskId so the phrase/stream
   * renderer surfaces a visible failure instead of swallowing an orphaned
   * complete card (and so a strict stream never rejects a task id it hasn't
   * seen open). The decision policy is untouched: this only reports a
   * downstream failure.
   */
  recordConfirmedWriteFailure(spaceId: string, tool: string, reason: string): void {
    const text = reason && reason.trim().length > 0 ? reason.trim() : "confirmed write failed";
    this.failures.record(spaceId, tool, text);
    const space = spaceId === "" ? undefined : spaceId;
    const title = toolStepTitle(tool, "confirmed write failed");
    const taskId = nextToolStepId();
    const output = redact(text);
    const label = humanizeToolName(tool);
    emitToolStep(this.onToolStep, {
      spaceId: space,
      taskId,
      title,
      label,
      progressState: "waiting",
      progressDetail: "Write failed; review required",
      status: "in_progress",
      output,
    });
    emitToolStep(this.onToolStep, { spaceId: space, taskId, title, label, status: "complete", outcome: "failed", output });
    this.log(`[approvals] confirmed write failed for ${tool}: ${text}`);
  }

  async request(d: ApprovalRequest): Promise<ApprovalResolution> {
    const id = randomUUID();
    if (this.pending.size >= this.maxPending) {
      // SAFETY: a Map iterator's next() yields { value, done }; value is the
      // oldest PendingRequest while the registry is non-empty (size >=
      // maxPending >= 1) and undefined when empty — the guard below handles
      // both shapes.
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
      nudgeTimer: setTimeout(() => {
        this.nudge(entry, d, this.nudgeMinutes);
      }, this.nudgeMinutes * 60_000),
      nudged: false,
      resolve,
      settled: false,
    };
    // Never hold the process open waiting for a button that may not come.
    entry.timer.unref?.();
    entry.nudgeTimer.unref?.();
    this.pending.set(id, entry);
    try {
      const messageTs = await this.adapter.postMessage(d.spaceId, approvalPromptText(d), {
        blocks: buildApprovalBlocks(d, id, this.failures.lastFailure(d.spaceId, d.tool)),
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
    await resolveBlockAction(this.log, action, {
      // The slack action router only delivers approve/deny clicks here.
      owns: (a) => a.actionId === APPROVE_ACTION_ID || a.actionId === DENY_ACTION_ID,
      guard: (a) => {
        const entry = this.pending.get(a.value);
        if (entry === undefined || entry.settled) {
          return `[approvals] ignoring action ${a.actionId} for unknown request ${a.value}`;
        }
        if (entry.spaceId !== a.spaceId) {
          return `[approvals] ignoring action for request ${entry.id} from foreign space ${a.spaceId}`;
        }
        return null;
      },
      settle: (a) => {
        const entry = this.pending.get(a.value);
        if (entry === undefined) return null; // defend the settled race, see rewriteIfSettled
        const approved = a.actionId === APPROVE_ACTION_ID;
        this.markSettled(entry, { approved, approver: a.principal }, `Denied by <@${a.principal}>`);
        return { outcome: entry };
      },
      // The skeleton passes (action, outcome); outcome is the settled entry.
      rewrite: (_a, entry) => this.rewriteIfSettled(entry),
    });
  }

  /**
   * Posts ONE nudge for a still-pending request (issue #109). Fired by the
   * per-request nudge timer; a no-op once the request is settled or already
   * nudged. Best-effort and never awaited: a failed post or audit is logged,
   * never thrown into the turn path, and never settles the request. The
   * nudge reuses the SAME posting seam as the prompt (adapter.postMessage).
   */
  private nudge(entry: PendingRequest, d: ApprovalRequest, pendingMinutes: number): void {
    if (entry.settled || entry.nudged) return;
    entry.nudged = true;
    const text = `⏳ *Still waiting on approval* — \`${d.tool}\` has been pending for ~${pendingMinutes} minute${pendingMinutes === 1 ? "" : "s"}. Click approve or deny on the original message above to resolve it.`;
    void this.adapter
      .postMessage(d.spaceId, text)
      .then(() => this.log(`[approvals] nudged pending request ${entry.id} for ${d.tool}`))
      .catch((err) => this.log(`[approvals] nudge post failed for ${entry.id}: ${String(err)}`));
    if (this.audit !== undefined) {
      void this.audit
        .appendAudit({
          space_id: d.spaceId === "" ? null : d.spaceId,
          actor: "system",
          event_type: APPROVAL_NUDGED_EVENT,
          payload: { tool: d.tool, space_id: d.spaceId, elapse_minutes: pendingMinutes },
        })
        .catch((err) => this.log(`[approvals] nudge audit failed for ${entry.id}: ${String(err)}`));
    }
  }

  /** Settles a request exactly once: resolve the gate, evict, rewrite the prompt. */
  private settle(entry: PendingRequest, resolution: ApprovalResolution, label: string): void {
    if (entry.settled) return;
    this.markSettled(entry, resolution, label);
    this.rewriteIfSettled(entry);
  }

  /**
   * Marks a request settled exactly once (resolve the gate, evict, capture
   * the outcome for replay). The message rewrite is the caller's job: the
   * skeleton's rewrite step calls {@link rewriteIfSettled} after this, and
   * the request-timeout/eviction paths call {@link settle} (state + rewrite).
   */
  private markSettled(entry: PendingRequest, resolution: ApprovalResolution, label: string): void {
    if (entry.settled) return;
    entry.settled = true;
    entry.outcome = { resolution, label };
    clearTimeout(entry.timer);
    clearTimeout(entry.nudgeTimer);
    this.pending.delete(entry.id);
    entry.resolve(resolution);
  }

  /**
   * Rewrites the prompt message with the settled outcome. No-op until the
   * post resolved (a failed post never had a message on the wire).
   * Best-effort: a failed rewrite must not flip the already-resolved gate.
   */
  private rewriteIfSettled(entry: PendingRequest): void {
    if (!entry.settled || entry.messageTs === "") return;
    const { resolution, label } = entry.outcome!;
    bestEffortMessageRewrite(
      this.adapter,
      entry.spaceId,
      entry.messageTs,
      outcomeText(entry, resolution, label),
      undefined,
      (reason) => this.log(`[approvals] updateMessage failed for ${entry.id}: ${reason}`),
    );
  }
}
