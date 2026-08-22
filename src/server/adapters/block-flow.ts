/**
 * Shared building blocks for the Slack block-action routers (issue #341):
 * the one source for the mrkdwn escaping, the best-effort prompt rewrite,
 * and the settle/ignore/rewrite skeleton the approval, delivery, and
 * scheduler routers all follow.
 *
 * The three routers each own genuinely different state (an in-memory
 * pending registry, an audit-trail announcement, scheduler job controls),
 * but their button-click handling shares one outline: decide the click
 * belongs to this router, ignore clicks that fail a guard (logged, state
 * untouched), apply the settlement, then best-effort rewrite the posted
 * prompt with the new state. `resolveBlockAction` factors that outline;
 * each router supplies its own guards, settlement, and rewrite handlers so
 * its outward behavior is unchanged.
 */

import type { SlackAction, SlackAdapter, SlackBlockPayload } from "./slack";

/**
 * Mutates mrkdwn special characters so free-text user input renders
 * literally instead of being parsed as Slack markup. `&` first so the
 * entities the later replacements produce are not re-escaped. Shared by
 * the scheduler router (the only block renderer that embeds arbitrary,
 * untrusted strings) — declared once here, imported everywhere.
 */
export function escapeMrkdwn(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/**
 * Best-effort rewrite of a settled prompt message (issue #341). A failed
 * rewrite must never lose the recorded decision, so the error is only
 * logged via `fail`; the returned promise never rejects. Shared by the
 * approval and delivery routers' fire-and-forget rewrites.
 */
export function bestEffortMessageRewrite(
  adapter: Pick<SlackAdapter, "updateMessage">,
  spaceId: string,
  messageTs: string,
  text: string,
  opts: { blocks?: SlackBlockPayload[] } | undefined,
  fail: (reason: string) => void,
): void {
  void adapter
    .updateMessage(spaceId, messageTs, text, opts)
    .catch((err) => fail(String(err)));
}

/** The result of a settlement step: carry the outcome the rewrite needs. */
export interface BlockActionSettlement<TOutcome> {
  outcome: TOutcome;
}

/**
 * One block-action click's settle/ignore/rewrite skeleton (issue #341 #9):
 * the control flow the approval, delivery, and scheduler routers all run.
 * Each step is a handler so a router keeps its exact logic.
 *
 * `resolveBlockAction` returns `true` when the click was handled (settled
 * and the prompt rewritten) and `false` when it was ignored or a no-op —
 * matching the routers' outward boolean. Every ignore path leaves the
 * underlying state untouched; a rewrite failure never fails the settlement.
 */
export async function resolveBlockAction<TOutcome>(
  log: (line: string) => void,
  action: SlackAction,
  steps: {
    /** True when this router owns the action id; false → not this router's click. */
    owns(action: SlackAction): boolean;
    /**
     * Guard. Return `null` to proceed, or an ignore-reason string — emitted
     * to `log` (prefixed by the router via the returned text) and the click
     * is dropped with the state untouched. An empty string suppresses the
     * log line (a router may already treat an ignore as silent).
     */
    guard?(action: SlackAction): Promise<string | null> | string | null;
    /**
     * Apply the settlement. Return a settlement descriptor when the click
     * changed state and the prompt should be rewritten, or `null` when
     * nothing changed (no rewrite; handled=false).
     */
    settle(
      action: SlackAction,
    ): Promise<BlockActionSettlement<TOutcome> | null> | BlockActionSettlement<TOutcome> | null;
    /**
     * Best-effort rewrite of the prompt with the settled outcome. Must not
     * throw (use {@link bestEffortMessageRewrite} or a local try/catch).
     * May return a promise; the skeleton awaits it so a router that wants
     * the rewrite to finish before returning can do so.
     */
    rewrite(action: SlackAction, outcome: TOutcome): void | Promise<void>;
  },
): Promise<boolean> {
  // Not this router's click — ignore without touching state or logging.
  if (!steps.owns(action)) return false;
  // Guard failure → drop the click (logged at the router's choice), state untouched.
  if (steps.guard) {
    const reason = await steps.guard(action);
    if (reason !== null) {
      if (reason.length > 0) log(reason);
      return false;
    }
  }
  // Settle. null → the click changed nothing; no rewrite.
  const settlement = await steps.settle(action);
  if (settlement === null) return false;
  await steps.rewrite(action, settlement.outcome);
  return true;
}