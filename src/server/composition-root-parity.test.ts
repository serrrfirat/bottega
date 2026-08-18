/**
 * Composition-root parity test (issue #172): one test file proving the
 * three composition roots — server (src/server/index.ts `main`), executor
 * (src/executor.ts `bootExecutorRuntime`), MCP (src/mcp/server.ts
 * `bootMemoryMcpServer`) — produce IDENTICAL wiring for the shared chain
 * (store → audit → org policy → extension registry → effective surfaces →
 * extension runtime → memory provider, `bootstrapRuntime`, #153 item 2).
 *
 * Behavioral probes only — never source-grep (AGENTS.md):
 * - memory backend: `memory_backend.base_url` set → mem0 in ALL roots;
 *   unset → SQLite in ALL roots (regression for the MCP root's historical
 *   `createSqliteMemoryProvider` hardwire);
 * - registry contents: the same pinned snapshots register in every root;
 * - boundary: `authorize()` fails with the BROKER RESOLVER's error in
 *   every root — never the unwired-default error (regression for the MCP
 *   and executor roots' resolver-less boundaries);
 * - org-policy source: the same org settings drive the same policy in
 *   every root (DB-first over the config.yml floor).
 *
 * Hermetic: each root boots in its own temp cwd (real main()/boot
 * functions, real store, real registry) with a fail-closed transport seam
 * so tools-less manifests never touch the network; no Slack connection
 * (the server adapter is never started), no live services.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpBinding } from "../extensions/manifest";
import { resetToolSurfaceCache } from "../extensions/surface";
import { createStore, type ExtensionCredential } from "../store/db";
import type { OrgSettingsInput } from "../store/org-settings";
import type { PolicyConfig } from "../policy/config";
import { bootExecutorRuntime, type ExecutorBoot } from "../executor";
import { bootMemoryMcpServer, type McpBoot } from "../mcp/server";
import { main } from "./index";
import type { BootstrapRuntime } from "./bootstrap-runtime";

/** The committed pinned extension snapshots (issue #50) — copied into each
 * temp deployment root so every root boots the REAL registry. */
const EXTENSIONS_DIR = resolve(import.meta.dir, "../../config/extensions");

/** Every tools-less manifest's tools/list fails closed: zero network. */
const closedTransport = (_binding: McpBinding): Transport => {
  throw new Error("parity test: no external network");
};

/** A registry credential whose secret payload the broker would hold. */
const credential: ExtensionCredential = {
  id: "c1",
  provider: "github",
  identity_key: "ik",
  owner: null,
  scope: "org",
  broker_credential_id: 1,
  created_at: 1_700_000_000_000,
};

/** The broker resolver's fail-closed error (OMP_AUTH_BROKER_URL/TOKEN unset). */
const RESOLVER_ERROR = /broker secret resolution is not configured/;

interface RootWirings {
  server: BootstrapRuntime;
  executor: ExecutorBoot;
  mcp: McpBoot;
}

interface CaptureEnv {
  dir: string;
  cleanup(): void;
}

/**
 * One root's temp deployment root: fresh cwd, every boot knob absent
 * except the Slack tokens the server demands, config/extensions + config/
 * kb.yml + config/omp templates shipped (the same hermetic env the
 * boot-wiring tests use). Returns a cleanup that restores cwd + env.
 */
function tempEnv(restoreCwd: string): CaptureEnv {
  const dir = mkdtempSync(join(tmpdir(), "bottega-parity-"));
  const saved = {
    cwd: restoreCwd,
    app: process.env.SLACK_APP_TOKEN,
    bot: process.env.SLACK_BOT_TOKEN,
    configDir: process.env.BOTTEGA_CONFIG_DIR,
    dbPath: process.env.BOTTEGA_DB_PATH,
    extensionsDir: process.env.BOTTEGA_EXTENSIONS_DIR,
    spaceId: process.env.BOTTEGA_SPACE_ID,
    defaultPrincipal: process.env.BOTTEGA_MCP_DEFAULT_PRINCIPAL,
    sessionDir: process.env.BOTTEGA_SESSION_DIR,
    mem0Base: process.env.MEM0_BASE_URL,
    mem0Key: process.env.MEM0_API_KEY,
    brokerUrl: process.env.OMP_AUTH_BROKER_URL,
    brokerToken: process.env.OMP_AUTH_BROKER_TOKEN,
    proxyUrl: process.env.BOTTEGA_PROXY_CONTROL_URL,
    proxyToken: process.env.BOTTEGA_PROXY_CONTROL_TOKEN,
    gitTokenFile: process.env.EXECUTOR_GIT_TOKEN_FILE,
    modelKey: process.env.OPENCODE_API_KEY,
    nearKey: process.env.NEAR_API_KEY,
    callbackPort: process.env.BOTTEGA_CALLBACK_PORT,
  };
  process.chdir(dir);
  // Deployment config the boots read: the server needs the KB config, the
  // pin sync needs the config/omp template, every root reads the same
  // committed extension snapshots.
  mkdirSync(join(dir, "config", "extensions"), { recursive: true });
  for (const name of ["attio.json", "github.json", "linear.json"]) {
    copyFileSync(join(EXTENSIONS_DIR, name), join(dir, "config", "extensions", name));
  }
  mkdirSync(join(dir, "config", "omp"), { recursive: true });
  writeFileSync(join(dir, "config", "omp", "config.yml"), "modelRoles:\n  default: openai-codex/gpt-5.6-luna\n");
  writeFileSync(join(dir, "config", "kb.yml"), "sources:\n");
  process.env.SLACK_APP_TOKEN = "xapp-1-test";
  process.env.SLACK_BOT_TOKEN = "xoxb-test";
  // The browser-leg listener (startOAuthCallbackServer) must never inherit
  // the live .env's BOTTEGA_CALLBACK_PORT — the harness dev server holds
  // it, so booting against it is EADDRINUSE. Pin 0 (ephemeral, the #209
  // default) like every other setup knob this fixture scrubs.
  process.env.BOTTEGA_CALLBACK_PORT = "0";
  delete process.env.BOTTEGA_CONFIG_DIR;
  delete process.env.BOTTEGA_DB_PATH;
  delete process.env.BOTTEGA_EXTENSIONS_DIR;
  delete process.env.BOTTEGA_SPACE_ID;
  delete process.env.BOTTEGA_MCP_DEFAULT_PRINCIPAL;
  delete process.env.BOTTEGA_SESSION_DIR;
  delete process.env.MEM0_BASE_URL;
  delete process.env.MEM0_API_KEY;
  delete process.env.OMP_AUTH_BROKER_URL;
  delete process.env.OMP_AUTH_BROKER_TOKEN;
  delete process.env.BOTTEGA_PROXY_CONTROL_URL;
  delete process.env.BOTTEGA_PROXY_CONTROL_TOKEN;
  delete process.env.EXECUTOR_GIT_TOKEN_FILE;
  delete process.env.OPENCODE_API_KEY;
  delete process.env.NEAR_API_KEY;
  return {
    dir,
    cleanup() {
      process.chdir(saved.cwd);
      const restore = (key: keyof typeof saved, envName: string) => {
        const value = saved[key];
        if (value === undefined) delete process.env[envName];
        else process.env[envName] = value;
      };
      restore("app", "SLACK_APP_TOKEN");
      restore("bot", "SLACK_BOT_TOKEN");
      restore("configDir", "BOTTEGA_CONFIG_DIR");
      restore("dbPath", "BOTTEGA_DB_PATH");
      restore("extensionsDir", "BOTTEGA_EXTENSIONS_DIR");
      restore("spaceId", "BOTTEGA_SPACE_ID");
      restore("defaultPrincipal", "BOTTEGA_MCP_DEFAULT_PRINCIPAL");
      restore("sessionDir", "BOTTEGA_SESSION_DIR");
      restore("mem0Base", "MEM0_BASE_URL");
      restore("mem0Key", "MEM0_API_KEY");
      restore("brokerUrl", "OMP_AUTH_BROKER_URL");
      restore("brokerToken", "OMP_AUTH_BROKER_TOKEN");
      restore("proxyUrl", "BOTTEGA_PROXY_CONTROL_URL");
      restore("proxyToken", "BOTTEGA_PROXY_CONTROL_TOKEN");
      restore("gitTokenFile", "EXECUTOR_GIT_TOKEN_FILE");
      restore("modelKey", "OPENCODE_API_KEY");
      restore("nearKey", "NEAR_API_KEY");
      restore("callbackPort", "BOTTEGA_CALLBACK_PORT");
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Seeds the org settings blob the way a deployment would (DB is the source
 * of truth, issue #67): the root's bootstrapRuntime opens the same file
 * and reads these settings at boot.
 */
function seedSettings(settings: OrgSettingsInput): void {
  const store = createStore("data/bottega.db");
  store.setOrgSettings(settings);
  store.close();
}

/** Boots all three roots in their own temp cwd with the same settings. */
async function captureWirings(settings: OrgSettingsInput): Promise<RootWirings> {
  const envs: CaptureEnv[] = [];
  const originalCwd = process.cwd();
  try {
    // Server root: a real main() with the wiring seam. The boundary gets
    // an explicit ABSOLUTE temp secrets dir (issue #191): the boots chdir
    // into their temp root, but authorize() runs AFTER cleanup restored
    // the repo cwd — the relative default "data/proxy-secrets" would
    // resolve to the LIVE production dir and clobber github.secret.
    const serverEnv = tempEnv(originalCwd);
    envs.push(serverEnv);
    seedSettings(settings);
    let server: BootstrapRuntime | undefined;
    const serverBoot = await main({
      agentDir: join(serverEnv.dir, "agent"),
      surfaceTransport: closedTransport,
      boundary: { secretsDir: join(serverEnv.dir, "data", "proxy-secrets") },
      onRuntimeWiring: (wiring) => {
        server = wiring;
      },
    });
    await serverBoot.stop();
    if (server === undefined) throw new Error("server main() never reported its runtime wiring");

    // Executor root: the real boot function (shared chain + pin + getters).
    const executorEnv = tempEnv(originalCwd);
    envs.push(executorEnv);
    seedSettings(settings);
    const executor = await bootExecutorRuntime({
      agentDir: join(executorEnv.dir, "agent"),
      mcpTransport: closedTransport,
      boundary: { secretsDir: join(executorEnv.dir, "data", "proxy-secrets") },
    });

    // MCP root: the real boot function (shared chain + policy overlay + server).
    const mcpEnv = tempEnv(originalCwd);
    envs.push(mcpEnv);
    seedSettings(settings);
    const mcp = await bootMemoryMcpServer({
      mcpTransport: closedTransport,
      boundary: { secretsDir: join(mcpEnv.dir, "data", "proxy-secrets") },
    });

    return { server, executor, mcp };
  } finally {
    for (const env of envs) env.cleanup();
  }
}

function registryIds(rt: BootstrapRuntime): string[] {
  return rt.registry.list().map((entry) => entry.manifest.id);
}

describe("composition-root parity (issue #172)", () => {
  beforeEach(() => {
    // Discovery is cached per manifest id + binding and the cache is
    // process-global: hermetic tests injecting their OWN transport must
    // not observe a stale surface from an earlier fixture (issue #167).
    resetToolSurfaceCache();
  });

  test("memory_backend.base_url set → mem0 in ALL three roots (regression: the MCP root hardwired SQLite, #172)", async () => {
    const { server, executor, mcp } = await captureWirings({
      memory_backend: { base_url: "http://mem0.internal:9000" },
    });
    expect(server.memoryProvider.backend).toBe("mem0");
    expect(executor.runtime.memoryProvider.backend).toBe("mem0");
    expect(mcp.runtime.memoryProvider.backend).toBe("mem0");
  });

  test("memory_backend.base_url unset → SQLite sharing the store DB in ALL three roots", async () => {
    const { server, executor, mcp } = await captureWirings({});
    expect(server.memoryProvider.backend).toBe("sqlite");
    expect(executor.runtime.memoryProvider.backend).toBe("sqlite");
    expect(mcp.runtime.memoryProvider.backend).toBe("sqlite");
    // SQLite shares the boot store's database handle — one memory pool per
    // root process.
    expect(server.memoryProvider.save).toBeDefined();
  });

  test("all three roots register the same extension registry contents", async () => {
    const { server, executor, mcp } = await captureWirings({});
    const expected = ["attio", "github", "linear"];
    expect(registryIds(server)).toEqual(expected);
    expect(registryIds(executor.runtime)).toEqual(expected);
    expect(registryIds(mcp.runtime)).toEqual(expected);
  });

  test("every root's extension boundary carries the broker secret resolver (regression: the MCP and executor boundaries were resolver-less, #172)", async () => {
    const { server, executor, mcp } = await captureWirings({});
    for (const [name, rt] of [
      ["server", server],
      ["executor", executor.runtime],
      ["mcp", mcp.runtime],
    ] as const) {
      // The resolver's OWN fail-closed error proves the resolver is wired:
      // an unwired boundary fails with the default "no broker secret
      // resolver wired" message instead (UNWIRED_ERROR must never match).
      await expect(rt.boundary.authorize(credential), `${name} boundary`).rejects.toThrow(RESOLVER_ERROR);
    }
  });

  test("secrets_backend: 1password-connect wires the Connect resolver into every root's boundary (issue #190)", async () => {
    // Stub Connect server: serves one item field; every root's boundary
    // must resolve the SAME secret from it (the org's configured backend).
    const seen: Array<{ path: string; auth: string | null }> = [];
    const connect = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const url = new URL(req.url);
        seen.push({ path: url.pathname, auth: req.headers.get("authorization") });
        return new Response(
          JSON.stringify({ id: "i", title: "t", category: "LOGIN", fields: [{ id: "f", label: "f", value: "parity-secret" }] }),
          { headers: { "content-type": "application/json" } },
        );
      },
    });
    const beforeToken = process.env.OP_CONNECT_TOKEN;
    process.env.OP_CONNECT_TOKEN = "parity-connect-token";
    try {
      const { server, executor, mcp } = await captureWirings({
        secrets_backend: {
          type: "1password-connect",
          connect_url: `http://127.0.0.1:${connect.port}`,
          mapping: { "github:ik": { vault: "v", item: "i", field: "f" } },
        },
      });
      // authorize() resolves from the stub and writes the secret file —
      // proving the configured backend (not the broker default) was wired.
      await server.boundary.authorize(credential);
      await executor.runtime.boundary.authorize(credential);
      await mcp.runtime.boundary.authorize(credential);
      expect(seen).toHaveLength(3);
      for (const request of seen) {
        expect(request.path).toBe("/v1/vaults/v/items/i");
        expect(request.auth).toBe("Bearer parity-connect-token");
      }
    } finally {
      connect.stop(true);
      if (beforeToken === undefined) delete process.env.OP_CONNECT_TOKEN;
      else process.env.OP_CONNECT_TOKEN = beforeToken;
    }
  });

  test("all three roots load the same org-policy source from the same settings (DB-first over the config.yml floor)", async () => {
    const { server, executor, mcp } = await captureWirings({
      response_mode: "mention",
      approvals: { timeout_minutes: 9 },
    });
    const policies: PolicyConfig[] = [
      server.orgPolicy,
      executor.runtime.orgPolicy,
      mcp.runtime.orgPolicy,
    ];
    for (const policy of policies) {
      expect(policy.responseMode).toBe("mention");
      expect(policy.timeoutMinutes).toBe(9);
    }
    expect(policies[0]).toEqual(policies[1]);
    expect(policies[1]).toEqual(policies[2]);
  });
});
