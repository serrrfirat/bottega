/**
 * Local-dev iron-proxy override (issue #123): docker-compose.dev.yml is the
 * dev-only delta on top of docker-compose.yml — host-reachable listeners
 * and the host's gitignored ./data bind, so `bun run dev` (scripts/dev.sh)
 * reuses the SAME committed config/egress.yml as compose while the host
 * server's boundary secret files (data/proxy-secrets) are what the proxy
 * injects. The base compose file keeps NO published ports (deployment
 * invariant, asserted in compose.test.ts).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseYamlSubset, type YamlNode } from "../yaml-subset";
import { PROXY_SECRETS_DIR, PROXY_SECRETS_MOUNT_PATH } from "../extensions/boundary";

const dev = parseYamlSubset(
  readFileSync(resolve(import.meta.dir, "../../docker-compose.dev.yml"), "utf8"),
);

const proxy = (dev["services"] as Record<string, YamlNode>)["iron-proxy"] as Record<string, YamlNode>;

describe("docker-compose.dev.yml (issue #123 local-dev iron-proxy override)", () => {
  test("overrides ONLY iron-proxy (no other service is touched)", () => {
    expect(Object.keys(dev["services"] as Record<string, YamlNode>).sort()).toEqual(["iron-proxy"]);
  });

  test("publishes the tunnel + management listeners bound to loopback only", () => {
    const ports = proxy["ports"] as string[];
    expect(ports.sort()).toEqual(["127.0.0.1:8080:8080", "127.0.0.1:9092:9092"]);
  });

  test("keeps the committed config + CA mounts and binds the host ./data at /data", () => {
    const vols = proxy["volumes"] as string[];
    expect(vols).toContain("./config/egress.yml:/etc/iron-proxy/egress.yml:ro");
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
});
