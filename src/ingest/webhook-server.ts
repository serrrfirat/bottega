/**
 * The webhook ingest route (issue #57): `POST /webhooks/<extension>` — the
 * generic inbound leg of the extension-ingest framework. The route is
 * mounted on the server's single inbound HTTP surface (the #198 OAuth
 * callback's Bun.serve, see src/extensions/oauth-callback.ts) so a
 * deployment exposes ONE public path prefix for inbound provider pushes.
 *
 * Per delivery (fail closed at every step — nothing dispatches unless the
 * whole chain passes):
 *
 *   1. resolve the provider from the path segment — an extension-registry
 *      `webhook` declaration wins; otherwise the ingest provider presets
 *      (github/linear). Unknown provider → 404, nothing written;
 *   2. read the RAW body (bounded — oversized deliveries are refused);
 *   3. verify the provider signature against the vault-backed shared
 *      secret (missing/unconfigured secret or a wrong/missing signature →
 *      401 + `ingest.webhook.rejected`, nothing dispatched);
 *   4. validate + bound the payload (malformed → 4xx +
 *      `ingest.webhook.rejected`, nothing dispatched);
 *   5. dispatch through the SHARED dispatch target
 *      ({@link dispatchIngestEvent} — the same function the polling leg
 *      uses): work-item row → org-channel post → `ingest.webhook.dispatch`
 *      audit. Valid-but-non-actionable deliveries (GitHub's `ping` probe,
 *      a comment that does not @mention the bot, an edited/deleted
 *      comment) are acknowledged with 200 and never dispatched.
 */
import type { AuditModule } from "../policy/audit";
import type { Store } from "../store/db";
import type { ExtensionRegistry } from "../extensions/registry";
import { INGEST_WEBHOOK_REJECTED_EVENT } from "../store/audit-events";
import type { IngestEvent, SignatureVerifier } from "./types";
import { dispatchIngestEvent, type IngestDispatchContext } from "./dispatch";
import { getVerifier } from "./registry";
import { createWebhookVerifier } from "./webhook-scheme";
import {
  githubMentionEvent,
  MAX_WEBHOOK_RAW_BODY_BYTES,
  parseGitHubMentionEvent,
} from "./github/payload";

/** The inbound path prefix of the webhook surface (the extension id is the last segment). */
export const WEBHOOK_PATH_PREFIX = "/webhooks";

/** The provider segment: one path segment, extension-id-shaped. */
const WEBHOOK_PATH = /^\/webhooks\/([A-Za-z0-9_-]+)$/;

export interface WebhookRouteDeps {
  /** The shared store — the dispatch's work-item creation path. */
  store: Store;
  /** Audit module (the shared #172 chain's). */
  audit: AuditModule;
  /** The existing Slack post path (adapter.postMessage bound). */
  postMessage: (spaceId: string, text: string) => Promise<string | undefined>;
  /** The org channel/DM the dispatch posts to (org settings onboarding.space_id). */
  spaceId: string;
  /**
   * Resolves a provider's webhook shared secret from its SECRET-REF
   * identity. The caller (the route) passes the provider id; the resolver
   * maps it to the vault-backed boot secret — the `github-webhook` row →
   * GITHUB_WEBHOOK_SECRET for GitHub, a registered extension's declared
   * `webhook.secretRef` for the rest, and the provider id itself as the
   * fallback. Undefined = unconfigured → the signature cannot be verified
   * → fail closed (401 + rejected audit, nothing dispatched).
   */
  secretFor: (secretRef: string) => string | undefined;
  /**
   * The extension registry (issue #57): an extension registered with a
   * `webhook` declaration resolves its signature verifier here. GitHub and
   * Linear are PRESETS and never need registry registration — their
   * verifiers come from the ingest provider registry directly (exact
   * current behavior). An unknown provider, or a registered extension
   * WITHOUT a webhook declaration, fails closed (404).
   */
  registry?: ExtensionRegistry;
  /** GitHub bot login for mention detection; default "bottega". */
  botLogin?: string;
  /** Raw body cap in bytes (bounding); default {@link MAX_WEBHOOK_RAW_BODY_BYTES}. */
  maxRawBodyBytes?: number;
}

/** The shared dispatch context, with the leg pinned to "webhook". */
function dispatchContext(deps: WebhookRouteDeps): IngestDispatchContext {
  return {
    store: deps.store,
    audit: deps.audit,
    postMessage: deps.postMessage,
    leg: "webhook",
    spaceId: deps.spaceId,
  };
}

/** Records a pre-dispatch rejection. Never throws — the audit must not change the delivery verdict. */
async function reject(
  deps: WebhookRouteDeps,
  provider: string,
  eventType: string | undefined,
  reason: string,
): Promise<void> {
  try {
    await deps.audit.appendAudit({
      space_id: null,
      actor: "system",
      event_type: INGEST_WEBHOOK_REJECTED_EVENT,
      payload: { provider, event_type: eventType ?? "unknown", reason },
    });
  } catch {
    // The audit trail is best-effort; the fail-closed verdict stands.
  }
}

/** Reads the raw body, refusing anything over the cap (bounding). */
async function readRawBody(req: Request, maxBytes: number): Promise<{ ok: true; body: string } | { ok: false }> {
  const declared = req.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (Number.isFinite(length) && length > maxBytes) return { ok: false };
  }
  const body = await req.text();
  if (Buffer.byteLength(body, "utf8") > maxBytes) return { ok: false };
  return { ok: true, body };
}

/**
 * Resolves the signature verifier for a webhook path provider (issue #57).
 * REGISTRY-FIRST: a provider registered in the extension registry (any
 * registered extension carries a manifest) with a `webhook` declaration
 * resolves its verifier from that declaration
 * ({@link createWebhookVerifier}). An unknown provider, or a registered
 * extension WITHOUT a webhook declaration, is undefined → the caller fails
 * closed with 404 (nothing read, nothing dispatched).
 *
 * GitHub and Linear are PRESETS that never need extension-registry
 * registration: their verifiers come from the ingest provider registry
 * (getVerifier) and behave exactly as before. But when an extension SHARES
 * a preset id (e.g. an extension registered as "github"), its declared
 * webhook (if any) takes precedence via the registry-first rule; if it
 * declares no webhook, the preset verifier still applies (fallback).
 */
function resolveWebhookVerifier(provider: string, registry?: ExtensionRegistry): SignatureVerifier | undefined {
  const declaration = registry?.resolve(provider)?.manifest.webhook;
  if (declaration !== undefined) return createWebhookVerifier(declaration);
  try {
    return getVerifier(provider);
  } catch {
    return undefined;
  }
}

/**
 * Handles one inbound webhook request (path `/webhooks/<extension>`).
 * The provider's signature verifier comes from the SHARED registry; the
 * secret from the vault-backed boot secret; dispatch goes through the
 * SHARED dispatch target. Every failure path is a fail-closed verdict
 * with an `ingest.webhook.rejected` audit row and NO dispatch.
 */
export async function handleWebhookRequest(req: Request, deps: WebhookRouteDeps): Promise<Response> {
  const match = WEBHOOK_PATH.exec(new URL(req.url).pathname);
  if (!match) return new Response("not found", { status: 404 });
  const provider = match[1]!;

  // 1. Provider resolution — fail closed: an unknown provider (or a
  //    registered extension without a webhook declaration) is a 404 and
  //    nothing is read.
  const verifier = resolveWebhookVerifier(provider, deps.registry);
  if (verifier === undefined) return new Response("unknown provider", { status: 404 });
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  const viaRegistry = deps.registry?.resolve(provider)?.manifest.webhook !== undefined;

  // 2. Raw body, bounded (the signature is computed over these exact bytes).
  const maxRawBodyBytes = deps.maxRawBodyBytes ?? MAX_WEBHOOK_RAW_BODY_BYTES;
  const raw = await readRawBody(req, maxRawBodyBytes);
  if (!raw.ok) {
    await reject(deps, provider, undefined, "payload_too_large");
    return new Response("payload too large", { status: 413 });
  }

  // 3. Signature verification against the vault-backed shared secret. An
  //    unconfigured secret cannot be verified — fail closed. The route
  //    passes the provider (the secret-ref key) to the resolver, which
  //    maps it to the secret's boot identity.
  const eventType = req.headers.get("x-github-event") ?? undefined;
  const secret = deps.secretFor(provider);
  if (secret === undefined || secret.trim() === "") {
    await reject(deps, provider, eventType, "unconfigured");
    return new Response("unauthorized", { status: 401 });
  }
  const headers: Record<string, string> = {};
  for (const [key, value] of req.headers.entries()) headers[key.toLowerCase()] = value;
  const verified = await verifier.verify(headers, raw.body, secret);
  if (!verified) {
    await reject(deps, provider, eventType, "signature_mismatch");
    return new Response("unauthorized", { status: 401 });
  }

  // 4/5. Dispatch. Two branches — the preset (github/linear) path and the
  //    generic manifest-declared path — both funnel through the SHARED
  //    dispatch target; both fail closed.
  if (!viaRegistry) {
    // PRESET branch: github/linear. Validate + bound the payload with the
    // provider adapter's gate.
    let parsed: ReturnType<typeof parseGitHubMentionEvent>;
    try {
      parsed = parseGitHubMentionEvent(JSON.parse(raw.body), { botLogin: deps.botLogin });
    } catch {
      await reject(deps, provider, eventType, "malformed_payload");
      return new Response("malformed payload", { status: 400 });
    }
    if (!parsed.ok) {
      await reject(deps, provider, eventType, "invalid_payload");
      return new Response("invalid payload", { status: parsed.status });
    }
    // A valid delivery that is not an actionable mention (ping probe, no bot
    // mention, non-created action): acknowledged, never dispatched.
    if (!parsed.actionable) return new Response("ok", { status: 200 });

    // Dispatch through the SHARED target (work item → org-channel post →
    // `ingest.webhook.dispatch` audit). The event is normalized to the
    // canonical github `mention` shape — the dispatcher's single github
    // schema serves both legs. Infra failures throw: report 500 (GitHub
    // retries) + a rejected row for the trail.
    const event: IngestEvent = githubMentionEvent(parsed.payload);
    try {
      await dispatchIngestEvent(dispatchContext(deps), event);
    } catch (err) {
      await reject(deps, provider, eventType, "dispatch_error");
      return new Response(`dispatch failed: ${err instanceof Error ? err.message : String(err)}`, {
        status: 500,
      });
    }
    return new Response("ok", { status: 200 });
  }

  // GENERIC branch (issue #57): a manifest-declared webhook extension.
  // Parse the raw JSON (malformed → 400 + rejected audit). The payload is
  // passed through untouched — the dispatcher's envelope + schema gate
  // decides what is dispatchable (acknowledged 200 on rejection).
  const genericEventType = req.headers.get("x-bottega-event") ?? req.headers.get("x-github-event") ?? "webhook";
  let genericPayload: unknown;
  try {
    genericPayload = JSON.parse(raw.body);
  } catch {
    await reject(deps, provider, genericEventType, "malformed_payload");
    return new Response("malformed payload", { status: 400 });
  }

  const genericEvent: IngestEvent = {
    provider,
    eventType: genericEventType,
    payload: genericPayload,
    occurredAt: new Date().toISOString(),
  };
  try {
    await dispatchIngestEvent(dispatchContext(deps), genericEvent);
  } catch (err) {
    // Store/post failure (infra, not validation) — a generic payload that
    // fails the dispatcher's schema was already audited as rejected and
    // returns normally; this catch is defense in depth for real infra
    // errors (report 500 so the provider retries).
    await reject(deps, provider, genericEventType, "dispatch_error");
    return new Response(`dispatch failed: ${err instanceof Error ? err.message : String(err)}`, {
      status: 500,
    });
  }
  return new Response("ok", { status: 200 });
}