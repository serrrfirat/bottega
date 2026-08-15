/**
 * Bottega server entrypoint: Slack adapter (Socket Mode) + space service.
 */
import { createStore } from "../store/db";
import { createAudit } from "../policy/audit";
import { DenyRouter } from "../policy/approval-router";
import { loadOrgConfig } from "../policy/config";
import createPolicyExtension from "../policy/extension";
import { createOmpSdkDriver } from "./agent-driver";
import { createSlackAdapter } from "./slack";
import { SpaceService } from "./space-service";

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
  // DenyRouter until the Slack-backed approval router lands (later issue):
  // until then, exec-tier tool calls are blocked server-side, never run.
  const driver = createOmpSdkDriver({
    extensions: [createPolicyExtension({ orgPolicy, audit, router: DenyRouter, store })],
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

  return {
    async start() {
      await adapter.start();
      await spaceService.start();
    },
    async stop() {
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
