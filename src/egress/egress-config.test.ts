import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseYamlSubset, type YamlNode } from "../yaml-subset";

const cfg = parseYamlSubset(
  readFileSync(resolve(import.meta.dir, "../../config/egress.yml"), "utf8"),
);

const transforms = cfg["transforms"] as YamlNode[];
const allowlist = transforms.find((t) => (t as Record<string, YamlNode>)["name"] === "allowlist") as Record<string, YamlNode>;
const allowlistCfg = allowlist["config"] as Record<string, YamlNode>;
const judge = transforms.find((t) => (t as Record<string, YamlNode>)["name"] === "judge") as Record<string, YamlNode>;
const judgeCfg = judge["config"] as Record<string, YamlNode>;

describe("config/egress.yml (iron-proxy v0.49.0 schema)", () => {
  test("has the expected top-level sections", () => {
    expect(Object.keys(cfg).sort()).toEqual(["dns", "log", "proxy", "tls", "transforms"]);
  });

  test("DNS resolves everything to the proxy IP (default-deny routing)", () => {
    const dns = cfg["dns"] as Record<string, YamlNode>;
    expect(dns["listen"]).toBe(":53");
    expect(dns["proxy_ip"]).toBe("172.30.0.2");
  });

  test("proxy listeners include the explicit tunnel for HTTP_PROXY clients", () => {
    const proxy = cfg["proxy"] as Record<string, YamlNode>;
    expect(proxy["http_listen"]).toBe(":80");
    expect(proxy["https_listen"]).toBe(":443");
    expect(proxy["tunnel_listen"]).toBe(":8080");
  });

  test("TLS MITM CA is configured (read-only mount, never committed)", () => {
    const tls = cfg["tls"] as Record<string, YamlNode>;
    expect(tls["ca_cert"]).toBe("/etc/iron-proxy/certs/ca.crt");
    expect(tls["ca_key"]).toBe("/etc/iron-proxy/certs/ca.key");
  });

  test("allowlist contains the NEAR.ai model endpoints", () => {
    expect(allowlist).toBeDefined();
    const domains = allowlistCfg["domains"] as string[];
    // Live gateway used by config/omp/models.yml (issue #36); api.near.ai
    // was retired 2025-10-31 and must not be allowed.
    expect(domains).toContain("cloud-api.near.ai");
    expect(domains).toContain("*.completions.near.ai");
    expect(domains).not.toContain("api.near.ai");
  });

  test("judge policy gate is configured after the allowlist", () => {
    expect(judge).toBeDefined();
    expect((judgeCfg["name"] as string)).toBe("egress-policy");
    expect(judgeCfg["fallback"]).toBe("deny"); // fail closed
  });

  test("judge has a timeout and circuit breaker", () => {
    expect(judgeCfg["timeout"]).toBe("8s");
    const cb = judgeCfg["circuit_breaker"] as Record<string, YamlNode>;
    expect(Number(cb["consecutive_failures"])).toBeGreaterThan(0);
    expect(cb["cooldown"]).toMatch(/^[0-9]+(m|s)$/);
  });

  test("judge rules cover all traffic that passes the allowlist", () => {
    const rules = judgeCfg["rules"] as Record<string, YamlNode>[];
    expect(rules).toHaveLength(1);
    expect(rules[0]["host"]).toBe("*");
  });

  test("judge LLM backend points at a NEAR.ai OpenAI-compatible endpoint", () => {
    const provider = judgeCfg["provider"] as Record<string, YamlNode>;
    expect(provider["type"]).toBe("openai");
    expect(provider["base_url"] as string).toMatch(/^https:\/\/[a-z0-9-]+\.completions\.near\.ai\/v1$/);
    expect(provider["api_key_env"]).toBe("NEARAI_JUDGE_API_KEY");
    expect(Number(provider["max_tokens"])).toBeGreaterThan(0);
  });

  test("judge prompt encodes the deny-unless policy", () => {
    const prompt = judgeCfg["prompt"] as string;
    expect(prompt).toMatch(/DENY/i);
    expect(prompt).toMatch(/clearly required by the\s+current task/i);
  });
});
