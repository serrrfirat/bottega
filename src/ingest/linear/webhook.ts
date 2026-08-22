/**
 * Linear webhook HMAC skeleton (issue #57): the provider-agnostic
 * signature-verifier contract compiles and the adapter is registered, but
 * the journey is NOT wired — this is the config-only Linear skeleton.
 *
 * Linear signs webhook deliveries with HMAC-SHA256 of the raw body hex
 * encoded (`Linear-Signature` header; the signing key is the webhook's
 * HMAC secret). The real comparison lands with the Linear journey; until
 * then the verifier ALWAYS returns false, so the route fails closed: an
 * unconfigured provider is never a silent no-op (401 +
 * `ingest.webhook.rejected`, nothing dispatched — "unconfigured →
 * skipped").
 */
import type { SignatureVerifier } from "../types";

/** The Linear webhook signature header (lowercase — the route normalizes header keys). */
export const LINEAR_SIGNATURE_HEADER = "linear-signature";

/** The Linear verifier adapter (the registry's `linear` entry). */
export const linearSignatureVerifier: SignatureVerifier = {
  async verify() {
    // Config-only skeleton: no Linear webhook secret is provisioned (there
    // is no `linear-webhook` boot-secret row), so every delivery is
    // refused until the real HMAC comparison is implemented.
    return false;
  },
};
