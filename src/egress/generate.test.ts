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
import { readPinnedSnapshots, SNAPSHOT_SCHEMA, type PinnedSnapshot } from "../extensions/registry";
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
    // The committed SEED fixtures (issue #233): github/linear/attio pins —
    // notion is gone (its registration is a runtime connect, merged into
    // the egress only when registered at runtime). Copy before sorting:
    // EXTENSION_DOMAINS is a module-level constant later byte-pin tests
    // render with (in-place sort would corrupt the registration order).
    expect([...EXTENSION_DOMAINS].sort()).toEqual([
      "api.githubcopilot.com",
      "mcp.attio.com",
      "mcp.linear.app",
    ]);
  });

  test("the base allowlist permits the OpenAI and Anthropic model gateways (#37ee2bf)", () => {
    // The OpenAI/Anthropic providers (37ee2bf) call api.openai.com/v1 and
    // api.anthropic.com/v1; without these in the deployed allowlist the new
    // providers die in compose (default-deny egress 403s them).
    expect(BASE_EGRESS_DOMAINS).toContain("api.openai.com");
    expect(BASE_EGRESS_DOMAINS).toContain("api.anthropic.com");
    expect(BASE_EGRESS_DOMAINS).toContain("chatgpt.com");
    const domains = allowlistDomains(COMMITTED_EGRESS);
    expect(domains).toContain("api.openai.com");
    expect(domains).toContain("api.anthropic.com");
    expect(domains).toContain("chatgpt.com");
    expect(allowlistDomains(renderEgressConfig(BASE_EGRESS_DOMAINS))).toContain("api.anthropic.com");
  });

  test("the base allowlist permits Slack file downloads", () => {
    expect(BASE_EGRESS_DOMAINS).toContain("files.slack.com");
  });

  test("the base allowlist permits the server's own Slack traffic (issue #126)", () => {
    // The Socket Mode adapter (src/server/adapters/slack.ts) calls the Web
    // API at slack.com/api/* (@slack/web-api's default slackApiUrl — also
    // served on api.slack.com) and opens the Socket Mode websocket on
    // *.slack.com (wss-primary/wss-secondary from apps.connections.open).
    // Without these the strict allowlist default-denies the server's own
    // Slack traffic in deployment; the dev config is allow-all, so dev
    // never sees the 403s.
    expect(BASE_EGRESS_DOMAINS).toContain("slack.com");
    expect(BASE_EGRESS_DOMAINS).toContain("api.slack.com");
    expect(BASE_EGRESS_DOMAINS).toContain("*.slack.com");
    const domains = allowlistDomains(COMMITTED_EGRESS);
    expect(domains).toContain("slack.com");
    expect(domains).toContain("api.slack.com");
    expect(domains).toContain("*.slack.com");
    expect(allowlistDomains(renderEgressConfig(BASE_EGRESS_DOMAINS))).toContain("*.slack.com");
  });

  test("rendering without extensions still emits the model-gateway secrets entries (base config is unchanged)", () => {
    // Issue #208: the model-gateway static-key entries are base config —
    // only the extension entries are optional. The codex provider (issue
    // #214) is one of those static entries now (issue #230: the seed owns
    // the refresh and writes the access token to openai-codex.secret) —
    // the oauth_token transform is emitted ONLY when an extension
    // snapshot carries an oauth credential.
    const yaml = renderEgressConfig(BASE_EGRESS_DOMAINS);
    expect(yaml).toContain("- name: secrets");
    expect(yaml).toContain('path: "/data/proxy-secrets/near.secret"');
    expect(yaml).toContain('path: "/data/proxy-secrets/openai-codex.secret"');
    expect(yaml).not.toContain("- name: oauth_token");
    expect(yaml).not.toContain("openai-codex-oauth.json");
    expect(yaml).not.toContain("https://auth.openai.com/oauth/token");
    expect(secretsEntries(yaml)?.length).toBe(5); // near/opencode/openai/anthropic/openai-codex
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
    // 5 model-gateway keys (issue #208 + #230, incl. openai-codex) + the fixture extension.
    expect(entries).toHaveLength(6);
    // SAFETY: every rendered secrets entry's `source` is a block mapping
    // carrying a `path` scalar (renderSecretsTransform emits it).
    const fixture = entries.find((e) => String((e["source"] as Record<string, YamlNode>)["path"]).includes(FIXTURE_EXTENSION_ID));
    expect(fixture).toMatchObject({
      source: { type: "file", path: `/data/proxy-secrets/${FIXTURE_EXTENSION_ID}.secret` },
      inject: { header: "Authorization", formatter: "Bearer {{ .Value }}" },
    });
    // SAFETY: renderSecretsTransform emits each entry's `rules` as a sequence of host-rule mappings.
    const rules = fixture!["rules"] as Record<string, YamlNode>[];
    expect(rules.map((r) => r["host"])).toEqual([FIXTURE_EXTENSION_DOMAIN, "api.example.com"]);
    // The gateway entries are REQUIRED (fail closed — issue #208).
    for (const provider of ["near", "opencode", "openai", "anthropic", "openai-codex"]) {
      // SAFETY: each gateway entry's `source` is a block mapping with a `path` scalar.
      const entry = entries.find((e) => String((e["source"] as Record<string, YamlNode>)["path"]).includes(`${provider}.secret`));
      expect(entry, `${provider} gateway entry`).toBeDefined();
      // SAFETY: each gateway entry's `inject` is a block mapping with a `require` scalar.
      expect(String((entry!["inject"] as Record<string, YamlNode>)["require"])).toBe("true");
    }
  });

  test("mergedEgressDomains appends extension domains after the base, deduped", () => {
    expect(mergedEgressDomains(["a.example.com", "b.example.com", "cloud-api.near.ai"])).toEqual([
      "cloud-api.near.ai",
      "*.completions.near.ai",
      "opencode.ai",
      "chatgpt.com",
      "api.openai.com",
      "api.anthropic.com",
      "raw.githubusercontent.com",
      "files.slack.com",
      "slack.com",
      "api.slack.com",
      "*.slack.com",
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
        "chatgpt.com",
        "api.openai.com",
        "api.anthropic.com",
        "raw.githubusercontent.com",
        "files.slack.com",
        "slack.com",
        "api.slack.com",
        "*.slack.com",
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
    expect(secretsEntries(yaml)?.length).toBe(5); // the model-gateway keys (issue #208 + #230)
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

describe("runtime registry merge (issue #233)", () => {
  /** A runtime-registered notion-shaped snapshot (the catalog connect's
   * durable record — store state, never a repo file). */
  function runtimeSnapshot(extensionId: string, domains: string[], credentialType: "oauth" | "api_key"): PinnedSnapshot {
    return {
      schema: SNAPSHOT_SCHEMA,
      extensionId,
      pinnedAt: "2026-08-18T00:00:00.000Z",
      source: { catalog: "https://integrations.sh/api", specId: extensionId, vendorOfficial: true, reviewed: true },
      manifest: {
        id: extensionId,
        label: extensionId,
        vendor: extensionId,
        kind: "mcp",
        mcp: { serverUrl: `https://mcp.${extensionId}.example.com/mcp`, transport: "streamable-http" },
        credentialSchema: { type: credentialType },
        domains,
      },
    };
  }

  test("regenerateEgressConfig merges the RUNTIME set (domains + oauth_token entries) into the emitted config", () => {
    const dir = mkdtempSync(join(tmpdir(), "egress-runtime-"));
    try {
      const outPath = join(dir, "egress.yml");
      // The OAuth runtime extension uses a "fixture."-prefixed id (the
      // canary's synthesized-endpoint seam — there is no real authorization
      // server behind a fixture domain); the api_key one is a plain id.
      const runtime = [
        runtimeSnapshot("fixture.runtime-oauth", ["fixture-runtime.example.com"], "oauth"),
        runtimeSnapshot("runtime-key", ["runtime-key.example.com", "mcp.runtime-key.example.com"], "api_key"),
      ];
      const yaml = regenerateEgressConfig(join(dir, "missing-snapshots"), outPath, runtime);
      expect(readFileSync(outPath, "utf8")).toBe(yaml);
      // Runtime domains join the allowlist (after the base set).
      const domains = allowlistDomains(yaml);
      expect(domains).toContain("fixture-runtime.example.com");
      expect(domains).toContain("runtime-key.example.com");
      // The OAuth runtime extension gets an oauth_token entry (the #198
      // mint shape; the endpoint is synthesized from its own allowlisted
      // host — a fixture id, never a guessed production URL)…
      expect(yaml).toContain("fixture.runtime-oauth-oauth.json");
      expect(yaml).toContain('token_endpoint: "https://fixture-runtime.example.com/token"');
      // …and the api_key runtime extension gets a secrets file entry.
      expect(yaml).toContain('path: "/data/proxy-secrets/runtime-key.secret"');
      // The base config stays intact around the merge.
      expect(yaml).toContain('fallback: "deny"');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("regenerateDevEgressConfig merges the same runtime set", () => {
    const dir = mkdtempSync(join(tmpdir(), "egress-runtime-"));
    try {
      const outPath = join(dir, "egress.dev.yml");
      const runtime = [runtimeSnapshot("runtime-key", ["runtime-key.example.com"], "api_key")];
      const yaml = regenerateDevEgressConfig(join(dir, "missing-snapshots"), outPath, runtime);
      expect(readFileSync(outPath, "utf8")).toBe(yaml);
      expect(yaml).toContain('path: "/data/proxy-secrets/runtime-key.secret"');
      expect(allowlistDomains(yaml)).toEqual(["*"]); // dev stays allow-all
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the committed byte-pin tests stay hermetic on the SEED fixtures: an empty runtime set reproduces the committed configs", () => {
    // Issue #233's hermeticity contract: the runtime set is INJECTED via
    // fixtures; the committed configs are byte-pinned to the seed only.
    // Re-read the pinned seed fresh (the module-level EXTENSION_DOMAINS is
    // registration-ordered but some tests copy-sort it; a fresh read keeps
    // this pin independent of sibling test order).
    const committedDev = readFileSync(resolve(import.meta.dir, `../../${DEV_EGRESS_CONFIG_PATH}`), "utf8");
    const seed = readPinnedSnapshots(SNAPSHOTS_DIR);
    const seedDomains = seed.flatMap((s) => s.manifest.domains);
    const seedEntries = apiKeyExtensionEntries(seed);
    const seedOAuth = oauthTokenEntries(seed);
    expect(renderEgressConfig(mergedEgressDomains(seedDomains), seedEntries, seedOAuth)).toBe(COMMITTED_EGRESS);
    expect(renderDevEgressConfig(seedEntries, seedOAuth)).toBe(committedDev);
  });
});

describe("oauth_token rule scoping (issue #246)", () => {
  /** A notion-shaped RUNTIME snapshot (the #233 store-backed record — not
   * a repo pin): resource at /mcp, domains notion.com + mcp.notion.com.
   * Mirrors the connect-flow merge the generator performs. */
  function notionRuntimeSnapshot(): PinnedSnapshot {
    return {
      schema: SNAPSHOT_SCHEMA,
      extensionId: "notion",
      pinnedAt: "2026-08-18T00:00:00.000Z",
      source: { catalog: "https://integrations.sh/api", specId: "notion", vendorOfficial: true, reviewed: true },
      manifest: {
        id: "notion",
        label: "Notion",
        vendor: "Notion",
        kind: "mcp",
        mcp: { serverUrl: "https://mcp.notion.com/mcp", transport: "streamable-http" },
        credentialSchema: { type: "oauth" },
        domains: ["notion.com", "mcp.notion.com"],
      },
    };
  }

  /** The merged snapshot set the runtime connect produces: the pinned seed
   * (attio/linear OAuth) plus a notion-shaped runtime registration. */
  const MERGED_SNAPSHOTS = [...SNAPSHOTS, notionRuntimeSnapshot()];
  const MERGED_ENTRIES = oauthTokenEntries(MERGED_SNAPSHOTS);
  // The runtime render merges the runtime domains into the allowlist too
  // (issue #233) — the strict render needs them to be internally coherent.
  const MERGED_DOMAINS = mergedEgressDomains(MERGED_SNAPSHOTS.flatMap((s) => s.manifest.domains));
  const MERGED_YAML = renderEgressConfig(MERGED_DOMAINS, apiKeyExtensionEntries(MERGED_SNAPSHOTS), MERGED_ENTRIES);

  /** Every oauth_token rule across the render, or null when the transform is absent. */
  function oauthTokenRules(yaml: string): Record<string, YamlNode>[] | null {
    const cfg = parseYamlSubset(yaml);
    // SAFETY: every rendered egress config emits `transforms` as a top-level sequence.
    const transforms = cfg["transforms"] as YamlNode[];
    const oauth = transforms.find((t) => (t as Record<string, YamlNode>)["name"] === "oauth_token");
    if (oauth === undefined) return null;
    // SAFETY: the oauth_token transform is a mapping whose `config` is a block mapping.
    const config = (oauth as Record<string, YamlNode>)["config"] as Record<string, YamlNode>;
    // SAFETY: the config's `tokens` is a sequence of entry mappings each holding a `rules` sequence.
    const tokens = config["tokens"] as YamlNode[];
    const rules: Record<string, YamlNode>[] = [];
    for (const token of tokens) {
      rules.push(...((token as Record<string, YamlNode>)["rules"] as Record<string, YamlNode>[]));
    }
    return rules;
  }

  /** A rule's path globs; [] when the rule carries no `paths` (the pre-fix bare-host shape). */
  function rulePaths(rule: Record<string, YamlNode>): string[] {
    const paths = rule["paths"];
    if (!Array.isArray(paths)) return [];
    return paths as string[];
  }

  /**
   * Mirrors iron-proxy v0.49.0 hostmatch.MatchPath (verified 2026-08-19
   * from ironsh/iron-proxy internal/hostmatch/path.go): a pattern ending
   * `/*` matches the exact base path OR any path under it (prefix must end
   * at a `/` — `/mcp/*` matches `/mcp` and `/mcp/anything`, never
   * `/mcpx`); any other pattern uses path.Match glob semantics (`*` =
   * non-separator run), which for our emitted literal resource path
   * degenerates to exact equality.
   */
  function globMatchesPath(pattern: string, reqPath: string): boolean {
    if (pattern.endsWith("/*")) {
      const prefix = pattern.slice(0, -1); // "/mcp/"
      const base = pattern.slice(0, -2); // "/mcp"
      return reqPath.startsWith(prefix) || reqPath === base;
    }
    // Go path.Match: `*` matches any run of non-`/` characters.
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*");
    return new RegExp(`^${escaped}$`).test(reqPath);
  }

  test("every oauth_token rule is path-scoped so public .well-known metadata never mints (issue #246)", () => {
    const rules = oauthTokenRules(MERGED_YAML);
    expect(rules).not.toBeNull();
    expect(rules!.length).toBeGreaterThan(0);
    // The RFC 8414/9207 discovery endpoints the SDK probes BEFORE any
    // credential exists (catalog-register.ts probes them; the MCP OAuth SDK
    // needs them to mint). A rule matching one of these under require: true
    // 502s the connect (issue #246's symptom).
    const discoveryPaths = [
      "/.well-known/oauth-authorization-server",
      "/.well-known/oauth-protected-resource/mcp",
    ];
    for (const rule of rules!) {
      // Every rule MUST be path-scoped (issue #246): the pre-fix bare-host
      // rules have no `paths` at all, so this assertion fails red.
      expect(rulePaths(rule).length, `rule for ${String(rule["host"])} is not path-scoped`).toBeGreaterThan(0);
      for (const pattern of rulePaths(rule)) {
        for (const discovery of discoveryPaths) {
          expect(
            globMatchesPath(pattern, discovery),
            `rule for ${String(rule["host"])} scoping "${pattern}" matches discovery ${discovery}`,
          ).toBe(false);
        }
      }
    }
  });

  test("the MCP resource path still matches an oauth_token rule for every provider host (minting preserved)", () => {
    const rules = oauthTokenRules(MERGED_YAML)!;
    // Every allowlisted OAuth host keeps a rule whose scope covers the
    // /mcp resource — real API calls stay fail-closed with the minted
    // token injected.
    const oauthHosts = MERGED_SNAPSHOTS.filter((s) => s.manifest.credentialSchema.type === "oauth")
      .flatMap((s) => s.manifest.domains);
    for (const host of oauthHosts) {
      const rule = rules.find((r) => String(r["host"]) === host);
      expect(rule, `no oauth_token rule for ${host}`).toBeDefined();
      expect(
        rulePaths(rule!).some((p) => globMatchesPath(p, "/mcp")),
        `rule for ${host} no longer scopes the /mcp resource`,
      ).toBe(true);
    }
    expect(oauthHosts.length).toBeGreaterThan(0);
  });

  test("oauth_token entries keep require true (fail-closed minting preserved)", () => {
    const cfg = parseYamlSubset(MERGED_YAML);
    // SAFETY: every rendered egress config emits `transforms` as a top-level sequence.
    const transforms = cfg["transforms"] as YamlNode[];
    const oauth = transforms.find((t) => (t as Record<string, YamlNode>)["name"] === "oauth_token")!;
    // SAFETY: the oauth_token transform's `config` is a block mapping carrying `tokens`.
    const tokens = ((oauth as Record<string, YamlNode>)["config"] as Record<string, YamlNode>)["tokens"] as YamlNode[];
    expect(tokens.length).toBeGreaterThan(0);
    for (const token of tokens) {
      expect(String((token as Record<string, YamlNode>)["require"])).toBe("true");
    }
  });
});
