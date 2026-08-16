/**
 * Issue #54 acceptance: the three pinned provider snapshots (Linear, GitHub,
 * Attio) validate against the #50 validator, resolve through the registry,
 * feed the egress allowlist, and execute end-to-end through the tool bridge
 * against a stub MCP transport — no live calls in tests.
 */
import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ExtensionContext, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { createExtensionRegistry, readPinnedSnapshots } from "./registry";
import { extensionToolDefinitions } from "./tools";
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
  return def.execute("1", params, undefined, undefined, {} as ExtensionContext);
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
    expect(registry.egressDomains()).toEqual(["mcp.attio.com", "api.github.com", "mcp.linear.app"]);
  });

  test("linear executes end-to-end through the tool bridge against a stub transport", async () => {
    const registry = createExtensionRegistry(SNAPSHOTS_DIR);
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
    const definitions = extensionToolDefinitions(registry.list(), { mcpTransport });
    const search = definitions.find((def) => def.name === "linear.search_issues");
    expect(search).toBeDefined();
    expect(search?.approval).toBe("read");
    const result = await run(search!, { query: "bug" });
    expect(result.content).toEqual([{ type: "text", text: "stub linear.search_issues query=bug" }]);
  });

  test("github (stdio binding) failures surface as tool errors, not silent no-ops", async () => {
    const registry = createExtensionRegistry(SNAPSHOTS_DIR);
    const github = registry.resolve("github");
    expect(github?.manifest.mcp).toEqual({ command: "github-mcp-server", transport: "stdio" });
    const definitions = extensionToolDefinitions([github!], {
      mcpTransport: () => {
        throw new Error("github-mcp-server not in image");
      },
    });
    const result = await run(definitions[0], { query: "repo:foo" });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("not in image");
  });
});
