/**
 * models.yml generation (issue #67): the agent-dir model catalog becomes a
 * boot-time output of the org settings blob (DB is the source of truth) —
 * the same pattern as the egress config generation (issue #50).
 *
 * The OMP SDK still reads the FILE (data/omp-agent/models.yml); generation
 * writes it from the DB settings at startup. The committed
 * config/omp/models.yml stays the no-settings default template: generation
 * writes ONLY when settings carry model ids — otherwise the template is
 * left in place, so a deployment without model settings is unchanged.
 *
 * The generated file keeps the template's provider skeleton (opencode-go
 * primary, NEAR fallback) and lists the configured model ids
 * (models.default/fast/reasoning, deduped, order-stable) under the NEAR
 * provider — the catalog the SDK can hand to sessions. Role selection
 * (which id a session uses for default/fast/reasoning) is the session
 * driver's concern (issue #64 model_settings), not this file's.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

/** The generated file (mounted agent dir, read by the OMP SDK at boot). */
export const MODELS_CONFIG_PATH = "data/omp-agent/models.yml";

/** The model knobs of the org settings blob (subset of OrgSettings). */
export interface ModelCatalogSettings {
  models?: {
    default?: string;
    fast?: string;
    reasoning?: string;
    /** Reasoning effort; not a catalog property, accepted for shape parity. */
    effort?: string;
  };
}

/** The configured model ids (default, fast, reasoning), non-empty and deduped, order-stable. */
export function configuredModelIds(settings: ModelCatalogSettings): string[] {
  const models = settings.models;
  if (!models) return [];
  const ids = [models.default, models.fast, models.reasoning].filter(
    (id): id is string => typeof id === "string" && id.trim().length > 0,
  );
  return [...new Set(ids)];
}

/**
 * Renders the agent-dir model catalog from the org settings blob.
 * Returns null when settings carry no model ids — the caller then leaves
 * the committed template in place (no-settings default).
 */
export function renderModelsConfig(settings: ModelCatalogSettings): string | null {
  const ids = configuredModelIds(settings);
  if (ids.length === 0) return null;
  const modelLines = ids
    .map(
      (id) =>
        `      - id: "${id}"\n` +
        `        name: "${id}"\n` +
        `        contextWindow: 128000\n` +
        `        maxTokens: 8192`,
    )
    .join("\n");
  return `# Model catalog for a bottega deployment (generated from DB settings, issue #67).
# Written at boot from the org_settings blob (models.default/fast/reasoning).
# The committed config/omp/models.yml stays the no-settings default template;
# edit settings (the settings tool) to change this file. Model ids are
# quoted because org-chosen ids may contain characters outside the YAML
# subset's plain scalars.
providers:
  # Primary model (issue #37): deepseek-v4-flash via the built-in opencode-go
  # provider. Key from env/Keychain (service: bottega-opencode).
  opencode-go:
    apiKey: OPENCODE_API_KEY
  # Fallback: NEAR AI Cloud gateway (issue #36). Used when no opencode key
  # is configured.
  near:
    api: openai-completions
    baseUrl: "https://cloud-api.near.ai/v1"
    apiKey: NEAR_API_KEY
    models:
${modelLines}
`;
}

/**
 * Writes the generated catalog to `outPath` when settings carry model ids;
 * returns the rendered text, or null when nothing was written (caller keeps
 * the template). Defaults are the deployment paths; the server calls this
 * at boot with the org settings blob.
 */
export function regenerateModelsConfig(
  settings: ModelCatalogSettings,
  outPath: string = MODELS_CONFIG_PATH,
): string | null {
  const yaml = renderModelsConfig(settings);
  if (yaml === null) return null;
  writeFileSync(resolve(outPath), yaml);
  return yaml;
}
