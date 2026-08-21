/**
 * Fixture extension (issue #50, test-only): proves the registry shape — a
 * typed manifest whose tool registers into the space agent's toolset and
 * whose domains feed the egress allowlist. The three real providers are
 * their own issues; nothing here runs outside tests.
 */
import { createExtensionRegistry, type ExtensionRegistry } from "./registry";
import type { ExtensionManifest } from "./manifest";

export const FIXTURE_EXTENSION_ID = "fixture.weather";
export const FIXTURE_EXTENSION_TOOL = "weather.current";
export const FIXTURE_EXTENSION_DOMAIN = "fixture.weather.test";

export function fixtureManifest(): ExtensionManifest {
  return {
    id: FIXTURE_EXTENSION_ID,
    label: "Fixture Weather",
    vendor: "bottega-fixtures",
    kind: "mcp",
    mcp: { serverUrl: "http://127.0.0.1:9/mcp", transport: "streamable-http" },
    credentialSchema: { type: "api_key" },
    tools: [
      {
        name: FIXTURE_EXTENSION_TOOL,
        tier: "read",
        description:
          "Current weather for a city (fixture extension proving the registry shape; the " +
          "serverUrl is intentionally unreachable — real provider bindings are their own issues).",
        params: [{ name: "city", type: "string", description: "City name", required: true }],
      },
    ],
    domains: [FIXTURE_EXTENSION_DOMAIN],
    credentialTargets: [{ host: FIXTURE_EXTENSION_DOMAIN, pathPrefix: "/mcp" }],
  };
}

export function createFixtureRegistry(): ExtensionRegistry {
  const registry = createExtensionRegistry();
  registry.register(fixtureManifest());
  return registry;
}
