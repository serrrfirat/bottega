/**
 * Extension connect capability (issue #52): "connect as org / as me".
 *
 * The connect path drives the OMP auth broker's EXISTING import/login
 * surface — bottega never reimplements OAuth — and records the outcome in
 * the extension credential registry (issue #51) via
 * upsertExtensionCredential: metadata only, {provider, identityKey, owner,
 * scope, brokerCredentialId}. The secret payload itself stays in the broker
 * vault.
 *
 * Governance:
 * - scope "org" is privileged: the connect routes through the shared
 *   policy gate (src/policy/gate.ts — the exec/ask-human flow from
 *   issues #44/#45). The org policy must allow `connect_extension`
 *   (`tools: connect_extension: allow` in config.yml; the default policy
 *   denies — fail closed) and a human must approve the ask-human prompt.
 *   A denied connect never touches the broker and writes no registry row.
 * - scope "personal" is unprivileged: any principal may connect their own
 *   account (owner = actor). Personal rows are unique per (provider,
 *   owner) — re-connecting updates the existing row, never duplicates
 *   (the store's partial unique indexes enforce this too).
 *
 * Every successful connect writes an `extension.connected` audit row
 * {extension, scope, owner}; org connects additionally carry the gate's
 * `policy.decision` / `approval.requested` / `approval.resolved` rows, so
 * the trail for a privileged connect is complete.
 *
 * The broker seam: callers inject a {@link BrokerConnector};
 * {@link connectViaAuthBroker} is the production implementation (the
 * server's default). Known limitation: the broker's vault keeps ONE api_key
 * row per provider (API keys have no identity), so a personal api_key
 * re-connect replaces the vault row another owner's row still references —
 * the #53 runtime resolves credentials against the current vault state.
 */
import { z, type ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { runAuthBrokerCommand } from "@oh-my-pi/pi-coding-agent/cli/auth-broker-cli";
import { discoverAuthStorage } from "@oh-my-pi/pi-coding-agent";
import { resolveAuthBrokerConfig } from "@oh-my-pi/pi-coding-agent/session/auth-broker-config";
// The broker HTTP client comes from @oh-my-pi/pi-ai (the SDK's pinned
// transitive auth package, same 17.x release train) — no new dependency.
import { AuthBrokerClient } from "@oh-my-pi/pi-ai/auth-broker";
import type { ApprovalRouter } from "../policy/approval-router";
import type { AuditModule } from "../policy/audit";
import type { PolicyConfig } from "../policy/config";
import { evaluatePolicyGate } from "../policy/gate";
import type { ExtensionCredential, Store } from "../store/db";
import { EXTENSION_CONNECTED_EVENT } from "../store/audit-events";
import { errorMessage, toolError } from "../tools/helpers";
import { looksLikeObviousSecret } from "../tools/memory";
import type { McpOAuthConnector, McpOAuthStartResult } from "./mcp-oauth";
import type { CredentialType } from "./manifest";
import type { ExtensionRegistry } from "./registry";

/** The connect capability's tool/policy name (exec tier, issue #52). */
export const CONNECT_EXTENSION_TOOL = "connect_extension";

export type ConnectScope = "org" | "personal";

/** What the broker flow recorded in the vault (the secret payload stays there). */
export interface BrokerConnectResult {
  /**
   * Broker snapshot identity key (email/accountId/projectId) for OAuth
   * credentials; null for API keys — the broker derives no identity for
   * them, so bottega records a stable api-key identity instead (see
   * {@link apiKeyIdentityKey}).
   */
  identityKey: string | null;
  /** Auth-broker snapshot entry id of the connected vault row. */
  brokerCredentialId: number;
}

/**
 * The broker seam: invokes the existing OMP auth-broker import/login
 * surface for the provider and returns what the vault recorded. The flow
 * itself runs wherever the broker vault lives; this function drives it and
 * resolves the resulting vault row.
 */
export type BrokerConnector = (input: {
  provider: string;
  credentialType: CredentialType;
  /** Required by api_key credential types (the user's key, imported into the vault). */
  apiKey?: string;
}) => Promise<BrokerConnectResult>;

export interface ConnectExtensionDeps {
  /** Extension registry (provider manifests: id, label, credential schema). */
  registry: Pick<ExtensionRegistry, "resolve">;
  store: Pick<Store, "upsertExtensionCredential">;
  /** Redacting audit wrapper (src/policy/audit.ts). */
  audit: AuditModule;
  broker: BrokerConnector;
  /**
   * Generic MCP OAuth seam (issue #198): hosted OAuth MCPs (kind "mcp",
   * transport streamable-http, credential type "oauth") connect through
   * THIS — the authorization URL is minted and shown in Slack (one-time
   * link posture), the browser flow completes at the server's callback
   * endpoint, and the token lands in the vault via the existing upload
   * path — with zero broker provider registration. Absent → the hosted
   * OAuth path fails closed (never falls through to the broker's
   * provider-registry login, which would fail anyway).
   */
  mcpOAuth?: McpOAuthConnector;
  /** Policy gate used for org-scope connects (the exec/ask-human flow). */
  gate: {
    loadPolicy: (spaceId: string | undefined) => Promise<PolicyConfig>;
    router: ApprovalRouter;
    /** Ask-human timeout in ms; defaults to the policy's `approvals.timeout_minutes`. */
    timeoutMs?: number;
    /** Executor-session scope (issue #11); see decidePolicyCall. */
    preApproved?: boolean;
  };
}

export type ConnectOutcome =
  | { ok: true; credential: ExtensionCredential; message: string }
  | {
      ok: true;
      /** Null for hosted OAuth MCPs: the credential lands when the browser flow completes (issue #198). */
      credential: null;
      message: string;
    }
  | { ok: false; message: string };

/**
 * The no-secrets-in-chat redirect (issue #196): a credential-shaped value
 * pasted into the connect flow is refused with this pointer to the three
 * safe paths — OAuth (no secret to handle), the org's connected vault (the
 * #190 secret resolver at the egress boundary), or the one-time upload
 * link ({@link MINT_UPLOAD_LINK_TOOL}).
 */
export const SECRET_PASTE_REDIRECT =
  "pasted credentials are never stored or sent through chat — use OAuth, the org's connected vault, or ask for a one-time upload link instead";

/**
 * The connect capability core: paste guard (issue #196) → gate (org only)
 * → broker flow → registry upsert → audit + feedback. Fail closed: a
 * credential-shaped api_key, a denied gate, an unknown extension, a broker
 * failure, or a failed upsert all return an error and write no registry
 * row.
 */
export async function connectExtension(
  input: { extension: string; scope: ConnectScope; actor: string; spaceId?: string; apiKey?: string },
  deps: ConnectExtensionDeps,
): Promise<ConnectOutcome> {
  const resolved = deps.registry.resolve(input.extension);
  if (!resolved) {
    return { ok: false, message: `unknown extension "${input.extension}" — register it before connecting` };
  }
  const manifest = resolved.manifest;
  const provider = manifest.id;
  const label = manifest.label;

  // Paste guard (issue #196): refuse credential-shaped api_key values
  // BEFORE anything runs — no gate request, no broker call, no audit row —
  // so the value never reaches a transcript (mirrors #121's memory.save
  // rejection). The safe path is the one-time upload link: the secret goes
  // straight from the user's browser into the vault.
  if (input.apiKey !== undefined && looksLikeObviousSecret(input.apiKey)) {
    return { ok: false, message: SECRET_PASTE_REDIRECT };
  }

  // Org-scope connects are privileged: they cross the shared policy gate as
  // an exec-tier tool call (deny → blocked, allow → ask-human). Personal
  // connects are unprivileged — any principal connects their own account.
  if (input.scope === "org") {
    const outcome = await evaluatePolicyGate(
      {
        loadPolicy: deps.gate.loadPolicy,
        audit: deps.audit,
        router: deps.gate.router,
        timeoutMs: deps.gate.timeoutMs,
        preApproved: deps.gate.preApproved,
      },
      { tool: CONNECT_EXTENSION_TOOL, args: { extension: input.extension, scope: input.scope }, spaceId: input.spaceId, actor: input.actor },
    );
    if (!outcome.allowed) return { ok: false, message: outcome.blockReason };
  }

  // Hosted OAuth MCPs (issue #198) connect through the GENERIC MCP OAuth
  // flow, never the broker's provider-registry login (the broker knows no
  // `notion` OAuth provider, and per-provider broker work does not scale):
  // the authorization URL is minted here and shown in Slack (one-time-link
  // posture), the browser flow completes at the server's callback endpoint,
  // and the token lands in the vault through the existing upload path.
  if (
    manifest.kind === "mcp" &&
    manifest.mcp.transport === "streamable-http" &&
    manifest.credentialSchema.type === "oauth"
  ) {
    if (!deps.mcpOAuth) {
      return {
        ok: false,
        message: `connect ${label} failed: generic MCP OAuth is not wired in this server (issue #198)`,
      };
    }
    let oauthStart: McpOAuthStartResult;
    try {
      oauthStart = await deps.mcpOAuth.start({
        extension: input.extension,
        provider,
        label,
        scope: input.scope,
        actor: input.actor,
        spaceId: input.spaceId,
      });
    } catch (err) {
      return { ok: false, message: `connect ${label} failed: ${errorMessage(err)}` };
    }
    if (!oauthStart.ok) return { ok: false, message: oauthStart.message };
    // No registry row yet: the callback endpoint records the credential
    // after the browser flow completes (single-use state, fail closed).
    return { ok: true, credential: null, message: oauthStart.message };
  }

  let brokerResult: BrokerConnectResult;
  try {
    brokerResult = await deps.broker({ provider, credentialType: manifest.credentialSchema.type, apiKey: input.apiKey });
  } catch (err) {
    return { ok: false, message: `connect ${label} failed: ${errorMessage(err)}` };
  }

  const owner = input.scope === "personal" ? input.actor : null;
  const identityKey = brokerResult.identityKey ?? apiKeyIdentityKey(provider, input.scope, owner);
  let credential: ExtensionCredential;
  try {
    credential = await deps.store.upsertExtensionCredential({
      provider,
      identityKey,
      owner,
      scope: input.scope,
      brokerCredentialId: brokerResult.brokerCredentialId,
    });
  } catch (err) {
    return { ok: false, message: `connect ${label} failed: ${errorMessage(err)}` };
  }

  await deps.audit.appendAudit({
    space_id: input.spaceId ?? null,
    actor: input.actor,
    event_type: EXTENSION_CONNECTED_EVENT,
    payload: { extension: input.extension, scope: input.scope, owner },
  });

  const message =
    input.scope === "org" ? `${label} connected as an organization` : `${label} connected as @${input.actor}`;
  return { ok: true, credential, message };
}

/**
 * Stable registry identity for API-key vault rows: the broker derives no
 * identity for API keys, so bottega records a deterministic, readable key
 * (one org row per provider, one personal row per owner — the same
 * uniqueness the registry rows enforce).
 */
export function apiKeyIdentityKey(provider: string, scope: ConnectScope, owner: string | null): string {
  return scope === "org" ? `api-key:${provider}` : `api-key:${owner ?? "unknown"}`;
}

/**
 * Stable registry identity for GENERIC MCP OAuth vault rows (issue #198):
 * hosted OAuth servers return no account identity in the token response
 * (no email/accountId like the broker's model-provider flows), so bottega
 * records a deterministic, readable key — one org row per provider, one
 * personal row per owner — exactly like API keys.
 */
export function oauthIdentityKey(provider: string, scope: ConnectScope, owner: string | null): string {
  return scope === "org" ? `oauth:${provider}` : `oauth:${owner ?? "unknown"}`;
}

/** Newest broker snapshot entry (broker row ids increase monotonically). */
export function pickNewestBrokerEntry<T extends { id: number }>(entries: readonly T[]): T | null {
  let newest: T | null = null;
  for (const entry of entries) {
    if (newest === null || entry.id > newest.id) newest = entry;
  }
  return newest;
}

/**
 * Production broker connector (the server's default): drives the existing
 * OMP auth-broker surface for the provider, then resolves the vault row
 * the flow recorded.
 *
 * - oauth: `omp auth-broker login <provider>` — the interactive OAuth
 *   flow. Login runs where the broker vault lives (on the broker host in
 *   broker deployments, `--via=user@host` for remote flows); this process
 *   then reads the vault through discoverAuthStorage, so the credential
 *   the flow wrote is the one that gets recorded.
 * - api_key: the key is uploaded into the vault — through the broker's
 *   POST /v1/credential when a broker is configured, else the local
 *   credential store.
 *
 * Throws when the flow fails or no entry for the provider appears in the
 * vault afterwards — a connect that recorded nothing must never succeed.
 */
export async function connectViaAuthBroker(input: {
  provider: string;
  credentialType: CredentialType;
  apiKey?: string;
}): Promise<BrokerConnectResult> {
  if (input.credentialType === "oauth") {
    // The CLI maps the positional provider arg onto flags.provider; the
    // programmatic surface reads that same slot.
    await runAuthBrokerCommand({ action: "login", flags: { json: true, provider: input.provider } });
    const storage = await discoverAuthStorage();
    try {
      await storage.reload();
      const entries = storage.exportSnapshot().credentials.filter((entry) => entry.provider === input.provider);
      const newest = pickNewestBrokerEntry(entries);
      if (!newest?.identityKey) {
        throw new Error(`no "${input.provider}" OAuth identity found in the vault after the broker login`);
      }
      return { identityKey: newest.identityKey, brokerCredentialId: newest.id };
    } finally {
      storage.close();
    }
  }

  const apiKey = input.apiKey?.trim();
  if (!apiKey) {
    throw new Error(`connect ${input.provider} needs its API key (api_key extensions require the key)`);
  }
  const brokerConfig = await resolveAuthBrokerConfig();
  if (brokerConfig) {
    const client = new AuthBrokerClient({ url: brokerConfig.url, token: brokerConfig.token });
    const res = await client.uploadCredential(input.provider, { type: "api_key", key: apiKey });
    const newest = pickNewestBrokerEntry(res.entries);
    if (!newest) throw new Error(`the broker did not record the "${input.provider}" API key`);
    return { identityKey: null, brokerCredentialId: newest.id };
  }
  const storage = await discoverAuthStorage();
  try {
    const entries = storage.upsertCredential(input.provider, { type: "api_key", key: apiKey });
    const newest = pickNewestBrokerEntry(entries);
    if (!newest) throw new Error(`the vault did not record the "${input.provider}" API key`);
    return { identityKey: null, brokerCredentialId: newest.id };
  } finally {
    storage.close();
  }
}

export interface ConnectToolDeps extends ConnectExtensionDeps {
  /** The principal who requested the connect (space-service seam). */
  getPrincipal?: () => string | undefined;
  /** Actor when no principal is resolvable (headless sessions). */
  defaultActor?: string;
  /** Session file → space id; injected so this module stays driver-free. */
  spaceIdFromFile?: (file: string | null | undefined) => string | undefined;
}

/** `connect_extension` params: {extension, scope} plus the optional api_key for api_key-type extensions. */
const CONNECT_PARAMS_SCHEMA = z.object({
  extension: z.string().describe("Extension id from the registry (e.g. the provider id)"),
  scope: z.enum(["org", "personal"]).describe("org = shared org account (needs approval); personal = your own account"),
  api_key: z
    .string()
    .optional()
    .describe(
      "API key for api_key-type extensions — never paste a live token here (it would land in the transcript); use connect_upload_link instead",
    ),
});

/**
 * The `connect_extension` tool definition (issue #52): params {extension,
 * scope: org|personal} plus the optional api_key for api_key-type
 * extensions. Returns the in-channel confirmation text ("Attio connected as
 * an organization / as @alice"); failures are tool errors.
 */
export function connectExtensionToolDefinition(deps: ConnectToolDeps): ToolDefinition<typeof CONNECT_PARAMS_SCHEMA> {
  const spaceIdFromFile = deps.spaceIdFromFile ?? (() => undefined);
  return {
    name: CONNECT_EXTENSION_TOOL,
    label: "Connect extension",
    description:
      `Connects an extension account for use in this space. ` +
      `scope "org" connects the organization's shared account — privileged, requires a human approver. ` +
      `scope "personal" connects the requesting user's own account — any user may do it. ` +
      `Extensions whose credential type is api_key require the api_key parameter. ` +
      `Never paste a live token here — pasted credentials are refused and land nowhere; ` +
      `use connect_upload_link to mint a one-time browser upload instead.`,
    parameters: CONNECT_PARAMS_SCHEMA,
    approval: "exec",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const spaceId = spaceIdFromFile(ctx.sessionManager.getSessionFile());
      const actor = deps.getPrincipal?.() ?? deps.defaultActor ?? "agent";
      const outcome = await connectExtension(
        { extension: params.extension, scope: params.scope, apiKey: params.api_key, actor, spaceId },
        deps,
      );
      if (!outcome.ok) return toolError(outcome.message);
      return { content: [{ type: "text", text: outcome.message }] };
    },
  };
}
