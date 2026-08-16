/**
 * opencode-go provider tests (issue #78): root-cause reproduction + fix
 * proof at the provider boundary, using the SDK's own model resolution.
 *
 * Root cause (live canary finding, issue #71): the opencode-go gateway
 * (Console Go) validates tool names against `^[a-zA-Z0-9_-]+$` and 400s
 * EVERY request carrying a dotted name (memory.save, memory.search, the
 * namespace extension tools) — so space-agent sessions on opencode-go
 * returned empty completions. Layer two: the opencode-go entry pinned no
 * model, so the SDK's default role resolved the provider CATALOG DEFAULT
 * (kimi-k2.7-code) instead of the intended deepseek-v4-flash — fixed by
 * pinning modelRoles.default in config.yml to
 * opencode-go/deepseek-v4-flash (the model ships in the SDK catalog with
 * its transport metadata). models.yml keeps the opencode-go entry
 * KEY-ONLY: the SDK validates any models.yml provider declaration as a
 * CUSTOM provider (baseUrl required), so redeclaring catalog models there
 * fails the boot guard (issue #80) instead of pinning anything.
 *
 * These tests prove BOTH layers against the real gateway, skip-gated on
 * the OPENCODE_API_KEY (env or macOS Keychain service `bottega-opencode`,
 * the dev.sh/canary pattern). Template-pin assertions run always; live
 * gateway probes run only when the key is present.
 */
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverAuthStorage, ModelRegistry } from "@oh-my-pi/pi-coding-agent";
import type { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { resolveModelFromSettings, pickDefaultAvailableModel } from "@oh-my-pi/pi-coding-agent/config/model-resolver";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

/** The opencode key: env, else the Keychain (dev.sh pattern). */
function opencodeKey(): string | undefined {
  if (process.env.OPENCODE_API_KEY) return process.env.OPENCODE_API_KEY;
  try {
    return execFileSync("security", ["find-generic-password", "-s", "bottega-opencode", "-w"])
      .toString()
      .trim();
  } catch {
    return undefined;
  }
}

const KEY = opencodeKey();
const describeLive = KEY ? describe : describe.skip;

describe("deployment templates pin the opencode-go model (issue #78, layer 2)", () => {
  test("models.yml template validates through the SDK registry (key-only opencode-go, pin via catalog + config.yml)", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "bottega-opencode-"));
    try {
      const modelsPath = join(agentDir, "models.yml");
      writeFileSync(modelsPath, readFileSync(join(REPO_ROOT, "config/omp/models.yml"), "utf8"));
      // The deployment boot guard (issue #80) refuses to start when the
      // SDK's models.yml validation fails — the opencode-go entry must
      // load clean. It is KEY-ONLY on purpose: opencode-go is a built-in
      // SDK catalog provider (deepseek-v4-flash ships there with its
      // transport metadata), and the SDK validates any models.yml provider
      // declaration as CUSTOM — redeclaring catalog models without a
      // baseUrl fails the boot guard.
      const registry = new ModelRegistry(await discoverAuthStorage(agentDir), modelsPath);
      expect(registry.getError()).toBeUndefined();
      const models = readFileSync(modelsPath, "utf8");
      const opencodeSection = models.slice(models.indexOf("opencode-go:"));
      expect(opencodeSection).toContain("apiKey: OPENCODE_API_KEY");
      expect(opencodeSection).not.toContain("- id: deepseek-v4-flash");
      // The generated catalog (settings path) keeps the same key-only shape.
      const generated = readFileSync(join(REPO_ROOT, "src/models/generate.ts"), "utf8");
      expect(generated).toContain("opencode-go:");
      expect(generated).toContain("apiKey: OPENCODE_API_KEY");
    } finally {
      rmSync(agentDir, { recursive: true, force: true });
    }
  });

  test("config.yml pins the default model role to opencode-go/deepseek-v4-flash", () => {
    const config = readFileSync(join(REPO_ROOT, "config/omp/config.yml"), "utf8");
    expect(config).toContain("modelRoles:");
    expect(config).toContain("default: opencode-go/deepseek-v4-flash");
  });
});

describeLive("opencode-go SDK resolution + gateway (issue #78, live)", () => {
  test("the pinned default role resolves deepseek-v4-flash — not the catalog default", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "bottega-opencode-"));
    try {
      // The deployment template pair: models.yml + config.yml with the role pin.
      const modelsPath = join(agentDir, "models.yml");
      writeFileSync(modelsPath, readFileSync(join(REPO_ROOT, "config/omp/models.yml"), "utf8"));
      const cfgYaml = readFileSync(join(REPO_ROOT, "config/omp/config.yml"), "utf8");
      const roleLine = cfgYaml.split("\n").find((line) => line.trim().startsWith("default:"));
      expect(roleLine).toContain("opencode-go/deepseek-v4-flash");
      // The registry resolves models.yml `apiKey: OPENCODE_API_KEY` from the
      // process env (the canary/dev.sh pattern). An explicit models path
      // keeps this test process-local — it must never touch the process-wide
      // agent dir (other e2e files boot their own registries concurrently).
      process.env.OPENCODE_API_KEY ??= KEY;
      const authStorage = await discoverAuthStorage(agentDir);
      const registry = new ModelRegistry(authStorage, modelsPath);
      await registry.refresh();
      const available = registry.getAvailable();

      // Without a role pin the SDK's default picker would choose the
      // provider catalog default (kimi-k2.7-code) — the drift the pin
      // prevents.
      expect(pickDefaultAvailableModel(available)?.id).toBe("kimi-k2.7-code");
      // The resolution path the session uses (config.yml modelRoles.default)
      // must land on the pinned model.
      const settings = {
        getModelRole: (role: string) => (role === "default" ? "opencode-go/deepseek-v4-flash" : undefined),
      } as unknown as Settings;
      const resolved = resolveModelFromSettings({ settings, availableModels: available });
      expect(resolved?.provider).toBe("opencode-go");
      expect(resolved?.id).toBe("deepseek-v4-flash");
      expect(resolved?.baseUrl).toBe("https://opencode.ai/zen/go/v1");
    } finally {
      rmSync(agentDir, { recursive: true, force: true });
    }
  }, 60_000);

  test("the gateway 400s dotted tool names and accepts flat ones (non-empty text)", async () => {
    const baseUrl = "https://opencode.ai/zen/go/v1";
    const headers = { "content-type": "application/json", authorization: `Bearer ${KEY}` };
    const schema = { type: "object", properties: { query: { type: "string" } } };
    const makeTools = (suffix: (name: string) => string) =>
      ["memory.save", "memory.search", "linear.search_issues"].map((name) => ({
        type: "function",
        name: suffix(name),
        description: "probe tool",
        parameters: schema,
        strict: false,
      }));
    const probe = async (tools: unknown[]) => {
      const res = await fetch(`${baseUrl}/responses`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: "deepseek-v4-flash",
          input: [{ role: "user", content: [{ type: "input_text", text: "Say OK" }] }],
          tools,
          stream: false,
        }),
      });
      const text = await res.text();
      return { status: res.status, text };
    };

    // Root-cause proof: dotted names are rejected by the gateway pattern.
    const dotted = await probe(makeTools((name) => name));
    expect(dotted.status).toBe(400);
    expect(dotted.text).toContain("^[a-zA-Z0-9_-]+$");

    // Fix proof: the flattened toolset (what the driver now registers) gets
    // a completed, non-empty response.
    const flat = await probe(makeTools((name) => name.replace(/[^a-zA-Z0-9_-]+/g, "_")));
    expect(flat.status).toBe(200);
    const parsed = JSON.parse(flat.text) as { output?: Array<{ type: string; text?: string }> };
    const text = (parsed.output ?? [])
      .filter((item) => item.type === "message")
      .flatMap((item) => (item as { content?: Array<{ text?: string }> }).content ?? [])
      .map((block) => block.text ?? "")
      .join("");
    expect(text.trim().length).toBeGreaterThan(0);
  }, 60_000);
});
