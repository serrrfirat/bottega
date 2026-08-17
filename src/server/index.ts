/**
 * Bottega server entrypoint: Slack adapter (Socket Mode) + space service.
 */
import { pruneDigestMemories } from "../memory/sqlite";
import { maintainMemory, type ConsolidationModelCall } from "../memory/consolidation";
import { sessionSearchToolDefinitions } from "../memory/session-search";
import type { ApprovalRouter } from "../policy/approval-router";
import { loadSpacePolicy, type ResponseMode } from "../policy/config";
import { bootstrapRuntime, type BootstrapRuntime } from "./bootstrap-runtime";
import { workItemToolDefinitions } from "../tools/work-items";
import { memoryToolDefinitions } from "../tools/memory";
import { objectToolDefinitions } from "../tools/objects";
import { modelToolsDefinitions } from "../tools/model-settings";
import { settingsToolDefinitions } from "../tools/settings";
import { adminToolDefinitions, onboardingGuideText, runWizardChecks } from "../tools/admin";
import { kbToolDefinitions, type KbToolDependencies } from "../tools/kb-tools";
import { loadKbConfig } from "../kb/config";
import { buildRegistry } from "../scheduler/actions";
import { startScheduler } from "../scheduler/runner";
import { schedulerToolDefinitions } from "../scheduler/scheduler-tools";
import { standupDigestAction } from "../scheduler/standup";
import { reflectionAction } from "../scheduler/reflection";
import { orgPulseAction } from "../scheduler/observer";
import { recurringWorkAction } from "../scheduler/recurring-work";
import { regenerateModelsConfig } from "../models/generate";
import { createAcpDriver } from "./drivers/acp-driver";
import { connectViaAuthBroker } from "../extensions/connect";
import {
  refreshMissingExtensionSurfaces,
  type ExtensionSurfaces,
} from "../extensions/surface";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpBinding } from "../extensions/manifest";
import { extensionToolDefinitions } from "../extensions/tools";
import {
  assertAgentDirModelAvailable,
  createOmpSdkDriver,
  ensureAgentDirModelPin,
  OMP_CONFIG_TEMPLATE,
  SessionModelRoleRegistry,
  sessionIdFromFilePath,
  type AgentDriver,
  type AgentSessionDriver,
} from "./drivers/agent-driver";
import { startDeliveryPoller } from "./services/delivery-poller";
import { SlackApprovalRouter } from "./adapters/approval-router";
import { resolveDeliveryAction } from "./adapters/delivery-router";
import {
  createSlackAdapter,
  DELIVERY_APPROVE_ACTION_ID,
  DELIVERY_DENY_ACTION_ID,
  type SlackAction,
  type SlackAdapter,
} from "./adapters/slack";
import { SpaceService } from "./services/space-service";
import { createLearningService } from "./services/learning";
import { ADMIN_ONBOARDING_BOOT_EVENT } from "../store/audit-events";
import type { ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Project-local OMP agent dir (issue #9). Per-deployment agent config
 * (config.yml / secrets.yml / models.yml) lives here instead of the default
 * ~/.omp/agent: compose mounts config/omp templates at data/omp-agent, so a
 * deployment's secrets-obfuscation and model catalog ship with the repo and
 * no credential ever lands in a user's home agent dir.
 */
export const OMP_AGENT_DIR = "data/omp-agent";

export interface BottegaServer {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface BottegaServerOpts {
  /**
   * Driver factory seam (issue #33): receives the resolved agent dir so
   * tests can observe at runtime which directory the server hands the
   * driver. Defaults to the OMP SDK driver with the project extensions.
   */
  createDriver?: (agentDir: string) => AgentDriver;
  /**
   * Approval router factory seam (issue #44): receives the adapter and the
   * policy timeout so tests can observe the wiring. Defaults to the
   * Slack-backed button router used for space sessions; headless contexts
   * (the executor) keep DenyRouter in their own entrypoint.
   */
  createApprovalRouter?: (deps: {
    adapter: Pick<SlackAdapter, "postMessage" | "updateMessage">;
    timeoutMs: number;
  }) => ApprovalRouter & { handleAction(a: SlackAction): Promise<void> };
  /**
   * Agent dir override (issue #67): where the SDK agent config lives and
   * models.yml is generated at boot. Defaults to {@link OMP_AGENT_DIR};
   * tests override it with a temp dir so generation is observable without
   * touching the deployment agent dir.
   */
  agentDir?: string;
  /**
   * Boot-guide posting seam (issue #116): posts the boot-time onboarding
   * guide to the configured onboarding space. Defaults to the Slack
   * adapter's postMessage; tests inject a fake so no Slack call happens.
   */
  postOnboardingGuide?: (spaceId: string, text: string) => Promise<void>;
  /**
   * Session-toolset observation seam (testing-gaps audit 2026-08-17):
   * receives the space-agent custom-tools bridge definitions wired at
   * boot — work items (#10), memory (#22/#43), model/settings/admin tools
   * (#64/#67/#73), scheduler administration (#86/#111), and the KB ingest
   * tool (#91). Caller-level boot tests assert the scheduler + KB wiring
   * is registered without opening a live session (which would need the
   * SDK + a model).
   */
  onSessionToolset?: (tools: ToolDefinition[]) => void;
  /**
   * Extension MCP transport seam (issue #166): the transport used for
   * tools/list discovery of tools-less manifests at boot AND for the
   * runtime's lazy per-call resolution. Defaults to the production
   * transport (src/extensions/runtime.ts); hermetic boot tests inject
   * in-memory transports so an auth-gated/unreachable provider never
   * touches the network.
   */
  surfaceTransport?: (binding: McpBinding) => Transport;
  /**
   * Extension-surface observation seam (issue #166): receives the map of
   * surfaces resolved at boot — only the extensions whose discovery
   * succeeded (a per-provider failure is skipped, never a boot failure).
   * Caller-level boot tests assert reachable providers discover eagerly
   * and auth-gated providers are absent (deferred to the runtime's lazy
   * per-call path, which fails closed).
   */
  onExtensionSurfaces?: (surfaces: ExtensionSurfaces) => void;
  /**
   * Extension-toolset observation seam (issue #167): receives the SDK tool
   * definitions built from the boot-resolved surfaces — the extension half
   * of the space agent's session toolset (work items/memory/scheduler/KB
   * ride onSessionToolset). Caller-level boot tests assert the FULL
   * discovered surface of a reachable provider lands in the session
   * toolset (never a truncated or stale subset). The definitions the seam
   * receives are exactly the ones the driver's sessions start from; a
   * session-creation refresh (refreshMissingExtensionSurfaces) can only
   * ADD tools for providers the boot could not reach.
   */
  onExtensionToolset?: (tools: ToolDefinition[]) => void;
  /**
   * Shared-chain observation seam (issue #172): receives the
   * {@link BootstrapRuntime} the boot built — store → audit → org policy →
   * extension registry → effective surfaces → extension runtime → memory
   * provider, the SAME construction the executor and MCP roots use. The
   * composition-root parity test drives a real main() with this seam to
   * assert the server resolves the same memory backend, registry contents,
   * org-policy source, and boundary (broker secret resolver present) as
   * the other two roots under the same settings.
   */
  onRuntimeWiring?: (wiring: BootstrapRuntime) => void;
}

export async function main(opts: BottegaServerOpts = {}): Promise<BottegaServer> {
  const appToken = process.env.SLACK_APP_TOKEN;
  const botToken = process.env.SLACK_BOT_TOKEN;
  if (!appToken || !botToken) {
    throw new Error("SLACK_APP_TOKEN and SLACK_BOT_TOKEN are required");
  }

  // Shared composition chain (issue #172, #153 item 2): ONE construction
  // site for store → audit → org policy → extension registry → effective
  // surfaces → extension runtime → memory provider, identical across the
  // server / executor / MCP roots. The extension runtime's ask-human
  // router is late-bound (the Slack-backed router is constructed below,
  // after the adapter); the runtime reads it per call.
  let approvalRouter: ApprovalRouter & { handleAction(a: SlackAction): Promise<void> };
  // Delivery-approval clicks (issue #149) resolve the executor's delivery
  // seam; late-bound like approvalRouter — assigned after the adapter and
  // store are available, before main() returns.
  let deliveryActionHandler: (a: SlackAction) => Promise<void>;
  const wiring = await bootstrapRuntime({
    router: () => approvalRouter,
    ...(opts.surfaceTransport !== undefined ? { mcpTransport: opts.surfaceTransport } : {}),
  });
  const {
    store,
    audit,
    orgPolicy,
    registry: extensionRegistry,
    runtime: extensionRuntime,
    surfaces: extensionSurfaces,
    memoryProvider,
  } = wiring;
  opts.onRuntimeWiring?.(wiring);
  // Issue #67: the org settings blob is the source of truth — the policy
  // loader reads DB-first (config.yml is the default/fallback), the memory
  // backend URL and model catalog come from settings, and the agent-dir
  // models.yml is generated at boot (written only when settings carry
  // model ids — otherwise the committed template stays the default).
  // A malformed settings blob fails the boot closed (getOrgSettings
  // throws; loadOrgPolicy fails the policy closed).
  const orgSettings = store.getOrgSettings();
  const schedulerRegistry = buildRegistry([
    standupDigestAction,
    reflectionAction,
    orgPulseAction,
    recurringWorkAction,
  ]);
  const kbDeps: KbToolDependencies = {
    memoryProvider,
    audit,
    config: loadKbConfig(),
  };
  opts.onExtensionSurfaces?.(extensionSurfaces);
  /** Manifest tier of an extension tool, shared by the policy extension and the runtime gate (issue #53). */
  const extensionToolTier = (toolName: string) => {
    const extensionId = extensionRegistry.extensionIdForTool(toolName);
    if (extensionId === undefined) return undefined;
    // Issue #158: consult the EFFECTIVE surface (pinned or discovered).
    return (extensionSurfaces.get(extensionId) ?? []).find((tool) => tool.name === toolName)?.tier;
  };
  // Created at boot so the SDK agent dir exists even outside compose (local
  // dev); under compose the config/omp templates are mounted here.
  const agentDir = opts.agentDir ?? OMP_AGENT_DIR;
  mkdirSync(agentDir, { recursive: true });
  // Boot-time generation (issue #67): the SDK reads models.yml from the
  // agent dir; the DB settings are the source of truth. Written only when
  // settings carry model ids — otherwise the mounted template stays.
  if (orgSettings !== null) {
    regenerateModelsConfig(orgSettings, join(agentDir, "models.yml"));
  }
  // Boot-time pin sync (issue #78 recurrence): the SDK reads modelRoles
  // from the agent dir's config.yml; host-dev agent dirs are never re-synced
  // from config/omp, so a stale copy without the pin makes every session
  // silently fall back to the provider catalog default (kimi-k2.7-code),
  // which the Console Go gateway 400s into empty completions. Sync the pin
  // before the driver guard runs.
  const pinSync = ensureAgentDirModelPin(agentDir);
  if (pinSync === "created" || pinSync === "patched") {
    console.log(
      `bottega boot: agent-dir config.yml ${pinSync} — modelRoles pin synced from ${OMP_CONFIG_TEMPLATE}`,
    );
  }
  // Wiring order matters: the policy gate (both drivers) needs the approval
  // router, the router needs the adapter, and the adapter's callbacks need
  // the service/router — all late-bound closures, so no message or action
  // can arrive before main() returns.
  // Per-space response mode (issue #55), read by both consumers: the adapter
  // filters for `mention` spaces; the service appends the request-only
  // directive at session creation.
  const responseModeFor = async (spaceId: string): Promise<ResponseMode> => {
    const policy = await loadSpacePolicy(orgPolicy, store, spaceId);
    return policy.responseMode;
  };
  let spaceService: SpaceService;
  const adapter = createSlackAdapter({
    appToken,
    botToken,
    onMessage: (m) => spaceService.handleInboundMessage(m),
    onAction: (a) => {
      // Delivery buttons (issue #149) resolve the executor's delivery seam;
      // every other interactive click is an exec-tier approval (issue #44).
      if (a.actionId === DELIVERY_APPROVE_ACTION_ID || a.actionId === DELIVERY_DENY_ACTION_ID) {
        return deliveryActionHandler(a);
      }
      return approvalRouter.handleAction(a);
    },
    responseModeFor,
  });
  // Boot-time onboarding guide (issue #116): proactive Slack-side setup.
  // When any first-run check fails AND an onboarding space is configured
  // (org settings onboarding.space_id), post ONE guided message naming the
  // failing checks with a pointer to the first_run_wizard — once per boot
  // by construction. Fail closed: no space configured → no post; a failed
  // post is audited + logged, never a boot failure.
  const onboardingSpaceId = orgSettings?.onboarding?.spaceId;
  if (onboardingSpaceId !== undefined) {
    const failing = runWizardChecks(store).filter((c) => !c.ok);
    if (failing.length > 0) {
      const postGuide =
        opts.postOnboardingGuide ?? ((spaceId: string, text: string) => adapter.postMessage(spaceId, text));
      const checks = failing.map((c) => ({ name: c.name, ok: c.ok }));
      try {
        await postGuide(onboardingSpaceId, onboardingGuideText(failing));
        await audit.appendAudit({
          space_id: onboardingSpaceId,
          actor: "system",
          event_type: ADMIN_ONBOARDING_BOOT_EVENT,
          payload: { posted: true, checks },
        });
      } catch (err) {
        console.error(`[boot] onboarding guide post to ${onboardingSpaceId} failed:`, err);
        await audit
          .appendAudit({
            space_id: onboardingSpaceId,
            actor: "system",
            event_type: ADMIN_ONBOARDING_BOOT_EVENT,
            payload: { posted: false, checks },
          })
          .catch(() => {});
      }
    }
  }
  // Space sessions resolve ask-human via Slack buttons (issue #44). The
  // executor keeps DenyRouter (src/executor.ts): its work-item pickup
  // approval is the authorization, and nothing headless may run exec tools
  // without one.
  approvalRouter = (opts.createApprovalRouter ?? ((deps) => new SlackApprovalRouter(deps)))({
    adapter,
    timeoutMs: orgPolicy.timeoutMinutes * 60_000,
  });
  // Delivery resolution (issue #149): a block-action click on the poller's
  // prompt records the human's decision as delivery.resolved — the audit
  // row the executor's onDelivery wait reads — and rewrites the prompt with
  // the outcome.
  deliveryActionHandler = async (a) => {
    await resolveDeliveryAction({ store, adapter, log: (line) => console.log(line) }, a);
  };
  // Extension tool runtime (issue #53): every extension tool call crosses
  // the policy gate → credential ladder → egress boundary → audit — built
  // by bootstrapRuntime above with the router just assigned (the #172
  // shared chain). Its boundary ALWAYS carries the broker secret resolver
  // (#54 wiring, shipped with #143): the resolver fetches the resolved
  // credential's secret payload from the auth-broker vault
  // (OMP_AUTH_BROKER_URL/TOKEN — set by scripts/dev.sh locally, by
  // docker-compose.yml in deployment) and fails closed when the broker is
  // not configured. With BOTTEGA_PROXY_CONTROL_URL + token in the
  // environment (issue #123), authorize writes the secret file AND reloads
  // the proxy; unset (hermetic tests) stays write-only.
  // Live-session registry (issue #64): SpaceService registers each live
  // session; the model tools extension resolves use_model switches through
  // it. Created here (before both) because the two share it.
  const modelRoles = new SessionModelRoleRegistry();
  // Space-agent session toolset (issue #69): the gated custom-tools bridge
  // definitions every restricted session carries — work items (#10), memory
  // (issues #22/#43 — provider selected from the org settings (#67):
  // memory_backend.base_url set → mem0 backend (compose ships it), else
  // SQLite sharing the store's database handle; every save is audited via
  // the policy audit module), session search (#132), objects (#124), model
  // tools (#64), settings (#67), admin (#73), scheduler administration
  // (#86/#111), KB ingest (#91). Hoisted out of the driver factory so the
  // onSessionToolset seam can expose the wiring to caller-level boot tests.
  const sessionToolset = [
    ...workItemToolDefinitions(store, { orgPolicy, agentDir }),
    ...memoryToolDefinitions(memoryProvider, { audit }),
    ...sessionSearchToolDefinitions(store.getDb(), "data/sessions"),
    ...objectToolDefinitions(store, { orgPolicy, audit, adapter }),
    ...modelToolsDefinitions(store, { audit, modelRoles }),
    ...settingsToolDefinitions(store, {
      audit,
      // Org-scope writes cross the approval router (issue #151): the same
      // exec-tier ask-human flow as every other privileged mutation — the
      // Slack-backed router posts an approve/deny prompt, and without this
      // gate the tool fails closed (org writes rejected).
      gate: {
        loadPolicy: (spaceId) => loadSpacePolicy(orgPolicy, store, spaceId),
        router: approvalRouter,
      },
    }),
    // Admin tools (issue #73): catalog browser, stack health, deploy info,
    // first-run wizard — gated like the settings tool (write tier →
    // org-settings access via approval); deploy_info is read-tier (anyone).
    ...adminToolDefinitions(store, { audit, registry: extensionRegistry }),
    ...schedulerToolDefinitions(store, audit, schedulerRegistry),
    ...kbToolDefinitions(kbDeps),
  ];
  opts.onSessionToolset?.(sessionToolset);
  // Issue #167: the extension half of the space agent's session toolset.
  // The bridge builds SDK definitions from the boot-resolved surfaces —
  // a boot that resolved github eagerly yields ALL 44 definitions here,
  // never a truncated subset. The seam exposes exactly the definitions
  // sessions start from; the per-session resolver below (passed to the
  // driver as a lazy customTools) can only ADD tools for providers the
  // boot could not reach.
  // Issue #152: every extension call carries the principal of the TURN it
  // runs in via the bridge's getCaller seam, so the #51 ladder's personal
  // scope matches the Slack human whose message STARTED the turn. spaceService
  // is late-bound (constructed after the driver); the closure reads it only
  // at call time.
  const extensionCaller = (ctx: { sessionManager?: { getSessionFile(): string | null | undefined } }) => {
    const spaceId = sessionIdFromFilePath(ctx.sessionManager?.getSessionFile());
    return spaceId ? spaceService.getTurnPrincipal(spaceId) : undefined;
  };
  const buildExtensionToolset = (surfaces: ExtensionSurfaces): ToolDefinition[] =>
    extensionToolDefinitions(extensionRegistry.list(), {
      runtime: extensionRuntime,
      getCaller: extensionCaller,
      surfaces,
    });
  opts.onExtensionToolset?.(buildExtensionToolset(extensionSurfaces));
  // Session-creation refresh (issue #167): a provider whose discovery
  // failed at boot (issue #166 — skipped, never a boot failure) is
  // re-attempted when a session is created. Failed discoveries are never
  // cached (surface.ts), so the next attempt really re-discovers; the
  // moment it succeeds the FULL surface lands in that session. Resolved
  // providers pass through as cache hits — zero I/O in the steady state.
  const refreshExtensionToolset = async (): Promise<ToolDefinition[]> => {
    const surfaces = await refreshMissingExtensionSurfaces(
      extensionRegistry.list(),
      extensionSurfaces,
      opts.surfaceTransport !== undefined ? { mcpTransport: opts.surfaceTransport } : {},
    );
    return buildExtensionToolset(surfaces);
  };
  const createDriver =
    opts.createDriver ??
    ((agentDir: string) => {
      // Org config selects the space-agent driver (issue #26): `acp` flips
      // the space agent to the ACP driver — policy enforced over
      // session/request_permission with audit, memory tools attached as an
      // MCP server. Default `omp-sdk` keeps the in-process extensions
      // (deep interception); the flip is opt-in via config until proven.
      if (orgPolicy.agentDriver === "acp") {
        return createAcpDriver({
          mcpServers: [
            {
              name: "bottega",
              command: process.execPath,
              args: ["run", fileURLToPath(new URL("../mcp/server.ts", import.meta.url))],
              env: {
                BOTTEGA_DB_PATH: process.env.BOTTEGA_DB_PATH ?? "data/bottega.db",
                BOTTEGA_CONFIG_DIR: process.env.BOTTEGA_CONFIG_DIR ?? process.cwd(),
                // Absolute because ACP starts the MCP child from the session workspace.
                BOTTEGA_SESSION_DIR: join(process.cwd(), "data/sessions"),
                // The MCP server boots the same extension registry (issue
                // #61) so ACP agents see connect_extension + extension
                // tools; the driver absolutizes the relative path because
                // the spawned server runs with the agent session's cwd.
                BOTTEGA_EXTENSIONS_DIR: "config/extensions",
              },
            },
          ],
          policy: {
            orgPolicy,
            loadPolicy: (spaceId) => loadSpacePolicy(orgPolicy, store, spaceId),
            audit,
            router: approvalRouter,
          },
        });
      }
      return createOmpSdkDriver({
        agentDir,
        // Registry tools (issue #50): typed extension tools ride the SDK
        // custom-tools path so they surface in the restricted space-agent
        // toolset; execution goes through the #53 runtime, which runs its
        // OWN policy gate (gate → ladder → boundary → audit), so they are
        // never wrapped by the driver gate below.
        //
        // Issue #167: the toolset is a lazy RESOLVER — the driver builds
        // the definitions per session, refreshing surfaces for providers
        // the boot could not reach. The boot snapshot (extensionSurfaces,
        // above) is the base; refreshMissingExtensionSurfaces adds only
        // what the boot missed, and resolved providers stay cache hits.
        customTools: refreshExtensionToolset,
        // Policy gate (issue #69): restricted SDK sessions never evaluate
        // inline extension factories (sdk.ts), so the policy extension's
        // tool_call interception is inert in production. The gate moves to
        // the custom-tools bridge: every gated tool definition below AND
        // every allowlisted built-in (read/glob/grep/task/...) crosses the
        // shared decision table (tier × space policy → allow | deny |
        // ask-human, audited, Slack-routed approvals) before executing.
        gate: {
          orgPolicy,
          audit,
          router: approvalRouter,
          store,
          // Extension policy seam (issue #56): resolve extension tool
          // calls against the space's allowlist before tier/approval.
          toolExtensionId: (name) => extensionRegistry.extensionIdForTool(name),
          // Extension tier seam (issue #53): an allowed extension crosses
          // the tier stage as a known tool with its manifest tier.
          toolTier: (name) => extensionToolTier(name),
          knownExtensionIds: extensionRegistry.list().map((r) => r.manifest.id),
          // The in-session tool surface, as SDK tool definitions (issue
          // #69) — see sessionToolset above.
          tools: sessionToolset,
        },
        // Connect capability (issue #52): connect_extension is built per
        // session so the actor is the requesting principal; org-scope
        // connects gate through the same Slack-backed approval router as
        // every exec-tier tool call (its own gate — never double-wrapped).
        connectExtension: {
          registry: extensionRegistry,
          store,
          audit,
          loadPolicy: (spaceId) => loadSpacePolicy(orgPolicy, store, spaceId),
          router: approvalRouter,
        },
        // Per-space model settings (issue #64): the OMP session resolves
        // use_model roles against the space's settings column.
        getModelSettings: (spaceId) => store.getSpaceSettings(spaceId),
        // Turn-start memory injection (#42), gated by the org policy config.
        memoryContext: {
          provider: memoryProvider,
          enabled: orgPolicy.memory.injection.enabled,
          maxEntries: orgPolicy.memory.injection.maxEntries,
        },
      });
    });
  const driver = createDriver(agentDir);
  const learning = createLearningService({
    driver,
    memory: memoryProvider,
    audit,
    autoExtract: orgPolicy.learning.autoExtract,
  });

  // Boot-time guard (issue #80): createOmpSdkDriver installs the agent dir
  // as the process-global dir at construction; fail the boot here — not the
  // first prompt — when the SDK's model registry then resolves no available
  // model from OUR models.yml. The ACP driver resolves models in its own
  // MCP server, not through the OMP registry, so the guard is OMP-only.
  if (orgPolicy.agentDriver !== "acp") {
    const available = await assertAgentDirModelAvailable(agentDir);
    console.log(`bottega boot: model registry ready (${available} available model(s) from ${agentDir})`);
  }
  let consolidationSequence = 0;
  const consolidationModelCall: ConsolidationModelCall = async (systemPrompt, input) => {
    let reply: string | undefined;
    let sideSession: AgentSessionDriver | undefined;
    let offMessage: (() => void) | undefined;
    try {
      sideSession = await driver.createSession({
        spaceId: `memory-consolidation:${++consolidationSequence}`,
        transcriptDir: "data/memory-consolidation",
        allowTools: [],
        appendSystemPrompt: systemPrompt,
        onOutput: (_spaceId, text) => {
          if (text.trim()) reply = text;
        },
      });
      offMessage = sideSession.on("message", (data) => {
        const text = (data as { text?: unknown } | null)?.text;
        if (typeof text === "string" && text.trim()) reply = text;
      });
      // ACP v1 has no system-prompt field, so carry the instructions in-band
      // on that driver while OMP receives them through appendSystemPrompt.
      await sideSession.prompt(
        orgPolicy.agentDriver === "acp" ? `${systemPrompt}\n\n${input}` : input,
      );
      return reply;
    } finally {
      offMessage?.();
      if (sideSession) {
        try {
          await sideSession.dispose();
        } catch (error) {
          console.error("[memory-consolidation] side-session dispose failed:", error);
        }
      }
    }
  };

  let consolidationInFlight: Promise<void> | undefined;
  const runMemoryMaintenance = (): void => {
    if (memoryProvider.backend !== "sqlite" || consolidationInFlight) return;
    consolidationInFlight = (async () => {
      try {
        await maintainMemory(store.getDb(), consolidationModelCall);
      } catch (error) {
        console.error("[memory-consolidation] maintenance failed:", error);
      } finally {
        consolidationInFlight = undefined;
      }
    })();
  };
  const memoryMaintenanceInterval =
    memoryProvider.backend === "sqlite"
      ? setInterval(runMemoryMaintenance, 6 * 60 * 60 * 1_000)
      : undefined;
  memoryMaintenanceInterval?.unref?.();
  runMemoryMaintenance();
  spaceService = new SpaceService({
    store,
    adapter,
    driver,
    learning,
    audit,
    orgPolicy,
    // Per-space response mode (issue #55): the request-only directive is
    // appended at session creation.
    responseModeFor,
    // Digest-on-idle (#42): summarize idle spaces into org memory; the cap
    // prunes digest memories beyond the newest 20 per space on this file.
    memoryProvider,
    digestPrune: (spaceId, keep) => {
      pruneDigestMemories(store.getDb(), spaceId, keep);
    },
    // Connect intent seam (issue #61): `connect X` / `connect X as org|me`
    // messages route straight to the connect capability — no agent tool
    // call. Org connects gate through the same Slack approval router as
    // every exec-tier tool call; personal connects run for the sender.
    connect: {
      registry: extensionRegistry,
      store,
      audit,
      broker: connectViaAuthBroker,
      gate: {
        loadPolicy: (spaceId) => loadSpacePolicy(orgPolicy, store, spaceId),
        router: approvalRouter,
        timeoutMs: orgPolicy.timeoutMinutes * 60_000,
      },
    },
    // Live sessions register here (issue #64) so use_model can reach them.
    modelRoles,
  });
  // Executor's delivery seam (issue #11 follow-up, #12, round trip #149):
  // the executor runs in its own container and cannot post to Slack. When a
  // work item's PR is opened it writes a work_item.delivery_pending audit
  // marker; this poller watches that trail, posts the PR + an interactive
  // approve/deny prompt to the space channel, and records
  // delivery.requested (dedupe across restarts). A button click resolves
  // the seam (delivery.resolved via deliveryActionHandler above) and the
  // executor's onDelivery wait completes working -> review -> done.
  const deliveryPoller = startDeliveryPoller({
    store,
    adapter,
    log: (line) => console.log(line),
  });
  const scheduler = startScheduler({
    store,
    audit,
    registry: schedulerRegistry,
    memoryProvider,
    postMessage: (spaceId, text) => adapter.postMessage(spaceId, text),
    loadPolicy: (spaceId) => loadSpacePolicy(orgPolicy, store, spaceId),
    log: (line) => console.log(line),
  });

  return {
    async start() {
      await adapter.start();
      deliveryPoller.start();
      scheduler.start();
    },
    async stop() {
      if (memoryMaintenanceInterval) clearInterval(memoryMaintenanceInterval);
      deliveryPoller.stop();
      scheduler.stop();
      await spaceService.stop();
      await consolidationInFlight;
      await adapter.stop();
      store.close();
    },
  };
}

if (import.meta.main) {
  const server = await main();
  let stopping = false;
  process.on("SIGINT", () => {
    if (stopping) return;
    stopping = true;
    console.log("bottega server: shutting down");
    server
      .stop()
      .then(() => process.exit(0))
      .catch((err) => {
        console.error("bottega server: shutdown failed", err);
        process.exit(1);
      });
  });
  server.start().catch((err) => {
    console.error("bottega server: failed to start", err);
    process.exit(1);
  });
}
