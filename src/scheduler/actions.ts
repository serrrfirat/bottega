/** Typed scheduler action registry helpers (issue #86). */
import type {
  SchedulerAction,
  SchedulerActionName,
  SchedulerActionRegistry,
} from "./types";

/** The only action names accepted by durable job creation. Handlers are wired elsewhere. */
export const KNOWN_ACTIONS = [
  "standup_digest",
  "reflection",
  "org_pulse",
  "recurring_work",
  "ingest_poll",
] as const satisfies readonly SchedulerActionName[];

/** Builds a name-to-handler registry and rejects ambiguous duplicate registrations. */
export function buildRegistry(actions: SchedulerAction[]): SchedulerActionRegistry {
  const registry: SchedulerActionRegistry = new Map();
  for (const action of actions) {
    if (registry.has(action.name)) throw new Error(`duplicate scheduler action: ${action.name}`);
    registry.set(action.name, action);
  }
  return registry;
}
