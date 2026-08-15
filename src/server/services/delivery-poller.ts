/**
 * Delivery approval poller (issue #12, #11 follow-up).
 *
 * The executor runs in its own container and cannot post to Slack: when a
 * work item's PR is opened it writes a `work_item.delivery_pending` audit
 * marker (payload {id, pr_url, summary}) and then waits on the onDelivery
 * seam. The server side of that seam is this poller: it watches the audit
 * trail, posts the PR + approval request to the space channel via the
 * adapter, and records a `delivery.requested` audit row so a restart never
 * double-posts.
 *
 * `delivery.requested` is distinct from `approval.requested` (which is
 * reserved for policy-tool approvals with payload {tool, reason}) — the
 * two carry different payload schemas and never share an event name
 * (issue #33).
 *
 * The button round-trip (the human's decision resolving the seam into
 * working -> review -> done) is a later adapter issue; this module only
 * announces. The executor keeps waiting, so the item stays `working` until
 * that path lands.
 */
import { DELIVERY_PENDING_EVENT, DELIVERY_REQUESTED_EVENT } from "../../store/audit-events";
import type { Store } from "../../store/db";
import type { SlackAdapter } from "../adapters/slack";

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

interface DeliveryPayload {
  id?: unknown;
  pr_url?: unknown;
  summary?: unknown;
}

function parsePayload(raw: string): DeliveryPayload | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as DeliveryPayload) : null;
  } catch {
    return null;
  }
}

/**
 * One poll pass: for every delivery_pending marker whose item has no
 * delivery.requested row yet, post the PR + approval request to the space
 * channel and record the request. Returns the number of announcements made.
 * Idempotent across restarts — the audit row is the dedupe key.
 */
export async function pollPendingDeliveries(
  store: Pick<Store, "listAudit" | "appendAudit">,
  adapter: Pick<SlackAdapter, "postMessage">,
): Promise<number> {
  const [pending, requested] = await Promise.all([
    store.listAudit({ event_type: DELIVERY_PENDING_EVENT }),
    store.listAudit({ event_type: DELIVERY_REQUESTED_EVENT }),
  ]);
  const announced = new Set<string>();
  for (const row of requested) {
    const payload = parsePayload(row.payload);
    if (payload && typeof payload.id === "string") announced.add(payload.id);
  }

  let posted = 0;
  for (const row of pending) {
    if (!row.space_id) continue;
    const payload = parsePayload(row.payload);
    if (!payload || typeof payload.id !== "string" || typeof payload.pr_url !== "string") continue;
    if (announced.has(payload.id)) continue;
    await adapter.postMessage(row.space_id, `PR ready: ${payload.pr_url} — approve to finish`);
    await store.appendAudit({
      space_id: row.space_id,
      actor: "server",
      event_type: DELIVERY_REQUESTED_EVENT,
      payload: JSON.stringify({
        id: payload.id,
        pr_url: payload.pr_url,
        summary: typeof payload.summary === "string" ? payload.summary : "",
      }),
    });
    announced.add(payload.id);
    posted += 1;
  }
  return posted;
}

/** Background loop around {@link pollPendingDeliveries}. First pass runs immediately. */
export function startDeliveryPoller(deps: DeliveryPollerDeps): DeliveryPoller {
  const log = deps.log ?? (() => {});
  const intervalMs = deps.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  let timer: ReturnType<typeof setInterval> | null = null;

  const tick = async (): Promise<void> => {
    try {
      const posted = await pollPendingDeliveries(deps.store, deps.adapter);
      if (posted > 0) log(`delivery poller: announced ${posted} approval request(s)`);
    } catch (err) {
      // One bad pass must not kill the loop; unposted rows retry next tick.
      log(`delivery poller: poll failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return {
    start() {
      if (timer !== null) return;
      void tick(); // announce anything pending from before boot immediately
      timer = setInterval(tick, intervalMs);
    },
    stop() {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
