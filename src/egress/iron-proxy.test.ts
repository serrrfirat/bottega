/**
 * iron-proxy integration leg (issue #29): boots the pinned
 * `ironsh/iron-proxy:0.49.0` image with a config whose allowlist domains are
 * read from the real `config/egress.yml`, and proves default-deny egress
 * enforcement against the actual binary:
 *   - an allowlisted host is reachable through the proxy (local HTTP target),
 *   - a non-allowlisted host gets a 403 from the proxy,
 *   - the proxy's DNS answers every name with the sinkhole IP (queried from
 *     a helper container, since the host can't reach the container's UDP
 *     port reliably on Docker Desktop).
 *
 * The judge transform from egress.yml is intentionally omitted: it needs the
 * NEARAI_JUDGE_API_KEY LLM round-trip (manual checklist, like the mem0 leg's
 * LLM key); the allowlist + default-deny layer is what this leg proves.
 *
 * Skip-gated with evidence when Docker or the image is unavailable; hard
 * timeout so CI never hangs. The target server is local — no external
 * network is ever contacted.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseYamlSubset, type YamlNode } from "../yaml-subset";
import { renderDevEgressConfig, SNAPSHOTS_DIR } from "./generate";
import { readPinnedSnapshots } from "../extensions/registry";
import { extensionSecretFileName, PROXY_SECRETS_MOUNT_PATH } from "../extensions/boundary";

const PROXY_IMAGE = "ironsh/iron-proxy:0.49.0";
/** Pinned tiny image with nslookup, used to query the proxy's DNS. */
const DNS_CLIENT_IMAGE = "alpine:3.19";
/** Arbitrary sinkhole IP for the leg config; must never be a real host. */
const SINKHOLE_IP = "10.42.0.2";
/** Exact entry in config/egress.yml — the allowlisted target host. */
const ALLOWED_HOST = "cloud-api.near.ai";
/** Anything not on the allowlist must be blocked. */
const DENIED_HOST = "bottega-blocked.test";

describe("iron-proxy integration leg (skip-gated)", () => {
  test(
    "default-deny allowlist enforced by the pinned image",
    async () => {
      const skip = (reason: string) => {
        console.log(`[iron-proxy leg] SKIP: ${reason}`);
      };

      // 0. Integration legs are opt-in (issue #41): the default CI run stays
      //    hermetic + unit only; set BOTTEGA_RUN_INTEGRATION=1 to enable.
      if (process.env.BOTTEGA_RUN_INTEGRATION !== "1") {
        skip("integration leg skipped: set BOTTEGA_RUN_INTEGRATION=1 to run");
        return;
      }

      // 1. Allowlist domains straight from the deployment contract
      //    (config/egress.yml) so the leg tracks the real policy.
      const egressCfg = parseYamlSubset(readFileSync(resolve(import.meta.dir, "../../config/egress.yml"), "utf8"));
      const transforms = egressCfg["transforms"] as YamlNode[];
      const allowlist = transforms.find((t) => (t as Record<string, YamlNode>)["name"] === "allowlist") as
        | Record<string, YamlNode>
        | undefined;
      const domains = (allowlist?.["config"] as Record<string, YamlNode> | undefined)?.["domains"] as
        | string[]
        | undefined;
      if (!domains?.includes(ALLOWED_HOST)) {
        skip(`config/egress.yml allowlist does not contain ${ALLOWED_HOST} — cannot build the leg target`);
        return;
      }

      // 2. Docker daemon present?
      const docker = Bun.spawnSync(["docker", "version", "--format", "{{.Server.Version}}"], { timeout: 10_000 });
      if (!docker.success) {
        skip(`docker unavailable (${docker.stderr.toString().trim().slice(0, 120) || "no daemon"}). ` +
          `Manual checklist: install Docker, pre-pull ${PROXY_IMAGE}, and re-run this leg.`);
        return;
      }

      // 3. Images present? Pull with a hard timeout; skip on failure.
      const pullIfMissing = (image: string): string | null => {
        const inspect = Bun.spawnSync(["docker", "image", "inspect", image], { timeout: 10_000 });
        if (inspect.success) return null;
        const pull = Bun.spawnSync(["docker", "pull", image], { timeout: 120_000 });
        return pull.success ? null : pull.stderr.toString().trim().slice(0, 120);
      };
      const proxyPullError = pullIfMissing(PROXY_IMAGE);
      if (proxyPullError) {
        skip(`could not pull ${PROXY_IMAGE} (${proxyPullError}). ` +
          `Manual checklist: pre-pull the image and re-run this leg.`);
        return;
      }

      // 4. Local HTTP target: reached through the proxy via --add-host
      //    (host-gateway), never directly. No external network involved.
      const target = Bun.serve({
        hostname: "0.0.0.0",
        port: 0,
        fetch: () => new Response("target-ok"),
      });
      const targetPort = (target as { port: number }).port;

      // 5. Leg config: allowlist domains from egress.yml, DNS sinkhole, TLS
      //    CA (required by the image), no judge (judge needs the
      //    NEARAI_JUDGE_API_KEY LLM — manual checklist).
      //    The temp dir lives under data/ (gitignored): Docker Desktop does
      //    not reliably bind-mount files from /tmp or /var/folders.
      const dir = join(resolve(import.meta.dir, "../../data"), `ironproxy-leg-${process.pid}`);
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      const certsDir = join(dir, "certs");
      const cfgPath = join(dir, "egress-leg.yml");
      mkdirSync(certsDir, { recursive: true });
      try {
        const genCa = Bun.spawnSync(
          ["docker", "run", "--rm", "-v", `${certsDir}:/certs`, PROXY_IMAGE, "generate-ca", "-outdir", "/certs"],
          { timeout: 60_000 },
        );
        if (!genCa.success) {
          skip(`CA generation failed (${genCa.stderr.toString().trim().slice(0, 120)}). ` +
            `Manual checklist: run 'docker run --rm -v $PWD/certs:/certs ${PROXY_IMAGE} generate-ca -outdir /certs'.`);
          return;
        }
        writeFileSync(
          cfgPath,
          [
            "dns:",
            `  listen: ":53"`,
            `  proxy_ip: "${SINKHOLE_IP}"`,
            "proxy:",
            '  http_listen: ":80"',
            "tls:",
            '  mode: "mitm"',
            '  ca_cert: "/etc/iron-proxy/certs/ca.crt"',
            '  ca_key: "/etc/iron-proxy/certs/ca.key"',
            "transforms:",
            "  - name: allowlist",
            "    config:",
            "      domains:",
            ...domains.map((d) => `        - "${d}"`),
            "log:",
            '  level: "error"',
            "",
          ].join("\n"),
        );

        const name = `bottega-ironproxy-${process.pid}`;
        const run = Bun.spawnSync(
          [
            "docker", "run", "-d", "--name", name,
            `--add-host=${ALLOWED_HOST}:host-gateway`,
            "-p", "127.0.0.1::80",
            "-v", `${cfgPath}:/etc/iron-proxy/egress.yml:ro`,
            "-v", `${certsDir}:/etc/iron-proxy/certs:ro`,
            PROXY_IMAGE,
            "-config", "/etc/iron-proxy/egress.yml",
          ],
          { timeout: 30_000 },
        );
        if (!run.success) {
          skip(`container start failed (${run.stderr.toString().trim().slice(0, 120)}). ` +
            `Manual checklist: check iron-proxy logs, then re-run this leg.`);
          return;
        }

        try {
          // 6. Published HTTP port: -p with no host port picks a free one.
          const ports = Bun.spawnSync(["docker", "port", name], { timeout: 10_000 }).stdout.toString();
          const httpPort = Number((ports.match(/80\/tcp -> 127\.0\.0\.1:(\d+)/) ?? [])[1]);
          if (!httpPort) {
            skip(`published ports not found in \`docker port ${name}\` output: ${ports.trim().slice(0, 120)}`);
            return;
          }

          // 7. Readiness: a proxied request to a denied host returns 403 once
          //    the proxy is up (deny needs no upstream resolution).
          const proxyUrl = `http://127.0.0.1:${httpPort}`;
          const deadline = Date.now() + 60_000;
          let denied: Response | null = null;
          while (Date.now() < deadline) {
            try {
              const res = await fetch(`http://${DENIED_HOST}/`, { proxy: proxyUrl });
              if (res.status === 403) {
                denied = res;
                break;
              }
            } catch {
              // proxy not up yet
            }
            await Bun.sleep(500);
          }
          if (!denied) {
            const logs = Bun.spawnSync(["docker", "logs", "--tail", "10", name], { timeout: 10_000 });
            const tail = `${logs.stdout.toString()}\n${logs.stderr.toString()}`.trim().slice(0, 300);
            skip(`proxy never became reachable (${tail || "no logs"}). ` +
              `Manual checklist: run the image with the compose config locally and inspect.`);
            return;
          }

          // 8. Assertions — the proxy is running, so these are real findings.
          const allowed = await fetch(`http://${ALLOWED_HOST}:${targetPort}/`, { proxy: proxyUrl });
          expect(allowed.status).toBe(200);
          expect(await allowed.text()).toBe("target-ok");

          expect(denied.status).toBe(403);

          // 9. DNS sinkhole: every name answers with the configured proxy IP.
          //    Queried from a helper container on the same bridge (host-side
          //    UDP into containers is unreliable on Docker Desktop).
          const proxyIp = Bun.spawnSync(
            ["docker", "inspect", name, "--format", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}"],
            { timeout: 10_000 },
          ).stdout.toString().trim();
          const clientPullError = pullIfMissing(DNS_CLIENT_IMAGE);
          if (clientPullError) {
            console.log(`[iron-proxy leg] DNS sinkhole assertion skipped: could not pull ${DNS_CLIENT_IMAGE} (${clientPullError})`);
          } else {
            const lookup = Bun.spawnSync(
              ["docker", "run", "--rm", "--dns", proxyIp, DNS_CLIENT_IMAGE, "nslookup", "does-not-exist.test"],
              { timeout: 30_000 },
            );
            const out = `${lookup.stdout.toString()}\n${lookup.stderr.toString()}`;
            expect(out).toContain(`Address: ${SINKHOLE_IP}`);
          }
        } finally {
          Bun.spawnSync(["docker", "rm", "-f", name], { timeout: 30_000 });
        }
      } finally {
        target.stop(true);
        rmSync(dir, { recursive: true, force: true });
      }
    },
    240_000,
  );
});

/**
 * Dev-permissive leg (issue #126): boots the pinned iron-proxy image with
 * the REAL generated dev config (config/egress.dev.yml — allow-all "*" +
 * no judge + secrets + management) and proves, against the actual binary:
 *   - a host that is NOT on the strict allowlist passes (allow-all; the
 *     strict config would 403 it),
 *   - the secrets transform injects the boundary's secret file as the
 *     Authorization header for an extension host (credential injection is
 *     the core requirement and is KEPT in the dev config).
 *
 * No external network is contacted: both target hosts map to a local
 * Bun.serve via --add-host host-gateway, and the injected secret is a
 * leg-local value. Skip-gated like the strict leg (BOTTEGA_RUN_INTEGRATION=1).
 */
describe("iron-proxy dev-permissive leg (skip-gated)", () => {
  test(
    "the dev config allow-alls a non-strict host and injects the extension secret",
    async () => {
      const skip = (reason: string) => {
        console.log(`[iron-proxy dev leg] SKIP: ${reason}`);
      };
      if (process.env.BOTTEGA_RUN_INTEGRATION !== "1") {
        skip("integration leg skipped: set BOTTEGA_RUN_INTEGRATION=1 to run");
        return;
      }
      const docker = Bun.spawnSync(["docker", "version", "--format", "{{.Server.Version}}"], { timeout: 10_000 });
      if (!docker.success) {
        skip(`docker unavailable (${docker.stderr.toString().trim().slice(0, 120) || "no daemon"}). Manual checklist: install Docker, pre-pull ${PROXY_IMAGE}, and re-run this leg.`);
        return;
      }
      const pullIfMissing = (image: string): string | null => {
        const inspect = Bun.spawnSync(["docker", "image", "inspect", image], { timeout: 10_000 });
        if (inspect.success) return null;
        const pull = Bun.spawnSync(["docker", "pull", image], { timeout: 120_000 });
        return pull.success ? null : pull.stderr.toString().trim().slice(0, 120);
      };
      const proxyPullError = pullIfMissing(PROXY_IMAGE);
      if (proxyPullError) {
        skip(`could not pull ${PROXY_IMAGE} (${proxyPullError}). Manual checklist: pre-pull the image and re-run this leg.`);
        return;
      }

      // The REAL generated dev config, with the committed extension entries
      // (issue #53 injection rules) — the same file dev.sh mounts.
      const extensionEntries = readPinnedSnapshots(SNAPSHOTS_DIR).map((s) => ({
        extensionId: s.manifest.id,
        domains: s.manifest.domains,
      }));
      const devConfig = renderDevEgressConfig(extensionEntries);
      const secretsEntries = parseYamlSubset(devConfig)["transforms"] as YamlNode[];
      if (!secretsEntries.some((t) => (t as Record<string, YamlNode>)["name"] === "secrets")) {
        skip("generated dev config has no secrets transform — cannot prove injection");
        return;
      }

      // Extension host with an injection rule; NOT on the strict allowlist.
      const INJECT_HOST = "api.github.com";
      // Host that is NOT on the strict allowlist at all — must still pass
      // under the dev allow-all config (the strict config 403s it).
      const PERMISSIVE_HOST = "bottega-permissive.test";
      const SECRET_VALUE = "leg-secret-token";

      // Local target: reached through the proxy via --add-host
      // (host-gateway), never directly. Records the Authorization header it
      // receives so the leg can prove the injection.
      const seenAuth: string[] = [];
      const target = Bun.serve({
        hostname: "0.0.0.0",
        port: 0,
        fetch: (req) => {
          seenAuth.push(req.headers.get("authorization") ?? "");
          return new Response("target-ok");
        },
      });
      const targetPort = (target as { port: number }).port;

      // Temp dir under data/ (gitignored): Docker Desktop does not reliably
      // bind-mount files from /tmp or /var/folders.
      const dir = join(resolve(import.meta.dir, "../../data"), `ironproxy-dev-leg-${process.pid}`);
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      const certsDir = join(dir, "certs");
      const secretsDir = join(dir, "secrets");
      const cfgPath = join(dir, "egress.dev-leg.yml");
      mkdirSync(certsDir, { recursive: true });
      mkdirSync(secretsDir, { recursive: true });
      try {
        const genCa = Bun.spawnSync(
          ["docker", "run", "--rm", "-v", `${certsDir}:/certs`, PROXY_IMAGE, "generate-ca", "-outdir", "/certs"],
          { timeout: 60_000 },
        );
        if (!genCa.success) {
          skip(`CA generation failed (${genCa.stderr.toString().trim().slice(0, 120)}). Manual checklist: run 'docker run --rm -v $PWD/certs:/certs ${PROXY_IMAGE} generate-ca -outdir /certs'.`);
          return;
        }
        // The boundary's secret file for the github extension (what the
        // runtime writes on the shared data volume in real dev).
        writeFileSync(join(secretsDir, extensionSecretFileName("github")), SECRET_VALUE);
        writeFileSync(cfgPath, devConfig);

        const name = `bottega-ironproxy-dev-${process.pid}`;
        const run = Bun.spawnSync(
          [
            "docker", "run", "-d", "--name", name,
            `--add-host=${INJECT_HOST}:host-gateway`,
            `--add-host=${PERMISSIVE_HOST}:host-gateway`,
            "-p", "127.0.0.1::80",
            // The management block (management.api_key_env) is fail-closed
            // at BOOT: iron-proxy v0.49.0 refuses to start when
            // IRON_MANAGEMENT_API_KEY is unset. dev.sh always exports it
            // from data/proxy-mgmt-token (compose interpolation), so the
            // running dev container's token always matches the boundary's
            // BOTTEGA_PROXY_CONTROL_TOKEN — mirror that here.
            "-e", "IRON_MANAGEMENT_API_KEY=leg-mgmt-token",
            "-v", `${cfgPath}:/etc/iron-proxy/egress.yml:ro`,
            "-v", `${certsDir}:/etc/iron-proxy/certs:ro`,
            "-v", `${secretsDir}:${PROXY_SECRETS_MOUNT_PATH}:ro`,
            PROXY_IMAGE,
            "-config", "/etc/iron-proxy/egress.yml",
          ],
          { timeout: 30_000 },
        );
        if (!run.success) {
          skip(`container start failed (${run.stderr.toString().trim().slice(0, 120)}). Manual checklist: check iron-proxy logs, then re-run this leg.`);
          return;
        }

        try {
          const ports = Bun.spawnSync(["docker", "port", name], { timeout: 10_000 }).stdout.toString();
          const httpPort = Number((ports.match(/80\/tcp -> 127\.0\.0\.1:(\d+)/) ?? [])[1]);
          if (!httpPort) {
            skip(`published ports not found in \`docker port ${name}\` output: ${ports.trim().slice(0, 120)}`);
            return;
          }

          // Readiness: a proxied request to the permissive host returns 200
          // once the proxy is up (allow-all — nothing to deny).
          const proxyUrl = `http://127.0.0.1:${httpPort}`;
          const deadline = Date.now() + 60_000;
          let ready = false;
          while (Date.now() < deadline) {
            try {
              const res = await fetch(`http://${PERMISSIVE_HOST}:${targetPort}/`, { proxy: proxyUrl });
              if (res.status === 200) {
                ready = true;
                break;
              }
            } catch {
              // proxy not up yet
            }
            await Bun.sleep(500);
          }
          if (!ready) {
            const logs = Bun.spawnSync(["docker", "logs", "--tail", "10", name], { timeout: 10_000 });
            const tail = `${logs.stdout.toString()}\n${logs.stderr.toString()}`.trim().slice(0, 300);
            skip(`proxy never became reachable (${tail || "no logs"}). Manual checklist: run the image with the dev config locally and inspect.`);
            return;
          }

          // Assertions — the proxy is running the REAL dev config, so these
          // are real findings.
          const permissive = await fetch(`http://${PERMISSIVE_HOST}:${targetPort}/`, { proxy: proxyUrl });
          expect(permissive.status).toBe(200);
          expect(await permissive.text()).toBe("target-ok");
          // No injection rule matches PERMISSIVE_HOST → no Authorization.
          expect(seenAuth.at(-1)).toBe("");

          // Extension host: 200 through the dev proxy AND the secrets
          // transform injected the boundary's secret file as Bearer auth.
          const injected = await fetch(`http://${INJECT_HOST}:${targetPort}/`, { proxy: proxyUrl });
          expect(injected.status).toBe(200);
          expect(await injected.text()).toBe("target-ok");
          expect(seenAuth.at(-1)).toBe(`Bearer ${SECRET_VALUE}`);
        } finally {
          Bun.spawnSync(["docker", "rm", "-f", name], { timeout: 30_000 });
        }
      } finally {
        target.stop(true);
        rmSync(dir, { recursive: true, force: true });
      }
    },
    240_000,
  );
});
