/**
 * Effective tool surface resolution (issue #158): a tools-less manifest
 * discovers its FULL tool surface from the provider's tools/list through
 * the #157 transport seam with conservative tiers; pinned tools win (no
 * discovery); the cache keys by manifest id + binding; an unreachable
 * provider fails closed with a clear error — never a silent empty set.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { createExtensionRegistry } from "./registry";
import { validateManifest, type ExtensionManifest, type McpBinding } from "./manifest";
import {
  extensionToolSurface,
  resetToolSurfaceCache,
  resolveExtensionSurfaces,
  toolOwnerExtensionId,
  type ExtensionSurfaces,
} from "./surface";

const BINDING: McpBinding = { serverUrl: "https://mcp.example.test/mcp", transport: "streamable-http" };

/** A tools-less mcp manifest (the discovery subject). */
function toolsLessManifest(overrides: Partial<ExtensionManifest> = {}): ExtensionManifest {
  return validateManifest(
    JSON.parse(
      JSON.stringify({
        id: "discover.me",
        label: "Discover Me",
        vendor: "example",
        kind: "mcp",
        mcp: BINDING,
        credentialSchema: { type: "api_key" },
        domains: ["mcp.example.test"],
        ...overrides,
      }),
    ),
  );
}

/** A fake MCP server whose tools/list returns the given wire tools (counting calls). */
function fakeToolsServer(tools: unknown[], calls: { count: number }): (binding: McpBinding) => Transport {
  return () => {
    calls.count += 1;
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = new Server({ name: "fake-mcp", version: "1.0.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
    void server.connect(serverTransport);
    return clientTransport;
  };
}

const FAKE_WIRE_TOOLS = [
  {
    name: "search_issues",
    description: "Search issues",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
  {
    name: "create_issue",
    description: "Create an issue",
    inputSchema: { type: "object", properties: { title: { type: "string" } } },
  },
  {
    name: "delete_issue",
    description: "Delete an issue",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_thing",
    description: "Read a thing",
    annotations: { readOnlyHint: true },
    inputSchema: { type: "object", properties: {} },
  },
  { name: "repository", description: "Repository info", inputSchema: { type: "object" } },
];

beforeEach(() => {
  resetToolSurfaceCache();
});

describe("extensionToolSurface (issue #158 runtime discovery)", () => {
  test("a tools-less manifest discovers the FULL fake surface with conservative tiers", async () => {
    const surface = await extensionToolSurface(
      toolsLessManifest(),
      fakeToolsServer(FAKE_WIRE_TOOLS, { count: 0 }),
    );
    // The full provider surface — namespaced names + wire providerNames.
    expect(surface.map((tool) => tool.name)).toEqual([
      "discover.me.search_issues",
      "discover.me.create_issue",
      "discover.me.delete_issue",
      "discover.me.get_thing",
      "discover.me.repository",
    ]);
    expect(surface.map((tool) => tool.providerName)).toEqual([
      "search_issues",
      "create_issue",
      "delete_issue",
      "get_thing",
      "repository",
    ]);
    // Conservative tiers (the #157 heuristic, shared — never duplicated):
    // read verbs/hints → read; mutating/unknown → write; destructive → exec.
    expect(surface.map((tool) => tool.tier)).toEqual(["read", "write", "exec", "read", "write"]);
    // Params come from the server's inputSchema.
    expect(surface[0]!.params).toEqual([{ name: "query", type: "string" }]);
  });

  test("pinned tools win: no discovery happens for a manifest WITH tools (backward compatible)", async () => {
    const calls = { count: 0 };
    const pinned = toolsLessManifest({
      id: "pinned.me",
      tools: [
        {
          name: "pinned.me.only",
          tier: "read",
          description: "The reviewed surface",
          params: [],
        },
      ],
    });
    const surface = await extensionToolSurface(
      pinned,
      // A throwing transport proves tools/list is never consulted.
      () => {
        calls.count += 1;
        throw new Error("must never be called");
      },
    );
    expect(surface.map((tool) => tool.name)).toEqual(["pinned.me.only"]);
    expect(calls.count).toBe(0);
  });

  test("tools: [] is a deliberate pinned empty surface — still no discovery", async () => {
    const calls = { count: 0 };
    const egressOnly = toolsLessManifest({ id: "egress.only", tools: [] });
    const surface = await extensionToolSurface(egressOnly, () => {
      calls.count += 1;
      throw new Error("must never be called");
    });
    expect(surface).toEqual([]);
    expect(calls.count).toBe(0);
  });

  test("a tools-less cli manifest has no tools/list protocol — an egress-only empty surface", async () => {
    const cli = validateManifest({
      id: "cli.only",
      label: "CLI Only",
      vendor: "example",
      kind: "cli",
      cli: { command: "/usr/bin/example" },
      credentialSchema: { type: "api_key" },
      domains: ["api.example.com"],
    });
    expect(await extensionToolSurface(cli)).toEqual([]);
  });

  test("the cache keys by manifest id + binding: one tools/list per key", async () => {
    const calls = { count: 0 };
    const manifest = toolsLessManifest();
    const transport = fakeToolsServer(FAKE_WIRE_TOOLS, calls);
    const first = await extensionToolSurface(manifest, transport);
    const second = await extensionToolSurface(manifest, transport);
    expect(first).toHaveLength(FAKE_WIRE_TOOLS.length);
    expect(second).toBe(first); // same cached array
    expect(calls.count).toBe(1);
    // A DIFFERENT binding (same id) is a fresh cache entry.
    const otherBinding = toolsLessManifest({
      mcp: { serverUrl: "https://other.example.test/mcp", transport: "streamable-http" },
    });
    await extensionToolSurface(otherBinding, transport);
    expect(calls.count).toBe(2);
  });

  test("an unreachable provider or invalid tools/list fails closed with a clear error", async () => {
    await expect(
      extensionToolSurface(
        toolsLessManifest(),
        () => {
          throw new Error("connection refused");
        },
      ),
    ).rejects.toThrow(/tools\/list failed/);

    // Malformed tools/list response (fails the SDK's ListToolsResultSchema).
    const broken = (): Transport => {
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const server = new Server({ name: "broken-mcp", version: "1.0.0" }, { capabilities: { tools: {} } });
      server.setRequestHandler(ListToolsRequestSchema, async () =>
        // SAFETY: the malformed response is the point of the test — the SDK's
        // ListToolsResultSchema must reject it, so the typed handler return is
        // deliberately bypassed (never) to inject the invalid shape.
        ({ tools: "nope" }) as never,
      );
      void server.connect(serverTransport);
      return clientTransport;
    };
    await expect(extensionToolSurface(toolsLessManifest(), broken)).rejects.toThrow(/tools\/list failed/);
  });
});

describe("resolveExtensionSurfaces (the server boot step)", () => {
  test("resolves every registered extension's effective surface in one map", async () => {
    const registry = createExtensionRegistry();
    registry.register(
      validateManifest(
        JSON.parse(
          JSON.stringify({
            id: "pinned.provider",
            label: "Pinned",
            vendor: "example",
            kind: "mcp",
            mcp: BINDING,
            credentialSchema: { type: "api_key" },
            tools: [{ name: "pinned.provider.get", tier: "read", description: "d", params: [] }],
            domains: ["pinned.example"],
          }),
        ),
      ),
    );
    registry.register(toolsLessManifest({ id: "discover.me" }));

    const surfaces = await resolveExtensionSurfaces(registry.list(), {
      mcpTransport: fakeToolsServer(FAKE_WIRE_TOOLS, { count: 0 }),
    });
    expect(surfaces.get("pinned.provider")?.map((tool) => tool.name)).toEqual(["pinned.provider.get"]);
    expect(surfaces.get("discover.me")?.map((tool) => tool.name)).toEqual([
      "discover.me.search_issues",
      "discover.me.create_issue",
      "discover.me.delete_issue",
      "discover.me.get_thing",
      "discover.me.repository",
    ]);
  });

  test("skips an unreachable tools-less provider at boot — reachable providers still resolve eagerly (issue #166)", async () => {
    const registry = createExtensionRegistry();
    registry.register(
      toolsLessManifest({
        id: "reachable.one",
        mcp: { serverUrl: "https://reachable.one.test/mcp", transport: "streamable-http" },
      }),
    );
    registry.register(
      toolsLessManifest({
        id: "unreachable.two",
        mcp: { serverUrl: "https://unreachable.two.test/mcp", transport: "streamable-http" },
      }),
    );
    const transports = new Map<string, (binding: McpBinding) => Transport>();
    transports.set(
      "reachable.one",
      fakeToolsServer([{ name: "get_ok", description: "ok", inputSchema: { type: "object" } }], { count: 0 }),
    );
    transports.set(
      "unreachable.two",
      () => {
        throw new Error("connection refused");
      },
    );
    const surfaces = await resolveExtensionSurfaces(registry.list(), {
      mcpTransport: (binding) => {
        // Route by binding serverUrl so each manifest gets its own transport.
        const serverUrl = binding.transport === "streamable-http" ? binding.serverUrl : "";
        for (const [id, make] of transports) {
          if (serverUrl.includes(id)) return make(binding);
        }
        throw new Error(`no transport for ${serverUrl}`);
      },
    });
    // The boot NEVER fails on a per-provider discovery failure (issue
    // #166): the reachable provider resolves eagerly into the map, the
    // unreachable one is absent — deferred to the runtime's lazy per-call
    // path, which fails closed.
    expect(surfaces.get("reachable.one")?.map((tool) => tool.name)).toEqual(["reachable.one.get_ok"]);
    expect(surfaces.has("unreachable.two")).toBe(false);
    expect(surfaces.size).toBe(1);
  });

  test("boot fails open on the provider, but LOUDLY names a CONNECTED-but-dead provider; never-connected providers keep the silent skip (issue #257)", async () => {
    const registry = createExtensionRegistry();
    registry.register(toolsLessManifest({ id: "connected.dead" }));
    registry.register(toolsLessManifest({ id: "never.connected" }));

    const bootLines: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      bootLines.push(args.map(String).join(" "));
    };
    let surfaces: ExtensionSurfaces;
    try {
      surfaces = await resolveExtensionSurfaces(registry.list(), {
        mcpTransport: () => {
          throw new Error("tools/list connection refused");
        },
        // The composition root's store probe: connected = has a credential row.
        isConnected: async (providerId) => providerId === "connected.dead",
      });
    } finally {
      console.error = originalError;
    }

    // Neither surface resolved and boot did NOT throw (issue #166).
    expect(surfaces.size).toBe(0);

    // Connected-but-dead: the LOUD fail-closed warning, naming the provider
    // and the recovery action — never a silent skip.
    const loud = bootLines.find((line) => line.includes("CONNECTED provider"));
    expect(loud).toContain('"connected.dead"');
    expect(loud).toContain("has a saved credential but can no longer mint");
    expect(loud).toContain('Re-run "connect connected.dead"');
    expect(loud).toContain("every call to it stays fail-closed");

    // Never-connected (no credential row): the pre-existing SILENT skip with
    // lazy per-call resolution — unchanged by issue #257.
    const silent = bootLines.find((line) => line.includes('skipping "never.connected"'));
    expect(silent).toBeTruthy();
    expect(silent).toContain("resolves it lazily per call");
    expect(bootLines.some((line) => line.includes("CONNECTED provider") && line.includes("never.connected"))).toBe(false);
  });
});

describe("toolOwnerExtensionId (the MCP surface's name→extension seam)", () => {
  test("resolves owners across pinned AND discovered surfaces", async () => {
    const registry = createExtensionRegistry();
    registry.register(
      validateManifest(
        JSON.parse(
          JSON.stringify({
            id: "pinned.provider",
            label: "Pinned",
            vendor: "example",
            kind: "mcp",
            mcp: BINDING,
            credentialSchema: { type: "api_key" },
            tools: [{ name: "pinned.provider.get", tier: "read", description: "d", params: [] }],
            domains: ["pinned.example"],
          }),
        ),
      ),
    );
    registry.register(toolsLessManifest({ id: "discover.me" }));

    const transport = fakeToolsServer(FAKE_WIRE_TOOLS, { count: 0 });
    expect(await toolOwnerExtensionId(registry, "pinned.provider.get", transport)).toBe("pinned.provider");
    // Discovered surface: the namespaced name resolves to the tools-less extension.
    expect(await toolOwnerExtensionId(registry, "discover.me.search_issues", transport)).toBe("discover.me");
    expect(await toolOwnerExtensionId(registry, "bash", transport)).toBeUndefined();
  });
});
