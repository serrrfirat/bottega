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

const devServices = dev["services"] as Record<string, YamlNode>;
const proxy = devServices["iron-proxy"] as Record<string, YamlNode>;
const broker = devServices["auth-broker"] as Record<string, YamlNode>;
const baseBroker = (base["services"] as Record<string, YamlNode>)["auth-broker"] as Record<string, YamlNode>;

describe("docker-compose.dev.yml (local-dev overrides: iron-proxy #123, auth-broker #143)", () => {
  test("overrides ONLY iron-proxy and auth-broker (no other service is touched)", () => {
    expect(Object.keys(devServices).sort()).toEqual(["auth-broker", "iron-proxy"]);
  });

  test("publishes the tunnel + management listeners bound to loopback only", () => {
    const ports = proxy["ports"] as string[];
    expect(ports.sort()).toEqual(["127.0.0.1:8080:8080", "127.0.0.1:9092:9092"]);
  });

  test("mounts the dev-permissive config (not the strict one), CA, and the host ./data at /data", () => {
    const vols = proxy["volumes"] as string[];
    expect(vols).toContain("./config/egress.dev.yml:/etc/iron-proxy/egress.yml:ro");
    // The dev proxy must NOT mount the STRICT config/egress.yml: the dev
    // config (allow-all + no judge, issue #126) is what makes local testing
    // pass; the strict config stays the deployment contract (base compose).
    expect(vols).not.toContain("./config/egress.yml:/etc/iron-proxy/egress.yml:ro");
    expect(vols.some((v) => v.startsWith("./certs:") && v.endsWith(":ro"))).toBe(true);
    expect(vols).toContain("./data:/data");
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
    const ports = broker["ports"] as string[];
    expect(ports.sort()).toEqual(["127.0.0.1:8765:8765"]);
    // The serve port must match the base service's command + healthcheck,
    // so the override only exposes what the broker already listens on.
    const baseCommand = baseBroker["command"] as string[];
    expect(baseCommand).toContain("--bind=0.0.0.0:8765");
    const healthcheck = (baseBroker["healthcheck"] as Record<string, YamlNode>)["test"] as string[];
    expect(healthcheck).toContain("http://127.0.0.1:8765/v1/healthz");
  });

  test("auth-broker swaps the named data volume for the host ./data bind (entrypoints mount stays inherited)", () => {
    const vols = broker["volumes"] as string[];
    // The broker's token bootstraps to /data/.omp/auth-broker.token (0600,
    // entrypoints/broker.sh); on the host that is ./data/.omp/auth-broker.token,
    // which scripts/dev.sh reads for OMP_AUTH_BROKER_TOKEN. Compose merges
    // volumes by container path, so ./data:/data REPLACES the base
    // `data:/data` (the same dedup the iron-proxy override relies on).
    expect(vols).toContain("./data:/data");
    expect(vols).not.toContain("data:/data");
    // The entrypoints mount (the token bootstrap) is inherited from the
    // base service untouched — the override lists only its deltas.
    expect(vols).toEqual(["./data:/data"]);
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
