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
  apiKeyExtensionEntries,
  oauthTokenEntries,
} from "./generate";
import { readPinnedSnapshots, SNAPSHOT_SCHEMA } from "../extensions/registry";
import { createFixtureRegistry, FIXTURE_EXTENSION_DOMAIN, FIXTURE_EXTENSION_ID } from "../extensions/fixture";

const COMMITTED_EGRESS = readFileSync(resolve(import.meta.dir, "../../config/egress.yml"), "utf8");

/** Committed snapshots (issue #54): read once from the live pinned files so
 * the pinned expectations track new providers without duplicating their
 * domains here. */
const SNAPSHOTS = readPinnedSnapshots(SNAPSHOTS_DIR);
const EXTENSION_DOMAINS = SNAPSHOTS.flatMap((s) => s.manifest.domains);

/** File-injection entries for the committed api_key snapshots + the OAuth
 * entries for the oauth snapshots (issue #208: the proxy mints OAuth). */
const EXTENSION_ENTRIES = apiKeyExtensionEntries(SNAPSHOTS);
const OAUTH_ENTRIES = oauthTokenEntries(SNAPSHOTS);

function allowlistDomains(yaml: string): string[] {
  const cfg = parseYamlSubset(yaml);
  // SAFETY: every rendered egress config emits `transforms` as a top-level sequence (the strict and dev templates both do).
  const transforms = cfg["transforms"] as YamlNode[];
  // SAFETY: every transform entry is a block mapping carrying a `name` scalar, and exactly one entry is the allowlist.
  const allowlist = transforms.find((t) => (t as Record<string, YamlNode>)["name"] === "allowlist") as Record<
    string,
    YamlNode
  >;
  // SAFETY: the allowlist transform's `config` is a block mapping whose `domains` is a sequence of scalar strings.
  const config = allowlist["config"] as Record<string, YamlNode>;
  // SAFETY: the allowlist config's `domains` is a sequence of scalar strings.
  return config["domains"] as string[];
}

/** The secrets transform's entries from a rendered config, or null when absent. */
function secretsEntries(yaml: string): Record<string, YamlNode>[] | null {
  const cfg = parseYamlSubset(yaml);
  // SAFETY: every rendered egress config emits `transforms` as a top-level sequence whose entries are mappings with a `name` scalar.
  const transforms = cfg["transforms"] as YamlNode[];
  // SAFETY: when present, the secrets transform entry is a mapping carrying a `name` scalar.
  const secrets = transforms.find((t) => (t as Record<string, YamlNode>)["name"] === "secrets");
  if (secrets === undefined) return null;
  // SAFETY: when a secrets transform exists it is a mapping whose `config` is a block mapping.
  const config = (secrets as Record<string, YamlNode>)["config"] as Record<string, YamlNode>;
  // SAFETY: the secrets config's `secrets` value is a sequence of inject-entry mappings.
  return config["secrets"] as Record<string, YamlNode>[];
}

describe("egress config generation", () => {
  test("rendering with the base + pinned extension domains reproduces the committed config byte-for-byte", () => {
    // config/egress.yml is a generated artifact; this pins it to the
    // template so hand edits and generator drift both fail here. The
    // pinned extension domains (issue #54), their credential-injection
    // entries (issue #53), and the oauth_token transform for the OAuth
    // extensions (issue #208) are part of the committed output.
    expect(renderEgressConfig(mergedEgressDomains(EXTENSION_DOMAINS), EXTENSION_ENTRIES, OAUTH_ENTRIES)).toBe(
      COMMITTED_EGRESS,
    );
  });

  test("the committed allowlist contains model, KB, and provider domains", () => {
    expect(allowlistDomains(COMMITTED_EGRESS)).toEqual(mergedEgressDomains(EXTENSION_DOMAINS));
    expect(EXTENSION_DOMAINS.sort()).toEqual(["api.githubcopilot.com", "mcp.attio.com", "mcp.linear.app"]);
  });

  test("the base allowlist permits the OpenAI and Anthropic model gateways (#37ee2bf)", () => {
    // The OpenAI/Anthropic providers (37ee2bf) call api.openai.com/v1 and
    // api.anthropic.com/v1; without these in the deployed allowlist the new
    // providers die in compose (default-deny egress 403s them).
    expect(BASE_EGRESS_DOMAINS).toContain("api.openai.com");
    expect(BASE_EGRESS_DOMAINS).toContain("api.anthropic.com");
    const domains = allowlistDomains(COMMITTED_EGRESS);
    expect(domains).toContain("api.openai.com");
    expect(domains).toContain("api.anthropic.com");
    expect(allowlistDomains(renderEgressConfig(BASE_EGRESS_DOMAINS))).toContain("api.anthropic.com");
  });

  test("the base allowlist permits Slack file downloads", () => {
    expect(BASE_EGRESS_DOMAINS).toContain("files.slack.com");
  });

  test("rendering without extensions still emits the model-gateway secrets entries (base config is unchanged)", () => {
    // Issue #208: the model-gateway static-key entries are base config —
    // only the extension entries are optional. No oauth transform without
    // oauth entries.
    const yaml = renderEgressConfig(BASE_EGRESS_DOMAINS);
    expect(yaml).toContain("- name: secrets");
    expect(yaml).toContain('path: "/data/proxy-secrets/near.secret"');
    expect(yaml).not.toContain("- name: oauth_token");
    expect(secretsEntries(yaml)?.length).toBe(4); // near/opencode/openai/anthropic
  });

  test("rendered config enables the management API for boundary reloads (issue #123)", () => {
    const yaml = renderEgressConfig(BASE_EGRESS_DOMAINS);
    expect(yaml).toContain("management:");
    expect(yaml).toContain('listen: ":9092"');
    expect(yaml).toContain('api_key_env: "IRON_MANAGEMENT_API_KEY"');
  });

  test("renderSecretsTransform emits the gateway keys plus one inject entry per extension", () => {
    const yaml = renderSecretsTransform([
      { extensionId: FIXTURE_EXTENSION_ID, domains: [FIXTURE_EXTENSION_DOMAIN, "api.example.com"] },
    ]);
    const entries = secretsEntries(`transforms:\n${yaml}`) ?? [];
    // 4 model-gateway keys (issue #208) + the fixture extension.
    expect(entries).toHaveLength(5);
    const fixture = entries.find((e) => String((e["source"] as Record<string, YamlNode>)["path"]).includes(FIXTURE_EXTENSION_ID));
    expect(fixture).toMatchObject({
      source: { type: "file", path: `/data/proxy-secrets/${FIXTURE_EXTENSION_ID}.secret` },
      inject: { header: "Authorization", formatter: "Bearer {{ .Value }}" },
    });
    // SAFETY: renderSecretsTransform emits each entry's `rules` as a sequence of host-rule mappings.
    const rules = fixture!["rules"] as Record<string, YamlNode>[];
    expect(rules.map((r) => r["host"])).toEqual([FIXTURE_EXTENSION_DOMAIN, "api.example.com"]);
    // The gateway entries are REQUIRED (fail closed — issue #208).
    for (const provider of ["near", "opencode", "openai", "anthropic"]) {
      const entry = entries.find((e) => String((e["source"] as Record<string, YamlNode>)["path"]).includes(`${provider}.secret`));
      expect(entry, `${provider} gateway entry`).toBeDefined();
      expect(String((entry!["inject"] as Record<string, YamlNode>)["require"])).toBe("true");
    }
  });

  test("mergedEgressDomains appends extension domains after the base, deduped", () => {
    expect(mergedEgressDomains(["a.example.com", "b.example.com", "cloud-api.near.ai"])).toEqual([
      "cloud-api.near.ai",
      "*.completions.near.ai",
      "opencode.ai",
      "api.openai.com",
      "api.anthropic.com",
      "raw.githubusercontent.com",
      "files.slack.com",
      "api.github.com",
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
        "opencode.ai",
        "api.openai.com",
        "api.anthropic.com",
        "raw.githubusercontent.com",
        "files.slack.com",
        "api.github.com",
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
    expect(renderDevEgressConfig(EXTENSION_ENTRIES, OAUTH_ENTRIES)).toBe(COMMITTED_DEV_EGRESS);
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

  test("rendering the dev config without extensions still allow-alls, keeps management + the gateway entries", () => {
    const yaml = renderDevEgressConfig();
    expect(allowlistDomains(yaml)).toEqual(["*"]);
    expect(secretsEntries(yaml)?.length).toBe(4); // the model-gateway keys (issue #208)
    expect(yaml).toContain('api_key_env: "IRON_MANAGEMENT_API_KEY"');
    expect(yaml).not.toContain("- name: judge");
  });

  test("regenerateDevEgressConfig writes the dev config and returns the rendered text", () => {
    const dir = mkdtempSync(join(tmpdir(), "egress-dev-gen-"));
    try {
      const outPath = join(dir, "egress.dev.yml");
      const yaml = regenerateDevEgressConfig(SNAPSHOTS_DIR, outPath);
      expect(readFileSync(outPath, "utf8")).toBe(yaml);
      expect(yaml).toBe(renderDevEgressConfig(EXTENSION_ENTRIES, OAUTH_ENTRIES));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
