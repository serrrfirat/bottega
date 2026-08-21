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
  pinSnapshotDraft,
  type FetchCatalogOptions,
  type SnapshotDraft,
} from "../extensions/fetch-catalog";
import { PROXY_SECRETS_DIR, proxyBoundaryControlFromEnv } from "../extensions/boundary";
import { OAUTH_CALLBACK_PATH, callbackPort } from "../extensions/oauth-callback";
import { uploadLinkPublicBase } from "../extensions/upload-link";
import { runtimeSnapshotsFromStore } from "../extensions/runtime-registry";
import type {
  CliBinding,
  CredentialSchema,
  CredentialTarget,
  ExtensionKind,
  ExtensionTool,
  McpBinding,
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
  /**
   * OAuth callback-listener probe (issue #271): TCP connect to
   * 127.0.0.1:<port> PLUS a GET /oauth/callback on the same port — any
   * non-5xx HTTP answer proves the listener serves the callback route (a
   * bare GET 400s: no code/state), so a 4xx is UP, not down.
   */
  callbackListener?: (port: number, timeoutMs?: number) => Promise<{ ok: boolean; evidence: string }>;
  /**
   * Public callback-base probe (issue #271): GET the base the connect mints
   * authorize URLs at (the SAME source the redirect_uri embeds:
   * data/public-base-url, else BOTTEGA_OAUTH_CALLBACK_BASE_URL). Any
   * non-5xx answers "up" — the ingress 404s unknown paths, so a 2xx/3xx/4xx
   * proves the tunnel forwards to the listener; a 5xx (502/530) or a
   * transport failure means a dead/stale tunnel.
   */
  publicBase?: (base: string, timeoutMs?: number) => Promise<{ ok: boolean; evidence: string }>;
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
  binding: McpBinding | CliBinding | undefined;
  credential_schema: CredentialSchema | undefined;
  credential_targets: CredentialTarget[] | undefined;
  tools_count: number | null;
  domains: string[];
  vendor_official: boolean;
  reviewed: boolean;
}

/**
 * The review-gate summary for a completed draft: everything the human must
 * see before confirming a pin (id, label, kind, binding, credential schema,
 * credential targets, tool count, domains, provenance). One source shared by
 * required refusal and the audit trail.
 */
function draftSummary(draft: SnapshotDraft): DraftSummary {
  const binding = draft.manifest.kind === "mcp" ? draft.manifest.mcp : draft.manifest.cli;
  return {
    id: draft.manifest.id,
    label: draft.manifest.label,
    kind: draft.manifest.kind,
    binding,
    credential_schema: draft.manifest.credentialSchema,
    credential_targets: draft.manifest.credentialTargets,
    tools_count: draft.manifest.tools?.length ?? null,
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
  // SAFETY: Bun.spawn with stdout: "pipe" always exposes a readable stream
  // on proc.stdout (it is never null or a file descriptor here).
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
    /** One `docker compose ps --format json` row. */
    const composeRowSchema = z.object({
      Service: z.string().optional(),
      State: z.string().optional(),
      Health: z.string().optional(),
      RestartCount: z.number().optional(),
    });
    const parsed: unknown = JSON.parse(stdout);
    // Docker Compose v5 emits a single JSON object for `ps --format json
    // <service>`; older versions emit an array. Normalize both to an array,
    // then validate every row — accepting either shape without weakening
    // the row schema.
    const rows = z.array(composeRowSchema).parse(Array.isArray(parsed) ? parsed : [parsed]);
    const row = rows.find((r) => r["Service"] === service);
    if (!row) return { available: true };
    return {
      available: true,
      state: row["State"],
      health: row["Health"],
      restartCount: row["RestartCount"],
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
    return { ok: false, evidence: `GET ${url} failed: ${err instanceof Error ? err.message : String(err)}` };
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
 * Default OAuth callback-listener probe (issue #271): TCP connect to
 * 127.0.0.1:<port>, then GET /oauth/callback on the same port. The callback
 * endpoint answers 400 for a bare GET (no code/state), so any non-5xx
 * response — the TCP connect PLUS a served route — proves the listener is
 * up; a 5xx or transport failure proves it is not.
 */
export async function defaultCallbackListenerProbe(
  port: number,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<{ ok: boolean; evidence: string }> {
  const tcp = await defaultTcpConnect("127.0.0.1", port, timeoutMs);
  if (!tcp.ok) return tcp;
  try {
    const res = await fetch(`http://127.0.0.1:${port}${OAUTH_CALLBACK_PATH}`, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "follow",
    });
    return {
      ok: res.status < 500,
      evidence: `GET http://127.0.0.1:${port}${OAUTH_CALLBACK_PATH} -> HTTP ${res.status}`,
    };
  } catch (err) {
    return {
      ok: false,
      evidence: `GET http://127.0.0.1:${port}${OAUTH_CALLBACK_PATH} failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Default public callback-base probe (issue #271): any non-5xx HTTP
 * response answers "up" (the ingress 404s unknown paths, so a 2xx/3xx/4xx
 * means the tunnel forwards to the listener); a 5xx (Cloudflare 502/530,
 * nginx 502) or a transport failure (DNS, refused, timeout) means the base
 * is dead and every minted authorize URL would die in the browser.
 */
export async function defaultPublicBaseProbe(
  base: string,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<{ ok: boolean; evidence: string }> {
  try {
    const res = await fetch(base, { signal: AbortSignal.timeout(timeoutMs), redirect: "follow" });
    return { ok: res.status < 500, evidence: `GET ${base} -> HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, evidence: `GET ${base} failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** One stack service's probe target. `fromHost` marks a target that is an
 * explicitly configured, host-reachable URL (broker from OMP_AUTH_BROKER_URL,
 * or a configured mem0 base) as opposed to a Docker-internal default name
 * (auth-gateway, iron-proxy, default mem0) that only resolves inside compose. */
type ServiceTarget = { kind: "http" | "tcp"; host?: string; port?: number; url?: string; fromHost?: boolean };

/**
 * Probes one service: compose state when docker is available, local
 * HTTP/TCP probes otherwise. Returns up/down/unknown with evidence.
 */
async function probeService(
  service: string,
  seams: Required<Pick<HealthProbeSeams, "composePs" | "httpGet" | "tcpConnect">>,
  target: ServiceTarget,
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
  // Compose is available but produced no row: the service is simply not
  // part of the running project (not running / not enabled). A target that
  // is a Docker-internal default name (gateway, iron-proxy, default mem0)
  // is reported unknown — those names do not resolve from the macOS host
  // (ENOTFOUND), so a DNS/HTTP fallback would falsely report a healthy local
  // dev stack as down. A target with an explicitly configured host-reachable
  // URL (broker from OMP_AUTH_BROKER_URL, or a configured mem0 base) may
  // legitimately run outside compose in local dev, so it falls through to
  // probe that configured URL below.
  if (compose.available && !target.fromHost) {
    return {
      service,
      status: "unknown",
      method: "compose",
      evidence: `docker compose ps ${service}: ${compose.health || "service not in the running project (not running/not enabled)"}`,
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
  const seams: Required<
    Pick<HealthProbeSeams, "composePs" | "httpGet" | "tcpConnect" | "callbackListener" | "publicBase">
  > = {
    composePs: opts.health?.composePs ?? ((service) => defaultComposePs(service, process.cwd())),
    httpGet: opts.health?.httpGet ?? defaultHttpGet,
    tcpConnect: opts.health?.tcpConnect ?? defaultTcpConnect,
    callbackListener: opts.health?.callbackListener ?? defaultCallbackListenerProbe,
    publicBase: opts.health?.publicBase ?? defaultPublicBaseProbe,
  };
  const brokerUrl = (process.env.OMP_AUTH_BROKER_URL ?? "http://auth-broker:8765").replace(/\/+$/, "");
  // An explicitly configured OMP_AUTH_BROKER_URL (dev.sh exports
  // http://127.0.0.1:8765) is host-reachable from the macOS host even when
  // the compose service (named auth-broker) has no `broker` row; the default
  // http://auth-broker:8765 is a Docker-internal name only.
  const brokerFromHost = Boolean(process.env.OMP_AUTH_BROKER_URL?.trim());
  const settings = store.getOrgSettings();
  const mem0FromHost = Boolean(settings?.memoryBackend?.baseUrl?.trim());
  const mem0Base = settings?.memoryBackend?.baseUrl?.trim().replace(/\/+$/, "") ?? "http://mem0:8000";
  const targets: Array<{ service: string; target: ServiceTarget }> = [
    { service: "broker", target: { kind: "http", url: `${brokerUrl}/v1/healthz`, fromHost: brokerFromHost } },
    { service: "gateway", target: { kind: "tcp", host: "auth-gateway", port: 4000 } },
    { service: "iron-proxy", target: { kind: "tcp", host: "iron-proxy", port: 8080 } },
    { service: "mem0", target: { kind: "http", url: `${mem0Base}/openapi.json`, fromHost: mem0FromHost } },
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
    // Compose is available but the executor is not part of the running
    // project (not enabled / not running in this topology) — honest unknown,
    // never a fabricated "down" of an absent profile.
    results.push({
      service: "executor",
      status: "unknown",
      method: "compose",
      evidence: "docker compose ps executor: service not in the running project (not running/not enabled)",
    });
  } else {
    results.push({
      service: "executor",
      status: "unknown",
      method: "none",
      evidence: "no listening port; docker/compose unavailable here — check `docker compose ps` on the host",
    });
  }
  // The OAuth callback chain (issue #271): the connect mints authorize URLs
  // at <public-base>/oauth/callback, served by the in-process listener on
  // BOTTEGA_CALLBACK_PORT — BOTH must be live, or every minted link dies in
  // the browser. These rows exist so a LIVE chain is provably up and a dead
  // one is loud (the 2026-08-20 misdiagnosis: a live listener + tunnel read
  // as a dead stack because nothing probed them).
  try {
    const port = callbackPort();
    if (port === 0) {
      // Ephemeral port (local dev, tests): nothing stable to probe, and no
      // tunnel can forward to it — honest unknown, never a fabricated down.
      results.push({
        service: "oauth-callback-listener",
        status: "unknown",
        method: "none",
        evidence:
          "BOTTEGA_CALLBACK_PORT is not set — the callback listener binds an ephemeral port; " +
          "set a stable port when a tunnel/reverse proxy forwards to it",
      });
    } else {
      const listener = await seams.callbackListener(port, PROBE_TIMEOUT_MS);
      results.push({
        service: "oauth-callback-listener",
        status: listener.ok ? "up" : "down",
        method: "tcp",
        evidence: listener.evidence,
      });
    }
  } catch (err) {
    // A mistyped BOTTEGA_CALLBACK_PORT must never crash the report.
    results.push({
      service: "oauth-callback-listener",
      status: "down",
      method: "none",
      evidence: `invalid BOTTEGA_CALLBACK_PORT: ${errorMessage(err)}`,
    });
  }
  // The SAME public base the connect embeds into the authorize URL's
  // redirect_uri (data/public-base-url, else BOTTEGA_OAUTH_CALLBACK_BASE_URL
  // — uploadLinkPublicBase, the source server/index.ts wires). Unconfigured
  // → loopback-only posture: the listener row above covers loopback
  // liveness, reported unknown here (local dev), never a fabricated down.
  const publicBase = uploadLinkPublicBase();
  if (publicBase === undefined) {
    results.push({
      service: "public-callback-base",
      status: "unknown",
      method: "none",
      evidence:
        "no public callback base configured (data/public-base-url or BOTTEGA_OAUTH_CALLBACK_BASE_URL) — " +
        "authorize URLs use the loopback URL (local dev only; a remote user cannot open them)",
    });
  } else {
    const baseProbe = await seams.publicBase(publicBase, PROBE_TIMEOUT_MS);
    results.push({
      service: "public-callback-base",
      status: baseProbe.ok ? "up" : "down",
      method: "http",
      evidence: baseProbe.evidence,
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
          const bindingMissing = draft.manifest.mcp === undefined && draft.manifest.cli === undefined;
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
                  note: bindingMissing
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
          const manifest = { ...draft.manifest };
          if (draft.manifest.kind === "mcp") {
            if (params.binding !== undefined) {
              // SAFETY: the merged manifest is re-validated by validateManifest
              // below (fail closed) before any write or registration; the params
              // arrive zod-validated from the tool args schema, and the JSON
              // round-trip keeps the validator's JSON-domain contract.
              manifest.mcp = JSON.parse(JSON.stringify(params.binding)) as McpBinding;
            }
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
          // the MCP host in, keep the scaffold/extra domains, deduped.
          const mergedDraft: SnapshotDraft = { ...draft, manifest };
          const host = hostedBindingHost(mergedDraft);
          manifest.domains = [
            ...new Set<string>([...(params.domains ?? draft.manifest.domains), ...(host !== null ? [host] : [])]),
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
          const needsBinding =
            completed.manifest.kind === "mcp"
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
          // web-search verified no official hosted server exists.
          const hosted = host !== null;
          if (!hosted && params.no_hosted_variant !== true) {
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
          if (hosted && completed.manifest.mcp !== undefined && completed.manifest.mcp.transport === "streamable-http") {
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
                summary: draftSummary(completed),
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
