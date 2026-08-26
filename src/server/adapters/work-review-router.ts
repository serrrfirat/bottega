/**
 * Open-review action router (issue #359): the server side of the BLOCKED
 * issue card's "Open review" button. A click from a verified Slack actor is
 * authorized LIVE — the actor must currently be a member of the work item's
 * originating channel (conversations.members, never cached, fail-closed on
 * API error) — and only then does the router mint an actor-bound,
 * single-use review token (hashed at rest by the store) and deliver its
 * private link by EPHEMERAL message: visible to that user only, forwarding
 * it grants no other Slack identity authority. The route itself re-checks
 * membership again at redemption (see src/server/work-review/routes.ts).
 */
import type { Store } from "../../store/db";
import { OPEN_WORK_REVIEW_ACTION_ID } from "./blocks";
import type { SlackAction, SlackAdapter } from "./slack";
import { resolveBlockAction } from "./block-flow";

/** How long one minted review token stays redeemable (single-use). */
export const OPEN_WORK_REVIEW_TOKEN_TTL_MS = 15 * 60_000;

export interface WorkReviewRouterDeps {
  store: Store;
  /** The live membership gate + the ephemeral delivery surface (issue #359). */
  adapter: Pick<SlackAdapter, "isChannelMember" | "postEphemeral">;
  /**
   * Late-bound PUBLIC base URL the browser reaches this server at — resolved
   * per mint (`uploadLinkPublicBase() ?? oauthCallback.baseUrl` in the
   * composition root), so a rotated tunnel host heals without a restart.
   */
  publicBaseUrl(): string;
  /** Observability seam; defaults to console.log. */
  log?: (line: string) => void;
}

/**
 * One block-action click on an Open-review button (issue #359). Returns
 * true when the click minted + delivered a review link, false when ignored
 * or DENIED — foreign space, unknown item, missing identity, non-member,
 * or membership-outage (all deny without leaking any work details to the
 * clicker; only server logs carry context).
 */
export async function resolveOpenReviewAction(deps: WorkReviewRouterDeps, action: SlackAction): Promise<boolean> {
  const log = deps.log ?? ((line: string) => console.log(line));
  return resolveBlockAction(log, action, {
    owns: (a) => a.actionId === OPEN_WORK_REVIEW_ACTION_ID,
    guard: async (a) => {
      if (a.value.trim().length === 0) return "[work-review] ignoring click with empty work-item id";
      const source = await deps.store.getWorkItem(a.value);
      if (source === null) return `[work-review] ignoring action for unknown item ${a.value}`;
      if (source.space_id !== a.spaceId) {
        return `[work-review] denying open-review for ${a.value} from foreign space ${a.spaceId}`;
      }
      if (a.teamId === undefined || a.teamId.length === 0) {
        return `[work-review] denying open-review for ${a.value}: no team id on the verified payload`;
      }
      // The live authorization gate: current channel membership, asked NOW.
      try {
        const member = await deps.adapter.isChannelMember(a.spaceId, a.principal);
        if (!member) return `[work-review] denied open-review for ${a.value}: ${a.principal} is not a current member`;
        return null;
      } catch (err) {
        return `[work-review] denied open-review for ${a.value}: membership lookup failed (${String(err)})`;
      }
    },
    settle: (a) => {
      // The guard above already denied identity-less clicks; this branch is
      // the typed restatement, never a live path.
      if (!a.teamId) return null;
      const rawToken = deps.store.createWorkReviewToken(
        {
          workItemId: a.value,
          slackTeamId: a.teamId,
          slackUserId: a.principal,
          slackChannelId: a.spaceId.replace(/^slack:/u, ""),
        },
        Date.now() + OPEN_WORK_REVIEW_TOKEN_TTL_MS,
      );
      return {
        outcome: {
          link: `${deps.publicBaseUrl()}/work-review/redeem/${rawToken}`,
          userId: a.principal,
          spaceId: a.spaceId,
        },
      };
    },
    rewrite: async (_action, outcome) => {
      const text =
        `Your private review of this work: ${outcome.link}\n` +
        "The link opens for you only and expires soon.";
      await deps.adapter
        .postEphemeral(outcome.spaceId, outcome.userId, text)
        .catch((err) => log(`[work-review] ephemeral post failed: ${String(err)} — the minted token simply expires unused`));
    },
  });
}
