/**
 * Bottega server entrypoint: Slack adapter (Socket Mode) + space service.
 */
import { createStore } from "../store/db";
import { pruneDigestMemories } from "../memory/sqlite";
import { resolveMemoryProvider } from "./memory-provider";
import { createAudit } from "../policy/audit";
import type { ApprovalRouter } from "../policy/approval-router";
import { loadOrgConfig, loadSpacePolicy, type ResponseMode } from "../policy/config";
import createPolicyExtension from "../policy/extension";
import { workItemsExtension } from "../tools/work-items";
import { memoryToolsExtension } from "../tools/memory";
import { createAcpDriver } from "./drivers/acp-driver";
import { createExtensionRegistry } from "../extensions/registry";
import { createExtensionRuntime } from "../extensions/runtime";
import { extensionToolDefinitions } from "../extensions/tools";
import { createOmpSdkDriver, type AgentDriver } from "./drivers/agent-driver";
import { startDeliveryPoller } from "./services/delivery-poller";
import { SlackApprovalRouter } from "./adapters/approval-router";
import { createSlackAdapter, type SlackAction, type SlackAdapter } from "./adapters/slack";
import { SpaceService } from "./services/space-service";
import { mkdirSync } from "node:fs";
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
}

export function main(opts: BottegaServerOpts = {}): BottegaServer {
  const appToken = process.env.SLACK_APP_TOKEN;
  const botToken = process.env.SLACK_BOT_TOKEN;
  if (!appToken || !botToken) {
    throw new Error("SLACK_APP_TOKEN and SLACK_BOT_TOKEN are required");
  }

  const store = createStore();
  const audit = createAudit(store);
  const orgPolicy = loadOrgConfig();
  // One memory provider for the whole process: shared by the agent
  // memory tools, the context-injection extension, and digest-on-idle (#42).
  // Chosen from env (#43): MEM0_BASE_URL set → mem0 backend (compose ships
  // it), else SQLite sharing the store's database handle.
  const memoryProvider = resolveMemoryProvider(process.env, store.getDb());
  // Extension registry (issue #50): loads pinned spec snapshots from
  // config/extensions/ at boot. Per-org deployments resolve extensions from
  // these local files — never from the integrations.sh catalog at runtime.
  const extensionRegistry = createExtensionRegistry("config/extensions");
  /** Manifest tier of an extension tool, shared by the policy extension and the runtime gate (issue #53). */
  const extensionToolTier = (toolName: string) => {
    const extensionId = extensionRegistry.extensionIdForTool(toolName);
    if (extensionId === undefined) return undefined;
    return extensionRegistry.resolve(extensionId)?.manifest.tools.find((tool) => tool.name === toolName)?.tier;
  };
  // Created at boot so the SDK agent dir exists even outside compose (local
  // dev); under compose the config/omp templates are mounted here.
  mkdirSync(OMP_AGENT_DIR, { recursive: true });
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
  let approvalRouter: ApprovalRouter & { handleAction(a: SlackAction): Promise<void> };
  const adapter = createSlackAdapter({
    appToken,
    botToken,
    onMessage: (m) => spaceService.handleInboundMessage(m),
    onAction: (a) => approvalRouter.handleAction(a),
    responseModeFor,
  });
  // Space sessions resolve ask-human via Slack buttons (issue #44). The
  // executor keeps DenyRouter (src/executor.ts): its work-item pickup
  // approval is the authorization, and nothing headless may run exec tools
  // without one.
  approvalRouter = (opts.createApprovalRouter ?? ((deps) => new SlackApprovalRouter(deps)))({
    adapter,
    timeoutMs: orgPolicy.timeoutMinutes * 60_000,
  });
  // Extension tool runtime (issue #53): every extension tool call crosses
  // the policy gate → credential ladder → egress boundary → audit. The
  // broker secret resolver for the boundary is issue #54's wiring, so
  // calls fail closed at the boundary until then.
  const extensionRuntime = createExtensionRuntime({
    registry: extensionRegistry,
    store,
    audit,
    orgPolicy,
    router: approvalRouter,
  });
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
        // toolset alongside the project extensions below; execution goes
        // through the #53 runtime (gate → ladder → boundary → audit).
        customTools: extensionToolDefinitions(extensionRegistry.list(), { runtime: extensionRuntime }),
        // Connect capability (issue #52): connect_extension is built per
        // session so the actor is the requesting principal; org-scope
        // connects gate through the same Slack-backed approval router as
        // every exec-tier tool call.
        connectExtension: {
          registry: extensionRegistry,
          store,
          audit,
          loadPolicy: (spaceId) => loadSpacePolicy(orgPolicy, store, spaceId),
          router: approvalRouter,
        },
        extensions: [
          createPolicyExtension({
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
          }),
          workItemsExtension(store, { orgPolicy }),
          // Memory tools (issue #22, #43): provider chosen from env —
          // MEM0_BASE_URL set → mem0 backend (compose ships it), else SQLite
          // sharing the store's database handle. Every save is audited via
          // the policy audit module.
          memoryToolsExtension(memoryProvider, { audit }),
        ],
        // Turn-start memory injection (#42), gated by the org policy config.
        memoryContext: {
          provider: memoryProvider,
          enabled: orgPolicy.memory.injection.enabled,
          maxEntries: orgPolicy.memory.injection.maxEntries,
        },
      });
    });
  const driver = createDriver(OMP_AGENT_DIR);
  spaceService = new SpaceService({
    store,
    adapter,
    driver,
    // Per-space response mode (issue #55): the request-only directive is
    // appended at session creation.
    responseModeFor,
    // Digest-on-idle (#42): summarize idle spaces into org memory; the cap
    // prunes digest memories beyond the newest 20 per space on this file.
    memoryProvider,
    digestPrune: (spaceId, keep) => {
      pruneDigestMemories(store.getDb(), spaceId, keep);
    },
  });
  // Executor's delivery seam (issue #11 follow-up, #12): the executor runs
  // in its own container and cannot post to Slack. When a work item's PR is
  // opened it writes a work_item.delivery_pending audit marker; this poller
  // watches that trail, posts the PR + approval request to the space
  // channel, and records delivery.requested (dedupe across restarts). The
  // button round-trip that resolves the seam (working -> review -> done) is
  // a later adapter issue.
  const deliveryPoller = startDeliveryPoller({
    store,
    adapter,
    log: (line) => console.log(line),
  });

  return {
    async start() {
      await adapter.start();
      deliveryPoller.start();
    },
    async stop() {
      deliveryPoller.stop();
      await spaceService.stop();
      await adapter.stop();
      store.close();
    },
  };
}

if (import.meta.main) {
  const server = main();
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
