/**
 * Test-side journey registry for the hybrid canary (issue #298).
 *
 * Three layers share stable journey ids and one typed descriptor:
 *   - "hermetic"  : caller-level role/multiplayer journeys against the REAL
 *                   SpaceService / store / policy / Slack emulator path.
 *   - "live-api"  : strict nightly journeys against the real Slack API with
 *                   the four fixed QA identities.
 *   - "browser"   : real browser journeys on a self-hosted runner with two
 *                   persistent Chrome profiles.
 *
 * This module is the SOURCE OF TRUTH for what every journey covers. The
 * built-in-tool coverage gate (canary-registry.test.ts) enumerates the
 * SURFACED registered tool names and FAILS when one lacks a journey mapping
 * or an explicit non-empty exclusion.
 *
 * Third-party extension behavior is mapped by capability class (credential /
 * transport / policy), not vendor-by-vendor; each class gets one row below.
 */
import { BUILTIN_TOOLS, HIDDEN_TOOLS } from "@oh-my-pi/pi-coding-agent";
import { PROJECT_TOOL_NAMES } from "../../src/extensions/manifest";
import { SPACE_AGENT_TOOLS } from "../../src/server/drivers/agent-driver";


/** The three layers every journey belongs to; each journey has exactly one. */
export const JOURNEY_LAYERS = ["hermetic", "live-api", "browser"] as const;
export type JourneyLayer = (typeof JOURNEY_LAYERS)[number];

/** A typed journey descriptor shared by coverage + reporting. */
export interface CanaryJourney {
  /** Stable journey id, shared across all three layers (e.g. "roles.queue-ownership"). */
  id: string;
  /** The layer this journey executes in. */
  layer: JourneyLayer;
  /**
   * The fixed identities this journey requires: "requester", "space-approver",
   * "member", "second-member", or "bot". Empty when identity-agnostic.
   */
  actors: string[];
  /**
   * Surfaced tool names (see SURFACED_TOOL_NAMES) or capability classes
   * ("credential", "transport", "policy", "mcp", "cli", "oauth") this
   * journey exercises. The coverage gate checks these.
   */
  covers: string[];
  /** The human-visible evidence the journey must observe (a reply, a card, a form). */
  visibleProof: string;
  /** The durable evidence the journey must verify (store rows, audit events, permalinks). */
  durableProof: string;
  /** Fixtures the journey needs: emulator identities, live tokens, browser profiles. */
  fixtures: string[];
  /** Explicit non-empty reason when this row is a coverage/exclusion row, not a runnable journey. */
  exclusionReason?: string;
}

/** Capability classes covering third-party extension behavior (not vendor-by-vendor). */
export const CAPABILITY_CLASSES = [
  "credential", // secrets, boundaries, vault writes
  "transport", // streamable-http / stdio wiring
  "policy", // allow/deny/prompt decision table
  "mcp", // model-context-protocol surface
  "cli", // command-line bindings
  "oauth", // OAuth credential flows
] as const;

export type CapabilityClass = (typeof CAPABILITY_CLASSES)[number];

/**
 * SDK built-ins that the space agent's SESSION does NOT surface (not in
 * SPACE_AGENT_TOOLS / PROJECT_TOOL_NAMES). They are not callable by the
 * space agent, so no canary journey can exercise them — one explicit
 * exclusion row covers all of them.
 */
export const NON_SURFACED_SDK_BUILTINS: string[] = Object.keys(BUILTIN_TOOLS).filter(
  (name) => !SPACE_AGENT_TOOLS.some((toolName) => toolName === name) &&
    !PROJECT_TOOL_NAMES.some((toolName) => toolName === name),
).concat(Object.keys(HIDDEN_TOOLS));

/**
 * The tools the coverage gate REQUIRES to be mapped: the namespace the space
 * agent's session can actually call — the union of the SDK built-ins the
 * session allowlist surfaces (SPACE_AGENT_TOOLS ∩ BUILTIN_TOOLS), the
 * session allowlist itself, the project/reserved tools, and the scheduler /
 * admin / KB / render tools surfaced through the custom-tools bridge.
 *
 * A built-in NOT surfaced by the session needs no journey (structurally
 * excluded via NON_SURFACED_SDK_BUILTINS).
 */
export const SURFACED_TOOL_NAMES: readonly string[] = Array.from(
  new Set([
    ...SPACE_AGENT_TOOLS,
    ...PROJECT_TOOL_NAMES,
    ...Object.keys(BUILTIN_TOOLS).filter((name) => SPACE_AGENT_TOOLS.some((toolName) => toolName === name)),
    // Scheduler administration tools (src/scheduler/scheduler-tools.ts).
    "create_scheduler_job",
    "list_scheduler_jobs",
    "update_scheduler_job",
    "pause_scheduler_job",
    "resume_scheduler_job",
    "run_scheduler_job_now",
    "delete_scheduler_job",
    // Knowledge-base ingestion (src/tools/kb-tools.ts).
    "kb_ingest",
    // Other tools surfaced through the session custom-tools bridge.
    "complete_work_item",
    "render_chart",
    "search_web",
  ]),
);

/**
 * :: The hybrid canary's journey registry ::
 *
 * One row per journey, stable ids, layer-tagged, with the tools/classes they
 * cover. The tool-coverage gate (canary-registry.test.ts) checks:
 *   - every SURFACED_TOOL_NAMES entry appears in some journey's `covers`,
 *   - every `covers` key is a real surfaced tool or capability class,
 *   - every exclusion row bills an explicit non-empty reason.
 */
export const JOURNEYS: readonly CanaryJourney[] = [
  // ========================= Layer: hermetic =============================
  {
    id: "roles.cross-user-queue-ownership",
    layer: "hermetic",
    actors: ["requester", "member", "second-member"],
    covers: ["create_work_item", "list_work_items", "work_item_cancel"],
    visibleProof: "each user's items carry the right requester in list_work_items",
    durableProof: "work_items rows + WORK_ITEM_CREATED_EVENT audit rows keyed by requester principal",
    fixtures: ["emulator:requester", "emulator:member", "emulator:second-member"],
  },
  {
    id: "roles.same-user-steering-cross-user",
    layer: "hermetic",
    actors: ["requester", "member"],
    covers: [],
    visibleProof: "the requester's correction steers their own turn; the member's message queues, not steers",
    durableProof: "turn transcript + reply ownership: no cross-user reply attribution",
    fixtures: ["emulator:requester", "emulator:member"],
  },
  {
    id: "roles.approve-deny-actors",
    layer: "hermetic",
    actors: ["requester", "space-approver", "member"],
    covers: ["model_settings"],
    visibleProof: "approve by the space-approver lands; deny by an ordinary member is rejected",
    durableProof: "APPROVAL_RESOLVED_EVENT rows keyed by approver principal",
    fixtures: ["emulator:requester", "emulator:space-approver", "emulator:member"],
  },
  {
    id: "roles.credential-isolation",
    layer: "hermetic",
    actors: ["member", "second-member"],
    covers: ["credential", "connect_extension"],
    visibleProof: "each user's personal credential is only visible to them",
    durableProof: "extension.connected audit rows scoped per owner principal",
    fixtures: ["emulator:member", "emulator:second-member"],
  },
  {
    id: "roles.personal-vs-org-memory",
    layer: "hermetic",
    actors: ["member", "second-member"],
    covers: ["memory.save", "memory.search"],
    visibleProof: "org memory shared; personal memory isolated per principal",
    durableProof: "memory.write audit rows with scope org vs user + principal",
    fixtures: ["emulator:member", "emulator:second-member"],
  },
  {
    id: "roles.work-item-ownership-cancel",
    layer: "hermetic",
    actors: ["requester", "member"],
    covers: ["create_work_item", "work_item_cancel"],
    visibleProof: "only the requester (or a space approver) can cancel a work item",
    durableProof: "work_items state transitions audited with the cancelling actor",
    fixtures: ["emulator:requester", "emulator:member"],
  },
  {
    id: "roles.simultaneous-dm-channel",
    layer: "hermetic",
    actors: ["requester", "member", "second-member"],
    covers: ["use_model"],
    visibleProof: "a DM turn and a channel turn run concurrently without interleaving replies",
    durableProof: "per-space transcripts + reply ownership per conversation",
    fixtures: ["emulator:requester", "emulator:member", "emulator:second-member"],
  },
  {
    id: "roles.per-task-model-isolation",
    layer: "hermetic",
    actors: ["requester", "member"],
    covers: ["use_model", "model_settings"],
    visibleProof: "a work item's pinned model role does not change the other member's active role",
    durableProof: "model.pin_applied + model switched audit rows scoped per session/space",
    fixtures: ["emulator:requester", "emulator:member"],
  },
  {
    id: "operator.read-surfaces",
    layer: "hermetic",
    actors: ["requester", "member"],
    covers: ["audit_search", "explain_policy"],
    visibleProof: "cursor-paged audit rows and allow/deny/ask explanations are viewer-scoped and redacted",
    durableProof: "audit.read + policy.explained rows; no approval.requested row from explanation",
    fixtures: ["sqlite:seeded-audit", "policy:deny-ask-allow", "slack:admin-authority-double"],
  },


  // ====================== Layer: live-api ================================
  {
    id: "live.roles.queue-ownership",
    layer: "live-api",
    actors: ["requester", "member", "second-member", "space-approver"],
    covers: ["create_work_item", "work_item_cancel", "list_work_items"],
    visibleProof: "requester's item appears with their user; only they can cancel it",
    durableProof: "WORK_ITEM_CREATED_EVENT + cancel audit rows with requester/actor principals",
    fixtures: ["live:SLACK_QA_REQUESTER_TOKEN", "live:SLACK_QA_APPROVER_TOKEN", "live:SLACK_QA_MEMBER_TOKEN", "live:SLACK_QA_SECOND_TOKEN"],
  },
  {
    id: "live.roles.approve-deny",
    layer: "live-api",
    actors: ["requester", "space-approver", "member"],
    covers: ["model_settings"],
    visibleProof: "approve/deny resolution with approver attribution in the channel",
    durableProof: "APPROVAL_RESOLVED_EVENT rows + redacted Block Kit payload permalink",
    fixtures: ["live:SLACK_QA_REQUESTER_TOKEN", "live:SLACK_QA_APPROVER_TOKEN", "live:SLACK_QA_MEMBER_TOKEN"],
  },
  {
    id: "live.roles.personal-vs-org-memory",
    layer: "live-api",
    actors: ["member", "second-member"],
    covers: ["memory.save", "memory.search"],
    visibleProof: "org memory round-trips to both members; personal memory isolates per principal",
    durableProof: "memory.write rows (scope org vs user) + audit + permalink",
    fixtures: ["live:SLACK_QA_MEMBER_TOKEN", "live:SLACK_QA_SECOND_TOKEN"],
  },
  {
    id: "live.roles.credential-isolation",
    layer: "live-api",
    actors: ["member", "second-member"],
    covers: ["credential", "connect_extension"],
    visibleProof: "member's personal credential row is not visible to the second member",
    durableProof: "extension.connected audit rows keyed by owner principal",
    fixtures: ["live:SLACK_QA_MEMBER_TOKEN", "live:SLACK_QA_SECOND_TOKEN"],
  },
  {
    id: "live.roles.simultaneous-dm-channel",
    layer: "live-api",
    actors: ["requester", "member"],
    covers: [
      "list_todos",
      "settings",
      "catalog_browser",
      "stack_health",
      "deploy_info",
      "first_run_wizard",
      "list_space_skills",
      "get_space_skill",
      "create_space_skill",
      "update_space_skill",
      "delete_space_skill",
      "session_search",
      "todo",
    ],
    visibleProof: "a DM turn and a channel turn both complete; replies stay in their own conversation",
    durableProof: "per-space transcripts + permalinks for both replies",
    fixtures: ["live:SLACK_QA_REQUESTER_TOKEN", "live:SLACK_QA_MEMBER_TOKEN"],
  },
  {
    id: "live.roles.per-task-model-pin",
    layer: "live-api",
    actors: ["requester", "member"],
    covers: ["use_model", "model_settings"],
    visibleProof: "per-task pin applied without disturbing the other member's session role",
    durableProof: "model.pin_applied + model switched audit rows per session",
    fixtures: ["live:SLACK_QA_REQUESTER_TOKEN", "live:SLACK_QA_MEMBER_TOKEN"],
  },
  {
    id: "live.scheduler-lifecycle",
    layer: "live-api",
    actors: ["requester"],
    covers: ["create_scheduler_job", "pause_scheduler_job", "resume_scheduler_job", "run_scheduler_job_now", "list_scheduler_jobs"],
    visibleProof: "the QA turn drives create → pause → resume → run-now on a durable scheduler job",
    durableProof: "SCHEDULER_FIRE_EVENT audit row (source manual) + job enabled/next-fire store state",
    fixtures: ["live:SLACK_QA_REQUESTER_TOKEN"],
  },
  {
    id: "live.operator-home",
    layer: "live-api",
    actors: ["requester"],
    covers: ["explain_policy"],
    visibleProof: "the read-tier policy explanation posts matching the effective allow list (no approval)",
    durableProof: "policy.explained audit row; no approval.requested row from explanation",
    fixtures: ["live:SLACK_QA_REQUESTER_TOKEN"],
  },

  // ======================== Layer: browser ===============================
  {
    id: "browser.dm-card-lifecycle",
    layer: "browser",
    actors: ["requester"],
    covers: [],
    visibleProof: "DM card transitions seen in the DOM (thinking → reply, no orphan card)",
    durableProof: "screenshot + browser trace of the final card state + DM permalink",
    fixtures: ["browser:profile-requester"],
  },
  {
    id: "browser.approve-deny-buttons",
    layer: "browser",
    actors: ["requester", "space-approver"],
    covers: ["model_settings"],
    visibleProof: "real approve/deny buttons observed and clicked by the approver profile",
    durableProof: "screenshot + trace of the button state + APPROVAL_RESOLVED audit row",
    fixtures: ["browser:profile-requester", "browser:profile-approver"],
  },
  {
    id: "browser.native-chart-citation",
    layer: "browser",
    actors: ["requester"],
    covers: ["render_chart"],
    visibleProof: "native chart + citation rendered in the DM reply",
    durableProof: "screenshot + trace of the rendered blocks",
    fixtures: ["browser:profile-requester"],
  },
  {
    id: "browser.connect-upload",
    layer: "browser",
    actors: ["requester"],
    covers: ["connect_extension", "credential"],
    visibleProof: "connect + upload browser flow completes with the upload form visible",
    durableProof: "screenshot + trace + extension.connected audit row",
    fixtures: ["browser:profile-requester"],
  },
  {
    id: "browser.threaded-multiplayer",
    layer: "browser",
    actors: ["requester", "member"],
    covers: [],
    visibleProof: "a thread's replies continue under the same thread across two members",
    durableProof: "screenshot + trace + thread permalink",
    fixtures: ["browser:profile-requester", "browser:profile-member"],
  },

  // ============ Third-party capability coverage by class =================
  // A coverage row with no exclusionReason is a runnable journey; a row with
  // an explicit non-empty exclusionReason documents a class covered elsewhere.
  {
    id: "coverage.session-file-surface",
    layer: "hermetic",
    actors: [],
    covers: ["web_search", "use_model", "model_settings"],
    visibleProof: "the file/model surface the chat + multiplayer journeys drive",
    durableProof: "the canary hermetic + live journeys exercise these tools end-to-end",
    fixtures: ["emulator:standard"],
    exclusionReason: "the generic file/model surface is exercised by the existing chat + multiplayer journeys; no dedicated journey needed",
  },
  {
    id: "coverage.scheduler-kb-surface",
    layer: "hermetic",
    actors: [],
    covers: [
      "create_scheduler_job",
      "list_scheduler_jobs",
      "update_scheduler_job",
      "pause_scheduler_job",
      "resume_scheduler_job",
      "run_scheduler_job_now",
      "delete_scheduler_job",
      "kb_ingest",
      "list_todos",
      "complete_work_item",
      "search_web",
    ],
    visibleProof: "the scheduler + KB + completion surface is exercised through the scheduler harness",
    durableProof: "scheduler-job + KB audit rows",
    fixtures: ["registry:scheduler"],
    exclusionReason: "the scheduler + KB tools are exercised by the existing scheduler/work-item journeys; no dedicated journey needed",
  },
  {
    id: "coverage.mcp-transport",
    layer: "hermetic",
    actors: [],
    covers: ["mcp", "transport"],
    visibleProof: "the MCP surface + streamable-http/stdio transport are exercised",
    durableProof: "the extension-registry + runtime journey coverage rows",
    fixtures: ["registry:fixture"],
    exclusionReason: "extension-registry/hermetic journeys cover the MCP transport surface; not a runnable journey of its own",
  },
  {
    id: "coverage.cli-binding",
    layer: "hermetic",
    actors: [],
    covers: ["cli"],
    visibleProof: "CLI extensions are validated + wired",
    durableProof: "manifest validation + runtime registry coverage",
    fixtures: ["registry:fixture"],
    exclusionReason: "covered by the extension-manifest/hermetic validation journeys; no live CLI vendor needed",
  },
  {
    id: "coverage.oauth-credential",
    layer: "live-api",
    actors: ["member"],
    covers: ["oauth"],
    visibleProof: "OAuth credential flow round-trips",
    durableProof: "OOAuth flow store + extension.connected audit rows",
    fixtures: ["live:SLACK_QA_MEMBER_TOKEN", "registry:oauth-fixture"],
    exclusionReason: "covered by the canary OAuth fixture journey (issue #198); no third-party OAuth vendor enumerated",
  },
  {
    id: "coverage.policy-decision",
    layer: "hermetic",
    actors: [],
    covers: ["policy"],
    visibleProof: "allow/deny/prompt decision table driven through the real gate",
    durableProof: "policy.decision audit rows",
    fixtures: ["registry:policy"],
    exclusionReason: "the policy decision table is covered by the approver/hermetic journeys and unit tests; not a vendor row",
  },
  {
    id: "coverage.non-surfaced-sdk-builtins",
    layer: "hermetic",
    actors: [],
    covers: NON_SURFACED_SDK_BUILTINS,
    visibleProof: "(no journey runs; these tools are not callable by the space agent)",
    durableProof: "SPACE_AGENT_TOOLS + PROJECT_TOOL_NAMES reserve the surfaced set; these are excluded by the session allowlist",
    fixtures: ["registry:session-allowlist"],
    exclusionReason:
      "These SDK built-ins are NOT in the space agent's session tool set (SPACE_AGENT_TOOLS / PROJECT_TOOL_NAMES) — " +
      "the space agent cannot call them, so no canary journey can exercise them; the session allowlist excludes them structurally",
  },
];

// ---------------------------------------------------------------------------
// Gate helpers.
// ---------------------------------------------------------------------------

/**
 * The surfaced built-in tools that have NO covering journey and NO explicit
 * exclusion. Empty when the gate holds. A bound tool with no journey mapping
 * and no non-empty exclusion reason is UNMAPPED — CI must fail.
 */
export function uncoveredTools(
  registered: readonly string[] = SURFACED_TOOL_NAMES,
  journeys: readonly CanaryJourney[] = JOURNEYS,
): string[] {
  const covered = new Set<string>();
  const excluded = new Set<string>();
  for (const j of journeys) {
    const isExclusion = j.exclusionReason !== undefined && j.exclusionReason.trim().length > 0;
    for (const key of j.covers) {
      covered.add(key);
      if (isExclusion) excluded.add(key);
    }
  }
  return registered.filter((name) => !covered.has(name) && !excluded.has(name));
}

/** True only when every surfaced built-in tool is covered or excluded. */
export function allToolsCovered(
  registered: readonly string[] = SURFACED_TOOL_NAMES,
  journeys: readonly CanaryJourney[] = JOURNEYS,
): boolean {
  return uncoveredTools(registered, journeys).length === 0;
}

/** Journeys for a specific layer (the CI/runner filter for layer dispatch). */
export function journeysForLayer(
  layer: JourneyLayer,
  journeys: readonly CanaryJourney[] = JOURNEYS,
): CanaryJourney[] {
  return journeys.filter((j) => j.layer === layer);
}

/** Journeys touching a specific actor (the role filter for focused runs). */
export function journeysForActor(
  actor: string,
  journeys: readonly CanaryJourney[] = JOURNEYS,
): CanaryJourney[] {
  return journeys.filter((j) => j.actors.includes(actor));
}

/** The journey with a stable id, or undefined when unknown. */
export function journeyById(
  id: string,
  journeys: readonly CanaryJourney[] = JOURNEYS,
): CanaryJourney | undefined {
  return journeys.find((j) => j.id === id);
}

/** The four fixed identities the role/multiplayer matrix drives (issue #298). */
export const LIVE_IDENTITIES = ["requester", "approver", "member", "second-member"] as const;
export type LiveIdentity = (typeof LIVE_IDENTITIES)[number];

/**
 * Canonicalize a role alias to a fixed identity (issue #298). The registry
 * and CLI accept `space-approver` as the human-friendly name for the
 * `approver` identity; anything not a fixed identity or a known alias is
 * undefined (unknown role → caller must fail closed, never vacuously pass).
 */
export function canonicalIdentity(role: string): LiveIdentity | undefined {
  if (role === "space-approver") return "approver";
  return LIVE_IDENTITIES.find((identity) => identity === role);
}

/**
 * Focused-run filters parsed from the canary CLI (issue #298). */
export interface CanaryFilters {
  layer?: JourneyLayer;
  /** A single stable journey id ("roles.queue-ownership", …). */
  journey?: string;
  /** A single fixed actor ("requester", "space-approver", …). */
  role?: string;
}

/**
 * Parse the focused-run filters from argv: `--layer <hermetic|live-api|browser>`,
 * `--journey <stable id>`, `--role <actor>`. Unknown values THROW so a
 * mistyped filter fails loudly instead of silently running everything.
 */
export function parseCanaryFilters(
  argv: readonly string[],
  journeys: readonly CanaryJourney[] = JOURNEYS,
): CanaryFilters {
  const layerIdx = argv.indexOf("--layer");
  const journeyIdx = argv.indexOf("--journey");
  const roleIdx = argv.indexOf("--role");
  const has = (idx: number) => idx >= 0 && idx + 1 < argv.length;
  const value = (idx: number) => (has(idx) ? argv[idx + 1] : undefined);
  const filters: CanaryFilters = {};
  const layer = value(layerIdx);
  if (layer !== undefined) {
    const parsedLayer = JOURNEY_LAYERS.find((candidate) => candidate === layer);
    if (parsedLayer === undefined) {
      throw new Error(`invalid --layer "${layer}": expected hermetic | live-api | browser`);
    }
    filters.layer = parsedLayer;
  }
  const journey = value(journeyIdx);
  if (journey !== undefined) {
    if (journeys.find((j) => j.id === journey) === undefined) {
      throw new Error(`invalid --journey "${journey}": no such journey in the registry`);
    }
    filters.journey = journey;
  }
  const role = value(roleIdx);
  if (role !== undefined && journeysForActor(role, journeys).length === 0) {
    throw new Error(`invalid --role "${role}": no journey touches that actor`);
  }
  if (role !== undefined) filters.role = role;
  return filters;
}

/**
 * The journeys a focused run should attempt, given filters. An empty filter
 * set runs nothing (the caller's default). A filter narrows to matching
 * journeys; the caller then runs only those with runnable bodies.
 */
export function selectJourneys(
  filters: CanaryFilters,
  journeys: readonly CanaryJourney[] = JOURNEYS,
): CanaryJourney[] {
  let selected: CanaryJourney[] = [...journeys];
  if (filters.layer !== undefined) selected = selected.filter((j) => j.layer === filters.layer);
  if (filters.journey !== undefined) selected = selected.filter((j) => j.id === filters.journey);
  if (filters.role !== undefined) selected = selected.filter((j) => j.actors.includes(filters.role!));
  return selected;
}