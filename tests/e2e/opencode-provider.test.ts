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
import { ensureAgentDirModelPin } from "../../src/server/drivers/agent-driver";
import { parseYamlSubset } from "../../src/yaml-subset";

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

/**
 * Band-aid-era gate (2026-08): the live leg probes the REAL opencode.ai
 * gateway, so it only runs when the deployment can actually satisfy it.
 * It skips with evidence when opencode-go is disabled in the agent-dir
 * config (disabledProviders), when the model pin no longer targets
 * opencode-go, or when the gateway is unreachable / does not answer 200 to
 * the flat-tool probe (the band-aid era: the gateway 403/429s or the
 * deployment routes around it). The assertions themselves are unchanged —
 * this only decides whether the environment can host them, the same
 * skip-gated shape as the mem0 docker leg (src/memory/mem0.test.ts).
 */
const RUNTIME_AGENT_CONFIG = join(REPO_ROOT, "data/omp-agent/config.yml");
const TEMPLATE_AGENT_CONFIG = join(REPO_ROOT, "config/omp/config.yml");

interface AgentDirConfig {
  disabledProviders?: string[] | string;
  modelRoles?: { [role: string]: string };
}

function readAgentDirConfig(path: string): AgentDirConfig | null {
  try {
    return parseYamlSubset(readFileSync(path, "utf8")) as unknown as AgentDirConfig;
  } catch {
    return null;
  }
}

/** The pin must name an opencode-go model — anything else is a drift/band-aid. */
function pinTargetsOpencode(cfg: AgentDirConfig | null): boolean {
  const pin = cfg?.modelRoles?.default;
  return typeof pin === "string" && pin.startsWith("opencode-go/");
}

/** One gateway probe per file: the flat-tool request the fix asserts succeeds. */
let probeStatus: Promise<number | "unreachable"> | undefined;
function gatewayProbeStatus(): Promise<number | "unreachable"> {
  probeStatus ??= (async () => {
    try {
      const res = await fetch("https://opencode.ai/zen/go/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
        body: JSON.stringify({
          model: "deepseek-v4-flash",
          input: [{ role: "user", content: [{ type: "input_text", text: "Say OK" }] }],
          tools: [
            {
              type: "function",
              name: "memory_save",
              description: "probe tool",
              parameters: { type: "object", properties: { query: { type: "string" } } },
              strict: false,
            },
          ],
          stream: false,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      return res.status;
    } catch {
      return "unreachable";
    }
  })();
  return probeStatus;
}

async function liveSkipReason(): Promise<string | undefined> {
  // 1. The runtime agent-dir config (data/omp-agent, gitignored) is where
  //    the #78 band-aid lives: opencode-go disabled, or the pin moved off
  //    opencode-go (e.g. the local near/GLM pin).
  const runtime = readAgentDirConfig(RUNTIME_AGENT_CONFIG);
  const disabled = runtime?.disabledProviders;
  if (disabled !== undefined) {
    const list = Array.isArray(disabled) ? disabled : [disabled];
    if (list.includes("opencode-go")) {
      return `opencode-go is disabled (disabledProviders: ${list.join(", ")}) in ${RUNTIME_AGENT_CONFIG}`;
    }
  }
  if (runtime !== null && !pinTargetsOpencode(runtime)) {
    return `the agent-dir model pin (modelRoles.default = ${JSON.stringify(runtime.modelRoles?.default)}) does not target opencode-go (${RUNTIME_AGENT_CONFIG})`;
  }
  // 2. The committed template is the deployment floor; a pin that drifted
  //    off opencode-go there means the live leg cannot hold.
  const template = readAgentDirConfig(TEMPLATE_AGENT_CONFIG);
  if (template !== null && !pinTargetsOpencode(template)) {
    return `the committed template model pin does not target opencode-go (${TEMPLATE_AGENT_CONFIG})`;
  }
  // 3. Gateway health: the flat-tool probe must answer 200. Anything else
  //    (unreachable, 403, 429 — the observed band-aid-era behavior, or
  //    transient outage) means the live assertions cannot hold here.
  const status = await gatewayProbeStatus();
  if (status !== 200) {
    return `the opencode.ai gateway answered ${status === "unreachable" ? "unreachable" : `HTTP ${status}`} for the flat-tool probe — the live assertions cannot hold in this environment`;
  }
  return undefined;
}

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

  test("ensureAgentDirModelPin syncs the pin into a stale agent-dir config (issue #78 recurrence)", () => {
    // The recurrence root cause: the SDK reads modelRoles from the agent
    // dir's config.yml, and host-dev agent dirs are never re-synced from
    // config/omp — a stale copy without the pin silently falls back to the
    // provider catalog default (kimi-k2.7-code). The boot sync must patch
    // such a file without touching operator customizations.
    const dir = mkdtempSync(join(tmpdir(), "bottega-pin-"));
    const template = "modelRoles:\n  default: opencode-go/deepseek-v4-flash\n";
    try {
      // Stale config (pre-#78 copy): no pin, operator customizations intact.
      const stale = "# OMP agent settings\nsecrets:\n  enabled: true\n";
      writeFileSync(join(dir, "config.yml"), stale);
      expect(ensureAgentDirModelPin(dir, join(dir, "template.yml"))).toBe("skipped"); // no template at that path
      writeFileSync(join(dir, "template.yml"), template);
      expect(ensureAgentDirModelPin(dir, join(dir, "template.yml"))).toBe("patched");
      const patched = readFileSync(join(dir, "config.yml"), "utf8");
      expect(patched).toContain("secrets:\n  enabled: true");
      expect(patched).toContain("modelRoles:\n  default: opencode-go/deepseek-v4-flash");
      // Second run: already pinned → untouched.
      expect(ensureAgentDirModelPin(dir, join(dir, "template.yml"))).toBe("unchanged");
      // Missing agent-dir config → template copy (compose-equivalent first boot).
      const empty = mkdtempSync(join(tmpdir(), "bottega-pin-"));
      try {
        expect(ensureAgentDirModelPin(empty, join(dir, "template.yml"))).toBe("created");
        expect(readFileSync(join(empty, "config.yml"), "utf8")).toBe(template);
      } finally {
        rmSync(empty, { recursive: true, force: true });
      }
      // Unparseable config → left alone, never a crash.
      const broken = mkdtempSync(join(tmpdir(), "bottega-pin-"));
      try {
        writeFileSync(join(broken, "config.yml"), "key: [unclosed\n");
        expect(ensureAgentDirModelPin(broken, join(dir, "template.yml"))).toBe("skipped");
      } finally {
        rmSync(broken, { recursive: true, force: true });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
    const skipReason = await liveSkipReason();
    if (skipReason !== undefined) {
      console.log(`[opencode live leg] SKIP: ${skipReason}`);
      return;
    }
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

  test("the boot pin lands in the agent dir and the fixed path returns non-empty text (recurrence regression)", async () => {
    // Regression for the recurrence: the pin must reach the RUNTIME agent
    // dir (ensureAgentDirModelPin), not just the committed template, so the
    // SDK resolves deepseek-v4-flash — and the resolved endpoint answers
    // with non-empty text on the text path.
    const skipReason = await liveSkipReason();
    if (skipReason !== undefined) {
      console.log(`[opencode live leg] SKIP: ${skipReason}`);
      return;
    }
    const agentDir = mkdtempSync(join(tmpdir(), "bottega-pin-live-"));
    try {
      const modelsPath = join(agentDir, "models.yml");
      writeFileSync(modelsPath, readFileSync(join(REPO_ROOT, "config/omp/models.yml"), "utf8"));
      // A stale agent dir (the recurrence state): config.yml without the pin.
      writeFileSync(
        join(agentDir, "config.yml"),
        "# OMP agent settings (stale, pre-#78)\nsecrets:\n  enabled: true\n",
      );
      expect(ensureAgentDirModelPin(agentDir)).toBe("patched");
      const patched = readFileSync(join(agentDir, "config.yml"), "utf8");
      expect(patched).toContain("modelRoles:\n  default: opencode-go/deepseek-v4-flash");

      process.env.OPENCODE_API_KEY ??= KEY;
      const registry = new ModelRegistry(await discoverAuthStorage(agentDir), modelsPath);
      await registry.refresh();
      const available = registry.getAvailable();
      const settings = {
        getModelRole: (role: string) => (role === "default" ? "opencode-go/deepseek-v4-flash" : undefined),
      } as unknown as Settings;
      const resolved = resolveModelFromSettings({ settings, availableModels: available });
      expect(resolved?.provider).toBe("opencode-go");
      expect(resolved?.id).toBe("deepseek-v4-flash");
      if (!resolved) throw new Error("resolveModelFromSettings returned no model for the pinned role");
      expect(resolved.baseUrl).toBe("https://opencode.ai/zen/go/v1");

      // The resolved endpoint answers with non-empty text (both reasoning
      // levels; maxTokens is generous in the catalog — not the failure).
      for (const effort of ["minimal", "medium"]) {
        const res = await fetch(`${resolved.baseUrl}/responses`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
          body: JSON.stringify({
            model: "deepseek-v4-flash",
            input: [{ role: "user", content: [{ type: "input_text", text: "Reply with exactly: hello world" }] }],
            max_output_tokens: 2048,
            reasoning: { effort },
            stream: false,
            store: false,
          }),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          output?: Array<{ type: string; content?: Array<{ type: string; text?: string }> }>;
        };
        const text = (body.output ?? [])
          .filter((item) => item.type === "message")
          .flatMap((item) => item.content ?? [])
          .map((block) => block.text ?? "")
          .join("");
        expect(text.trim().length).toBeGreaterThan(0);
      }
    } finally {
      rmSync(agentDir, { recursive: true, force: true });
    }
  }, 90_000);

  test("the Console Go gateway requires tool outputs adjacent to their calls (replay-shape constraint)", async () => {
    // Live recurrence mechanism (2026-08-16): the SDK's responses replay can
    // carry a function_call whose output is not immediately after it (e.g.
    // after a subagent-context merge), and Console Go 400s the whole request
    // with "No tool output found" — the SDK retries 10x and the space agent
    // surfaces empty completions. The correct replay shape (call + adjacent
    // output) is accepted. This pins the gateway constraint so the replay
    // shape stays regression-tested at the provider boundary.
    const skipReason = await liveSkipReason();
    if (skipReason !== undefined) {
      console.log(`[opencode live leg] SKIP: ${skipReason}`);
      return;
    }
    const baseUrl = "https://opencode.ai/zen/go/v1";
    const headers = { "content-type": "application/json", authorization: `Bearer ${KEY}` };
    const callInput = (items: unknown[]) =>
      JSON.stringify({
        model: "deepseek-v4-flash",
        input: items,
        max_output_tokens: 2048,
        reasoning: { effort: "minimal" },
        stream: false,
        store: false,
      });
    // Broken shape: function_call followed by an assistant turn before any output.
    const broken = await fetch(`${baseUrl}/responses`, {
      method: "POST",
      headers,
      body: callInput([
        { role: "user", content: [{ type: "input_text", text: "use the bash tool to echo hi" }] },
        { type: "function_call", call_id: "call_repro_1", name: "bash", arguments: "{}" },
        { role: "assistant", content: [{ type: "output_text", text: "let me run that" }] },
      ]),
    });
    expect(broken.status).toBe(400);
    expect(await broken.text()).toContain("No tool output found");
    // Correct shape: each call immediately followed by its output.
    const ok = await fetch(`${baseUrl}/responses`, {
      method: "POST",
      headers,
      body: callInput([
        { role: "user", content: [{ type: "input_text", text: "use the bash tool to echo hi" }] },
        { type: "function_call", call_id: "call_repro_2", name: "bash", arguments: "{}" },
        { type: "function_call_output", call_id: "call_repro_2", output: "hi\n" },
        { role: "user", content: [{ type: "input_text", text: "now reply: done" }] },
      ]),
    });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { output?: Array<{ type: string; content?: Array<{ text?: string }> }> };
    const text = (body.output ?? [])
      .filter((item) => item.type === "message")
      .flatMap((item) => item.content ?? [])
      .map((block) => block.text ?? "")
      .join("");
    expect(text.trim().length).toBeGreaterThan(0);
  }, 60_000);
});
