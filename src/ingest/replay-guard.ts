/**
 * Webhook replay guard (issue #346 #2): bounded in-memory idempotency for
 * inbound webhook deliveries, keyed on a provider delivery-id where one
 * exists (GitHub `x-github-delivery`). A captured valid delivery must not
 * replay indefinitely into duplicate work items/spam; recording a
 * processed delivery-id makes a re-delivery a same-session no-op.
 *
 * The store is deliberately small and in-memory (mirroring the bounded
 * pending-registry pattern in the approval/delivery routers): no schema
 * migration, no I/O on the hot path. Entries expire after a TTL (default
 * one day — comfortably above GitHub's ~24h retry budget) and the map is
 * bounded: at capacity the oldest entry is evicted, so the guard can never
 * grow without bound. A server restart resets the set — the generic
 * scheme's `x-bottega-timestamp` skew check (±5 min) bounds replay across
 * restarts for manifest-declared webhooks; provider retries that land on a
 * different instance after a restart are re-dispatched, which the store's
 * own work-item dedup tolerates rather than duplicates.
 */

/**
 * Registry bound: at capacity the oldest recorded delivery is evicted
 * (treated as a fresh one on its next sighting). Kept small — a replay
 * guard needs only a recent window, not every delivery ever seen.
 */
const MAX_TRACKED = 4096;

/**
 * A delivery-id idempotency guard. One instance is shared per inbound
 * surface (the route owns it); thread-safe because Bun runs the route
 * single-threaded and all calls are awaited sequentially per request.
 */
export class ReplayGuard {
  private readonly entries = new Map<string, number>();
  private readonly ttlMs: number;

  constructor(opts: { ttlMs?: number } = {}) {
    this.ttlMs = opts.ttlMs ?? 24 * 60 * 60 * 1000; // 24h default
  }

  private key(provider: string, deliveryId: string): string {
    return `${provider}:${deliveryId}`;
  }

  /**
   * Returns true when `(provider, deliveryId)` was already seen and is
   * still within its TTL (a replay — the caller should no-op). Otherwise
   * records it as seen and returns false (a fresh delivery — proceed).
   * Expired entries and at-capacity evictions are dropped lazily.
   */
  isReplayed(provider: string, deliveryId: string): boolean {
    const now = Date.now();
    const k = this.key(provider, deliveryId);
    const expiry = this.entries.get(k);
    if (expiry !== undefined && expiry > now) return true;
    // Seen but expired, or never seen → record as fresh.
    if (this.entries.size >= MAX_TRACKED) {
      // Oldest insertion first (a Map preserves insertion order); evict it.
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    // Refresh first so repeated reuse does not extend the window unboundedly.
    this.entries.delete(k);
    this.entries.set(k, now + this.ttlMs);
    return false;
  }

  /** Number of tracked deliveries (test observability). */
  get size(): number {
    return this.entries.size;
  }
}