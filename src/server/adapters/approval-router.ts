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
import { summarizeToolArgs } from "../../policy/gate";
import { DEFAULT_TIMEOUT_MINUTES } from "../../policy/config";
import { APPROVE_ACTION_ID, DENY_ACTION_ID, type SlackAction, type SlackAdapter } from "./slack";
import { emitToolStep, nextToolStepId, toolStepTitle, type ToolStepSink } from "../services/slack-turn-presenter";

/** Cap for the args summary text rendered in the approval prompt (redacted first). */
export const ARGS_SUMMARY_MAX_CHARS = 2000;

/** Per-row cap for an argument value rendered in the approval prompt. */
export const ARGS_ROW_VALUE_MAX = 300;

/** Rows rendered before a "… and N more fields" note on the approval prompt. */
export const ARGS_ROW_MAX = 12;

/** Registry bound: at capacity the oldest pending request is evicted (denied). */
export const MAX_PENDING_REQUESTS = 64;

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

/** True for values that carry no information on an approval card (elided). */
function isEmptyValue(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "string") return v === "";
  if (typeof v === "number" || typeof v === "boolean") return false;
  if (Array.isArray(v)) return v.length === 0;
  if (v instanceof Set) return v.size === 0;
  if (v instanceof Map) return v.size === 0;
  return Object.keys(v).length === 0;
}

/**
 * One arg value rendered for the prompt: redacted FIRST (the same redaction
 * the audit module applies — secret-shaped values never reach the card),
 * then capped per value with an ellipsis.
 */
function renderArgValue(v: unknown): string {
  let text: string;
  if (typeof v === "string") text = v;
  else if (typeof v === "number" || typeof v === "boolean") text = String(v);
  else text = JSON.stringify(v) ?? "";
  text = redact(text);
  return text.length > ARGS_ROW_VALUE_MAX ? `${text.slice(0, ARGS_ROW_VALUE_MAX)}…` : text;
}

/**
 * Humanized, redacted, capped rows for the would-be-write payload (issue
 * #277): keys become title words, empty values are elided, values are
 * redacted then capped, and the row list is capped.
 */
export function humanizeArgsRows(args: unknown): ApprovalArgRow[] {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return [];
  const entries = Object.entries(args as Record<string, unknown>);
  const rows: ApprovalArgRow[] = [];
  for (const [key, value] of entries) {
    if (isEmptyValue(value)) continue;
    rows.push({ label: humanizeKey(key), value: renderArgValue(value) });
  }
  return rows;
}

/**
 * Skill mutation approvals show a content-safe replacement plan: paths,
 * byte counts, and hashes. Procedure/file bodies never reach Slack.
 */
export function approvalArgsRows(request: ApprovalRequest): ApprovalArgRow[] {
  if (request.tool !== "create_space_skill" && request.tool !== "update_space_skill") {
    return humanizeArgsRows(request.args);
  }
  const parsed: unknown = JSON.parse(summarizeToolArgs(request.tool, request.args));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  const summary = parsed as Record<string, unknown>;
  const rows: ApprovalArgRow[] = [];
  if (typeof summary.name === "string") rows.push({ label: "Skill", value: summary.name });
  if (typeof summary.expected_revision === "string") {
    rows.push({ label: "Expected revision", value: summary.expected_revision });
  }
  if (summary.document !== null && typeof summary.document === "object" && !Array.isArray(summary.document)) {
    const document = summary.document as Record<string, unknown>;
    rows.push({
      label: "SKILL.md",
      value: `${request.tool === "create_space_skill" ? "add" : "replace"} ${String(document.bytes)} bytes (sha256 ${String(document.sha256)})`,
    });
  }
  if (Array.isArray(summary.companion_files)) {
    rows.push({
      label: "Companion set",
      value:
        request.tool === "create_space_skill"
          ? `add ${summary.companion_files.length} declared file(s)`
          : `replace complete set with ${summary.companion_files.length} declared file(s); omitted old files are deleted`,
    });
    for (const item of summary.companion_files) {
      if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
      const file = item as Record<string, unknown>;
      rows.push({
        label: `Companion ${String(file.path)}`,
        value: `${request.tool === "create_space_skill" ? "add" : "replace"} ${String(file.bytes)} bytes (sha256 ${String(file.sha256)})`,
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
      this.entries.delete(this.entries.keys().next().value as string);
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
export function buildApprovalBlocks(d: ApprovalRequest, id: string, rememberedFailure?: string): unknown[] {
  const args = renderArgsRowsText(approvalArgsRows(d));
  const blocks: unknown[] = [
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
  private readonly maxPending: number;
  private readonly failures: ApprovalFailureMemory;
  private readonly onToolStep: ToolStepSink | undefined;
  private readonly log: (line: string) => void;

  constructor(deps: SlackApprovalRouterDeps) {
    this.adapter = deps.adapter;
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MINUTES * 60_000;
    this.maxPending = deps.maxPending ?? MAX_PENDING_REQUESTS;
    this.failures = new ApprovalFailureMemory(deps.maxFailures ?? FAILURE_MEMORY_MAX);
    this.onToolStep = deps.onToolStep;
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
    emitToolStep(this.onToolStep, { spaceId: space, taskId, title, label, status: "in_progress", output });
    emitToolStep(this.onToolStep, { spaceId: space, taskId, title, label, status: "complete", output, outcome: "failed" });
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
      resolve,
      settled: false,
    };
    // Never hold the process open waiting for a button that may not come.
    entry.timer.unref?.();
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
      .catch((err) => this.log(`[approvals] updateMessage failed for ${entry.id}: ${String(err)}`));
  }
}
