/** Typed scheduler action registry helpers (issue #86). */
import {
  DURABLE_ACTION_NAMES,
  type SchedulerAction,
  type SchedulerActionName,
  type SchedulerActionRegistry,
} from "./types";

/**
 * The only action names accepted by durable job creation (issue #341):
 * derived from the single source of truth in types.ts, so a new action is
 * registered in exactly one place.
 */
export const KNOWN_ACTIONS: readonly SchedulerActionName[] = DURABLE_ACTION_NAMES;

/** Builds a name-to-handler registry and rejects ambiguous duplicate registrations. */
export function buildRegistry(actions: SchedulerAction[]): SchedulerActionRegistry {
  const registry: SchedulerActionRegistry = new Map();
  for (const action of actions) {
    if (registry.has(action.name)) throw new Error(`duplicate scheduler action: ${action.name}`);
    registry.set(action.name, action);
  }
  return registry;
}
