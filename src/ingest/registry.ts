/**
 * Ingest provider registry (issue #57): the single name → adapter lookup
 * for both inbound legs. Unknown providers THROW (fail closed) — a missing
 * adapter is an operator error, never a silent no-op.
 *
 * The registry is shared by the webhook and poller legs; provider files
 * live under src/ingest/<provider>/ (webhook.ts + poller.ts per provider).
 */
import type { Poller, SignatureVerifier } from "./types";
import { githubSignatureVerifier } from "./github/webhook";
import { linearSignatureVerifier } from "./linear/webhook";
import { createGithubPoller } from "./github/poller";
import { createLinearPoller } from "./linear/poller";

/** The verifier for a provider's webhook signatures. Throws for unknown providers. */
export function getVerifier(provider: string): SignatureVerifier {
  switch (provider) {
    case "github":
      return githubSignatureVerifier;
    case "linear":
      return linearSignatureVerifier;
    default:
      throw new Error(`unknown ingest provider: ${provider}`);
  }
}

/** The poller for a provider's polling leg. Throws for unknown providers. */
export function getPoller(provider: string): Poller {
  switch (provider) {
    case "github":
      return createGithubPoller();
    case "linear":
      return createLinearPoller();
    default:
      throw new Error(`unknown ingest provider: ${provider}`);
  }
}
