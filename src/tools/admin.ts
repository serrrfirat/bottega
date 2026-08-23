/**
 * Admin tools (issue #73): the setup & onboarding surfaces of the admin
 * epic (#72) — catalog browser, stack health, version/deploy info, and
 * the first-run wizard, all reachable by talking to the agent.
 *
 * Admin-gating mirrors the settings tool (issue #67): the three admin
 * surfaces are write-tier (`approval: "write"` + TIER_BY_TOOL → write), so
 * the policy gate prompts for human approval in non-yolo approval modes —
 * org-settings access IS the gate, exactly like org-scope settings sets.
 * `deploy_info` is read-tier (the issue: version/deploy info is for
 * anyone). Every invocation appends an `admin.*` audit row (on top of the
 * gate's `policy.decision` row), so the trail shows what was browsed,
 * probed, and reported — never secrets (payloads carry statuses and paths,
 * not credentials).
 *
 * Catalog browser (`catalog_browser`): lists matches from the PINNED
 * snapshots (the local registry, config/extensions) and the integrations.sh
 * catalog (via the #54 fetch-catalog helper — same seams, same fail-closed
 * errors). `draft` fetches a catalog entry and writes an UNREVIEWED draft
 * snapshot (source.reviewed: false) to config/extensions/drafts/ — drafts
 * are never installed or pinned by this tool; catalog entries carry no
 * MCP/CLI binding, so the draft result surfaces that and tells the agent to
 * web-search the vendor's OFFICIAL MCP server (issue #146) before
 * completing the binding, credential schema, and credential targets.
 * `pin` is the CHAT-NATIVE pin (issue #195): the agent completes the draft
 * IN-CHANNEL (binding/credentialSchema/credentialTargets/tools via params —
 * the space agent has no write/bash tools, so the reviewed facts come from
 * the call and the provenance comes from the draft file), the tool
 * surfaces the draft summary and REQUIRES the human's in-channel
 * confirmation (confirm: true — the confirmation IS the review: the
 * snapshot records source.reviewed: true, and an unconfirmed/unreviewed
 * draft always refuses, fail closed), writes the pinned snapshot via the
 * fetch-catalog pin flow (same review gate), and regenerates
 * config/egress.yml + config/egress.dev.yml (#53 domains — the binding
 * host is merged into the allowlist domains), and HOT-RELOADS (issue
 * #197): the snapshot registers into the LIVE
 * registry the composition root wired (#172 — new sessions see the
 * extension immediately via the #167 per-session surface refresh, no
 * restart) and the dev proxy reloads after the egress regen (the
 * boundary's POST /v1/reload with BOTTEGA_PROXY_CONTROL_URL/TOKEN); a
 * failed registration or reload is surfaced loudly in the pin result +
 * audited (fail closed — the snapshot still lands). POLICY (#49/#195):
 * official HOSTED streamable-http + OAuth
 * bindings are preferred; stdio/CLI
 * bindings pin only when the agent web-searched and verified NO official
 * hosted variant exists (no_hosted_variant: true — documented in the
 * guidance). Manifest tools are OPTIONAL (issue #158): omit them to pin a
 * tools-less manifest whose surface is discovered at runtime from the
 * provider's tools/list with conservative tiers (the agent sees the
 * provider's FULL real surface, never a hand-authored subset), or pin
 * tools explicitly via the tools param / fetch-catalog --generate-tools
 * (issue #157). The drafts dir sits OUTSIDE the registry's scan
 * (readPinnedSnapshots reads only top-level *.json), so a draft can never
 * fail the boot.
 *
 * Stack health (`stack_health`): per-service status for
 * broker/gateway/iron-proxy/mem0/executor. Compose state via
 * `docker compose ps` when docker is available; local HTTP/TCP probes
 * otherwise (in-container, the compose-internal names resolve). Any DOWN
 * service fails the result loudly with evidence (isError). The OAuth
 * callback chain (issue #271) is part of the stack: the callback listener
 * on BOTTEGA_CALLBACK_PORT and the public callback base the connect mints
 * authorize URLs at are probed like any service, so a live listener +
 * tunnel is provably up and a dead one is loud.
 *
 * Deploy info (`deploy_info`): image tag (BOTTEGA_IMAGE_TAG), git commit,
 * process uptime, config dir.
 *
 * First-run wizard (`first_run_wizard`): the guided checklist — Slack
 * tokens, model key, broker token, git PAT file (mode 0600), egress
 * allowlist, memory backend (mem0 or SQLite fallback). Each check reports
 * pass/fail with the fix instruction; any failure fails the result loudly.
 * The checklist is ONE shared source of truth (`runWizardChecks`) reused by
 * the proactive onboarding surface (issue #116): the boot-time guided post
 * (server boot, org setting `onboarding.space_id`) and the in-conversation
 * nudge (space service) both name the same failing checks with the same
 * one-line pointer (`onboardingGuideText`).
 */
import type { ExtensionFactory, AgentToolResult, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { z } from "@oh-my-pi/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ADMIN_CATALOG_BROWSER_EVENT,
  ADMIN_DEPLOY_INFO_EVENT,
  ADMIN_FIRST_RUN_EVENT,
  ADMIN_STACK_HEALTH_EVENT,
} from "../store/audit-events";
import {
  buildSnapshotDraft,
  fetchCatalogEntry,
  listCatalogEntries,
  openApiGenerationFor,
  pinSnapshotDraft,
  type CatalogEntry,
  type FetchCatalogOptions,
  type SnapshotDraft,
} from "../extensions/fetch-catalog";
import { fetchOpenApiSpec } from "../extensions/openapi-tools";
import { PROXY_SECRETS_DIR, proxyBoundaryControlFromEnv } from "../extensions/boundary";
import { runtimeSnapshotsFromStore } from "../extensions/runtime-registry";
import type {
  CliBinding,
  CredentialSchema,
  CredentialTarget,
  ExtensionKind,
  ExtensionManifest,
  ExtensionTool,
  JsonObject,
  McpBinding,
  OpenApiBinding,
} from "../extensions/manifest";
import { validateManifest } from "../extensions/manifest";
import { probeMcpEndpoint } from "../extensions/mcp-endpoint-probe";
import type { ExtensionRegistry, PinnedSnapshot, ResolvedExtension } from "../extensions/registry";
import {
  DEV_EGRESS_CONFIG_PATH,
  EGRESS_CONFIG_PATH,
  SNAPSHOTS_DIR,
  regenerateDevEgressConfig,
  regenerateEgressConfig,
} from "../egress/generate";
import type { Store } from "../store/db";
import type { AuditModule } from "../policy/audit";
import { errorMessage, toolError } from "./helpers";
// The stack-health surface (issue #73) split into admin-health.ts (issue
// #19): admin.ts imports what it uses and re-exports the externally-consumed
// names so index.ts/space-service/slack-turn-presenter/admin.test.ts importers
// stay unchanged (zero-churn split).
import { runStackHealth, stackHealthArgsSchema, type HealthProbeSeams } from "./admin-health";
export { defaultComposePs } from "./admin-health";
export type { HealthProbeSeams, ServiceStatus } from "./admin-health";

/** One wizard check result. */
export interface WizardCheck {
  name: string;
  ok: boolean;
  /** What was observed (evidence). */
  detail: string;
  /** What to do when !ok (the fix instruction). */
  fix: string;
}

export interface AdminToolsOpts {
  /** Audit module; every invocation appends an `admin.*` row. */
  audit?: Pick<AuditModule, "appendAudit">;
  /** Actor recorded on audit rows; defaults to "agent". */
  actor?: string;
  /**
   * The pinned-snapshot registry (issue #50) — the catalog browser's
   * "pinned" half, and the LIVE instance the runtime resolves against
   * (#172): `pin` registers the new snapshot into it so NEW sessions see
   * the extension immediately (no restart). Absent → no pinned entries
   * (still lists the catalog) and no live registration.
   */
  registry?: ExtensionRegistry;
  /** Catalog fetch seams (the #54 helper's own seams). */
  catalog?: FetchCatalogOptions;
  /** Where catalog drafts land. Default "config/extensions/drafts". */
  catalogDraftsDir?: string;
  /** Where the pin action writes pinned snapshots. Default "config/extensions" (SNAPSHOTS_DIR). */
  catalogSnapshotsDir?: string;
  /** Dev-permissive egress output for the pin's regeneration. Default "config/egress.dev.yml". */
  devEgressConfigPath?: string;
  /** Stack-health probe seams; defaults are the real probes. */
  health?: HealthProbeSeams;
  /** Git token file for the wizard's PAT check. Default EXECUTOR_GIT_TOKEN_FILE ?? "data/secrets/github-pat". */
  gitTokenFile?: string;
  /** Egress config path for the wizard. Default "config/egress.yml". */
  egressConfigPath?: string;
  /** Git commit resolution for deploy_info. Defaults to `git rev-parse HEAD`. */
  gitCommit?: () => string | null;
  /** Config dir for deploy_info. Defaults to BOTTEGA_CONFIG_DIR ?? process.cwd(). */
  configDir?: () => string;
}

/** Tool args: browser action + optional query/spec + the pin completion facts. */
export const catalogBrowserArgsSchema = z.object({
  action: z.enum(["list", "draft", "pin"]).default("list"),
  /** Substring filter for `list` (name/slug/id/kind/domain, case-insensitive). */
  query: z.string().optional(),
  /** Catalog slug or id (e.g. "linear", "mcp/linear") — required for `draft`; draft id — required for `pin`. */
  spec: z.string().optional(),
  /** Pin: the human's IN-CHANNEL confirmation. REQUIRED to pin — the confirmation is the review. */
  confirm: z.boolean().optional().describe("Human confirmation for the pin (required: the review gate)"),
  /** Pin: true when web-search verified NO official hosted MCP variant exists (required for stdio/CLI bindings). */
  no_hosted_variant: z
    .boolean()
    .optional()
    .describe("True when the agent verified no official hosted MCP server exists (stdio/CLI fallback)"),
  /** Pin: the completed MCP binding ({serverUrl|command, transport}) or CLI binding ({command, args?, env?}) the agent filled from vendor docs. */
  binding: z.record(z.string(), z.unknown()).optional().describe("The completed MCP/CLI binding from the vendor's official spec"),
  /** Pin: the completed credentialSchema ({type: "oauth"|"api_key", scopes?}). */
  credential_schema: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("The completed credentialSchema ({type: oauth|api_key, scopes?})"),
  /** Pin: reviewed destinations that may receive credentials ({host, pathPrefix?}). */
  credential_targets: z
    .array(z.record(z.string(), z.unknown()))
    .optional()
    .describe("Reviewed credential destinations ({host, pathPrefix?}); required by the completed manifest"),
  /** Pin: the explicit tool surface (optional — absent → runtime discovery of the provider's tools/list, issue #158). */
  tools: z
    .array(z.record(z.string(), z.unknown()))
    .optional()
    .describe("The explicit pinned tool surface (optional; omit for runtime discovery)"),
  /** Pin: additional egress domains (the binding host is always merged automatically). */
  domains: z.array(z.string()).optional().describe("Extra egress allowlist domains"),
  /** Pin: true when the binding is the vendor's OFFICIAL server (the #146 web-search determination). */
  vendor_official: z.boolean().optional().describe("True when the binding is the vendor's official server (per #146)"),
});

/** No args: identity info only. */
export const deployInfoArgsSchema = z.object({});
/** No args: the full checklist. */
export const firstRunWizardArgsSchema = z.object({});

export type AdminToolDefinition = ToolDefinition<
  typeof catalogBrowserArgsSchema | typeof stackHealthArgsSchema | typeof deployInfoArgsSchema | typeof firstRunWizardArgsSchema
>;

const CATALOG_LIST_CAP = 50;

/** A non-empty env value that does not look like a placeholder ("replace"/"…"). */
function envValue(name: string): string | null {
  const value = process.env[name];
  if (!value || value.trim() === "") return null;
  return /replace|\.\.\./i.test(value) ? null : value;
}


// ---------------------------------------------------------------------------
// Catalog browser
// ---------------------------------------------------------------------------

function pinnedMatchesQuery(entry: ResolvedExtension, needle: string): boolean {
  return [entry.manifest.id, entry.manifest.label, entry.manifest.kind, ...entry.manifest.domains].some((field) =>
    field.toLowerCase().includes(needle),
  );
}

/** One pinned extension as surfaced to the agent by the catalog browser. */
interface PinnedView {
  id: string;
  label: string;
  kind: ExtensionKind;
  domains: string[];
  reviewed: boolean;
  pinned_at: string | null;
}

function pinnedView(entry: ResolvedExtension): PinnedView {
  return {
    id: entry.manifest.id,
    label: entry.manifest.label,
    kind: entry.manifest.kind,
    domains: entry.manifest.domains,
    reviewed: entry.snapshot?.source.reviewed ?? false,
    pinned_at: entry.snapshot?.pinnedAt ?? null,
  };
}

/** The review-gate summary shape shared by the refusal and the audit trail. */
interface DraftSummary {
  id: string;
  label: string;
  kind: ExtensionKind;
  binding: McpBinding | CliBinding | OpenApiBinding | undefined;
  credential_schema: CredentialSchema | undefined;
  credential_targets: CredentialTarget[] | undefined;
  tools_count: number | null;
  /** The generated operations + tiers for an openapi entry (the review rendering, issue #345). */
  operations: Array<{ name: string; tier: string; operation: string; method: string; path: string }> | null;
  domains: string[];
  vendor_official: boolean;
  reviewed: boolean;
}

/**
 * The review-gate summary for a completed draft: everything the human must
 * see before confirming a pin (id, label, kind, binding, credential schema,
 * credential targets, tool count, domains, provenance). One source shared by
 * required refusal and the audit trail. `openApiOperations` feeds the
 * operations+tiers rendering for an openapi draft (issue #345).
 */
function draftSummary(
  draft: SnapshotDraft,
  openApiOperations: DraftSummary["operations"] = null,
): DraftSummary {
  const binding =
    draft.manifest.kind === "mcp"
      ? draft.manifest.mcp
      : draft.manifest.kind === "cli"
        ? draft.manifest.cli
        : draft.manifest.openapi;
  return {
    id: draft.manifest.id,
    label: draft.manifest.label,
    kind: draft.manifest.kind,
    binding,
    credential_schema: draft.manifest.credentialSchema,
    credential_targets: draft.manifest.credentialTargets,
    tools_count: draft.manifest.tools?.length ?? null,
    operations: openApiOperations,
    domains: draft.manifest.domains,
    vendor_official: draft.source.vendorOfficial,
    reviewed: draft.source.reviewed,
  };
}

/**
 * The binding's egress host when the binding is a hosted streamable-http
 * MCP server (the host the proxy must allowlist + inject credentials for,
 * issue #53/#195); null for stdio/CLI bindings (no remote host). Used by
 * the pin action to merge the MCP host into the allowlist domains.
 */
function hostedBindingHost(draft: SnapshotDraft): string | null {
  if (draft.manifest.kind !== "mcp" || draft.manifest.mcp === undefined || draft.manifest.mcp.transport !== "streamable-http") {
    return null;
  }
  try {
    return new URL(draft.manifest.mcp.serverUrl).host;
} catch {
        return null;
      }
    }

// ---------------------------------------------------------------------------
// First-run wizard
// ---------------------------------------------------------------------------

/** The egress allowlist is non-empty when the generated file lists domains. */
function egressAllowlistCheck(path: string): WizardCheck {
  const fix =
    "generate it: `bun run src/egress/generate.ts` (the base model endpoints are always " +
    "allowlisted; extension domains append from config/extensions snapshots)";
  if (!existsSync(path)) {
    return { name: "egress_allowlist", ok: false, detail: `${path} is missing`, fix };
  }
  const text = readFileSync(path, "utf8");
  const domainCount = text
    .split("\n")
    .filter((line) => /^\s*-\s+"?[A-Za-z0-9.*-]+"?$/.test(line.trimEnd())).length;
  if (domainCount === 0) {
    return { name: "egress_allowlist", ok: false, detail: `${path} has an empty allowlist`, fix };
  }
  return { name: "egress_allowlist", ok: true, detail: `${path}: ${domainCount} allowlisted domains`, fix: "none" };
}

function gitPatCheck(tokenFile: string, allowLoosePat: boolean): WizardCheck {
  const fix = `install the PAT there with mode 0600: install -m 0600 <pat> ${tokenFile} (never env/image)`;
  if (!existsSync(tokenFile)) {
    return { name: "git_pat", ok: false, detail: `${tokenFile} does not exist`, fix };
  }
  const mode = statSync(tokenFile).mode & 0o777;
  if (mode !== 0o600) {
    if (allowLoosePat) {
      return {
        name: "git_pat",
        ok: true,
        detail: `${tokenFile} exists, mode ${mode.toString(8)} (allow_loose_pat set — local dev override)`,
        fix: "reset to 0600 before production",
      };
    }
    return { name: "git_pat", ok: false, detail: `${tokenFile} exists but mode is ${mode.toString(8)}, not 0600`, fix };
  }
  return { name: "git_pat", ok: true, detail: `${tokenFile} exists, mode 0600`, fix: "none" };
}

function memoryBackendCheck(store: Store): WizardCheck {
  const baseUrl = store.getOrgSettings()?.memoryBackend?.baseUrl?.trim();
  if (baseUrl) {
    return {
      name: "memory_backend",
      ok: true,
      detail: `mem0 backend configured (memory_backend.base_url ${baseUrl})`,
      fix: "none",
    };
  }
  return {
    name: "memory_backend",
    ok: true,
    detail: "no memory_backend.base_url setting — SQLite fallback (in-process, no extra setup)",
    fix: "none",
  };
}

/**
 * The shared first-run checklist (issue #116): ONE source of truth for the
 * `first_run_wizard` tool, the boot-time onboarding guide (src/server/
 * index.ts), and the in-conversation nudge (space-service.ts). Runs every
 * check and returns the full report; the path defaults mirror the wizard
 * tool's (opts override them for tests/hermeticity).
 */
export function runWizardChecks(
  store: Store,
  opts: Pick<AdminToolsOpts, "gitTokenFile" | "egressConfigPath"> = {},
): WizardCheck[] {
  const slackApp = envValue("SLACK_APP_TOKEN");
  const slackBot = envValue("SLACK_BOT_TOKEN");
  const proxySecretsDir = process.env.BOTTEGA_PROXY_SECRETS_DIR ?? PROXY_SECRETS_DIR;
  const modelKey = ["opencode.secret", "near.secret"].some((file) => {
    const path = resolve(proxySecretsDir, file);
    return existsSync(path) && statSync(path).size > 0;
  });
  const brokerToken = envValue("OMP_AUTH_BROKER_TOKEN");
  const settings = store.getOrgSettings();
  const tokenFile = opts.gitTokenFile ?? process.env.EXECUTOR_GIT_TOKEN_FILE ?? "data/secrets/github-pat";
  return [
    slackApp && slackBot
      ? { name: "slack_tokens", ok: true, detail: "SLACK_APP_TOKEN and SLACK_BOT_TOKEN are set", fix: "none" }
      : {
          name: "slack_tokens",
          ok: false,
          detail: `SLACK_APP_TOKEN set: ${slackApp !== null}, SLACK_BOT_TOKEN set: ${slackBot !== null}`,
          fix: "create the Slack app from slack-app-manifest.yml, then provision the tokens into the auth-broker vault (connect_upload_link: slack-app / slack-bot) or set them in .env",
        },
    modelKey
      ? { name: "model_key", ok: true, detail: "iron-proxy has a model gateway credential", fix: "none" }
      : {
          name: "model_key",
          ok: false,
          detail: "iron-proxy has neither opencode.secret nor near.secret",
          fix: "provision the auth-broker vault (connect_upload_link: opencode / near) or configure the macOS Keychain fallback, then restart so the proxy boundary is seeded",
        },
    brokerToken
      ? { name: "broker_token", ok: true, detail: "OMP_AUTH_BROKER_TOKEN is set", fix: "none" }
      : {
          name: "broker_token",
          ok: false,
          detail: "OMP_AUTH_BROKER_TOKEN is not set (or a placeholder)",
          fix: "copy the broker token once: `docker compose exec auth-broker cat /data/.omp/auth-broker.token` → OMP_AUTH_BROKER_TOKEN in .env",
        },
    gitPatCheck(tokenFile, settings?.allowLoosePat ?? false),
    egressAllowlistCheck(opts.egressConfigPath ?? "config/egress.yml"),
    memoryBackendCheck(store),
  ];
}

/**
 * One-line onboarding pointer (issue #116): names the failing checks and
 * points at the first-run wizard. Shared by the boot-time guided post and
 * the in-conversation nudge — one wording, one source of truth.
 */
export function onboardingGuideText(failing: WizardCheck[]): string {
  const names = failing.map((c) => c.name).join(", ");
  return `Setup is incomplete — missing: ${names}. Run the \`first_run_wizard\` tool to see the full checklist.`;
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

/**
 * The admin tools as SDK {@link ToolDefinition}s (issue #73): one source
 * shared by the in-session extension surface and the driver's gatedTools
 * path (issue #69) — restricted SDK sessions drop extension-registered
 * tools, so these ride the custom-tools bridge like the settings/memory
 * tools.
 */
export function adminToolDefinitions(store: Store, opts: AdminToolsOpts = {}): ToolDefinition[] {
  const actor = opts.actor ?? "agent";
  const audit = opts.audit;
  const catalogOpts: FetchCatalogOptions = opts.catalog ?? {};
  const draftsDir = opts.catalogDraftsDir ?? "config/extensions/drafts";
  const snapshotsDir = opts.catalogSnapshotsDir ?? SNAPSHOTS_DIR;
  const egressPath = opts.egressConfigPath ?? EGRESS_CONFIG_PATH;
  const devEgressPath = opts.devEgressConfigPath ?? DEV_EGRESS_CONFIG_PATH;

  const catalogBrowser: ToolDefinition<typeof catalogBrowserArgsSchema> = {
    name: "catalog_browser",
    label: "Browse the extension catalog",
    description:
      "Lists available extensions, drafts new ones, and PINS a completed draft in-channel (issue #195). " +
      "`list` (default) matches the query (name/slug/id/kind/domain substring, case-insensitive; no query = " +
      "everything) against the PINNED snapshots (config/extensions) and the integrations.sh catalog; the catalog " +
      "is capped at 50 matches with a truncated flag. `draft` requires `spec` (catalog slug or id, e.g. " +
      "\"linear\") and writes an UNREVIEWED draft snapshot (source.reviewed: false) to " +
      "config/extensions/drafts/<id>.draft.json — it is NEVER installed or pinned by this action. Catalog " +
      "entries carry no MCP/CLI binding, so when drafting one, web-search the vendor's OFFICIAL MCP server " +
      "(serverUrl + transport + credentialSchema + reviewed credentialTargets from the vendor's published MCP " +
      "spec; vendor-official URLs only — never guess or use community URLs). `pin` completes the draft " +
      "IN-CHANNEL and REQUIRES the human's confirmation (the review gate): pass `spec` + the completed `binding` / " +
      "`credential_schema` / `credential_targets` (+ optional `tools` / `domains` / `vendor_official`) and FIRST " +
      "call WITHOUT confirm to surface the draft " +
      "summary, then " +
      "call WITH confirm=true after the human confirms in-channel — the confirmation IS the review, the snapshot " +
      "records source.reviewed: true, the pinned snapshot is written to config/extensions via the fetch-catalog " +
      "pin flow (same review gate: unconfirmed/unreviewed drafts always refuse, fail closed), and " +
      "config/egress.yml + config/egress.dev.yml regenerate (the binding host is merged into the allowlist " +
      "domains) and the pin HOT-RELOADS (issue #197): the snapshot registers into the LIVE " +
      "registry (new sessions see the extension without a restart) and the dev proxy reloads after the egress regen " +
      "(BOTTEGA_PROXY_CONTROL_URL/TOKEN — the boundary's mechanism); a failed registration or reload surfaces " +
      "loudly in the result (fail closed — the snapshot still lands). POLICY (issue #49/#195): prefer official " +
      "HOSTED streamable-http + OAuth bindings (the broker " +
      "handles the OAuth flow — no binaries, no API keys); stdio/CLI bindings pin only when web-search verified " +
      "NO official hosted variant exists (no_hosted_variant: true). Manifest tools are OPTIONAL (issue #158): " +
      "omit them to pin a tools-less manifest whose surface is discovered at runtime from the provider's " +
      "tools/list with conservative tiers (the default — the agent then sees the provider's FULL real surface), " +
      "or pass `tools` explicitly. Write-tier: prompts for approval in non-yolo modes (admin-gated like the " +
      "settings tool).",
    parameters: catalogBrowserArgsSchema,
    approval: "write",
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx): Promise<AgentToolResult> {
      try {
        if (params.action === "draft") {
          if (!params.spec || !params.spec.trim()) {
            return toolError('catalog_browser draft requires `spec` (e.g. "linear")');
          }
          const entry = await fetchCatalogEntry(params.spec.trim(), catalogOpts);
          const draft = buildSnapshotDraft(entry);
          // The catalog record carries no MCP/CLI binding (issue #146): the
          // agent must research the vendor's official server before completing.
          // An OPENAPI entry's binding is self-contained (spec URL + auth
          // scheme from the catalog's `openapi` block, issue #345), so its
          // draft is not "binding-missing" — only the frozen surface remains
          // to be generated at pin time.
          const bindingMissing =
            draft.manifest.kind === "openapi"
              ? draft.manifest.openapi === undefined
              : draft.manifest.mcp === undefined && draft.manifest.cli === undefined;
          const isOpenApi = draft.manifest.kind === "openapi";
          mkdirSync(draftsDir, { recursive: true });
          const outPath = resolve(draftsDir, `${draft.extensionId}.draft.json`);
          writeFileSync(outPath, JSON.stringify(draft, null, 2) + "\n");
          await audit?.appendAudit({
            actor,
            event_type: ADMIN_CATALOG_BROWSER_EVENT,
            payload: { action: "draft", spec: params.spec.trim(), written_to: outPath },
          });
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  action: "draft",
                  spec: params.spec.trim(),
                  written_to: outPath,
                  reviewed: false,
                  binding_missing: bindingMissing,
                  note: isOpenApi
                    ? "DRAFT — not installed. This is an API-first vendor (kind openapi): its OpenAPI spec URL + " +
                      "static auth scheme (bearer/apiKeyHeader) come from the catalog's `openapi` block, so no " +
                      "binding research is needed. Complete the draft IN-CHANNEL: call catalog_browser action=pin " +
                      "spec=<id> (the pin fetches the vendor's spec once, generates the tool surface, and the " +
                      "REVIEW shows the generated operations + tiers), then ASK THE HUMAN to confirm in-channel " +
                      "(confirm=true) — the confirmation is the review that pins — then connect_extension " +
                      '("connect as me / as org" provisions the static API key via the one-time upload link; the ' +
                      "key is injected at egress by iron-proxy, never held by the agent)."
                    : bindingMissing
                      ? "DRAFT — not installed. This catalog entry has NO MCP/CLI binding: research the " +
                        "vendor's OFFICIAL MCP server via web_search before completing the draft — " +
                        "serverUrl + transport + credentialSchema from the vendor's published MCP " +
                        "spec; vendor-official URLs only, do NOT guess or use community URLs. PREFER the " +
                        "official HOSTED streamable-http server with OAuth (policy #49/#195 — no binaries, " +
                        "the broker handles the OAuth flow); stdio/API-key only when no hosted variant " +
                        "exists. Complete the draft IN-CHANNEL: call catalog_browser action=pin spec=<id> " +
                        "with the binding + credential_schema + credential_targets (+ optional tools) params, then " +
                        "ASK THE HUMAN to confirm in-channel (confirm=true) — the confirmation is the review that " +
                        "pins — then connect_extension (\"connect as me\" opens the OAuth flow). Manifest " +
                        "tools are OPTIONAL (issue #158): omit them to pin a tools-less manifest whose " +
                        "surface is discovered at runtime from the provider's tools/list with " +
                        "conservative tiers (the agent then sees the provider's FULL surface), or run " +
                        "`bun run src/extensions/fetch-catalog.ts --generate-tools <draft.json>` to pin " +
                        "tools explicitly."
                      : "DRAFT — not installed. Complete the manifest binding (mcp/cli), credentialSchema, and " +
                        "credentialTargets from the vendor docs IN-CHANNEL: call catalog_browser action=pin spec=<id> with " +
                        "the binding + credential_schema + credential_targets (+ optional tools) params, then ASK THE HUMAN to confirm " +
                        "in-channel (confirm=true) — the confirmation is the review that pins — then " +
                        "connect_extension (\"connect as me\" opens the OAuth flow for oauth extensions). " +
                        "PREFER the official HOSTED streamable-http + OAuth server (policy #49/#195); " +
                        "stdio/API-key only when no hosted variant exists. Manifest tools are OPTIONAL " +
                        "(issue #158) — omit them for runtime discovery of the provider's tools/list surface " +
                        "with conservative tiers, or pin tools explicitly via fetch-catalog --generate-tools.",
                  draft,
                }),
              },
            ],
          };
        }
        if (params.action === "pin") {
          if (!params.spec || !params.spec.trim()) {
            return toolError('catalog_browser pin requires `spec` (the draft id, e.g. "notion")');
          }
          const draftPath = resolve(draftsDir, `${params.spec.trim()}.draft.json`);
          if (!existsSync(draftPath)) {
            return toolError(
              `no draft for "${params.spec.trim()}" at ${draftPath} — draft it first ` +
                `(catalog_browser action=draft spec=${params.spec.trim()})`,
            );
          }
          let draft: SnapshotDraft;
          try {
            // SAFETY: the draft file is JSON written by fetch-catalog's
            // own buildSnapshotDraft writer, and validateManifest below is
            // the authority on the merged shape (fail closed) before any
            // side effect — the cast only scaffolds the in-channel merge.
            draft = JSON.parse(readFileSync(draftPath, "utf8")) as SnapshotDraft;
          } catch {
            return toolError(`draft at ${draftPath} is not valid JSON`);
          }
          // The agent completes the draft IN-CHANNEL (the space agent has no
          // write/bash tools): merge the pin params into the draft's
          // provenance scaffold. The strict manifest validation below is the
          // authority on the merged shape.
          const isOpenApi = draft.manifest.kind === "openapi";
          // Openapi operation+tier rendering for the review gate (issue #345);
          // null for MCP/CLI pins.
          let openApiOperations: DraftSummary["operations"] = null;
          const manifest = { ...draft.manifest };
          if (draft.manifest.kind === "mcp") {
            if (params.binding !== undefined) {
              // SAFETY: the merged manifest is re-validated by validateManifest
              // below (fail closed) before any write or registration; the params
              // arrive zod-validated from the tool args schema, and the JSON
              // round-trip keeps the validator's JSON-domain contract.
              manifest.mcp = JSON.parse(JSON.stringify(params.binding)) as McpBinding;
            }
          } else if (isOpenApi) {
            // An openapi pin (issue #345) does NOT take a human-filled MCP/CLI
            // binding: the spec URL + static auth scheme come from the
            // catalog's `openapi` block (already in the draft's manifest). The
            // frozen tool surface is generated from the vendor's spec at pin
            // time — fetched ONCE, validated, FROZEN (the runtime never
            // re-fetches), exactly like a reviewed MCP pin.
            const openApi = draft.manifest.openapi;
            if (openApi === undefined) {
              return toolError(
                `draft for "${draft.extensionId}" (kind openapi) is missing its "openapi" block (spec URL + auth ` +
                  "scheme) — re-draft it from the catalog before pinning.",
              );
            }
            const specUrl = openApi.specUrl;
            if (!specUrl.toLowerCase().startsWith("https://")) {
              return toolError(`refusing to pin "${draft.extensionId}": the OpenAPI spec URL must be HTTPS (got "${specUrl}")`);
            }
            // Re-fetch the catalog entry so the `openapi` block's optional
            // operations curation is honored (the same lookup the connect
            // path uses).
            let entry: CatalogEntry;
            try {
              entry = await fetchCatalogEntry(draft.extensionId, catalogOpts);
            } catch (err) {
              return toolError(`refusing to pin "${draft.extensionId}": ${errorMessage(err)}`);
            }
            let spec: JsonObject;
            try {
              spec = await fetchOpenApiSpec(specUrl, catalogOpts.fetchImpl);
            } catch (err) {
              return toolError(`refusing to pin "${draft.extensionId}": ${errorMessage(err)}`);
            }
            let review;
            try {
              review = openApiGenerationFor(entry, spec);
            } catch (err) {
              return toolError(`refusing to pin "${draft.extensionId}": ${errorMessage(err)}`);
            }
            // SAFETY: openApiGenerationFor refuses to return (throws) for any
            // non-openapi entry (it checks `entry.kind !== "openapi"` first),
            // so the manifest it produced is ALWAYS the openapi-kind variant —
            // the Extract narrowing is exact, never a guess.
            const frozenOpenApi = review.manifest as Extract<ExtensionManifest, { kind: "openapi" }>;
            manifest.kind = "openapi";
            manifest.tools = frozenOpenApi.tools;
            manifest.domains = frozenOpenApi.domains;
            manifest.credentialSchema = frozenOpenApi.credentialSchema;
            manifest.credentialTargets = frozenOpenApi.credentialTargets;
            manifest.openapi = frozenOpenApi.openapi;
            openApiOperations = review.operations.map((op) => ({
              name: op.name,
              tier: op.tier,
              operation: op.operationId,
              method: op.method,
              path: op.path,
            }));
          } else if (params.binding !== undefined) {
            // SAFETY: same invariant as the mcp branch — validateManifest is
            // the fail-closed authority on the binding before any side effect.
            manifest.cli = JSON.parse(JSON.stringify(params.binding)) as CliBinding;
          }
          if (params.credential_schema !== undefined) {
            // SAFETY: validateManifest below is the fail-closed authority on
            // credentialSchema before any write or registration.
            manifest.credentialSchema = JSON.parse(JSON.stringify(params.credential_schema)) as CredentialSchema;
          }
          if (params.credential_targets !== undefined) {
            // SAFETY: validateManifest below is the fail-closed authority on
            // credentialTargets before any write or registration.
            manifest.credentialTargets = JSON.parse(
              JSON.stringify(params.credential_targets),
            ) as CredentialTarget[];
          }
          if (params.tools !== undefined) {
            // SAFETY: validateManifest below is the fail-closed authority on
            // the tool surface before any write or registration.
            manifest.tools = JSON.parse(JSON.stringify(params.tools)) as ExtensionTool[];
          }
          // The egress allowlist must include the binding host (the proxy
          // allowlists + injects credentials per domain, issue #53) — merge
          // the MCP host in, keep the scaffold/extra domains, deduped. An
          // openapi pin's allowlist comes from the spec's HTTPS servers
          // (already FROZEN); only explicit `domains` extras append.
          const mergedDraft: SnapshotDraft = { ...draft, manifest };
          const host = isOpenApi ? null : hostedBindingHost(mergedDraft);
          manifest.domains = isOpenApi
            ? [...new Set<string>([...manifest.domains, ...(params.domains ?? [])])]
            : [
                ...new Set<string>([
                  ...(params.domains ?? draft.manifest.domains),
                  ...(host !== null ? [host] : []),
                ]),
              ];
          const completed: SnapshotDraft = {
            ...mergedDraft,
            source: {
              ...draft.source,
              ...(params.vendor_official !== undefined ? { vendorOfficial: params.vendor_official } : undefined),
            },
          };
          // Fail closed BEFORE the review gate: an incomplete draft (missing
          // the binding, credentialSchema, or reviewed credentialTargets) or
          // a malformed manifest must never reach the human's confirmation.
          // An openapi pin's binding/schema/targets come from the FROZEN
          // manifest generated above (never the human's in-channel merge).
          const needsBinding = isOpenApi
            ? manifest.openapi === undefined
            : completed.manifest.kind === "mcp"
              ? completed.manifest.mcp === undefined
              : completed.manifest.cli === undefined;
          if (
            needsBinding ||
            completed.manifest.credentialSchema === undefined ||
            completed.manifest.credentialTargets === undefined
          ) {
            return toolError(
              `draft for "${completed.extensionId}" is incomplete: add the ${completed.manifest.kind} binding, ` +
                "credentialSchema, and credentialTargets from the vendor docs (web-search the vendor's OFFICIAL MCP spec per #146) " +
                "before pinning; manifest tools are OPTIONAL (issue #158) — omit them to discover the surface at " +
                "runtime from the provider's tools/list with conservative tiers, or pass them via the tools param.",
            );
          }
          try {
            validateManifest(JSON.parse(JSON.stringify(completed.manifest)));
          } catch (err) {
            return toolError(errorMessage(err));
          }
          // Hosted-vs-stdio policy (#49/#195): official hosted
          // streamable-http + OAuth is preferred; stdio/CLI bindings are the
          // no-hosted-variant fallback and pin only when the agent's
          // web-search verified no official hosted server exists. Openapi
          // pins (issue #345) are an API-first surface — no hosted-MCP
          // variant policy applies (the spec's servers are the allowlist).
          const hosted = host !== null;
          if (!isOpenApi && !hosted && params.no_hosted_variant !== true) {
            return toolError(
              `refusing to pin "${params.spec.trim()}": the binding is NOT an official hosted streamable-http MCP ` +
                "server (policy #195/#49 prefers hosted MCP + OAuth — no binaries, the broker handles the OAuth " +
                `flow). Draft summary: ${JSON.stringify(draftSummary(completed))}. Only pin a stdio/CLI binding ` +
                "when web-search verified NO official hosted variant exists — then confirm with " +
                "no_hosted_variant: true.",
            );
          }
          // Issue #286 — THE ENDPOINT VALIDATION PROBE. A hosted
          // streamable-http binding's exact serverUrl is probed with a raw
          // JSON-RPC initialize BEFORE the human's review gate: nothing pins
          // an endpoint the probe cannot prove speaks MCP (or returns a
          // standards-compliant Bearer challenge). HTTPS-only, redirects
          // never followed, no credentials sent — a rejected endpoint is a
          // loud refusal with the probe evidence, no snapshot, no egress
          // regen, no hot-register, and an auditable pin_refused row.
          if (!isOpenApi && hosted && completed.manifest.mcp !== undefined && completed.manifest.mcp.transport === "streamable-http") {
            const mcpBinding = completed.manifest.mcp;
            const verdict = await probeMcpEndpoint(mcpBinding.serverUrl, { fetchImpl: catalogOpts.fetchImpl });
            if (!verdict.ok) {
              await audit?.appendAudit({
                actor,
                event_type: ADMIN_CATALOG_BROWSER_EVENT,
                payload: {
                  action: "pin_refused",
                  spec: params.spec.trim(),
                  reason: "mcp_validation_probe_failed",
                  endpoint: mcpBinding.serverUrl,
                  evidence: verdict.evidence,
                },
              });
              return toolError(
                `refusing to pin "${params.spec.trim()}": the binding endpoint ${mcpBinding.serverUrl} failed the ` +
                  `MCP validation probe (${verdict.evidence}); no snapshot was written and egress is unchanged. ` +
                  "Provide the vendor's official endpoint (web-search the vendor's OFFICIAL MCP spec per #146) and " +
                  "pin again — the probe must see a valid MCP initialize response or a standards-compliant Bearer " +
                  "challenge.",
              );
            }
          }
          // THE REVIEW GATE: the tool surfaces the draft summary and the
          // human must confirm in-channel. Nothing pins without the
          // confirmation — unconfirmed/unreviewed drafts always refuse
          // (fail closed).
          if (params.confirm !== true) {
            return toolError(
              JSON.stringify({
                action: "pin",
                spec: params.spec.trim(),
                confirm_required: true,
                hosted_variant: hosted,
                summary: draftSummary(completed, openApiOperations),
                note:
                  `REVIEW REQUIRED — nothing was pinned. The human must confirm this draft in-channel before it ` +
                  `pins. To confirm, call catalog_browser again with action=pin spec=${params.spec.trim()} ` +
                  "confirm=true — the confirmation IS the review (the snapshot records source.reviewed: true). " +
                  `Then connect the account: connect_extension extension=${params.spec.trim()} scope=personal ` +
                  '("connect as me" — opens the OAuth flow for oauth extensions) or scope=org (org account, needs ' +
                  "approval).",
              }),
            );
          }
          try {
            // The confirmation is the human review: unreviewed/community
            // drafts pin AS reviewed — never without it.
            const reviewed: SnapshotDraft = {
              ...completed,
              source: { ...completed.source, reviewed: true },
            };
            mkdirSync(snapshotsDir, { recursive: true });
            const outPath = await pinSnapshotDraft(reviewed, snapshotsDir, catalogOpts);
            // SUPERSET regen (issue #250): the runtime-registry rows join
            // the committed pins, so a pin for one extension never drops
            // another provider's allowlist entry from egress (the 16:29
            // regen clobber). A malformed runtime row is a LOUD
            // skip — never a pin failure (the #205 posture): the regen
            // proceeds on the committed-only set and surfaces the warning.
            let runtimeSet: PinnedSnapshot[] = [];
            let runtimeSetWarning: string | undefined;
            try {
              runtimeSet = await runtimeSnapshotsFromStore(store);
            } catch (err) {
              runtimeSetWarning = `EGRESS REGEN SKIPPED MALFORMED RUNTIME ROW — the egress config regenerated with the committed ` +
                `pins only, so a previously runtime-registered provider may be missing from egress: ${errorMessage(err)}`;
            }
            // regenerateEgressConfig returns the rendered YAML; the paths are
            // what the caller and the audit trail need.
            regenerateEgressConfig(snapshotsDir, egressPath, runtimeSet);
            regenerateDevEgressConfig(snapshotsDir, devEgressPath, runtimeSet);
            // HOT-RELOAD (issue #197): the registry the composition root
            // wired is the LIVE instance the runtime resolves against (#172). Register the new snapshot into it so
            // NEW sessions resolve the extension immediately through the
            // per-session surface refresh (#167) — NO restart. Fail closed: a
            // failed registration surfaces loudly in the result and the audit
            // row, and the snapshot file already landed (never rolled back).
            // Re-pinning an already-live extension is idempotent (resolve →
            // already registered); absent registry → nothing to register (the
            // catalog's "pinned" half stays list-only, like the boot).
            let liveRegistry: "registered" | "failed" | "absent" = "absent";
            let liveError: string | undefined;
            if (opts.registry !== undefined) {
              if (opts.registry.resolve(reviewed.extensionId) !== undefined) {
                liveRegistry = "registered";
              } else {
                try {
                  const manifest = validateManifest(JSON.parse(JSON.stringify(reviewed.manifest)));
                  const snapshot: PinnedSnapshot = {
                    schema: reviewed.schema,
                    extensionId: reviewed.extensionId,
                    pinnedAt: reviewed.pinnedAt,
                    source: reviewed.source,
                    manifest,
                  };
                  opts.registry.register(manifest, snapshot);
                  liveRegistry = "registered";
                } catch (err) {
                  liveRegistry = "failed";
                  liveError = errorMessage(err);
                }
              }
            }
            // HOT-RELOAD: the egress regen changed the allowlist/inject rules
            // — trigger the proxy reload (the boundary's existing mechanism,
            // issue #123: POST /v1/reload with the management token) so the
            // new domains apply immediately. Unset control URL (unconfigured
            // deployments, hermetic tests) → write-only, like the boundary.
            const control = proxyBoundaryControlFromEnv();
            /** The proxy reload attempt result (ok, or the error evidence). */
            interface ProxyReloadResult {
              ok: boolean;
              error?: string;
            }
            const reload: ProxyReloadResult = { ok: false };
            if (control.proxyControlUrl !== undefined) {
              try {
                const res = await fetch(`${control.proxyControlUrl}/v1/reload`, {
                  method: "POST",
                  headers:
                    control.proxyControlToken !== undefined
                      ? { Authorization: `Bearer ${control.proxyControlToken}` }
                      : undefined,
                });
                if (!res.ok) throw new Error(`proxy reload failed (${res.status})`);
                reload.ok = true;
              } catch (err) {
                reload.error = errorMessage(err);
              }
            }
            const proxyReload: "ok" | "failed" | "unset" =
              control.proxyControlUrl === undefined ? "unset" : reload.ok ? "ok" : "failed";
            const hotReloadWarnings: string[] = [];
            if (runtimeSetWarning !== undefined) hotReloadWarnings.push(runtimeSetWarning);
            if (liveRegistry === "failed") {
              hotReloadWarnings.push(
                `LIVE REGISTRY REGISTRATION FAILED — the snapshot landed, but this server's runtime won't see ` +
                  `"${params.spec.trim()}" until a restart: ${liveError}`,
              );
            }
            if (proxyReload === "failed") {
              hotReloadWarnings.push(
                `PROXY RELOAD FAILED — the egress config regenerated, but the dev proxy is still serving the OLD ` +
                  `allowlist until a reload/restart: ${reload.error}`,
              );
            }
            await audit?.appendAudit({
              actor,
              event_type: ADMIN_CATALOG_BROWSER_EVENT,
              payload: {
                action: "pin",
                spec: params.spec.trim(),
                written_to: outPath,
                egress_config: egressPath,
                hosted_variant: hosted,
                no_hosted_variant: params.no_hosted_variant === true,
                vendor_official: reviewed.source.vendorOfficial,
                live_registry: liveRegistry,
                ...(liveError !== undefined ? { live_error: liveError } : undefined),
                proxy_reload: proxyReload,
                ...(reload.error !== undefined ? { proxy_reload_error: reload.error } : undefined),
              },
            });
            /** The pin result the tool reports back to the agent. */
            interface PinResult {
              action: string;
              spec: string;
              written_to: string;
              reviewed: boolean;
              hosted_variant: boolean;
              egress_regenerated: string[];
              live_registry: "registered" | "failed" | "absent";
              proxy_reload: "ok" | "failed" | "unset";
              warnings?: string[];
              note?: string;
            }
            const result: PinResult = {
              action: "pin",
              spec: params.spec.trim(),
              written_to: outPath,
              reviewed: true,
              hosted_variant: hosted,
              egress_regenerated: [egressPath, devEgressPath],
              live_registry: liveRegistry,
              proxy_reload: proxyReload,
            };
            const note =
              `PINNED — "${params.spec.trim()}" is installed, its domains are egress allowlisted, and it is live ` +
              `in the running server (no restart). Connect the account to use it: call connect_extension ` +
              `extension=${params.spec.trim()} scope=personal ("connect as me" — the OAuth flow opens for oauth ` +
              "extensions) or scope=org (the org account, needs human approval). api_key extensions need the " +
              "api_key param.";
            if (hotReloadWarnings.length > 0) {
              // Fail closed: the snapshot still landed, but a failed
              // registration/reload is LOUD — the agent must not assume the
              // new domains are being served.
              result["warnings"] = hotReloadWarnings;
              result["note"] =
                `${note} HOT-RELOAD WARNING${hotReloadWarnings.length > 1 ? "S" : ""}: ${hotReloadWarnings.join(" ")} ` +
                "The snapshot and egress config are on disk; a restart (or manual proxy reload) is needed for " +
                "the running server to serve them.";
              return toolError(JSON.stringify(result));
            }
            result["note"] = note;
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(result),
                },
              ],
            };
          } catch (err) {
            return toolError(errorMessage(err));
          }
        }
        const pinned = opts.registry?.list() ?? [];
        const needle = params.query?.trim().toLowerCase() ?? "";
        const pinnedMatches = needle ? pinned.filter((entry) => pinnedMatchesQuery(entry, needle)) : pinned;
        const catalogResult = await listCatalogEntries(params.query, catalogOpts);
        const catalogEntries = catalogResult.entries;
        const catalogSkipped = catalogResult.skipped;
        const truncated = catalogEntries.length > CATALOG_LIST_CAP;
        await audit?.appendAudit({
          actor,
          event_type: ADMIN_CATALOG_BROWSER_EVENT,
          payload: {
            action: "list",
            query: params.query ?? null,
            pinned_matches: pinnedMatches.length,
            catalog_matches: truncated ? CATALOG_LIST_CAP : catalogEntries.length,
            catalog_truncated: truncated,
            catalog_skipped: catalogSkipped.length,
          },
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                action: "list",
                query: params.query ?? null,
                pinned: pinnedMatches.map(pinnedView),
                catalog: catalogEntries.slice(0, CATALOG_LIST_CAP).map((entry) => ({
                  id: entry.id,
                  slug: entry.slug,
                  name: entry.name,
                  kind: entry.kind,
                  domain: entry.domain,
                  ...(entry.url !== undefined ? { url: entry.url } : undefined),
                  ...(entry.description !== undefined ? { description: entry.description } : undefined),
                  // Surfacing the openapi block (spec URL + static auth scheme)
                  // so an API-first vendor's pin facts are visible inline (issue #345).
                  ...(entry.openapi !== undefined
                    ? {
                        openapi: {
                          url: entry.openapi.url,
                          ...(entry.openapi.operations !== undefined
                            ? { operations: entry.openapi.operations }
                            : undefined),
                          auth: {
                            scheme: entry.openapi.auth.scheme,
                            ...(entry.openapi.auth.headerName !== undefined
                              ? { headerName: entry.openapi.auth.headerName }
                              : undefined),
                            ...(entry.openapi.auth.credentialLabel !== undefined
                              ? { credentialLabel: entry.openapi.auth.credentialLabel }
                              : undefined),
                          },
                        },
                      }
                    : undefined),
                })),
                catalog_truncated: truncated,
                // Compact skipped diagnostics: total count + up to 3 examples,
                // never the full wall (issue #118).
                catalog_skipped: {
                  count: catalogSkipped.length,
                  ...(catalogSkipped.length > 0
                    ? { examples: catalogSkipped.slice(0, 3).map((s) => ({ spec_id: s.specId, reason: s.reason })) }
                    : undefined),
                },
              }),
            },
          ],
        };
      } catch (err) {
        return toolError(errorMessage(err));
      }
    },
  };

  const stackHealth: ToolDefinition<typeof stackHealthArgsSchema> = {
    name: "stack_health",
    label: "Check stack health",
    description:
      "Reports per-service status for broker, gateway, iron-proxy, mem0, executor, and the OAuth " +
      "callback chain (issue #271: the callback listener on BOTTEGA_CALLBACK_PORT + the public " +
      "callback base the connect mints authorize URLs at): compose " +
      "state via `docker compose ps` when docker is available, local HTTP/TCP probes otherwise " +
      "(in-container the compose-internal names resolve). Every service carries evidence (state or " +
      "probe result); any DOWN service fails the result loudly (the tool result is an error with " +
      "the full report). Write-tier: prompts for approval in non-yolo modes (admin-gated).",
    parameters: stackHealthArgsSchema,
    approval: "write",
    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx): Promise<AgentToolResult> {
      try {
        const services = await runStackHealth(store, opts);
        // Fail loudly on DOWN (probe evidence of a dead service); UNKNOWN
        // (no probe possible, e.g. the executor without docker access)
        // reports honestly without failing the reachable verdict.
        const ok = services.every((s) => s.status !== "down");
        await audit?.appendAudit({
          actor,
          event_type: ADMIN_STACK_HEALTH_EVENT,
          payload: { ok, services: services.map((s) => ({ service: s.service, status: s.status })) },
        });
        const text = JSON.stringify({ ok, services });
        return ok ? { content: [{ type: "text", text }] } : toolError(text);
      } catch (err) {
        return toolError(errorMessage(err));
      }
    },
  };

  const deployInfo: ToolDefinition<typeof deployInfoArgsSchema> = {
    name: "deploy_info",
    label: "Version and deploy info",
    description:
      "Deployment identity: image tag (BOTTEGA_IMAGE_TAG env; null when unset), git commit sha " +
      "(git rev-parse HEAD; null when the deployment has no git metadata), process uptime in " +
      "seconds, and the config dir (BOTTEGA_CONFIG_DIR, else the working directory). Read-tier — " +
      "available to anyone.",
    parameters: deployInfoArgsSchema,
    approval: "read",
    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx): Promise<AgentToolResult> {
      try {
        const imageTag = process.env.BOTTEGA_IMAGE_TAG?.trim() || null;
        const commit = (opts.gitCommit ?? defaultGitCommit)();
        const uptimeSeconds = Math.round(process.uptime());
        const configDir = (opts.configDir ?? (() => process.env.BOTTEGA_CONFIG_DIR ?? process.cwd()))();
        await audit?.appendAudit({
          actor,
          event_type: ADMIN_DEPLOY_INFO_EVENT,
          payload: { image_tag: imageTag, commit, uptime_seconds: uptimeSeconds, config_dir: configDir },
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                image_tag: imageTag,
                commit,
                uptime_seconds: uptimeSeconds,
                config_dir: configDir,
              }),
            },
          ],
        };
      } catch (err) {
        return toolError(errorMessage(err));
      }
    },
  };

  const firstRunWizard: ToolDefinition<typeof firstRunWizardArgsSchema> = {
    name: "first_run_wizard",
    label: "First-run setup checklist",
    description:
      "Runs the first-run onboarding checklist: slack_tokens (SLACK_APP_TOKEN/SLACK_BOT_TOKEN set), " +
      "model_key (OPENCODE_API_KEY or NEAR_API_KEY resolvable), broker_token " +
      "(OMP_AUTH_BROKER_TOKEN set), git_pat (PAT file exists, mode 0600; the org setting " +
      "allow_loose_pat is a local-dev override), egress_allowlist (config/egress.yml lists domains), " +
      "memory_backend (mem0 configured via memory_backend.base_url, or the SQLite fallback). Every " +
      "check reports pass/fail with the fix instruction; any failure fails the result loudly with " +
      "the full report. Write-tier: prompts for approval in non-yolo modes (admin-gated).",
    parameters: firstRunWizardArgsSchema,
    approval: "write",
    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx): Promise<AgentToolResult> {
      try {
        const checks = runWizardChecks(store, opts);
        const okCount = checks.filter((c) => c.ok).length;
        const allOk = okCount === checks.length;
        await audit?.appendAudit({
          actor,
          event_type: ADMIN_FIRST_RUN_EVENT,
          payload: { ok: allOk, checks: checks.map((c) => ({ name: c.name, ok: c.ok })) },
        });
        const text = JSON.stringify({ ok: allOk, passed: okCount, total: checks.length, checks });
        return allOk ? { content: [{ type: "text", text }] } : toolError(text);
      } catch (err) {
        return toolError(errorMessage(err));
      }
    },
  };

  return [catalogBrowser, stackHealth, deployInfo, firstRunWizard];
}

/** Default commit resolution: `git rev-parse HEAD` in cwd; null on any failure. */
export function defaultGitCommit(cwd: string = process.cwd()): string | null {
  try {
    const proc = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd, stdout: "pipe", stderr: "pipe" });
    if (proc.exitCode !== 0) return null;
    const out = proc.stdout.toString().trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

export function adminToolsExtension(store: Store, opts: AdminToolsOpts = {}): ExtensionFactory {
  return (pi) => {
    for (const definition of adminToolDefinitions(store, opts)) pi.registerTool(definition);
  };
}
