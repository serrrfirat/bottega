/**
 * Ephemeral iron-proxy boot for the CI live-API canary leg (issue #304):
 * starts the SAME iron-proxy the local dev canary rides (the permissive
 * dev config via docker-compose.dev.yml — allow-all allowlist "*" + NO
 * judge + secrets kept, so web search, Slack, GitHub, and the NEAR model
 * endpoint all pass; issue #126), then the credential-boundary sync
 * (src/extensions/proxy-seed) seeds the provider secret files so the proxy
 * can inject the real bearer at egress.
 *
 * Why CI needs it: the scheduled `live-api` canary (issue #79) runs on
 * ubuntu-latest where NO iron-proxy is running, so scripts/canary.sh
 * --live-slack evals scripts/canary-egress.ts --env and FAILS CLOSED
 * (issue #241): the tunnel at 127.0.0.1:8080 is unreachable → the egress
 * env is never applied → the leg refuses to run rather than egress
 * directly. This script boots the proxy, then syncProxyCredentialsFromEnv
 * writes the `<provider>.secret` files the dev config's `secrets` transform
 * requires (`require: true` → a missing key rejects the request closed),
 * and reloads the proxy.
 *
 * Used only by .github/workflows/canary.yml (live-api job):
 *   bun run scripts/canary-proxy-boot.ts
 * The workflow sets the model-gateway repo secrets in env (NEAR_API_KEY …);
 * the sync reads process.env. Tear down is an `if: always()` compose-down
 * step in the workflow — never here.
 *
 * Hermetic: the pure decisions (dir derivation, token generation, compose
 * command, readiness polling) are exported for the unit tests; the docker
 * side effects (generate-ca, compose up) are injected seams the tests stub.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { PROXY_SECRETS_MOUNT_PATH } from "../src/extensions/boundary";
import { syncProxyCredentialsFromEnv } from "../src/extensions/proxy-seed";

/** The pinned proxy image the canary boots — the SAME pin compose/dev.sh pin (issue #177 version-bump tripwire). */
export const CANARY_PROXY_IMAGE = "ironsh/iron-proxy:0.49.0";

/** The tunnel the canary egress rides — matches scripts/canary-egress.ts. */
export const PROXY_TUNNEL_URL = "http://127.0.0.1:8080";
/** The management API (the credential boundary's POST /v1/reload) — same as compose/dev.sh. */
export const MANAGEMENT_URL = "http://127.0.0.1:9092";

/** Base compose file (the STRICT deploy contract) + the dev override (permissive, ports 127.0.0.1:8080/9092). */
export const COMPOSE_FILES = ["docker-compose.yml", "docker-compose.dev.yml"] as const;

/**
 * The canary-proxy boot env: the dev-topology dirs pinned to this checkout,
 * the management token, and the credential-boundary control env — the SAME
 * values scripts/dev.sh exports for a local dev proxy. The dev override
 * (docker-compose.dev.yml) mounts ${BOTTEGA_DEV_DATA_DIR:-./data}:/data, so
 * the sync's writes to secretsDir land where the proxy reads
 * (PROXY_SECRETS_MOUNT_PATH=/data/proxy-secrets) — one relative path, both
 * topologies, mirroring issue #301's canonical dir intent.
 */
export interface CanaryProxyBootEnv {
  root: string;
  dataDir: string;
  certsDir: string;
  secretsDir: string;
  mgmtTokenFile: string;
  controlUrl: string;
  controlToken: string;
}

/** Environment keys the boot publishes (proxy container interpolation + credential sync). */
export const BOOT_ENV_KEYS = [
  "BOTTEGA_DEV_CERTS_DIR",
  "BOTTEGA_DEV_DATA_DIR",
  "BOTTEGA_PROXY_SECRETS_DIR",
  "IRON_MANAGEMENT_API_KEY",
  "BOTTEGA_PROXY_CONTROL_URL",
  "BOTTEGA_PROXY_CONTROL_TOKEN",
] as const;

/**
 * Pure derivation of the canary-proxy boot env (issue #304): the canonical
 * dev-topology dirs pinned to this checkout. `cwd` is the repo root (the
 * runner's checkout); exported for tests.
 */
export function proxyBootEnv(cwd: string): CanaryProxyBootEnv {
  const root = resolve(cwd);
  return {
    root,
    dataDir: join(root, "data"),
    certsDir: join(root, "certs"),
    secretsDir: join(root, "data", "proxy-secrets"),
    mgmtTokenFile: join(root, "data", "proxy-mgmt-token"),
    controlUrl: MANAGEMENT_URL,
    controlToken: "",
  };
}

/** The docker-compose invocation that boots the canary proxy (issue #304) — the same files dev.sh uses. */
export function composeCommand(): string[] {
  return ["docker", "compose", ...COMPOSE_FILES.map((f) => `-f ${f}`), "up", "-d", "iron-proxy"];
}

/**
 * Read-or-generate the management token (0600, gitignored): reuse on
 * consecutive CI boots (issue #301). Plain hex fallback mirrors dev.sh.
 */
export function managementToken(dataDir: string): string {
  const file = join(dataDir, "proxy-mgmt-token");
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  const token = randomBytes(16).toString("hex");
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(file, token, { mode: 0o600 });
  return token;
}

/**
 * The management-API readiness probe (issue #304): a successful POST
 * /v1/reload with the bearer proves the dev egress config parsed AND that
 * the running container's IRON_MANAGEMENT_API_KEY matches the token this
 * boot generated (issue #123) — the exact probe scripts/dev.sh uses. The
 * probe never prints the token; it only reports success/failure.
 */
export type ManagementProbe = (
  controlUrl: string,
  token: string,
  fetcher?: typeof fetch,
) => Promise<boolean>;

export const managementProbe: ManagementProbe = async (controlUrl, token, fetcher = fetch) => {
  try {
    const res = await fetcher(`${controlUrl}/v1/reload`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    return res.ok;
  } catch {
    return false;
  }
};

/** Poll the management API until it answers or the deadline elapses. */
export async function waitForManagement(
  controlUrl: string,
  token: string,
  probe: ManagementProbe = managementProbe,
  timeoutMs = 30_000,
  pollMs = 1_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await probe(controlUrl, token)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

/** Shell to docker for a one-shot side effect (generate-ca / compose up); the tests stub this. */
export type DockerRun = (cmd: string[]) => { status: number; error?: string };

export const dockerRun: DockerRun = (cmd) => {
  const res = spawnSync(cmd[0] ?? "docker", cmd.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
  return { status: res.status ?? 1, error: res.stderr?.toString().trim().slice(0, 200) };
};

/** Generate the MITM CA with the pinned image if missing — the SAME command dev.sh uses (issue #301, no new crypto). */
export function ensureCanaryCa(certsDir: string, run: DockerRun = dockerRun): boolean {
  if (existsSync(join(certsDir, "ca.crt"))) return true;
  mkdirSync(certsDir, { recursive: true });
  const res = run(["docker", "run", "--rm", "-v", `${certsDir}:/certs`, CANARY_PROXY_IMAGE, "generate-ca", "-outdir", "/certs"]);
  if (res.status !== 0) return false;
  return existsSync(join(certsDir, "ca.crt"));
}

/**
 * Boot the canary proxy end-to-end (issue #304):
 *   1. publish the boot env (dirs + management token + control env);
 *   2. ensure the MITM CA exists (generate with the pinned image if not);
 *   3. `docker compose … up -d iron-proxy`;
 *   4. wait for the management API readiness probe (dev.sh semantics);
 *   5. run the credential sync — seeds `<provider>.secret` from the repo
 *      secrets env and reloads the proxy with them (fail-closed: missing
 *      keys delete the file, a failed reload throws).
 * Exported so tests can drive the orchestration with stubbed side effects.
 */
export async function bootCanaryProxy(
  cwd: string,
  deps: {
    run?: DockerRun;
    probe?: ManagementProbe;
    sync?: typeof syncProxyCredentialsFromEnv;
    waitTimeoutMs?: number;
  } = {},
): Promise<CanaryProxyBootEnv> {
  const env = proxyBootEnv(cwd);
  const run = deps.run ?? dockerRun;
  const probe = deps.probe ?? managementProbe;
  const sync = deps.sync ?? syncProxyCredentialsFromEnv;

  const token = managementToken(env.dataDir);
  env.controlToken = token;

  // Publish the env contract (proxy container interpolation + the sync's
  // BOTTEGA_* read). IRON_MANAGEMENT_API_KEY is what docker-compose.dev.yml
  // interpolates into the iron-proxy container.
  process.env.BOTTEGA_DEV_CERTS_DIR = env.certsDir;
  process.env.BOTTEGA_DEV_DATA_DIR = env.dataDir;
  process.env.BOTTEGA_PROXY_SECRETS_DIR = env.secretsDir;
  process.env.IRON_MANAGEMENT_API_KEY = token;
  process.env.BOTTEGA_PROXY_CONTROL_URL = env.controlUrl;
  process.env.BOTTEGA_PROXY_CONTROL_TOKEN = token;

  if (!ensureCanaryCa(env.certsDir, run)) {
    throw new Error(
      `canary-proxy-boot: iron-proxy CA generation failed — is ${CANARY_PROXY_IMAGE} pullable? ` +
        "Manual: docker pull " + CANARY_PROXY_IMAGE,
    );
  }

  const up = run(composeCommand());
  if (up.status !== 0) {
    throw new Error(`canary-proxy-boot: docker compose up iron-proxy failed: ${up.error ?? "(no stderr)"}`);
  }

  const ready = await waitForManagement(env.controlUrl, token, probe, deps.waitTimeoutMs ?? 30_000);
  if (!ready) {
    throw new Error(
      "canary-proxy-boot: iron-proxy did not become ready (management API /v1/reload not answering) — " +
        "diagnose with: docker compose -f docker-compose.yml -f docker-compose.dev.yml logs iron-proxy",
    );
  }

  // Seed the provider secret files from the workflow's repo-secret env and
  // reload the proxy (the sync's own POST /v1/reload push). Fail closed: a
  // missing key deletes the file; a reload failure throws.
  await sync({ secretsDir: env.secretsDir });

  return env;
}

if (import.meta.main) {
  const env = await bootCanaryProxy(process.cwd());
  console.log(`canary-proxy-boot: ready — tunnel ${PROXY_TUNNEL_URL}, management on ${env.controlUrl}`);
  console.log(`canary-proxy-boot: proxy secrets dir ${env.secretsDir} (${PROXY_SECRETS_MOUNT_PATH} in the container)`);
}