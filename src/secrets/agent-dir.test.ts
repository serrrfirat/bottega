import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, statSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { OMP_AGENT_DIR, main } from "../server/index";

describe("agent dir wiring (issue #9)", () => {
  test("the server boots its OMP driver against the project-local agent dir", async () => {
    // Observable contract: main() creates data/omp-agent at boot (it exists
    // even before any compose mount) and hands it to the driver factory.
    rmSync(OMP_AGENT_DIR, { recursive: true, force: true });
    process.env.SLACK_APP_TOKEN = "xapp-test-token";
    process.env.SLACK_BOT_TOKEN = "xoxb-test-token";
    const server = main();
    expect(statSync(OMP_AGENT_DIR).isDirectory()).toBe(true);
    // The factory call in index.ts must pass the constant (source-level
    // contract: the driver would otherwise default to ~/.omp/agent).
    const indexSrc = readFileSync(resolve(import.meta.dir, "../server/index.ts"), "utf8");
    expect(indexSrc).toContain("agentDir: OMP_AGENT_DIR");
    await server.stop();
    mkdirSync(OMP_AGENT_DIR, { recursive: true }); // leave a clean tree behind
  });

  test("the agent dir constant points into the project data directory", () => {
    expect(OMP_AGENT_DIR).toBe("data/omp-agent");
    expect(existsSync(OMP_AGENT_DIR)).toBe(true);
  });
});
