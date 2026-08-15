import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { createOmpSdkDriver } from "../server/agent-driver";
import { OMP_AGENT_DIR, main } from "../server/index";

describe("agent dir wiring (issue #9)", () => {
  test("the server boots its OMP driver against the project-local agent dir", async () => {
    // Observable contract: main() creates data/omp-agent at boot (it exists
    // even before any compose mount) and hands it to the driver factory —
    // asserted at runtime through the factory seam, not by grepping source.
    rmSync(OMP_AGENT_DIR, { recursive: true, force: true });
    process.env.SLACK_APP_TOKEN = "xapp-test-token";
    process.env.SLACK_BOT_TOKEN = "xoxb-test-token";
    let receivedAgentDir: string | undefined;
    const server = main({
      createDriver: (agentDir) => {
        receivedAgentDir = agentDir;
        return createOmpSdkDriver({ agentDir, extensions: [] });
      },
    });
    expect(statSync(OMP_AGENT_DIR).isDirectory()).toBe(true);
    expect(receivedAgentDir).toBe(OMP_AGENT_DIR);
    await server.stop();
    mkdirSync(OMP_AGENT_DIR, { recursive: true }); // leave a clean tree behind
  });

  test("the agent dir constant points into the project data directory", () => {
    expect(OMP_AGENT_DIR).toBe("data/omp-agent");
    expect(existsSync(OMP_AGENT_DIR)).toBe(true);
  });
});
