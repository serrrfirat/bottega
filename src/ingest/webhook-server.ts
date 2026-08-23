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
import { createWebhookVerifier, GENERIC_TIMESTAMP_HEADER } from "./webhook-scheme";
import { ReplayGuard } from "./replay-guard";
import {
  githubMentionEvent,
  MAX_WEBHOOK_RAW_BODY_BYTES,
  parseGitHubMentionEvent,
} from "./github/payload";

/** The inbound path prefix of the webhook surface (the extension id is the last segment). */
export const WEBHOOK_PATH_PREFIX = "/webhooks";

/** The provider segment: one path segment, extension-id-shaped. */
const WEBHOOK_PATH = /^\/webhooks\/([A-Za-z0-9_-]+)$/;

/** GitHub's per-delivery id header (unique per webhook push; replay key). */
export const GITHUB_DELIVERY_HEADER = "x-github-delivery";

/**
 * Max clock skew (ms) tolerated for the generic scheme's
 * `x-bottega-timestamp` (issue #346 #2): ±5 minutes bounds how long a
 * captured generic delivery can be replayed.
 */
export const GENERIC_TIMESTAMP_SKEW_MS = 5 * 60 * 1000;

/**
 * Process-wide shared replay guard — the inbound surface owns one, so
 * delivery-id idempotency holds across requests without per-route stats.
 */
const sharedReplayGuard = new ReplayGuard();

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
   * Delivery-id replay guard (issue #346 #2): records processed
   * provider delivery-ids so a re-delivered webhook is a no-op, not a
   * duplicate dispatch. Defaults to a shared process-wide instance; tests
   * inject a fresh one per harness.
   */
  replayGuard?: ReplayGuard;
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

/**
 * Reads the raw body with an enforced byte cap on the ACTUAL read (issue
 * #346 #3): a streaming reader accumulates up to `maxBytes` bytes and
 * cancels once the cap is exceeded. Content-Length is never trusted as the
 * bound — an attacker can declare a small Content-Length and stream a huge
 * body (a memory DoS if we held it all). Exceeding the cap is `{ ok:false }`
 * WITHOUT holding the oversized remainder (the reader is cancelled), so a
 * declared-small/huge-actual delivery is refused without buffering it all.
 */
async function readRawBody(req: Request, maxBytes: number): Promise<{ ok: true; body: string } | { ok: false }> {
  if (req.body === null) return { ok: false };
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        // Never hold the whole body: refuse and cancel the stream. The
        // accumulated chunks are freed without ever decoding the tail.
        await reader.cancel();
        return { ok: false };
      }
      chunks.push(value);
    }
  } catch {
    // A stream that errors mid-read is not a usable body — refuse it.
    return { ok: false };
  }
  const body = Buffer.concat(chunks, total).toString("utf8");
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

  // 3b. Delivery-id replay protection (issue #346 #2). Providers that send a
  //    per-delivery id (GitHub: `x-github-delivery`) are idempotent against
  //    re-delivery: once a verified delivery-id is processed, a repeat of
  //    the same delivery is a 200 no-op (audited as `replayed`), never a
  //    duplicate dispatch. The check sits after signature verification so
  //    only signed, verified deliveries ever mark/consume the guard.
  const replayGuard = deps.replayGuard ?? sharedReplayGuard;
  const deliveryId = headers[GITHUB_DELIVERY_HEADER];
  if (deliveryId !== undefined && deliveryId.trim() !== "" && replayGuard.isReplayed(provider, deliveryId)) {
    await reject(deps, provider, eventType, "replayed");
    // The provider's retry budget is satisfied — acknowledge without
    // dispatching (mirrors how non-actionable deliveries are acked 200).
    return new Response("ok", { status: 200 });
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
      // Infra failure: report a generic 500 (GitHub retries) + a rejected
      // row for the trail. The concrete error detail is logged server-side
      // only — never leaked to the unauthenticated caller (issue #346 #5).
      await reject(deps, provider, eventType, "dispatch_error");
      console.error(`[webhook] ${provider}/${eventType ?? "unknown"} dispatch failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      return new Response("dispatch failed", { status: 500 });
    }
    return new Response("ok", { status: 200 });
  }

  // GENERIC branch (issue #57): a manifest-declared webhook extension.
  const genericEventType = req.headers.get("x-bottega-event") ?? req.headers.get("x-github-event") ?? "webhook";

  // Replay hardening (issue #346 #2): the generic scheme signs
  // `x-bottega-timestamp` into the HMAC; the route independently enforces
  // the ±5 min skew so a captured signature (valid only for its signed
  // timestamp) cannot be replayed once stale. An out-of-window timestamp
  // is a fail-closed 401 + rejected audit, nothing dispatched.
  const rawTimestamp = headers[GENERIC_TIMESTAMP_HEADER];
  if (rawTimestamp !== undefined) {
    const ts = Number(rawTimestamp.trim());
    if (Number.isFinite(ts) && Math.abs(Date.now() - ts) > GENERIC_TIMESTAMP_SKEW_MS) {
      await reject(deps, provider, genericEventType, "stale_timestamp");
      return new Response("unauthorized", { status: 401 });
    }
  }

  // Parse the raw JSON (malformed → 400 + rejected audit). The payload is
  // passed through untouched — the dispatcher's envelope + schema gate
  // decides what is dispatchable (acknowledged 200 on rejection).
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
    // errors (report 500 so the provider retries). The response body is a
    // GENERIC message — the concrete error is logged server-side only and
    // never leaked to the unauthenticated caller (issue #346 #5).
    await reject(deps, provider, genericEventType, "dispatch_error");
    console.error(`[webhook] ${provider}/${genericEventType} dispatch failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    return new Response("dispatch failed", { status: 500 });
  }
  return new Response("ok", { status: 200 });
}