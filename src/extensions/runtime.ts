/**
 * Extension tool runtime (issue #53): executes a manifest tool call through
 * the safety spine — POLICY GATE first, then the credential ladder, then
 * the provider's official MCP server (or preinstalled CLI), with every call
 * audited as `extension.call`.
 *
 * Sequence per call (fail closed at every step):
 *   1. resolve the manifest + effective tool surface (pinned manifest tools,
 *      or the provider's tools/list discovered surface for tools-less
 *      manifests — issue #158; an unreachable provider is a clear error
 *      result, never a silent empty toolset; unknown → error audit, no
 *      execution);
 *   2. POLICY GATE (`evaluatePolicyGate`, shared with the in-process policy
 *      extension and out-of-process surfaces): denied calls never resolve a
 *      credential. The call carries the extensionId so the extension
 *      allowlist (issue #56) decides BEFORE tier/approval; the gate's
 *      `toolTier` seam resolves the manifest tier so an allowed extension
 *      crosses the tier stage as a known tool;
 *   3. credential ladder (`resolveCredential`, issue #51): org / me / auto
 *      scopes over the store's registry rows, audit
 *      `extension.credential_resolved` on success;
 *   4. credential boundary (`CredentialBoundary`, issue #53): the resolved
 *      credential is injected at the egress proxy (secret file + reload);
 *      the provider call carries NO credential — iron-proxy attaches the
 *      Authorization header for the extension's allowlisted domains. The
 *      credential never enters the agent env, transcripts, or audit.
 *      Exception (issue #198): hosted OAuth MCPs carry auth IN the
 *      transport — the MCP SDK's OAuth client (vault-backed tokens,
 *      refresh on 401) — and the boundary's file holds the same current
 *      access token for the proxy's inject;
 *   5. provider call: kind "mcp" → the provider's OFFICIAL MCP server via
 *      the MCP SDK client (streamable-http or stdio per the manifest
 *      binding, streamable-http with the OAuth provider when the
 *      credential is OAuth); kind "cli" → the preinstalled CLI with a
 *      credential-safe env (issue #58). One client/process per call;
 *   6. audit `extension.call` {extension, tool, actor, credential_id,
 *      decision} — written for EVERY call, including denied and failed
 *      ones (credential_id null unless the ladder resolved).
 *
 * The egress path: outbound calls ride the environment's HTTP(S)_PROXY
 * (compose points them at iron-proxy's tunnel, src/egress) and NO_PROXY
 * keeps internal names (localhost, data, auth-broker, mem0) direct — the
 * proxy env passthrough is Bun-native (proven in src/egress/proxy-env.test.ts).
 */
import { isIP } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolResultSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { AgentToolResult } from "@oh-my-pi/pi-coding-agent";
import type { AuditModule } from "../policy/audit";
import { redact } from "../policy/audit";
import type { ApprovalRouter } from "../policy/approval-router";
import { loadSpacePolicy, orgCredentialsAllowed, resolveTier, type PolicyConfig } from "../policy/config";
import { evaluatePolicyGate, summarizeArgs, type PolicyGateCall } from "../policy/gate";
import type { ExtensionCredential, Store } from "../store/db";
import { EXTENSION_CALL_EVENT } from "../store/audit-events";
import { errorMessage } from "../tools/helpers";
import {
  CREDENTIAL_ENV_RE,
  type CliBinding,
  type ExtensionTool,
  type ExtensionToolParam,
  type JsonObject,
  type JsonValue,
  type McpBinding,
} from "./manifest";
import type { ExtensionRegistry } from "./registry";
import { recordCredentialResolution, resolveCredential, type CallScope } from "./credentials";
import {
  createSecretFileBoundary,
  type AuthorizationContext,
  type CredentialBoundary,
} from "./boundary";
import { extensionToolSurface, type ExtensionSurfaces } from "./surface";
import { callOpenApiTool, type OpenApiEgressSeam } from "./openapi-executor";
import { humanizeToolName } from "../server/adapters/approval-router";

/**
 * Default OpenAPI egress seam (issue #345): no credential provisioner is
 * wired for openapi extensions yet, so it fails closed — the executor
 * refuses to send before any request leaves the process. A real inject
 * provisioner (the static model-gateway inject config supporting arbitrary
 * headers) is the documented residual; the seam is injected by deployments
 * via `ExtensionRuntimeDeps.openapiEgress`.
 */
export const FAIL_CLOSED_OPENAPI_EGRESS: OpenApiEgressSeam = {
  injectForHost: () => undefined,
  fetchWire: async () => {
    throw new Error("openapi egress is not provisioned — refuse to send");
  },
};
import {
  emitToolStep,
  nextToolStepId,
  toolStepTitle,
  type ToolStepSink,
} from "../server/services/slack-turn-presenter";

export type ExtensionCallDecision = "allow" | "deny" | "error";

export interface ExtensionRuntimeCall {
  /** Registry id of the extension (the manifest id / credential provider). */
  extensionId: string;
  /**
   * A tool declared by the extension's manifest — the manifest name OR the
   * provider's wire name (issue #148: the bridge forwards providerName ??
   * name). Resolved against both, and the manifest identity always drives
   * the gate/audit/tier surface.
   */
  toolName: string;
  /** Tool arguments as JSON (the agent's raw call args). */
  args: JsonObject;
  /** Actor recorded on audit rows and used for personal-scope ladder lookups. */
  caller: string;
  spaceId?: string;
}

export type ExtensionRuntimeResult =
  | { ok: true; content: AgentToolResult["content"] }
  | { ok: false; error: string };

export interface ExtensionRuntime {
  execute(call: ExtensionRuntimeCall): Promise<ExtensionRuntimeResult>;
}

export interface ExtensionRuntimeDeps {
  registry: ExtensionRegistry;
  /** Registry rows for the ladder + the credential-resolution audit row (#51). */
  store: Pick<Store, "listExtensionCredentials" | "getSpace" | "appendAudit">;
  audit: AuditModule;
  /** Org floor policy; the space overlay is applied per call. */
  orgPolicy: PolicyConfig;
  /** Ask-human routing for the policy gate. */
  router: ApprovalRouter;
  /** Gate ask-human timeout in ms; defaults to the policy's approvals.timeout_minutes. */
  timeoutMs?: number;
  /** Ladder scope for every call; defaults to "auto" (org when the policy allows, else personal, else ask). */
  callScope?: CallScope;
  /**
   * Egress boundary (issue #53): injects the resolved credential at the
   * proxy. Defaults to the secret-file boundary ({@link createSecretFileBoundary});
   * the broker secret resolver is issue #54's wiring, so the default fails
   * closed until then.
   */
  boundary?: CredentialBoundary;
  /**
   * OpenAPI egress seam (issue #345): injects the static credential for a
   * pinned openapi extension's host at egress (model-gateway inject mode) —
   * the executor sends NO auth header. Defaults to a fail-closed seam that
   * refuses to send until a real inject provisioner is wired (test seam
   * injects a fake proxy asserting the header).
   */
  openapiEgress?: OpenApiEgressSeam;
  /**
   * MCP transport factory (test seam): tests inject in-memory transports so
   * tool execution is exercised hermetically. Defaults to the real
   * streamable-http / stdio transports. The optional second argument is the
   * OAuth client provider (issue #198): hosted OAuth MCPs (credential type
   * "oauth") attach it to the streamable-http transport so the MCP SDK's
   * OAuth client drives discovery/refresh with the vault-backed tokens.
   */
  mcpTransport?: (
    binding: McpBinding,
    authProvider?: OAuthClientProvider,
    authorization?: AuthorizationContext,
  ) => Transport;
  /**
   * Pre-resolved effective tool surfaces (issue #158): extensionId →
   * pinned manifest tools or the discovered tools/list surface, resolved
   * once at boot by resolveExtensionSurfaces (src/extensions/surface.ts).
   * Absent → the runtime discovers tools-less manifests lazily on first
   * call through the transport seam, fail-closed (an unreachable provider
   * is a clear error result, never a silent empty toolset).
   */
  surfaces?: ExtensionSurfaces;
  /**
   * Thinking-step sink (issue #168): every gated extension tool call emits
   * one task_update — in_progress "tool — allowed (tier)" on start (or
   * "waiting for approval" while the approval router waits), complete on
   * resolution, a terminal denied card on denial. Titles and the args
   * code-card pass the same redaction as audit payloads. Headless callers
   * omit it.
   */
  onToolStep?: ToolStepSink;
}

export function createExtensionRuntime(deps: ExtensionRuntimeDeps): ExtensionRuntime {
  const makeTransport = deps.mcpTransport ?? defaultMcpTransport;
  const boundary = deps.boundary ?? createSecretFileBoundary();
  const knownExtensionIds = deps.registry.list().map((entry) => entry.manifest.id);

  const loadPolicy = (spaceId: string | undefined) => loadSpacePolicy(deps.orgPolicy, deps.store, spaceId);

  /** Audit row for every call; credential_id is null unless the ladder resolved one. */
  const auditCall = async (input: {
    extensionId: string;
    toolName: string;
    actor: string;
    spaceId?: string;
    credentialId: string | null;
    decision: ExtensionCallDecision;
    callId?: string;
  }): Promise<number | null> => {
    try {
      return await deps.audit.appendAudit({
        space_id: input.spaceId ?? null,
        actor: input.actor,
        event_type: EXTENSION_CALL_EVENT,
        payload: {
          extension: input.extensionId,
          tool: input.toolName,
          actor: input.actor,
          credential_id: input.credentialId,
          decision: input.decision,
          call_id: input.callId ?? null,
        },
      });
    } catch (err) {
      // Issue #205: the audit write must never turn a handled tool error
      // into a REJECTION (an unhandled rejection exits the process with
      // code 1). The audit is evidence, not the call's fate — log and
      // continue so the caller still gets its error result.
      console.error(
        `[extensions] audit write failed for ${input.extensionId}.${input.toolName}: ${errorMessage(err)}`,
      );
      return null;
    }
  };

  return {
    async execute(call) {
      const { extensionId, toolName, args, caller, spaceId } = call;
      const resolved = deps.registry.resolve(extensionId);
      const manifest = resolved?.manifest;
      if (!manifest) {
        await auditCall({ extensionId, toolName, actor: caller, spaceId, credentialId: null, decision: "error" });
        return { ok: false, error: `extension "${extensionId}" is not registered` };
      }

      // Issue #158: the effective tool surface — pinned manifest tools when
      // present (the reviewed path wins, no discovery), else the discovered
      // tools/list surface (pre-resolved at boot, or lazily through the
      // transport seam). Fail closed: an unreachable provider or an invalid
      // tools/list is a clear error result — never a silent empty toolset.
      const preResolved = deps.surfaces?.get(manifest.id);
      let surface: readonly ExtensionTool[];
      if (preResolved !== undefined) {
        surface = preResolved;
      } else {
        try {
          surface = await extensionToolSurface(manifest, makeTransport);
        } catch (err) {
          await auditCall({ extensionId, toolName, actor: caller, spaceId, credentialId: null, decision: "error" });
          return {
            ok: false,
            error: `extension "${extensionId}" tool surface unavailable: ${errorMessage(err)}`,
          };
        }
      }

      // Issue #148: the bridge forwards the provider's wire name
      // (providerName ?? name). Resolve the tool by either the manifest
      // name (direct callers, the MCP surface) or the wire name — the
      // manifest identity then drives the gate/audit/tier, and the
      // provider call uses the wire name below.
      const tool =
        surface.find(
          (entry) => entry.name === toolName || (entry.providerName !== undefined && entry.providerName === toolName),
        ) ?? surface.find((entry) => entry.name === toolName);
      if (!tool) {
        await auditCall({ extensionId, toolName, actor: caller, spaceId, credentialId: null, decision: "error" });
        return {
          ok: false,
          error: `tool "${toolName}" is not declared by extension "${extensionId}"`,
        };
      }

      // 1. POLICY GATE FIRST — a denied call never resolves a credential.
      // The extensionId rides the gate call so the extension allowlist
      // (issue #56) decides before tier/approval; the gate's toolTier seam
      // resolves the effective tier (pinned or discovered, issue #158) so
      // an allowed extension crosses the tier stage as a known tool (issue
      // #53). The gate sees the MANIFEST name — policies are written
      // against bottega's surface, not the provider's wire names (#148).
      const gateCall: PolicyGateCall & { extensionId?: string } = {
        tool: tool.name,
        args,
        spaceId,
        actor: caller,
        extensionId,
      };
      const sink = deps.onToolStep;
      const tier = tool.tier ?? resolveTier(tool.name);
      const stepArgs = sink !== undefined ? redact(summarizeArgs(args)) : undefined;
      const taskId = nextToolStepId();
      // #295: the human-readable footer label for the tool NAME, derived at
      // the source (no internal tool identifiers reach Slack).
      const label = humanizeToolName(tool.name);
      const outcome = await evaluatePolicyGate(
        {
          loadPolicy,
          audit: deps.audit,
          router: deps.router,
          timeoutMs: deps.timeoutMs,
          knownExtensionIds,
          // Per-call closure over THIS extension's resolved surface (the
          // gate consults it only for calls carrying this extensionId).
          toolTier: (name) =>
            surface.find((entry) => entry.name === name || entry.providerName === name)?.tier,
          // Issue #168: render "waiting for approval" while the router
          // waits — the resolution (approved/denied) shares this taskId.
          onAskHuman:
            sink !== undefined
              ? () => {
                  emitToolStep(sink, {
                    spaceId,
                    taskId,
                    label,
                    title: toolStepTitle(tool.name, "waiting for approval"),
                    progressState: "waiting",
                    progressDetail: "Waiting for approval",
                    sourceLabel: manifest.label,
                    status: "in_progress",
                    output: stepArgs,
                  });
                }
              : undefined,
        },
        gateCall,
      );
      if (!outcome.allowed) {
        await auditCall({ extensionId, toolName: tool.name, actor: caller, spaceId, credentialId: null, decision: "deny" });
        // Terminal deny card: a waiting-for-approval card (ask-human) is
        // resolved here; a straight deny renders one deny step.
        emitToolStep(sink, {
          spaceId,
          taskId,
          label,
          title: toolStepTitle(tool.name, `denied (${tier})`),
          sourceLabel: manifest.label,
          status: "complete",
          outcome: "denied",
          output: stepArgs,
        });
        return { ok: false, error: outcome.blockReason };
      }
      emitToolStep(sink, {
        spaceId,
        taskId,
        label,
        title: toolStepTitle(tool.name, outcome.decision === "ask-human" ? "approved" : `allowed (${tier})`),
        progressState: "working",
        progressDetail: label,
        sourceLabel: manifest.label,
        status: "in_progress",
        output: stepArgs,
      });

      // 2. Credential ladder over the store's registry rows. Personal
      // lookups are filtered to the caller — the ladder never sees other
      // people's rows.
      const policy = await loadPolicy(spaceId);
      const rows = await deps.store.listExtensionCredentials(manifest.id);
      const findCredential = (scope: "org" | "personal", owner: string | null): ExtensionCredential | null => {
        if (scope === "org") return rows.find((row) => row.scope === "org" && row.owner === null) ?? null;
        return rows.find((row) => row.scope === "personal" && row.owner === owner) ?? null;
      };
      const resolution = resolveCredential({
        callScope: deps.callScope ?? "auto",
        caller,
        provider: manifest.id,
        spacePolicy: { orgUsageAllowed: orgCredentialsAllowed(policy) },
        findCredential,
      });
      if (resolution.kind !== "credential") {
        // "ask" is a blocking signal too: the runtime never guesses an account.
        await auditCall({ extensionId, toolName, actor: caller, spaceId, credentialId: null, decision: "error" });
        // The card documents the attempt: check it off so the thinking
        // panel never shows a stuck spinner (the error rides the reply).
        // The tool never ran — this is a FAILED outcome, never success.
        emitToolStep(sink, {
          spaceId,
          taskId,
          label,
          title: toolStepTitle(tool.name, `allowed (${tier})`),
          sourceLabel: manifest.label,
          status: "complete",
          outcome: "failed",
          output: stepArgs,
        });
        return { ok: false, error: resolution.kind === "ask" ? resolution.reason : resolution.message };
      }
      const credential = resolution.credential;
      const callId = `${extensionId}:${taskId}`;
      await recordCredentialResolution(deps.store, { actor: caller, spaceId, credential });
      await auditCall({
        extensionId,
        toolName: tool.name,
        actor: caller,
        spaceId,
        credentialId: credential.id,
        decision: "allow",
        callId,
      });

      // 3. Request-scoped boundary + provider call. The transport receives
      // only a random proxy placeholder. iron-proxy replaces it with this
      // caller's selected credential while the reviewed target and call
      // authority are active, then the boundary revokes it in finally.
      const wireName = tool.providerName ?? tool.name;
      try {
        return await boundary.runWithAuthorization(
          {
            credential,
            targets: manifest.credentialTargets,
            callId,
            timeoutMs: deps.timeoutMs,
          },
          async (authorization) => {
            // Issue #248: restore structured arguments before the wire call.
            const providerArgs = manifest.kind === "mcp" ? restoreNativeJsonArgs(args, tool.params) : args;
            const result =
              manifest.kind === "mcp"
                ? await callMcpTool(
                    makeTransport,
                    manifest.mcp,
                    wireName,
                    providerArgs,
                    authorization,
                  )
                : manifest.kind === "openapi"
                  ? await callOpenApiTool(manifest, tool, args, {
                      egress: deps.openapiEgress ?? FAIL_CLOSED_OPENAPI_EGRESS,
                    })
                  : await callCliTool(manifest.cli, wireName, args, authorization);
            emitToolStep(sink, {
              spaceId,
              taskId,
              label,
              title: toolStepTitle(tool.name, `allowed (${tier})`),
              sourceLabel: manifest.label,
              status: "complete",
              outcome: result.ok ? "succeeded" : "failed",
              output: stepArgs,
            });
            return result;
          },
        );
      } catch (err) {
        // A human-confirmed write that then FAILED (issue #277): posted
        // back into the thread and remembered per (space, tool) — bounded —
        // via the router's optional failure seam, so a later approval card
        // for the same tool surfaces 'last confirmed write failed'. Only
        // ask-human approvals are "confirmed writes"; the decision is
        // unchanged and the failure still surfaces as a tool error.
        if (outcome.decision === "ask-human") {
          deps.router.recordConfirmedWriteFailure?.(spaceId ?? "", tool.name, errorMessage(err));
        }
        emitToolStep(sink, {
          spaceId,
          taskId,
          label,
          title: toolStepTitle(tool.name, `allowed (${tier})`),
          sourceLabel: manifest.label,
          status: "complete",
          outcome: "failed",
          output: stepArgs,
        });
        return { ok: false, error: `extension tool "${tool.name}" failed: ${errorMessage(err)}` };
      }
    },
  };
}

/**
 * Throws when `host` is a loopback / link-local / private-network /
 * CGNAT / cloud-metadata (or otherwise non-public) destination that the
 * SERVER must never reach with a model-controlled MCP transport (issue
 * #338). Public, fully-qualified hostnames pass — reachability and
 * credential routing stay the iron-proxy egress policy's job, not this
 * guard's (no egress-policy duplication). DNS names that cannot be public
 * internet (single-label `localhost`, bare internal labels, or reserved
 * internal TLDs) and IP literals in a private/loopback/link-local/reserved
 * range are rejected fail-closed before a transport could be created.
 *
 * A PUBLIC DNS name whose resolution happens to point at a private address
 * is not re-checked here: the extension's PINNED endpoint + the iron-proxy
 * egress allowlist (the configured domains) are the boundary that keeps a
 * resolved private/loopback destination unreachable. This guard rejects
 * literals and structurally-internal names only; it deliberately does not
 * duplicate the resolver's DNS lookup or the egress policy's allowlist.
 */
export function assertPublicMcpEndpointHost(host: string): void {
  if (host === "") {
    throw new Error("MCP serverUrl has no host — refusing a Unix-socket / empty-authority http endpoint");
  }
  // URL.hostname brackets a literal IPv6 (`[::1]`); strip them so the
  // literal is tested by the IP branch, not misrouted to the DNS-name
  // branch (a single `[::1]` label would otherwise be a false single-label
  // denial, and a public IPv6 like `[2606:4700::6810:84e5]` would be
  // wrongly rejected instead of passing through to the IP branch).
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (isIP(bare) !== 0) {
    if (isBlockedIpLiteral(bare)) {
      throw new Error(`MCP serverUrl host "${host}" is a loopback/link-local/private/reserved address — refused server-side`);
    }
    return;
  }
  const normalized = bare.toLowerCase();
  // DNS name: reject anything that cannot be public internet.
  const labels = normalized.split(".");
  if (labels.length < 2) {
    throw new Error(`MCP serverUrl host "${host}" is a bare internal/single-label name — refused server-side`);
  }
  if (labels.some((label) => label === "")) {
    throw new Error(`MCP serverUrl host "${host}" has an empty DNS label — refused server-side`);
  }
  const tld = labels[labels.length - 1]!;
  if (INTERNAL_HOST_SLICE[tld] === true || RESERVED_INTERNAL_TLDS[tld] === true || normalized === "localhost") {
    throw new Error(`MCP serverUrl host "${host}" is an internal/reserved destination — refused server-side`);
  }
}

/** IP literals whose leading octets are a private, loopback, or link-local range. */
function isBlockedIpLiteral(ip: string): boolean {
  if (isIP(ip) === 4) {
    if (ip === "0.0.0.0") return true;
    const octets = ip.split(".").map((octet) => Number.parseInt(octet, 10));
    const a = octets[0];
    const b = octets[1];
    if (a === undefined || b === undefined) return true;
    if (a === 10) return true; // 10/8  private
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT (RFC 6598)
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12 private
    if (a === 192 && b === 168) return true; // 192.168/16 private
    if (a === 127) return true; // loopback
    if (a === 169 && b === 254) return true; // link-local + cloud-metadata (169.254.169.254)
    if (a >= 224) return true; // multicast + reserved
    return false;
  }
  // IPv6: collapse and test leading hextets.
  const lower = ip.toLowerCase();
  // ::1 (loopback), :: (unspecified), ff00::/8 (multicast).
  if (lower === "::1" || lower === "::") return true;
  if (lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb")) return true; // fe80::/10 link-local
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // fc00::/7 unique-local
  if (lower.startsWith("ff")) return true; // ff00::/8 multicast
  // IPv4-mapped (::ffff:a.b.c.d) — recurse on the tail.
  const v4mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (v4mapped !== null) return isBlockedIpLiteral(v4mapped[1]!);
  return false;
}

/** Reserved internal TLDs that can never be public internet. */
const RESERVED_INTERNAL_TLDS: Record<string, true> = Object.fromEntries(
  ["local", "internal", "home", "localhost", "lan", "intranet", "arpa"].map((suffix) => [suffix, true]),
);

/**
 * Leading labels that always denote an internal machine (never a public
 * internet hostname the model may reach).
 */
const INTERNAL_HOST_SLICE: Record<string, true> = Object.fromEntries(
  ["metadata", "localhost"].map((slice) => [slice, true]),
);

/**
 * The production MCP transport for a binding (issue #53): remote
 * streamable-http for official servers; stdio for preinstalled servers.
 * Shared by the runtime's call path and the manifest tool generator's
 * tools/list discovery (issue #157); tests inject in-memory transports
 * instead.
 *
 * Issue #338 boundary: the SERVER only ever creates a remote Streamable
 * HTTP transport to a PUBLIC host. stdio/local-command MCP and
 * loopback/private/link-local/metadata/Unix-socket endpoints are refused
 * before a transport object exists — they belong to the work-item Docker
 * sandbox, not the server process. Validation runs before transport
 * creation so an unsafe binding can never reach the MCP SDK.
 *
 * For streamable-http bindings whose credential is an OAuth token (issue
 * #198), the optional `authProvider` attaches the MCP SDK's OAuth client:
 * it sends the vault-backed access token, refreshes on 401, and fails
 * closed with a re-auth prompt when no interactive flow is possible. API
 * keys stay at the iron-proxy boundary (no authProvider — the proxy
 * injects the Authorization header for the extension's allowlisted
 * domains, issue #53).
 */
export function defaultMcpTransport(
  binding: McpBinding,
  authProvider?: OAuthClientProvider,
  authorization?: AuthorizationContext,
): Transport {
  // stdio / local-command MCP belongs in the one-job Docker sandbox, never
  // the server process (issue #338): the model must not reach a local
  // process or the host filesystem through MCP. Fail closed before any
  // StdioClientTransport is created.
  if (binding.transport !== "streamable-http") {
    throw new Error(
      "MCP stdio/local-command bindings are refused in the server process (issue #338) — " +
        "stdio MCP belongs in a one-job Docker sandbox; server-side MCP is remote Streamable HTTP only",
    );
  }
  let serverUrl: URL;
  try {
    serverUrl = new URL(binding.serverUrl);
  } catch {
    throw new Error(`MCP serverUrl is not a valid URL: ${binding.serverUrl}`);
  }
  if (serverUrl.protocol !== "http:" && serverUrl.protocol !== "https:") {
    throw new Error(`MCP serverUrl must be an http(s) URL (got "${serverUrl.protocol}")`);
  }
  // Reject loopback/link-local/private/metadata/Unix-socket destinations
  // BEFORE a StreamableHTTPClientTransport is constructed.
  assertPublicMcpEndpointHost(serverUrl.hostname);
  const headers =
    authorization === undefined
      ? undefined
      : { Authorization: `Bearer ${authorization.placeholder}` };
  return new StreamableHTTPClientTransport(serverUrl, {
    ...(authProvider !== undefined ? { authProvider } : undefined),
    ...(headers !== undefined ? { requestInit: { headers } } : undefined),
    ...(authorization !== undefined
      ? {
          fetch: (input, init) =>
            fetch(input, { ...init, signal: authorization.signal }),
        }
      : undefined),
  });
}

/**
 * Restores NATIVE array/object args for manifest params that declare
 * `jsonType` (issue #248): the provider's inputSchema demands a real
 * array/object (e.g. github-mcp-server's `fields` on its search and list
 * tools), but the model-facing surface types such params as `string` — the agent
 * supplies a JSON literal. Only params declared with jsonType (generated
 * from the provider's schema at discovery, or hand-authored on a pinned
 * manifest) are re-parsed, so a genuinely-string param whose value only
 * LOOKS like JSON is never touched. Values that already arrived as an
 * array/object pass through; a string that fails to parse stays a string
 * (the provider rejects it with its own clearer error).
 */
/** True when the model supplied the json-typed param as a string literal. */
function isJsonString(value: JsonValue | undefined): value is string {
  // String(x) returns x itself exactly for string primitives.
  return String(value) === value;
}

function restoreNativeJsonArgs(args: JsonObject, params: readonly ExtensionToolParam[]): JsonObject {
  const restored: JsonObject = { ...args };
  for (const param of params) {
    if (param.jsonType === undefined) continue;
    const value = args[param.name];
    if (!isJsonString(value)) continue; // already-native / absent — pass through
    try {
      restored[param.name] = JSON.parse(value);
    } catch {
      // Not a JSON literal — leave the raw string for the provider to reject.
    }
  }
  return restored;
}

/**
 * Calls the provider's official MCP server (one client per call; the
 * provider owns its connection lifecycle). Text content blocks pass
 * through; other content types are stringified so the result always fits
 * the agent tool result shape.
 */
async function callMcpTool(
  makeTransport: (
    binding: McpBinding,
    authProvider?: OAuthClientProvider,
    authorization?: AuthorizationContext,
  ) => Transport,
  binding: McpBinding,
  toolName: string,
  params: JsonObject,
  authorization: AuthorizationContext,
): Promise<ExtensionRuntimeResult> {
  const client = new Client({ name: "bottega-extensions", version: "1.0.0" });
  try {
    await client.connect(makeTransport(binding, undefined, authorization));
    // The SDK's declared return is a union with an experimental task-based
    // branch; passing CallToolResultSchema pins the runtime shape, so the
    // cast is the documented contract (guarded below).
    // SAFETY: CallToolResultSchema.parse pins the SDK's callTool return to
    // the plain call-result shape; the guard below rejects the task branch.
    const result = (await client.callTool({ name: toolName, arguments: params }, CallToolResultSchema)) as CallToolResult;
    // Task-based (experimental) results carry toolResult, not content; the
    // runtime only forwards plain call results.
    if (!("content" in result)) {
      throw new Error(`MCP server returned a task-based result for "${toolName}" (not supported)`);
    }
    // The provider's isError flag must surface as a FAILURE, not a success:
    // a server-side validation/execution error delivered as content (e.g.
    // GitHub's "parameter labels could not be coerced") is a tool error —
    // masking it as a success made the agent retry the write "blind" and
    // amplified the duplicate-execution confusion of issue #178.
    if (result.isError === true) {
      const text = result.content
        .filter((block): block is { type: "text"; text: string } => block.type === "text")
        .map((block) => block.text)
        .join("\n")
        .trim();
      return { ok: false, error: text || `MCP server reported an error for "${toolName}"` };
    }
    return {
      ok: true,
      content: result.content.map((block) =>
        block.type === "text"
          ? { type: "text" as const, text: block.text }
          : { type: "text" as const, text: JSON.stringify(block) },
      ),
    };
  } finally {
    await client.close();
  }
}

/**
 * Shells out to the preinstalled CLI (tools image). Fixed args from the
 * manifest come first, then the call's params as `--name value` flags
 * (`--name` alone for boolean true). Exit code 0 -> stdout as the result;
 * any other exit -> a tool error with stderr.
 *
 * Credential boundary (issue #58): the child env is the parent env minus
 * credential-named variables, plus the manifest's (validated
 * credential-free) `env` delta — CLIs never receive credentials via env.
 * Auth happens at the iron-proxy boundary: HTTPS_PROXY points at iron-proxy
 * (egress allowlist, src/egress), which injects the credential for the
 * allowlisted domain per request. Bun's `env` option REPLACES the
 * environment, so the merge must carry PATH and friends explicitly.
 */
async function callCliTool(
  binding: CliBinding,
  toolName: string,
  params: JsonObject,
  authorization: AuthorizationContext,
): Promise<ExtensionRuntimeResult> {
  const flagArgs: string[] = [];
  for (const [name, value] of Object.entries(params)) {
    if (value === true) {
      flagArgs.push(`--${name}`);
    } else if (value !== false) {
      flagArgs.push(`--${name}`, String(value));
    }
  }
  const proc = Bun.spawnSync({
    cmd: [binding.command, ...(binding.args ?? []), ...flagArgs],
    env: {
      ...credentialSafeEnv(),
      ...binding.env,
      ...(binding.credentialEnv !== undefined
        ? { [binding.credentialEnv]: authorization.placeholder }
        : undefined),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    const stderr = proc.stderr.toString().trim();
    return {
      ok: false,
      error: `cli tool "${toolName}" exited ${proc.exitCode}${stderr ? `: ${stderr}` : ""}`,
    };
  }
  return { ok: true, content: [{ type: "text", text: proc.stdout.toString() }] };
}

/**
 * The parent environment minus credential-named variables
 * ({@link CREDENTIAL_ENV_RE} in manifest.ts). Credentials must never reach
 * a spawned CLI through the environment — the iron-proxy boundary is the
 * only auth path (see {@link callCliTool}).
 */
export function credentialSafeEnv() {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !CREDENTIAL_ENV_RE.test(name)) env[name] = value;
  }
  return env;
}
