/**
 * Local-dev overrides (issues #123, #126, #143): docker-compose.dev.yml is
 * the dev-only delta on top of docker-compose.yml — host-reachable
 * listeners and the host's gitignored ./data bind, so `bun run dev`
 * (scripts/dev.sh) loads the DEV-PERMISSIVE generated config
 * (config/egress.dev.yml: allow-all "*" + no judge, secrets + management
 * kept) into the dev proxy while the host server's boundary secret files
 * (data/proxy-secrets) are what the proxy injects, and runs the
 * auth-broker vault host-reachable so the boundary's broker secret
 * resolver can fetch credentials. The base compose file keeps the STRICT
 * config/egress.yml (deployment contract) and NO published ports
 * (invariant asserted in compose.test.ts).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseYamlSubset, type YamlNode } from "../yaml-subset";
import { PROXY_SECRETS_DIR, PROXY_SECRETS_MOUNT_PATH } from "../extensions/boundary";

const dev = parseYamlSubset(
  readFileSync(resolve(import.meta.dir, "../../docker-compose.dev.yml"), "utf8"),
);
const base = parseYamlSubset(
  readFileSync(resolve(import.meta.dir, "../../docker-compose.yml"), "utf8"),
);

// SAFETY: docker-compose.dev.yml's top-level `services` map is an object in the checked-in fixture.
const devServices = dev["services"] as Record<string, YamlNode>;
// SAFETY: the dev override defines the iron-proxy service (its deltas are asserted below).
const proxy = devServices["iron-proxy"] as Record<string, YamlNode>;
// SAFETY: the dev override defines the auth-broker service (its deltas are asserted below).
const broker = devServices["auth-broker"] as Record<string, YamlNode>;
// SAFETY: the base compose file defines the auth-broker service; the override's inheritance is asserted against it below.
const baseBroker = (base["services"] as Record<string, YamlNode>)["auth-broker"] as Record<string, YamlNode>;

describe("docker-compose.dev.yml (local-dev overrides: iron-proxy #123, auth-broker #143)", () => {
  test("overrides ONLY iron-proxy and auth-broker (no other service is touched)", () => {
    expect(Object.keys(devServices).sort()).toEqual(["auth-broker", "iron-proxy"]);
  });

  test("publishes the tunnel + management listeners bound to loopback only", () => {
    // SAFETY: the dev override publishes exactly the two loopback ports asserted below.
    const ports = proxy["ports"] as string[];
    expect(ports.sort()).toEqual(["127.0.0.1:8080:8080", "127.0.0.1:9092:9092"]);
  });

  test("mounts the dev-permissive config (not the strict one), CA, and the host ./data at /data", () => {
    // SAFETY: the dev override mounts the dev-permissive config, certs, and ./data (asserted below).
    const vols = proxy["volumes"] as string[];
    expect(vols).toContain("./config/egress.dev.yml:/etc/iron-proxy/egress.yml:ro");
    // The dev proxy must NOT mount the STRICT config/egress.yml: the dev
    // config (allow-all + no judge, issue #126) is what makes local testing
    // pass; the strict config stays the deployment contract (base compose).
    expect(vols).not.toContain("./config/egress.yml:/etc/iron-proxy/egress.yml:ro");
    // The MITM CA bind is the CANONICAL certs dir (dev.sh exports
    // BOTTEGA_DEV_CERTS_DIR=shared_certs_dir, issue #301) so every worktree's
    // dev proxy terminates with the SAME CA — never a worktree-local cert the
    // shared stack's other containers are not terminating with. The `:-./certs`
    // fallback keeps bare `docker compose` on the local certs dir.
    expect(vols).toContain("${BOTTEGA_DEV_CERTS_DIR:-./certs}:/etc/iron-proxy/certs:ro");
    expect(vols).not.toContain("./certs:/etc/iron-proxy/certs:ro");
    // The canonical data dir is interpolated by scripts/dev.sh (which exports
    // BOTTEGA_DEV_DATA_DIR=shared_data_dir, issue #301/#293): every worktree's
    // dev stack binds the SAME canonical data/ — required once worktrees share
    // one Compose project (else the mount flips on every boot from a
    // different worktree). The `${...:-./data}` fallback keeps the bare
    // `docker compose` invocation from docs/troubleshooting on ./data.
    expect(vols).toContain("${BOTTEGA_DEV_DATA_DIR:-./data}:/data");
    // The dev proxy must NOT use the compose named volume: the host server
    // writes secret files to the CANONICAL data/proxy-secrets
    // (BOTTEGA_PROXY_SECRETS_DIR, issue #301) and the generated egress
    // config reads them at /data/proxy-secrets (PROXY_SECRETS_MOUNT_PATH) —
    // one relative path, both topologies.
    expect(vols).not.toContain("data:/data");
    expect(PROXY_SECRETS_MOUNT_PATH).toBe(`/data/${PROXY_SECRETS_DIR.split("/").pop()}`);
  });

  test("does not change the image, config command, or restart policy", () => {
    expect(proxy["image"]).toBeUndefined(); // inherited from the base service
    expect(proxy["command"]).toBeUndefined();
    expect(proxy["restart"]).toBeUndefined();
  });

  test("auth-broker publishes the vault on 127.0.0.1:8765 (the broker serve port)", () => {
    // SAFETY: the auth-broker override publishes exactly the vault port asserted below.
    const ports = broker["ports"] as string[];
    expect(ports.sort()).toEqual(["127.0.0.1:8765:8765"]);
    // The serve port must match the base service's command + healthcheck,
    // so the override only exposes what the broker already listens on.
    // SAFETY: the base auth-broker command binds the vault port (asserted below).
    const baseCommand = baseBroker["command"] as string[];
    expect(baseCommand).toContain("--bind=0.0.0.0:8765");
    // SAFETY: the base auth-broker healthcheck.test holds the probe command (asserted below).
    const healthcheck = (baseBroker["healthcheck"] as Record<string, YamlNode>)["test"] as string[];
    expect(healthcheck).toContain("http://127.0.0.1:8765/v1/healthz");
  });

  test("auth-broker swaps the named data volume for the host ./data bind (entrypoints mount stays inherited)", () => {
    // SAFETY: the auth-broker override swaps the named volume for the host ./data bind (asserted below).
    const vols = broker["volumes"] as string[];
    // The broker's token bootstraps to /data/.omp/auth-broker.token (0600,
    // entrypoints/broker.sh); on the host that is ./data/.omp/auth-broker.token,
    // which scripts/dev.sh reads for OMP_AUTH_BROKER_TOKEN. Compose merges
    // volumes by container path, so ./data:/data REPLACES the base
    // `data:/data` (the same dedup the iron-proxy override relies on).
    expect(vols).toContain("${BOTTEGA_DEV_DATA_DIR:-./data}:/data");
    expect(vols).not.toContain("data:/data");
    // The entrypoints mount (the token bootstrap) is inherited from the
    // base service untouched — the override lists only its deltas.
    expect(vols).toEqual(["${BOTTEGA_DEV_DATA_DIR:-./data}:/data"]);
    // SAFETY: the base auth-broker keeps the entrypoints mount (asserted below).
    expect(baseBroker["volumes"] as string[]).toContain("./config/entrypoints:/entrypoints:ro");
  });

  test("auth-broker inherits image, entrypoint, command, and healthcheck from the base service", () => {
    expect(broker["image"]).toBeUndefined();
    expect(broker["entrypoint"]).toBeUndefined();
    expect(broker["command"]).toBeUndefined();
    expect(broker["healthcheck"]).toBeUndefined();
    expect(broker["restart"]).toBeUndefined();
  });

  test("the base compose auth-broker publishes NO ports (deployment contract, issue #143)", () => {
    expect(baseBroker["ports"]).toBeUndefined();
  });
});

describe("local development bootstrap wiring (#143/#301/#311)", () => {
  const devSh = readFileSync(resolve(import.meta.dir, "../../scripts/dev.sh"), "utf8");
  const bootstrap = readFileSync(resolve(import.meta.dir, "../../scripts/dev-bootstrap.ts"), "utf8");

  test("keeps the shell launcher thin and routes both package entrypoints through the shared module", () => {
    expect(devSh).toContain("scripts/dev-bootstrap.ts setup");
    expect(devSh).toContain("scripts/dev-bootstrap.ts dev");
    expect(devSh).not.toContain("docker compose");
    expect(devSh).not.toContain("auth-broker.token");
  });

  test("pins the canonical Compose project, data, credential, public-base, and CA paths", () => {
    expect(devSh).toContain('export COMPOSE_PROJECT_NAME="$(dev_compose_project)"');
    expect(devSh).toContain('export BOTTEGA_DEV_DATA_DIR="$(shared_data_dir)"');
    expect(devSh).toContain('export BOTTEGA_PROXY_SECRETS_DIR="$(shared_data_dir)/proxy-secrets"');
    expect(devSh).toContain('export BOTTEGA_PUBLIC_BASE_URL_FILE="$(shared_data_dir)/public-base-url"');
    expect(devSh).toContain('export BOTTEGA_DEV_CERTS_DIR="$(shared_certs_dir)"');
  });

  test("the shared module preserves broker fallback, token readiness, and fail-closed HOME handling", () => {
    expect(bootstrap).toContain('"oh-my-pi/pi:dev"');
    expect(bootstrap).toContain('["omp", "auth-broker", "serve", "--bind=0.0.0.0:8765"]');
    expect(bootstrap).toContain("brokerTokenReady");
    expect(bootstrap).toContain("is outside HOME");
  });

  test("the shared module serializes and validates the canonical CA", () => {
    expect(bootstrap).toContain('join(config.certsDir, ".gen-lock")');
    expect(bootstrap).toContain('["openssl", "x509"');
    expect(bootstrap).toContain('["openssl", "rsa"');
    expect(bootstrap).toContain("cert.stdout.trim() !== key.stdout.trim()");
  });

  test("renders canonical host paths into Compose and the canonical egress env", () => {
    const vols = proxy["volumes"] as string[];
    expect(vols).toContain("${BOTTEGA_DEV_DATA_DIR:-./data}:/data");
    expect(vols).toContain("${BOTTEGA_DEV_CERTS_DIR:-./certs}:/etc/iron-proxy/certs:ro");
    const egressSrc = readFileSync(resolve(import.meta.dir, "../../scripts/canary-egress.ts"), "utf8");
    expect(egressSrc).toContain('process.env.BOTTEGA_DEV_CERTS_DIR ?? join(cwd, "certs")');
  });
});
