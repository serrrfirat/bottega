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
 * primary, NEAR fallback, plus the openai/anthropic custom gateways) and
 * lists the configured model ids (models.default/fast/reasoning, deduped,
 * order-stable) under the NEAR provider — the catalog the SDK can hand to
 * sessions. Since issue #208 every provider's apiKey is the proxy
 * placeholder (`bottega-proxy-placeholder`): the SDK sends it and
 * iron-proxy swaps the real key at egress; the app process never holds a
 * live key. Role selection (which id a session uses for default/fast/
 * reasoning) is the session driver's concern (issue #64 model_settings),
 * not this file's.
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
    (id): id is string => id !== undefined && id.trim().length > 0,
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
# CREDENTIALS LIVE AT iron-proxy (issue #208): every provider sends the
# placeholder bearer (bottega-proxy-placeholder) and the proxy swaps the
# real key at egress — the app process never holds a live key.
providers:
  # Primary model (issue #37, pinned #78): deepseek-v4-flash via the
  # built-in opencode-go provider. The entry is KEY-ONLY: opencode-go is a
  # built-in SDK catalog provider (deepseek-v4-flash ships there with its
  # transport metadata), and the SDK's models.yml validation treats any
  # provider declaration as CUSTOM — redeclaring its models without a
  # baseUrl fails the boot guard. The pin lives in config.yml
  # (modelRoles.default), so the session can never silently shift to the
  # catalog default (kimi-k2.7-code). The key is the proxy placeholder
  # (#208): the proxy injects the real opencode key at egress.
  opencode-go:
    apiKey: bottega-proxy-placeholder
  # Fallback: NEAR AI Cloud gateway (issue #36). Used when no opencode key
  # is configured.
  near:
    api: openai-completions
    baseUrl: "https://cloud-api.near.ai/v1"
    apiKey: bottega-proxy-placeholder
    models:
${modelLines}
  # Codex (ChatGPT subscription, issue #214): the ChatGPT Codex endpoint
  # with the subscription OAuth access token (a filesystem credential —
  # ~/.codex/auth.json — seeded to the proxy at boot; the placeholder is
  # the only key the app env ever sees, #208). KEY-ONLY, the opencode-go
  # pattern: openai-codex is a built-in SDK catalog provider (gpt-5.4
  # ships with its transport metadata + native codex wire contract —
  # stream:true + store:false REQUIRED, max_output_tokens REJECTED), and a
  # redeclared models list without a baseUrl would fail the boot guard.
  openai-codex:
    apiKey: bottega-proxy-placeholder
  # OpenAI (ChatGPT): direct OpenAI-compatible gateway. Declared anchor +
  # gateway probe (listAvailableModels) for the full live list.
  openai:
    api: openai-completions
    baseUrl: "https://api.openai.com/v1"
    apiKey: bottega-proxy-placeholder
    models:
      - id: "gpt-5-mini"
        name: "gpt-5-mini"
        contextWindow: 400000
        maxTokens: 128000
  # Anthropic (Claude): OpenAI-compatible endpoint
  # (docs.anthropic.com/en/api/openai-sdk). Same pattern as near/openai.
  anthropic:
    api: openai-completions
    baseUrl: "https://api.anthropic.com/v1"
    apiKey: bottega-proxy-placeholder
    models:
      - id: "claude-sonnet-4-5"
        name: "claude-sonnet-4-5"
        contextWindow: 200000
        maxTokens: 64000
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
