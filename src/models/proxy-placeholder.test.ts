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
  body: string;
}

const stubs: Array<{ stop: () => void }> = [];
const dirs: string[] = [];
const records: WireRecord[] = [];

/** The minimal Responses-API SSE stream the SDK resolves to a message (issue #214). */
function responsesSse(): string {
  const item = { id: "msg_1", type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] };
  return [
    `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: "resp_1", status: "in_progress" } })}\n\n`,
    `event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item })}\n\n`,
    `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "resp_1", status: "completed", output: [item] } })}\n\n`,
  ].join("");
}

function stubGateway(): { baseUrl: string } {
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const body = await req.text();
      records.push({ provider: "", auth: req.headers.get("authorization") ?? "", path: new URL(req.url).pathname, body });
      if (new URL(req.url).pathname.endsWith("/codex/responses")) {
        // The openai-codex provider (issue #214) posts to
        // {baseUrl}/codex/responses and expects the Responses-API SSE shape.
        return new Response(responsesSse(), { headers: { "Content-Type": "text/event-stream" } });
      }
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
 * itself keeps the real hosts). Returns the anchor model ids per provider:
 * the DECLARED models of the custom gateways, plus the key-only
 * declarations' bundled anchors — opencode-go's pinned deepseek-v4-flash
 * (the pre-#214 config.yml pin) and openai-codex's gpt-5.6-luna (issue
 * #214, the default role — config.yml modelRoles.default — and the SDK
 * catalog entry under the key-only decl). */
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
    // The key-only decls (opencode-go, openai-codex — issue #214) have no
    // baseUrl in the committed file (their transport metadata is baked
    // into the SDK catalog) — the test copy redirects them at the
    // recording stub so the wire proof never touches the real gateway.
    if (!emitted.has("baseUrl")) {
      lines.push(`    baseUrl: "${stub.baseUrl}"`);
    }
  }
  // opencode-go's key-only decl declares no models — the pinned anchor
  // (config.yml modelRoles.default) is the wire shape under test. Same for
  // openai-codex (issue #214): the anchor is the default role
  // (config.yml modelRoles.default) — the SDK catalog's gpt-5.6-luna under
  // the key-only placeholder decl.
  declaredAnchors.push({ provider: "opencode-go", id: "deepseek-v4-flash" });
  declaredAnchors.push({ provider: "openai-codex", id: "gpt-5.6-luna" });
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
    expect(Object.keys(providers).sort()).toEqual(["anthropic", "near", "openai", "openai-codex", "opencode-go"]);
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

    // The openai-codex provider (issue #214) uses the SDK's NATIVE Codex
    // transport: the request hits {baseUrl}/codex/responses and carries the
    // codex wire contract the backend demands (stream:true + store:false
    // REQUIRED, max_output_tokens REJECTED, input a list) — with the
    // placeholder bearer, never a live token.
    const codexRecord = records.find((r) => r.path.endsWith("/codex/responses"));
    expect(codexRecord, "an openai-codex /codex/responses request reached the stub").toBeDefined();
    const codexBody = JSON.parse(codexRecord!.body);
    expect(codexBody["model"]).toBe("gpt-5.6-luna");
    expect(codexBody["stream"]).toBe(true);
    expect(codexBody["store"]).toBe(false);
    expect(Array.isArray(codexBody["input"])).toBe(true);
    expect("max_output_tokens" in codexBody).toBe(false);
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
