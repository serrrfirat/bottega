import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseYamlSubset, type YamlNode } from "../yaml-subset";
import {
  BASE_EGRESS_DOMAINS,
  DEV_EGRESS_CONFIG_PATH,
  mergedEgressDomains,
  regenerateDevEgressConfig,
  regenerateEgressConfig,
  renderDevEgressConfig,
  renderEgressConfig,
  SNAPSHOTS_DIR,
  renderSecretsTransform,
} from "./generate";
import { readPinnedSnapshots, SNAPSHOT_SCHEMA } from "../extensions/registry";
import { createFixtureRegistry, FIXTURE_EXTENSION_DOMAIN, FIXTURE_EXTENSION_ID } from "../extensions/fixture";

const COMMITTED_EGRESS = readFileSync(resolve(import.meta.dir, "../../config/egress.yml"), "utf8");

/** Committed snapshots (issue #54): read once from the live pinned files so
 * the pinned expectations track new providers without duplicating their
 * domains here. */
const SNAPSHOTS = readPinnedSnapshots(SNAPSHOTS_DIR);
const EXTENSION_DOMAINS = SNAPSHOTS.flatMap((s) => s.manifest.domains);

/** Injection entries for the committed snapshots (issue #53). */
const EXTENSION_ENTRIES = SNAPSHOTS.map((s) => ({
  extensionId: s.manifest.id,
  domains: s.manifest.domains,
}));

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

/** The secrets transform's entries from a rendered config, or null when absent. */
function secretsEntries(yaml: string): Record<string, YamlNode>[] | null {
  const cfg = parseYamlSubset(yaml);
  const transforms = cfg["transforms"] as YamlNode[];
  const secrets = transforms.find((t) => (t as Record<string, YamlNode>)["name"] === "secrets");
  if (secrets === undefined) return null;
  const config = (secrets as Record<string, YamlNode>)["config"] as Record<string, YamlNode>;
  return config["secrets"] as Record<string, YamlNode>[];
}

describe("egress config generation", () => {
  test("rendering with the base + pinned extension domains reproduces the committed config byte-for-byte", () => {
    // config/egress.yml is a generated artifact; this pins it to the
    // template so hand edits and generator drift both fail here. The
    // pinned extension domains (issue #54) and their credential-injection
    // entries (issue #53) are part of the committed output.
    expect(renderEgressConfig(mergedEgressDomains(EXTENSION_DOMAINS), EXTENSION_ENTRIES)).toBe(COMMITTED_EGRESS);
  });

  test("the committed allowlist contains model, KB, and provider domains", () => {
    expect(allowlistDomains(COMMITTED_EGRESS)).toEqual(mergedEgressDomains(EXTENSION_DOMAINS));
    expect(EXTENSION_DOMAINS.sort()).toEqual(["api.github.com", "mcp.attio.com", "mcp.linear.app"]);
  });

  test("the base allowlist permits Slack file downloads", () => {
    expect(BASE_EGRESS_DOMAINS).toContain("files.slack.com");
  });

  test("rendering without extensions emits no secrets transform (base config is unchanged)", () => {
    expect(renderEgressConfig(BASE_EGRESS_DOMAINS)).not.toContain("- name: secrets");
    expect(secretsEntries(renderEgressConfig(BASE_EGRESS_DOMAINS))).toBeNull();
  });

  test("rendered config enables the management API for boundary reloads (issue #123)", () => {
    const yaml = renderEgressConfig(BASE_EGRESS_DOMAINS);
    expect(yaml).toContain("management:");
    expect(yaml).toContain('listen: ":9092"');
    expect(yaml).toContain('api_key_env: "IRON_MANAGEMENT_API_KEY"');
  });

  test("renderSecretsTransform emits one inject entry per extension with its domains", () => {
    const yaml = renderSecretsTransform([
      { extensionId: FIXTURE_EXTENSION_ID, domains: [FIXTURE_EXTENSION_DOMAIN, "api.example.com"] },
    ]);
    const entries = secretsEntries(`transforms:\n${yaml}`) ?? [];
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      source: { type: "file", path: `/data/proxy-secrets/${FIXTURE_EXTENSION_ID}.secret` },
      inject: { header: "Authorization", formatter: "Bearer {{ .Value }}" },
    });
    const rules = entries[0]!["rules"] as Record<string, YamlNode>[];
    expect(rules.map((r) => r["host"])).toEqual([FIXTURE_EXTENSION_DOMAIN, "api.example.com"]);
  });

  test("mergedEgressDomains appends extension domains after the base, deduped", () => {
    expect(mergedEgressDomains(["a.example.com", "b.example.com", "cloud-api.near.ai"])).toEqual([
      "cloud-api.near.ai",
      "*.completions.near.ai",
      "raw.githubusercontent.com",
      "files.slack.com",
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
        "raw.githubusercontent.com",
        "files.slack.com",
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

describe("dev-permissive egress config (issue #126)", () => {
  const COMMITTED_DEV_EGRESS = readFileSync(resolve(import.meta.dir, `../../${DEV_EGRESS_CONFIG_PATH}`), "utf8");

  test("the committed dev config is byte-identical to renderDevEgressConfig with the pinned extensions", () => {
    // config/egress.dev.yml is a generated artifact (same discipline as the
    // strict config): hand edits and generator drift both fail here.
    expect(renderDevEgressConfig(EXTENSION_ENTRIES)).toBe(COMMITTED_DEV_EGRESS);
  });

  test("allow-all: the dev allowlist contains only \"*\"", () => {
    // iron-proxy v0.49.0 hostmatch glob semantics: MatchGlob("*", name) is
    // true for every host, so no request is denied at the allowlist layer.
    expect(allowlistDomains(COMMITTED_DEV_EGRESS)).toEqual(["*"]);
  });

  test("no judge transform and no judge key", () => {
    // The LLM policy gate was the dev restrictiveness (issue #126): the dev
    // config must not contain the transform, and must not REFERENCE the key
    // in any transform config (the header comment may mention it as
    // documentation that dev needs none).
    expect(COMMITTED_DEV_EGRESS).not.toContain("- name: judge");
    expect(COMMITTED_DEV_EGRESS).not.toContain("egress-policy");
    expect(COMMITTED_DEV_EGRESS).not.toContain('fallback: "deny"');
    expect(COMMITTED_DEV_EGRESS).not.toContain('api_key_env: "NEARAI_JUDGE_API_KEY"');
    expect(renderDevEgressConfig()).not.toContain("- name: judge");
  });

  test("keeps the secrets transform with the SAME injection entries as the strict config", () => {
    // Credential injection (issue #53) is the core requirement: the dev
    // proxy injects the boundary's secret files for the pinned extensions
    // exactly like the strict config does.
    expect(secretsEntries(COMMITTED_DEV_EGRESS)).toEqual(secretsEntries(COMMITTED_EGRESS));
  });

  test("keeps the management block for boundary reloads (issue #123)", () => {
    expect(COMMITTED_DEV_EGRESS).toContain("management:");
    expect(COMMITTED_DEV_EGRESS).toContain('listen: ":9092"');
    expect(COMMITTED_DEV_EGRESS).toContain('api_key_env: "IRON_MANAGEMENT_API_KEY"');
  });

  test("rendering the dev config without extensions still allow-alls and keeps management", () => {
    const yaml = renderDevEgressConfig();
    expect(allowlistDomains(yaml)).toEqual(["*"]);
    expect(secretsEntries(yaml)).toBeNull();
    expect(yaml).toContain('api_key_env: "IRON_MANAGEMENT_API_KEY"');
    expect(yaml).not.toContain("- name: judge");
  });

  test("regenerateDevEgressConfig writes the dev config and returns the rendered text", () => {
    const dir = mkdtempSync(join(tmpdir(), "egress-dev-gen-"));
    try {
      const outPath = join(dir, "egress.dev.yml");
      const yaml = regenerateDevEgressConfig(SNAPSHOTS_DIR, outPath);
      expect(readFileSync(outPath, "utf8")).toBe(yaml);
      expect(yaml).toBe(renderDevEgressConfig(EXTENSION_ENTRIES));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
