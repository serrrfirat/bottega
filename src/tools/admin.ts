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
 * are never installed or pinned by this tool; a maintainer completes the
 * binding facts from the vendor docs and pins through the fetch-catalog
 * flow (which enforces the review gate). The drafts dir sits OUTSIDE the
 * registry's scan (readPinnedSnapshots reads only top-level *.json), so a
 * draft can never fail the boot.
 *
 * Stack health (`stack_health`): per-service status for
 * broker/gateway/iron-proxy/mem0/executor. Compose state via
 * `docker compose ps` when docker is available; local HTTP/TCP probes
 * otherwise (in-container, the compose-internal names resolve). Any DOWN
 * service fails the result loudly with evidence (isError).
 *
 * Deploy info (`deploy_info`): image tag (BOTTEGA_IMAGE_TAG), git commit,
 * process uptime, config dir.
 *
 * First-run wizard (`first_run_wizard`): the guided checklist — Slack
 * tokens, model key, broker token, git PAT file (mode 0600), egress
 * allowlist, memory backend (mem0 or SQLite fallback). Each check reports
 * pass/fail with the fix instruction; any failure fails the result loudly.
 */
import type { ExtensionFactory, AgentToolResult, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { z } from "@oh-my-pi/pi-coding-agent";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
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
  type FetchCatalogOptions,
} from "../extensions/fetch-catalog";
import type { ResolvedExtension } from "../extensions/registry";
import type { Store } from "../store/db";
import type { AuditModule } from "../policy/audit";
import { errorMessage, toolError } from "./helpers";

/** One wizard check result. */
export interface WizardCheck {
  name: string;
  ok: boolean;
  /** What was observed (evidence). */
  detail: string;
  /** What to do when !ok (the fix instruction). */
  fix: string;
}

/** One service's health probe result. */
export interface ServiceStatus {
  service: string;
  status: "up" | "down" | "unknown";
  /** How it was probed ("compose", "http", "tcp", "none"). */
  method: string;
  /** One line of evidence (state/endpoint + what was observed). */
  evidence: string;
}

/**
 * Stack-health probe seams (hermetic tests inject fakes; the defaults are
 * the real probes).
 */
export interface HealthProbeSeams {
  /**
   * Compose state for one service. `{ available: false }` → docker/compose
   * cannot run here (no binary); `{ available: true }` without state →
   * compose ran but the service is not in the running project.
   */
  composePs?: (
    service: string,
  ) => Promise<{ available: boolean; state?: string; health?: string; restartCount?: number }>;
  /** HTTP GET probe: ok on any 2xx; evidence carries the status/error. */
  httpGet?: (url: string, timeoutMs?: number) => Promise<{ ok: boolean; evidence: string }>;
  /** TCP connect probe: ok on connect; evidence carries the error. */
  tcpConnect?: (host: string, port: number, timeoutMs?: number) => Promise<{ ok: boolean; evidence: string }>;
}

export interface AdminToolsOpts {
  /** Audit module; every invocation appends an `admin.*` row. */
  audit?: Pick<AuditModule, "appendAudit">;
  /** Actor recorded on audit rows; defaults to "agent". */
  actor?: string;
  /**
   * The pinned-snapshot registry (issue #50) — the catalog browser's
   * "pinned" half. Absent → no pinned entries (still lists the catalog).
   */
  registry?: { list(): readonly ResolvedExtension[] };
  /** Catalog fetch seams (the #54 helper's own seams). */
  catalog?: FetchCatalogOptions;
  /** Where catalog drafts land. Default "config/extensions/drafts". */
  catalogDraftsDir?: string;
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

/** Tool args: browser action + optional query/spec. */
export const catalogBrowserArgsSchema = z.object({
  action: z.enum(["list", "draft"]).default("list"),
  /** Substring filter for `list` (name/slug/id/kind/domain, case-insensitive). */
  query: z.string().optional(),
  /** Catalog slug or id (e.g. "linear", "mcp/linear") — required for `draft`. */
  spec: z.string().optional(),
});

/** No args: the health report covers every service. */
export const stackHealthArgsSchema = z.object({});
/** No args: identity info only. */
export const deployInfoArgsSchema = z.object({});
/** No args: the full checklist. */
export const firstRunWizardArgsSchema = z.object({});

export type AdminToolDefinition = ToolDefinition<
  typeof catalogBrowserArgsSchema | typeof stackHealthArgsSchema | typeof deployInfoArgsSchema | typeof firstRunWizardArgsSchema
>;

const PROBE_TIMEOUT_MS = 2000;
const CATALOG_LIST_CAP = 50;

/** A non-empty env value that does not look like a placeholder ("replace"/"…"). */
function envValue(name: string): string | null {
  const value = process.env[name];
  if (!value || value.trim() === "") return null;
  return /replace|\.\.\./i.test(value) ? null : value;
}

function placeholderFix(envName: string, source: string): string {
  return `set ${envName} in .env (${source}); it must not be a placeholder`;
}

// ---------------------------------------------------------------------------
// Catalog browser
// ---------------------------------------------------------------------------

function pinnedMatchesQuery(entry: ResolvedExtension, needle: string): boolean {
  return [entry.manifest.id, entry.manifest.label, entry.manifest.kind, ...entry.manifest.domains].some((field) =>
    field.toLowerCase().includes(needle),
  );
}

function pinnedView(entry: ResolvedExtension): Record<string, unknown> {
  return {
    id: entry.manifest.id,
    label: entry.manifest.label,
    kind: entry.manifest.kind,
    domains: entry.manifest.domains,
    reviewed: entry.snapshot?.source.reviewed ?? false,
    pinned_at: entry.snapshot?.pinnedAt ?? null,
  };
}

// ---------------------------------------------------------------------------
// Stack health
// ---------------------------------------------------------------------------

/** Default compose probe: `docker compose ps --format json <service>` in cwd. */
export async function defaultComposePs(
  service: string,
  cwd: string,
): Promise<{ available: boolean; state?: string; health?: string; restartCount?: number }> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(["docker", "compose", "ps", "--format", "json", service], {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
      env: process.env,
    });
  } catch {
    return { available: false };
  }
  const out = await new Response(proc.stdout as ReadableStream).text();
  const code = await proc.exited;
  if (code !== 0) {
    // Compose ran but found no such service in the (running) project — the
    // caller falls back to local probes / reports down.
    return { available: true };
  }
  const stdout = out.trim();
  if (!stdout) return { available: true };
  try {
    const rows = JSON.parse(stdout) as Array<Record<string, unknown>>;
    const row = rows.find((r) => r["Service"] === service);
    if (!row) return { available: true };
    return {
      available: true,
      state: typeof row["State"] === "string" ? row["State"] : undefined,
      health: typeof row["Health"] === "string" ? row["Health"] : undefined,
      restartCount: typeof row["RestartCount"] === "number" ? row["RestartCount"] : undefined,
    };
  } catch {
    // Unparseable output is evidence, not a crash: report unknown state.
    return { available: true, state: undefined, health: `unparseable compose output: ${stdout.slice(0, 120)}` };
  }
}

/** Default HTTP probe: any 2xx answers "up". */
export async function defaultHttpGet(url: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<{ ok: boolean; evidence: string }> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "follow" });
    return { ok: res.ok, evidence: `GET ${url} -> HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, evidence: `GET ${url} failed: ${(err as Error).message}` };
  }
}

/** Default TCP probe: a successful connect answers "up". */
export async function defaultTcpConnect(
  host: string,
  port: number,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<{ ok: boolean; evidence: string }> {
  return new Promise((resolvePromise) => {
    const socket = connect({ host, port });
    const done = (ok: boolean, evidence: string): void => {
      socket.destroy();
      resolvePromise({ ok, evidence });
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true, `tcp ${host}:${port} connected`));
    socket.once("timeout", () => done(false, `tcp ${host}:${port} timed out after ${timeoutMs}ms`));
    socket.once("error", (err) => done(false, `tcp ${host}:${port} failed: ${err.message}`));
  });
}

/**
 * Probes one service: compose state when docker is available, local
 * HTTP/TCP probes otherwise. Returns up/down/unknown with evidence.
 */
async function probeService(
  service: string,
  seams: Required<Pick<HealthProbeSeams, "composePs" | "httpGet" | "tcpConnect">>,
  target: { kind: "http" | "tcp"; host?: string; port?: number; url?: string },
): Promise<ServiceStatus> {
  const compose = await seams.composePs(service);
  if (compose.available && compose.state !== undefined) {
    const up =
      compose.state === "running" &&
      (compose.health === undefined || compose.health === "" || compose.health === "healthy") &&
      (compose.restartCount === undefined || compose.restartCount === 0);
    const state = [compose.state, compose.health ?? "", compose.restartCount !== undefined ? `restarts:${compose.restartCount}` : ""]
      .filter(Boolean)
      .join(" ");
    return {
      service,
      status: up ? "up" : "down",
      method: "compose",
      evidence: `docker compose ps ${service}: ${state}`,
    };
  }
  if (target.kind === "http") {
    const result = await seams.httpGet(target.url!, PROBE_TIMEOUT_MS);
    return { service, status: result.ok ? "up" : "down", method: "http", evidence: result.evidence };
  }
  if (target.kind === "tcp") {
    const result = await seams.tcpConnect(target.host!, target.port!, PROBE_TIMEOUT_MS);
    return { service, status: result.ok ? "up" : "down", method: "tcp", evidence: result.evidence };
  }
  return { service, status: "unknown", method: "none", evidence: "no probe available" };
}

async function runStackHealth(store: Store, opts: AdminToolsOpts): Promise<ServiceStatus[]> {
  const seams: Required<Pick<HealthProbeSeams, "composePs" | "httpGet" | "tcpConnect">> = {
    composePs: opts.health?.composePs ?? ((service) => defaultComposePs(service, process.cwd())),
    httpGet: opts.health?.httpGet ?? defaultHttpGet,
    tcpConnect: opts.health?.tcpConnect ?? defaultTcpConnect,
  };
  const brokerUrl = (process.env.OMP_AUTH_BROKER_URL ?? "http://auth-broker:8765").replace(/\/+$/, "");
  const settings = store.getOrgSettings();
  const mem0Base = settings?.memoryBackend?.baseUrl?.trim().replace(/\/+$/, "") ?? "http://mem0:8000";
  const targets: Array<{ service: string; target: { kind: "http" | "tcp"; host?: string; port?: number; url?: string } }> = [
    { service: "broker", target: { kind: "http", url: `${brokerUrl}/v1/healthz` } },
    { service: "gateway", target: { kind: "tcp", host: "auth-gateway", port: 4000 } },
    { service: "iron-proxy", target: { kind: "tcp", host: "iron-proxy", port: 8080 } },
    { service: "mem0", target: { kind: "http", url: `${mem0Base}/openapi.json` } },
  ];
  const results: ServiceStatus[] = [];
  for (const { service, target } of targets) {
    results.push(await probeService(service, seams, target));
  }
  // The executor has no listening port: its only reachable state is the
  // compose one. Without docker access that is unobservable, reported as
  // unknown with the reason (never a fabricated "down").
  const compose = await seams.composePs("executor");
  if (compose.available && compose.state !== undefined) {
    const up =
      compose.state === "running" &&
      (compose.health === undefined || compose.health === "" || compose.health === "healthy") &&
      (compose.restartCount === undefined || compose.restartCount === 0);
    const state = [compose.state, compose.health ?? "", compose.restartCount !== undefined ? `restarts:${compose.restartCount}` : ""]
      .filter(Boolean)
      .join(" ");
    results.push({
      service: "executor",
      status: up ? "up" : "down",
      method: "compose",
      evidence: `docker compose ps executor: ${state}`,
    });
  } else if (compose.available) {
    results.push({
      service: "executor",
      status: "down",
      method: "compose",
      evidence: "docker compose ps executor: service not in the running project",
    });
  } else {
    results.push({
      service: "executor",
      status: "unknown",
      method: "none",
      evidence: "no listening port; docker/compose unavailable here — check `docker compose ps` on the host",
    });
  }
  return results;
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

  const catalogBrowser: ToolDefinition<typeof catalogBrowserArgsSchema> = {
    name: "catalog_browser",
    label: "Browse the extension catalog",
    description:
      "Lists available extensions and drafts new ones. `list` (default) matches the query " +
      "(name/slug/id/kind/domain substring, case-insensitive; no query = everything) against the " +
      "PINNED snapshots (config/extensions) and the integrations.sh catalog; the catalog is capped " +
      "at 50 matches with a truncated flag. `draft` requires `spec` (catalog slug or id, e.g. " +
      "\"linear\") and writes an UNREVIEWED draft snapshot (source.reviewed: false) to " +
      "config/extensions/drafts/<id>.draft.json — it is NEVER installed or pinned by this tool; a " +
      "maintainer completes the binding facts (mcp/cli, credentialSchema, tools) from the vendor " +
      "docs and pins through the fetch-catalog flow after review. Write-tier: prompts for approval " +
      "in non-yolo modes (admin-gated like the settings tool).",
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
                  note:
                    "DRAFT — not installed. Complete the manifest binding (mcp/cli, credentialSchema, " +
                    "tools) from the vendor docs, mark source.reviewed, and pin via the fetch-catalog " +
                    "flow (--pin) to install.",
                  draft,
                }),
              },
            ],
          };
        }
        const pinned = opts.registry?.list() ?? [];
        const needle = params.query?.trim().toLowerCase() ?? "";
        const pinnedMatches = needle ? pinned.filter((entry) => pinnedMatchesQuery(entry, needle)) : pinned;
        const catalogEntries = await listCatalogEntries(params.query, catalogOpts);
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
                  url: entry.url,
                  ...(entry.description !== undefined ? { description: entry.description } : {}),
                })),
                catalog_truncated: truncated,
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
      "Reports per-service status for broker, gateway, iron-proxy, mem0, and executor: compose " +
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
        const slackApp = envValue("SLACK_APP_TOKEN");
        const slackBot = envValue("SLACK_BOT_TOKEN");
        const modelKey = envValue("OPENCODE_API_KEY") ?? envValue("NEAR_API_KEY");
        const brokerToken = envValue("OMP_AUTH_BROKER_TOKEN");
        const settings = store.getOrgSettings();
        const tokenFile = opts.gitTokenFile ?? process.env.EXECUTOR_GIT_TOKEN_FILE ?? "data/secrets/github-pat";
        const checks: WizardCheck[] = [
          slackApp && slackBot
            ? { name: "slack_tokens", ok: true, detail: "SLACK_APP_TOKEN and SLACK_BOT_TOKEN are set", fix: "none" }
            : {
                name: "slack_tokens",
                ok: false,
                detail: `SLACK_APP_TOKEN set: ${slackApp !== null}, SLACK_BOT_TOKEN set: ${slackBot !== null}`,
                fix: "create the Slack app from slack-app-manifest.yml and fill both tokens in .env",
              },
          modelKey
            ? { name: "model_key", ok: true, detail: "a model key is resolvable (OPENCODE_API_KEY or NEAR_API_KEY)", fix: "none" }
            : {
                name: "model_key",
                ok: false,
                detail: "neither OPENCODE_API_KEY nor NEAR_API_KEY is set (or they are placeholders)",
                fix: placeholderFix(
                  "OPENCODE_API_KEY or NEAR_API_KEY",
                  "the macOS Keychain (service: bottega-opencode / bottega-near) loads it for local dev",
                ),
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
