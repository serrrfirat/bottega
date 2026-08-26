/**
 * Shared work-review continuation service (issue #359): continue a blocked
 * item from its latest failure, once per source and space.
 */
import { forkWorkItem } from "../../work-items/fork";
import type { AuditCursor, Store } from "../../store/db";
import {
  WORK_ITEM_FORKED_EVENT,
  WORK_REVIEW_CONTINUATION_REQUESTED_EVENT,
  WORK_REVIEW_CONTINUATION_RESOLVED_EVENT,
} from "../../store/audit-events";

export const CONTINUATION_GUIDANCE_MAX_CHARS = 2000;
export type ContinueResult = { forkId: string; existed: boolean };

type ContinuationInput = {
  sourceId: string;
  requester: string;
  spaceId: string;
  guidance?: string;
};

// ponytail: one process-local lock per store/source; the append-only fork audit
// remains the restart-safe dedupe record, while this prevents concurrent clicks
// in one process from both passing the read-before-create check.
const locks = new WeakMap<Store, Map<string, Promise<void>>>();

function isForkOf(payloadText: string, sourceId: string): { forkId: string } | null {
  try {
    const payload = JSON.parse(payloadText) as { id?: unknown; forked_from?: unknown };
    return payload.forked_from === sourceId && typeof payload.id === "string" ? { forkId: payload.id } : null;
  } catch {
    return null;
  }
}

async function existingFork(store: Pick<Store, "queryAudit">, sourceId: string): Promise<string | null> {
  let cursor: AuditCursor | undefined;
  for (;;) {
    const page = await store.queryAudit({ event_type: WORK_ITEM_FORKED_EVENT, limit: 100, cursor });
    for (const row of page.rows) {
      const match = isForkOf(row.payload, sourceId);
      if (match !== null) return match.forkId;
    }
    cursor = page.nextCursor ?? undefined;
    if (cursor === undefined) return null;
  }
}

async function withSourceLock<T>(store: Store, sourceId: string, work: () => Promise<T>): Promise<T> {
  let sourceLocks = locks.get(store);
  if (sourceLocks === undefined) {
    sourceLocks = new Map();
    locks.set(store, sourceLocks);
  }
  const previous = sourceLocks.get(sourceId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  sourceLocks.set(sourceId, current);
  await previous;
  try {
    return await work();
  } finally {
    release();
    if (sourceLocks.get(sourceId) === current) sourceLocks.delete(sourceId);
  }
}

export async function continueWork(
  deps: { store: Store; transcriptDir: string },
  input: ContinuationInput,
): Promise<ContinueResult> {
  const source = await deps.store.getWorkItem(input.sourceId);
  if (source === null) throw new Error(`work item not found: ${input.sourceId}`);
  if (source.space_id !== input.spaceId) {
    throw new Error(`cannot continue work item ${input.sourceId} from foreign space ${input.spaceId}`);
  }
  const guidance = input.guidance?.trim();
  if (guidance !== undefined && guidance.length > CONTINUATION_GUIDANCE_MAX_CHARS) {
    throw new Error(`continuation guidance exceeds ${CONTINUATION_GUIDANCE_MAX_CHARS} characters`);
  }
  const note = guidance !== undefined && guidance.length > 0 ? guidance : `retried from chat by ${input.requester}`;

  return withSourceLock(deps.store, input.sourceId, async () => {
    await deps.store.appendAudit({
      space_id: source.space_id,
      actor: input.requester,
      event_type: WORK_REVIEW_CONTINUATION_REQUESTED_EVENT,
      payload: JSON.stringify({ source_id: input.sourceId, by: input.requester, guided: guidance !== undefined && guidance.length > 0 }),
    });

    const forkId = await existingFork(deps.store, input.sourceId);
    if (forkId !== null) {
      const result = { forkId, existed: true } satisfies ContinueResult;
      await deps.store.appendAudit({
        space_id: source.space_id,
        actor: input.requester,
        event_type: WORK_REVIEW_CONTINUATION_RESOLVED_EVENT,
        payload: JSON.stringify({ source_id: input.sourceId, fork_id: forkId, existed: true, by: input.requester }),
      });
      return result;
    }

    const fork = await forkWorkItem(
      { ...deps.store, transcriptDir: deps.transcriptDir },
      { sourceId: input.sourceId, afterKind: "failed", requester: input.requester, note },
    );
    const result = { forkId: fork.id, existed: false } satisfies ContinueResult;
    await deps.store.appendAudit({
      space_id: source.space_id,
      actor: input.requester,
      event_type: WORK_REVIEW_CONTINUATION_RESOLVED_EVENT,
      payload: JSON.stringify({ source_id: input.sourceId, fork_id: fork.id, existed: false, by: input.requester }),
    });
    return result;
  });
}
