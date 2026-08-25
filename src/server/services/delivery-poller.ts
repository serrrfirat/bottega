/**
 * Delivery approval seam (issue #12, #11 follow-up; round trip #149),
 * migrated onto the reactive core (issue #356).
 *
 * The executor runs in its own container and cannot post to Slack: when a
 * work item's PR is opened it writes a `work_item.delivery_pending` audit
 * marker (payload {id, pr_url, summary}) and then waits on the onDelivery
 * seam. The server side of that seam is the `delivery-approval-prompt`
 * behavior below: it reacts to those ledger rows, posts the PR + an
 * interactive approve/deny prompt to the space channel via the adapter, and
 * records a `delivery.requested` audit row so a restart never double-posts.
 *
 * `delivery.requested` is distinct from `approval.requested` (which is
 * reserved for policy-tool approvals with payload {tool, reason}) — the
 * two carry different payload schemas and never share an event name
 * (issue #33).
 *
 * The button round-trip (the human's decision resolving the seam into
 * working -> review -> done) is the delivery router's job
 * (src/server/adapters/delivery-router.ts): a block-action click records
 * `delivery.resolved`, which the executor's onDelivery wait reads as the
 * approval. This module only announces.
 */
import { z } from "zod";
import { DELIVERY_PENDING_EVENT, DELIVERY_REQUESTED_EVENT } from "../../store/audit-events";
import type { AuditRow, Store } from "../../store/db";
import type { ReactionResult, ReactiveBehavior } from "../../events/reactive";
import { startReactiveCore, type ReactiveCore } from "../../events/reactive";
import type { SlackAdapter } from "../adapters/slack";
import { buildDeliveryBlocks } from "../adapters/delivery-router";

export const DEFAULT_POLL_INTERVAL_MS = 5000;

export interface DeliveryPollerDeps {
  /** Only the audit surface is used; a full Store also satisfies this. */
  store: Pick<Store, "listAudit" | "appendAudit">;
  /** Only postMessage is used; a full SlackAdapter also satisfies this. */
  adapter: Pick<SlackAdapter, "postMessage">;
  /** Announcement poll interval. Default 5000 ms. */
  intervalMs?: number;
  log?: (line: string) => void;
}

export interface DeliveryPoller {
  start(): void;
  stop(): void;
}

/** The `work_item.delivery_pending` marker payload, decoded at the audit-row boundary. */
const DeliveryPayloadSchema = z.object({
  id: z.string().optional(),
  pr_url: z.string().optional(),
  summary: z.string().optional().catch(""),
});
type DeliveryPayload = z.infer<typeof DeliveryPayloadSchema>;

/** A recognized no-op: consumed once, never retried. */
const NO_OP: ReactionResult = { handled: false };

function parsePayload(raw: string): DeliveryPayload | null {
  try {
    return DeliveryPayloadSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * Announces one delivery_pending marker whose item has no delivery.requested
 * row yet: posts the PR + approval request to the space channel and records
 * the request. Returns true when an announcement was made, false for
 * recognized no-ops. Throws on post/record failures — the reactive core
 * retries with backoff and the audit row dedupes replays after a crash.
 */
async function announcePendingDelivery(
  store: Pick<Store, "listAudit" | "appendAudit">,
  adapter: Pick<SlackAdapter, "postMessage">,
  row: AuditRow,
): Promise<ReactionResult> {
  if (!row.space_id || row.event_type !== DELIVERY_PENDING_EVENT) return NO_OP;
  const payload = parsePayload(row.payload);
  if (!payload || payload.id === undefined || payload.pr_url === undefined) return NO_OP;
  const requested = await store.listAudit({ event_type: DELIVERY_REQUESTED_EVENT });
  for (const requestedRow of requested) {
    const requestedPayload = parsePayload(requestedRow.payload);
    if (requestedPayload?.id === payload.id) return NO_OP;
  }
  const summary = payload.summary ?? "";
  // Interactive prompt: approve/deny buttons carry the work item id, the
  // key the delivery router resolves on (issue #149).
  await adapter.postMessage(
    row.space_id,
    `PR ready: ${payload.pr_url} — approve to finish`,
    { blocks: buildDeliveryBlocks(payload.pr_url, summary, payload.id) },
  );
  await store.appendAudit({
    space_id: row.space_id,
    actor: "server",
    event_type: DELIVERY_REQUESTED_EVENT,
    payload: JSON.stringify({
      id: payload.id,
      pr_url: payload.pr_url,
      summary,
    }),
  });
  return { handled: true };
}

/**
 * The delivery-approval-prompt behavior (issue #356): reacts to every
 * `work_item.delivery_pending` ledger row exactly once per item — the
 * `delivery.requested` audit row is the dedupe key across crash replays.
 */
export function deliveryApprovalPromptBehavior(deps: DeliveryPollerDeps): ReactiveBehavior {
  return {
    id: "delivery-approval-prompt",
    events: [DELIVERY_PENDING_EVENT],
    react: (row) => announcePendingDelivery(deps.store, deps.adapter, row),
  };
}

/**
 * One poll pass over every pending marker (the flow-level helper the
 * behavior composes per row). Idempotent across restarts — the audit row is
 * the dedupe key.
 */
export async function pollPendingDeliveries(
  store: Pick<Store, "listAudit" | "appendAudit">,
  adapter: Pick<SlackAdapter, "postMessage">,
): Promise<number> {
  const pending = await store.listAudit({ event_type: DELIVERY_PENDING_EVENT });
  let posted = 0;
  for (const row of pending) {
    if ((await announcePendingDelivery(store, adapter, row)).handled) posted += 1;
  }
  return posted;
}

/**
 * Background loop around the {@link deliveryApprovalPromptBehavior} — a
 * single-behavior reactive core (issue #356). First pass runs immediately.
 */
export function startDeliveryPoller(deps: DeliveryPollerDeps): DeliveryPoller {
  const log = deps.log ?? (() => {});
  const intervalMs = deps.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const core: ReactiveCore = startReactiveCore(
    deps.store,
    [deliveryApprovalPromptBehavior(deps)],
    {
      intervalMs,
      // Retry eligibility aligned with the pass cadence: the first retry
      // runs on the next pass, later consecutive failures back off.
      backoffMs: intervalMs,
      onError: ({ error }) => {
        // One bad reaction must not kill the loop; unposted rows retry next tick.
        log(`delivery poller: poll failed: ${error instanceof Error ? error.message : String(error)}`);
      },
      onPass: ({ delivered }) => {
        if (delivered > 0) log(`delivery poller: announced ${delivered} approval request(s)`);
      },
    },
  );
  return {
    start() {
      core.start();
    },
    stop() {
      core.stop();
    },
  };
}
