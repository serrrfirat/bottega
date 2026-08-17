import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listAvailableModels, resolveModelPin, type ModelCatalogEntry } from "./model-pin";

/**
 * Issue #194 (generalized): every custom openai-completions gateway
 * declared in the agent dir's models.yml — near, openai, anthropic — is
 * probed from its /v1/models and merged into listAvailableModels
 * (hermetic — stub gateways stand in for the real hosts), and the
 * provider-unqualified resolution rule prefers near (the working deepseek
 * provider) over ties, never opencode-go's #78-broken deepseek by default.
 */

/** A stub gateway: random localhost port + a fetch handler, stopped after the suite. */
interface GatewayStub {
  port: number;
  stop: () => void;
}

const dirs: string[] = [];
function agentDir(modelsYml: string): string {
  const dir = mkdtempSync(join(tmpdir(), "bottega-near-catalog-"));
  writeFileSync(join(dir, "models.yml"), modelsYml);
  dirs.push(dir);
  return dir;
}

const stubs: GatewayStub[] = [];
function stubGateway(handler: (req: Request) => Response | Promise<Response>): GatewayStub {
  const server = Bun.serve({ port: 0, fetch: handler });
  const port = server.port;
  if (port === undefined) throw new Error("stub gateway did not bind a port");
  const stub = { port, stop: () => server.stop(true) };
  stubs.push(stub);
  return stub;
}

afterAll(() => {
  for (const stub of stubs) stub.stop();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  delete process.env.BOTTEGA_TEST_NEAR_API_KEY;
  delete process.env.BOTTEGA_TEST_OPENAI_API_KEY;
  delete process.env.BOTTEGA_TEST_ANTHROPIC_API_KEY;
});

/** The declared near model every test agent dir ships (the data/omp-agent shape). */
const DECLARED_NEAR_GLM = "zai-org/GLM-5.1-FP8";

/** What the real gateway serves beyond the declared model (verified live). */
const GATEWAY_MODELS = [
  { id: "deepseek-ai/DeepSeek-V4-Flash", name: "DeepSeek V4 Flash" },
  { id: "openai/gpt-5.1", name: "GPT 5.1" },
  { id: DECLARED_NEAR_GLM, name: "GLM 5.1" }, // also declared — must dedupe
];

function nearModelsYml(baseUrl: string, apiKey: string): string {
  return `providers:
  near:
    api: openai-completions
    baseUrl: "${baseUrl}"
    apiKey: ${apiKey}
    models:
      - id: "${DECLARED_NEAR_GLM}"
        name: "${DECLARED_NEAR_GLM}"
        contextWindow: 128000
        maxTokens: 8192
`;
}

function nearEntries(catalog: ModelCatalogEntry[]): ModelCatalogEntry[] {
  return catalog.filter((m) => m.provider === "near");
}

describe("listAvailableModels near gateway probe (issue #194)", () => {
  test("a live gateway list merges with the declared set — declared first, deduped, cached per build", async () => {
    process.env.BOTTEGA_TEST_NEAR_API_KEY = "stub-key";
    const requests: Array<{ url: string; auth: string | null }> = [];
    const stub = stubGateway(async (req) => {
      requests.push({ url: req.url, auth: req.headers.get("authorization") });
      return Response.json({ object: "list", data: GATEWAY_MODELS });
    });
    const dir = agentDir(nearModelsYml(`http://127.0.0.1:${stub.port}/v1`, "BOTTEGA_TEST_NEAR_API_KEY"));

    const catalog = await listAvailableModels(dir);
    const near = nearEntries(catalog);

    // The declared model is present exactly once (probed list dedupes against it).
    expect(near.filter((m) => m.id === DECLARED_NEAR_GLM)).toHaveLength(1);
    // The gateway-only models joined the near provider's set.
    expect(near).toContainEqual({ id: "deepseek-ai/DeepSeek-V4-Flash", name: "DeepSeek V4 Flash", provider: "near" });
    expect(near).toContainEqual({ id: "openai/gpt-5.1", name: "GPT 5.1", provider: "near" });
    // The declared entry keeps its declared name (declared wins the dedupe).
    expect(near.find((m) => m.id === DECLARED_NEAR_GLM)!.name).toBe(DECLARED_NEAR_GLM);

    // The probe hit the gateway's /v1/models with the provider's resolved key…
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe(`http://127.0.0.1:${stub.port}/v1/models`);
    expect(requests[0]!.auth).toBe("Bearer stub-key");

    // …and a second catalog build reuses the cached probe (one probe per build).
    await listAvailableModels(dir);
    expect(requests).toHaveLength(1);
  });

  test("a failing probe fails closed — the declared set stands, no partial catalog", async () => {
    process.env.BOTTEGA_TEST_NEAR_API_KEY = "stub-key";
    const stub = stubGateway(() => new Response("gateway exploded", { status: 500 }));
    const dir = agentDir(nearModelsYml(`http://127.0.0.1:${stub.port}/v1`, "BOTTEGA_TEST_NEAR_API_KEY"));

    const catalog = await listAvailableModels(dir);
    const near = nearEntries(catalog);
    expect(near).toHaveLength(1); // only the declared GLM — nothing probed leaked in
    expect(near[0]!.id).toBe(DECLARED_NEAR_GLM);
  });

  test("no declared near provider → no probe, no near entries, no crash", async () => {
    const dir = agentDir("providers:\n  opencode-go:\n    apiKey: OPENCODE_API_KEY\n");
    const catalog = await listAvailableModels(dir);
    expect(nearEntries(catalog)).toHaveLength(0);
  });

  test("every custom openai-completions gateway is probed with its own key; gateway-only ids merge under their own provider", async () => {
    process.env.BOTTEGA_TEST_OPENAI_API_KEY = "openai-stub-key";
    process.env.BOTTEGA_TEST_ANTHROPIC_API_KEY = "anthropic-stub-key";
    const requests: Array<{ url: string; auth: string | null }> = [];
    const openaiStub = stubGateway(async (req) => {
      requests.push({ url: req.url, auth: req.headers.get("authorization") });
      return Response.json({
        object: "list",
        data: [
          { id: "gpt-5.9-beta", name: "GPT 5.9 Beta" }, // not in the SDK's bundled openai catalog — probe-only
          { id: "gpt-5-mini", name: "GPT 5 Mini" }, // the declared anchor — must dedupe
        ],
      });
    });
    const anthropicStub = stubGateway(async (req) => {
      requests.push({ url: req.url, auth: req.headers.get("authorization") });
      return Response.json({ object: "list", data: [{ id: "claude-sonnet-4-9", name: "Claude Sonnet 4.9" }] });
    });
    const dir = agentDir(`providers:
  openai:
    api: openai-completions
    baseUrl: "http://127.0.0.1:${openaiStub.port}/v1"
    apiKey: BOTTEGA_TEST_OPENAI_API_KEY
    models:
      - id: "gpt-5-mini"
        name: "GPT-5 Mini"
        contextWindow: 400000
        maxTokens: 128000
  anthropic:
    api: openai-completions
    baseUrl: "http://127.0.0.1:${anthropicStub.port}/v1"
    apiKey: BOTTEGA_TEST_ANTHROPIC_API_KEY
    models:
      - id: "claude-sonnet-4-5"
        name: "Claude Sonnet 4.5"
        contextWindow: 200000
        maxTokens: 64000
`);

    const catalog = await listAvailableModels(dir);
    const openai = catalog.filter((m) => m.provider === "openai");
    const anthropic = catalog.filter((m) => m.provider === "anthropic");

    // The declared anchors keep their declared names (winning over the
    // SDK's bundled entry for the same id)…
    expect(openai).toContainEqual({ id: "gpt-5-mini", name: "GPT-5 Mini", provider: "openai" });
    expect(anthropic).toContainEqual({ id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", provider: "anthropic" });
    // …each anchor appears exactly once (declared + probed dedupe)…
    expect(openai.filter((m) => m.id === "gpt-5-mini")).toHaveLength(1);
    // …and the gateway-only ids merged under THEIR provider.
    expect(openai).toContainEqual({ id: "gpt-5.9-beta", name: "GPT 5.9 Beta", provider: "openai" });
    expect(anthropic).toContainEqual({ id: "claude-sonnet-4-9", name: "Claude Sonnet 4.9", provider: "anthropic" });

    // Each probe hit its own gateway's /v1/models with its own resolved key.
    expect(requests).toHaveLength(2);
    const authByUrl = new Map(requests.map((r) => [r.url, r.auth]));
    expect(authByUrl.get(`http://127.0.0.1:${openaiStub.port}/v1/models`)).toBe("Bearer openai-stub-key");
    expect(authByUrl.get(`http://127.0.0.1:${anthropicStub.port}/v1/models`)).toBe("Bearer anthropic-stub-key");
  });

  test("a failing gateway probe fails closed PER provider — its gateway-only ids stay out, healthy gateways still merge", async () => {
    process.env.BOTTEGA_TEST_OPENAI_API_KEY = "openai-stub-key";
    process.env.BOTTEGA_TEST_ANTHROPIC_API_KEY = "anthropic-stub-key";
    const openaiStub = stubGateway(() => new Response("gateway exploded", { status: 500 }));
    const anthropicStub = stubGateway(async () => Response.json({ object: "list", data: [{ id: "claude-sonnet-4-9", name: "Claude Sonnet 4.9" }] }));
    const dir = agentDir(`providers:
  openai:
    api: openai-completions
    baseUrl: "http://127.0.0.1:${openaiStub.port}/v1"
    apiKey: BOTTEGA_TEST_OPENAI_API_KEY
    models:
      - id: "gpt-5-mini"
        name: "GPT-5 Mini"
        contextWindow: 400000
        maxTokens: 128000
  anthropic:
    api: openai-completions
    baseUrl: "http://127.0.0.1:${anthropicStub.port}/v1"
    apiKey: BOTTEGA_TEST_ANTHROPIC_API_KEY
    models:
      - id: "claude-sonnet-4-5"
        name: "Claude Sonnet 4.5"
        contextWindow: 200000
        maxTokens: 64000
`);

    const catalog = await listAvailableModels(dir);
    const openai = catalog.filter((m) => m.provider === "openai");
    const anthropic = catalog.filter((m) => m.provider === "anthropic");

    // The dead openai gateway leaked nothing — its gateway-only id is absent,
    // while the declared anchor (and the SDK bundled set) still stands.
    expect(openai).toContainEqual({ id: "gpt-5-mini", name: "GPT-5 Mini", provider: "openai" });
    expect(openai.some((m) => m.id === "gpt-5.9-beta")).toBe(false);
    // The healthy anthropic gateway still merged its live list.
    expect(anthropic).toContainEqual({ id: "claude-sonnet-4-9", name: "Claude Sonnet 4.9", provider: "anthropic" });
  });
});

describe("provider-unqualified resolution prefers near (issue #194)", () => {
  /** Realistic ids: near's deepseek is deepseek-ai/DeepSeek-V4-Flash, NOT opencode-go's bare id. */
  const catalog: ModelCatalogEntry[] = [
    { id: "gpt-sol-5.6", name: "GPT-Sol 5.6", provider: "opencode-go" },
    { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash (2x usage)", provider: "opencode-go" },
    { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash", provider: "opencode-zen" },
    { id: DECLARED_NEAR_GLM, name: "GLM 5.1 FP8", provider: "near" },
    { id: "deepseek-ai/DeepSeek-V4-Flash", name: "DeepSeek V4 Flash", provider: "near" },
    { id: "openai/gpt-5.1", name: "GPT 5.1", provider: "near" },
  ];

  test("unqualified 'deepseek-v4-flash' resolves to NEAR's working deepseek — never opencode-go's #78-broken one", () => {
    expect(resolveModelPin("deepseek-v4-flash", catalog)).toEqual({
      ok: true,
      pin: { kind: "id", modelId: "deepseek-ai/DeepSeek-V4-Flash" },
    });
  });

  test("unqualified 'deepseek v4' resolves to near the same way", () => {
    expect(resolveModelPin("deepseek v4", catalog)).toEqual({
      ok: true,
      pin: { kind: "id", modelId: "deepseek-ai/DeepSeek-V4-Flash" },
    });
  });

  test("a provider-qualified id still wins outright — explicit intent beats the preference", () => {
    expect(resolveModelPin("opencode-go/deepseek-v4-flash", catalog)).toEqual({
      ok: true,
      pin: { kind: "id", modelId: "deepseek-v4-flash" },
    });
    expect(resolveModelPin("opencode-zen/deepseek-v4-flash", catalog)).toEqual({
      ok: true,
      pin: { kind: "id", modelId: "deepseek-v4-flash" },
    });
  });

  test("a tie WITHOUT near still fails closed as ambiguous", () => {
    const noNear = catalog.filter((m) => m.provider !== "near");
    const result = resolveModelPin("deepseek v4", noNear);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("ambiguous");
      expect(result.error).toContain("opencode-go/deepseek-v4-flash");
      expect(result.error).toContain("opencode-zen/deepseek-v4-flash");
    }
  });

  test("non-deepseek resolution is unchanged: unique ids and near-only names still resolve", () => {
    expect(resolveModelPin("gpt-sol-5.6", catalog)).toEqual({ ok: true, pin: { kind: "id", modelId: "gpt-sol-5.6" } });
    expect(resolveModelPin("zai-org/GLM-5.1-FP8", catalog)).toEqual({
      ok: true,
      pin: { kind: "id", modelId: DECLARED_NEAR_GLM },
    });
    expect(resolveModelPin("near glm", catalog)).toEqual({ ok: true, pin: { kind: "id", modelId: DECLARED_NEAR_GLM } });
    expect(resolveModelPin("gpt-5.1", catalog)).toEqual({ ok: true, pin: { kind: "id", modelId: "openai/gpt-5.1" } });
  });
});
