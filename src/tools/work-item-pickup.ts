/**
 * Semantic auto-pickup of actionable messages (issue #89): the deterministic
 * contract behind the space agent's pickup guidance.
 *
 * The agent (LLM) classifies each turn — draft vs ask vs none — following the
 * directive built by {@link buildAutoPickupDirective}, which rides the space
 * session prompt when the org floor enables `work_items.auto_pickup`. This
 * module is the single source of truth that directive encodes: the intent
 * vocabulary, the confidence-gated decision table, and the model/effort
 * derivation. Keeping the contract as pure functions makes the acceptance
 * behavior hermetic and testable, and keeps the guidance text honest —
 * the directive is derived from the same vocabulary and rules.
 *
 * Fail closed, like every pickup surface: a disabled flag never drafts, an
 * ambiguous request asks instead of guessing, and a pin that names no
 * available model resolves to an error the agent surfaces rather than a
 * silent default.
 */
import type { PickupConfidence } from "../policy/config";
import { resolveModelPin, type ModelCatalogEntry, type ModelPin } from "../models/model-pin";

export type PickupDecision = "draft" | "ask" | "none";

/** Per-task reasoning-effort pin values (issue #185), mirrored from create_work_item. */
export type ReasoningEffort = "off" | "low" | "medium" | "high";

/** Confidence ranks for the threshold comparison (high drafts the most). */
const CONFIDENCE_RANK: Record<PickupConfidence, number> = { high: 3, medium: 2, low: 1 };

/** The intent vocabulary the guidance recognizes (issue #89). */
export interface IntentVocabularyEntry {
  kind: string;
  label: string;
  examples: string[];
}

export const INTENT_VOCABULARY: IntentVocabularyEntry[] = [
  { kind: "implement", label: "implement", examples: ["implement this feature", "build the checkout flow"] },
  { kind: "research", label: "research", examples: ["research Y", "investigate the flaky test"] },
  { kind: "create-issue", label: "create-issue", examples: ["create an issue for Z", "file a bug ticket"] },
  { kind: "file-work", label: "file-work", examples: ["update the xls", "fill out this document"] },
  { kind: "data-work", label: "data-work", examples: ["process this dataset", "clean the export"] },
];

/** A request is actionable when it carries one of these verbs (issue #89). */
const ACTIONABLE_RE =
  /\b(?:implement|build|add|fix|write|develop|create|research|investigate|analyze|update|fill|edit|process|extract|transform|migrate|clean|review|refactor|set up|setup|look into|figure out|find out)\b/i;

/** Hedged phrasing: a polite/conditional request, not a direct imperative. */
const HEDGE_RE = /\b(?:can|could|would|will)\s+you\b|\b(?:do|would)\s+you\s+mind\b|\bhelp\s+me\b|\bany\s+chance\b/i;

/**
 * Tokens that carry no concrete object. A request like "implement something
 * for me" is vague even though it has words after the verb.
 */
const VAGUE_TOKEN_RE =
  /^(?:something|anything|nothing|this|that|it|these|those|things|stuff|everything|all|the|a|an|for|me|us|you|with|about|on|at|in|out|and|or|of|to|please|now|soon|today|later|first|next|some|someone|maybe|perhaps|possibly)$/;

/** Leading politeness/greeting the imperative test skips. */
const LEADING_POLITENESS_RE = /^(?:(?:hey|hi|hello|yo)\b[\s,]*)?(?:please\b[\s,]*)?/i;

function imperativeStart(text: string): boolean {
  const trimmed = text.replace(LEADING_POLITENESS_RE, "");
  const verb = ACTIONABLE_RE.exec(trimmed);
  return verb !== null && verb.index === 0;
}

/** The request names something concrete when a real token follows the verb. */
function hasConcreteObject(text: string): boolean {
  const verb = ACTIONABLE_RE.exec(text);
  if (!verb) return false;
  const rest = text.slice(verb.index + verb[0].length);
  const tokens = rest.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return tokens.some((token) => !VAGUE_TOKEN_RE.test(token));
}

/**
 * The pickup decision table (issue #89), mirroring the agent guidance:
 *
 * - disabled → `none` (auto-pickup never runs; the directive is not even
 *   appended to the session prompt);
 * - no actionable intent → `none` (informational turns are not work);
 * - actionable + high confidence (a direct imperative with a concrete
 *   object, e.g. "implement X") → `draft` at the default threshold;
 * - actionable + medium confidence (hedged but concrete, e.g. "could you
 *   implement X?") → `draft` only when the threshold is medium or low;
 * - actionable + low confidence (vague/object-less) → `draft` only at the
 *   low threshold; otherwise `ask` (never guess, never silent).
 *
 * `threshold` is `work_items.pickup_confidence` (default "high").
 */
export function classifyPickupIntent(
  text: string,
  opts?: { enabled?: boolean; threshold?: PickupConfidence },
): PickupDecision {
  const enabled = opts?.enabled ?? false;
  const threshold = opts?.threshold ?? "high";
  if (!enabled) return "none";
  if (!ACTIONABLE_RE.test(text)) return "none";
  const concrete = hasConcreteObject(text);
  let confidence: PickupConfidence;
  if (imperativeStart(text) && concrete) confidence = "high";
  else if (HEDGE_RE.test(text) && concrete) confidence = "medium";
  else confidence = "low";
  return CONFIDENCE_RANK[confidence] >= CONFIDENCE_RANK[threshold] ? "draft" : "ask";
}

/** A parsed "using <model> [at <effort>]" pin from a request. */
export interface ModelEffortPin {
  /** The friendly model name as stated ("deepseek v4"). */
  model: string;
  /** The effort pin when the request names one ("at low effort"). */
  reasoningEffort?: ReasoningEffort;
}

/**
 * Parses the #185 pin from a request: `using <model friendly name> [at
 * <effort>]`. The model name is everything from "using " up to the effort
 * pin or a sentence boundary; effort is one of off/low/medium/high.
 * Returns null when the request names no pin.
 */
export function parseModelEffortPin(text: string): ModelEffortPin | null {
  const match =
    /\busing\s+([a-z0-9][a-z0-9 ._/-]*?)(?:\s+at\s+(off|low|medium|high)\s+effort\b)?(?=[.,;!?](?:\s|$)|\s*$|\s+(?:and|then|to|please|so|for)\b)/i.exec(
      text,
    );
  if (!match) return null;
  const model = match[1]!.trim().replace(/\s+/g, " ");
  if (!model) return null;
  return {
    model,
    ...(match[2] !== undefined ? { reasoningEffort: match[2]!.toLowerCase() as ReasoningEffort } : {}),
  };
}

/**
 * The derived pin a confirmable draft carries (issue #89): parse the
 * request's "using <model> [at <effort>]" mention, then resolve the model
 * name against the available catalog exactly like create_work_item does
 * (fail closed — an unresolvable/ambiguous name is an error the agent
 * surfaces, never a silent default).
 *
 * Returns null when the request names no pin (the draft omits it and the
 * space's model settings apply at execution).
 */
export type DerivedModelPin =
  | { ok: true; model: ModelPin; reasoningEffort?: ReasoningEffort }
  | { ok: false; error: string };

export function deriveModelPin(text: string, catalog: ModelCatalogEntry[]): DerivedModelPin | null {
  const parsed = parseModelEffortPin(text);
  if (!parsed) return null;
  const resolution = resolveModelPin(parsed.model, catalog);
  if (!resolution.ok) return { ok: false, error: resolution.error };
  return {
    ok: true,
    model: resolution.pin,
    ...(parsed.reasoningEffort !== undefined ? { reasoningEffort: parsed.reasoningEffort } : {}),
  };
}

/**
 * The pickup directive appended to the space session prompt when
 * `work_items.auto_pickup` is on (org floor, issue #89). Evaluated at
 * session creation like the response-mode directive, so a config change
 * applies on the next cold start. The threshold parameter mirrors the
 * `work_items.pickup_confidence` knob in the wording of the confidence gate.
 */
export function buildAutoPickupDirective(threshold: PickupConfidence = "high"): string {
  const vocabulary = INTENT_VOCABULARY.map((entry) => `${entry.label} (${entry.examples.join(", ")})`).join("; ");
  const draftsOn =
    threshold === "high"
      ? "direct explicit requests with a concrete object (e.g. \"implement X\")"
      : threshold === "medium"
        ? "direct or hedged-but-concrete requests (e.g. \"implement X\", \"could you implement X?\")"
        : "any detected actionable intent";
  return [
    "Semantic auto-pickup is ON (work_items.auto_pickup): when the user states an actionable intent — " +
      `${vocabulary} — treat it as a work-item request.`,
    `Confidence gate (work_items.pickup_confidence=${threshold}): ${draftsOn} → post a CONFIRMABLE DRAFT of the ` +
      "work item (description, repo when derivable, delivery kind, model/effort pin) and ask the user to confirm. " +
      "On explicit confirmation, call create_work_item with the draft's fields. Below that confidence (hedged, " +
      "vague, or missing object) → ask a clarifying question first. Never create a work item without explicit " +
      "in-channel confirmation, and never silently ignore an actionable request.",
    'Model/effort derivation: when the request names a pin ("using <model> [at <effort>]"), carry the model + ' +
      "reasoning_effort into the draft and then into create_work_item (which resolves the name against the " +
      "available catalog, fail closed). No mention → omit the pin; the space's model settings apply.",
  ].join("\n");
}
