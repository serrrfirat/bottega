/**
 * The ingest polling scheduler action (issue #57): runs on the durable
 * scheduler's cron (a job with action "ingest_poll", params.space = the
 * target Slack space), polls every configured provider, and dispatches each
 * event through the shared dispatcher (leg "poll").
 *
 * Fail-closed error handling: poll errors are logged loudly and NEVER
 * throw past the action, so the scheduler loop survives a broken provider.
 * An unconfigured provider (no PAT / config-only skeleton) polls to an
 * empty list — no-op. A missing params.space skips the whole pass with a
 * log line (the job cannot target a channel it does not know).
 *
 * Provider pollers are instantiated once per action instance (module-level
 * state is avoided so tests get clean instances): the GitHub poller's
 * dedupe baseline must survive across polls, so a fresh poller per run
 * would re-emit every open mention.
 */
import type { SchedulerAction } from "../scheduler/types";
import { dispatchIngestEvent } from "./dispatch";
import { getPoller } from "./registry";
import type { Poller } from "./types";

const ACTION_NAME = "ingest_poll";
const PROVIDERS = ["github", "linear"] as const;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface IngestPollActionOpts {
  /** Test seam: provider → poller factory; defaults to the ingest registry. */
  pollers?: Record<string, () => Poller>;
}

/** Builds the ingest polling action (one poller instance per provider). */
export function createIngestPollAction(opts: IngestPollActionOpts = {}): SchedulerAction {
  const pollerInstances = new Map<string, Poller>();

  function pollerFor(provider: string): Poller {
    let poller = pollerInstances.get(provider);
    if (!poller) {
      const factory = opts.pollers?.[provider] ?? (() => getPoller(provider));
      poller = factory();
      pollerInstances.set(provider, poller);
    }
    return poller;
  }

  return {
    name: ACTION_NAME,
    async run(params, ctx) {
      const spaceId = params.space?.trim() ?? "";
      if (!spaceId) {
        ctx.log(`[${ACTION_NAME}] no target space (params.space) configured — skipping poll`);
        return;
      }

      for (const provider of PROVIDERS) {
        let poller: Poller;
        try {
          poller = pollerFor(provider);
        } catch (err) {
          ctx.log(`[${ACTION_NAME}] provider ${provider} unavailable: ${errorMessage(err)}`);
          continue;
        }
        try {
          const events = await poller.poll();
          for (const event of events) {
            await dispatchIngestEvent(
              {
                store: ctx.store,
                audit: ctx.audit,
                postMessage: ctx.postMessage,
                log: ctx.log,
                leg: "poll",
                spaceId,
              },
              event,
            );
          }
        } catch (err) {
          // Loud, survivable: the scheduler loop must never die on a poller.
          ctx.log(`[${ACTION_NAME}] ${provider} poll failed: ${errorMessage(err)}`);
        }
      }
    },
  };
}
