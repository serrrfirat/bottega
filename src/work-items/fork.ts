/**
 * Forkable work items (issue #358): branch a NEW work item from any point
 * of an existing run's event trail. The original row is never mutated —
 * the fork is a fresh row (fresh id, fresh sandbox) carrying a `forked_from`
 * edge plus the resolved fork point (`fork_json`). At claim time the
 * executor prepends the bounded prior-context block built here to the
 * session's initial prompt; delivery approval routes through the fork's
 * space policy exactly like any other work item (inheritance by
 * construction — same `space_id`, policy resolved per-space at claim).
 *
 * Bounds: the injected context reuses the memory-injection caps — the 5
 * most recent messages within a 4096-byte budget (issue #42 defaults,
 * MEMORY_LIMIT_DEFAULT) — and the ancestor walk is depth-capped.
 */
import { readFileSync } from "node:fs";
import { z } from "zod";
import type { AuditCursor, ForkMeta, Store, WorkItem } from "../store/db";
import { WORK_ITEM_FAILED_EVENT } from "../store/audit-events";
import type { JsonValue } from "../memory/mem0";
import { messageLineSchema } from "../memory/session-search";
import { buildTimeline, itemTranscriptPath, type TimelineEntry } from "./timeline";

/** Max bytes of injected prior progress (the memory-context byte cap default). */
export const FORK_CONTEXT_MAX_BYTES = 4096;
/** Max injected prior messages (the memory-entry cap default). */
export const FORK_CONTEXT_MAX_MESSAGES = 5;
/** Depth bound for the forked-from chain walk (attempt numbering). */
const MAX_FORK_DEPTH = 10;

export interface ForkInput {
  /** The work item to fork from. */
  sourceId: string;
  /** Cut at this exact projected timeline index (mutually exclusive with afterKind). */
  atTimelineIndex?: number;
  /** Cut after the LAST entry of this kind — today only "failed" (the retry button's shape). */
  afterKind?: "failed";
  note?: string;
  /** Why this fork exists; "continuation" scopes #359 dedupe to retry forks. */
  intent?: "continuation";
  /** Principal recorded as the fork's requester and audit actor. */
  requester: string;
}

export interface ForkPoint {
  timelineIndex: number;
  meta: ForkMeta;
}

/**
 * Resolves the concrete fork point from the projected timeline: the chosen
 * entry (index or the last failed/blocked one), and the transcript cut —
 * the end of the nearest transcript span at or before that entry (0 when
 * none precedes it, i.e. no prior context injects).
 */
export function resolveForkPoint(
  timeline: TimelineEntry[],
  input: Pick<ForkInput, "atTimelineIndex" | "afterKind" | "note">,
): ForkPoint {
  let index: number;
  if (input.atTimelineIndex !== undefined) {
    if (!Number.isInteger(input.atTimelineIndex) || input.atTimelineIndex < 0 || input.atTimelineIndex >= timeline.length) {
      throw new Error(`atTimelineIndex out of range: ${String(input.atTimelineIndex)} (timeline has ${timeline.length} entries)`);
    }
    index = input.atTimelineIndex;
  } else if (input.afterKind === "failed") {
    index = findLastIndex(timeline, (entry) => entry.kind === "failed" || entry.kind === "blocked");
    if (index < 0) throw new Error("afterKind 'failed': the timeline has no failed/blocked entry");
  } else {
    throw new Error("one of atTimelineIndex or afterKind:'failed' is required");
  }

  // Transcript cut: the furthest transcript-span end at or before the cut.
  let spanEnd = 0;
  for (let i = 0; i <= index; i += 1) {
    const entry = timeline[i]!;
    if ("transcriptSpan" in entry) spanEnd = Math.max(spanEnd, entry.transcriptSpan[1] + 1);
  }
  const cut = timeline[index]!;
  const meta: ForkMeta = { timelineIndex: index };
  if (spanEnd > 0) meta.spanEnd = spanEnd;
  if ("cause" in cut) {
    const cause = z.string().safeParse(cut.cause);
    if (cause.success) meta.cause = cause.data;
  }
  if (input.note !== undefined) meta.note = input.note;
  return { timelineIndex: index, meta };
}

/** Array.prototype.findLastIndex stand-in for older lib targets. */
function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (predicate(items[i]!)) return i;
  }
  return -1;
}

/**
 * Renders the bounded prior-progress block from the source transcript's
 * lines [0, spanEnd): the FORK_CONTEXT_MAX_MESSAGES most recent messages
 * that fit FORK_CONTEXT_MAX_BYTES, oldest first. Empty string when there is
 * nothing usable (missing file, empty range).
 */
export function buildForkContext(transcriptPath: string | null, spanEnd: number): string {
  if (transcriptPath === null || spanEnd <= 0) return "";
  let lines: string[];
  try {
    lines = readFileSync(transcriptPath, "utf8").split("\n");
  } catch {
    return "";
  }
  const messages: string[] = [];
  for (let i = 0; i < Math.min(spanEnd, lines.length); i += 1) {
    let entry: JsonValue;
    try {
      entry = JSON.parse(lines[i]!);
    } catch {
      continue;
    }
    const parsed = messageLineText(entry);
    if (parsed !== null && parsed.trim().length > 0) messages.push(parsed.trim());
  }
  // Most recent first, within both caps; then restore chronological order.
  const picked: string[] = [];
  let bytes = 0;
  for (let i = messages.length - 1; i >= 0 && picked.length < FORK_CONTEXT_MAX_MESSAGES; i -= 1) {
    const text = messages[i]!;
    const cost = Buffer.byteLength(text, "utf8") + 3; // "- " bullet + newline
    if (picked.length > 0 && bytes + cost > FORK_CONTEXT_MAX_BYTES) break;
    picked.push(text);
    bytes += cost;
  }
  if (picked.length === 0) return "";
  return picked.reverse().map((text) => `- ${text}`).join("\n");
}

/** A visible-text content part (same contract session-search renders). */
const forkTextPartSchema = z.object({ type: z.literal("text"), text: z.string() });

/**
 * Visible text of one parsed transcript record; null for non-message rows.
 * Reuses the exported {@link messageLineSchema} wire contract: string
 * content passes through; array content keeps only parsed text parts.
 */
function messageLineText(record: JsonValue): string | null {
  const parsed = messageLineSchema.safeParse(record);
  if (!parsed.success) return null;
  const content = parsed.data.message.content;
  let text: string;
  if (Array.isArray(content)) {
    text = content
      .map((part) => forkTextPartSchema.safeParse(part))
      .flatMap((result) => (result.success ? [result.data.text] : []))
      .join("\n");
  } else {
    text = content;
  }
  text = text.trim();
  if (!text) return null;
  return text;
}

/**
 * The attempt preamble the executor prepends to a forked item's initial
 * prompt (issue #358's system preamble), with the bounded prior-progress
 * block appended. Null when the item is not a fork or carries no usable
 * context — callers then boot the item like any original.
 */
export async function buildForkPreamble(
  deps: Pick<Store, "getWorkItem">,
  transcriptDir: string,
  item: WorkItem,
): Promise<string | null> {
  if (item.forked_from === null) return null;
  let meta: ForkMeta = {};
  try {
    // SAFETY: fork_json is written by createWorkItem via JSON.stringify of a
    // typed ForkMeta; a legacy/malformed blob falls back to an empty meta.
    meta = item.fork_json === null ? {} : (JSON.parse(item.fork_json) as ForkMeta);
  } catch {
    meta = {};
  }
  // Attempt number: walk the forked-from chain (bounded).
  let depth = 0;
  let cursorId: string | null = item.forked_from;
  while (cursorId !== null && depth < MAX_FORK_DEPTH) {
    const ancestor: WorkItem | null = await deps.getWorkItem(cursorId);
    if (ancestor === null) break;
    depth += 1;
    cursorId = ancestor.forked_from;
  }

  const source = await deps.getWorkItem(item.forked_from);
  const context =
    source === null
      ? ""
      : buildForkContext(itemTranscriptPath(transcriptDir, source), meta.spanEnd ?? 0);
  if (context.length === 0 && Object.keys(meta).length === 0 && depth === 0) return null;

  const header = [
    `This is attempt ${depth + 1} of "${item.description.split("\n")[0]?.slice(0, 200)}"; the previous attempt${meta.cause ? ` failed at ${meta.cause}` : " did not complete"}.`,
    "Prior progress follows — treat it as context, verify before trusting:",
  ];
  const body = context.length > 0 ? `\n${context}` : "";
  return `${header.join("\n")}${body}`;
}

/**
 * Creates a fork: projects the source timeline, resolves the point, and
 * inserts the NEW work-item row (fresh id, enqueued job, inherited
 * space/delivery/repo/model pins). The original row is untouched; the edge
 * lives on the fork (`forked_from`) and in the `work_item.forked` audit row.
 */
export async function forkWorkItem(
  deps: Pick<Store, "getWorkItem" | "queryAudit" | "createWorkItem"> & { transcriptDir: string },
  input: ForkInput,
): Promise<WorkItem> {
  const source = await deps.getWorkItem(input.sourceId);
  if (source === null) throw new Error(`work item not found: ${input.sourceId}`);
  const timeline = await buildTimeline(deps, deps.transcriptDir, input.sourceId);
  if (timeline === null) throw new Error(`work item not found: ${input.sourceId}`);
  const point = resolveForkPoint(timeline, input);

  // The failure marker refines the preamble cause when the cut itself is
  // not a terminal landing (e.g. an index cut right before the failure).
  let meta: ForkMeta = { ...point.meta };
  if (input.intent !== undefined) meta.intent = input.intent;
  if (meta.cause === undefined) {
    const failed = await latestFailureCause(deps, input.sourceId);
    if (failed !== undefined) meta = { ...meta, cause: failed };
  }

  return deps.createWorkItem({
    space_id: source.space_id,
    requester: input.requester,
    description: source.description,
    repo: source.repo ?? undefined,
    delivery: source.delivery,
    model: source.model ?? undefined,
    reasoning_effort: source.reasoning_effort ?? undefined,
    pr_url: source.pr_url ?? undefined,
    pr_branch: source.pr_branch ?? undefined,
    base_branch: source.base_branch ?? undefined,
    // SAFETY: skills is written by createWorkItem as JSON.stringify of the
    // validated string[] input; the parse restores that array.
    skills: JSON.parse(source.skills) as string[],
    forkedFrom: source.id,
    forkMeta: meta,
  });
}

/** Newest `work_item.failed` marker's error text for the source; undefined when none. */
async function latestFailureCause(deps: Pick<Store, "queryAudit">, sourceId: string): Promise<string | undefined> {
  let cursor: AuditCursor | undefined;
  let cause: string | undefined;
  for (;;) {
    const page = await deps.queryAudit({ event_type: WORK_ITEM_FAILED_EVENT, limit: 100, cursor });
    for (const row of page.rows) {
      try {
        // SAFETY: failed markers are appended by job-bodies via
        // JSON.stringify({id, error}); malformed rows are skipped.
        const payload = JSON.parse(row.payload) as { id?: unknown; error?: unknown };
        if (payload.id === sourceId && z.string().safeParse(payload.error).success) {
          cause = z.string().parse(payload.error);
        }
      } catch {
        // Malformed rows never break the fork; the timeline carries the rest.
      }
    }
    cursor = page.nextCursor ?? undefined;
    if (cursor === undefined) break;
  }
  return cause;
}

