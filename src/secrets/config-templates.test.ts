import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
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
    expect(near["baseUrl"] as string).toBe("https://api.near.ai/v1");
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

  test("covers every environment variable referenced by the code", () => {
    // Grep-level contract: code may not reference an env var the operator
    // cannot discover from .env.example. PATH is ambient runtime state.
    const srcFiles: string[] = [];
    for (const dir of ["src"]) {
      for (const file of walk(resolve(SRC_DIR, dir))) {
        if (file.endsWith(".ts")) srcFiles.push(file);
      }
    }
    const referenced = new Set<string>();
    for (const file of srcFiles) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/process\.env\.([A-Z0-9_]+)/g)) referenced.add(m[1]);
      for (const m of text.matchAll(/process\.env\[\s*"([A-Z0-9_]+)"\s*\]/g)) referenced.add(m[1]);
    }
    for (const varName of [...referenced].sort()) {
      if (varName === "PATH") continue;
      expect(envExample).toContain(varName);
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

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}
