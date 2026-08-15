import { describe, expect, test } from "bun:test";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ExtensionContext, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { extensionToolDefinitions } from "./tools";
import { createFixtureRegistry, FIXTURE_EXTENSION_TOOL } from "./fixture";
import { validateManifest, type McpBinding } from "./manifest";

/** Minimal structural view of an omptype schema's parse surface. */
interface ParsableSchema {
  safeParse(value: unknown): { success: boolean };
}

/** Full ToolDefinition execute signature; tests call with a fake context. */
function run(def: ToolDefinition, params: Record<string, unknown>) {
  return def.execute("1", params, undefined, undefined, {} as ExtensionContext);
}

describe("extension tool bridge", () => {
  test("the fixture tool becomes an SDK definition with tier read and typed params", async () => {
    const definitions = extensionToolDefinitions(createFixtureRegistry().list());
    expect(definitions).toHaveLength(1);
    const definition = definitions[0];
    expect(definition.name).toBe(FIXTURE_EXTENSION_TOOL);
    expect(definition.label).toBe(FIXTURE_EXTENSION_TOOL);
    expect(definition.description).toContain("Current weather for a city");
    expect(definition.approval).toBe("read");

    const schema = definition.parameters as unknown as ParsableSchema;
    expect(schema.safeParse({ city: "Lisbon" }).success).toBe(true);
    expect(schema.safeParse({}).success).toBe(false); // city is required
  });

  test("cli extension tools shell out to the preinstalled command with --name value flags", async () => {
    const cli = validateManifest({
      id: "com.example.cli",
      label: "Example CLI",
      vendor: "example",
      kind: "cli",
      cli: { command: "/bin/echo", args: ["hello"] },
      credentialSchema: { type: "api_key" },
      tools: [
        {
          name: "example.greet",
          tier: "read",
          description: "Echoes a greeting",
          params: [
            { name: "name", type: "string", required: true },
            { name: "loud", type: "boolean" },
          ],
        },
      ],
      domains: ["api.example.com"],
    });
    const [definition] = extensionToolDefinitions([{ manifest: cli }]);
    const result = await run(definition, { name: "world", loud: true });
    expect(result.content).toEqual([{ type: "text", text: "hello --name world --loud\n" }]);
  });

  test("cli failures surface as tool errors, not silent no-ops", async () => {
    const cli = validateManifest({
      id: "com.example.cli",
      label: "Example CLI",
      vendor: "example",
      kind: "cli",
      cli: { command: "/usr/bin/false" },
      credentialSchema: { type: "api_key" },
      tools: [{ name: "example.fail", tier: "read", description: "Always fails", params: [] }],
      domains: ["api.example.com"],
    });
    const [definition] = extensionToolDefinitions([{ manifest: cli }]);
    const result = await run(definition, {});
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("exited 1");
  });

  test("mcp extension tools call the provider's official MCP server over the injected transport", async () => {
    const mcp = validateManifest({
      id: "com.example.mcp",
      label: "Example MCP",
      vendor: "example",
      kind: "mcp",
      mcp: { serverUrl: "http://127.0.0.1:1/mcp", transport: "streamable-http" },
      credentialSchema: { type: "oauth", scopes: ["read"] },
      tools: [
        {
          name: "weather.current",
          tier: "read",
          description: "Current weather",
          params: [{ name: "city", type: "string" }],
        },
      ],
      domains: ["api.example.com"],
    });
    const mcpTransport = (_binding: McpBinding): Transport => {
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const server = new Server({ name: "fixture-mcp", version: "1.0.0" }, { capabilities: { tools: {} } });
      server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const args = request.params.arguments as Record<string, unknown>;
        return { content: [{ type: "text", text: `sunny in ${args["city"]}` }] };
      });
      void server.connect(serverTransport);
      return clientTransport;
    };
    const [definition] = extensionToolDefinitions([{ manifest: mcp }], { mcpTransport });
    const result = await run(definition, { city: "Lisbon" });
    expect(result.content).toEqual([{ type: "text", text: "sunny in Lisbon" }]);
  });

  test("mcp connection failures surface as tool errors", async () => {
    const definitions = extensionToolDefinitions(createFixtureRegistry().list(), {
      // Force the fixture's (unreachable) serverUrl through a transport that
      // fails immediately, proving failures fail closed as tool errors.
      mcpTransport: () => {
        throw new Error("connection refused");
      },
    });
    const result = await run(definitions[0], { city: "Lisbon" });
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("connection refused");
  });

  test("a cli extension without a tool still yields no definitions", () => {
    const cli = validateManifest({
      id: "com.example.cli2",
      label: "Example CLI",
      vendor: "example",
      kind: "cli",
      cli: { command: "/bin/echo" },
      credentialSchema: { type: "api_key" },
      tools: [],
      domains: ["api.example.com"],
    });
    expect(extensionToolDefinitions([{ manifest: cli }])).toEqual([]);
  });
});
