/**
 * Per-task model pin resolution (issue #185): `create_work_item` accepts a
 * model pin — a role ref ("fast"/"reasoning") or a natural-language model
 * name ("deepseek v4", "gpt sol 5.6") — and resolves it against the
 * deployment's AVAILABLE model catalog at creation time, fail closed.
 *
 * The catalog is the same one the sessions see: the agent dir's models.yml
 * merged with the SDK's bundled provider catalog, filtered to models with
 * configured auth (the SDK's ModelRegistry.getAvailable(), exactly what
 * assertAgentDirModelAvailable guards at boot). Role refs are stored
 * verbatim (they resolve against the space's settings at execution — the
 * "fast slot" is not ambiguous); every other value resolves to ONE bare
 * model id at creation so execution never re-interprets a fuzzy name.
 *
 * Custom gateway probe (issue #194, generalized): the near provider is a
 * models.yml custom openai-completions provider with a single declared
 * model, but its gateway serves the full catalog — the same holds for the
 * openai and anthropic entries. listAvailableModels probes GET {baseUrl}/models
 * (the configured baseUrls all end in /v1; other openai-completions
 * baseUrls get /v1/models appended) for EVERY custom openai-completions
 * provider, using each provider's resolved key, bounded to 5s and cached
 * per build, and MERGES each gateway's ids into that provider's declared
 * set. Any probe failure fails CLOSED: the declared set stands and the
 * catalog is never broken by a dead gateway.
 *
 * Unqualified-resolution rule (issue #194): several providers serve the
 * same model name (deepseek-v4-flash exists on near, opencode-go,
 * opencode-zen), but only near's deepseek is WORKING — opencode-go's is
 * #78-broken and must never win a tie by default. When a provider-
 * unqualified value ties at the best match and near is one of the tied
 * providers, near wins deterministically. A provider-qualified value
 * ("opencode-go/deepseek-v4-flash") still wins outright — explicit intent
 * beats the preference. Ties without a single near candidate fail closed
 * as ambiguous, listing the candidates — unless the caller passes a
 * `preferredProvider` (the provider of the space's own qualified default
 * model, issue #244): a bare id that ties across providers resolves to
 * that single preferred provider, so a work item pinned to the space's
 * bare default id is never rejected as ambiguous.
 */
import { ModelRegistry, discoverAuthStorage, type AuthStorage } from "@oh-my-pi/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { parseYamlSubset } from "../yaml-subset";

/** The deployment agent dir both the server and the executor default to. */
export const DEFAULT_MODEL_CATALOG_DIR = "data/omp-agent";

/** Model role refs a pin may name directly (issue #185). */
export const MODEL_ROLE_REFS = ["fast", "reasoning"] as const;
export type ModelRoleRef = (typeof MODEL_ROLE_REFS)[number];

/** The near gateway provider id (models.yml): the WORKING deepseek provider (issue #194). */
const NEAR_PROVIDER = "near";

/** Probe bound: a slow or dead gateway never hangs the catalog build. */
const GATEWAY_PROBE_TIMEOUT_MS = 5_000;

/**
 * Per-build probe cache: one combined gateway-probe pass per agent dir,
 * shared by every catalog build in this process. Successes and failures
 * are cached alike — a failed probe keeps the declared set for the whole
 * build (fail closed).
 */
const gatewayProbeCache = new Map<string, Promise<ModelCatalogEntry[]>>();

/** A resolved model pin: a role slot, or one concrete available model id carrying the provider it matched. */
export type ModelPin =
  | { kind: "role"; role: ModelRoleRef }
  | { kind: "id"; provider: string; modelId: string };

export type ModelPinResolution = { ok: true; pin: ModelPin } | { ok: false; error: string };

/**
 * Optional resolution hints (issue #244): when the caller resolves a model
 * for a space whose DEFAULT model is provider-qualified
 * ("openai-codex/gpt-5.6-luna"), a bare id that ties across several
 * providers breaks toward the space's own provider. This only unties a
 * genuinely ambiguous bare id (several same-best matches); it never
 * overrides a provider-qualified query (explicit intent) or near
 * (issue #194), and it fails closed when the preferred provider is not
 * uniquely among the tied best matches.
 */
export interface ModelPinResolutionOptions {
  /** The provider of the space's effective default model, when that default is qualified. */
  preferredProvider?: string;
}

/** The catalog shape the resolver matches against (id/name/provider of an available model). */
export interface ModelCatalogEntry {
  id: string;
  name: string;
  provider: string;
}

/**
 * The available model catalog for an agent dir: models.yml custom models +
 * the SDK's bundled provider catalog, filtered to models with configured
 * auth — the same registry the sessions resolve against — MERGED with each
 * custom openai-completions gateway's probed /v1/models list (issue #194,
 * generalized to every such provider: near, openai, anthropic), so each
 * gateway shows its full set instead of only the declared anchors.
 */
export async function listAvailableModels(agentDir: string): Promise<ModelCatalogEntry[]> {
  const registry = new ModelRegistry(await discoverAuthStorage(agentDir), join(agentDir, "models.yml"));
  const declared = registry.getAvailable().map((model) => ({ id: model.id, name: model.name ?? model.id, provider: model.provider }));
  const probed = await probeGatewayCached(agentDir, registry.authStorage);
  return mergeProbedModels(declared, probed);
}

/** A custom openai-completions gateway declared in the agent dir's models.yml. */
interface CustomGatewayProvider {
  provider: string;
  baseUrl: string;
}

/**
 * Every custom openai-completions provider (api + baseUrl) declared in the
 * agent dir's models.yml — near, openai, anthropic, or any future gateway.
 * Each is probed for its full model list (issue #194 generalized).
 */
/** models.yml providers block: a name → provider config mapping. */
const gatewayProvidersSchema = z.record(z.string(), z.unknown());
/** One provider entry: {api, baseUrl}; non-openai-completions entries are skipped. */
const gatewayProviderEntrySchema = z.object({
  api: z.string(),
  baseUrl: z.string(),
});

function readCustomGatewayProviders(agentDir: string): CustomGatewayProvider[] {
  try {
    const parsed = parseYamlSubset(readFileSync(join(agentDir, "models.yml"), "utf8"));
    const providers = gatewayProvidersSchema.safeParse(parsed.providers);
    if (!providers.success) return [];
    const gateways: CustomGatewayProvider[] = [];
    for (const [name, cfg] of Object.entries(providers.data)) {
      const entry = gatewayProviderEntrySchema.safeParse(cfg);
      if (!entry.success) continue;
      if (entry.data.api !== "openai-completions" || entry.data.baseUrl.trim() === "") continue;
      gateways.push({ provider: name, baseUrl: entry.data.baseUrl });
    }
    return gateways;
  } catch {
    return []; // unreadable models.yml → no probes, declared set stands
  }
}

/**
 * The gateway /v1/models URL for a baseUrl: the configured baseUrls already
 * end in "/v1" ("https://cloud-api.near.ai/v1", "https://api.openai.com/v1",
 * "https://api.anthropic.com/v1" → "/v1/models"); other openai-completions
 * baseUrls get the /v1 suffix appended.
 */
function gatewayModelsUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  return base.endsWith("/v1") ? `${base}/models` : `${base}/v1/models`;
}

/**
 * Probes every configured custom openai-completions gateway's model list
 * with the provider's resolved key, in parallel, each bounded to 5s. Fail
 * closed per provider on ANY error (timeout, non-2xx, malformed body, no
 * key): the caller keeps the declared set — the catalog is never broken by
 * a dead gateway.
 */
/** The gateway /v1/models response: a `data` array of model entries. */
const gatewayModelListSchema = z.object({ data: z.array(z.unknown()) });
/** One model entry: {id, name?}; ids with only whitespace are rejected. */
const gatewayModelEntrySchema = z.object({
  id: z.string().refine((id) => id.trim() !== ""),
  name: z.string().optional(),
});

async function probeGatewayModels(agentDir: string, authStorage: AuthStorage): Promise<ModelCatalogEntry[]> {
  const gateways = readCustomGatewayProviders(agentDir);
  if (gateways.length === 0) return [];
  const perProvider = await Promise.all(
    gateways.map(async ({ provider, baseUrl }) => {
      const key = await authStorage.getApiKey(provider);
      if (key === undefined) return []; // provider not configured → nothing to probe
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), GATEWAY_PROBE_TIMEOUT_MS);
      try {
        const res = await fetch(gatewayModelsUrl(baseUrl), { headers: { Authorization: `Bearer ${key}` }, signal: controller.signal });
        if (!res.ok) return [];
        const body = gatewayModelListSchema.safeParse(await res.json());
        if (!body.success) return [];
        const models: ModelCatalogEntry[] = [];
        for (const item of body.data.data) {
          const entry = gatewayModelEntrySchema.safeParse(item);
          if (!entry.success) continue;
          const name = entry.data.name;
          models.push({ id: entry.data.id, name: name !== undefined && name !== "" ? name : entry.data.id, provider });
        }
        return models;
      } catch {
        return []; // timeout / refused / malformed → declared set only
      } finally {
        clearTimeout(timer);
      }
    }),
  );
  return perProvider.flat();
}

/** Cached-per-build entry point: one combined probe pass per agent dir per process. */
function probeGatewayCached(agentDir: string, authStorage: AuthStorage): Promise<ModelCatalogEntry[]> {
  const cached = gatewayProbeCache.get(agentDir);
  if (cached !== undefined) return cached;
  const probing = probeGatewayModels(agentDir, authStorage).catch(() => []);
  gatewayProbeCache.set(agentDir, probing);
  return probing;
}

/** Declared catalog first, then probed gateway models not already present (dedup by provider/id). */
function mergeProbedModels(declared: ModelCatalogEntry[], probed: ModelCatalogEntry[]): ModelCatalogEntry[] {
  if (probed.length === 0) return declared;
  const seen = new Set(declared.map((model) => `${model.provider}/${model.id}`));
  const merged = [...declared];
  for (const model of probed) {
    const key = `${model.provider}/${model.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(model);
  }
  return merged;
}

/**
 * Resolves a create_work_item `model` value, fail closed:
 * - "fast"/"reasoning" (case-insensitive) → the role ref, stored verbatim;
 * - an exact "provider/id" → that model's bare id (explicit intent wins,
 *   even over the near preference — the user named the provider);
 * - a friendly name → the unique best available-model match, matched
 *   case-insensitively by substring over id, name, and "provider/id"
 *   (token-wise so "deepseek v4" hits deepseek-v4-flash);
 * - near preference (issue #194): when several providers tie at the best
 *   match and near is one of them, near wins — near's deepseek is the
 *   WORKING one, opencode-go's is #78-broken, and an unqualified value
 *   must never land on a broken model by default. An exact bare id at a
 *   non-near provider is treated as a strong (tie-able) match, not an
 *   automatic win, so the unqualified "deepseek-v4-flash" can be won by
 *   near's deepseek-ai/DeepSeek-V4-Flash (which matches the same name);
 * - no match → error listing the available candidates; ambiguous matches
 *   (several models tie at the best score without a single near winner)
 *   → error listing those.
 * Never guesses: an unresolvable or ambiguous name is an error the agent
 * can clarify, and no work item is created.
 */
export function resolveModelPin(
  raw: string,
  catalog: ModelCatalogEntry[],
  options: ModelPinResolutionOptions = {},
): ModelPinResolution {
  const query = raw.trim();
  const q = query.toLowerCase();
  if (q === "fast" || q === "reasoning") return { ok: true, pin: { kind: "role", role: q } };
  if (!q) return { ok: false, error: "model must not be empty" };

  const entries = catalog.map((model) => ({
    model,
    haystack: `${model.id} ${model.name} ${model.provider}/${model.id}`.toLowerCase(),
  }));

  // A provider-qualified id ("opencode-go/deepseek-v4-flash") names ONE
  // entry — explicit intent, resolved outright. Issue #238: the pin carries
  // the matched entry's provider so the driver never re-derives it from a
  // bare-id catalog find (which lands on the FIRST same-id provider).
  const qualified = entries.find((e) => `${e.model.provider}/${e.model.id}`.toLowerCase() === q);
  if (qualified) {
    return { ok: true, pin: { kind: "id", provider: qualified.model.provider, modelId: qualified.model.id } };
  }

  // Score every model: 0 = the exact bare id, served by near (the working
  // provider — an exact id it serves is unambiguous intent); 1 = the exact
  // bare id elsewhere, or the whole query is a substring; 2 = every
  // whitespace-separated token is; 3 = at least one token is.
  const tokens = q.split(/\s+/).filter(Boolean);
  const scored: Array<{ entry: (typeof entries)[number]; score: number }> = [];
  for (const entry of entries) {
    let score = Infinity;
    if (entry.model.id.toLowerCase() === q) score = entry.model.provider === NEAR_PROVIDER ? 0 : 1;
    else if (entry.haystack.includes(q)) score = 1;
    else if (tokens.length > 0 && tokens.every((token) => entry.haystack.includes(token))) score = 2;
    else if (tokens.some((token) => entry.haystack.includes(token))) score = 3;
    if (score < Infinity) scored.push({ entry, score });
  }
  if (scored.length === 0) {
    return {
      ok: false,
      error:
        `model '${query}' matches no available model. Available: ${formatModelCandidates(catalog)} ` +
        "(or a role ref: fast, reasoning)",
    };
  }
  scored.sort(
    (a, b) => a.score - b.score || a.entry.model.id.length - b.entry.model.id.length || a.entry.model.id.localeCompare(b.entry.model.id),
  );
  const best = scored[0]!.score;
  const bestMatches = scored.filter((s) => s.score === best);
  if (bestMatches.length > 1) {
    // Near preference: several providers tie at the best match — near wins
    // when it is the unique near candidate (working deepseek; #78-broken
    // opencode-go deepseek never wins an unqualified tie by default).
    const near = bestMatches.filter((s) => s.entry.model.provider === NEAR_PROVIDER);
    if (near.length === 1) {
      return { ok: true, pin: { kind: "id", provider: near[0]!.entry.model.provider, modelId: near[0]!.entry.model.id } };
    }
    // Preferred-provider tie-break (issue #244): a bare id served by several
    // providers (gpt-5.6-luna on openai, openai-codex, opencode-go,
    // anthropic) is not ambiguous when the caller pins the SPACE's own
    // default — the space's qualified default names that provider. Only a
    // UNIQUE preferred candidate among the tied best matches wins; a
    // preferred provider that is not in the tie leaves the ambiguity
    // (fail closed). Near (above) and provider-qualified queries (before
    // scoring) both outrank this.
    const preferred =
      options.preferredProvider === undefined
        ? []
        : bestMatches.filter((s) => s.entry.model.provider === options.preferredProvider);
    if (preferred.length === 1) {
      return { ok: true, pin: { kind: "id", provider: preferred[0]!.entry.model.provider, modelId: preferred[0]!.entry.model.id } };
    }
    return {
      ok: false,
      error: `model '${query}' is ambiguous — matches ${formatModelCandidates(bestMatches.map((s) => s.entry.model))}; be more specific`,
    };
  }
  return { ok: true, pin: { kind: "id", provider: bestMatches[0]!.entry.model.provider, modelId: bestMatches[0]!.entry.model.id } };
}

/** "provider/id (name)" per available model, for fail-closed error messages. */
export function formatModelCandidates(catalog: ModelCatalogEntry[]): string {
  if (catalog.length === 0) return "none (no model has configured auth in the agent dir)";
  return catalog.map((m) => `${m.provider}/${m.id} (${m.name})`).join(", ");
}
