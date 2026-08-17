/**
 * Manifest tool generator tests (issue #157): hermetic — a fake tools/list
 * served over the SDK's in-memory transport seam generates manifest tools
 * correctly (namespaced names, wire providerName, params from inputSchema,
 * CONSERVATIVE tiers), the review gate holds on the pin path, and
 * unknown/unsafe-looking tools get conservative tiers.
 */
import { describe, expect, test } from "bun:test";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ListToolsRequestSchema, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  classifyTier,
  generateManifestTools,
  listProviderTools,
  refreshManifestTools,
  toolsFromMcpList,
} from "./generate-tools";
import type { ExtensionTool, McpBinding } from "./manifest";

const BINDING: McpBinding = { serverUrl: "https://mcp.example.test/mcp", transport: "streamable-http" };

/** A fake MCP server whose tools/list returns the given wire tools. */
function fakeToolsServer(tools: unknown[]): (binding: McpBinding) => Transport {
  return () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = new Server({ name: "fake-mcp", version: "1.0.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
    void server.connect(serverTransport);
    return clientTransport;
  };
}

/**
 * A transport that starts and accepts writes but NEVER responds: the shape
 * of a dead stdio server (e.g. bare `npx` — a process exists, the MCP
 * handshake is never answered). Without the discovery bound the SDK's
 * 60s default request timeout would hang the caller.
 */
class SilentTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  async start(): Promise<void> {}
  async send(_message: JSONRPCMessage): Promise<void> {}
  async close(): Promise<void> {
    this.onclose?.();
  }
}

describe("classifyTier (issue #157 conservative default tiers)", () => {
  test("the server's own hints win", () => {
    expect(classifyTier("anything", { readOnlyHint: true })).toBe("read");
    expect(classifyTier("anything", { destructiveHint: true })).toBe("exec");
    // Contradictory hints resolve to the SAFER tier: destructive wins.
    expect(classifyTier("anything", { readOnlyHint: true, destructiveHint: true })).toBe("exec");
  });

  test("confident read verbs classify read", () => {
    for (const name of ["get_issue", "list_repositories", "search_issues", "fetch_commit", "describe_entity"]) {
      expect(classifyTier(name)).toBe("read");
    }
  });

  test("clearly destructive verbs classify exec", () => {
    for (const name of ["delete_issue", "remove_label", "purge_cache", "wipe_all_data", "cancel_workflow_run"]) {
      expect(classifyTier(name)).toBe("exec");
    }
  });

  test("everything unknown or mutating lands on write (approval)", () => {
    for (const name of ["create_issue", "update_issue", "set_status", "merge_pull_request", "repository", "blob"]) {
      expect(classifyTier(name)).toBe("write");
    }
  });
});

describe("generateManifestTools: fake tools/list over the in-memory transport seam", () => {
  test("generates the full surface: wire providerName, params from inputSchema, conservative tiers", async () => {
    const generation = await generateManifestTools({
      binding: BINDING,
      extensionId: "fake",
      mcpTransport: fakeToolsServer([
        {
          name: "search_issues",
          description: "Search issues across repositories",
          inputSchema: {
            type: "object",
            properties: {
              query: { type: "string", description: "Search query" },
              limit: { type: "integer", description: "Max results" },
              labels: { type: "array", description: "Label names" },
              archived: { type: "boolean", description: "Include archived" },
            },
            required: ["query"],
          },
        },
        {
          name: "get_issue",
          description: "Get an issue by number",
          annotations: { readOnlyHint: true },
          inputSchema: { type: "object", properties: { issueNumber: { type: "number" } }, required: ["issueNumber"] },
        },
        { name: "create_issue", description: "Create an issue", inputSchema: { type: "object", properties: { title: { type: "string" } }, required: ["title"] } },
        { name: "delete_issue", description: "Delete an issue", inputSchema: { type: "object", properties: {} } },
        { name: "wipe_all_data", description: "Wipe all data", inputSchema: { type: "object" } },
        { name: "repository", description: "Repository info", inputSchema: { type: "object" } },
      ]),
    });

    expect(generation.skipped).toEqual([]);
    // Namespaced manifest names; providerName carries the provider's WIRE name.
    expect(generation.tools.map((tool) => tool.name)).toEqual([
      "fake.search_issues",
      "fake.get_issue",
      "fake.create_issue",
      "fake.delete_issue",
      "fake.wipe_all_data",
      "fake.repository",
    ]);
    expect(generation.tools.map((tool) => tool.providerName)).toEqual([
      "search_issues",
      "get_issue",
      "create_issue",
      "delete_issue",
      "wipe_all_data",
      "repository",
    ]);
    // Conservative tiers: read-only heuristic → read; mutating → write;
    // clearly destructive → exec; unknown surface → write.
    expect(generation.tools.map((tool) => tool.tier)).toEqual(["read", "read", "write", "exec", "exec", "write"]);

    // Params: JSON schema types → manifest string/number/boolean; array →
    // string (JSON-serialized); required from the schema's required list.
    const search = generation.tools[0]!;
    expect(search.params).toEqual([
      { name: "query", type: "string", description: "Search query" },
      { name: "limit", type: "number", description: "Max results", required: false },
      { name: "labels", type: "string", description: "Label names", required: false },
      { name: "archived", type: "boolean", description: "Include archived", required: false },
    ]);
    // A schema with no required list → every param explicitly optional.
    expect(generation.tools[4]!.params).toEqual([]);
    expect(generation.tools[1]!.params).toEqual([{ name: "issueNumber", type: "number" }]);
    // Server descriptions pass through.
    expect(search.description).toBe("Search issues across repositories");
  });

  test("unknown/unsafe-looking tools get conservative tiers", async () => {
    const generation = await generateManifestTools({
      binding: BINDING,
      extensionId: "fake",
      mcpTransport: fakeToolsServer(
        ["update_issue", "set_status", "enable_feature", "merge_pull_request", "issue", "blob"].map((name) => ({
          name,
          description: `tool ${name}`,
          inputSchema: { type: "object", properties: {} },
        })),
      ),
    });
    expect(generation.skipped).toEqual([]);
    expect(generation.tools.every((tool) => tool.tier === "write")).toBe(true);
  });

  test("unrepresentable wire names and missing inputSchema are skipped, never silently dropped", () => {
    const generation = toolsFromMcpList(
      [
        { name: "createIssue", description: "camelCase wire name", inputSchema: { type: "object", properties: {} } },
        { name: "with space", description: "space in wire name", inputSchema: { type: "object" } },
        { name: "no_schema_tool", description: "omits the MCP-required inputSchema" },
        { name: "get_ok", description: "representable", inputSchema: { type: "object" } },
      ],
      "fake",
    );
    expect(generation.tools.map((tool) => tool.name)).toEqual(["fake.get_ok"]);
    expect(generation.skipped.map((entry) => entry.tool)).toEqual(["createIssue", "with space", "no_schema_tool"]);
    expect(generation.skipped[0]!.reason).toContain("not a valid manifest identifier");
    expect(generation.skipped[2]!.reason).toContain("no inputSchema");
  });

  test("the SDK rejects a tool missing inputSchema — the whole list fails closed, nothing generated", async () => {
    await expect(
      generateManifestTools({
        binding: BINDING,
        extensionId: "fake",
        mcpTransport: fakeToolsServer([{ name: "no_schema_tool", description: "omits the MCP-required inputSchema" }]),
      }),
    ).rejects.toThrow(/tools\/list failed/);
  });

  test("a missing server description yields an honest fallback, never an empty description", () => {
    const generation = toolsFromMcpList([{ name: "get_thing", inputSchema: { type: "object" } }], "fake");
    expect(generation.tools[0]!.description).toContain("no description from the MCP server");
  });

  test("an unreachable provider or a malformed tools/list fails closed with a clear error", async () => {
    await expect(
      generateManifestTools({
        binding: BINDING,
        extensionId: "fake",
        mcpTransport: () => {
          throw new Error("connection refused");
        },
      }),
    ).rejects.toThrow(/tools\/list failed/);

    // Malformed tools/list response (fails the SDK's ListToolsResultSchema).
    const broken = (): Transport => {
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const server = new Server({ name: "broken-mcp", version: "1.0.0" }, { capabilities: { tools: {} } });
      // SAFETY: the handler's declared result type would reject this malformed
      // payload, which is the point — the SDK's ListToolsResultSchema must fail
      // it so tools/list fails closed instead of returning garbage.
      server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: "nope" }) as never);
      void server.connect(serverTransport);
      return clientTransport;
    };
    await expect(
      generateManifestTools({ binding: BINDING, extensionId: "fake", mcpTransport: broken }),
    ).rejects.toThrow(/tools\/list failed/);
  });

  test("a server that never responds fails the discovery within the bound (issue #205)", async () => {
    // Issue #205: a dead stdio server must fail FAST (bounded, fail-closed),
    // never hang the boot or a turn for the SDK's 60s default timeout. The
    // 150ms bound is the test's clock: old code (no bound) hangs until the
    // runner's timeout; new code rejects at ~150ms with a clear error.
    const start = Date.now();
    await expect(
      listProviderTools({ command: "dead-server", transport: "stdio" }, () => new SilentTransport(), {
        timeoutMs: 150,
      }),
    ).rejects.toThrow(/tools\/list failed/);
    expect(Date.now() - start).toBeLessThan(5_000);
  });
});

describe("refreshManifestTools (issue #157 re-discovery)", () => {
  test("existing tools keep their reviewed tiers; new tools are added for review, never silent", () => {
    const existing: ExtensionTool[] = [
      {
        name: "fake.delete_issue",
        providerName: "delete_issue",
        tier: "write", // human-reviewed: delete needs approval only, not exec
        description: "reviewed",
        params: [],
      },
      { name: "fake.search_issues", providerName: "search_issues", tier: "read", description: "reviewed", params: [] },
    ];
    const generated: ExtensionTool[] = [
      {
        name: "fake.delete_issue",
        providerName: "delete_issue",
        tier: "exec", // the heuristic's default — MUST NOT clobber the review
        description: "server default",
        params: [],
      },
      { name: "fake.search_issues", providerName: "search_issues", tier: "read", description: "server default", params: [] },
      { name: "fake.create_issue", providerName: "create_issue", tier: "write", description: "server default", params: [] },
    ];

    const refreshed = refreshManifestTools(existing, generated);
    expect(refreshed.tools.map((tool) => [tool.name, tool.tier])).toEqual([
      ["fake.delete_issue", "write"],
      ["fake.search_issues", "read"],
      ["fake.create_issue", "write"],
    ]);
    expect(refreshed.added.map((tool) => tool.name)).toEqual(["fake.create_issue"]);
    expect(refreshed.added[0]!.tier).toBe("write");
  });

  test("an unchanged surface reports no additions", () => {
    const existing: ExtensionTool[] = [
      { name: "fake.get_issue", providerName: "get_issue", tier: "read", description: "d", params: [] },
    ];
    const refreshed = refreshManifestTools(existing, [
      { name: "fake.get_issue", providerName: "get_issue", tier: "read", description: "d", params: [] },
    ]);
    expect(refreshed.added).toEqual([]);
    expect(refreshed.tools).toHaveLength(1);
  });
});
