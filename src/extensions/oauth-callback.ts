/**
 * Generic MCP OAuth callback endpoint (issue #198): the in-process HTTP
 * half of the connect flow's browser leg, mirroring the #196 one-time
 * upload-link server (Bun.serve on 127.0.0.1, ephemeral port — the same
 * public-ingress posture as issue #57's local dev; the PUBLIC base URL is
 * the durable store `data/public-base-url` (#249) — else the
 * `BOTTEGA_OAUTH_CALLBACK_BASE_URL` override, else the loopback URL).
 *
 * The authorization URL the connect tool shows in Slack points at the
 * hosted MCP's authorize endpoint with `redirect_uri = <base>/oauth/callback`
 * and `state = <flow token>`. When the user authorizes, the provider
 * redirects the browser HERE with `?code=...&state=...`; this endpoint
 *
 *   1. consumes the flow row (single-use, TTL, fail closed — a replayed or
 *      expired state is just gone);
 *   2. exchanges the code through the MCP SDK's OAuth client, cryptically
 *      bound to the SAME flow (the persisted PKCE verifier, registered
 *      client info, and discovery state — never a token in transit through
 *      chat or transcripts);
 *   3. stores the token in the vault via the existing broker upload path;
 *   4. records the registry row (scope me/org) + the `extension.connected`
 *      audit row — the same ladder shape as every connect, with zero
 *      broker provider registration.
 *
 * The browser sees a success/error page; the token itself never touches
 * the endpoint's response or any log.
 */
import type { AuditModule } from "../policy/audit";
import type { OAuthFlow, Store } from "../store/db";
import { completeMcpOAuthFlow, createVaultTokenStore, type McpOAuthTokenStore } from "./mcp-oauth";
import { createReconcileEgress } from "./egress-reconcile";
import {
  handleWebhookRequest,
  WEBHOOK_PATH_PREFIX,
  type WebhookRouteDeps,
} from "../ingest/webhook-server";
import type { UploadLinkMount } from "./upload-link";
import { API_PATH_PREFIX, OPENAPI_PATH, type RestApiMount } from "../server/api";

export const OAUTH_CALLBACK_PATH = "/oauth/callback";

/**
 * The stable local port for the in-process browser-leg listeners (issue
 * #196 follow-up): `BOTTEGA_CALLBACK_PORT` — a static tunnel / reverse
 * proxy cannot forward to an ephemeral port (0 = pick one at boot, the
 * default for tests and local dev). Unset or empty → 0 (ephemeral,
 * unchanged). Set but not a valid port number → throws (fail closed: a
 * mistyped port must not silently bind a random one).
 */
export function callbackPort(): number {
  const raw = process.env.BOTTEGA_CALLBACK_PORT;
  if (raw === undefined || raw.length === 0) return 0;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`BOTTEGA_CALLBACK_PORT must be a port number 0-65535, got "${raw}"`);
  }
  return port;
}

/** The callback endpoint's store slice (the full {@link Store} satisfies it). */
export type OAuthCallbackStoreSlice = Pick<Store, "consumeOAuthFlow" | "upsertExtensionCredential" | "listRuntimeExtensions">;

export interface OAuthCallbackEndpointDeps {
  store: OAuthCallbackStoreSlice;
  audit: AuditModule;
  /** Token persistence; defaults to the production vault store. */
  tokenStore?: McpOAuthTokenStore;
  /**
   * Connect-time egress reconcile (issue #250): after a successful hosted
   * OAuth connect, regenerate egress with the superset + seed the
   * provider's proxy OAuth blob + reload. Default: built from `deps.store`
   * (the store's `listRuntimeExtensions` supplies the runtime half of the
   * superset), so the callback reconciles with zero composition-root wiring.
   */
  reconcileEgress?: (provider: string) => Promise<{ warnings: string[] }>;
  /**
   * Post-connect same-space refresh (issue #281): invoked after a
   * successful callback (credential + registry + audit + egress all
   * landed) with the extension's provider and the SPACE whose connect
   * started the flow. The composition root wires this to refresh that
   * space's live session toolset so the freshly-connected provider's
   * tools appear without a restart. Absent → no session refresh (the
   * callback still succeeds).
   */
  onConnected?: (info: { provider: string; spaceId: string | null }) => void | Promise<void>;
  /**
   * The PUBLIC base URL the browser reaches the callback at (deployment:
   * BOTTEGA_OAUTH_CALLBACK_BASE_URL; default: the loopback server URL).
   */
  baseUrl?: string;
  /**
   * The ingest webhook route (issue #57): when present, this surface also
   * serves `POST /webhooks/<extension>` — the webhook leg joins the SAME
   * inbound HTTP surface as the OAuth callback, so a deployment exposes
   * ONE public ingress (reverse proxy + TLS) for both paths.
   */
  webhooks?: WebhookRouteDeps;
  /**
   * The one-time upload-link surface (issue #196): when present, this
   * surface also serves `GET|POST /upload/<token>` — the upload form joins
   * the SAME inbound HTTP surface as the OAuth callback + webhook route, so
   * ONE listener on ONE stable port (BOTTEGA_CALLBACK_PORT) serves every
   * browser leg; a static tunnel forwards the public base to that port.
   */
  uploadLink?: UploadLinkMount;
  /**
   * The token-authenticated REST API surface (issue #100): when present,
   * this surface also serves `/api/v1/*` and `/openapi.json` — the REST
   * surface joins the SAME inbound HTTP listener as the OAuth callback,
   * webhook route, and upload form, so ONE ingress serves every inbound
   * path. Every request is bearer-authenticated (BOTTEGA_API_TOKEN via the
   * boot-secret chain) and audited with actor `api:default`.
   */
  restApi?: RestApiMount;
  /** Server-rendered authenticated work-review routes (issue #359). */
  workReview?: { fetch(req: Request): Promise<Response> };
  /**
   * Local bind port override (default: `BOTTEGA_CALLBACK_PORT` when set,
   * else 0 = ephemeral). A stable port lets a static tunnel / reverse
   * proxy forward to this listener across restarts.
   */
  port?: number;
}

/** A plain, script-free result page (the browser's only output). */
function page(status: number, title: string, body: string): Response {
  const html =
    `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n` +
    `<title>${title}</title>\n</head>\n<body>\n<h1>${title}</h1>\n<p>${body}</p>\n</body>\n</html>\n`;
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'",
    },
  });
}

/**
 * The callback handler: consumes the flow state (single-use), exchanges the
 * code, stores the token in the vault, and records the credential. Any
 * failure is a clear error page — the flow row is already consumed, so a
 * failed exchange never replays (the user re-runs connect).
 */
async function handleCallback(
  req: Request,
  deps: OAuthCallbackEndpointDeps,
  tokenStore: McpOAuthTokenStore,
  reconcileEgress: (provider: string) => Promise<{ warnings: string[] }>,
): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname !== OAUTH_CALLBACK_PATH) return new Response("not found", { status: 404 });
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");
  if (error) {
    return page(200, "Authorization declined", "No account was connected — you can close this window.");
  }
  if (!code || !state) {
    return page(400, "Incomplete authorization", "The authorization response is missing the code or state.");
  }
  const consumed = deps.store.consumeOAuthFlow(state);
  if (!consumed.ok) {
    return page(
      404,
      "This authorization link is invalid",
      "The link is invalid, expired, or already used — ask the agent for a fresh connect.",
    );
  }
  const row: OAuthFlow = consumed.row;
  try {
    await completeMcpOAuthFlow(row, code, {
      store: deps.store,
      audit: deps.audit,
      tokenStore,
      reconcileEgress,
      onConnected: deps.onConnected,
    });
  } catch (err) {
    // Generic message to the unauthenticated caller (issue #346 #5) — the
    // concrete exchange/egress detail is logged server-side only.
    console.error(`[oauth-callback] connecting ${row.label} failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    return page(500, "Connect failed", `Connecting ${row.label} failed — ask the agent to try again.`);
  }
  return page(200, "Connected", `${row.label} is connected — you can close this window.`);
}

export interface OAuthCallbackServerHandle {
  /** http://127.0.0.1:<port> — the loopback base the connect mint uses when no public URL is set. */
  baseUrl: string;
  stop(): void;
}

/**
 * Starts the in-process inbound HTTP surface (issue #198 + #57 + #196):
 * Bun.serve on 127.0.0.1 (loopback only — the same posture as issue #57's
 * local dev), BOTTEGA_CALLBACK_PORT when set else ephemeral. `GET
* `GET /oauth/callback` completes the OAuth connect flow; when the deps carry
 * `webhooks`, `POST /webhooks/<extension>` serves the ingest webhook route
 * (issue #57) on the SAME surface — and when they carry `uploadLink`, the
 * one-time upload form (`/upload/<token>`, issue #196) joins it too, and
 * `restApi` adds the token-authenticated REST surface (`/api/v1/*` +
 * `/openapi.json`, issue #100): ONE public ingress + ONE stable local port
 * serve every inbound path, and a
 * static tunnel forwards the public base to that port. Anything else is a
 * 404 (fail closed).
 */
export function startOAuthCallbackServer(deps: OAuthCallbackEndpointDeps): OAuthCallbackServerHandle {
  const tokenStore = deps.tokenStore ?? createVaultTokenStore();
  // Issue #250: default the connect-time reconcile from the store (the
  // runtime half of the egress superset) so the callback reconciles the
  // proxy plane with zero composition-root wiring.
  const reconcileEgress = deps.reconcileEgress ?? createReconcileEgress({ store: deps.store });
  // Bind hostname (issue #366): loopback by default — the tunnel/reverse
  // proxy terminates the public base on the HOST and forwards to this port,
  // so the container deployment needs the bind widened to 0.0.0.0 there
  // (BOTTEGA_CALLBACK_HOST=0.0.0.0 + a loopback-only docker port publish).
  // Loopback remains the default: local dev exposes nothing.
  const hostname = process.env.BOTTEGA_CALLBACK_HOST ?? "127.0.0.1";
  const server = Bun.serve({
    hostname,
    port: deps.port ?? callbackPort(),
    async fetch(req) {
      const url = new URL(req.url);
      // Issue #196: the upload-link leg joins the same surface — the
      // deployment's ONE ingress serves /upload/*, /oauth/callback, and
      // the #57 webhook route on a single stable port.
      if (deps.uploadLink !== undefined && url.pathname.startsWith("/upload/")) {
        return deps.uploadLink.fetch(req);
      }
      if (url.pathname === OAUTH_CALLBACK_PATH) return handleCallback(req, deps, tokenStore, reconcileEgress);
      // Issue #57: the webhook route joins the same inbound surface.
      if (deps.webhooks !== undefined && url.pathname.startsWith(`${WEBHOOK_PATH_PREFIX}/`)) {
        return handleWebhookRequest(req, deps.webhooks);
      }
      if (deps.workReview !== undefined && (url.pathname === "/work-review" || url.pathname.startsWith("/work-review/"))) {
        return deps.workReview.fetch(req);
      }
      if (deps.restApi !== undefined && (url.pathname === OPENAPI_PATH || url.pathname.startsWith(`${API_PATH_PREFIX}/`))) {
        return deps.restApi.fetch(req);
      }
      return new Response("not found", { status: 404 });
    },
  });
  const port = server.port;
  if (port === undefined) throw new Error("oauth callback server did not bind a port");
  return { baseUrl: `http://127.0.0.1:${port}`, stop: () => server.stop(true) };
}
