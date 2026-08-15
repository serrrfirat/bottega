import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { main } from "../server/index";
import { parseYamlSequence, parseYamlSubset, type YamlNode } from "../yaml-subset";

const CONFIG_DIR = resolve(import.meta.dir, "../../config/omp");
const SRC_DIR = resolve(import.meta.dir, "../..");

function readConfig(name: string): string {
  return readFileSync(join(CONFIG_DIR, name), "utf8");
}

describe("config/omp templates (issue #9 secrets & models)", () => {
  test("config.yml enables secret obfuscation and leaves approval gating to the policy extension", () => {
    const config = parseYamlSubset(readConfig("config.yml"));
    const secrets = config["secrets"] as Record<string, YamlNode>;
    expect(secrets["enabled"] as string).toBe("true");
    // The policy extension (issue #6) owns tool-call gating — OMP's own
    // approval mode must not be configured.
    expect(config["approvalMode"]).toBeUndefined();
  });

  test("secrets.yml is a YAML array of obfuscate-mode placeholders", () => {
    const entries = parseYamlSequence(readConfig("secrets.yml")) as Record<string, YamlNode>[];
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(["plain", "regex"]).toContain(entry["type"] as string);
      expect(["obfuscate", "replace"]).toContain(entry["mode"] as string);
      expect(entry["mode"] as string).toBe("obfuscate");
      expect(typeof entry["content"]).toBe("string");
      expect(typeof entry["friendlyName"]).toBe("string");
      // Templates must never ship real credentials.
      expect(entry["content"] as string).toMatch(/^replace-with-/);
    }
  });

  test("models.yml declares the NEAR.ai provider over the OpenAI-compatible API", () => {
    const models = parseYamlSubset(readConfig("models.yml"));
    const providers = models["providers"] as Record<string, YamlNode>;
    const near = providers["near"] as Record<string, YamlNode>;
    expect(near["api"] as string).toBe("openai-completions");
    // Live NEAR AI Cloud gateway (issue #36); api.near.ai was retired.
    expect(near["baseUrl"] as string).toBe("https://cloud-api.near.ai/v1");
    // apiKey is an env-var reference, resolved by the SDK at runtime — the
    // key value itself never appears in the template.
    expect(near["apiKey"] as string).toBe("NEAR_API_KEY");
  });
});

describe(".env.example (issue #9 environment contract)", () => {
  const envExample = readFileSync(resolve(SRC_DIR, ".env.example"), "utf8");

  test("declares every credential the deployment needs", () => {
    for (const varName of [
      "SLACK_APP_TOKEN",
      "SLACK_BOT_TOKEN",
      "NEAR_API_KEY",
      "OMP_AUTH_BROKER_URL",
      "OMP_AUTH_BROKER_TOKEN",
      "GITHUB_PAT",
    ]) {
      expect(envExample).toContain(varName);
    }
  });

  test("boot fails closed when the documented channel tokens are missing", () => {
    // Behavioral contract (issue #33): the server refuses to boot without
    // the credentials .env.example documents — scrub the env and assert
    // the fail-closed message instead of grepping src/ for env references.
    const savedApp = process.env.SLACK_APP_TOKEN;
    const savedBot = process.env.SLACK_BOT_TOKEN;
    delete process.env.SLACK_APP_TOKEN;
    delete process.env.SLACK_BOT_TOKEN;
    try {
      expect(() => main()).toThrow(/SLACK_APP_TOKEN and SLACK_BOT_TOKEN are required/);
    } finally {
      if (savedApp === undefined) delete process.env.SLACK_APP_TOKEN;
      else process.env.SLACK_APP_TOKEN = savedApp;
      if (savedBot === undefined) delete process.env.SLACK_BOT_TOKEN;
      else process.env.SLACK_BOT_TOKEN = savedBot;
    }
  });

  test("contains no real-looking credentials", () => {
    // Placeholders only: a committed secret-shaped value in .env.example is
    // a credential leak (and a scanner trip) waiting to happen.
    expect(envExample).not.toMatch(/xox[baprs]-[0-9a-zA-Z]{12,}/);
    expect(envExample).not.toMatch(/sk-[A-Za-z0-9]{20,}/);
    expect(envExample).not.toMatch(/github_pat_[A-Za-z0-9_]{20,}/);
    expect(envExample).not.toMatch(/near-[A-Za-z0-9]{20,}/);
  });
});
