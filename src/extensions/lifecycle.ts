import { AuthBrokerClient } from "@oh-my-pi/pi-ai/auth-broker";
import { discoverAuthStorage, z, type ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { resolveAuthBrokerConfig } from "@oh-my-pi/pi-coding-agent/session/auth-broker-config";
import type { AuditModule } from "../policy/audit";
import type { ApprovalRouter } from "../policy/approval-router";
import type { PolicyConfig } from "../policy/config";
import { evaluatePolicyGate } from "../policy/gate";
import {
  EXTENSION_CONNECTION_PHASE_EVENT,
  EXTENSION_CONNECTION_READ_EVENT,
} from "../store/audit-events";
import type { ConnectionStatus, ExtensionCredential, Store } from "../store/db";
import { errorMessage, toolError } from "../tools/helpers";
import { createSecretFileBoundary, type ConnectionBoundary, type CredentialReplacementPreparation } from "./boundary";
import { connectViaAuthBroker, type BrokerConnector } from "./connect";
import type { CredentialType } from "./manifest";
import type { ExtensionRegistry } from "./registry";

export const LIST_CONNECTIONS_TOOL = "list_connections";
export const INSPECT_CONNECTION_TOOL = "inspect_connection";
export const REPLACE_CONNECTION_TOOL = "replace_connection";
export const DISCONNECT_CONNECTION_TOOL = "disconnect_connection";

export type { ConnectionBoundary } from "./boundary";
export type ConnectionReadModel = {
  id: string;
  provider: string;
  label: string;
  identity_label: string;
  scope: "org" | "personal";
  owner: "organization" | "you";
  status: ConnectionStatus;
  revision: number;
  reconnect_needed: boolean;
  created_at: number;
  updated_at: number;
};

export interface ConnectionAuthority {
  provision(input: {
    connection: ExtensionCredential;
    credentialType: CredentialType;
    apiKey?: string;
  }): Promise<{ brokerCredentialId: number; identityKey: string }>;
  revoke(credential: ExtensionCredential): Promise<void>;
}

/** Production authority adapter. Vault disable is scoped to the selected row id. */
export function createConnectionAuthority(broker: BrokerConnector = connectViaAuthBroker): ConnectionAuthority {
  return {
    async provision(input) {
      const result = await broker({
        provider: input.connection.provider,
        vaultProvider: input.connection.vault_provider,
        credentialType: input.credentialType,
        apiKey: input.apiKey,
      });
      return {
        brokerCredentialId: result.brokerCredentialId,
        identityKey: result.identityKey ?? input.connection.identity_key,
      };
    },
    async revoke(credential) {
      const brokerConfig = await resolveAuthBrokerConfig();
      if (brokerConfig) {
        const client = new AuthBrokerClient({ url: brokerConfig.url, token: brokerConfig.token });
        await client.disableCredential(
          credential.broker_credential_id,
          `bottega connection ${credential.id} ${credential.status}`,
        );
        return;
      }
      const storage = await discoverAuthStorage();
      try {
        storage.disableCredentialById(
          credential.broker_credential_id,
          `bottega connection ${credential.id} ${credential.status}`,
        );
      } finally {
        storage.close();
      }
    },
  };
}

export interface ConnectionLifecycleDeps {
  registry: Pick<ExtensionRegistry, "resolve">;
  store: Pick<
    Store,
    | "listExtensionConnections"
    | "getExtensionConnection"
    | "beginExtensionConnectionReplacement"
    | "commitExtensionConnectionReplacement"
    | "rollbackExtensionConnectionReplacement"
    | "beginExtensionConnectionDisconnect"
    | "transitionExtensionConnection"
  >;
  audit: AuditModule;
  authority?: ConnectionAuthority;
  boundary?: ConnectionBoundary;
  gate: {
    loadPolicy: (spaceId: string | undefined) => Promise<PolicyConfig>;
    router: ApprovalRouter;
    timeoutMs?: number;
    preApproved?: boolean;
  };
}

export interface ConnectionLifecycleToolDeps extends ConnectionLifecycleDeps {
  getPrincipal?: () => string | undefined;
  defaultActor?: string;
  spaceIdFromFile?: (file: string | null | undefined) => string | undefined;
}

type LifecycleOutcome = { ok: true; message: string } | { ok: false; message: string };

const EMPTY_PARAMS = z.object({});
const TARGET_PARAMS = z.object({
  connection_id: z.string().min(1).describe("Stable connection id from list_connections"),
});
const MUTATION_PARAMS = z.object({
  connection_id: z.string().min(1).describe("Stable connection id from list_connections"),
  expected_revision: z.number().int().positive().describe("Revision returned by list_connections or inspect_connection"),
});
function visibleConnection(connection: ExtensionCredential, actor: string): boolean {
  return connection.scope === "org" || connection.owner === actor;
}

function identityLabel(identityKey: string): string {
  if (identityKey.startsWith("api-key:")) return "API key";
  const email = identityKey.includes(":") ? identityKey.slice(identityKey.indexOf(":") + 1) : identityKey;
  const at = email.indexOf("@");
  if (at > 0) return `${email[0]}***${email.slice(at)}`;
  if (identityKey.startsWith("oauth:")) return "OAuth account";
  if (identityKey.startsWith("account:")) {
    const suffix = identityKey.slice("account:".length);
    return suffix.length > 4 ? `account ending ${suffix.slice(-4)}` : "connected account";
  }
  return "connected account";
}

function toConnectionReadModel(connection: ExtensionCredential, registry: Pick<ExtensionRegistry, "resolve">): ConnectionReadModel {
  return {
    id: connection.id,
    provider: connection.provider,
    label: registry.resolve(connection.provider)?.manifest.label ?? connection.provider,
    identity_label: identityLabel(connection.identity_key),
    scope: connection.scope,
    owner: connection.scope === "org" ? "organization" : "you",
    status: connection.status,
    revision: connection.revision,
    reconnect_needed: connection.status !== "active",
    created_at: connection.created_at,
    updated_at: connection.updated_at,
  };
}

function connectionLine(connection: ConnectionReadModel): string {
  const reconnectNeeded = connection.reconnect_needed ? "yes" : "no";
  return `${connection.id} — ${connection.label}; identity=${connection.identity_label}; scope=${connection.scope}; owner=${connection.owner}; status=${connection.status}; revision=${connection.revision}; reconnect_needed=${reconnectNeeded}`;
}

async function appendLifecycleAudit(
  deps: ConnectionLifecycleDeps,
  input: {
    actor: string;
    spaceId?: string;
    connection: ExtensionCredential;
    phase: string;
  },
): Promise<void> {
  await deps.audit.appendAudit({
    space_id: input.spaceId ?? null,
    actor: input.actor,
    event_type: EXTENSION_CONNECTION_PHASE_EVENT,
    payload: {
      connection_id: input.connection.id,
      provider: input.connection.provider,
      scope: input.connection.scope,
      phase: input.phase,
      revision: input.connection.revision,
      status: input.connection.status,
    },
  });
}

async function authorizedConnection(
  deps: ConnectionLifecycleDeps,
  id: string,
  actor: string,
): Promise<ExtensionCredential | null> {
  const connection = await deps.store.getExtensionConnection(id);
  return connection && visibleConnection(connection, actor) ? connection : null;
}

async function approveOrgMutation(
  deps: ConnectionLifecycleDeps,
  input: { tool: string; actor: string; spaceId?: string; connection: ExtensionCredential; expectedRevision: number },
): Promise<LifecycleOutcome | null> {
  if (input.connection.scope !== "org") return null;
  const outcome = await evaluatePolicyGate(
    {
      loadPolicy: deps.gate.loadPolicy,
      audit: deps.audit,
      router: deps.gate.router,
      timeoutMs: deps.gate.timeoutMs,
      preApproved: deps.gate.preApproved,
    },
    {
      tool: input.tool,
      args: { connection_id: input.connection.id, expected_revision: input.expectedRevision },
      spaceId: input.spaceId,
      actor: input.actor,
    },
  );
  return outcome.allowed ? null : { ok: false, message: outcome.blockReason };
}

/** Canonical authorization-filtered, redacted connection read model. */
export async function listConnectionReadModel(
  input: { actor: string },
  deps: Pick<ConnectionLifecycleDeps, "registry" | "store">,
): Promise<ConnectionReadModel[]> {
  return (await deps.store.listExtensionConnections())
    .filter((connection) => visibleConnection(connection, input.actor))
    .map((connection) => toConnectionReadModel(connection, deps.registry));
}

export async function listConnections(
  input: { actor: string; spaceId?: string },
  deps: ConnectionLifecycleDeps,
): Promise<LifecycleOutcome> {
  const rows = await listConnectionReadModel({ actor: input.actor }, deps);
  const lines = rows.map(connectionLine);
  await deps.audit.appendAudit({
    space_id: input.spaceId ?? null,
    actor: input.actor,
    event_type: EXTENSION_CONNECTION_READ_EVENT,
    payload: { action: "list", count: rows.length },
  });
  return { ok: true, message: lines.length === 0 ? "No visible extension connections." : lines.join("\n") };
}

export async function inspectConnection(
  input: { connectionId: string; actor: string; spaceId?: string },
  deps: ConnectionLifecycleDeps,
): Promise<LifecycleOutcome> {
  const connection = await authorizedConnection(deps, input.connectionId, input.actor);
  if (!connection) return { ok: false, message: `connection "${input.connectionId}" not found` };
  const model = toConnectionReadModel(connection, deps.registry);
  await deps.audit.appendAudit({
    space_id: input.spaceId ?? null,
    actor: input.actor,
    event_type: EXTENSION_CONNECTION_READ_EVENT,
    payload: { action: "inspect", connection_id: connection.id },
  });
  return { ok: true, message: connectionLine(model) };
}

function replacementCredential(
  connection: ExtensionCredential,
  vaultProvider: string,
  brokerCredentialId: number,
  identityKey: string,
): ExtensionCredential {
  return {
    ...connection,
    vault_provider: vaultProvider,
    identity_key: identityKey,
    broker_credential_id: brokerCredentialId,
    pending_vault_provider: null,
    pending_broker_credential_id: null,
    pending_identity_key: null,
    retiring_broker_credential_id: null,
    status: "replacing",
  };
}

async function finishReplacementCleanup(
  connection: ExtensionCredential,
  input: { actor: string; spaceId?: string },
  deps: ConnectionLifecycleDeps,
  authority: ConnectionAuthority,
): Promise<LifecycleOutcome> {
  const retiringId = connection.retiring_broker_credential_id;
  if (retiringId === null) {
    return { ok: false, message: `replace ${connection.id} is missing its retiring authority reference` };
  }
  const retiring = replacementCredential(
    connection,
    connection.vault_provider,
    retiringId,
    connection.identity_key,
  );
  try {
    await authority.revoke(retiring);
  } catch (err) {
    return {
      ok: false,
      message: `replace ${connection.id} switched but old authority cleanup failed; retry revision ${connection.revision}: ${errorMessage(err)}`,
    };
  }
  await appendLifecycleAudit(deps, { ...input, connection, phase: "old_authority_revoked" });
  const active = await deps.store.transitionExtensionConnection({
    id: connection.id,
    from: "replace_cleanup_pending",
    to: "active",
    clearRetiringAuthority: true,
  });
  await appendLifecycleAudit(deps, { ...input, connection: active, phase: "replacement_active" });
  return { ok: true, message: `${connection.id} replaced at revision ${active.revision}` };
}

export async function replaceConnection(
  input: {
    connectionId: string;
    expectedRevision: number;
    actor: string;
    spaceId?: string;
    replacementApiKey?: string;
  },
  deps: ConnectionLifecycleDeps,
): Promise<LifecycleOutcome> {
  let connection = await authorizedConnection(deps, input.connectionId, input.actor);
  if (!connection) return { ok: false, message: `connection "${input.connectionId}" not found` };
  if (connection.revision !== input.expectedRevision) {
    return {
      ok: false,
      message: `stale revision for connection "${connection.id}": expected ${input.expectedRevision}, current ${connection.revision}`,
    };
  }
  const denied = await approveOrgMutation(deps, {
    tool: REPLACE_CONNECTION_TOOL,
    actor: input.actor,
    spaceId: input.spaceId,
    connection,
    expectedRevision: input.expectedRevision,
  });
  if (denied) return denied;

  const authority = deps.authority ?? createConnectionAuthority();
  const boundary = deps.boundary ?? createSecretFileBoundary();
  if (connection.status === "replace_cleanup_pending") {
    return finishReplacementCleanup(connection, input, deps, authority);
  }
  if (connection.status === "disconnected") {
    return { ok: false, message: `${connection.id} is disconnected — connect it again instead of replacing it` };
  }
  if (connection.status !== "active" && connection.status !== "replacing") {
    return { ok: false, message: `${connection.id} cannot be replaced while status=${connection.status}` };
  }
  const manifest = deps.registry.resolve(connection.provider)?.manifest;
  if (!manifest) return { ok: false, message: `connection "${connection.id}" has an unknown provider binding` };

  if (connection.status === "active") {
    const replacementVaultProvider =
      manifest.credentialSchema.type === "api_key"
        ? `${connection.vault_provider}:r${connection.revision + 1}`
        : connection.vault_provider;
    const provisionTarget = { ...connection, vault_provider: replacementVaultProvider };
    let provisioned: { brokerCredentialId: number; identityKey: string };
    try {
      provisioned = await authority.provision({
        connection: provisionTarget,
        credentialType: manifest.credentialSchema.type,
        apiKey: input.replacementApiKey,
      });
    } catch (err) {
      const guidance =
        manifest.credentialSchema.type === "api_key" && input.replacementApiKey === undefined
          ? ` Use connect_upload_link extension=${connection.provider} scope=${connection.scope} connection_id=${connection.id} expected_revision=${connection.revision}.`
          : "";
      return { ok: false, message: `replace ${connection.id} failed before switching: ${errorMessage(err)}${guidance}` };
    }
    const stagedAuthority = replacementCredential(
      connection,
      replacementVaultProvider,
      provisioned.brokerCredentialId,
      provisioned.identityKey,
    );
    try {
      connection = await deps.store.beginExtensionConnectionReplacement({
        id: connection.id,
        vaultProvider: replacementVaultProvider,
        expectedRevision: input.expectedRevision,
        identityKey: provisioned.identityKey,
        brokerCredentialId: provisioned.brokerCredentialId,
      });
    } catch (err) {
      try {
        await authority.revoke(stagedAuthority);
      } catch (cleanupError) {
        return {
          ok: false,
          message: `replace ${connection.id} was rejected and staged authority cleanup failed: ${errorMessage(err)}; ${errorMessage(cleanupError)}`,
        };
      }
      return { ok: false, message: errorMessage(err) };
    }
    await appendLifecycleAudit(deps, { ...input, connection, phase: "runtime_denied" });
  }

  const pendingVaultProvider = connection.pending_vault_provider;
  const pendingId = connection.pending_broker_credential_id;
  const pendingIdentity = connection.pending_identity_key;
  if (pendingVaultProvider === null || pendingId === null || pendingIdentity === null) {
    return { ok: false, message: `replace ${connection.id} is missing its staged authority reference` };
  }
  const replacement = replacementCredential(connection, pendingVaultProvider, pendingId, pendingIdentity);
  let prepared: CredentialReplacementPreparation;
  try {
    prepared = await boundary.prepareReplacement(connection, replacement);
    await prepared.activate();
  } catch (err) {
    try {
      await authority.revoke(replacement);
      await deps.store.rollbackExtensionConnectionReplacement(connection.id, input.expectedRevision);
    } catch (cleanupError) {
      return {
        ok: false,
        message: `replace ${connection.id} failed and staged authority cleanup also failed; retry revision ${connection.revision}: ${errorMessage(
          err,
        )}; ${errorMessage(cleanupError)}`,
      };
    }
    return { ok: false, message: `replace ${connection.id} rolled back: ${errorMessage(err)}` };
  }
  await appendLifecycleAudit(deps, { ...input, connection, phase: "boundary_ready" });

  let switched: ExtensionCredential;
  try {
    switched = await deps.store.commitExtensionConnectionReplacement(connection.id, input.expectedRevision);
  } catch (err) {
    try {
      await prepared.rollback();
    } catch (rollbackError) {
      return {
        ok: false,
        message: `replace ${connection.id} could not commit and boundary rollback failed: ${errorMessage(err)}; ${errorMessage(rollbackError)}`,
      };
    }
    return { ok: false, message: `replace ${connection.id} could not commit: ${errorMessage(err)}` };
  }
  await appendLifecycleAudit(deps, { ...input, connection: switched, phase: "authority_switched" });
  return finishReplacementCleanup(switched, input, deps, authority);
}

export async function disconnectConnection(
  input: { connectionId: string; expectedRevision: number; actor: string; spaceId?: string },
  deps: ConnectionLifecycleDeps,
): Promise<LifecycleOutcome> {
  let connection = await authorizedConnection(deps, input.connectionId, input.actor);
  if (!connection) return { ok: false, message: `connection "${input.connectionId}" not found` };
  if (connection.revision !== input.expectedRevision) {
    return {
      ok: false,
      message: `stale revision for connection "${connection.id}": expected ${input.expectedRevision}, current ${connection.revision}`,
    };
  }
  const denied = await approveOrgMutation(deps, {
    tool: DISCONNECT_CONNECTION_TOOL,
    actor: input.actor,
    spaceId: input.spaceId,
    connection,
    expectedRevision: input.expectedRevision,
  });
  if (denied) return denied;
  if (connection.status === "disconnected") {
    return { ok: true, message: `${connection.id} is already disconnected at revision ${connection.revision}` };
  }
  if (connection.status === "active") {
    try {
      connection = await deps.store.beginExtensionConnectionDisconnect(connection.id, input.expectedRevision);
    } catch (err) {
      return { ok: false, message: errorMessage(err) };
    }
    await appendLifecycleAudit(deps, { ...input, connection, phase: "runtime_denied" });
  }
  if (connection.status !== "disconnecting_boundary" && connection.status !== "disconnecting_authority") {
    return { ok: false, message: `${connection.id} cannot disconnect while status=${connection.status}` };
  }

  const boundary = deps.boundary ?? createSecretFileBoundary();
  if (connection.status === "disconnecting_boundary") {
    try {
      await boundary.disconnect(connection);
    } catch (err) {
      return {
        ok: false,
        message: `disconnect ${connection.id} denied runtime use but boundary cleanup failed; retry revision ${connection.revision}: ${errorMessage(err)}`,
      };
    }
    await appendLifecycleAudit(deps, { ...input, connection, phase: "boundary_cleared" });
    connection = await deps.store.transitionExtensionConnection({
      id: connection.id,
      from: "disconnecting_boundary",
      to: "disconnecting_authority",
    });
  }

  const authority = deps.authority ?? createConnectionAuthority();
  try {
    await authority.revoke(connection);
  } catch (err) {
    return {
      ok: false,
      message: `disconnect ${connection.id} remains denied; authority revoke failed, retry revision ${connection.revision}: ${errorMessage(err)}`,
    };
  }
  await appendLifecycleAudit(deps, { ...input, connection, phase: "authority_revoked" });
  const disconnected = await deps.store.transitionExtensionConnection({
    id: connection.id,
    from: "disconnecting_authority",
    to: "disconnected",
  });
  await appendLifecycleAudit(deps, { ...input, connection: disconnected, phase: "disconnected" });
  return { ok: true, message: `${connection.id} disconnected at revision ${disconnected.revision}` };
}

/** The four canonical lifecycle tools used by real sessions. */
export function connectionLifecycleToolDefinitions(deps: ConnectionLifecycleToolDeps): ToolDefinition[] {
  const actor = () => deps.getPrincipal?.() ?? deps.defaultActor ?? "agent";
  const spaceId = (ctx: { sessionManager: { getSessionFile(): string | null | undefined } }) =>
    deps.spaceIdFromFile?.(ctx.sessionManager.getSessionFile());
  const list: ToolDefinition<typeof EMPTY_PARAMS> = {
    name: LIST_CONNECTIONS_TOOL,
    label: "List connections",
    description: "Lists the caller-visible extension connections. Returns metadata only; never credentials or tokens.",
    parameters: EMPTY_PARAMS,
    approval: "read",
    async execute(_id, _params, _signal, _update, ctx) {
      const outcome = await listConnections({ actor: actor(), spaceId: spaceId(ctx) }, deps);
      return { content: [{ type: "text", text: outcome.message }] };
    },
  };
  const inspect: ToolDefinition<typeof TARGET_PARAMS> = {
    name: INSPECT_CONNECTION_TOOL,
    label: "Inspect connection",
    description: "Inspects one caller-visible stable connection id. Returns redacted metadata only.",
    parameters: TARGET_PARAMS,
    approval: "read",
    async execute(_id, params, _signal, _update, ctx) {
      const outcome = await inspectConnection(
        { connectionId: params.connection_id, actor: actor(), spaceId: spaceId(ctx) },
        deps,
      );
      return outcome.ok ? { content: [{ type: "text", text: outcome.message }] } : toolError(outcome.message);
    },
  };
  const replace: ToolDefinition<typeof MUTATION_PARAMS> = {
    name: REPLACE_CONNECTION_TOOL,
    label: "Replace connection",
    description: "Replaces exactly one stable connection using expected-revision compare-and-swap. Organization changes require approval.",
    parameters: MUTATION_PARAMS,
    approval: "exec",
    async execute(_id, params, _signal, _update, ctx) {
      const outcome = await replaceConnection(
        {
          connectionId: params.connection_id,
          expectedRevision: params.expected_revision,
          actor: actor(),
          spaceId: spaceId(ctx),
        },
        deps,
      );
      return outcome.ok ? { content: [{ type: "text", text: outcome.message }] } : toolError(outcome.message);
    },
  };
  const disconnect: ToolDefinition<typeof MUTATION_PARAMS> = {
    name: DISCONNECT_CONNECTION_TOOL,
    label: "Disconnect connection",
    description: "Immediately denies and durably disconnects exactly one stable connection. Safe to retry after partial failure.",
    parameters: MUTATION_PARAMS,
    approval: "exec",
    async execute(_id, params, _signal, _update, ctx) {
      const outcome = await disconnectConnection(
        {
          connectionId: params.connection_id,
          expectedRevision: params.expected_revision,
          actor: actor(),
          spaceId: spaceId(ctx),
        },
        deps,
      );
      return outcome.ok ? { content: [{ type: "text", text: outcome.message }] } : toolError(outcome.message);
    },
  };
  return [list, inspect, replace, disconnect];
}
