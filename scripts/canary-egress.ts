/**
 * Iron-proxy egress env for the live canary leg (issue #241): the ONE
 * canonical definition of the tunnel + MITM CA env, shared by
 * scripts/dev.sh (which evals `bun run scripts/canary-egress.ts --env`) and
 * scripts/canary.sh --live-slack (same eval before exec'ing
 * tests/e2e/canary.ts). The live Slack leg must ALWAYS ride iron-proxy: a
 * launch from a bare shell used to send the raw `bottega-proxy-placeholder`
 * bearer straight to chatgpt.com — "Could not parse your authentication
 * token" on every model turn (issues #71/#79 live canary, #123 iron-proxy).
 *
 * Fail-closed: `exportProxyEnv` refuses to apply the env (and the CLI exits
 * non-zero) when the tunnel is unreachable — the leg egresses THROUGH the
 * proxy or not at all, never directly.
 */
import { connect } from "node:net";
import { join } from "node:path";

/** The dev tunnel the proxy terminates (issue #123) — one canonical URL. */
export const PROXY_TUNNEL_URL = "http://127.0.0.1:8080";
/** Internal names exempt from proxying (same list as compose) — one canonical list. */
export const NO_PROXY_LIST = "localhost,127.0.0.1,data,auth-broker,auth-gateway,mem0";
/** The five proxy env vars the egress needs; tests snapshot them by key. */
export const EGRESS_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE"] as const;

export type EgressEnv = Record<(typeof EGRESS_KEYS)[number], string>;

/** A reachability probe: true when the tunnel answers connections. */
export type TunnelProbe = (tunnelUrl: string) => Promise<boolean>;

/** The five proxy env vars, derived from the repo root (the CA cert path). */
export function proxyEnv(cwd: string): EgressEnv {
  const caCert = join(cwd, "certs", "ca.crt");
  return {
    HTTP_PROXY: PROXY_TUNNEL_URL,
    HTTPS_PROXY: PROXY_TUNNEL_URL,
    NO_PROXY: NO_PROXY_LIST,
    NODE_EXTRA_CA_CERTS: caCert,
    SSL_CERT_FILE: caCert,
  };
}

function tcpProbe(tunnelUrl: string, timeoutMs = 1_000): Promise<boolean> {
  const { hostname, port } = new URL(tunnelUrl);
  return new Promise((resolve) => {
    const socket = connect({ host: hostname, port: Number(port), timeout: timeoutMs });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

/**
 * Applies the proxy env to the live process and fails closed: when the
 * tunnel is unreachable it throws and NOTHING is exported — the spawned
 * canary must never fall back to a direct egress. `probe` is injectable so
 * hermetic tests can simulate an unreachable tunnel.
 */
export async function exportProxyEnv(cwd: string, probe?: TunnelProbe): Promise<EgressEnv> {
  const env = proxyEnv(cwd);
  if (!(await (probe ?? tcpProbe)(PROXY_TUNNEL_URL))) {
    throw new Error(
      `canary-egress: iron-proxy not reachable at ${PROXY_TUNNEL_URL} — refusing to ` +
        "egress directly (issue #241). Start it with 'bun run dev' or " +
        "'docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d iron-proxy'.",
    );
  }
  for (const key of EGRESS_KEYS) process.env[key] = env[key];
  return env;
}

/**
 * Repo root derived from this file's location (`scripts/` sits one level
 * under the root) — what dev.sh/canary.sh would see as `$PWD`.
 */
function repoRoot(): string {
  return join(import.meta.dir, "..");
}

if (import.meta.main) {
  const [mode] = Bun.argv.slice(2);
  if (mode !== "--env") {
    console.error(`canary-egress: expected --env (got '${mode ?? ""}') — prints the exported proxy env after a fail-closed tunnel check`);
    process.exit(2);
  }
  const env = await exportProxyEnv(repoRoot());
  for (const key of EGRESS_KEYS) console.log(`export ${key}='${env[key]}'`);
}
