import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseYamlSubset, type YamlNode } from "../yaml-subset";

const cfg = parseYamlSubset(
  readFileSync(resolve(import.meta.dir, "../../config/egress.yml"), "utf8"),
);

// config/egress.yml is hand-authored to the iron-proxy v0.49.0 schema; every
// key this suite reads is asserted below, so narrowing nodes to their rendered
// shapes (block mapping / scalar sequence / scalar) is sound. A shape change
// surfaces as a failing assertion, never a silent skip.
function asRecord(node: YamlNode): Record<string, YamlNode> {
  // SAFETY: every key this suite reads is a block mapping in the committed config.
  return node as Record<string, YamlNode>;
}
function asRecordArray(node: YamlNode): Record<string, YamlNode>[] {
  // SAFETY: `transforms` and `secrets` are block sequences of mappings in the committed config.
  return node as Record<string, YamlNode>[];
}
function asStringArray(node: YamlNode): string[] {
  // SAFETY: the domains/rules keys are block sequences of scalar strings in the committed config.
  return node as string[];
}
function asString(node: YamlNode): string {
  // SAFETY: the name/prompt/base_url keys are scalar strings in the committed config.
  return node as string;
}

const transforms = asRecordArray(cfg["transforms"]);
// SAFETY: the committed config names the transforms allowlist/judge/secrets;
// the ordering assertion below pins that exact set.
const allowlist = transforms.find((t) => asRecord(t)["name"] === "allowlist") as Record<string, YamlNode>;
const allowlistCfg = asRecord(allowlist["config"]);
// SAFETY: the committed config names the transforms allowlist/judge/secrets;
// the ordering assertion below pins that exact set.
const judge = transforms.find((t) => asRecord(t)["name"] === "judge") as Record<string, YamlNode>;
const judgeCfg = asRecord(judge["config"]);

describe("config/egress.yml (iron-proxy v0.49.0 schema)", () => {
  test("has the expected top-level sections", () => {
    expect(Object.keys(cfg).sort()).toEqual(["dns", "log", "management", "proxy", "tls", "transforms"]);
  });

  test("management API is enabled for boundary reloads (issue #123)", () => {
    // The extension credential boundary calls POST /v1/reload after writing
    // each secret file; the management block must be present in the ONE
    // committed config so both compose and local dev (docker-compose.dev.yml
    // publishes 127.0.0.1:9092) can rotate credentials without a restart.
    const mgmt = asRecord(cfg["management"]);
    expect(mgmt["listen"]).toBe(":9092");
    expect(mgmt["api_key_env"]).toBe("IRON_MANAGEMENT_API_KEY");
  });

  test("DNS resolves everything to the proxy IP (default-deny routing)", () => {
    const dns = asRecord(cfg["dns"]);
    expect(dns["listen"]).toBe(":53");
    expect(dns["proxy_ip"]).toBe("172.30.0.2");
  });

  test("proxy listeners include the explicit tunnel for HTTP_PROXY clients", () => {
    const proxy = asRecord(cfg["proxy"]);
    expect(proxy["http_listen"]).toBe(":80");
    expect(proxy["https_listen"]).toBe(":443");
    expect(proxy["tunnel_listen"]).toBe(":8080");
  });

  test("TLS MITM CA is configured (read-only mount, never committed)", () => {
    const tls = asRecord(cfg["tls"]);
    expect(tls["ca_cert"]).toBe("/etc/iron-proxy/certs/ca.crt");
    expect(tls["ca_key"]).toBe("/etc/iron-proxy/certs/ca.key");
  });

  test("allowlist contains the NEAR.ai model endpoints", () => {
    expect(allowlist).toBeDefined();
    const domains = asStringArray(allowlistCfg["domains"]);
    // Live gateway used by config/omp/models.yml (issue #36); api.near.ai
    // was retired 2025-10-31 and must not be allowed.
    expect(domains).toContain("cloud-api.near.ai");
    expect(domains).toContain("*.completions.near.ai");
    expect(domains).not.toContain("api.near.ai");
  });

  test("allowlist contains the OpenAI and Anthropic model gateways (#37ee2bf)", () => {
    const domains = asStringArray(allowlistCfg["domains"]);
    // The OpenAI/Anthropic providers (37ee2bf) reach their gateways through
    // the proxy; a missing domain = those providers dead in compose
    // (default-deny egress answers every name with the proxy IP, 403 at the
    // HTTP layer).
    expect(domains).toContain("api.openai.com");
    expect(domains).toContain("api.anthropic.com");
  });

  test("allowlist contains the ChatGPT Codex gateway (issue #214)", () => {
    const domains = asStringArray(allowlistCfg["domains"]);
    // The codex provider (config/omp/models.yml) posts to
    // chatgpt.com/backend-api/codex/responses; without the host in the
    // allowlist the provider dies in compose (403 at the HTTP layer).
    expect(domains).toContain("chatgpt.com");
  });

  test("judge policy gate is configured after the allowlist", () => {
    expect(judge).toBeDefined();
    expect(asString(judgeCfg["name"])).toBe("egress-policy");
    expect(judgeCfg["fallback"]).toBe("deny"); // fail closed
  });

  test("judge has a timeout and circuit breaker", () => {
    expect(judgeCfg["timeout"]).toBe("8s");
    const cb = asRecord(judgeCfg["circuit_breaker"]);
    expect(Number(cb["consecutive_failures"])).toBeGreaterThan(0);
    expect(cb["cooldown"]).toMatch(/^[0-9]+(m|s)$/);
  });

  test("judge rules cover all traffic that passes the allowlist", () => {
    const rules = asRecordArray(judgeCfg["rules"]);
    expect(rules).toHaveLength(1);
    expect(rules[0]["host"]).toBe("*");
  });

  test("judge LLM backend points at a NEAR.ai OpenAI-compatible endpoint", () => {
    const provider = asRecord(judgeCfg["provider"]);
    expect(provider["type"]).toBe("openai");
    expect(asString(provider["base_url"])).toMatch(/^https:\/\/[a-z0-9-]+\.completions\.near\.ai\/v1$/);
    expect(provider["api_key_env"]).toBe("NEARAI_JUDGE_API_KEY");
    expect(Number(provider["max_tokens"])).toBeGreaterThan(0);
  });

  test("judge prompt encodes the deny-unless policy", () => {
    const prompt = asString(judgeCfg["prompt"]);
    expect(prompt).toMatch(/DENY/i);
    expect(prompt).toMatch(/clearly required by the\s+current task/i);
  });

  test("secrets transform (issue #53 + #208 + #230) runs AFTER judge and injects auth per api_key extension + model gateway", () => {
    const secrets = transforms.find((t) => asRecord(t)["name"] === "secrets")!;
    expect(secrets).toBeDefined();
    // Ordering: allowlist, judge, secrets — the LLM judge must never see
    // real credentials (iron-proxy README's recommended ordering). Issue
    // #284: there is NO oauth_token transform (the SDK owns hosted-MCP
    // OAuth; the proxy is transport/allowlist only).
    const names = transforms.map((t) => asString(asRecord(t)["name"]));
    expect(names).toEqual(["allowlist", "judge", "secrets"]);
    const cfg = asRecord(secrets["config"]);
    const entries = asRecordArray(cfg["secrets"]);
    // api_key extensions (github) + the six model-gateway keys (#208 +
    // #230, incl. the openai-codex static access token) + the Tavily web
    // search provider (issue #278). The OAuth extensions (linear/attio)
    // get NO file entry (issue #284 — the SDK sends its own bearer).
    expect(entries).toHaveLength(7); // github + near/opencode/openai/anthropic/openai-codex/tavily
    for (const entry of entries) {
      const source = asRecord(entry["source"]);
      expect(source["type"]).toBe("file");
      expect(asString(source["path"])).toMatch(/^\/data\/proxy-secrets\/([a-z-]+)\.secret$/);
      const inject = asRecord(entry["inject"]);
      expect(inject["header"]).toBe("Authorization");
      expect(inject["formatter"]).toBe("Bearer {{ .Value }}");
      const rules = asRecordArray(entry["rules"]);
      expect(rules.length).toBeGreaterThanOrEqual(1);
      for (const rule of rules) {
        expect(asStringArray(allowlistCfg["domains"])).toContain(String(rule["host"]));
      }
    }
    // The model-gateway entries are REQUIRED (fail closed — issue #208),
    // including the Tavily web-search provider (issue #278).
    for (const provider of ["near", "opencode", "openai", "anthropic", "openai-codex", "tavily"]) {
      const entry = entries.find((e) => asString(asRecord(e["source"])["path"]).includes(`${provider}.secret`));
      expect(entry, `${provider} gateway entry`).toBeDefined();
      expect(asString(asRecord(entry!["inject"])["require"])).toBe("true");
    }
    // The Tavily web-search entry's specific contract (issue #278): the
    // search_web tool's provider key is a REQUIRED proxy secret injected at
    // egress for api.tavily.com — fail closed if the app ever holds it, and
    // the entry must exist (removal → meaningful failure, not just a count).
    const tavily = entries.find((e) => asString(asRecord(e["source"])["path"]).includes("tavily.secret"));
    expect(tavily).toBeDefined();
    expect(asString(asRecord(tavily!["source"])["path"])).toBe("/data/proxy-secrets/tavily.secret");
    expect(asString(asRecord(tavily!["inject"])["require"])).toBe("true");
    const tavilyRules = asRecordArray(tavily!["rules"]);
    expect(tavilyRules.map((r) => String(r["host"]))).toEqual(["api.tavily.com"]);
    // The codex static entry's specific contract (issue #230): the seed
    // writes the minted access token to openai-codex.secret (the static
    // secrets pattern — no oauth_token entry, the proxy never touches
    // auth.openai.com for codex), injected for chatgpt.com.
    const codex = entries.find((e) => asString(asRecord(e["source"])["path"]).includes("openai-codex.secret"));
    expect(codex).toBeDefined();
    const codexRules = asRecordArray(codex!["rules"]);
    expect(codexRules.map((r) => String(r["host"]))).toEqual(["chatgpt.com"]);
  });

  test("NO oauth_token transform — hosted-MCP OAuth is SDK-owned; the proxy is transport/allowlist only (issue #284)", () => {
    // The OAuth extensions' domains are allowlisted (their SDK bearer
    // passes through the proxy transport), but the committed config emits
    // no oauth_token transform, no per-provider JSON blobs, and no token
    // endpoints — the proxy never holds or mints extension OAuth
    // credentials. The codex MODEL provider is a STATIC secrets entry
    // (issue #230: the seed owns the refresh; the proxy never touches
    // auth.openai.com).
    expect(transforms.find((t) => asRecord(t)["name"] === "oauth_token")).toBeUndefined();
    const raw = readFileSync(resolve(import.meta.dir, "../../config/egress.yml"), "utf8");
    expect(raw).not.toContain("-oauth.json");
    expect(raw).not.toContain("token_endpoint:");
    expect(raw).not.toContain("grant: refresh_token");
    // The OAuth extensions' domains stay allowlisted for the SDK bearer.
    const domains = asStringArray(allowlistCfg["domains"]);
    expect(domains).toContain("mcp.linear.app");
    expect(domains).toContain("mcp.attio.com");
  });
});
