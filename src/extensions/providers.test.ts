/**
 * Issue #54 acceptance: the three pinned provider snapshots (Linear, GitHub,
 * Attio) validate against the #50 validator, resolve through the registry,
 * feed the egress allowlist, and execute end-to-end through the tool bridge
 * against a stub MCP transport — no live calls in tests.
 *
 * Runtime seam (#53, not landed when #54 shipped): the registry seeds from
 * config/extensions/ at server boot (server/index.ts) and the tool bridge
 * (tools.ts) executes calls over the binding's MCP transport with the
 * injectable `mcpTransport` seam. The #53 runtime adds the credential
 * broker handoff (resolve(id) -> vault credential per the #51 ladder) and
 * still needs one mapping: manifest tool names are bottega's v1 surface
 * (e.g. linear.search_issues), while the official servers expose their own
 * names (linear_search_issues / search_issues / search-records) — the
 * bridge forwards the manifest name verbatim today.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
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
import type { McpBinding } from "./manifest";

const SNAPSHOTS_DIR = resolve(import.meta.dir, "../../config/extensions");

const PROVIDERS = ["linear", "github", "attio"] as const;

/** The v1 tool surface per provider, from the issue body: search/create/update. */
const TOOL_SURFACE = {
  linear: ["linear.search_issues", "linear.create_issue", "linear.update_status"],
  github: ["github.search_issues", "github.create_issue", "github.add_comment"],
  attio: ["attio.search_records", "attio.create_record", "attio.update_record"],
} as const;

function run(def: ToolDefinition, params: Record<string, unknown>) {
  return def.execute("1", params, undefined, undefined, {
    sessionManager: { getSessionFile: () => null },
  } as unknown as ExtensionContext);
}

/**
 * The #53 runtime over the pinned-snapshot registry: real in-memory store
 * with an org credential row per provider, real audit, DenyRouter, and the
 * injected MCP transport seam (issue #53 owns gate → ladder → boundary →
 * audit; #54 exercises the provider tool surface through it).
 */
function makeRuntime(mcpTransport?: (binding: McpBinding) => Transport) {
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
    boundary: { async authorize() {} },
    mcpTransport,
  });
  return { registry, runtime };
}

describe("issue #54 pinned providers", () => {
  test("all three snapshots parse against the #50 validator as vendor-official, reviewed", () => {
    const snapshots = readPinnedSnapshots(SNAPSHOTS_DIR);
    expect(snapshots.map((s) => s.extensionId).sort()).toEqual([...PROVIDERS].sort());
    for (const snapshot of snapshots) {
      expect(snapshot.source.vendorOfficial).toBe(true);
      expect(snapshot.source.reviewed).toBe(true);
      expect(snapshot.manifest.kind).toBe("mcp");
    }
  });

  test("the registry resolves all three providers from the committed snapshots", () => {
    const registry = createExtensionRegistry(SNAPSHOTS_DIR);
    expect(registry.list()).toHaveLength(PROVIDERS.length);
    for (const id of PROVIDERS) {
      const resolved = registry.resolve(id);
      expect(resolved).toBeDefined();
      expect(resolved?.snapshot?.extensionId).toBe(id);
      expect(resolved?.snapshot?.source.specId).toBeTruthy();
    }
  });

  test("each provider exposes the v1 search/create/update surface with read/write/write tiers", () => {
    const registry = createExtensionRegistry(SNAPSHOTS_DIR);
    for (const id of PROVIDERS) {
      const tools = registry.resolve(id)?.manifest.tools;
      expect(tools?.map((t) => t.name)).toEqual([...TOOL_SURFACE[id]]);
      expect(tools?.map((t) => t.tier)).toEqual(["read", "write", "write"]);
      for (const tool of tools ?? []) {
        expect(tool.description.length).toBeGreaterThan(0);
      }
    }
    expect(registry.toolNames().sort()).toEqual(
      Object.values(TOOL_SURFACE).flat().sort(),
    );
  });

  test("the egress allowlist contains the three provider domains", () => {
    const registry = createExtensionRegistry(SNAPSHOTS_DIR);
    // Snapshot files load in sorted order (attio, github, linear).
    expect(registry.egressDomains()).toEqual(["mcp.attio.com", "api.githubcopilot.com", "mcp.linear.app"]);
  });

  test("linear executes end-to-end through the tool bridge against a stub transport", async () => {
    const mcpTransport = (_binding: McpBinding): Transport => {
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const server = new Server({ name: "linear-stub", version: "1.0.0" }, { capabilities: { tools: {} } });
      server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const args = request.params.arguments as Record<string, unknown>;
        return {
          content: [{ type: "text", text: `stub ${request.params.name} query=${String(args["query"])}` }],
        };
      });
      void server.connect(serverTransport);
      return clientTransport;
    };
    const { registry, runtime } = makeRuntime(mcpTransport);
    const definitions = extensionToolDefinitions(registry.list(), { runtime });
    const search = definitions.find((def) => def.name === "linear.search_issues");
    expect(search).toBeDefined();
    expect(search?.approval).toBe("read");
    const result = await run(search!, { query: "bug" });
    expect(result.content).toEqual([{ type: "text", text: "stub linear.search_issues query=bug" }]);
  });

  test("github (hosted MCP binding) transport failures surface as tool errors, not silent no-ops", async () => {
    const { registry, runtime } = makeRuntime(() => {
      throw new Error("api.githubcopilot.com unreachable");
    });
    const github = registry.resolve("github");
    expect(github?.manifest.mcp).toEqual({
      serverUrl: "https://api.githubcopilot.com/mcp/",
      transport: "streamable-http",
    });
    const definitions = extensionToolDefinitions([github!], { runtime });
    const result = await run(definitions[0], { query: "repo:foo" });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("unreachable");
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
});
