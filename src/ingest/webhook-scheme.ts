/**
 * Manifest-declared webhook schemes (issue #57 follow-up): the single
 * machinery behind every inbound webhook. A registered extension declares a
 * `webhook` block in its manifest (src/extensions/manifest.ts); this module
 * turns that declaration into the concrete {@link SignatureVerifier} the
 * route runs, and resolves the effective signature header.
 *
 * `hmac-sha256` is the provider-agnostic default: the sha256 HMAC of the
 * RAW request body with the extension's vault secret, constant-time
 * compared (timingSafeEqual), accepting a HEX **or** BASE64 digest. GitHub
 * and Linear are PRESETS that map onto the SAME createWebhookVerifier
 * boundary with their provider conventions preserved — `github` returns the
 * pre-manifest X-Hub-Signature-256 verifier, `linear` the Linear HMAC
 * verifier, so their schemes behave exactly as before. Everything fails
 * closed: an unknown scheme, a malformed signature, or a non-comparable
 * length is false, never a throw.
 */
import {
  createHmac,
  timingSafeEqual,
} from "node:crypto";
import type { SignatureVerifier } from "./types";
import { githubSignatureVerifier, GITHUB_SIGNATURE_HEADER } from "./github/webhook";
import { linearSignatureVerifier, LINEAR_SIGNATURE_HEADER } from "./linear/webhook";
import {
  DEFAULT_GENERIC_WEBHOOK_HEADER,
  type WebhookDeclaration,
} from "../extensions/manifest";

export type { WebhookDeclaration, WebhookScheme } from "../extensions/manifest";

/** A strict hex digest: exactly one byte pair per byte (64 chars for sha256). */
const HEX_DIGEST = /^[0-9a-fA-F]{64}$/;

/** A strict base64 digest (sha256 → 44 chars, `=` padding optional/truncated). */
const BASE64_DIGEST = /^[A-Za-z0-9+/]{43}=$/;

/**
 * The effective signature header for a declaration: the declared `header`,
 * else the scheme's provider convention (github / linear), else the generic
 * default `x-bottega-signature`. Never throws — an unknown scheme falls
 * back to the generic default header (route-level fail closure still
 * refuses an unknown scheme before any signature is read).
 */
export function declaredHeader(decl: WebhookDeclaration): string {
  if (decl.header !== undefined && decl.header.trim() !== "") return decl.header;
  switch (decl.scheme) {
    case "github":
      return GITHUB_SIGNATURE_HEADER;
    case "linear":
      return LINEAR_SIGNATURE_HEADER;
    case "hmac-sha256":
      return DEFAULT_GENERIC_WEBHOOK_HEADER;
  }
}

/**
 * Empty (never a valid verifier) for an unsupported scheme — the route's
 * fail-closed gate treats it as "no webhook declared" (404, nothing read).
 */
const UNAVAILABLE_VERIFIER: SignatureVerifier = {
  async verify() {
    return false;
  },
};

/**
 * The concrete verifier for a declared webhook scheme (issue #57
 * follow-up). `github`/`linear` return the existing preset adapters (their
 * behavior is unchanged); `hmac-sha256` returns the generic raw-body HMAC
 * verifier on the declaration's resolve header. An unknown scheme is never
 * a verifier — it yields the fail-closed false verdict.
 */
export function createWebhookVerifier(decl: WebhookDeclaration): SignatureVerifier {
  switch (decl.scheme) {
    case "github":
      return githubSignatureVerifier;
    case "linear":
      return linearSignatureVerifier;
    case "hmac-sha256":
      return createGenericHmacVerifier(declaredHeader(decl));
  }
  return UNAVAILABLE_VERIFIER;
}

/**
 * The generic default verifier (issue #57 follow-up): the sha256 HMAC of
 * the RAW request body with the shared secret, read from `header` (default
 * `x-bottega-signature`), constant-time compared, accepting a HEX or BASE64
 * digest. Fail closed: absent header, malformed digest, length mismatch, or
 * digest mismatch → false.
 */
export function createGenericHmacVerifier(header: string): SignatureVerifier {
  return {
    async verify(
      headers: Record<string, string>,
      rawBody: string,
      secret: string,
    ): Promise<boolean> {
      const provided = headers[header];
      if (provided === undefined) return false;
      const signature = provided.trim();
      if (signature === "") return false;
      const keyBytes = Buffer.from(secret, "utf8");
      const expected = createHmac("sha256", keyBytes).update(rawBody, "utf8");

      // Hex OR base64 — whichever the provider sent. A digest that parses
      // as neither is malformed → false.
      if (HEX_DIGEST.test(signature)) {
        const expectedBytes = Buffer.from(expected.digest("hex"), "hex");
        const providedBytes = Buffer.from(signature.toLowerCase(), "hex");
        return (
          expectedBytes.length === providedBytes.length &&
          timingSafeEqual(expectedBytes, providedBytes)
        );
      }
      if (BASE64_DIGEST.test(signature)) {
        const expectedBytes = Buffer.from(expected.digest("base64"), "base64");
        const providedBytes = Buffer.from(signature, "base64");
        return (
          expectedBytes.length === providedBytes.length &&
          timingSafeEqual(expectedBytes, providedBytes)
        );
      }
      return false;
    },
  };
}