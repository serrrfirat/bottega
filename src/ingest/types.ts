/**
 * Generic extension-ingest contracts (issue #57).
 *
 * The ingest framework is provider-agnostic: every inbound leg (webhook,
 * scheduler poller) reduces to a stream of {@link IngestEvent}s that the
 * single shared dispatcher (src/ingest/dispatch.ts) turns into a work-item
 * row + Slack post + audit trail. Providers are adapters behind the
 * verifier (webhook leg) and poller (polling leg) contracts.
 *
 * Fail-closed by design: an event that fails validation is audited as
 * `ingest.<leg>.rejected` and NEVER dispatched; an unknown provider is an
 * error, never a silent no-op.
 */

/**
 * One normalized inbound extension event. `payload` is provider- and
 * eventType-specific; the dispatcher validates it before anything is
 * created or posted.
 */
export interface IngestEvent {
  /** The extension that produced the event. */
  provider: "github" | "linear";
  /** Provider-specific event kind (e.g. "mention", an issue_comment webhook). */
  eventType: string;
  /** Validated payload; shape depends on provider + eventType. */
  payload: unknown;
  /** When the event occurred (ISO 8601; the dispatcher requires a parseable timestamp). */
  occurredAt: string;
}

/**
 * Webhook signature verification (issue #57): each provider implements its
 * own scheme (GitHub X-Hub-Signature-256, Linear HMAC) behind this
 * interface. Returns false (never throws) when the signature is missing or
 * does not match — the route fails closed with a 401.
 */
export interface SignatureVerifier {
  verify(headers: Record<string, string>, rawBody: string, secret: string): Promise<boolean>;
}

/**
 * Scheduler polling leg (issue #57): one poll pass against a provider API
 * (e.g. GitHub mentions in issues/PRs). Providers that are not configured
 * return an empty list (config-only skeletons are no-ops); a configured
 * poller that fails throws — the scheduler action logs the error loudly
 * and the loop survives.
 */
export interface Poller {
  poll(): Promise<IngestEvent[]>;
}
