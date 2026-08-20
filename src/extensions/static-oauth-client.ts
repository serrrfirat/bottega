/**
 * Static OAuth client provisioning (issue #288): hosted MCP servers whose
 * authorization server has NO dynamic client registration endpoint (the
 * Gmail class) need a PRE-REGISTERED OAuth client — the operator creates
 * one in the vendor's console (a Google "web application" OAuth client for
 * Gmail) and provisions it here, deployment-level, once.
 *
 * The seam's contract:
 *
 *   - The pinned auth-broker accepts ONLY `api_key` and `oauth`
 *     credentials — it is never forked and gains no dependency. The
 *     validated static-client JSON (`{"client_id":…,"client_secret":…}`)
 *     is stored as an OPAQUE `api_key` credential under a deterministic,
 *     collision-safe synthetic provider key derived from the extension
 *     (`static-oauth-client:<extension>`), SEPARATE from the per-user
 *     OAuth token rows (which stay under the real extension id).
 *   - The representation (the JSON encoding) never leaks outside this
 *     module: {@link StaticOAuthClientStore.load} returns the TYPED
 *     `{ client_id, client_secret }`, never the raw row; malformed /
 *     missing rows read as `null` (fail closed → the connect surfaces the
 *     provisioning instruction).
 *   - Provisioning is org-scoped, policy-gated, and audited with metadata
 *     ONLY (extension/scope/actor/status — never client values).
 */
import { discoverAuthStorage } from "@oh-my-pi/pi-coding-agent";
import type { AuditModule } from "../policy/audit";
import { evaluatePolicyGate } from "../policy/gate";
import { STATIC_CLIENT_PROVISIONED_EVENT } from "../store/audit-events";
import { errorMessage } from "../tools/helpers";
import {
  CONNECT_EXTENSION_TOOL,
  connectViaAuthBroker,
  type BrokerConnector,
  type ConnectExtensionDeps,
  type ConnectScope,
} from "./connect";

/** The vault provider-key prefix for static OAuth client rows (issue #288). */
export const STATIC_OAUTH_CLIENT_PROVIDER_PREFIX = "static-oauth-client";

/**
 * The deterministic, collision-safe synthetic vault provider key for an
 * extension's deployment-level static OAuth client. Real providers are
 * manifest ids / boot-secret ids — none contain a colon — so the
 * `static-oauth-client:` prefix can never collide with the per-user OAuth
 * token rows (which live under the REAL extension id, unchanged).
 */
export function staticOAuthClientProviderKey(extension: string): string {
  return `${STATIC_OAUTH_CLIENT_PROVIDER_PREFIX}:${extension}`;
}

/** Upper bound for a pre-registered client id (Google ids are ~100 chars). */
export const STATIC_CLIENT_ID_MAX_LENGTH = 512;
/** Upper bound for a pre-registered client secret (Google secrets are ~40 chars). */
export const STATIC_CLIENT_SECRET_MAX_LENGTH = 512;

/** A validated pre-registered OAuth client (the typed static-client shape). */
export interface StaticOAuthClient {
  client_id: string;
  client_secret: string;
}

/**
 * Validates an arbitrary static-client shape: both fields must be
 * non-empty strings within the bounds, free of control characters. Fail
 * closed — anything else is a clear error, never a stored or returned
 * value. The returned client is TRIMMED (leading/trailing whitespace
 * around a pasted value is an upload artifact, never part of a secret).
 */
export function parseStaticOAuthClient(raw: unknown): { ok: true; client: StaticOAuthClient } | { ok: false; message: string } {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, message: "static OAuth client must be a JSON object with client_id and client_secret" };
  }
  const obj = raw as Record<string, unknown>;
  const clientId = typeof obj.client_id === "string" ? obj.client_id.trim() : "";
  const clientSecret = typeof obj.client_secret === "string" ? obj.client_secret.trim() : "";
  if (clientId === "") return { ok: false, message: "client_id must be a non-empty string" };
  if (clientSecret === "") return { ok: false, message: "client_secret must be a non-empty string" };
  if (clientId.length > STATIC_CLIENT_ID_MAX_LENGTH) {
    return { ok: false, message: `client_id exceeds ${STATIC_CLIENT_ID_MAX_LENGTH} characters` };
  }
  if (clientSecret.length > STATIC_CLIENT_SECRET_MAX_LENGTH) {
    return { ok: false, message: `client_secret exceeds ${STATIC_CLIENT_SECRET_MAX_LENGTH} characters` };
  }
  if (/[\u0000-\u001f\u007f]/.test(`${clientId}${clientSecret}`)) {
    return { ok: false, message: "client values must not contain control characters" };
  }
  return { ok: true, client: { client_id: clientId, client_secret: clientSecret } };
}

/** The opaque api_key value that holds a validated static client in the vault. */
function serializeStaticOAuthClient(client: StaticOAuthClient): string {
  return JSON.stringify({ client_id: client.client_id, client_secret: client.client_secret });
}

/**
 * The static-client vault seam. SAVE stores the validated client through
 * the SAME vault path as every api_key upload (broker when configured,
 * else the local AuthStorage) under the synthetic provider key — the
 * broker records an opaque api_key row, nothing more. LOAD reads the
 * newest ACTIVE row for the synthetic provider, parses + validates the
 * opaque payload fail-closed, and returns the TYPED client — `null` for a
 * missing OR malformed row (the representation never leaves the seam).
 */
export interface StaticOAuthClientStore {
  /** Stores the validated static client; returns the vault row id. */
  save(extension: string, client: StaticOAuthClient): Promise<{ brokerCredentialId: number }>;
  /** The newest active static-client row for the extension; null when missing/malformed (fail closed). */
  load(extension: string): Promise<StaticOAuthClient | null>;
}

/**
 * Production static-client store (the server's default): the vault write
 * drives the broker-or-local api_key upload (exactly the
 * {@link connectViaAuthBroker} branch), the read resolves through the
 * local AuthStorage like every vault read (broker deployments sync the
 * snapshot locally). Injectable broker for tests; the default is the
 * production connector.
 */
export function createStaticOAuthClientStore(opts: { broker?: BrokerConnector } = {}): StaticOAuthClientStore {
  const broker = opts.broker ?? connectViaAuthBroker;
  return {
    async save(extension, client) {
      const providerKey = staticOAuthClientProviderKey(extension);
      const result = await broker({ provider: providerKey, credentialType: "api_key", apiKey: serializeStaticOAuthClient(client) });
      return { brokerCredentialId: result.brokerCredentialId };
    },
    async load(extension) {
      const providerKey = staticOAuthClientProviderKey(extension);
      const storage = await discoverAuthStorage();
      try {
        await storage.reload();
        const rows = storage
          .listStoredCredentials(providerKey)
          // "Active" only: disabled/blocked rows are never the static client.
          .filter((entry) => entry.disabledCause === null)
          .sort((a, b) => b.id - a.id);
        const newest = rows[0];
        if (newest === undefined || newest.credential.type !== "api_key") return null;
        const parsed = parseStaticOAuthClient(JSON.parse(newest.credential.key));
        if (!parsed.ok) {
          // Malformed vault JSON: fail closed (missing client) — the connect
          // surfaces the provisioning instruction. Logged loudly with the
          // extension id only — never the payload.
          console.error(
            `[static-oauth-client] the "${extension}" static OAuth client row is malformed (${parsed.message}) — ` +
              `re-provision it with connect_upload_link extension=${extension} scope=org`,
          );
          return null;
        }
        return parsed.client;
      } catch (err) {
        console.error(
          `[static-oauth-client] failed to read the "${extension}" static OAuth client row: ${errorMessage(err)}`,
        );
        return null;
      } finally {
        storage.close();
      }
    },
  };
}

/**
 * Org-scoped static OAuth client provisioning (issue #288): validates the
 * submitted client, crosses the SAME exec-tier policy gate as every org
 * connect (mint approves the link, this POST approves the store — the
 * #196 double-gate posture), stores it in the vault, and audits metadata
 * ONLY (extension/scope/actor/status — never client values). Personal
 * provisioning and invalid values fail closed with nothing stored.
 */
export async function provisionStaticOAuthClient(
  input: { extension: string; clientId: string; clientSecret: string; scope: ConnectScope; actor: string; spaceId?: string },
  deps: { store: StaticOAuthClientStore; audit: AuditModule; gate: ConnectExtensionDeps["gate"] },
): Promise<{ ok: true; brokerCredentialId: number } | { ok: false; message: string }> {
  const parsed = parseStaticOAuthClient({ client_id: input.clientId, client_secret: input.clientSecret });
  if (!parsed.ok) {
    return { ok: false, message: `static OAuth client provisioning for ${input.extension} failed: ${parsed.message}` };
  }
  if (input.scope !== "org") {
    return {
      ok: false,
      message:
        `static OAuth client provisioning is org-scoped — request ` +
        `connect_upload_link extension=${input.extension} scope=org`,
    };
  }
  // Personal provisioning returned above — the remaining path is org-only,
  // so the audit owner is always null (org rows are shared).
  const owner: string | null = null;
  const outcome = await evaluatePolicyGate(
    {
      loadPolicy: deps.gate.loadPolicy,
      audit: deps.audit,
      router: deps.gate.router,
      timeoutMs: deps.gate.timeoutMs,
      preApproved: deps.gate.preApproved,
    },
    {
      tool: CONNECT_EXTENSION_TOOL,
      args: { extension: input.extension, scope: input.scope },
      spaceId: input.spaceId,
      actor: input.actor,
    },
  );
  if (!outcome.allowed) return { ok: false, message: outcome.blockReason };
  let saved: { brokerCredentialId: number };
  try {
    saved = await deps.store.save(input.extension, parsed.client);
  } catch (err) {
    return {
      ok: false,
      message: `static OAuth client provisioning for ${input.extension} failed: ${errorMessage(err)}`,
    };
  }
  await deps.audit.appendAudit({
    space_id: input.spaceId ?? null,
    actor: input.actor,
    event_type: STATIC_CLIENT_PROVISIONED_EVENT,
    payload: { extension: input.extension, scope: input.scope, owner, status: "provisioned" },
  });
  return { ok: true, brokerCredentialId: saved.brokerCredentialId };
}
