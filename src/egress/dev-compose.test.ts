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
    expect(vols.some((v) => v.startsWith("./certs:") && v.endsWith(":ro"))).toBe(true);
    // The canonical data dir is interpolated by scripts/dev.sh (which exports
    // BOTTEGA_DEV_DATA_DIR=shared_data_dir, issue #301/#293): every worktree's
    // dev stack binds the SAME canonical data/ — required once worktrees share
    // one Compose project (else the mount flips on every boot from a
    // different worktree). The `${...:-./data}` fallback keeps the bare
    // `docker compose` invocation from docs/troubleshooting on ./data.
    expect(vols).toContain("${BOTTEGA_DEV_DATA_DIR:-./data}:/data");
    // The dev proxy must NOT use the compose named volume: the host server
    // writes secret files to ./data/proxy-secrets (PROXY_SECRETS_DIR) and
    // the generated egress config reads them at /data/proxy-secrets
    // (PROXY_SECRETS_MOUNT_PATH) — one relative path, both topologies.
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

describe("scripts/dev.sh broker wiring contract (issue #143)", () => {
  const devSh = readFileSync(resolve(import.meta.dir, "../../scripts/dev.sh"), "utf8");

  test("starts the auth-broker through the same compose dev override", () => {
    expect(devSh).toContain('"${COMPOSE_DEV[@]}" up -d auth-broker');
  });

  test("waits for the token file AND the broker health probe before exporting env", () => {
    expect(devSh).toContain("data/.omp/auth-broker.token");
    expect(devSh).toContain("http://127.0.0.1:8765/v1/healthz");
  });

  test("exports the resolver's env contract from the 0600 token file", () => {
    expect(devSh).toContain('export OMP_AUTH_BROKER_URL="http://127.0.0.1:8765"');
    expect(devSh).toContain('export OMP_AUTH_BROKER_TOKEN="$(<data/.omp/auth-broker.token)"');
  });

  test("fails loudly with the remedy when the broker cannot become ready (never silent)", () => {
    expect(devSh).toContain("auth-broker did not become ready");
    expect(devSh).toContain("docker pull oh-my-pi/pi:dev");
    expect(devSh).toContain("exit 1");
  });
});

describe("scripts/dev.sh shared dev stack wiring (issue #301)", () => {
  const devSh = readFileSync(resolve(import.meta.dir, "../../scripts/dev.sh"), "utf8");

  test("pins ONE canonical Compose project so every worktree reuses the same egress network", () => {
    // The fix: a worktree's `compose up` must target the CANONICAL checkout's
    // project name (issue #301), not its own dir basename — otherwise each
    // worktree creates a fresh <worktree>_egress network on the same explicit
    // 172.30.0.0/24 subnet and Docker rejects the second with "invalid pool
    // request: Pool overlaps with other one on this address space".
    expect(devSh).toContain('export COMPOSE_PROJECT_NAME="$(dev_compose_project)"');
  });

  test("binds the CANONICAL data dir so the shared project's mounts do not flip between worktrees", () => {
    // Sharing one project across worktrees REQUIRES a stable /data bind;
    // dev.sh points it at the shared_data_dir (the same canonical store
    // #293 already routes BOTTEGA_PUBLIC_BASE_URL_FILE through).
    expect(devSh).toContain('export BOTTEGA_DEV_DATA_DIR="$(shared_data_dir)"');
    // The two env exports must come from the shared helper (sourced once),
    // reusing its canonical-checkout resolution rather than duplicating it.
    expect(devSh).toContain('. "$(dirname "$0")/shared-data-dir.sh"');
  });
});
