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
 *      api.githubcopilot.com, so a credential-less initialize to the HOSTED
 *      GitHub MCP (https://api.githubcopilot.com/mcp/, issue #145 — the
 *      github extension's streamable-http binding, no local binary)
 *      AUTHENTICATES (non-401 with a JSON-RPC result).
 *
 * The vault is the REAL omp auth-broker server (`omp auth-broker serve`,
 * the same CLI the oh-my-pi/pi:dev compose image runs) started against the
 * repo's gitignored data/.omp — the image itself is a private Docker Hub
 * repo not pullable here (scripts/e2e-smoke.sh skips the broker for the
 * same reason). The vault is seeded with the user's REAL GitHub credential
 * via the REAL connect path (`connectViaAuthBroker` -> broker upload) using
 * `gh auth token` from the keyring; the vault entry the store row
 * references must exist and carry an api_key, and the token is NEVER
 * printed — the leg only proves the API call's success (authenticated
 * initialize).
 *
 * The provider MCP server is HOSTED (api.githubcopilot.com — no local
 * binary), so the runtime's documented `mcpTransport` seam substitutes an
 * in-process MCP server that performs the same initialize call through the
 * dev proxy with NO credential — the proxy injection is what authenticates
 * it, exactly as it does for the real hosted server's sessions.
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
import { AuthBrokerClient } from "@oh-my-pi/pi-ai/auth-broker";
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

/** Runs a credential-less initialize against the HOSTED GitHub MCP through the REAL dev proxy in a fresh child (env at boot, like the dev server). */
async function callHostedMcpViaProxy(): Promise<{ status: number; body: string }> {
  const childEnv: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HTTP_PROXY: PROXY_URL,
    HTTPS_PROXY: PROXY_URL,
    NO_PROXY: "localhost,127.0.0.1",
    NODE_EXTRA_CA_CERTS: `${REPO_ROOT}/certs/ca.crt`,
  };
  const script = `const r = await fetch(${JSON.stringify("https://api.githubcopilot.com/mcp/")}, { method: "POST", headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "bottega-live-github", version: "1.0.0" } } }) }); console.log(r.status); console.log(await r.text());`;
  const proc = Bun.spawn(["bun", "-e", script], { env: childEnv, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const [statusLine, ...rest] = out.trim().split("\n");
  if (err.trim()) throw new Error(`github child stderr: ${err.trim()}`);
  return { status: Number(statusLine), body: rest.join("\n") };
}

let store: Store;
let brokerProc: ReturnType<typeof Bun.spawn> | null = null;
let brokerToken: string | null = null;

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
  // root. This leg's broker (spawned below, or the harness-managed dev
  // broker) runs against the REPO's data/.omp agent dir, so that token is
  // authoritative; ~/.omp is only a fallback for brokers rooted at the
  // default agent dir.
  const dockerCandidate = resolve(REPO_ROOT, "data/.omp/auth-broker.token");
  const candidate = resolve(process.env.HOME ?? "/", ".omp", "auth-broker.token");
  const tokenFile = existsSync(dockerCandidate) ? dockerCandidate : existsSync(candidate) ? candidate : null;
  if (!tokenFile) {
    skip("no broker token file found (~/.omp/auth-broker.token or data/.omp/auth-broker.token)");
    return;
  }
  brokerToken = readFileSync(tokenFile, "utf8").trim();
  process.env.OMP_AUTH_BROKER_URL = BROKER_URL;
  process.env.OMP_AUTH_BROKER_TOKEN = brokerToken;

  // Seed the vault with the user's REAL keyring GitHub credential via the
  // real connect path (idempotent: the vault keeps ONE api_key row per
  // provider — the upload upserts, so the resolver always finds it).
  const pat = Bun.spawnSync(["gh", "auth", "token"], { stdout: "pipe" }).stdout.toString().trim();
  if (!pat || pat.length < 20) {
    skip("`gh auth token` returned nothing usable");
    return;
  }
  await connectViaAuthBroker({ provider: "github", credentialType: "api_key", apiKey: pat });
});

afterAll(() => {
  if (brokerProc) {
    brokerProc.kill();
  }
  store?.close();
});

describe("auth-broker live leg (issue #143, skip-gated)", () => {
  test(
    "a github extension call with the caller's personal credential resolves the vault secret, injects it via the dev proxy, and the hosted GitHub MCP authenticates",
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
      // The vault entry the STORE row references (broker_credential_id)
      // must exist and carry an api_key secret — that is the entry the
      // boundary's resolver fetches at call time, and the full-chain proof
      // below exercises it (the resolved secret is injected by the dev
      // proxy and the hosted MCP authenticates). The seed upload above
      // upserts the vault's single github api_key row, so a re-running leg
      // over a pre-existing vault must not assume the upload's id matches.
      const snapshot = await new AuthBrokerClient({
        url: BROKER_URL,
        token: brokerToken ?? "",
      }).fetchSnapshot();
      if (snapshot.status !== 200) {
        skip(`broker snapshot fetch failed (status ${snapshot.status})`);
        return;
      }
      const referenced = snapshot.snapshot.credentials.find(
        (entry) => entry.id === personal!.broker_credential_id && entry.provider === "github",
      );
      expect(referenced).toBeDefined();
      expect(referenced!.credential.type).toBe("api_key");
      if (referenced!.credential.type === "api_key") {
        expect(referenced!.credential.key.length).toBeGreaterThan(20);
      }

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
            // Stand-in for the hosted github MCP server: performs the same
            // initialize call through the dev proxy with NO credential —
            // the proxy injects the Authorization header (the boundary's
            // secret file). A JSON-RPC result with serverInfo is the crisp
            // auth proof (an unauthenticated initialize is 401).
            const { status, body } = await callHostedMcpViaProxy();
            const text =
              status !== 401 && body.includes("serverInfo")
                ? "github hosted MCP: authenticated via the dev proxy"
                : `github error ${status}: ${body.slice(0, 120)}`;
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
      expect(text).toContain("github hosted MCP: authenticated via the dev proxy");
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

      // Independent direct proof: a credential-less initialize to the
      // hosted GitHub MCP through the dev proxy authenticates (non-401
      // with serverInfo) as the user's own credential.
      const direct = await callHostedMcpViaProxy();
      expect(direct.status).not.toBe(401);
      expect(direct.body).toContain("serverInfo");
      console.log(`[auth-broker live leg] hosted GitHub MCP initialize through the dev proxy: HTTP ${direct.status} (authenticated)`);
    },
    120_000,
  );
});
