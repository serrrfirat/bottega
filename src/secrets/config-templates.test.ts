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
    // SAFETY: config.yml's `secrets` key is a mapping (its `enabled` scalar is asserted below); YAML mappings parse to YamlNode objects.
    const secrets = config["secrets"] as Record<string, YamlNode>;
    expect(secrets["enabled"]).toBe("true");
    // The policy extension (issue #6) owns tool-call gating — OMP's own
    // approval mode must not be configured.
    expect(config["approvalMode"]).toBeUndefined();
  });

  test("secrets.yml is a YAML array of obfuscate-mode placeholders", () => {
    // SAFETY: secrets.yml is a top-level YAML sequence of mappings (this test iterates its entries); sequence items parse to YamlNode objects.
    const entries = parseYamlSequence(readConfig("secrets.yml")) as Record<string, YamlNode>[];
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      // SAFETY: secrets.yml placeholder entries are scalar-only per the template contract (type "plain"|"regex", mode "obfuscate"|"replace", string content).
      const { type, mode, content } = entry as { type: string; mode: string; content: string };
      expect(["plain", "regex"]).toContain(type);
      expect(["obfuscate", "replace"]).toContain(mode);
      expect(mode).toBe("obfuscate");
      expect(content).toEqual(expect.any(String));
      expect(entry["friendlyName"]).toEqual(expect.any(String));
      // Templates must never ship real credentials.
      expect(content).toMatch(/^replace-with-/);
    }
  });

  test("models.yml declares the NEAR.ai provider over the OpenAI-compatible API", () => {
    const models = parseYamlSubset(readConfig("models.yml"));
    // SAFETY: models.yml's `providers` key is a mapping of provider id → config per the file contract.
    const providers = models["providers"] as Record<string, YamlNode>;
    // SAFETY: the `near` provider entry is a mapping (its scalars are asserted below) per models.yml's contract.
    const near = providers["near"] as Record<string, YamlNode>;
    expect(near["api"]).toBe("openai-completions");
    // Live NEAR AI Cloud gateway (issue #36); api.near.ai was retired.
    expect(near["baseUrl"]).toBe("https://cloud-api.near.ai/v1");
    // apiKey is an env-var reference, resolved by the SDK at runtime — the
    // key value itself never appears in the template.
    expect(near["apiKey"]).toBe("NEAR_API_KEY");
  });
});

describe(".env.example (issue #9 environment contract)", () => {
  const envExample = readFileSync(resolve(SRC_DIR, ".env.example"), "utf8");

  test("declares every credential the deployment needs", () => {
    for (const varName of [
      "SLACK_APP_TOKEN",
      "SLACK_BOT_TOKEN",
      "OPENCODE_API_KEY",
      "NEAR_API_KEY",
      "OMP_AUTH_BROKER_URL",
      "OMP_AUTH_BROKER_TOKEN",
      "NEARAI_JUDGE_API_KEY",
      "GITHUB_PAT",
      "EXECUTOR_GIT_TOKEN_FILE",
      "OPENAI_API_KEY",
    ]) {
      expect(envExample).toContain(varName);
    }
  });

  test("runtime knobs are settings, not env vars (issue #67)", () => {
    // Issue #67 env pruning: knobs moved to the org settings blob
    // (settings tool). They must not be documented as env assignments —
    // .env carries secrets + deployment identity only.
    for (const knob of [
      "WORKSPACES_DIR=",
      "EXECUTOR_REPOS=",
      "EXECUTOR_GITHUB_API_URL=",
      "BOTTEGA_ALLOW_LOOSE_PAT=",
      "MEM0_BASE_URL=",
    ]) {
      expect(envExample).not.toContain(knob);
    }
  });

  test("boot fails closed when the documented channel tokens are missing", async () => {
    // Behavioral contract (issue #33): the server refuses to boot without
    // the credentials .env.example documents — scrub the env and assert
    // the fail-closed message instead of grepping src/ for env references.
    const savedApp = process.env.SLACK_APP_TOKEN;
    const savedBot = process.env.SLACK_BOT_TOKEN;
    delete process.env.SLACK_APP_TOKEN;
    delete process.env.SLACK_BOT_TOKEN;
    try {
      await expect(main()).rejects.toThrow(/SLACK_APP_TOKEN and SLACK_BOT_TOKEN are required/);
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
