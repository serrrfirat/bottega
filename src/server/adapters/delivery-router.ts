/**
 * Delivery approval router (issue #149): the server side of the executor's
 * onDelivery seam.
 *
 * The executor runs in its own container and cannot post to Slack. When a
 * work item's PR is opened it writes a `work_item.delivery_pending` audit
 * marker and then waits on onDelivery. This module completes the round
 * trip:
 *
 *   1. The delivery poller (src/server/services/delivery-poller.ts) posts
 *      the interactive prompt built by {@link buildDeliveryBlocks} and
 *      records `delivery.requested`.
 *   2. A human clicks a button. {@link resolveDeliveryAction} records the
 *      decision as `delivery.resolved` (the executor's wait reads this —
 *      the audit trail is the cross-process channel, mirroring how the
 *      poller already uses audit rows as its dedupe key) and rewrites the
 *      posted prompt with the outcome, mirroring the #44 exec-tier
 *      approval router's settle-then-rewrite shape.
 *
 * No in-memory registry: settle-once comes from the audit trail itself, so
 * a server restart can never lose a decision or double-settle a request.
 * The first recorded click wins (the executor's wait reads the earliest
 * matching row).
 */
import { z } from "zod";
import { DELIVERY_REQUESTED_EVENT, DELIVERY_RESOLVED_EVENT } from "../../store/audit-events";
import type { Store } from "../../store/db";
import {
  DELIVERY_APPROVE_ACTION_ID,
  DELIVERY_DENY_ACTION_ID,
  type SlackAction,
  type SlackAdapter,
  type SlackBlockPayload,
} from "./slack";
import { bestEffortMessageRewrite, escapeMrkdwn, resolveBlockAction } from "./block-flow";

/**
 * The `delivery.requested` payload as the poller writes it (all strings).
 * Decoded at the audit-row boundary; `delivery.resolved` rows (id + boolean
 * fields) still parse — extra keys are stripped.
 */
const DeliveryRequestPayloadSchema = z.object({
  id: z.string().optional(),
  pr_url: z.string().optional(),
  summary: z.string().optional(),
});
type DeliveryRequestPayload = z.infer<typeof DeliveryRequestPayloadSchema>;

function parsePayload(raw: string): DeliveryRequestPayload | null {
  try {
    const parsed = DeliveryRequestPayloadSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Renders the interactive delivery-approval blocks: PR + summary, then
 * Approve/Deny buttons carrying the WORK ITEM id (the value the resolver
 * keys on). Pure so the outbound rendering is testable without Slack.
 */
export function buildDeliveryBlocks(prUrl: string, summary: string, id: string): SlackBlockPayload[] {
  // summary and prUrl are user-derived (agent/model message text), so they
  // are escaped with the shared escapeMrkdwn (mirrors scheduler-router) to
  // stop mrkdwn injection into the delivered approval blocks.
  const safePrUrl = escapeMrkdwn(prUrl);
  const safeSummary = escapeMrkdwn(summary);
  const summaryBlock: SlackBlockPayload[] = summary
    ? [{ type: "section", text: { type: "mrkdwn", text: `*Summary:* ${safeSummary}` } }]
    : [];
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: `*Delivery approval required* — <${safePrUrl}|PR ready>` },
    },
    ...summaryBlock,
    {
      type: "actions",
      block_id: "bottega_delivery",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Approve" },
          action_id: DELIVERY_APPROVE_ACTION_ID,
          value: id,
          style: "primary",
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Deny" },
          action_id: DELIVERY_DENY_ACTION_ID,
          value: id,
          style: "danger",
        },
      ],
    },
  ];
}

/** Outcome line replacing the prompt message once a click settles. */
function outcomeText(prUrl: string, approved: boolean, principal: string): string {
  // prUrl is user-derived; escaped to keep mrkdwn out of the settled prompt.
  const safePrUrl = escapeMrkdwn(prUrl);
  return approved
    ? `*Delivery approved* — <${safePrUrl}|PR>: approved by <@${principal}>.`
    : `*Delivery denied* — <${safePrUrl}|PR>: denied by <@${principal}>.`;
}

export interface DeliveryResolverDeps {
  /** Only the audit surface is used; a full Store also satisfies this. */
  store: Pick<Store, "listAudit" | "appendAudit">;
  /** Only postMessage/updateMessage are used; a full SlackAdapter also satisfies this. */
  adapter: Pick<SlackAdapter, "postMessage" | "updateMessage">;
  /** Observability seam; defaults to console.log. */
  log?: (line: string) => void;
}

/**
 * One block-action click on a delivery approval (issue #149). Records the
 * human's decision in the audit trail — `delivery.resolved`, the row the
 * executor's onDelivery wait reads — and rewrites the posted prompt with
 * the outcome.
 *
 * Ignored (returns false) when the action is not a delivery action, the
 * item was never announced, the click comes from a foreign space, or the
 * item is already resolved (first recorded click wins; settle-once holds
 * across restarts because the audit row, not memory, is the source of
 * truth). A failed message rewrite must never lose the recorded decision —
 * the update is best-effort, the audit row is the decision.
 */
export async function resolveDeliveryAction(
  deps: DeliveryResolverDeps,
  action: SlackAction,
): Promise<boolean> {
  const log = deps.log ?? ((line: string) => console.log(line));
  let announcement:
    | Awaited<ReturnType<Store["listAudit"]>>[number]
    | undefined;
  return resolveBlockAction(
    log,
    action,
    {
      // Delivery owns every block-action click that reaches it (the slack
      // router already filters to the delivery ids); the guard below keeps
      // the non-delivery ownership log, mirroring the original behavior.
      owns: () => true,
      guard: async (a) => {
        const approved = a.actionId === DELIVERY_APPROVE_ACTION_ID;
        if (!approved && a.actionId !== DELIVERY_DENY_ACTION_ID) {
          return `[delivery] ignoring non-delivery action ${a.actionId}`;
        }
        const [requested, resolved] = await Promise.all([
          deps.store.listAudit({ event_type: DELIVERY_REQUESTED_EVENT }),
          deps.store.listAudit({ event_type: DELIVERY_RESOLVED_EVENT }),
        ]);
        announcement = requested.find((row) => parsePayload(row.payload)?.id === a.value);
        if (!announcement) return `[delivery] ignoring action for unknown item ${a.value}`;
        if (announcement.space_id !== a.spaceId) {
          return `[delivery] ignoring action for ${a.value} from foreign space ${a.spaceId}`;
        }
        if (resolved.some((row) => parsePayload(row.payload)?.id === a.value)) {
          return `[delivery] ignoring action for already-resolved item ${a.value}`;
        }
        return null;
      },
      settle: async (a) => {
        const row = announcement!;
        const payload = parsePayload(row.payload);
        const prUrl = payload?.pr_url ?? a.value;
        const approved = a.actionId === DELIVERY_APPROVE_ACTION_ID;
        await deps.store.appendAudit({
          space_id: a.spaceId,
          actor: a.principal,
          event_type: DELIVERY_RESOLVED_EVENT,
          payload: JSON.stringify({ id: a.value, approved, approver: a.principal }),
        });
        return { outcome: { prUrl, approved, principal: a.principal } };
      },
      // Rewrite the prompt with the outcome. Best-effort by design: the audit
      // row above is the decision; a failed rewrite must not lose it.
      rewrite: (a, outcome) =>
        bestEffortMessageRewrite(
          deps.adapter,
          a.spaceId,
          a.messageTs,
          outcomeText(outcome.prUrl, outcome.approved, outcome.principal),
          undefined,
          (reason) => log(`[delivery] updateMessage failed for ${a.value}: ${reason}`),
        ),
    },
  );
}
