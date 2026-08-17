/**
 * Caller-level executor boot-wiring test (issue #172): the executor
 * analogue of src/server/boot-wiring.test.ts. Drives the real boot path —
 * bootExecutorRuntime (the shared chain via bootstrapRuntime + the
 * agent-dir modelRoles pin sync) and prepareExecutor (config resolution,
 * stale-run recovery, askpass install) — in a temp cwd and observes from
 * the caller:
 * - the worker toolset: memory tools + extension tools wired to the boot
 *   runtime, the extension half carrying the DISCOVERED provider surface
 *   (issue #158/#167 — a github tools/list served in-memory);
 * - the agent-dir pin: a fresh agent dir gets the modelRoles pin
 *   ("created", issue #78);
 * - the model guard: assertAgentDirModelAvailable resolves — the same
 *   fail-fast call runExecutor makes before the claim loop (issue #80);
 * - the driver getter: resolves to the OMP SDK driver built over the
 *   worker toolset (pre-approved gate, memory tools under it).
 *
 * Hermetic: temp cwd + fake env, no network (the github surface is served
 * through an in-memory transport; linear/attio fail closed and are
 * skipped, issue #166), no live services, no real PAT (a dummy mode-0600
 * file satisfies the credential-boundary guard).
 */
import { describe, expect, test, beforeEach } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpBinding } from "./extensions/manifest";
import { resetToolSurfaceCache } from "./extensions/surface";
import { bootExecutorRuntime, prepareExecutor, type ExecutorDeps } from "./executor";
import { assertAgentDirModelAvailable } from "./server/drivers/agent-driver";

const EXTENSIONS_DIR = resolve(import.meta.dir, "../config/extensions");

interface ExecutorEnv {
  dir: string;
  agentDir: string;
  cleanup(): void;
}

/** Temp cwd with the executor's deployment files shipped. */
function tempEnv(): ExecutorEnv {
  const dir = mkdtempSync(join(tmpdir(), "bottega-executor-boot-"));
  const agentDir = join(dir, "agent");
  const saved = {
    cwd: process.cwd(),
    configDir: process.env.BOTTEGA_CONFIG_DIR,
    dbPath: process.env.BOTTEGA_DB_PATH,
    extensionsDir: process.env.BOTTEGA_EXTENSIONS_DIR,
    mem0Base: process.env.MEM0_BASE_URL,
    gitTokenFile: process.env.EXECUTOR_GIT_TOKEN_FILE,
  };
  process.chdir(dir);
  mkdirSync(join(dir, "config", "extensions"), { recursive: true });
  for (const name of ["attio.json", "github.json", "linear.json"]) {
    copyFileSync(join(EXTENSIONS_DIR, name), join(dir, "config", "extensions", name));
  }
  mkdirSync(join(dir, "config", "omp"), { recursive: true });
  writeFileSync(join(dir, "config", "omp", "config.yml"), "modelRoles:\n  default: opencode-go/deepseek-v4-flash\n");
  // The credential-boundary guard (issue #9): the PAT lives in a file.
  mkdirSync(join(dir, "data", "secrets"), { recursive: true });
  writeFileSync(join(dir, "data", "secrets", "github-pat"), "pat-placeholder\n", { mode: 0o600 });
  delete process.env.BOTTEGA_CONFIG_DIR;
  delete process.env.BOTTEGA_DB_PATH;
  delete process.env.BOTTEGA_EXTENSIONS_DIR;
  delete process.env.MEM0_BASE_URL;
  delete process.env.EXECUTOR_GIT_TOKEN_FILE;
  return {
    dir,
    agentDir,
    cleanup() {
      process.chdir(saved.cwd);
      const restore = (key: keyof typeof saved, envName: string) => {
        const value = saved[key];
        if (value === undefined) delete process.env[envName];
        else process.env[envName] = value;
      };
      restore("configDir", "BOTTEGA_CONFIG_DIR");
      restore("dbPath", "BOTTEGA_DB_PATH");
      restore("extensionsDir", "BOTTEGA_EXTENSIONS_DIR");
      restore("mem0Base", "MEM0_BASE_URL");
      restore("gitTokenFile", "EXECUTOR_GIT_TOKEN_FILE");
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** GitHub's hosted MCP server served in-memory; linear/attio fail closed (skipped, #166). */
function githubSurfaceTransport(binding: McpBinding): Transport {
  const url = binding.transport === "streamable-http" ? (binding.serverUrl ?? "") : "";
  if (url.includes("github")) {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const mcp = new Server({ name: "github-stub", version: "1.0.0" }, { capabilities: { tools: {} } });
    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "search_issues",
          description: "Search issues",
          inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
        },
      ],
    }));
    void mcp.connect(serverTransport);
    return clientTransport;
  }
  throw new Error(`invalid_token: no credential connected for ${url}`);
}

describe("executor boot wiring (issue #172 — caller-level, boot-wiring.test.ts analogue)", () => {
  beforeEach(() => {
    resetToolSurfaceCache();
  });

  test("the real boot path wires the worker toolset, the agent-dir pin, and the model guard", async () => {
    const env = tempEnv();
    try {
      // The composition root: shared chain (store → audit → org policy →
      // registry → surfaces → runtime → memory provider) + pin sync +
      // memoized getters, exactly what the entrypoint runs.
      const boot = await bootExecutorRuntime({
        agentDir: env.agentDir,
        mcpTransport: githubSurfaceTransport,
      });

      // Runtime knobs (issue #67): the org settings blob is the source of
      // truth for repos/workspaces — prepareExecutor reads it.
      boot.runtime.store.setOrgSettings({
        workspaces_dir: join(env.dir, "workspaces"),
        git_base_url: "https://github.com",
        api_base_url: "https://api.github.com",
        repos: ["acme/sandbox"],
      });

      // The deps object exactly as the executor entrypoint builds it.
      let driver: ExecutorDeps["driver"];
      const deps: ExecutorDeps = {
        store: boot.runtime.store,
        get driver() {
          return (driver ??= boot.getDriver());
        },
        getExtensionWorkerToolset: boot.getExtensionWorkerToolset,
        orgConfigDir: "config",
      };

      // prepareExecutor: config resolution + stale-run recovery + askpass.
      const cfg = await prepareExecutor(deps);
      expect(cfg.repoAllowlist).toEqual(["acme/sandbox"]);
      expect(cfg.gitBaseUrl).toBe("https://github.com");
      expect(cfg.askpassScript).toBe("data/secrets/git-askpass.sh");

      // Agent-dir pin (issue #78): a fresh agent dir gets the modelRoles
      // pin from config/omp — the session can never silently drift to the
      // provider catalog default.
      const agentConfig = readFileSync(join(env.agentDir, "config.yml"), "utf8");
      expect(agentConfig).toContain("modelRoles");
      expect(agentConfig).toContain("opencode-go/deepseek-v4-flash");

      // Worker toolset: memory tools ride the driver's policy gate; the
      // extension half carries the DISCOVERED github surface (issue #167 —
      // the full resolved surface, never an empty or stale subset).
      const toolset = await boot.getExtensionWorkerToolset();
      const memoryNames = toolset.memoryTools.map((tool) => tool.name);
      expect(memoryNames).toContain("memory.save");
      expect(memoryNames).toContain("memory.search");
      const extensionNames = toolset.extensionTools.map((tool) => tool.name);
      expect(extensionNames).toContain("github.search_issues");
      expect(extensionNames.some((name) => name.startsWith("linear."))).toBe(false);

      // Model guard (issue #80): the same fail-fast call runExecutor makes
      // before the claim loop — resolves here (lenient leg: no models.yml).
      await expect(assertAgentDirModelAvailable(env.agentDir)).resolves.toBeTypeOf("number");

      // Driver getter: resolves to the OMP SDK driver built over the
      // worker toolset (pre-approved gate, memory tools under it).
      const resolvedDriver = await deps.driver;
      expect(resolvedDriver.createSession).toEqual(expect.any(Function));
    } finally {
      env.cleanup();
    }
  });
});
