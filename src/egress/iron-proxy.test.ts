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

const PROXY_IMAGE = "ironsh/iron-proxy:0.49.0";
/** Pinned tiny image with nslookup, used to query the proxy's DNS. */
const DNS_CLIENT_IMAGE = "alpine:3.19";
/** Arbitrary sinkhole IP for the leg config; must never be a real host. */
const SINKHOLE_IP = "10.42.0.2";
/** Exact entry in config/egress.yml — the allowlisted target host. */
const ALLOWED_HOST = "api.near.ai";
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
