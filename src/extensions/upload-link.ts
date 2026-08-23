/**
 * One-time upload link (issue #196): the no-secrets-in-chat path for
 * api_key-type extensions.
 *
 * The problem: pasted PATs land in the never-deleted transcript, and CLI
 * args land in shell history — neither is acceptable for a credential. The
 * safe paths already exist (OAuth — no secret to handle — and the #190
 * secret resolver at the egress boundary); this module is the third path
 * for PAT-shaped secrets:
 *
 *   1. MINT  — the `connect_upload_link` tool returns a single-use,
 *              expiring HTTPS URL (the token is 144 random bits; the link
 *              carries ONLY the token, never the secret). Shown in Slack
 *              as a link, never a value.
 *   2. UPLOAD — the user opens the URL in a browser and pastes the secret
 *              into a web form served by an in-process Bun.serve endpoint
 *              bound to 127.0.0.1 (the same public-ingress posture as
 *              issue #57: local dev serves loopback).
 *   3. VAULT  — the endpoint atomically consumes the token (single-use,
 *              short TTL, per-IP rate-limited; anything else is a 4xx —
 *              fail closed) and stores the value through the EXACT same
 *              connect path as {@link connectExtension}: policy gate →
 *              broker upload → registry upsert → audit. The value never
 *              passes through Slack, the agent, or a transcript. Boot
 *              secrets (issue #201 — Slack tokens + provider keys) mint by
 *              their vault provider id and store through the same gate →
 *              broker → audit path minus the registry row: there is no
 *              extension manifest; the vault row is the record the
 *              boot-time seed reads.
 *
 * The token store is the SQLite store's `upload_tokens` table (shared by
 * the server process — which hosts the endpoint — and the per-session MCP
 * child processes that mint links), so a link minted anywhere is
 * consumable by the endpoint.
 */
import { readFileSync } from "node:fs";
import { z, type ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { toolError } from "../tools/helpers";
import type { Store, UploadToken } from "../store/db";
import type { ExtensionManifest } from "./manifest";
import type { ExtensionRegistry } from "./registry";
import { connectExtension, storeBootSecret, type ConnectExtensionDeps, type ConnectScope } from "./connect";
import { bootSecretForProvider } from "../server/boot-secrets";
import { callbackPort } from "./oauth-callback";
import { resolveMcpOAuthRegistrationCapability } from "./mcp-oauth";
import {
  createConnectionAuthority,
  replaceConnection,
  type ConnectionLifecycleDeps,
} from "./lifecycle";
import type { ConnectionBoundary } from "./boundary";
import {
  createStaticOAuthClientStore,
  provisionStaticOAuthClient,
  type StaticOAuthClientStore,
} from "./static-oauth-client";

/** The mint tool's name (exec-tier surface, issue #196). */
export const MINT_UPLOAD_LINK_TOOL = "connect_upload_link";

/** Default link lifetime: short by design — 15 minutes. */
export const UPLOAD_LINK_TTL_MS = 15 * 60_000;
/** Per-actor cap on live (unexpired) links — the mint path's rate limit. */
export const UPLOAD_LINK_MAX_OUTSTANDING_PER_ACTOR = 5;
/** Per-client-IP POST attempts within the window — the ingest rate limit. */
export const UPLOAD_LINK_MAX_ATTEMPTS_PER_IP = 10;
/** Attempt window for the per-IP rate limit. */
export const UPLOAD_LINK_ATTEMPTS_WINDOW_MS = 15 * 60_000;

/** Durable public-base store path (issue #249), env-overridable like the git-token file. */
export const DEFAULT_PUBLIC_BASE_URL_FILE = "data/public-base-url";
/** Environment name for the durable public-base store path override. */
export const PUBLIC_BASE_URL_FILE_ENV = "BOTTEGA_PUBLIC_BASE_URL_FILE";

/** The durable public-base store path (env override, else the data-dir default). */
export function publicBaseUrlFile(): string {
  const override = process.env[PUBLIC_BASE_URL_FILE_ENV];
  return override !== undefined && override.length > 0 ? override : DEFAULT_PUBLIC_BASE_URL_FILE;
}

/**
 * Reads the durable public-base store (issue #249): `scripts/tunnel.sh`
 * writes the CURRENT cloudflared quick-tunnel URL here on every rotation, so
 * a new host self-heals WITHOUT a server restart. Absent / unreadable / empty
 * → `undefined` (fall through to the env override, then the loopback posture)
 * — never throws.
 */
export function storedPublicBase(file = publicBaseUrlFile()): string | undefined {
  try {
    const value = readFileSync(file, "utf8").trim();
    return value.length > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The upload endpoint's PUBLIC base URL (issue #196): the browser-facing
 * base of the deployment's ONE public ingress — the SAME base the #198 OAuth
 * callback surface reads, because the same reverse proxy / tunnel serves both
 * `/upload/<token>` and `/oauth/callback`. Resolution order (issue #249):
 *   1. the durable store `data/public-base-url` first — written by
 *      `scripts/tunnel.sh` on every tunnel rotation, so a rotated
 *      quick-tunnel host heals the next mint WITHOUT a restart; then
 *   2. the env `BOTTEGA_OAUTH_CALLBACK_BASE_URL` second — a
 *      deployment-only override for a FIXED public host that never rotates.
 * Neither → `undefined`: the mint falls back to the loopback URL of the
 * in-process endpoint (local dev, the issue #57 posture).
 */
export function uploadLinkPublicBase(): string | undefined {
  // Issue #249: the durable store is authoritative — boot env goes stale the
  // moment a quick-tunnel host changes (Cloudflare rotations happen without a
  // server restart, so a boot-frozen env breaks every connect/upload).
  const stored = storedPublicBase();
  if (stored !== undefined) return stored;
  const base = process.env.BOTTEGA_OAUTH_CALLBACK_BASE_URL;
  return base !== undefined && base.length > 0 ? base : undefined;
}

/** How long the public-base liveness probe may take before the tunnel is treated as dead (issue #211). */
export const PUBLIC_BASE_PROBE_TIMEOUT_MS = 5_000;

/** The mint's public-base resolution (issue #211): the reachable public base plus any staleness warning. */
export interface PublicBaseResolution {
  /**
   * The reachable public base to mint with. `undefined` → the mint falls
   * back to the loopback endpoint URL.
   */
  base: string | undefined;
  /**
   * Set when a configured public URL exists but the liveness probe failed:
   * the minted link is loopback-only and the .env tunnel URL is stale.
   */
  warning: string | undefined;
}

/**
 * Resolves the upload-link mint's PUBLIC base (issue #211): a quick tunnel
 * rotates, so any stored base goes stale between boots — the mint must
 * never trust it blindly. The configured base is health-checked at MINT time:
 *   - any non-5xx HTTP response → REACHABLE. The app's own ingress 404s
 *     unknown paths, so a 2xx/3xx/4xx means the tunnel forwards to the
 *     listener; a 5xx (Cloudflare 502/530 when the tunnel is gone, an
 *     nginx 502 when the backend is down) or a transport failure (DNS,
 *     refused connection, timeout) means DEAD.
 *   - reachable → mint with the configured base.
 *   - dead → base = undefined (loopback fallback) with a LOUD warning that
 *     surfaces the staleness (the user sees why the link is loopback-only).
 * No caching: mints are rare (exec-tier, per-actor capped) and every probe
 * re-reads the tunnel's CURRENT liveness, so a refreshed tunnel is picked
 * up by the very next mint.
 */
export async function resolveUploadLinkPublicBase(
  configuredBase: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<PublicBaseResolution> {
  if (configuredBase === undefined) return { base: undefined, warning: undefined };
  if (await probePublicBase(configuredBase, fetchImpl)) return { base: configuredBase, warning: undefined };
  return {
    base: undefined,
    warning:
      `WARNING: the configured public base (${configuredBase}) is unreachable — ` +
      `the stored tunnel URL (data/public-base-url, issue #249) or BOTTEGA_OAUTH_CALLBACK_BASE_URL is ` +
      `stale (issue #211). The minted link below is LOOPBACK-only: a remote user ` +
      `cannot open it. Refresh the tunnel (scripts/tunnel.sh re-writes the store), then re-mint.`,
  };
}

async function probePublicBase(base: string, fetchImpl: typeof fetch): Promise<boolean> {
  try {
    const res = await fetchImpl(base, { redirect: "follow", signal: AbortSignal.timeout(PUBLIC_BASE_PROBE_TIMEOUT_MS) });
    return res.status < 500;
  } catch {
    return false;
  }
}

export interface UploadLinkStoreOpts {
  /** Token lifetime in ms (default {@link UPLOAD_LINK_TTL_MS}). */
  ttlMs?: number;
  /** Max live links per actor (default {@link UPLOAD_LINK_MAX_OUTSTANDING_PER_ACTOR}). */
  maxOutstandingPerActor?: number;
  /** Max POST attempts per client IP in the window (default {@link UPLOAD_LINK_MAX_ATTEMPTS_PER_IP}). */
  maxAttemptsPerIp?: number;
  /** Per-IP attempt window in ms (default {@link UPLOAD_LINK_ATTEMPTS_WINDOW_MS}). */
  attemptsWindowMs?: number;
  /**
   * Local bind port override (default: `BOTTEGA_CALLBACK_PORT` when set,
   * else 0 = ephemeral). A stable port lets a static tunnel / reverse
   * proxy forward to this listener across restarts (issue #196 follow-up).
   */
  port?: number;
}

/** The store slice the link path needs (full {@link Store} satisfies it). */
export type UploadLinkStoreSlice = Pick<
  Store,
  "createUploadToken" | "consumeUploadToken" | "countActiveUploadTokens" | "getUploadToken"
>;

/**
 * The link path's token bookkeeping: SQLite-backed tokens (shared across
 * processes via the store file) + in-memory per-IP attempt tracking (only
 * the endpoint process sees requests). Single-use and expiry are enforced
 * by the store's atomic consume; the caps here are the rate limits.
 */
export class UploadLinkStore {
  readonly ttlMs: number;
  readonly maxOutstandingPerActor: number;
  readonly maxAttemptsPerIp: number;
  readonly attemptsWindowMs: number;
  readonly #store: UploadLinkStoreSlice;
  readonly #attempts = new Map<string, number[]>();

  constructor(store: UploadLinkStoreSlice, opts: UploadLinkStoreOpts = {}) {
    this.#store = store;
    this.ttlMs = opts.ttlMs ?? UPLOAD_LINK_TTL_MS;
    this.maxOutstandingPerActor = opts.maxOutstandingPerActor ?? UPLOAD_LINK_MAX_OUTSTANDING_PER_ACTOR;
    this.maxAttemptsPerIp = opts.maxAttemptsPerIp ?? UPLOAD_LINK_MAX_ATTEMPTS_PER_IP;
    this.attemptsWindowMs = opts.attemptsWindowMs ?? UPLOAD_LINK_ATTEMPTS_WINDOW_MS;
  }

  /** Mints a single-use, expiring token; refuses past the per-actor cap. */
  mint(input: {
    extension: string;
    scope: ConnectScope;
    actor: string;
    spaceId?: string | null;
    label: string;
    connectionId?: string;
    expectedRevision?: number;
    ttlMs?: number;
    /** Absolute ms override — tests pin expiry without waiting. */
    expiresAt?: number;
  }): { ok: true; token: string; expiresAt: number } | { ok: false; reason: string } {
    if (this.#store.countActiveUploadTokens(input.actor) >= this.maxOutstandingPerActor) {
      return {
        ok: false,
        reason: `too many outstanding upload links for ${input.actor} — reuse one or wait for it to expire`,
      };
    }
    const expiresAt = input.expiresAt ?? Date.now() + (input.ttlMs ?? this.ttlMs);
    const row = this.#store.createUploadToken({
      extension: input.extension,
      scope: input.scope,
      actor: input.actor,
      spaceId: input.spaceId,
      label: input.label,
      connectionId: input.connectionId,
      expectedRevision: input.expectedRevision,
      expiresAt,
    });
    return { ok: true, token: row.token, expiresAt: row.expires_at };
  }

  /** Non-consuming read for rendering the form (the token itself is the secret). */
  peek(token: string): UploadToken | null {
    return this.#store.getUploadToken(token);
  }

  /** Atomic single-use consume; anything else is a 404 (fail closed). */
  consume(token: string): { ok: true; row: UploadToken } | { ok: false; status: 404 } {
    const consumed = this.#store.consumeUploadToken(token);
    if (consumed.ok) return consumed;
    return { ok: false, status: 404 };
  }

  /** Per-IP POST attempt accounting; false once the window is saturated. */
  trackAttempt(ip: string): boolean {
    const now = Date.now();
    const cutoff = now - this.attemptsWindowMs;
    const bucket = (this.#attempts.get(ip) ?? []).filter((t) => t > cutoff);
    if (bucket.length >= this.maxAttemptsPerIp) {
      this.#attempts.set(ip, bucket);
      return false;
    }
    bucket.push(now);
    this.#attempts.set(ip, bucket);
    return true;
  }
}

export interface MintUploadLinkDeps {
  registry: Pick<ExtensionRegistry, "resolve">;
  store: UploadLinkStore;
  /**
   * The LOOPBACK fallback base (http://127.0.0.1:<port>) — used when no
   * public base is configured or the configured one is unreachable (issue
   * #211). Never the raw env value: the public URL comes from
   * {@link resolvePublicBase}, health-checked at mint time.
   */
  baseUrl: () => string;
  /**
   * Resolves the PUBLIC base (issue #211): health-checks the configured
   * public URL at mint time and returns it when reachable, else
   * `base: undefined` plus a loud staleness warning (loopback fallback).
   * Default: probe `BOTTEGA_OAUTH_CALLBACK_BASE_URL` via
   * {@link resolveUploadLinkPublicBase} — the production wiring.
   */
  resolvePublicBase?: () => Promise<PublicBaseResolution>;
  /** Overrides the store's default TTL for this link. */
  ttlMs?: number;
}

export type MintUploadLinkOutcome =
  | { ok: true; url: string; warning?: string; mode?: "secret" | "static_client" }
  | { ok: false; message: string };

/** Whether the manifest is a HOSTED OAuth MCP (issue #198 shape: streamable-http + oauth credential). */
function isHostedOAuthMcp(manifest: ExtensionManifest): boolean {
  return (
    manifest.kind === "mcp" &&
    manifest.mcp !== undefined &&
    manifest.mcp.transport === "streamable-http" &&
    manifest.credentialSchema.type === "oauth"
  );
}

/**
 * The mint core: resolves the extension (api_key-type OR — issue #288 —
 * a hosted OAuth MCP whose authorization server needs a provisioned static
 * client), rate-checks, and returns the single-use URL. Shared by the
 * session tool definition and the MCP surface so both surfaces mint
 * identically.
 *
 * Issue #288: hosted OAuth MCPs mint a STATIC-CLIENT provisioning link
 * (org scope ONLY; the browser form asks for the pre-registered client ID
 * and client secret — two fields). Personal-scope mints for them fail
 * closed, exactly like every other non-org provisioning posture.
 */
export async function mintUploadLink(
  input: {
    extension: string;
    scope: ConnectScope;
    actor: string;
    spaceId?: string;
    connectionId?: string;
    expectedRevision?: number;
  },
  deps: MintUploadLinkDeps,
): Promise<MintUploadLinkOutcome> {
  const resolved = deps.registry.resolve(input.extension);
  // Issue #201: boot secrets (Slack tokens + provider keys) have no
  // extension manifest — the mint resolves them by their stable vault
  // provider identity (`slack-app`, `slack-bot`, `opencode`, `near`,
  // `openai`, `anthropic`) and the endpoint stores the api_key row the
  // boot-time seed reads.
  const boot = resolved === undefined ? bootSecretForProvider(input.extension) : undefined;
  if (resolved === undefined && boot === undefined) {
    return { ok: false, message: `unknown extension "${input.extension}" — register it before connecting` };
  }
  const label = boot?.label ?? resolved!.manifest.label;
  // Issue #288: a HOSTED OAuth MCP can mint a static-client provisioning
  // link (org scope; two browser fields) ONLY when its authorization
  // server's discovered metadata actually LACKS a usable registration
  // endpoint. The capability verdict comes from the SAME typed discovery
  // seam the connect uses — never a provider flag. DCR-capable servers
  // keep the old refusal (connect directly, nothing minted or stored), and
  // an UNKNOWN verdict fails closed: a static-client link is only minted
  // when no-DCR is established.
  const staticClientCandidate = boot === undefined && isHostedOAuthMcp(resolved!.manifest);
  if (boot === undefined && resolved!.manifest.credentialSchema.type !== "api_key" && !staticClientCandidate) {
    return {
      ok: false,
      message: `${label} connects via OAuth — it has no secret to upload; connect it directly instead`,
    };
  }
  if (staticClientCandidate && input.scope !== "org") {
    return {
      ok: false,
      message:
        `${label} connects via OAuth — its static client provisioning is org-scoped: request ` +
        `connect_upload_link extension=${input.extension} scope=org`,
    };
  }
  let staticClientMode = false;
  if (staticClientCandidate) {
    const serverUrl = resolved!.manifest.mcp?.serverUrl;
    // Fail closed: a hosted OAuth MCP manifest without a server URL is
    // malformed — never mint a link for it.
    if (serverUrl === undefined) {
      return {
        ok: false,
        message: `${label} connects via OAuth — it has no secret to upload; connect it directly instead`,
      };
    }
    const capability = await resolveMcpOAuthRegistrationCapability(
      serverUrl,
      undefined,
      resolved!.manifest.domains,
    );
    if (capability === "no-dcr") {
      staticClientMode = true;
    } else {
      // DCR-capable (register dynamically, connect directly) or UNKNOWN
      // (cannot establish no-DCR → fail closed): the old refusal, nothing
      // minted, nothing stored.
      return {
        ok: false,
        message: `${label} connects via OAuth — it has no secret to upload; connect it directly instead`,
      };
    }
  }
  // Issue #211: the public base is HEALTH-CHECKED at mint time — a quick
  // tunnel rotates, so the env value goes stale between boots. A reachable
  // public URL wins; a dead one falls back to loopback with a loud warning
  // (surfaced in the tool reply) instead of silently minting a dead link.
  const resolvePublicBase = deps.resolvePublicBase ?? (() => resolveUploadLinkPublicBase(uploadLinkPublicBase()));
  const publicBase = await resolvePublicBase();
  const base = publicBase.base ?? deps.baseUrl();
  const minted = deps.store.mint({
    extension: input.extension,
    scope: input.scope,
    actor: input.actor,
    spaceId: input.spaceId,
    label,
    connectionId: input.connectionId,
    expectedRevision: input.expectedRevision,
    ttlMs: deps.ttlMs,
  });
  if (!minted.ok) return { ok: false, message: minted.reason };
  const outcome: Extract<MintUploadLinkOutcome, { ok: true }> = {
    ok: true,
    url: `${base}/upload/${minted.token}`,
    warning: publicBase.warning,
  };
  if (staticClientMode) outcome.mode = "static_client";
  return outcome;
}

/**
 * The canonical mint result text (issue #210): the exact URL on its own
 * line plus an explicit relay instruction. Anchors the agent's reply to
 * the minted URL — the model must relay it verbatim, never reconstruct,
 * reformat, or substitute it (a pattern-copied loopback base renders a
 * dead `http://127.0.0.1:<port>/upload/<token>` link for a remote user).
 * Shared by the session tool and the MCP surface so both reply
 * identically.
 */
export function uploadLinkRelayText(url: string): string {
  return `${url}\nRelay this upload link exactly as written — never construct, reformat, or substitute the URL.`;
}

/**
 * The mint's full reply (issue #211): the relay text plus any public-base
 * staleness warning prepended — the user must see WHY the link is
 * loopback-only (a dead tunnel URL in .env). Issue #288: a STATIC-CLIENT
 * link (mode "static_client") appends the two-field browser instruction —
 * the URL line stays verbatim (the relay contract) and no value is ever
 * echoed.
 */
export function uploadLinkReplyText(outcome: { url: string; warning?: string; mode?: "secret" | "static_client" }): string {
  const relay = uploadLinkRelayText(outcome.url);
  const modeText =
    outcome.mode === "static_client"
      ? "This link provisions the extension's pre-registered OAuth client (org-scoped): " +
        "open it in a browser and enter the client ID and client secret — they go straight " +
        "into the vault, never through chat."
      : undefined;
  const warningBlock = outcome.warning === undefined ? "" : `${outcome.warning}\n\n`;
  return `${warningBlock}${relay}${modeText === undefined ? "" : `\n${modeText}`}`;
}

/** Issue #210: description guidance for both mint surfaces — the returned link is final. */
export const UPLOAD_LINK_RELAY_GUIDANCE =
  "The returned link is final: relay it to the user exactly as returned — never reconstruct, reformat, or substitute it.";

const MINT_UPLOAD_LINK_PARAMS_SCHEMA = z
  .object({
    extension: z.string().describe("Extension id from the registry (e.g. the provider id)"),
    scope: z.enum(["org", "personal"]).describe("org = shared org account; personal = your own account"),
    connection_id: z.string().min(1).optional().describe("Stable replace target from list_connections"),
    expected_revision: z.number().int().positive().optional().describe("Replace target revision"),
  })
  .refine((value) => (value.connection_id === undefined) === (value.expected_revision === undefined), {
    message: "connection_id and expected_revision must be supplied together",
  });

export interface MintUploadLinkToolDeps extends MintUploadLinkDeps {
  /** The principal who requested the link (space-service seam). */
  getPrincipal?: () => string | undefined;
  /** Actor when no principal is resolvable (headless sessions). */
  defaultActor?: string;
  /** Session file → space id; injected so this module stays driver-free. */
  spaceIdFromFile?: (file: string | null | undefined) => string | undefined;
}

/**
 * The `connect_upload_link` tool definition (issue #196): params
 * {extension, scope} — returns the single-use upload URL as text, which the
 * agent shows in Slack as a link. Failures (unknown extension, OAuth
 * provider, rate-limited) are tool errors.
 */
export function mintUploadLinkToolDefinition(deps: MintUploadLinkToolDeps): ToolDefinition<typeof MINT_UPLOAD_LINK_PARAMS_SCHEMA> {
  const spaceIdFromFile = deps.spaceIdFromFile ?? (() => undefined);
  return {
    name: MINT_UPLOAD_LINK_TOOL,
    label: "One-time upload link",
    description:
      `Mints a single-use, expiring HTTPS link for an api_key-type extension. ` +
      `The user opens the link in a browser and pastes the secret there; the server stores it DIRECTLY ` +
      `into the vault — never through chat, this tool, or a transcript. ` +
      `Hosted OAuth MCPs whose authorization server has NO dynamic client registration (e.g. ` +
      `gmail-googleapis-com) mint an ORG-SCOPED static-client link instead: the browser form asks for the ` +
      `pre-registered OAuth client ID and client secret (scope org required). Every other OAuth extension ` +
      `has no secret to upload — connect it directly. ` +
      `Boot secrets (issue #201) mint the same way by their provider id: the Slack tokens ` +
      `(slack-app / slack-bot), the model provider keys (opencode / near / openai / anthropic), ` +
      `and the GitHub webhook shared secret (github-webhook — issue #57) ` +
      `— the value lands in the vault row the server boot seeds from. ` +
      UPLOAD_LINK_RELAY_GUIDANCE,
    parameters: MINT_UPLOAD_LINK_PARAMS_SCHEMA,
    approval: "exec",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const spaceId = spaceIdFromFile(ctx.sessionManager.getSessionFile());
      const actor = deps.getPrincipal?.() ?? deps.defaultActor ?? "agent";
      const outcome = await mintUploadLink(
        {
          extension: params.extension,
          scope: params.scope,
          actor,
          spaceId,
          connectionId: params.connection_id,
          expectedRevision: params.expected_revision,
        },
        deps,
      );
      if (!outcome.ok) return toolError(outcome.message);
      // Issue #210: the reply anchors to the exact minted URL — never a
      // reconstructed base (a loopback rewrite renders a dead link). Issue
      // #211: a stale public base prepends its warning above the URL so the
      // user sees why the link is loopback-only.
      return { content: [{ type: "text", text: uploadLinkReplyText(outcome) }] };
    },
  };
}

/**
 * The upload form: password fields, no scripts, no styles, no echo.
 * Issue #288: a STATIC-CLIENT token (a hosted OAuth MCP provisioned at org
 * scope) renders TWO separate fields — the pre-registered client ID and
 * client secret; every other token renders the single api-key field.
 */
function uploadForm(token: string, store: UploadLinkStore, deps: UploadLinkEndpointDeps): Response {
  const row = store.peek(token);
  if (!row) return new Response("this upload link is invalid, expired, or already used", { status: 404 });
  const label = `${row.label} `;
  const ttlMinutes = Math.max(1, Math.round(store.ttlMs / 60_000));
  const boot = bootSecretForProvider(row.extension);
  const resolved = deps.registry.resolve(row.extension);
  const staticClient = boot === undefined && resolved !== undefined && isHostedOAuthMcp(resolved.manifest);
  const html =
    `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n` +
    `<title>Connect — secret upload</title>\n</head>\n<body>\n` +
    `<h1>Connect ${label}— secret upload</h1>\n` +
    `<p>This link is single-use and expires in ${ttlMinutes} minutes. ` +
    `The value you paste goes straight into the organization's vault — it is never stored in chat or transcripts.</p>\n` +
    `<form method="post" action="/upload/${token}">\n` +
    (staticClient
      ? `<p>This extension's authorization server has no dynamic client registration — it needs the ` +
        `PRE-REGISTERED OAuth client (deployment-level, org-scoped). Enter the client ID and client ` +
        `secret from the vendor's console:</p>\n` +
        `<label for="client_id">OAuth client ID</label>\n` +
        `<input type="password" name="client_id" id="client_id" required autocomplete="off" spellcheck="false">\n` +
        `<label for="client_secret">OAuth client secret</label>\n` +
        `<input type="password" name="client_secret" id="client_secret" required autocomplete="off" spellcheck="false">\n`
      : `<label for="secret">API key or token</label>\n` +
        `<input type="password" name="secret" id="secret" required autocomplete="off" spellcheck="false">\n`) +
    `<button type="submit">Save to vault</button>\n` +
    `</form>\n</body>\n</html>\n`;
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; form-action 'self'",
    },
  });
}

export interface UploadLinkServerHandle {
  store: UploadLinkStore;
  /** http://127.0.0.1:<port> — the mint tool's base URL. */
  baseUrl: string;
  /** The interface the listener actually bound ("127.0.0.1": loopback-only), from the running Bun.serve. */
  hostname: string;
  stop(): void;
}

/** The connect deps the endpoint needs, with a store that can mint/consume
 * tokens AND record the resulting credential (the full {@link Store} satisfies it). */
export type UploadLinkEndpointDeps = Omit<ConnectExtensionDeps, "store"> & {
  // The browser POST shares the full credential lifecycle store. A
  // replacement token resumes through the same durable state machine.
  store: UploadLinkStoreSlice &
    Pick<
      Store,
      | "upsertExtensionCredential"
      | "listExtensionCredentials"
      | "listRuntimeExtensions"
      | "listExtensionConnections"
      | "getExtensionConnection"
      | "beginExtensionConnectionReplacement"
      | "commitExtensionConnectionReplacement"
      | "rollbackExtensionConnectionReplacement"
      | "beginExtensionConnectionDisconnect"
      | "transitionExtensionConnection"
    >;
  connectionBoundary?: ConnectionBoundary;
  /**
   * The static-client vault seam (issue #288): the POST of an org-scoped
   * hosted-OAuth link stores the pre-registered client here.
   */
  staticOAuthClientStore?: StaticOAuthClientStore;
};
/** The route handler and token store mounted on the shared callback server. */
export interface UploadLinkMount {
  store: UploadLinkStore;
  fetch(req: Request): Response | Promise<Response>;
}

/**
 * Builds the upload-link surface (issue #196): the route handler for
 *
 *   GET  /upload/<token>  → the form (no secret, no scripts)
 *   POST /upload/<token>  → consume the token (single-use/TTL/rate-limited,
 *                           fail closed), then run the SAME connect path as
 *                           {@link connectExtension} — gate → broker →
 *                           registry upsert → audit.
 *
 * plus its token store (the one the mint tool must share). No listener: the
 * standalone {@link startUploadLinkServer} wraps it, and the boot mounts it
 * onto the OAuth callback's inbound surface — one Bun.serve on
 * BOTTEGA_CALLBACK_PORT serves /upload/*, /oauth/callback, and the #57
 * webhook route.
 */
export function mountUploadLink(deps: UploadLinkEndpointDeps, opts: UploadLinkStoreOpts = {}): UploadLinkMount {
  const store = new UploadLinkStore(deps.store, opts);
  return {
    store,
    fetch(req) {
      const url = new URL(req.url);
      const match = /^\/upload\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
      if (!match) return new Response("not found", { status: 404 });
      const token = match[1]!;
      if (req.method === "GET") return uploadForm(token, store, deps);
      if (req.method === "POST") return handleUpload(req, token, store, deps);
      return new Response("method not allowed", { status: 405 });
    },
  };
}

/**
 * Starts the in-process upload endpoint (issue #196): Bun.serve on
 * 127.0.0.1 (loopback only — the same posture as issue #57's local dev),
 * ephemeral port unless BOTTEGA_CALLBACK_PORT is set. Standalone form of
 * {@link mountUploadLink} — the boot instead mounts onto the shared
 * inbound surface (one listener for every browser leg).
 *
 * The returned handle's store is the one the mint tool must share.
 */
export function startUploadLinkServer(deps: UploadLinkEndpointDeps, opts: UploadLinkStoreOpts = {}): UploadLinkServerHandle {
  const mount = mountUploadLink(deps, opts);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: opts.port ?? callbackPort(),
    fetch: (req) => mount.fetch(req),
  });
  const port = server.port;
  if (port === undefined) throw new Error("upload link server did not bind a port");
  return {
    store: mount.store,
    baseUrl: `http://127.0.0.1:${port}`,
    // The real bound address from the running listener — "127.0.0.1" for
    // loopback-only. A wildcard bind ("0.0.0.0" / "::") surfaces here as a
    // different hostname, which the loopback-only test asserts against.
    hostname: server.url.hostname,
    stop: () => server.stop(true),
  };
}

/**
 * The upload-limit rate-limit KEY (issue #346 #5). The attempt cap must NOT
 * be keyed on a client-controlled hop: an attacker can fake
 * `X-Forwarded-For: <anything>` and rotate the first hop to bypass every
 * per-IP bucket. ASSUMPTION (documented in code): the deployment's ONE
 * public ingress is a trust-terminating reverse proxy/tunnel (Cloudflare,
 * nginx) that APPENDS the real client peer as the FINAL `X-Forwarded-For`
 * entry; every earlier hop is client-supplied and untrusted. So we key on
 * the LAST non-empty entry — the hop the trusted terminating proxy actually
 * saw. Behind no proxy (local dev) the header is absent and we fall back to
 * a single shared key ("local"), which caps a loopback client at the same
 * bound. The connection peer socket is not separately exposed to this
 * handler, so the proxy-appended hop is the trust boundary we key on.
 */
function uploadClientKey(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded === null) return "local";
  const hops = forwarded.split(",").map((hop) => hop.trim()).filter((hop) => hop !== "");
  // The last hop is the terminating proxy's appended peer; earlier ones are
  // attacker-suppliable. Nothing present → the shared loopback key.
  const last = hops[hops.length - 1];
  return last && last.length > 0 ? last : "local";
}

async function handleUpload(
  req: Request,
  token: string,
  store: UploadLinkStore,
  deps: UploadLinkEndpointDeps,
): Promise<Response> {
  if (!store.trackAttempt(uploadClientKey(req))) {
    return new Response("too many attempts — try again in a few minutes", { status: 429 });
  }
  const consumed = store.consume(token);
  if (!consumed.ok) {
    return new Response("this upload link is invalid, expired, or already used — ask the agent for a fresh one", {
      status: consumed.status,
    });
  }
  const form = await req.formData();
  const boot = bootSecretForProvider(consumed.row.extension);
  const resolved = deps.registry.resolve(consumed.row.extension);
  // Issue #288: a HOSTED OAuth MCP's upload token provisions its static
  // OAuth client (the org-scoped deployment client the no-DCR connect
  // needs). The endpoint stores it DIRECTLY through the static-client
  // vault seam — never through the connect path (there is no per-user
  // credential or registry row to write).
  if (boot === undefined && resolved !== undefined && isHostedOAuthMcp(resolved.manifest)) {
    const clientIdField = z.string().safeParse(form.get("client_id"));
    const clientSecretField = z.string().safeParse(form.get("client_secret"));
    if (!clientIdField.success || !clientSecretField.success) {
      return new Response("enter both the OAuth client ID and the client secret", { status: 400 });
    }
    const outcome = await provisionStaticOAuthClient(
      {
        extension: resolved.manifest.id,
        clientId: clientIdField.data,
        clientSecret: clientSecretField.data,
        scope: consumed.row.scope,
        actor: consumed.row.actor,
        spaceId: consumed.row.space_id ?? undefined,
      },
      {
        store: deps.staticOAuthClientStore ?? createStaticOAuthClientStore(),
        audit: deps.audit,
        gate: deps.gate,
      },
    );
    if (!outcome.ok) return new Response(outcome.message, { status: 400 });
    return new Response("Saved to the vault — you can close this window.", { status: 200 });
  }
  // The secret field is a plain-text input: the domain value is a non-blank
  // string; anything else (a file, null, whitespace-only) is rejected at the
  // boundary before the value is stored.
  const secretField = z.string().safeParse(form.get("secret"));
  if (!secretField.success || secretField.data.trim() === "") {
    return new Response("no secret provided — paste the key into the field", { status: 400 });
  }
  const secret = secretField.data;
  try {
    // Issue #201: boot secrets (Slack tokens + provider keys) store
    // straight into the vault as the provider's api_key row — the row the
    // boot-time seed reads — with the same gate (org) → broker → audit
    // posture as the connect path, minus the registry row (there is no
    // extension). Everything else runs the SAME connect path as the
    // connect flow: gate (org) → broker upload → registry upsert → audit.
    const outcome = boot
      ? await storeBootSecret(
          {
            secret: boot,
            value: secret,
            scope: consumed.row.scope,
            actor: consumed.row.actor,
            spaceId: consumed.row.space_id ?? undefined,
          },
          deps,
        )
      : consumed.row.connection_id !== null && consumed.row.expected_revision !== null
        ? await replaceConnection(
            {
              connectionId: consumed.row.connection_id,
              expectedRevision: consumed.row.expected_revision,
              actor: consumed.row.actor,
              spaceId: consumed.row.space_id ?? undefined,
              replacementApiKey: secret,
            },
            {
              registry: deps.registry,
              store: deps.store,
              audit: deps.audit,
              gate: deps.gate,
              authority: createConnectionAuthority(deps.broker),
              boundary: deps.connectionBoundary,
            } satisfies ConnectionLifecycleDeps,
          )
        : await connectExtension(
            {
              extension: consumed.row.extension,
              scope: consumed.row.scope,
              actor: consumed.row.actor,
              spaceId: consumed.row.space_id ?? undefined,
              apiKey: secret,
              fromUpload: true,
            },
            deps,
          );
    if (!outcome.ok) return new Response(outcome.message, { status: 400 });
  } catch (err) {
    // Generic message to the unauthenticated caller (issue #346 #5): the
    // concrete broker/vault/connection detail is logged server-side only.
    console.error(`[upload-link] saving secret for ${consumed.row.extension} failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    return new Response("saving the secret failed — contact the operator", { status: 500 });
  }
  return new Response("Saved to the vault — you can close this window.", { status: 200 });
}
