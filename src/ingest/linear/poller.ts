/**
 * Linear poller skeleton (issue #57) — config-only. Linear has no polling
 * leg in v1 (its adapter surface proves provider-agnosticism without a
 * live journey): unconfigured providers are no-ops, so this poller always
 * returns an empty list. The contract (`Poller`) compiles; a real Linear
 * "updated issues" poll lands behind the same interface.
 */
import type { Poller } from "../types";

/** The Linear polling leg (config-only for v1 — never configured → no-op). */
export function createLinearPoller(): Poller {
  return {
    async poll() {
      return [];
    },
  };
}
