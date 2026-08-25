/**
 * Retry-with-context router (issue #358): the server side of the BLOCKED
 * issue card's "Retry with context" button.
 *
 * The card is posted by the outbox post seam when an item lands blocked;
 * the button carries the WORK ITEM id. A click forks the failed item at
 * its failure point (`afterKind: "failed"`) through the SAME fork service
 * the REST endpoint uses, so the new attempt boots with the bounded prior
 * context, runs in the same space (delivery-approval requirements apply
 * unchanged), and records the `forked-from` edge via its own
 * `work_item.forked` audit row — which is also this router's settle-once
 * dedupe key: the FIRST click wins, later clicks answer with a pointer to
 * the existing fork. No in-memory state, restart-safe by construction.
 */
import type { Store } from "../../store/db";
import { WORK_ITEM_FORKED_EVENT } from "../../store/audit-events";
import { RETRY_WITH_CONTEXT_ACTION_ID } from "./blocks";
import type { SlackAction, SlackAdapter } from "./slack";
import { resolveBlockAction } from "./block-flow";
import { forkWorkItem } from "../../work-items/fork";

export interface RetryRouterDeps {
  /** Full store satisfies the picks (timeline walk + fork creation + audit dedupe). */
  store: Store;
  /** The executor transcripts dir (read-only source of the prior-context block). */
  transcriptDir?: string;
  /** Only postMessage is used; a full SlackAdapter also satisfies this. */
  adapter: Pick<SlackAdapter, "postMessage">;
  /** Observability seam; defaults to console.log. */
  log?: (line: string) => void;
}

/** True when a `work_item.forked` payload records a fork OF `sourceId`. */
function isForkOf(payloadText: string, sourceId: string): boolean {
  try {
    // SAFETY: forked payloads are appended by createWorkItem via
    // JSON.stringify({id, forked_from, ...}); a malformed row is not a match.
    return (JSON.parse(payloadText) as { forked_from?: unknown }).forked_from === sourceId;
  } catch {
    return false;
  }
}

/**
 * One block-action click on a Retry-with-context button (issue #358).
 * Returns true when the click created a fork (or answered with the
 * existing one), false when ignored (foreign space, unknown item,
 * unparseable value).
 */
export async function resolveRetryAction(deps: RetryRouterDeps, action: SlackAction): Promise<boolean> {
  const log = deps.log ?? ((line: string) => console.log(line));
  let forkId: string | null = null;
  let alreadyForked = false;
  return resolveBlockAction(log, action, {
    owns: (a) => a.actionId === RETRY_WITH_CONTEXT_ACTION_ID,
    guard: async (a) => {
      if (a.value.trim().length === 0) return "[retry] ignoring click with empty work-item id";
      const source = await deps.store.getWorkItem(a.value);
      if (source === null) return `[retry] ignoring action for unknown item ${a.value}`;
      if (source.space_id !== a.spaceId) return `[retry] ignoring action for ${a.value} from foreign space ${a.spaceId}`;
      // Settle-once across restarts: the fork's own audit row is the record.
      const page = await deps.store.queryAudit({ event_type: WORK_ITEM_FORKED_EVENT });
      const existing = page.rows.find((row) => isForkOf(row.payload, a.value));
      if (existing !== undefined) {
        try {
          // SAFETY: the payload was written by createWorkItem via
          // JSON.stringify with a string `id`; an unreadable record is
          // reported, never crash-wrapped into a fork.
          forkId = (JSON.parse(existing.payload) as { id?: unknown }).id as string;
          alreadyForked = true;
          return null;
        } catch {
          return `[retry] ignoring action for ${a.value}: unreadable fork record`;
        }
      }
      return null;
    },
    settle: async (a) => {
      if (alreadyForked) return { outcome: { forkId: forkId!, existed: true } };
      const fork = await forkWorkItem(
        { ...deps.store, transcriptDir: deps.transcriptDir ?? "data/transcripts" },
        {
          sourceId: a.value,
          afterKind: "failed",
          requester: a.principal,
          note: `retried from chat by ${a.principal}`,
        },
      );
      forkId = fork.id;
      return { outcome: { forkId: fork.id, existed: false } };
    },
    rewrite: async (a, outcome) => {
      // A fresh confirmation post (never a rewrite of the failure card): the
      // blocked landing stays visible history; the fork announces itself.
      const text = outcome.existed
        ? `Already retried — ${outcome.forkId} is the running attempt.`
        : `Retrying with context — forked as *${outcome.forkId}* (attempt inherits the failed run's progress).`;
      await deps.adapter.postMessage(a.spaceId, text).catch((err) => log(`[retry] postMessage failed for ${a.value}: ${String(err)}`));
    },
  });
}

