/**
 * Manifest tool generator — TRANSPORT-LEG tests (issue #157): the fake
 * tools/list served over the SDK's in-memory transport seam, and every
 * fail-closed discovery bound (unreachable provider, malformed tools/list,
 * dead stdio server, a transport whose start() never settles).
 *
 * SPLIT + TIMEOUT RATIONALE (2026-08-26): under
 * `bun test --coverage --parallel=1` on Linux CI the combined file went
 * silent for ~1085s inside these SDK transport legs (the SDK's per-request
 * `timeout` bounds each RPC but NOT the transport lifecycle around it), and
 * the coverage gate had to kill the whole suite (runs 32949859379 /
 * 32953011447). This file now runs OUTSIDE the coverage gate's serial
 * invocation (bunfig coveragePathIgnorePatterns) and every test carries an
 * explicit runner timeout so a wedged leg is reaped by bun itself instead of
 * stalling the suite.
 *
 * The production backstop lives in generate-tools.ts: listProviderTools
 * races its whole discovery against ONE wall-clock deadline
 * (withDeadline), pinned here by the never-settling-transport test.
 */
import { describe, expect, test } from "bun:test";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ListToolsRequestSchema, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { generateManifestTools, listProviderTools } from "./generate-tools";
import type { McpBinding } from "./manifest";

const BINDING: McpBinding = { serverUrl: "https://mcp.example.test/mcp", transport: "streamable-http" };

/** The runner-level reap bound for every transport-leg test below. */
const LEG_TIMEOUT_MS = 20_000;

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
  /** Test seam: override start() (e.g. a promise that never settles). */
  private readonly startImpl: () => Promise<void>;
  constructor(startImpl: () => Promise<void> = async () => {}) {
    this.startImpl = startImpl;
  }
  async start(): Promise<void> {
    await this.startImpl();
  }
  async send(_message: JSONRPCMessage): Promise<void> {}
  async close(): Promise<void> {
    this.onclose?.();
  }
}

describe("generateManifestTools: fake tools/list over the in-memory transport seam", () => {
  test(
    "generates the full surface: wire providerName, params from inputSchema, conservative tiers",
    async () => {
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
      // string (JSON-serialized) keeping jsonType "array" so the runtime
      // restores the native array before the wire call (issue #248); required
      // from the schema's required list.
      const search = generation.tools[0]!;
      expect(search.params).toEqual([
        { name: "query", type: "string", description: "Search query" },
        { name: "limit", type: "number", description: "Max results", required: false },
        { name: "labels", type: "string", jsonType: "array", description: "Label names", required: false },
        { name: "archived", type: "boolean", description: "Include archived", required: false },
      ]);
      // A schema with no required list → every param explicitly optional.
      expect(generation.tools[4]!.params).toEqual([]);
      expect(generation.tools[1]!.params).toEqual([{ name: "issueNumber", type: "number" }]);
      // Server descriptions pass through.
      expect(search.description).toBe("Search issues across repositories");
    },
    LEG_TIMEOUT_MS,
  );

  test(
    "unknown/unsafe-looking tools get conservative tiers",
    async () => {
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
    },
    LEG_TIMEOUT_MS,
  );

  test(
    "the SDK rejects a tool missing inputSchema — the whole list fails closed, nothing generated",
    async () => {
      await expect(
        generateManifestTools({
          binding: BINDING,
          extensionId: "fake",
          mcpTransport: fakeToolsServer([{ name: "no_schema_tool", description: "omits the MCP-required inputSchema" }]),
        }),
      ).rejects.toThrow(/tools\/list failed/);
    },
    LEG_TIMEOUT_MS,
  );

  test(
    "an unreachable provider or a malformed tools/list fails closed with a clear error",
    async () => {
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
    },
    LEG_TIMEOUT_MS,
  );

  test(
    "a server that never responds fails the discovery within the bound (issue #205)",
    async () => {
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
    },
    LEG_TIMEOUT_MS,
  );

  test(
    "a transport whose start() NEVER settles still fails at the wall-clock bound (2026-08-26 CI hang)",
    async () => {
      // Regression for the 2026-08-26 coverage-job hang: on the Linux runner
      // this file went silent for 1085s inside the SDK's connect path — the
      // SDK's per-request `timeout` options bound each RPC but NOT the
      // transport lifecycle around them, so a start() that never settles
      // (a wedged stdio spawn, an instrumented InMemory pair) hung the whole
      // suite. The wrapper's Promise.race deadline is the backstop: the
      // discovery must reject at ~timeoutMs even when the transport's own
      // promise never resolves and never rejects.
      const neverSettles = (): Transport => new SilentTransport(() => new Promise<void>(() => {}));
      const start = Date.now();
      await expect(
        listProviderTools({ command: "wedged-server", transport: "stdio" }, neverSettles, { timeoutMs: 150 }),
      ).rejects.toThrow(/wall-clock bound/);
      expect(Date.now() - start).toBeLessThan(5_000);
    },
    LEG_TIMEOUT_MS,
  );
});
