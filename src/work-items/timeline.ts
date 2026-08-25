/**
 * Work-item run timeline (issue #358): a read-only projection of one work
 * item's full lifecycle, assembled from stores that already exist — the
 * append-only audit table and the item's JSONL transcript. No new writes,
 * no new storage: the trail is made operational by JOINing it in one place.
 *
 * Sources:
 * - `work_item.created`      → `created`
 * - `job.claimed`            → `claimed` (the worker lease; actor = runner)
 * - transcript message lines → `turn` (with the physical [start,end] JSONL
 *   line span) and `tool-call` (from tool_use content parts, digest-only)
 * - `delivery.requested` /
 *   `work_item.delivery_pending` → `delivery-pending`
 * - `work_item.transition`   → terminal landings only (`blocked`, `done` →
 *   `completed`, `aborted` → `failed`); intermediate states stay implicit
 * - `work_item.failed`       → `failed` (the executor's failure marker)
 *
 * Bounded fail-closed: the projection caps entries and never throws on a
 * missing/malformed transcript — a missing file simply contributes no
 * turn/tool entries (the audit rows still tell the lifecycle story).
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  DELIVERY_REQUESTED_EVENT,
  JOB_CLAIMED_EVENT,
  WORK_ITEM_CREATED_EVENT,
  DELIVERY_PENDING_EVENT,
  WORK_ITEM_FAILED_EVENT,
  WORK_ITEM_TRANSITION_EVENT,
} from "../store/audit-events";
import type { AuditCursor, Store, WorkItem } from "../store/db";
import { messageLineSchema } from "../memory/session-search";

/** Hard cap on projected entries (issue #358 resource bound); oldest kept. */
export const MAX_TIMELINE_ENTRIES = 500;

/** How much of a turn's text renders as its summary. */
const TURN_SUMMARY_CHARS = 160;

/** One ordered lifecycle entry. Timestamps are epoch ms; spans are 0-based inclusive JSONL line indices. */
export type TimelineEntry =
  | { at: number; kind: "created"; by: string }
  | { at: number; kind: "claimed"; runner: string }
  | { at: number; kind: "turn"; summary: string; transcriptSpan: [number, number] }
  | { at: number; kind: "tool-call"; tool: string; argsDigest: string; transcriptSpan: [number, number] }
  | { at: number; kind: "delivery-pending"; prUrl?: string }
  | { at: number; kind: "failed"; cause: string }
  | { at: number; kind: "completed"; cause: string }
  | { at: number; kind: "blocked"; cause: string };

/** A tool_use content part of a transcript message (Anthropic-style block). */
const toolUsePartSchema = z.object({
  type: z.literal("tool_use"),
  name: z.string().optional(),
  input: z.unknown().optional(),
});

/** A visible-text content part (same contract as session-search's renderer). */
const textPartSchema = z.object({ type: z.literal("text"), text: z.string() });

interface ParsedTranscript {
  turns: Array<{ at: number; summary: string; span: [number, number] }>;
  toolCalls: Array<{ at: number; tool: string; argsDigest: string; span: [number, number] }>;
}

/** Digest-only tool-args fingerprint: never the args themselves. */
function argsDigest(tool: z.infer<typeof toolUsePartSchema>): string {
  // SAFETY: the digest consumes the stable JSON serialization of an
  // already-parsed content part's input; JSON.stringify defines the
  // byte-level domain.
  return createHash("sha256").update(JSON.stringify(tool.input ?? null)).digest("hex").slice(0, 16);
}

/**
 * Parses one item transcript into turn/tool-call candidates. Line indices
 * are physical JSONL lines (0-based, truncated tail dropped like
 * session-search), timestamps are best-effort epoch ms — a missing or
 * unparseable stamp falls back to `fallbackAt` so ordering stays stable.
 */
export function parseItemTranscript(contents: string, fallbackAt: number): ParsedTranscript {
  // session-search convention: complete JSONL records only. The trailing ""
  // of split exists only when the file is newline-terminated; a crash-
  // truncated (or simply unterminated) final line is dropped, never the
  // last COMPLETE record.
  const lines = contents.length === 0 ? [] : contents.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const turns: ParsedTranscript["turns"] = [];
  const toolCalls: ParsedTranscript["toolCalls"] = [];
  for (let i = 0; i < lines.length; i += 1) {
    let entry: unknown;
    try {
      entry = JSON.parse(lines[i]!);
    } catch {
      continue;
    }
    const parsed = messageLineSchema.safeParse(entry);
    if (!parsed.success) continue;
    const at = Number.isFinite(Date.parse(parsed.data.timestamp ?? ""))
      ? Date.parse(parsed.data.timestamp!)
      : fallbackAt;
    const content = parsed.data.message.content;
    if (Array.isArray(content)) {
      for (const part of content) {
        const tool = toolUsePartSchema.safeParse(part);
        if (tool.success && tool.data.name !== undefined) {
          toolCalls.push({ at, tool: tool.data.name, argsDigest: argsDigest(tool.data), span: [i, i] });
        }
      }
    }
    const text = (Array.isArray(content)
      ? content
          .map((part) => {
            const parsedText = textPartSchema.safeParse(part);
            return parsedText.success ? parsedText.data.text : "";
          })
          .join("\n")
      : content
    ).trim();
    if (text.length > 0) {
      turns.push({ at, summary: text.slice(0, TURN_SUMMARY_CHARS), span: [i, i] });
    }
  }
  return { turns, toolCalls };
}


/**
 * Resolves where an item's transcript lives, by delivery kind with an
 * existence fallback (a forked item may replay across delivery kinds).
 * Null when no transcript file exists.
 */
export function itemTranscriptPath(
  transcriptDir: string,
  item: Pick<WorkItem, "id" | "space_id" | "delivery">,
): string | null {
  // Delivery-kind-first with an existence fallback: git items live at
  // `<dir>/<itemId>.jsonl`, extension items at `<dir>/<itemId>/<spaceId>.jsonl`
  // — a forked item may replay across delivery kinds.
  const flat = join(transcriptDir, `${item.id}.jsonl`);
  const nested = join(transcriptDir, item.id, `${item.space_id}.jsonl`);
  const candidates = item.delivery === "extension" ? [nested, flat] : [flat, nested];
  return candidates.find((path) => existsSync(path)) ?? null;
}

/**
 * Projects one work item's timeline. Audit rows are filtered by payload id
 * (every #358-relevant event carries it), merged with the transcript
 * projection, sorted chronologically (stable; ties keep audit-before-
 * transcript then insertion order), and capped at {@link MAX_TIMELINE_ENTRIES}.
 */
/** Minimal JSON value domain for parsed audit payloads. */
type JsonValueLike = string | number | boolean | null | JsonValueLike[] | { [key: string]: JsonValueLike };
type JsonValueObject = { [key: string]: JsonValueLike };

export async function buildTimeline(
  deps: Pick<Store, "getWorkItem" | "queryAudit">,
  transcriptDir: string,
  itemId: string,
): Promise<TimelineEntry[] | null> {
  const item = await deps.getWorkItem(itemId);

  if (item === null) return null;

  // Walk the item-scoped audit events (indexed by event_type + ts, cursor-paged).
  // Static event-name lookup: every #358-relevant audit event type.
  const relevant: ReadonlySet<string> = new Set([
    WORK_ITEM_CREATED_EVENT,
    JOB_CLAIMED_EVENT,
    WORK_ITEM_TRANSITION_EVENT,
    WORK_ITEM_FAILED_EVENT,
    DELIVERY_PENDING_EVENT,
    DELIVERY_REQUESTED_EVENT,
  ]);
  const auditEntries: TimelineEntry[] = [];
  let cursor: AuditCursor | undefined;
  for (;;) {
    const page = await deps.queryAudit({ limit: 100, cursor });
    // queryAudit pages NEWEST-first; reversing each page keeps accumulation
    // in chronological order, so the stable sort below preserves true event
    // order even when rows share a millisecond timestamp (same-turn
    // create→claim→transition bursts).
    for (const row of [...page.rows].reverse()) {
      if (!relevant.has(row.event_type)) continue;
      // SAFETY: payloads are written via JSON.stringify at each append site;
      // a malformed row is skipped rather than breaking the projection.
      let payload: JsonValueObject;
      try {
        payload = JSON.parse(row.payload);
      } catch {
        continue;
      }
      if (payload.id !== itemId) continue;
      switch (row.event_type) {
        case WORK_ITEM_CREATED_EVENT:
          auditEntries.push({ at: row.ts, kind: "created", by: z.string().catch(row.actor).parse(payload.requester) });
          break;
        case JOB_CLAIMED_EVENT:
          auditEntries.push({ at: row.ts, kind: "claimed", runner: row.actor });
          break;
        case WORK_ITEM_FAILED_EVENT:
          auditEntries.push({ at: row.ts, kind: "failed", cause: z.string().catch("").parse(payload.error) });
          break;
        case DELIVERY_PENDING_EVENT:
        case DELIVERY_REQUESTED_EVENT:
          const prUrl = z.string().safeParse(payload.pr_url);
          const entry: TimelineEntry = prUrl.success
            ? { at: row.ts, kind: "delivery-pending", prUrl: prUrl.data }
            : { at: row.ts, kind: "delivery-pending" };
          auditEntries.push(entry);
          break;
        case WORK_ITEM_TRANSITION_EVENT: {
          const cause = "";
          if (payload.to === "blocked") auditEntries.push({ at: row.ts, kind: "blocked", cause });
          else if (payload.to === "done") auditEntries.push({ at: row.ts, kind: "completed", cause });
          else if (payload.to === "aborted") auditEntries.push({ at: row.ts, kind: "failed", cause });
          break;
        }
        default:
          break;
      }
    }
    cursor = page.nextCursor ?? undefined;
    if (cursor === undefined) break;
  }

  // Transcript spans (no new writes — pure read of the existing JSONL).
  const transcriptEntries: TimelineEntry[] = [];
  const transcriptPath = itemTranscriptPath(transcriptDir, item);
  if (transcriptPath !== null) {
    const parsed = parseItemTranscript(readFileSync(transcriptPath, "utf8"), item.created_at);
    for (const turn of parsed.turns) {
      transcriptEntries.push({ at: turn.at, kind: "turn", summary: turn.summary, transcriptSpan: turn.span });
    }
    for (const call of parsed.toolCalls) {
      transcriptEntries.push({
        at: call.at,
        kind: "tool-call",
        tool: call.tool,
        argsDigest: call.argsDigest,
        transcriptSpan: call.span,
      });
    }
  }

  // Chronological merge; JS sort is stable so equal timestamps keep
  // insertion order (audit first, then transcript line order).
  const merged = [...auditEntries, ...transcriptEntries].sort((a, b) => a.at - b.at);
  return merged.slice(0, MAX_TIMELINE_ENTRIES);
}
