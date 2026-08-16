import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseYamlSubset, type YamlNode } from "../yaml-subset";
import {
  BASE_EGRESS_DOMAINS,
  mergedEgressDomains,
  regenerateEgressConfig,
  renderEgressConfig,
  SNAPSHOTS_DIR,
} from "./generate";
import { readPinnedSnapshots, SNAPSHOT_SCHEMA } from "../extensions/registry";
import { createFixtureRegistry, FIXTURE_EXTENSION_DOMAIN } from "../extensions/fixture";

const COMMITTED_EGRESS = readFileSync(resolve(import.meta.dir, "../../config/egress.yml"), "utf8");

/** Domains the committed snapshots contribute (issue #54): read from the
 * live pinned files so the pinned expectation tracks new providers without
 * duplicating their domains here. */
const EXTENSION_DOMAINS = readPinnedSnapshots(SNAPSHOTS_DIR).flatMap((s) => s.manifest.domains);

function allowlistDomains(yaml: string): string[] {
  const cfg = parseYamlSubset(yaml);
  const transforms = cfg["transforms"] as YamlNode[];
  const allowlist = transforms.find((t) => (t as Record<string, YamlNode>)["name"] === "allowlist") as Record<
    string,
    YamlNode
  >;
  const config = allowlist["config"] as Record<string, YamlNode>;
  return config["domains"] as string[];
}

describe("egress config generation", () => {
  test("rendering with the base + pinned extension domains reproduces the committed config byte-for-byte", () => {
    // config/egress.yml is a generated artifact; this pins it to the
    // template so hand edits and generator drift both fail here. The
    // pinned extension domains (issue #54) are part of the committed
    // output, so they join the base when reproducing it.
    expect(renderEgressConfig(mergedEgressDomains(EXTENSION_DOMAINS))).toBe(COMMITTED_EGRESS);
  });

  test("the committed allowlist contains the NEAR.ai model endpoints and the three provider domains", () => {
    expect(allowlistDomains(COMMITTED_EGRESS)).toEqual(mergedEgressDomains(EXTENSION_DOMAINS));
    expect(EXTENSION_DOMAINS.sort()).toEqual(["api.github.com", "mcp.attio.com", "mcp.linear.app"]);
  });

  test("mergedEgressDomains appends extension domains after the base, deduped", () => {
    expect(mergedEgressDomains(["a.example.com", "b.example.com", "cloud-api.near.ai"])).toEqual([
      "cloud-api.near.ai",
      "*.completions.near.ai",
      "a.example.com",
      "b.example.com",
    ]);
  });

  test("the registry's fixture domains feed the merged allowlist", () => {
    const registry = createFixtureRegistry();
    expect(registry.egressDomains()).toContain(FIXTURE_EXTENSION_DOMAIN);
    const yaml = renderEgressConfig(mergedEgressDomains(registry.egressDomains()));
    const domains = allowlistDomains(yaml);
    expect(domains).toContain("cloud-api.near.ai");
    expect(domains).toContain(FIXTURE_EXTENSION_DOMAIN);
    // The rendered config stays a valid iron-proxy config (judge intact).
    expect(yaml).toContain('name: "egress-policy"');
    expect(yaml).toContain('fallback: "deny"');
  });

  test("regenerateEgressConfig writes snapshot domains into the allowlist", () => {
    const dir = mkdtempSync(join(tmpdir(), "egress-gen-"));
    try {
      const snapshotsDir = join(dir, "snapshots");
      mkdirSync(snapshotsDir);
      writeFileSync(
        join(snapshotsDir, "fixture.weather.json"),
        JSON.stringify({
          schema: SNAPSHOT_SCHEMA,
          extensionId: "fixture.weather",
          pinnedAt: "2026-08-16T00:00:00.000Z",
          source: {
            catalog: "https://integrations.sh/api",
            specId: "fixture-weather",
            vendorOfficial: true,
            reviewed: false,
          },
          manifest: {
            id: "fixture.weather",
            label: "Fixture Weather",
            vendor: "bottega-fixtures",
            kind: "mcp",
            mcp: { serverUrl: "http://127.0.0.1:9/mcp", transport: "streamable-http" },
            credentialSchema: { type: "api_key" },
            tools: [
              {
                name: "weather.current",
                tier: "read",
                description: "Current weather for a city",
                params: [{ name: "city", type: "string" }],
              },
            ],
            domains: [FIXTURE_EXTENSION_DOMAIN],
          },
        }),
      );
      const outPath = join(dir, "egress.yml");
      const yaml = regenerateEgressConfig(snapshotsDir, outPath);
      expect(readFileSync(outPath, "utf8")).toBe(yaml);
      expect(allowlistDomains(yaml)).toEqual([
        "cloud-api.near.ai",
        "*.completions.near.ai",
        FIXTURE_EXTENSION_DOMAIN,
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("regenerate with no snapshots reproduces the base-only config", () => {
    const dir = mkdtempSync(join(tmpdir(), "egress-gen-"));
    try {
      const outPath = join(dir, "egress.yml");
      regenerateEgressConfig(join(dir, "missing-snapshots"), outPath);
      expect(readFileSync(outPath, "utf8")).toBe(renderEgressConfig(BASE_EGRESS_DOMAINS));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
