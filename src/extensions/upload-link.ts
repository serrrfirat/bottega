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
 *              passes through Slack, the agent, or a transcript.
 *
 * The token store is the SQLite store's `upload_tokens` table (shared by
 * the server process — which hosts the endpoint — and the per-session MCP
 * child processes that mint links), so a link minted anywhere is
 * consumable by the endpoint.
 */
import { z, type ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { errorMessage, toolError } from "../tools/helpers";
import type { Store, UploadToken } from "../store/db";
import type { ExtensionRegistry } from "./registry";
import { connectExtension, type ConnectExtensionDeps, type ConnectScope } from "./connect";

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

export interface UploadLinkStoreOpts {
  /** Token lifetime in ms (default {@link UPLOAD_LINK_TTL_MS}). */
  ttlMs?: number;
  /** Max live links per actor (default {@link UPLOAD_LINK_MAX_OUTSTANDING_PER_ACTOR}). */
  maxOutstandingPerActor?: number;
  /** Max POST attempts per client IP in the window (default {@link UPLOAD_LINK_MAX_ATTEMPTS_PER_IP}). */
  maxAttemptsPerIp?: number;
  /** Per-IP attempt window in ms (default {@link UPLOAD_LINK_ATTEMPTS_WINDOW_MS}). */
  attemptsWindowMs?: number;
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
  /** Resolves the endpoint base URL (http://127.0.0.1:<port>) at call time. */
  baseUrl: () => string;
  /** Overrides the store's default TTL for this link. */
  ttlMs?: number;
}

export type MintUploadLinkOutcome = { ok: true; url: string } | { ok: false; message: string };

/**
 * The mint core: resolves the extension (api_key-type only — OAuth has no
 * secret to upload), rate-checks, and returns the single-use URL. Shared by
 * the session tool definition and the MCP surface so both surfaces mint
 * identically.
 */
export function mintUploadLink(
  input: { extension: string; scope: ConnectScope; actor: string; spaceId?: string },
  deps: MintUploadLinkDeps,
): MintUploadLinkOutcome {
  const resolved = deps.registry.resolve(input.extension);
  if (!resolved) {
    return { ok: false, message: `unknown extension "${input.extension}" — register it before connecting` };
  }
  const label = resolved.manifest.label;
  if (resolved.manifest.credentialSchema.type !== "api_key") {
    return {
      ok: false,
      message: `${label} connects via OAuth — it has no secret to upload; connect it directly instead`,
    };
  }
  const minted = deps.store.mint({
    extension: input.extension,
    scope: input.scope,
    actor: input.actor,
    spaceId: input.spaceId,
    label,
    ttlMs: deps.ttlMs,
  });
  if (!minted.ok) return { ok: false, message: minted.reason };
  return { ok: true, url: `${deps.baseUrl()}/upload/${minted.token}` };
}

const MINT_UPLOAD_LINK_PARAMS_SCHEMA = z.object({
  extension: z.string().describe("Extension id from the registry (e.g. the provider id)"),
  scope: z.enum(["org", "personal"]).describe("org = shared org account; personal = your own account"),
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
      `into the vault — never through chat, this tool, or a transcript. OAuth extensions have no secret ` +
      `to upload and should be connected directly.`,
    parameters: MINT_UPLOAD_LINK_PARAMS_SCHEMA,
    approval: "exec",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const spaceId = spaceIdFromFile(ctx.sessionManager.getSessionFile());
      const actor = deps.getPrincipal?.() ?? deps.defaultActor ?? "agent";
      const outcome = mintUploadLink(
        { extension: params.extension, scope: params.scope, actor, spaceId },
        deps,
      );
      if (!outcome.ok) return toolError(outcome.message);
      return { content: [{ type: "text", text: outcome.url }] };
    },
  };
}

/** The upload form: a password field, no scripts, no styles, no echo. */
function uploadForm(token: string, store: UploadLinkStore): Response {
  const row = store.peek(token);
  if (!row) return new Response("this upload link is invalid, expired, or already used", { status: 404 });
  const label = `${row.label} `;
  const ttlMinutes = Math.max(1, Math.round(store.ttlMs / 60_000));
  const html =
    `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n` +
    `<title>Connect — secret upload</title>\n</head>\n<body>\n` +
    `<h1>Connect ${label}— secret upload</h1>\n` +
    `<p>This link is single-use and expires in ${ttlMinutes} minutes. ` +
    `The value you paste goes straight into the organization's vault — it is never stored in chat or transcripts.</p>\n` +
    `<form method="post" action="/upload/${token}">\n` +
    `<label for="secret">API key or token</label>\n` +
    `<input type="password" name="secret" id="secret" required autocomplete="off" spellcheck="false">\n` +
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
  stop(): void;
}

/** The connect deps the endpoint needs, with a store that can mint/consume
 * tokens AND record the resulting credential (the full {@link Store} satisfies it). */
export type UploadLinkEndpointDeps = Omit<ConnectExtensionDeps, "store"> & {
  store: UploadLinkStoreSlice & Pick<Store, "upsertExtensionCredential">;
};

/**
 * Starts the in-process upload endpoint (issue #196): Bun.serve on
 * 127.0.0.1 (loopback only — the same posture as issue #57's local dev),
 * ephemeral port.
 *
 *   GET  /upload/<token>  → the form (no secret, no scripts)
 *   POST /upload/<token>  → consume the token (single-use/TTL/rate-limited,
 *                           fail closed), then run the SAME connect path as
 *                           {@link connectExtension} — gate → broker →
 *                           registry upsert → audit.
 *
 * The returned handle's store is the one the mint tool must share.
 */
export function startUploadLinkServer(deps: UploadLinkEndpointDeps, opts: UploadLinkStoreOpts = {}): UploadLinkServerHandle {
  const store = new UploadLinkStore(deps.store, opts);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const match = /^\/upload\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
      if (!match) return new Response("not found", { status: 404 });
      const token = match[1]!;
      if (req.method === "GET") return uploadForm(token, store);
      if (req.method === "POST") return handleUpload(req, token, store, deps);
      return new Response("method not allowed", { status: 405 });
    },
  });
  const port = server.port;
  if (port === undefined) throw new Error("upload link server did not bind a port");
  return { store, baseUrl: `http://127.0.0.1:${port}`, stop: () => server.stop(true) };
}

async function handleUpload(
  req: Request,
  token: string,
  store: UploadLinkStore,
  deps: UploadLinkEndpointDeps,
): Promise<Response> {
  if (!store.trackAttempt(req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local")) {
    return new Response("too many attempts — try again in a few minutes", { status: 429 });
  }
  const consumed = store.consume(token);
  if (!consumed.ok) {
    return new Response("this upload link is invalid, expired, or already used — ask the agent for a fresh one", {
      status: consumed.status,
    });
  }
  const form = await req.formData();
  const secret = form.get("secret");
  if (typeof secret !== "string" || secret.trim() === "") {
    return new Response("no secret provided — paste the key into the field", { status: 400 });
  }
  try {
    // The SAME path as the connect flow: gate (org) → broker upload →
    // registry upsert → audit. The endpoint never sees the secret's value
    // anywhere else; the vault is its only destination.
    const outcome = await connectExtension(
      {
        extension: consumed.row.extension,
        scope: consumed.row.scope,
        actor: consumed.row.actor,
        spaceId: consumed.row.space_id ?? undefined,
        apiKey: secret,
      },
      deps,
    );
    if (!outcome.ok) return new Response(outcome.message, { status: 400 });
  } catch (err) {
    return new Response(`saving the secret failed: ${errorMessage(err)}`, { status: 500 });
  }
  return new Response("Saved to the vault — you can close this window.", { status: 200 });
}
