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
 */
import { ModelRegistry, discoverAuthStorage } from "@oh-my-pi/pi-coding-agent";
import { join } from "node:path";

/** The deployment agent dir both the server and the executor default to. */
export const DEFAULT_MODEL_CATALOG_DIR = "data/omp-agent";

/** Model role refs a pin may name directly (issue #185). */
export const MODEL_ROLE_REFS = ["fast", "reasoning"] as const;
export type ModelRoleRef = (typeof MODEL_ROLE_REFS)[number];

/** A resolved model pin: a role slot, or one concrete available model id. */
export type ModelPin = { kind: "role"; role: ModelRoleRef } | { kind: "id"; modelId: string };

export type ModelPinResolution = { ok: true; pin: ModelPin } | { ok: false; error: string };

/** The catalog shape the resolver matches against (id/name/provider of an available model). */
export interface ModelCatalogEntry {
  id: string;
  name: string;
  provider: string;
}

/**
 * The available model catalog for an agent dir: models.yml custom models +
 * the SDK's bundled provider catalog, filtered to models with configured
 * auth — the same registry the sessions resolve against.
 */
export async function listAvailableModels(agentDir: string): Promise<ModelCatalogEntry[]> {
  const registry = new ModelRegistry(await discoverAuthStorage(agentDir), join(agentDir, "models.yml"));
  return registry.getAvailable().map((model) => ({ id: model.id, name: model.name ?? model.id, provider: model.provider }));
}

/**
 * Resolves a create_work_item `model` value, fail closed:
 * - "fast"/"reasoning" (case-insensitive) → the role ref, stored verbatim;
 * - an exact available model id or "provider/id" → that model's bare id;
 * - a friendly name → the unique best available-model match, matched
 *   case-insensitively by substring over id, name, and "provider/id"
 *   (token-wise so "deepseek v4" hits deepseek-v4-flash);
 * - no match → error listing the available candidates; ambiguous matches
 *   (several models tie at the best score) → error listing those.
 * Never guesses: an unresolvable or ambiguous name is an error the agent
 * can clarify, and no work item is created.
 */
export function resolveModelPin(raw: string, catalog: ModelCatalogEntry[]): ModelPinResolution {
  const query = raw.trim();
  const q = query.toLowerCase();
  if (q === "fast" || q === "reasoning") return { ok: true, pin: { kind: "role", role: q } };
  if (!q) return { ok: false, error: "model must not be empty" };

  const entries = catalog.map((model) => ({
    model,
    haystack: `${model.id} ${model.name} ${model.provider}/${model.id}`.toLowerCase(),
  }));

  // Exact id / provider-id equality wins outright.
  const exact = entries.find((e) => e.model.id.toLowerCase() === q || `${e.model.provider}/${e.model.id}`.toLowerCase() === q);
  if (exact) return { ok: true, pin: { kind: "id", modelId: exact.model.id } };

  // Score every model: 1 = the whole query is a substring; 2 = every
  // whitespace-separated token is; 3 = at least one token is.
  const tokens = q.split(/\s+/).filter(Boolean);
  const scored: Array<{ entry: (typeof entries)[number]; score: number }> = [];
  for (const entry of entries) {
    let score = Infinity;
    if (entry.haystack.includes(q)) score = 1;
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
    return {
      ok: false,
      error: `model '${query}' is ambiguous — matches ${bestMatches.map((s) => s.entry.model.id).join(", ")}; be more specific`,
    };
  }
  return { ok: true, pin: { kind: "id", modelId: bestMatches[0]!.entry.model.id } };
}

/** "provider/id (name)" per available model, for fail-closed error messages. */
export function formatModelCandidates(catalog: ModelCatalogEntry[]): string {
  if (catalog.length === 0) return "none (no model has configured auth in the agent dir)";
  return catalog.map((m) => `${m.provider}/${m.id} (${m.name})`).join(", ");
}
