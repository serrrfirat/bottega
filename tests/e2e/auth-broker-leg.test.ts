/**
 * Auth-broker live leg (issue #143, skip-gated on BOTTEGA_RUN_INTEGRATION=1):
 * proves the FULL local-dev credential chain against REAL infrastructure —
 * a running auth-broker vault, the REAL dev iron-proxy (the one
 * scripts/dev.sh brings up: config/egress.dev.yml with the secrets +
 * management transforms), the REAL bottega store (data/bottega.db), and
 * REAL GitHub.
 *
 * Chain under test (mirrors what a `bun run dev` extension call does after
 * the #143 wiring):
 *   1. policy gate + credential ladder resolve the caller's personal
 *      `github` credential (store row -> broker_credential_id);
 *   2. the boundary's broker secret resolver (issue #54 wiring) fetches the
 *      secret payload from the vault over OMP_AUTH_BROKER_URL/TOKEN;
 *   3. the boundary writes data/proxy-secrets/github.secret (0600) and
 *      reloads the dev proxy (POST /v1/reload);
 *   4. the dev proxy injects `Authorization: Bearer <secret>` for
 *      api.github.com, so a credential-less GitHub API call SUCCEEDS.
 *
 * The vault is the REAL omp auth-broker server (`omp auth-broker serve`,
 * the same CLI the oh-my-pi/pi:dev compose image runs) started against the
 * repo's gitignored data/.omp — the image itself is a private Docker Hub
 * repo not pullable here (scripts/e2e-smoke.sh skips the broker for the
 * same reason). The vault is seeded with the user's REAL GitHub credential
 * via the REAL connect path (`connectViaAuthBroker` -> broker upload) using
 * `gh auth token` from the keyring; the seed's broker_credential_id is
 * asserted to match the store row's, and the token is NEVER printed — the
 * leg only proves the API call's success (login, status).
 *
 * The provider MCP server (github-mcp-server, stdio) is not installed on
 * this host, so the runtime's documented `mcpTransport` seam substitutes an
 * in-process MCP server that performs the same GitHub API call through the
 * dev proxy with NO credential — the proxy injection is what authenticates
 * it, exactly as it would for the real server's outbound calls.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  brokerSecretResolverFromEnv,
  createSecretFileBoundary,
  extensionSecretFileName,
  PROXY_SECRETS_DIR,
  proxyBoundaryControlFromEnv,
} from "../../src/extensions/boundary";
import { createExtensionRegistry } from "../../src/extensions/registry";
import { createExtensionRuntime } from "../../src/extensions/runtime";
import { connectViaAuthBroker } from "../../src/extensions/connect";
import { createAudit } from "../../src/policy/audit";
import { DenyRouter } from "../../src/policy/approval-router";
import { loadOrgPolicy } from "../../src/policy/config";
import { createStore, type Store } from "../../src/store/db";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const BROKER_URL = "http://127.0.0.1:8765";
const PROXY_URL = "http://127.0.0.1:8080";
const MGMT_URL = "http://127.0.0.1:9092";
const CALLER = "U0B9QUPCTJ5";

function skip(reason: string): void {
  console.log(`[auth-broker live leg] SKIP: ${reason}`);
}

/** Runs a credential-less GitHub API call through the REAL dev proxy in a fresh child (env at boot, like the dev server). */
async function callGithubViaProxy(path: string): Promise<{ status: number; body: string }> {
  const childEnv: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HTTP_PROXY: PROXY_URL,
    HTTPS_PROXY: PROXY_URL,
    NO_PROXY: "localhost,127.0.0.1",
    NODE_EXTRA_CA_CERTS: `${REPO_ROOT}/certs/ca.crt`,
  };
  const proc = Bun.spawn(
    ["bun", "-e", `const r = await fetch(${JSON.stringify(`https://api.github.com${path}`)}); console.log(r.status); console.log(await r.text());`],
    { env: childEnv, stdout: "pipe", stderr: "pipe" },
  );
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const [statusLine, ...rest] = out.trim().split("\n");
  if (err.trim()) throw new Error(`github child stderr: ${err.trim()}`);
  return { status: Number(statusLine), body: rest.join("\n") };
}

let store: Store;
let brokerProc: ReturnType<typeof Bun.spawn> | null = null;
let brokerToken: string | null = null;
let seededBrokerId = 0;

beforeAll(async () => {
  if (process.env.BOTTEGA_RUN_INTEGRATION !== "1") {
    skip("set BOTTEGA_RUN_INTEGRATION=1 to run");
    return;
  }
  const omp = Bun.spawnSync(["bash", "-c", "command -v omp"], { stdout: "pipe" });
  if (!omp.success) {
    skip("`omp` CLI not on PATH — the auth-broker server is not runnable locally");
    return;
  }
  const gh = Bun.spawnSync(["gh", "auth", "status"], { stdout: "pipe", stderr: "pipe" });
  if (!gh.success) {
    skip("`gh auth status` failed — no keyring GitHub credential to seed the vault (gh auth login)");
    return;
  }
  // The dev proxy (scripts/dev.sh) must be up with the management token
  // matching data/proxy-mgmt-token — the boundary's reload must succeed.
  const mgmtToken = readFileSync(resolve(REPO_ROOT, "data/proxy-mgmt-token"), "utf8").trim();
  const mgmtProbe = await fetch(`${MGMT_URL}/v1/reload`, {
    method: "POST",
    headers: { Authorization: `Bearer ${mgmtToken}` },
  });
  if (mgmtProbe.status !== 200) {
    skip(`dev iron-proxy not answering the management API (status ${mgmtProbe.status}) — start it with scripts/dev.sh first`);
    return;
  }
  process.env.BOTTEGA_PROXY_CONTROL_URL = MGMT_URL;
  process.env.BOTTEGA_PROXY_CONTROL_TOKEN = mgmtToken;

  // Broker: reuse an already-serving 8765 (e.g. the docker one) or spawn
  // the local omp CLI broker against the repo's gitignored data/.omp.
  let healthzOk = false;
  try {
    const h = await fetch(`${BROKER_URL}/v1/healthz`);
    healthzOk = h.ok;
  } catch {
    healthzOk = false;
  }
  if (!healthzOk) {
    brokerProc = Bun.spawn(["omp", "auth-broker", "serve", "--bind=127.0.0.1:8765"], {
      cwd: REPO_ROOT,
      env: { ...process.env, PI_CODING_AGENT_DIR: resolve(REPO_ROOT, "data/.omp") },
      stdout: "pipe",
      stderr: "pipe",
    });
    let up = false;
    for (let i = 0; i < 30; i++) {
      try {
        const h = await fetch(`${BROKER_URL}/v1/healthz`);
        if (h.ok) {
          up = true;
          break;
        }
      } catch {
        // not up yet
      }
      await Bun.sleep(500);
    }
    if (!up) {
      const err = await new Response(brokerProc.stderr as ReadableStream).text();
      skip(`local auth-broker did not become healthy (${err.trim().slice(0, 200)})`);
      return;
    }
  }
  // The broker CLI bootstraps its token (0600) at the agent-dir config
  // root; that is the token the resolver must present.
  const candidate = resolve(process.env.HOME ?? "/", ".omp", "auth-broker.token");
  const dockerCandidate = resolve(REPO_ROOT, "data/.omp/auth-broker.token");
  const tokenFile = existsSync(candidate) ? candidate : existsSync(dockerCandidate) ? dockerCandidate : null;
  if (!tokenFile) {
    skip("no broker token file found (~/.omp/auth-broker.token or data/.omp/auth-broker.token)");
    return;
  }
  brokerToken = readFileSync(tokenFile, "utf8").trim();
  process.env.OMP_AUTH_BROKER_URL = BROKER_URL;
  process.env.OMP_AUTH_BROKER_TOKEN = brokerToken;

  // Seed the vault with the user's REAL keyring GitHub credential via the
  // real connect path (idempotent: uploadCredential upserts per provider).
  const pat = Bun.spawnSync(["gh", "auth", "token"], { stdout: "pipe" }).stdout.toString().trim();
  if (!pat || pat.length < 20) {
    skip("`gh auth token` returned nothing usable");
    return;
  }
  const seeded = await connectViaAuthBroker({ provider: "github", credentialType: "api_key", apiKey: pat });
  seededBrokerId = seeded.brokerCredentialId;
});

afterAll(() => {
  if (brokerProc) {
    brokerProc.kill();
  }
  store?.close();
});

describe("auth-broker live leg (issue #143, skip-gated)", () => {
  test(
    "a github extension call with the caller's personal credential resolves the vault secret, injects it via the dev proxy, and GitHub answers 200",
    async () => {
      if (process.env.BOTTEGA_RUN_INTEGRATION !== "1" || !brokerToken) {
        skip("preconditions not met (see beforeAll)");
        return;
      }
      // The REAL store: the user's personal github credential row
      // (owner U0B9QUPCTJ5 -> broker_credential_id). The seeded vault id
      // must match it — a divergent deployed vault would fail closed here.
      store = createStore(resolve(REPO_ROOT, "data/bottega.db"));
      const rows = await store.listExtensionCredentials("github");
      const personal = rows.find((row) => row.scope === "personal" && row.owner === CALLER);
      expect(personal).toBeDefined();
      expect(seededBrokerId).toBe(personal!.broker_credential_id);

      const registry = createExtensionRegistry(resolve(REPO_ROOT, "config/extensions"));
      const runtime = createExtensionRuntime({
        registry,
        store,
        audit: createAudit(store),
        orgPolicy: loadOrgPolicy(store),
        router: DenyRouter,
        boundary: createSecretFileBoundary({
          ...proxyBoundaryControlFromEnv(),
          resolveSecret: brokerSecretResolverFromEnv(),
        }),
        mcpTransport: (): Transport => {
          const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
          const server = new Server(
            { name: "bottega-live-github", version: "1.0.0" },
            { capabilities: { tools: {} } },
          );
          server.setRequestHandler(CallToolRequestSchema, async () => {
            // Stand-in for the real github-mcp-server: performs the GitHub
            // API call through the dev proxy with NO credential — the
            // proxy injects the Authorization header (the boundary's
            // secret file). /user is the crisp auth proof.
            const { status, body } = await callGithubViaProxy("/user");
            const parsed = JSON.parse(body) as { login?: string; message?: string };
            const text = status === 200 && parsed.login
              ? `github user: ${parsed.login} (authenticated via the dev proxy)`
              : `github error ${status}: ${parsed.message ?? body.slice(0, 120)}`;
            return { content: [{ type: "text", text }] };
          });
          void server.connect(serverTransport);
          return clientTransport;
        },
      });

      const before = await store.listAudit({ event_type: "extension.call" });
      const result = await runtime.execute({
        extensionId: "github",
        toolName: "github.search_issues",
        args: { query: "repo:serrrfirat/bottega is:issue", limit: 3 },
        caller: CALLER,
      });

      // The provider call (through the proxy) succeeded with the injected
      // credential — the token value itself is never printed.
      expect(result.ok).toBe(true);
      const text = result.ok
        ? result.content.map((block) => ("text" in block ? block.text : "")).join("")
        : result.error;
      expect(text).toContain("github user: ");
      expect(text).not.toContain("gho_");
      expect(text).not.toContain("github_pat");

      // The boundary wrote the extension's secret file (0600) on the shared
      // data dir the dev proxy mounts.
      const secretFile = resolve(REPO_ROOT, PROXY_SECRETS_DIR, extensionSecretFileName("github"));
      expect(existsSync(secretFile)).toBe(true);
      expect(statSync(secretFile).mode & 0o777).toBe(0o600);

      // The runtime audited the call on the REAL trail (gate allow +
      // credential resolved -> call executed).
      const after = await store.listAudit({ event_type: "extension.call" });
      const fresh = after.filter(
        (row) => row.actor === CALLER && !before.some((old) => old.id === row.id),
      );
      expect(fresh.length).toBe(1);
      expect(fresh[0].payload).toContain('"extension":"github"');
      expect(fresh[0].payload).toContain('"decision":"allow"');

      // Independent direct proof: a credential-less /user call through the
      // dev proxy succeeds (200) as the user's own account.
      const direct = await callGithubViaProxy("/user");
      expect(direct.status).toBe(200);
      const parsed = JSON.parse(direct.body) as { login?: string };
      expect(parsed.login).toBeTruthy();
      console.log(`[auth-broker live leg] GitHub /user through the dev proxy: 200 as ${parsed.login}`);
    },
    120_000,
  );
});
