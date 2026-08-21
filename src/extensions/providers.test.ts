/**
 * Issue #54 acceptance: the pinned provider snapshots (Linear, GitHub,
 * Attio, Notion) validate against the #50 validator, resolve through the
 * registry, feed the egress allowlist, and execute end-to-end through the
 * tool bridge against a stub MCP transport — no live calls in tests.
 *
 * Runtime seam (#53, not landed when #54 shipped): the registry seeds from
 * config/extensions/ at server boot (server/index.ts) and the tool bridge
 * (tools.ts) executes calls over the binding's MCP transport with the
 * injectable `mcpTransport` seam. The #53 runtime adds the credential
 * broker handoff (resolve(id) -> vault credential per the #51 ladder).
 * Tool-name mapping (issue #148): manifest tool names are bottega's v1
 * surface (e.g. linear.search_issues), while the official servers expose
 * their own wire names (github → search_issues live-verified; attio →
 * search-records per official docs; linear → unprefixed per the official
 * server's tool list; notion → notion-search / notion-create-pages /
 * notion-update-page per Notion's official docs, which prefix EVERY wire
 * name with "notion-") — the bridge forwards `providerName ?? name`, so
 * the provider call carries the wire name while the manifest name stays
 * the SDK/policy/audit surface.
 *
 * The committed manifests are TOOLS-LESS (issue #158): the pinned
 * hand-authored 3-tool subsets are gone, so the runtime discovers each
 * provider's full surface from tools/list at boot. These tests exercise
 * that discovery through the hermetic transport seam (in-memory MCP
 * servers per provider) and keep the #148 wire-name semantics — the
 * discovered surface carries the provider's wire providerNames, and the
 * bridge still forwards them on every call.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ExtensionContext, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { createAudit } from "../policy/audit";
import { DenyRouter } from "../policy/approval-router";
import { parseOrgConfigYaml } from "../policy/config";
import { createStore, type ExtensionCredential } from "../store/db";
import { extensionSecretFileName } from "./boundary";
import { createExtensionRegistry, readPinnedSnapshots } from "./registry";
import { extensionToolDefinitions } from "./tools";
import { createExtensionRuntime } from "./runtime";
import { validateManifest, type McpBinding } from "./manifest";
import { resetToolSurfaceCache, resolveExtensionSurfaces, type ExtensionSurfaces } from "./surface";

const SNAPSHOTS_DIR = resolve(import.meta.dir, "../../config/extensions");

const PROVIDERS = ["linear", "github", "attio", "gmail-googleapis-com"] as const;

/** The WIRE tool surface per provider (issue #148): the names the hosted
 * servers expose (github live-verified; attio per official docs; linear
 * unprefixed; gmail per the reviewed /mcp/v1 binding's published surface —
 * the hermetic stubs serve exactly these from tools/list). */
const WIRE_SURFACE = {
  linear: ["search_issues", "create_issue", "update_status"],
  github: ["search_issues", "issue_write", "add_issue_comment"],
  attio: ["search-records", "create-record", "update-record"],
  "gmail-googleapis-com": ["get_profile", "search_messages", "send_message"],
} as const;

/** The conservative tiers the #157 heuristic assigns each provider's wire
 * surface (the discovery test pins them): the search/create/update wire
 * names classify read/write/write. */
const WIRE_TIERS = {
  linear: ["read", "write", "write"],
  github: ["read", "write", "write"],
  attio: ["read", "write", "write"],
  // get_/search_ are read verbs; send_ mutates → write (approval).
  "gmail-googleapis-com": ["read", "read", "write"],
} as const;

/** Minimal inputSchema per wire tool — the MCP spec requires one. */
function wireInputSchema(wire: string) {
  const schema = {
    type: "object" as const,
    properties: {
      query: { type: "string" },
      title: { type: "string" },
    },
  };
  if (wire.includes("search")) {
    return { ...schema, required: ["query"] };
  }
  return schema;
}

/**
 * The hermetic transport seam (issue #158): an in-memory MCP server for one
 * provider serving tools/list (discovery) and tools/call (execution) — no
 * network, deterministic. Mirrors the hosted servers' wire names (#148);
 * `seen` records every provider call so tests can assert the wire name
 * forwarding.
 */
function stubMcpTransport(provider: (typeof PROVIDERS)[number], seen?: { tool: string[] }) {
  return (_binding: McpBinding): Transport => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = new Server({ name: `${provider}-stub`, version: "1.0.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: WIRE_SURFACE[provider].map((wire) => ({
        name: wire,
        description: `${provider} ${wire}`,
        inputSchema: wireInputSchema(wire),
      })),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      seen?.tool.push(request.params.name);
      const args = request.params.arguments ?? {};
      return {
        content: [{ type: "text", text: `stub ${request.params.name} query=${String(args["query"])}` }],
      };
    });
    void server.connect(serverTransport);
    return clientTransport;
  };
}

/** One transport factory dispatching per binding to the right provider stub. */
function stubTransports(seen?: { tool: string[] }) {
  return (binding: McpBinding): Transport => {
    const url = binding.transport === "streamable-http" ? (binding.serverUrl ?? "") : "";
    if (url.includes("linear.app")) return stubMcpTransport("linear", seen)(binding);
    if (url.includes("attio.com")) return stubMcpTransport("attio", seen)(binding);
    if (url.includes("gmailmcp.googleapis.com")) return stubMcpTransport("gmail-googleapis-com", seen)(binding);
    return stubMcpTransport("github", seen)(binding);
  };
}

/** JSON-compatible tool call arguments (the execute boundary contract). */
type ToolCallArgs =
  | string
  | number
  | boolean
  | null
  | ToolCallArgs[]
  | { [key: string]: ToolCallArgs };

/** The context surface the tool bridge reads from an ExtensionContext. */
interface ToolRunContext {
  sessionManager: { getSessionFile(): string | null | undefined };
}

function run(def: ToolDefinition, params: ToolCallArgs) {
  const ctx: ToolRunContext = {
    sessionManager: { getSessionFile: () => null },
  };
  // SAFETY: the extension bridge resolves the space id only via
  // ctx.sessionManager.getSessionFile() (see src/extensions/tools.ts);
  // ToolRunContext is exactly that surface, so the stub is sound.
  return def.execute("1", params, undefined, undefined, ctx as ExtensionContext);
}

/**
 * The #53 runtime over the pinned-snapshot registry: real in-memory store
 * with an org credential row per provider, real audit, DenyRouter, and the
 * injected MCP transport seam (issue #53 owns gate → ladder → boundary →
 * audit; #54 exercises the provider tool surface through it).
 */
function makeRuntime(
  mcpTransport?: (binding: McpBinding) => Transport,
  surfaces?: ExtensionSurfaces,
) {
  const registry = createExtensionRegistry(SNAPSHOTS_DIR);
  const store = createStore(":memory:");
  for (const id of PROVIDERS) {
    void store.upsertExtensionCredential({
      provider: id,
      identityKey: "email:org@example.com",
      owner: null,
      scope: "org",
      brokerCredentialId: 1,
    });
  }
  const runtime = createExtensionRuntime({
    registry,
    store,
    audit: createAudit(store),
    // The providers cross the tier stage as known tools with their manifest
    // tiers; the tools map allows everything not explicitly denied.
    orgPolicy: parseOrgConfigYaml("tools:\n  unknown: allow\n"),
    router: DenyRouter,
    boundary: {
      async runWithAuthorization(request, invoke) {
        return invoke({
          callId: request.callId,
          placeholder: "test-placeholder",
          signal: new AbortController().signal,
        });
      },
    },
    ...(mcpTransport !== undefined ? { mcpTransport } : undefined),
    ...(surfaces !== undefined ? { surfaces } : undefined),
  });
  return { registry, runtime };
}

describe("issue #54 pinned providers", () => {
  beforeEach(() => {
    // Discovery is cached per manifest id + binding and the cache is
    // process-global: hermetic tests must not observe a stale surface from
    // an earlier test (or a skip-gated live leg) in the same process.
    resetToolSurfaceCache();
  });
  test("all pinned snapshots parse against the #50 validator as vendor-official, reviewed", () => {
    const snapshots = readPinnedSnapshots(SNAPSHOTS_DIR);
    expect(snapshots.map((s) => s.extensionId).sort()).toEqual([...PROVIDERS].sort());
    for (const snapshot of snapshots) {
      expect(snapshot.source.vendorOfficial).toBe(true);
      expect(snapshot.source.reviewed).toBe(true);
      expect(snapshot.manifest.kind).toBe("mcp");
    }
  });

  test("the registry resolves every pinned provider from the committed snapshots", () => {
    const registry = createExtensionRegistry(SNAPSHOTS_DIR);
    expect(registry.list()).toHaveLength(PROVIDERS.length);
    for (const id of PROVIDERS) {
      const resolved = registry.resolve(id);
      expect(resolved).toBeDefined();
      expect(resolved?.snapshot?.extensionId).toBe(id);
      expect(resolved?.snapshot?.source.specId).toBeTruthy();
    }
  });

  test("the committed manifests are tools-less; discovery restores the full surface with wire names and conservative tiers (issue #158)", async () => {
    const registry = createExtensionRegistry(SNAPSHOTS_DIR);
    // The hand-authored tool subsets are gone: binding + credentialSchema +
    // domains stay, the surface is discovered at runtime — the registry
    // has no sync tool names.
    for (const id of PROVIDERS) {
      const resolved = registry.resolve(id);
      expect(resolved?.manifest.tools).toBeUndefined();
      expect(resolved?.manifest.mcp).toBeDefined();
      expect(resolved?.manifest.credentialSchema).toBeDefined();
      expect(resolved?.manifest.domains.length).toBeGreaterThan(0);
    }
    expect(registry.toolNames()).toEqual([]);

    // The server-boot step: discovery through the hermetic transport seam
    // restores the v1 search/create/update surface — namespaced manifest
    // names, wire providerNames (issue #148), the per-provider conservative
    // tiers pinned in WIRE_TIERS, and non-empty descriptions. Never a
    // silent empty set.
    const surfaces = await resolveExtensionSurfaces(registry.list(), { mcpTransport: stubTransports() });
    for (const id of PROVIDERS) {
      const tools = [...(surfaces.get(id) ?? [])];
      expect(tools.map((t) => t.name)).toEqual([...WIRE_SURFACE[id]].map((wire) => `${id}.${wire}`));
      expect(tools.map((t) => t.providerName)).toEqual([...WIRE_SURFACE[id]]);
      expect(tools.map((t) => t.tier)).toEqual([...WIRE_TIERS[id]]);
      for (const tool of tools) {
        expect(tool.description.length).toBeGreaterThan(0);
      }
    }
  });

  test("the egress allowlist contains the pinned providers' domains", () => {
    const registry = createExtensionRegistry(SNAPSHOTS_DIR);
    // Snapshot files load in sorted order (attio, github,
    // gmail-googleapis-com, linear — "github" < "gmail-" lexicographically)
    // — the committed SEED (issue #233: notion's pin is gone; its domains
    // land via the runtime registry when a connect registers it; issue
    // #286: the reviewed Gmail override allowlists both gmail.googleapis.com
    // and the validated mcp host).
    expect(registry.egressDomains()).toEqual([
      "mcp.attio.com",
      "api.githubcopilot.com",
      "gmail.googleapis.com",
      "gmailmcp.googleapis.com",
      "mcp.linear.app",
    ]);
  });

  test("linear executes end-to-end through the tool bridge against a stub transport (discovered surface)", async () => {
    // SAFETY: the stub records wire tool names — every push is
    // request.params.name, a string per the MCP schema.
    const seen = { tool: [] as string[] };
    const mcpTransport = stubTransports(seen);
    const { registry, runtime } = makeRuntime(mcpTransport);
    // The tools-less manifest's surface comes from tools/list (the #158
    // hermetic seam), pre-resolved exactly like the server boot step.
    const surfaces = await resolveExtensionSurfaces(registry.list(), { mcpTransport });
    const definitions = extensionToolDefinitions(registry.list(), { runtime, surfaces });
    const search = definitions.find((def) => def.name === "linear.search_issues");
    expect(search).toBeDefined();
    expect(search?.approval).toBe("read");
    const result = await run(search!, { query: "bug" });
    // Issue #148: the provider sees the wire name (providerName), not the
    // namespaced manifest name.
    expect(result.content).toEqual([{ type: "text", text: "stub search_issues query=bug" }]);
    expect(seen.tool).toEqual(["search_issues"]);
  });

  test("a tools-less github manifest with an unreachable provider is skipped at boot and fails closed per call (issues #158/#166)", async () => {
    const unreachable = () => {
      throw new Error("api.githubcopilot.com unreachable");
    };
    const { registry, runtime } = makeRuntime(unreachable);
    const github = registry.resolve("github");
    expect(github?.manifest.mcp).toEqual({
      serverUrl: "https://api.githubcopilot.com/mcp/",
      transport: "streamable-http",
    });
    expect(github?.manifest.tools).toBeUndefined();
    // Issue #166: the boot SKIPS a provider whose discovery failed — the
    // map holds only RESOLVED surfaces, never a boot failure.
    const surfaces = await resolveExtensionSurfaces([github!], { mcpTransport: unreachable });
    expect(surfaces.has("github")).toBe(false);
    // The bridge contributes no definitions for the skipped extension (it
    // cannot name its tools) — no throw, and no claim of a toolset.
    expect(extensionToolDefinitions([github!], { runtime })).toEqual([]);
    // Fail-closed at the runtime's lazy path: a tool call returns a clear
    // error result naming the unavailable surface.
    const result = await runtime.execute({
      extensionId: "github",
      toolName: "github.search_issues",
      args: { query: "repo:foo" },
      caller: "UADA",
      spaceId: "slack:C1",
    });
    const error = result.ok ? "unexpected success" : result.error;
    expect(result.ok).toBe(false);
    expect(error).toContain("tool surface unavailable");
    expect(error).toContain("unreachable");
  });
});

/**
 * GitHub hosted MCP live leg (issue #145): the github extension now binds to
 * the HOSTED streamable-http server (https://api.githubcopilot.com/mcp/ —
 * no local binary), and the dev proxy's secrets transform injects the
 * boundary's secret file as the Authorization header for that domain. This
 * leg proves the real end-to-end path against the RUNNING dev stack
 * (harness-managed bottega-dev): the store's real personal github row
 * (owner U0B9QUPCTJ5) exists, the boundary's secret file the proxy injects
 * is present, and POST initialize to the hosted MCP through the dev proxy
 * (127.0.0.1:8080) returns an authenticated session — NOT 401.
 *
 * Skip-gated like the other integration legs (BOTTEGA_RUN_INTEGRATION=1).
 * The dev proxy MITMs TLS with the generated CA, so the leg needs Bun to
 * trust it: run with
 * `NODE_EXTRA_CA_CERTS=$PWD/certs/ca.crt BOTTEGA_RUN_INTEGRATION=1 bun test …`
 * (the same env scripts/dev.sh exports for the dev server). The credential
 * never leaves the proxy and is never printed here — only the HTTP status
 * and the JSON-RPC shape are asserted/logged.
 */
describe("github hosted MCP live leg (skip-gated, issue #145)", () => {
  test(
    "POST initialize through the dev proxy with the injected credential is not 401",
    async () => {
      const skip = (reason: string) => console.log(`[github hosted MCP leg] SKIP: ${reason}`);
      if (process.env.BOTTEGA_RUN_INTEGRATION !== "1") {
        skip("integration leg skipped: set BOTTEGA_RUN_INTEGRATION=1 to run (dev stack: NODE_EXTRA_CA_CERTS=$PWD/certs/ca.crt)");
        return;
      }
      const repoRoot = resolve(import.meta.dir, "../..");

      // 1. Dev proxy reachable (management API on 127.0.0.1:9092; a
      //    token-less reload probe answers 401 — reachability is the point).
      const mgmt = await fetch("http://127.0.0.1:9092/v1/reload", { method: "POST" }).catch(() => null);
      if (!mgmt) {
        skip("dev iron-proxy not reachable on 127.0.0.1:9092 — start the dev stack (bun run dev) first");
        return;
      }

      // 2. The real personal github credential row (issue #145: the live
      //    store row owned by U0B9QUPCTJ5). Opened read-only in WAL mode
      //    while the dev server holds the file; closed right after.
      const store = createStore(join(repoRoot, "data/bottega.db"));
      let row: ExtensionCredential | null = null;
      try {
        row =
          (await store.listExtensionCredentials("github")).find(
            (r) => r.scope === "personal" && r.owner === "U0B9QUPCTJ5",
          ) ?? null;
      } finally {
        store.close();
      }
      if (!row) {
        skip("no personal github credential row (owner U0B9QUPCTJ5) in data/bottega.db");
        return;
      }

      // 3. The boundary's secret file the proxy injects for the github
      //    domain (written by the runtime's boundary to the shared data
      //    volume; the proxy re-reads it on reload/ttl). Only its presence
      //    is checked — the secret itself is never read out or printed.
      const secretPath = join(repoRoot, "data/proxy-secrets", extensionSecretFileName("github"));
      if (!existsSync(secretPath) || readFileSync(secretPath).length === 0) {
        skip("data/proxy-secrets/github.secret is missing or empty — the boundary has not injected a credential yet");
        return;
      }

      // 4. POST initialize to the HOSTED MCP through the dev proxy: the
      //    secrets transform injects the Authorization header for
      //    api.githubcopilot.com, so an unauthenticated 401 proves the
      //    injection is missing — a non-401 with a JSON-RPC result proves
      //    the session authenticated.
      const res = await fetch("https://api.githubcopilot.com/mcp/", {
        method: "POST",
        proxy: "http://127.0.0.1:8080",
        headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "bottega-live-leg", version: "1.0.0" },
          },
        }),
      });
      console.log(`[github hosted MCP leg] initialize via dev proxy: HTTP ${res.status}`);
      expect(res.status).not.toBe(401);
      const body = await res.text();
      // An authenticated initialize returns a JSON-RPC result (the hosted
      // server's capabilities/instructions — never a credential).
      if (body.trim().length > 0) expect(body).toContain("jsonrpc");
      expect(body).not.toContain("ghp_");
    },
    60_000,
  );

  test(
    "issue #148: the mapped providerName tool names exist on the hosted server and a REAL call with the mapped name succeeds",
    async () => {
      const skip = (reason: string) => console.log(`[github hosted MCP leg #148] SKIP: ${reason}`);
      if (process.env.BOTTEGA_RUN_INTEGRATION !== "1") {
        skip("integration leg skipped: set BOTTEGA_RUN_INTEGRATION=1 to run (dev stack: NODE_EXTRA_CA_CERTS=$PWD/certs/ca.crt)");
        return;
      }
      const repoRoot = resolve(import.meta.dir, "../..");
      const mgmt = await fetch("http://127.0.0.1:9092/v1/reload", { method: "POST" }).catch(() => null);
      if (!mgmt) {
        skip("dev iron-proxy not reachable on 127.0.0.1:9092 — start the dev stack (bun run dev) first");
        return;
      }
      const secretPath = join(repoRoot, "data/proxy-secrets", extensionSecretFileName("github"));
      if (!existsSync(secretPath) || readFileSync(secretPath).length === 0) {
        skip("data/proxy-secrets/github.secret is missing or empty — the boundary has not injected a credential yet");
        return;
      }

      // Raw streamable-http session through the dev proxy: initialize →
      // notifications/initialized → tools/list → tools/call. The proxy's
      // secrets transform injects the Authorization header for
      // api.githubcopilot.com; the credential never leaves the proxy and is
      // never printed here.
      const base = {
        method: "POST" as const,
        proxy: "http://127.0.0.1:8080",
        headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" },
      };
      const rpc = (id: number, method: string, params?: ToolCallArgs) =>
        JSON.stringify({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : undefined) });
      /** JSON-RPC response envelope: exactly one of result/error, both opaque. */
      const jsonRpcEnvelopeSchema = z.object({
        result: z.unknown().optional(),
        error: z.unknown().optional(),
      });
      const parseResult = (body: string) => {
        const dataLine = body.split("\n").find((line) => line.startsWith("data: "));
        const parsed = jsonRpcEnvelopeSchema.parse(JSON.parse((dataLine ?? body).replace(/^data: /, "")));
        if (parsed.error !== undefined) return { error: parsed.error };
        return { result: parsed.result };
      };

      const initRes = await fetch("https://api.githubcopilot.com/mcp/", {
        ...base,
        body: rpc(1, "initialize", {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "bottega-live-leg-148", version: "1.0.0" },
        }),
      });
      expect(initRes.status).not.toBe(401);
      const init = parseResult(await initRes.text());
      expect(init.result).toBeDefined();
      expect(init.error).toBeUndefined();
      const sessionId = initRes.headers.get("mcp-session-id");
      const sessionHeaders = {
        ...base.headers,
        ...(sessionId ? { "mcp-session-id": sessionId } : undefined),
      };
      await fetch("https://api.githubcopilot.com/mcp/", {
        ...base,
        headers: sessionHeaders,
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      });

      // tools/list — the EVIDENCE: the mapped wire names exist on the
      // hosted server (never guess: an unauthenticated list would 401).
      const listRes = await fetch("https://api.githubcopilot.com/mcp/", {
        ...base,
        headers: sessionHeaders,
        body: rpc(2, "tools/list"),
      });
      expect(listRes.status).not.toBe(401);
      // SAFETY: the JSON-RPC result envelope is pinned by parseResult; when
      // tools/list succeeds, `result` is an object whose tools field is an
      // array of { name } entries — asserted by the expectations below.
      const list = parseResult(await listRes.text()) as {
        result?: { tools: Array<{ name: string }> };
        error?: unknown;
      };
      expect(list.error).toBeUndefined();
      const names = (list.result?.tools ?? []).map((tool) => tool.name);
      console.log(`[github hosted MCP leg #148] tools/list count=${names.length}`);
      for (const mapped of ["search_issues", "issue_write", "add_issue_comment"]) {
        expect(names).toContain(mapped);
        console.log(`[github hosted MCP leg #148] mapped wire name present: ${mapped}`);
      }
      expect(names).not.toContain("github.search_issues");

      // A REAL tool call with the mapped name succeeds end-to-end
      // (read-only search; the query is scoped to this repo).
      const callRes = await fetch("https://api.githubcopilot.com/mcp/", {
        ...base,
        headers: sessionHeaders,
        body: rpc(3, "tools/call", {
          name: "search_issues",
          arguments: { query: "repo:serrrfirat/bottega is:issue" },
        }),
      });
      expect(callRes.status).not.toBe(401);
      // SAFETY: the JSON-RPC result envelope is pinned by parseResult; a
      // successful tools/call returns result with isError and a content
      // array of { type, text? } blocks — asserted below.
      const call = parseResult(await callRes.text()) as {
        result?: { isError?: boolean; content?: Array<{ type: string; text?: string }> };
        error?: unknown;
      };
      expect(call.error).toBeUndefined();
      expect(call.result?.isError).not.toBe(true);
      expect(Array.isArray(call.result?.content)).toBe(true);
      expect((call.result?.content ?? []).length).toBeGreaterThan(0);
      // The result is real GitHub search data (the API's JSON envelope),
      // never a credential: the token stays at the proxy boundary and this
      // leg only logs statuses/counts. Issue bodies are arbitrary text, so
      // no substring-based secret sniffing here (false positives).
      const text = (call.result?.content ?? [])
        .map((block) => ("text" in block ? block.text ?? "" : ""))
        .join("");
      expect(text).toContain("total_count");
      console.log(`[github hosted MCP leg #148] real search_issues call OK (${text.length} chars of issue data)`);
    },
    90_000,
  );
});

/**
 * GitHub hosted MCP tools-less discovery live leg (issue #158): a manifest
 * WITHOUT tools (binding + credentialSchema + domains only) discovers its
 * FULL tool surface from the hosted server's tools/list through the
 * PRODUCTION path — the SDK client rides HTTP(S)_PROXY through the dev
 * iron-proxy, whose secrets transform injects the boundary's secret file
 * as the Authorization header for api.githubcopilot.com. This is the exact
 * path the server boot uses (resolveExtensionSurfaces → bridge → runtime),
 * so the leg proves the agent sees all N hosted tools with conservative
 * tiers, never the old hand-authored 3-tool subset.
 *
 * Skip-gated like the other integration legs (BOTTEGA_RUN_INTEGRATION=1)
 * with the dev stack running:
 * `NODE_EXTRA_CA_CERTS=$PWD/certs/ca.crt BOTTEGA_RUN_INTEGRATION=1 bun test …`
 * (the dev proxy MITMs TLS; the CA trust is the same requirement as the
 * #145/#148 legs). Evidence is logged (count + names); the credential
 * never leaves the proxy.
 */
describe("github hosted MCP live leg (skip-gated, issue #158 — tools-less discovery)", () => {
  test(
    "a tools-less github manifest discovers the FULL hosted surface with conservative tiers",
    async () => {
      const skip = (reason: string) => console.log(`[github hosted MCP leg #158] SKIP: ${reason}`);
      if (process.env.BOTTEGA_RUN_INTEGRATION !== "1") {
        skip("integration leg skipped: set BOTTEGA_RUN_INTEGRATION=1 to run (dev stack: NODE_EXTRA_CA_CERTS=$PWD/certs/ca.crt)");
        return;
      }
      const repoRoot = resolve(import.meta.dir, "../..");
      const mgmt = await fetch("http://127.0.0.1:9092/v1/reload", { method: "POST" }).catch(() => null);
      if (!mgmt) {
        skip("dev iron-proxy not reachable on 127.0.0.1:9092 — start the dev stack (bun run dev) first");
        return;
      }
      const secretPath = join(repoRoot, "data/proxy-secrets", extensionSecretFileName("github"));
      if (!existsSync(secretPath) || readFileSync(secretPath).length === 0) {
        skip("data/proxy-secrets/github.secret is missing or empty — the boundary has not injected a credential yet");
        return;
      }

      // Hermetic tests cache the same manifest id + binding key: clear the
      // process-global discovery cache so this leg observes the REAL hosted
      // surface, never a stub surface from an earlier test in this process.
      resetToolSurfaceCache();

      // The tools-less github manifest: binding + credentialSchema only.
      // The tool surface comes from the hosted server's tools/list.
      const registry = createExtensionRegistry();
      registry.register(
        validateManifest({
          id: "github",
          label: "GitHub",
          vendor: "GitHub",
          kind: "mcp",
          mcp: { serverUrl: "https://api.githubcopilot.com/mcp/", transport: "streamable-http" },
          credentialSchema: { type: "api_key" },
          domains: ["api.githubcopilot.com"],
          credentialTargets: [{ host: "api.githubcopilot.com", pathPrefix: "/mcp" }],
        }),
      );

      // The production discovery path (server boot): the SDK client rides
      // HTTP(S)_PROXY through iron-proxy, whose secrets transform injects
      // the credential for api.githubcopilot.com.
      const surfaces = await resolveExtensionSurfaces(registry.list());
      const github = [...(surfaces.get("github") ?? [])];
      const names = github.map((tool) => tool.name);
      const byWire = new Map(github.map((tool) => [tool.providerName, tool]));
      console.log(`[github hosted MCP leg #158] tools/list discovered ${github.length} tools`);

      // The FULL surface — the old hand-authored 3-tool subset is gone.
      expect(github.length).toBeGreaterThan(10);
      // The mapped wire names (issue #148) are part of it.
      for (const wire of ["search_issues", "issue_write", "add_issue_comment"]) {
        expect(names).toContain(`github.${wire}`);
        console.log(`[github hosted MCP leg #158] discovered: ${wire}`);
      }
      // Conservative tiers on the discovered surface (the #157 heuristic).
      expect(byWire.get("search_issues")?.tier).toBe("read");
      expect(byWire.get("issue_write")?.tier).toBe("write");
      expect(byWire.get("add_issue_comment")?.tier).toBe("write");
      // Every discovered tool is representable: namespaced manifest names,
      // wire providerNames, and params derived from the server's inputSchema
      // (a tool without inputSchema would have been skipped — never silent).
      for (const tool of github) {
        expect(tool.name.startsWith("github.")).toBe(true);
        expect(tool.providerName).toEqual(expect.any(String));
        expect(Array.isArray(tool.params)).toBe(true);
      }
      console.log(
        `[github hosted MCP leg #158] full surface OK (${github.length} tools, conservative tiers)`,
      );
    },
    120_000,
  );
});
