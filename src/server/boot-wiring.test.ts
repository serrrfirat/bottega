/**
 * Caller-level boot-wiring test (testing-gaps audit 2026-08-17): drives a
 * REAL main() in a temp cwd and asserts the boot wiring the audit found
 * untested from the caller — the scheduler (#111) and KB (#91) integration:
 *
 * - the scheduler registry is wired into the session toolset: the
 *   create_scheduler_job tool accepts every registered action and persists
 *   a durable job through the boot-wired store (a registry that dropped an
 *   action would reject it here);
 * - the KB ingest tool rides the custom-tools bridge (kb_ingest present,
 *   write-tier, KB-shaped);
 * - the boot-time pin sync runs (fresh agent dir gets the modelRoles pin),
 *   and a missing Slack token fails the boot closed.
 *
 * Hermetic: temp cwd + fake env, no Slack network (the adapter is never
 * started — the scheduler/onboarding paths the boot exposes need no
 * sessions), no live services. Same shape as onboarding-boot.test.ts (#116).
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentToolResult, ExtensionContext, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";
import { createStore } from "../store/db";
import type { SchedulerJob } from "../scheduler/types";
import type { McpBinding } from "../extensions/manifest";
import type { ExtensionSurfaces } from "../extensions/surface";
import type { McpOAuthTokenStore } from "../extensions/mcp-oauth";
import { resetToolSurfaceCache } from "../extensions/surface";
import { opencodeSafeToolName } from "./drivers/agent-driver";
import { main } from "./index";

/** The committed pinned extension snapshots (issue #50) — copied into the
 * temp deployment root so a hermetic boot loads the real tools-less
 * manifests instead of an empty registry. */
const EXTENSIONS_DIR = resolve(import.meta.dir, "../../config/extensions");

const jsonRpcRequestSchema = z.object({
  jsonrpc: z.string(),
  id: z.number().optional(),
  method: z.string(),
});
const extensionManifestDocumentSchema = z
  .object({
    manifest: z
      .object({
        mcp: z.object({ serverUrl: z.string() }).passthrough(),
      })
      .passthrough(),
  })
  .passthrough();

/** The scheduler tool execute never touches a session context. */
// SAFETY: scheduler tool executes ignore their ExtensionContext; the empty
// object only fills the required parameter position.
const unusedContext = {} as ExtensionContext;

interface BootEnv {
  dir: string;
  cleanup(): void;
}

/**
 * Temp cwd with the env a fresh deployment sees: Slack tokens present (the
 * server needs them to boot), every OTHER setup knob absent so the boot
 * runs the default paths deterministically.
 */
function tempEnv(): BootEnv {
  const dir = mkdtempSync(join(tmpdir(), "bottega-boot-wiring-"));
  const saved = {
    cwd: process.cwd(),
    app: process.env.SLACK_APP_TOKEN,
    bot: process.env.SLACK_BOT_TOKEN,
    configDir: process.env.BOTTEGA_CONFIG_DIR,
    dbPath: process.env.BOTTEGA_DB_PATH,
    modelKey: process.env.OPENCODE_API_KEY,
    nearKey: process.env.NEAR_API_KEY,
    broker: process.env.OMP_AUTH_BROKER_TOKEN,
    gitTokenFile: process.env.EXECUTOR_GIT_TOKEN_FILE,
    callbackPort: process.env.BOTTEGA_CALLBACK_PORT,
  };
  process.chdir(dir);
  // The server boots the KB config (issue #91): a fresh deployment root
  // ships the empty-sources config like the committed config/kb.yml.
  mkdirSync(join(dir, "config"));
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
  delete process.env.OPENCODE_API_KEY;
  delete process.env.NEAR_API_KEY;
  delete process.env.OMP_AUTH_BROKER_TOKEN;
  delete process.env.EXECUTOR_GIT_TOKEN_FILE;
  return {
    dir,
    cleanup() {
      process.chdir(saved.cwd);
      if (saved.app === undefined) delete process.env.SLACK_APP_TOKEN;
      else process.env.SLACK_APP_TOKEN = saved.app;
      if (saved.bot === undefined) delete process.env.SLACK_BOT_TOKEN;
      else process.env.SLACK_BOT_TOKEN = saved.bot;
      if (saved.configDir === undefined) delete process.env.BOTTEGA_CONFIG_DIR;
      else process.env.BOTTEGA_CONFIG_DIR = saved.configDir;
      if (saved.dbPath === undefined) delete process.env.BOTTEGA_DB_PATH;
      else process.env.BOTTEGA_DB_PATH = saved.dbPath;
      if (saved.modelKey === undefined) delete process.env.OPENCODE_API_KEY;
      else process.env.OPENCODE_API_KEY = saved.modelKey;
      if (saved.nearKey === undefined) delete process.env.NEAR_API_KEY;
      else process.env.NEAR_API_KEY = saved.nearKey;
      if (saved.broker === undefined) delete process.env.OMP_AUTH_BROKER_TOKEN;
      else process.env.OMP_AUTH_BROKER_TOKEN = saved.broker;
      if (saved.gitTokenFile === undefined) delete process.env.EXECUTOR_GIT_TOKEN_FILE;
      else process.env.EXECUTOR_GIT_TOKEN_FILE = saved.gitTokenFile;
      if (saved.callbackPort === undefined) delete process.env.BOTTEGA_CALLBACK_PORT;
      else process.env.BOTTEGA_CALLBACK_PORT = saved.callbackPort;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function textOf(result: AgentToolResult): string {
  return result.content.find((block) => block.type === "text")?.text ?? "";
}

/**
 * A github tools/list response of `count` wire tools; the first three are
 * the #148 live-verified hosted names (search_issues, issue_write,
 * add_issue_comment), the rest are synthetic valid wire identifiers. The
 * real hosted server's surface is 44 tools — the count matters, the exact
 * tail names do not.
 */
function githubWireTools(count: number): Array<{
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, { type: string }> };
}> {
  const special = ["search_issues", "issue_write", "add_issue_comment"];
  const tools: Array<{
    name: string;
    description: string;
    inputSchema: { type: "object"; properties: Record<string, { type: string }> };
  }> = [];
  for (let i = 0; i < count; i++) {
    const wire = i < special.length ? special[i]! : `github_tool_${i}`;
    tools.push({
      name: wire,
      description: `GitHub ${wire}`,
      inputSchema: { type: "object", properties: { query: { type: "string" } } },
    });
  }
  return tools;
}

describe("boot wiring (scheduler #111 + KB #91, caller-level)", () => {
  beforeEach(() => {
    // Discovery is cached per manifest id + binding and the cache is
    // process-global: hermetic tests injecting their OWN transport must
    // not observe a stale surface from an earlier fixture (issue #167 —
    // the full-suite flake was a prior test's github discovery poisoning
    // boot-wiring's eager-discovery assertion). Same contract as
    // providers.test.ts and surface.test.ts.
    resetToolSurfaceCache();
  });

  test("the scheduler registry and KB ingest tool are wired into the session toolset", async () => {
    const env = tempEnv();
    try {
      // Ship the agent-config template so the boot-time pin sync (issue
      // #78) takes the "created" path: the fresh agent dir gets a config
      // with the modelRoles pin instead of starting bare.
      mkdirSync(join(env.dir, "config", "omp"), { recursive: true });
      writeFileSync(
        join(env.dir, "config", "omp", "config.yml"),
        "modelRoles:\n  default: openai-codex/gpt-5.6-luna\n",
      );
      const agentDir = join(env.dir, "agent");
      let toolset: ToolDefinition[] | undefined;
      const server = await main({
        agentDir,
        onSessionToolset: (tools) => {
          toolset = tools;
        },
      });

      // The session toolset was captured — the seam fired during boot.
      expect(toolset).toBeDefined();
      const tools = toolset!;

      // KB wiring (issue #91): the ingest tool rides the custom-tools
      // bridge the space agent sees.
      const kb = tools.find((tool) => tool.name === "kb_ingest");
      expect(kb).toBeDefined();
      expect(kb!.approval).toBe("write");
      expect(kb!.label).toBe("Ingest knowledge base");
      expect(kb!.description).toContain("docs/wiki sources");

      // Scheduler wiring (issue #111): the admin tools are registered and
      // the registry accepts every typed action — job creation through the
      // boot-wired toolset persists durable rows in the boot store. A
      // registry that dropped one of the actions would return a tool error
      // instead of a job.
      const createJob = tools.find((tool) => tool.name === "create_scheduler_job");
      const listJobs = tools.find((tool) => tool.name === "list_scheduler_jobs");
      const deleteJob = tools.find((tool) => tool.name === "delete_scheduler_job");
      const updateJob = tools.find((tool) => tool.name === "update_scheduler_job");
      const pauseJob = tools.find((tool) => tool.name === "pause_scheduler_job");
      const resumeJob = tools.find((tool) => tool.name === "resume_scheduler_job");
      const runNow = tools.find((tool) => tool.name === "run_scheduler_job_now");
      expect(createJob).toBeDefined();
      expect(listJobs).toBeDefined();
      expect(deleteJob).toBeDefined();
      expect(updateJob).toBeDefined();
      expect(pauseJob).toBeDefined();
      expect(resumeJob).toBeDefined();
      expect(runNow).toBeDefined();

      // Operator read wiring (#161/#320): the real boot toolset exposes both
      // read-only surfaces, rather than only their helper definitions.
      expect(tools.find((tool) => tool.name === "audit_search")?.approval).toBe("read");
      expect(tools.find((tool) => tool.name === "explain_policy")?.approval).toBe("read");

      const actions = ["standup_digest", "reflection", "org_pulse", "governance_digest"] as const;
      const created: Array<{ action: string; cron: string }> = [];
      for (const action of actions) {
        // Issue #220: space-scoped actions (standup_digest, reflection)
        // fail closed without a destination, and the boot harness has no
        // session ctx to derive one from — bind an explicit target space.
        // org_pulse ignores the space and stays org-wide.
        const result = await createJob!.execute(
          "boot-1",
          { action, cron: "0 9 * * 1-5", space: "slack:C-boot" },
          undefined,
          undefined,
          unusedContext,
        );
        expect(result.isError).not.toBe(true);
        // SAFETY: create_scheduler_job returns JSON.stringify({...job,
        // summary}) — a SchedulerJob row (plus user-facing summary) whose
        // identifying fields are action + cron.
        created.push(JSON.parse(textOf(result)) as SchedulerJob);
      }
      expect(created.map((job) => job.action).sort()).toEqual([...actions].sort());

      await server.stop();

      // The jobs are durable in the boot-wired store (data/bottega.db in
      // the temp cwd), so the wiring is the real boot store, not a stub.
      const reopened = createStore("data/bottega.db");
      const jobs = await reopened.listSchedulerJobs();
      expect(jobs.map((job) => job.action).sort()).toEqual([...actions].sort());
      expect(jobs.every((job) => job.cron === "0 9 * * 1-5")).toBe(true);
      expect(jobs.every((job) => job.enabled)).toBe(true);
      reopened.close();
    } finally {
      env.cleanup();
    }
  });

  test("a missing Slack token fails the boot closed", async () => {
    const env = tempEnv();
    try {
      delete process.env.SLACK_APP_TOKEN;
      await expect(main({ agentDir: join(env.dir, "agent") })).rejects.toThrow(
        "SLACK_APP_TOKEN and SLACK_BOT_TOKEN are required",
      );
    } finally {
      env.cleanup();
    }
  });

  test("an auth-gated tools-less provider never fails the boot — skipped, reachable providers discover eagerly (issue #166)", async () => {
    const env = tempEnv();
    try {
      // Ship the committed tools-less snapshots (linear/github/attio)
      // into the temp deployment root so the registry resolves the REAL
      // manifests — the empty-registry path would make the test vacuous.
      mkdirSync(join(env.dir, "config", "extensions"), { recursive: true });
      for (const name of ["attio.json", "github.json", "linear.json"]) {
        copyFileSync(join(EXTENSIONS_DIR, name), join(env.dir, "config", "extensions", name));
      }
      // Ship the agent-config template so the boot-time pin sync (issue
      // #78) takes the "created" path (same as the scheduler test above).
      mkdirSync(join(env.dir, "config", "omp"), { recursive: true });
      writeFileSync(
        join(env.dir, "config", "omp", "config.yml"),
        "modelRoles:\n  default: openai-codex/gpt-5.6-luna\n",
      );

      // GitHub's hosted MCP server is reachable (tools/list served by an
      // in-memory stub); Linear/Attio are auth-gated — tools/list 401s
      // without a credential. Discovery must not fail the boot: linear and
      // attio are skipped (deferred to the runtime's lazy per-call path),
      // github resolves eagerly.
      const seen = { list: 0 };
      let surfaces: ExtensionSurfaces | undefined;
      const server = await main({
        agentDir: join(env.dir, "agent"),
        surfaceTransport: (binding: McpBinding): Transport => {
          const url = binding.transport === "streamable-http" ? (binding.serverUrl ?? "") : "";
          if (url.includes("github")) {
            seen.list += 1;
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
          // Auth-gated: the provider 401s tools/list without a credential.
          throw new Error(`invalid_token: no credential connected for ${url}`);
        },
        onExtensionSurfaces: (resolved) => {
          surfaces = resolved;
        },
      });
      await server.stop();

      // The boot threaded only the RESOLVED surfaces: github discovered
      // eagerly at boot, linear/attio skipped (absent → the runtime's
      // lazy per-call path fails closed if a call is attempted — their
      // MCPs are OAuth-gated, so tools/list 401s without a credential).
      expect(surfaces).toBeDefined();
      expect(surfaces!.has("github")).toBe(true);
      expect(surfaces!.get("github")!.map((tool) => tool.name)).toEqual(["github.search_issues"]);
      expect(surfaces!.has("linear")).toBe(false);
      expect(surfaces!.has("attio")).toBe(false);
      expect(seen.list).toBe(1); // one tools/list at boot, cached
    } finally {
      env.cleanup();
    }
  });

  test("a boot-resolved github surface reaches the session toolset in FULL — all 44 discovered tools, wire names intact (issue #167)", async () => {
    const env = tempEnv();
    try {
      // Ship the committed tools-less snapshots (linear/github/attio)
      // into the temp deployment root so the registry resolves the REAL
      // manifests — the empty-registry path would make the test vacuous.
      mkdirSync(join(env.dir, "config", "extensions"), { recursive: true });
      for (const name of ["attio.json", "github.json", "linear.json"]) {
        copyFileSync(join(EXTENSIONS_DIR, name), join(env.dir, "config", "extensions", name));
      }
      // Ship the agent-config template so the boot-time pin sync (issue
      // #78) takes the "created" path (same as the other boot tests).
      mkdirSync(join(env.dir, "config", "omp"), { recursive: true });
      writeFileSync(
        join(env.dir, "config", "omp", "config.yml"),
        "modelRoles:\n  default: openai-codex/gpt-5.6-luna\n",
      );

      // The hosted GitHub server's real wire surface — the #148 live leg
      // measured 44 tools — served through the in-memory seam (the
      // search_issues / issue_write / add_issue_comment names are the
      // #148 live-verified wire names).
      const wireTools = githubWireTools(44);
      let surfaces: ExtensionSurfaces | undefined;
      let definitions: ToolDefinition[] | undefined;
      const server = await main({
        agentDir: join(env.dir, "agent"),
        surfaceTransport: (binding: McpBinding): Transport => {
          const url = binding.transport === "streamable-http" ? (binding.serverUrl ?? "") : "";
          if (url.includes("github")) {
            const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
            const mcp = new Server({ name: "github-stub", version: "1.0.0" }, { capabilities: { tools: {} } });
            mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: wireTools }));
            void mcp.connect(serverTransport);
            return clientTransport;
          }
          // Auth-gated: linear/attio 401 tools/list without a credential.
          throw new Error(`invalid_token: no credential connected for ${url}`);
        },
        onExtensionSurfaces: (resolved) => {
          surfaces = resolved;
        },
        onExtensionToolset: (tools) => {
          definitions = tools;
        },
      });
      await server.stop();

      // Discovery restored the FULL provider surface — all 44 tools, with
      // the #148 wire names (providerName) intact for the bridge to forward
      // on every call.
      expect(surfaces).toBeDefined();
      const githubSurface = surfaces!.get("github");
      expect(githubSurface).toBeDefined();
      expect(githubSurface).toHaveLength(44);
      const providerNames = githubSurface!.map((tool) => tool.providerName);
      expect(providerNames).toContain("search_issues");
      expect(providerNames).toContain("issue_write");
      expect(providerNames).toContain("add_issue_comment");

      // The session toolset carries ONE definition per discovered tool —
      // the full surface lands in the space agent's session, never a
      // truncated or stale subset (the reported "only search_issues" gap).
      expect(definitions).toBeDefined();
      const github = definitions!.filter((tool) => tool.name.startsWith("github."));
      expect(github).toHaveLength(44);
      const names = new Set(github.map((tool) => tool.name));
      expect(names.has("github.search_issues")).toBe(true);
      expect(names.has("github.issue_write")).toBe(true);
      expect(names.has("github.add_issue_comment")).toBe(true);
      // The session flattens model-facing names for the gateway (issue
      // #78): the model sees github_issue_write / github_add_issue_comment.
      expect(opencodeSafeToolName("github.issue_write")).toBe("github_issue_write");
      expect(opencodeSafeToolName("github.add_issue_comment")).toBe("github_add_issue_comment");
      // Every definition carries a tier — nothing lands ungated.
      expect(
        github.every((tool) => tool.approval === "read" || tool.approval === "write" || tool.approval === "exec"),
      ).toBe(true);
    } finally {
      env.cleanup();
    }
  });

  test("an authenticated tools-less OAuth MCP receives an SDK OAuthClientProvider at boot discovery — the persisted credential's tool lands (issue #284)", async () => {
    const env = tempEnv();
    try {
      // Ship the agent-config template so the boot-time pin sync (issue
      // #78) takes the "created" path (same as the other boot tests).
      mkdirSync(join(env.dir, "config", "omp"), { recursive: true });
      writeFileSync(
        join(env.dir, "config", "omp", "config.yml"),
        "modelRoles:\n  default: openai-codex/gpt-5.6-luna\n",
      );
      // A tools-less hosted OAuth MCP manifest in the temp deployment root
      // (the #231 pattern: no pinned tools — the surface is discovered from
      // tools/list at boot, AUTHENTICATED through the persisted credential).
      const OAUTH_ID = "fixture.oauthboot";
      mkdirSync(join(env.dir, "config", "extensions"), { recursive: true });
      writeFileSync(
        join(env.dir, "config", "extensions", `${OAUTH_ID}.json`),
        JSON.stringify(
          {
            schema: "bottega.extension-snapshot.v1",
            extensionId: OAUTH_ID,
            pinnedAt: "2026-08-20T00:00:00.000Z",
            source: { catalog: "canary://fixture", specId: OAUTH_ID, vendorOfficial: true, reviewed: false },
            manifest: {
              id: OAUTH_ID,
              label: "Fixture OAuth Boot",
              vendor: "bottega-fixtures",
              kind: "mcp",
              mcp: { serverUrl: "http://127.0.0.1:0/mcp", transport: "streamable-http" },
              credentialSchema: { type: "oauth", scopes: ["read"] },
              domains: ["mcp.oauthboot.example.com"],
              credentialTargets: [{ host: "mcp.oauthboot.example.com", pathPrefix: "/mcp" }],
            },
          },
          null,
          2,
        ) + "\n",
      );
      // A fake authenticated MCP server: tools/list REQUIRES the bearer the
      // SDK's OAuthClientProvider supplies — a token-less request is 401.
      const seenAuth: string[] = [];
      const mcp = Bun.serve({
        port: 0,
        fetch: async (req) => {
          if (req.method !== "POST" || !new URL(req.url).pathname.startsWith("/mcp")) {
            return new Response("", { status: 404 });
          }
          const authorization = req.headers.get("authorization") ?? "";
          if (authorization === "") {
            return new Response("", { status: 401, headers: { "WWW-Authenticate": "Bearer" } });
          }
          seenAuth.push(authorization);
          const body = jsonRpcRequestSchema.parse(await req.json());
          if (body.method === "initialize") {
            return Response.json({
              jsonrpc: "2.0",
              id: body.id,
              result: {
                protocolVersion: "2024-11-05",
                capabilities: { tools: {} },
                serverInfo: { name: "oauthboot-stub", version: "1.0.0" },
              },
            });
          }
          if (body.method === "tools/list") {
            return Response.json({
              jsonrpc: "2.0",
              id: body.id,
              result: {
                tools: [{ name: "oauthboot.ping", description: "Authenticated stub ping", inputSchema: { type: "object", properties: {} } }],
              },
            });
          }
          return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "unknown method" } });
        },
      });
      // Patch the manifest's placeholder serverUrl to the live stub port.
      const manifestPath = join(env.dir, "config", "extensions", `${OAUTH_ID}.json`);
      const manifest = extensionManifestDocumentSchema.parse(
        JSON.parse(readFileSync(manifestPath, "utf8")),
      );
      manifest.manifest.mcp.serverUrl = `http://127.0.0.1:${mcp.port}/mcp`;
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
      // Pre-seed the boot store's PERSISTED extension credential (the
      // surface auth provider reads exactly this row).
      const seeded = createStore("data/bottega.db");
      await seeded.upsertExtensionCredential({
        provider: OAUTH_ID,
        identityKey: `oauth:${OAUTH_ID}`,
        owner: null,
        scope: "org",
        brokerCredentialId: 42,
      });
      seeded.close();
      // The vault-backed token store the persisted credential resolves to.
      const vault: McpOAuthTokenStore = {
        async load(provider, brokerCredentialId) {
          if (provider === OAUTH_ID && brokerCredentialId === 42) {
            return { type: "oauth", access: "access-boot-1", refresh: "refresh-boot-1", expires: Date.now() + 3_600_000 };
          }
          return null;
        },
        async save(_provider, _credential) {
          return { brokerCredentialId: 42 };
        },
      };
      let surfaces: ExtensionSurfaces | undefined;
      let definitions: ToolDefinition[] | undefined;
      const server = await main({
        agentDir: join(env.dir, "agent"),
        // NO surfaceTransport seam: the production defaultMcpTransport
        // (with the boot-built authProvider) drives the discovery through
        // the REAL SDK streamable-http client — the strongest proof that
        // the persisted credential authenticates tools/list.
        mcpOAuthTokenStore: vault,
        onExtensionSurfaces: (resolved) => {
          surfaces = resolved;
        },
        onExtensionToolset: (tools) => {
          definitions = tools;
        },
      });
      await server.stop();

      // The discovered surface landed: the authenticated tools/list was
      // served with the vault bearer and its tool is exposed.
      expect(seenAuth.length).toBeGreaterThan(0);
      expect(seenAuth[0]).toBe("Bearer access-boot-1");
      expect(surfaces).toBeDefined();
      const surface = surfaces!.get(OAUTH_ID);
      expect(surface).toBeDefined();
      expect(surface!.map((tool) => tool.name)).toEqual(["fixture.oauthboot.oauthboot.ping"]);
      expect(definitions).toBeDefined();
      expect(definitions!.some((tool) => tool.name === "fixture.oauthboot.oauthboot.ping")).toBe(true);
    } finally {
      env.cleanup();
    }
  });
});
