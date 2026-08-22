/**
 * Stack-health probes for the admin tools (issue #73): the ``stack_health``
 * tool's per-service verdict logic and the default compose/HTTP/TCP/callback
 * probes behind it. Split out of ``admin.ts`` (issue #19) so the health
 * machinery has one home with its hermetic seams (``HealthProbeSeams``) and
 * the real probes (``default*``). ``admin.ts`` imports and re-exports these
* its callers (and the admin tests) stay untouched.
 */
import { z } from "@oh-my-pi/pi-coding-agent";
import { connect } from "node:net";
import type { Store } from "../store/db";
import { OAUTH_CALLBACK_PATH, callbackPort } from "../extensions/oauth-callback";
import { uploadLinkPublicBase } from "../extensions/upload-link";
import { errorMessage } from "./helpers";

/**
 * One service's health probe result.
 */
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

/** No args: the health report covers every service. */
export const stackHealthArgsSchema = z.object({});

const PROBE_TIMEOUT_MS = 2000;

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

/** The stack-health probe opts admin.ts passes in (only the health seams). */
export interface StackHealthOpts {
  health?: HealthProbeSeams;
}

/**
 * Runs the stack-health report: per-service status for
 * broker/gateway/iron-proxy/mem0/executor plus the OAuth callback chain
 * (issue #271). Any DOWN service fails the result loudly with evidence.
 */
export async function runStackHealth(store: Store, opts: StackHealthOpts): Promise<ServiceStatus[]> {
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