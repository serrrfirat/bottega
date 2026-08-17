import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { createOmpSdkDriver } from "../server/drivers/agent-driver";
import { OMP_AGENT_DIR, main } from "../server/index";

describe("agent dir wiring (issue #9)", () => {
  test("the server boots its OMP driver against the project-local agent dir", async () => {
    // Observable contract: main() creates data/omp-agent at boot (it exists
    // even before any compose mount) and hands it to the driver factory —
    // asserted at runtime through the factory seam, not by grepping source.
    rmSync(OMP_AGENT_DIR, { recursive: true, force: true });
    process.env.SLACK_APP_TOKEN = "xapp-test-token";
    process.env.SLACK_BOT_TOKEN = "xoxb-test-token";
    // Never inherit the live .env's BOTTEGA_CALLBACK_PORT — the harness dev
    // server holds it, so a boot against it is EADDRINUSE. Pin 0 (ephemeral,
    // the #209 default) and restore the prior value after.
    const savedPort = process.env.BOTTEGA_CALLBACK_PORT;
    process.env.BOTTEGA_CALLBACK_PORT = "0";
    let receivedAgentDir: string | undefined;
    try {
      const server = await main({
        createDriver: (agentDir) => {
          receivedAgentDir = agentDir;
          return createOmpSdkDriver({ agentDir, extensions: [] });
        },
      });
      expect(statSync(OMP_AGENT_DIR).isDirectory()).toBe(true);
      expect(receivedAgentDir).toBe(OMP_AGENT_DIR);
      await server.stop();
    } finally {
      if (savedPort === undefined) delete process.env.BOTTEGA_CALLBACK_PORT;
      else process.env.BOTTEGA_CALLBACK_PORT = savedPort;
    }
    mkdirSync(OMP_AGENT_DIR, { recursive: true }); // leave a clean tree behind
  });

  test("the agent dir constant points into the project data directory", () => {
    expect(OMP_AGENT_DIR).toBe("data/omp-agent");
    expect(existsSync(OMP_AGENT_DIR)).toBe(true);
  });
});
