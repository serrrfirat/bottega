/**
 * Bottega server entrypoint: Slack adapter (Socket Mode) + space service.
 */
import { createStore } from "../store/db";
import { createSqliteMemoryProvider } from "../memory/sqlite";
import { createAudit } from "../policy/audit";
import { DenyRouter } from "../policy/approval-router";
import { loadOrgConfig } from "../policy/config";
import createPolicyExtension from "../policy/extension";
import { workItemsExtension } from "../tools/work-items";
import { memoryToolsExtension } from "../tools/memory";
import { createOmpSdkDriver } from "./agent-driver";
import { startDeliveryPoller } from "./delivery-poller";
import { createSlackAdapter } from "./slack";
import { SpaceService } from "./space-service";
import { mkdirSync } from "node:fs";

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

export function main(): BottegaServer {
  const appToken = process.env.SLACK_APP_TOKEN;
  const botToken = process.env.SLACK_BOT_TOKEN;
  if (!appToken || !botToken) {
    throw new Error("SLACK_APP_TOKEN and SLACK_BOT_TOKEN are required");
  }

  const store = createStore();
  const audit = createAudit(store);
  const orgPolicy = loadOrgConfig();
  // Created at boot so the SDK agent dir exists even outside compose (local
  // dev); under compose the config/omp templates are mounted here.
  mkdirSync(OMP_AGENT_DIR, { recursive: true });
  // DenyRouter until the Slack-backed approval router lands (later issue):
  // until then, exec-tier tool calls are blocked server-side, never run.
  const driver = createOmpSdkDriver({
    agentDir: OMP_AGENT_DIR,
    extensions: [
      createPolicyExtension({ orgPolicy, audit, router: DenyRouter, store }),
      workItemsExtension(store),
      // Memory tools (issue #22): the SQLite provider shares the store's
      // database handle; every save is audited via the policy audit module.
      memoryToolsExtension(createSqliteMemoryProvider(store.getDb()), { audit }),
    ],
  });
  // The adapter routes inbound messages to the service; the service posts
  // replies back through the adapter. Late-bound: no message can arrive
  // before main() returns, so the closure read is always initialized.
  let spaceService: SpaceService;
  const adapter = createSlackAdapter({
    appToken,
    botToken,
    onMessage: (m) => spaceService.handleInboundMessage(m),
  });
  spaceService = new SpaceService({ store, adapter, driver });
  // Executor's delivery seam (issue #11 follow-up, #12): the executor runs
  // in its own container and cannot post to Slack. When a work item's PR is
  // opened it writes a work_item.delivery_pending audit marker; this poller
  // watches that trail, posts the PR + approval request to the space
  // channel, and records approval.requested (dedupe across restarts). The
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
      await spaceService.start();
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
