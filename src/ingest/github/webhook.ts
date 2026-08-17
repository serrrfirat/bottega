/**
 * GitHub webhook signature verification (issue #57): X-Hub-Signature-256 —
 * the sha256 HMAC of the RAW request body with the shared secret, hex
 * encoded, compared in constant time. Fail closed: a missing, malformed,
 * or mismatched signature is false — the route then rejects the delivery
 * (401 + `ingest.webhook.rejected`, nothing dispatched).
 *
 * The signature is computed over the exact bytes the provider sent — the
 * route passes the raw body untouched (never parsed/reformatted first).
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { SignatureVerifier } from "../types";

/** The GitHub webhook signature header (lowercase — the route normalizes header keys). */
export const GITHUB_SIGNATURE_HEADER = "x-hub-signature-256";

/** The `sha256=<64 hex>` prefix GitHub signs with. */
const SHA256_PREFIX = "sha256=";
/** Exactly one sha256 hex digest (64 chars) — anything else is not a GitHub signature. */
const HEX_DIGEST = /^[0-9a-fA-F]{64}$/;

/**
 * Verifies an X-Hub-Signature-256 header against the raw body and the
 * shared secret. The provided digest must parse as exactly 64 hex chars;
 * the comparison is constant-time over equal-length buffers, so a timing
 * side channel cannot leak the digest. Any deviation (absent header,
 * malformed digest, length mismatch, digest mismatch) is false.
 */
export async function verifyGitHubSignature(
  headers: Record<string, string>,
  rawBody: string,
  secret: string,
): Promise<boolean> {
  const provided = headers[GITHUB_SIGNATURE_HEADER];
  if (provided === undefined) return false;
  const signature = provided.trim();
  if (!signature.startsWith(SHA256_PREFIX)) return false;
  const digest = signature.slice(SHA256_PREFIX.length);
  if (!HEX_DIGEST.test(digest)) return false;

  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  const expectedBytes = Buffer.from(expected, "hex");
  const providedBytes = Buffer.from(digest.toLowerCase(), "hex");
  return expectedBytes.length === providedBytes.length && timingSafeEqual(expectedBytes, providedBytes);
}

/** The GitHub verifier adapter (the registry's `github` entry). */
export const githubSignatureVerifier: SignatureVerifier = {
  verify: verifyGitHubSignature,
};
