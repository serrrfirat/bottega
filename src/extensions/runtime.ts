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
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
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
import { createSecretFileBoundary, type CredentialBoundary } from "./boundary";
import { createRuntimeMcpOAuthProvider, type McpOAuthTokenStore } from "./mcp-oauth";
import { extensionToolSurface, type ExtensionSurfaces } from "./surface";
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
   * MCP transport factory (test seam): tests inject in-memory transports so
   * tool execution is exercised hermetically. Defaults to the real
   * streamable-http / stdio transports. The optional second argument is the
   * OAuth client provider (issue #198): hosted OAuth MCPs (credential type
   * "oauth") attach it to the streamable-http transport so the MCP SDK's
   * OAuth client drives discovery/refresh with the vault-backed tokens.
   */
  mcpTransport?: (binding: McpBinding, authProvider?: OAuthClientProvider) => Transport;
  /**
   * Vault token store for the runtime's OAuth provider (issue #198 test
   * seam): defaults to the production vault-backed store (broker upload /
   * local AuthStorage).
   */
  mcpOAuthTokenStore?: McpOAuthTokenStore;
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
                    title: toolStepTitle(tool.name, "waiting for approval"),
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
          title: toolStepTitle(tool.name, `denied (${tier})`),
          status: "complete",
          output: stepArgs,
        });
        return { ok: false, error: outcome.blockReason };
      }
      if (outcome.decision === "ask-human") {
        // The waiting card (onAskHuman above) resolves as "approved".
        emitToolStep(sink, {
          spaceId,
          taskId,
          title: toolStepTitle(tool.name, `approved (${tier})`),
          status: "complete",
          output: stepArgs,
        });
      } else {
        emitToolStep(sink, {
          spaceId,
          taskId,
          title: toolStepTitle(tool.name, `allowed (${tier})`),
          status: "in_progress",
          output: stepArgs,
        });
      }

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
        if (outcome.decision !== "ask-human") {
          emitToolStep(sink, {
            spaceId,
            taskId,
            title: toolStepTitle(tool.name, `allowed (${tier})`),
            status: "complete",
            output: stepArgs,
          });
        }
        return { ok: false, error: resolution.kind === "ask" ? resolution.reason : resolution.message };
      }
      const credential = resolution.credential;
      await recordCredentialResolution(deps.store, { actor: caller, spaceId, credential });
      await auditCall({ extensionId, toolName: tool.name, actor: caller, spaceId, credentialId: credential.id, decision: "allow" });

      // 3. Boundary injection + provider call. The credential stays at the
      // boundary; the call carries no auth (iron-proxy attaches it for the
      // extension's allowlisted domains). Failures (boundary write, proxy
      // reload, transport, provider) are tool errors, never silent no-ops —
      // the allow decision is already on the trail. The provider sees the
      // WIRE name (providerName ?? manifest name, issue #148). The step
      // checks off either way — the card documents the attempt, so the
      // thinking panel never shows a stuck spinner.
      const wireName = tool.providerName ?? tool.name;
      // Issue #198: hosted OAuth MCPs carry their auth IN the transport —
      // the MCP SDK's OAuth client (vault-backed tokens, refresh on 401,
      // fail-closed re-auth prompt). The boundary's secret file still gets
      // the current access token (the proxy injects the same value for the
      // extension's allowlisted domains — consistent with the SDK's header).
      const mcpAuth =
        manifest.kind === "mcp" &&
        manifest.mcp.transport === "streamable-http" &&
        manifest.credentialSchema.type === "oauth"
          ? await createRuntimeMcpOAuthProvider({ credential, tokenStore: deps.mcpOAuthTokenStore })
          : undefined;
      try {
        await boundary.authorize(credential);
        // Issue #248: array/object manifest params travel the model-facing
        // surface as JSON-serialized strings; restore the NATIVE type the
        // provider's inputSchema declares before the wire call. CLI calls
        // keep the raw args — their flags are strings (jsonType never
        // applies there, and String(value) on a restored object would
        // mangle it).
        const providerArgs = manifest.kind === "mcp" ? restoreNativeJsonArgs(args, tool.params) : args;
        const result =
          manifest.kind === "mcp"
            ? await callMcpTool(makeTransport, manifest.mcp, wireName, providerArgs, mcpAuth)
            : await callCliTool(manifest.cli, wireName, args);
        if (outcome.decision !== "ask-human") {
          emitToolStep(sink, {
            spaceId,
            taskId,
            title: toolStepTitle(tool.name, `allowed (${tier})`),
            status: "complete",
            output: stepArgs,
          });
        }
        return result;
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
        if (outcome.decision !== "ask-human") {
          emitToolStep(sink, {
            spaceId,
            taskId,
            title: toolStepTitle(tool.name, `allowed (${tier})`),
            status: "complete",
            output: stepArgs,
          });
        }
        return { ok: false, error: `extension tool "${tool.name}" failed: ${errorMessage(err)}` };
      }
    },
  };
}

/**
 * The production MCP transport for a binding (issue #53): streamable-http
 * for remote official servers, stdio for preinstalled servers. Shared by
 * the runtime's call path and the manifest tool generator's tools/list
 * discovery (issue #157); tests inject in-memory transports instead.
 *
 * For streamable-http bindings whose credential is an OAuth token (issue
 * #198), the optional `authProvider` attaches the MCP SDK's OAuth client:
 * it sends the vault-backed access token, refreshes on 401, and fails
 * closed with a re-auth prompt when no interactive flow is possible. API
 * keys stay at the iron-proxy boundary (no authProvider — the proxy
 * injects the Authorization header for the extension's allowlisted
 * domains, issue #53).
 */
export function defaultMcpTransport(binding: McpBinding, authProvider?: OAuthClientProvider): Transport {
  if (binding.transport === "streamable-http") {
    return new StreamableHTTPClientTransport(
      new URL(binding.serverUrl),
      authProvider !== undefined ? { authProvider } : undefined,
    );
  }
  // stderr: "pipe" (issue #205): the discovery/call paths drain a bounded
  // prefix, so a misbehaving stdio server's exec noise (e.g. a shell
  // interpreting the MCP JSON-RPC) never reaches the server log and the
  // child cannot deadlock on an unwritten stderr buffer.
  return new StdioClientTransport({ command: binding.command, stderr: "pipe" });
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
function restoreNativeJsonArgs(args: JsonObject, params: readonly ExtensionToolParam[]): JsonObject {
  const restored: JsonObject = { ...args };
  for (const param of params) {
    if (param.jsonType === undefined) continue;
    const value = args[param.name];
    if (typeof value !== "string") continue; // already-native / absent — pass through
    try {
      restored[param.name] = JSON.parse(value) as JsonValue;
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
  makeTransport: (binding: McpBinding, authProvider?: OAuthClientProvider) => Transport,
  binding: McpBinding,
  toolName: string,
  params: JsonObject,
  authProvider?: OAuthClientProvider,
): Promise<ExtensionRuntimeResult> {
  const client = new Client({ name: "bottega-extensions", version: "1.0.0" });
  try {
    await client.connect(makeTransport(binding, authProvider));
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
    env: { ...credentialSafeEnv(), ...binding.env },
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
