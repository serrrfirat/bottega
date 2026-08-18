/**
 * Issue #208 Wave 2 — placeholder-on-the-wire contract (hermetic; no real
 * gateways, no real credentials):
 *
 *   1. Every provider config/omp/models.yml declares (the key-only
 *      opencode-go decl + the near/openai/anthropic custom gateways)
 *      sends `Bearer bottega-proxy-placeholder` on the wire — the value
 *      iron-proxy's `secrets` transform swaps for the real key at egress
 *      (proxy-swappable, the spike verdict).
 *   2. The unset-env-ref FAIL-OPEN regression: the literal env NAME must
 *      NEVER reach the wire. The pre-#208 shape (`apiKey: NEAR_API_KEY`
 *      with the env unset) sent `Bearer NEAR_API_KEY` upstream; the
 *      committed models.yml now carries only the placeholder literal, so
 *      an unset env can never leak an env NAME — THIS TEST FAILS ON THE
 *      PRE-WAVE CODE (it reads the committed file).
 *   3. The #80 boot guard passes with the placeholder decls and NO
 *      provider keys in env (spike-proven: the placeholder is a
 *      non-empty configured key, so the registry reports the declared
 *      models available).
 *
 * All requests go to loopback recording stubs standing in for the real
 * gateway hosts (baseUrl redirected in the test copy; the committed file
 * itself keeps the real gateway baseUrls — the proxy is where the swap
 * happens).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ModelRegistry, discoverAuthStorage } from "@oh-my-pi/pi-coding-agent";
import { completeSimple } from "@oh-my-pi/pi-ai";
import { parseYamlSubset } from "../yaml-subset";
import { assertAgentDirModelAvailable } from "../server/drivers/agent-driver";

/** The proxy placeholder every provider must send (issue #208). */
const PLACEHOLDER = "bottega-proxy-placeholder";

/** The committed model catalog (the source of truth for the provider shapes). */
const COMMITTED_MODELS_YML = readFileSync(resolve(import.meta.dir, "../../config/omp/models.yml"), "utf8");

/** A recording gateway stub: captures every Authorization, answers a chat completion. */
interface WireRecord {
  provider: string;
  auth: string;
  path: string;
}

const stubs: Array<{ stop: () => void }> = [];
const dirs: string[] = [];
const records: WireRecord[] = [];

function stubGateway(): { baseUrl: string } {
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      records.push({ provider: "", auth: req.headers.get("authorization") ?? "", path: new URL(req.url).pathname });
      return Response.json({
        id: "stub-completion",
        object: "chat.completion",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "ok" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    },
  });
  stubs.push({ stop: () => server.stop(true) });
  return { baseUrl: `http://127.0.0.1:${server.port}` };
}

afterAll(() => {
  for (const stub of stubs) stub.stop();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** A temp agent dir whose models.yml mirrors the committed file with every
 * gateway baseUrl redirected at the recording stub (the committed file
 * itself keeps the real hosts). Returns the DECLARED anchor model ids per
 * provider (opencode-go's key-only decl carries none — the pinned
 * deepseek-v4-flash, config.yml modelRoles.default). */
function stubAgentDir(): { agentDir: string; declaredAnchors: Array<{ provider: string; id: string }> } {
  const stub = stubGateway();
  const parsed = parseYamlSubset(COMMITTED_MODELS_YML);
  const providers = parsed["providers"] as Record<string, Record<string, unknown>>;
  const lines: string[] = ["providers:"];
  const declaredAnchors: Array<{ provider: string; id: string }> = [];
  for (const [provider, config] of Object.entries(providers)) {
    lines.push(`  ${provider}:`);
    const emitted = new Set<string>();
    for (const [key, value] of Object.entries(config as Record<string, unknown>)) {
      emitted.add(key);
      if (key === "models") {
        lines.push("    models:");
        for (const model of value as Array<Record<string, unknown>>) {
          lines.push(`      - id: ${model["id"]}`);
          lines.push(`        name: ${model["name"]}`);
          lines.push(`        contextWindow: ${model["contextWindow"]}`);
          lines.push(`        maxTokens: ${model["maxTokens"]}`);
          declaredAnchors.push({ provider, id: String(model["id"]) });
        }
      } else if (key === "baseUrl") {
        lines.push(`    baseUrl: "${stub.baseUrl}"`);
      } else {
        lines.push(`    ${key}: ${value}`);
      }
    }
    // The key-only opencode-go decl has no baseUrl in the committed file
    // (its transport metadata is baked into the SDK catalog) — the test
    // copy redirects it at the recording stub so the wire proof never
    // touches the real gateway.
    if (!emitted.has("baseUrl")) {
      lines.push(`    baseUrl: "${stub.baseUrl}"`);
    }
  }
  // opencode-go's key-only decl declares no models — the pinned anchor
  // (config.yml modelRoles.default) is the wire shape under test.
  declaredAnchors.push({ provider: "opencode-go", id: "deepseek-v4-flash" });
  const dir = mkdtempSync(join(tmpdir(), "bottega-placeholder-"));
  writeFileSync(join(dir, "models.yml"), `${lines.join("\n")}\n`);
  writeFileSync(join(dir, "config.yml"), "secrets:\n  enabled: true\n");
  dirs.push(dir);
  return { agentDir: dir, declaredAnchors };
}

describe("proxy placeholder on the wire (issue #208)", () => {
  test("the committed models.yml declares ONLY the placeholder apiKey — no env-name refs (the FAIL-OPEN regression)", () => {
    // Pre-#208 this assertion failed: the decls were `apiKey: NEAR_API_KEY`
    // etc., which the SDK resolves to the literal env NAME when the env is
    // unset — `Bearer NEAR_API_KEY` on the wire. The wave kills that
    // fail-open by construction: the placeholder is a literal.
    const parsed = parseYamlSubset(COMMITTED_MODELS_YML);
    const providers = parsed["providers"] as Record<string, Record<string, unknown>>;
    expect(Object.keys(providers).sort()).toEqual(["anthropic", "near", "openai", "opencode-go"]);
    for (const config of Object.values(providers)) {
      expect(config["apiKey"]).toBe(PLACEHOLDER);
      expect(String(config["apiKey"])).not.toMatch(/^[A-Z][A-Z0-9_]+$/); // never an env NAME
    }
  });

  test("every provider shape sends `Bearer bottega-proxy-placeholder` on the wire (proxy-swappable)", async () => {
    records.length = 0;
    const { agentDir, declaredAnchors } = stubAgentDir();
    const registry = new ModelRegistry(await discoverAuthStorage(agentDir), join(agentDir, "models.yml"));
    expect(registry.getError()).toBeUndefined();

    for (const { provider, id } of declaredAnchors) {
      // The DECLARED anchor model (the models.yml shape under test), not
      // the first available SDK-bundled entry merged under the provider.
      const model = registry.getAvailable().find((m) => m.provider === provider && m.id === id);
      expect(model, `declared anchor ${provider}/${id} is available`).toBeDefined();
      const apiKey = await registry.getApiKey(model!);
      expect(apiKey, `resolved key for ${provider}`).toBe(PLACEHOLDER);
      const msg = await completeSimple(
        model!,
        { systemPrompt: [], messages: [{ role: "user", content: "ping", timestamp: Date.now() }] },
        { apiKey },
      );
      // The call must resolve (the stub's chat-completions shape may yield
      // a message-level error for response-API providers — the WIRE is the
      // contract under test, never a hang or a throw).
      expect(msg.stopReason).toBeDefined();
    }

    // Every recorded request carried the placeholder — never an env NAME.
    // (The SDK may retry a provider internally, so the count is a floor:
    // at least one wire request per declared anchor.)
    expect(records.length).toBeGreaterThanOrEqual(declaredAnchors.length);
    for (const record of records) {
      expect(record.auth).toBe(`Bearer ${PLACEHOLDER}`);
      expect(record.auth).not.toMatch(/Bearer (NEAR|OPENAI|ANTHROPIC|OPENCODE)_API_KEY/);
    }
  }, 60_000);

  test("with NO provider keys in env, the SDK still resolves the placeholder (never the env NAME)", async () => {
    const envKeys = ["NEAR_API_KEY", "OPENCODE_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"];
    for (const key of envKeys) delete process.env[key];
    const { agentDir, declaredAnchors } = stubAgentDir();
    const registry = new ModelRegistry(await discoverAuthStorage(agentDir), join(agentDir, "models.yml"));
    for (const { provider, id } of declaredAnchors) {
      const model = registry.getAvailable().find((m) => m.provider === provider && m.id === id);
      const apiKey = await registry.getApiKey(model!);
      expect(apiKey).toBe(PLACEHOLDER);
    }
  });

  test("the #80 boot guard passes with the placeholder decls and no provider env", async () => {
    for (const key of ["NEAR_API_KEY", "OPENCODE_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"]) {
      delete process.env[key];
    }
    const { agentDir } = stubAgentDir();
    await expect(assertAgentDirModelAvailable(agentDir)).resolves.toBeGreaterThanOrEqual(1);
  });
});
