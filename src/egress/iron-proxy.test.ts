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
 * Issue #177 adds the missing halves of the safety model against the real
 * binary: the boundary's secrets transform (mode-0600 secret file written
 * per the #53 contract, POST /v1/reload with the management token, and the
 * injected Authorization header observed at the upstream — on allowlisted
 * hosts only), plus the version-bump tripwire (the image tag is read from
 * docker-compose.yml, so a proxy-upgrade PR must pass the leg before the
 * pin moves). The dev-permissive leg (issue #126) proves allow-all +
 * secrets + management on the real dev config.
 *
 * The judge transform from egress.yml is intentionally omitted: it needs the
 * NEARAI_JUDGE_API_KEY LLM round-trip (manual checklist, like the mem0 leg's
 * LLM key); the allowlist + default-deny + secrets + management layers are
 * what this leg proves.
 *
 * Skip-gated with evidence when Docker or the image is unavailable; hard
 * timeout so CI never hangs. The target server is local — no external
 * network is ever contacted. The CI integration lane (BOTTEGA_RUN_INTEGRATION=1)
 * treats any printed SKIP as a failure: a silently-skipped security test is
 * the worst outcome.
 */
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseYamlSubset, type YamlNode } from "../yaml-subset";
import { renderDevEgressConfig, renderSecretsTransform, SNAPSHOTS_DIR } from "./generate";
import { readPinnedSnapshots } from "../extensions/registry";
import {
  createSecretFileBoundary,
  extensionSecretFileName,
  PROXY_SECRETS_MOUNT_PATH,
} from "../extensions/boundary";
import type { ExtensionCredential } from "../store/db";

/**
 * The pinned iron-proxy image, read from docker-compose.yml (issue #177
 * version-bump tripwire): the leg runs against the SAME tag the deployment
 * pins, so a proxy-upgrade PR must pass the leg before the pin moves.
 * Throws when compose does not pin the image — the pin is the contract.
 */
function pinnedProxyImage(): string {
  const compose = readFileSync(resolve(import.meta.dir, "../../docker-compose.yml"), "utf8");
  const match = compose.match(/image:\s*(ironsh\/iron-proxy:[^\s#]+)/);
  if (!match) throw new Error("docker-compose.yml does not pin an ironsh/iron-proxy image");
  return match[1];
}

/** Pinned tiny image with nslookup, used to query the proxy's DNS. */
const DNS_CLIENT_IMAGE = "alpine:3.19";
/** Arbitrary sinkhole IP for the leg config; must never be a real host. */
const SINKHOLE_IP = "10.42.0.2";
/** Exact entry in config/egress.yml — the allowlisted target host. */
const ALLOWED_HOST = "cloud-api.near.ai";
/** Anything not on the allowlist must be blocked. */
const DENIED_HOST = "bottega-blocked.test";

/**
 * The egress.yml subset the legs read: each transform's name plus the
 * allowlist's config.domains (the shape regenerateEgressConfig writes;
 * everything else is stripped). The config is a generated artifact, so a
 * shape drift is a contract break the legs surface rather than guess at.
 */
const EgressConfigSchema = z.object({
  transforms: z
    .array(
      z.object({
        name: z.string(),
        config: z.object({ domains: z.array(z.string()).optional() }).optional(),
      }),
    )
    .optional(),
});

/** The allowlist transform's domains from an egress-config document, or undefined. */
function allowlistDomains(doc: Record<string, YamlNode>): string[] | undefined {
  const parsed = EgressConfigSchema.safeParse(doc);
  const allowlist = parsed.success
    ? parsed.data.transforms?.find((transform) => transform.name === "allowlist")
    : undefined;
  return allowlist?.config?.domains;
}

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
      const PROXY_IMAGE = pinnedProxyImage(); // compose pin — version-bump tripwire (#177)
      const egressCfg = parseYamlSubset(readFileSync(resolve(import.meta.dir, "../../config/egress.yml"), "utf8"));
      const domains = allowlistDomains(egressCfg);
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
      const targetPort = target.port;

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
      const PROXY_IMAGE = pinnedProxyImage(); // compose pin — version-bump tripwire (#177)
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
      const devParsed = EgressConfigSchema.safeParse(parseYamlSubset(devConfig));
      if (!devParsed.success) {
        throw new Error(
          `generated dev egress config does not match the expected shape: ${devParsed.error.issues[0]?.message ?? "unknown"}`,
        );
      }
      if (!devParsed.data.transforms?.some((t) => t.name === "secrets")) {
        skip("generated dev config has no secrets transform — cannot prove injection");
        return;
      }

      // Extension host with an injection rule; a host that IS on the strict
      // allowlist (the allow-all proof is PERMISSIVE_HOST below).
      const INJECT_HOST = "api.githubcopilot.com";
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
      const targetPort = target.port;

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

/**
 * Strict-config secrets leg (issue #177, gap #2): boots the pinned image
 * with a TEST-RENDERED strict config — the REAL allowlist domains from
 * config/egress.yml plus a leg-local target mapped to a local Bun.serve
 * upstream, the REAL generated secrets transform (renderSecretsTransform,
 * issue #53), and the management block (issue #123) — and proves, against
 * the actual binary:
 *   - a non-allowlisted host is 403'd and NEVER receives the injected
 *     Authorization header (the upstream never sees the request),
 *   - an allowlisted host without a secrets rule passes with NO header,
 *   - an allowlisted host with the rule receives the boundary's secret as
 *     `Authorization: Bearer <value>` — via the REAL boundary code path
 *     (mode-0600 write-temp + rename, POST /v1/reload with the management
 *     token), so rotation applies to a RUNNING proxy without a restart,
 *   - the secret file honors the mode-0600 boundary contract,
 *   - the management API is token-gated (a reload without the token 401s),
 *   - DNS sinkhole answers arbitrary names with the proxy IP.
 *
 * The judge transform is intentionally omitted (needs the
 * NEARAI_JUDGE_API_KEY LLM round-trip — documented manual checklist, same
 * as the strict leg above). Breaking the generated allowlist (removing a
 * domain this leg depends on) FAILS the leg — a silently-skipped security
 * test is the worst outcome.
 */
describe("iron-proxy strict secrets leg (skip-gated, issue #177)", () => {
  test(
    "default-deny, DNS sinkhole, and reload-injected Authorization on allowlisted-only",
    async () => {
      const skip = (reason: string) => {
        console.log(`[iron-proxy secrets leg] SKIP: ${reason}`);
      };
      if (process.env.BOTTEGA_RUN_INTEGRATION !== "1") {
        skip("integration leg skipped: set BOTTEGA_RUN_INTEGRATION=1 to run");
        return;
      }
      const PROXY_IMAGE = pinnedProxyImage(); // compose pin — version-bump tripwire (#177)

      // A real allowlisted extension host with a real secrets rule
      // (config/egress.yml -> mcp.attio.com + attio.secret injection).
      const INJECT_HOST = "mcp.attio.com";
      // Leg-local allowlisted host: passes the allowlist but has NO secrets
      // rule, so it must receive NO Authorization header.
      const LEG_TARGET = "bottega-leg-target.test";
      const DENIED_HOST = "bottega-blocked.test";
      const MGMT_TOKEN = "leg-mgmt-token";
      const SECRET_V1 = "leg-secret-v1";
      const SECRET_V2 = "leg-secret-v2";

      // 1. Allowlist domains from the deployment contract. The leg depends
      //    on INJECT_HOST being allowlisted: breaking the generated
      //    allowlist FAILS the leg (no skip).
      const egressCfg = parseYamlSubset(readFileSync(resolve(import.meta.dir, "../../config/egress.yml"), "utf8"));
      const realDomains = allowlistDomains(egressCfg);
      if (!realDomains?.includes(INJECT_HOST)) {
        // Tripwire: the generated allowlist lost the injection host — fail.
        throw new Error(`[iron-proxy secrets leg] generated allowlist lost ${INJECT_HOST} — default-deny is broken; refusing to skip`);
      }
      // Test-rendered allowlist: real domains + the leg-local target.
      const domains = [...realDomains, LEG_TARGET];

      // 2. Docker + pinned image present?
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

      // 3. Local upstream: records {host, Authorization} per request so the
      //    leg can prove who got the injected header — and who never did.
      const seen: Array<{ host: string; auth: string }> = [];
      const target = Bun.serve({
        hostname: "0.0.0.0",
        port: 0,
        fetch: (req) => {
          seen.push({ host: new URL(req.url).hostname, auth: req.headers.get("authorization") ?? "" });
          return new Response("target-ok");
        },
      });
      const targetPort = target.port;

      // 4. Temp dirs under data/ (gitignored; Docker Desktop bind-mounts).
      const dir = join(resolve(import.meta.dir, "../../data"), `ironproxy-secrets-leg-${process.pid}`);
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      const certsDir = join(dir, "certs");
      const secretsDir = join(dir, "secrets");
      const cfgPath = join(dir, "egress-secrets-leg.yml");
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

        // 5. The boundary's secret file for attio (the extension with an
        //    injection rule), written per the #53 contract BEFORE boot
        //    (mode 0600, write-temp + rename). Rotation via the REAL
        //    boundary below proves the reload path on a running proxy.
        const secretName = extensionSecretFileName("attio");
        const secretPath = join(secretsDir, secretName);
        writeFileSync(`${secretPath}.tmp`, SECRET_V1, { mode: 0o600 });
        renameSync(`${secretPath}.tmp`, secretPath);

        // 6. Test-rendered strict config: real allowlist + leg target, the
        //    REAL generated secrets transform, management (token-gated).
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
            "management:",
            '  listen: ":9092"',
            '  api_key_env: "IRON_MANAGEMENT_API_KEY"',
            "transforms:",
            "  - name: allowlist",
            "    config:",
            "      domains:",
            ...domains.map((d) => `        - "${d}"`),
            "",
            renderSecretsTransform([{ extensionId: "attio", domains: [INJECT_HOST] }]).trimEnd(),
            "log:",
            '  level: "error"',
            "",
          ].join("\n"),
        );

        const name = `bottega-ironproxy-secrets-${process.pid}`;
        const run = Bun.spawnSync(
          [
            "docker", "run", "-d", "--name", name,
            `--add-host=${INJECT_HOST}:host-gateway`,
            `--add-host=${LEG_TARGET}:host-gateway`,
            "-p", "127.0.0.1::80",
            "-p", "127.0.0.1::9092",
            "-e", `IRON_MANAGEMENT_API_KEY=${MGMT_TOKEN}`,
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
          const mgmtPort = Number((ports.match(/9092\/tcp -> 127\.0\.0\.1:(\d+)/) ?? [])[1]);
          if (!httpPort || !mgmtPort) {
            skip(`published ports not found in \`docker port ${name}\` output: ${ports.trim().slice(0, 120)}`);
            return;
          }

          // 7. Readiness: a proxied request to the denied host returns 403
          //    once the proxy is up (deny needs no upstream resolution).
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
            skip(`proxy never became reachable (${tail || "no logs"}). Manual checklist: run the image with the strict config locally and inspect.`);
            return;
          }

          // 8. Default-deny: the non-allowlisted host is 403'd and NEVER
          //    reaches the upstream — so it never receives the header.
          expect(denied.status).toBe(403);
          expect(seen.some((r) => r.host === DENIED_HOST)).toBe(false);

          // 9. Allowlisted host WITHOUT a secrets rule: passes, no header.
          const noRule = await fetch(`http://${LEG_TARGET}:${targetPort}/`, { proxy: proxyUrl });
          expect(noRule.status).toBe(200);
          expect(await noRule.text()).toBe("target-ok");
          expect(seen.at(-1)?.host).toBe(LEG_TARGET);
          expect(seen.at(-1)?.auth).toBe("");

          // 10. Allowlisted host WITH the rule: the boot-time secret file is
          //     injected as Bearer auth.
          const bootInjected = await fetch(`http://${INJECT_HOST}:${targetPort}/`, { proxy: proxyUrl });
          expect(bootInjected.status).toBe(200);
          expect(seen.at(-1)?.host).toBe(INJECT_HOST);
          expect(seen.at(-1)?.auth).toBe(`Bearer ${SECRET_V1}`);

          // 11. Management is token-gated: a reload without the token 401s.
          const noToken = await fetch(`http://127.0.0.1:${mgmtPort}/v1/reload`, { method: "POST" });
          expect(noToken.status).toBe(401);

          // 12. The #53 chain against the REAL binary: the boundary writes
          //     the rotated secret (mode 0600, write-temp + rename) and
          //     POSTs /v1/reload with the management token; the RUNNING
          //     proxy must now inject the new value without a restart.
          const boundary = createSecretFileBoundary({
            resolveSecret: async () => SECRET_V2,
            secretsDir,
            proxyControlUrl: `http://127.0.0.1:${mgmtPort}`,
            proxyControlToken: MGMT_TOKEN,
          });
          await boundary.authorize({
            id: "leg-attio",
            provider: "attio",
            vault_provider: "attio",
            identity_key: "leg",
            owner: null,
            scope: "org",
            broker_credential_id: 1,
            pending_vault_provider: null,
            pending_broker_credential_id: null,
            pending_identity_key: null,
            retiring_broker_credential_id: null,
            status: "active",
            revision: 1,
            created_at: Date.now(),
            updated_at: Date.now(),
          } satisfies ExtensionCredential);
          expect(statSync(secretPath).mode & 0o777).toBe(0o600);

          const reloadDeadline = Date.now() + 20_000;
          let rotated: string | null = null;
          while (Date.now() < reloadDeadline) {
            const res = await fetch(`http://${INJECT_HOST}:${targetPort}/`, { proxy: proxyUrl });
            if (res.status === 200 && seen.at(-1)?.auth === `Bearer ${SECRET_V2}`) {
              rotated = seen.at(-1)?.auth ?? null;
              break;
            }
            await Bun.sleep(500);
          }
          expect(rotated).toBe(`Bearer ${SECRET_V2}`);

          // 13. DNS sinkhole: every name answers with the configured proxy
          //     IP (queried from a helper container on the same bridge).
          const proxyIp = Bun.spawnSync(
            ["docker", "inspect", name, "--format", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}"],
            { timeout: 10_000 },
          ).stdout.toString().trim();
          const clientPullError = pullIfMissing(DNS_CLIENT_IMAGE);
          if (clientPullError) {
            console.log(`[iron-proxy secrets leg] DNS sinkhole assertion skipped: could not pull ${DNS_CLIENT_IMAGE} (${clientPullError})`);
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
