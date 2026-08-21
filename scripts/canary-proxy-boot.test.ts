/**
 * Hermetic regression for issue #304: the CI live-API canary must boot an
 * ephemeral iron-proxy (the same permissive dev config local dev rides)
 * and seed its credential secret files BEFORE scripts/canary-egress.ts
 * probes the tunnel — otherwise the scheduled leg fails closed with
 * "iron-proxy not reachable" (issue #241). These tests pin the
 * caller-surface contract of scripts/canary-proxy-boot.ts:
 *   - the boot env derives the canonical dev-topology dirs (data/certs/
 *     proxy-secrets) from the checkout, with the proxy's read path
 *     matching PROXY_SECRETS_MOUNT_PATH (one relative path, both
 *     topologies);
 *   - the management token persists 0600 and is reused across boots;
 *   - the compose command boots the iron-proxy service via the base +
 *     dev override files;
 *   - readiness is the dev.sh POST /v1/reload probe (never prints the
 *     token) and polled until the deadline;
 *   - the end-to-end boot (CA → compose up → readiness → credential sync)
 *     publishes the boundary env and fails closed on any step.
 * All docker side effects are stubbed — the tests never touch a daemon.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DockerRun, ManagementProbe } from "./canary-proxy-boot";
import type { ProxyCredentialSyncOpts } from "../src/extensions/proxy-seed";
import { PROXY_SECRETS_MOUNT_PATH } from "../src/extensions/boundary";
import {
  BOOT_ENV_KEYS,
  CANARY_PROXY_IMAGE,
  COMPOSE_FILES,
  MANAGEMENT_URL,
  PROXY_TUNNEL_URL,
  bootCanaryProxy,
  composeCommand,
  ensureCanaryCa,
  managementProbe,
  managementToken,
  proxyBootEnv,
  waitForManagement,
} from "./canary-proxy-boot";

interface FreshCwd {
  cwd: string;
  cleanup: () => void;
}

function freshCwd(): FreshCwd {
  const cwd = join(tmpdir(), `canary-proxy-boot-${process.pid}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(cwd, { recursive: true });
  return { cwd, cleanup: () => undefined }; // tmpdir entries are fine to leave; tests stay isolated
}

interface RecordedRun {
  run: DockerRun;
  calls: string[][];
}

/** Stub docker runner that records invocations and returns a scripted outcome. */
function stubRun(result: { status: number; error?: string } = { status: 0 }): RecordedRun {
  const calls: string[][] = [];
  return {
    calls,
    run: (cmd) => {
      calls.push([...cmd]);
      return { ...result };
    },
  };
}

const okProbe: ManagementProbe = async () => true;

describe("proxyBootEnv derives the canary dev-topology dirs (issue #304)", () => {
  test("pins data/, certs/, and proxy-secrets to the checkout root", () => {
    const { cwd, cleanup } = freshCwd();
    try {
      const env = proxyBootEnv(cwd);
      expect(env.root).toBe(cwd);
      expect(env.dataDir).toBe(join(cwd, "data"));
      expect(env.certsDir).toBe(join(cwd, "certs"));
      expect(env.secretsDir).toBe(join(cwd, "data", "proxy-secrets"));
      expect(env.mgmtTokenFile).toBe(join(cwd, "data", "proxy-mgmt-token"));
      expect(env.controlUrl).toBe("http://127.0.0.1:9092");
    } finally {
      cleanup();
    }
  });

  test("the proxy's read path matches PROXY_SECRETS_MOUNT_PATH (one relative path, both topologies)", () => {
    const env = proxyBootEnv(process.cwd());
    // The host secrets dir (what the sync writes) is what the container sees
    // at /data/proxy-secrets (PROXY_SECRETS_MOUNT_PATH) via the dev override's
    // ${BOTTEGA_DEV_DATA_DIR:-./data}:/data mount — the #301 single-path rule.
    expect(env.secretsDir).toBe(join(env.root, "data", "proxy-secrets"));
    expect(PROXY_SECRETS_MOUNT_PATH).toBe("/data/proxy-secrets");
  });
});

describe("composeCommand boots the canary proxy via base + dev override (issue #304)", () => {
  test("targets the iron-proxy service with the base + dev override files", () => {
    const cwd = "/repo";
    const cmd = composeCommand(cwd);
    expect(cmd[0]).toBe("docker");
    expect(cmd[1]).toBe("compose");
    expect(cmd).toContain("-f docker-compose.yml");
    expect(cmd).toContain("-f docker-compose.dev.yml");
    expect(cmd).toContain("up");
    expect(cmd).toContain("-d");
    expect(cmd[cmd.length - 1]).toBe("iron-proxy");
  });

  test("the file list matches the dev.sh topology (same two compose files)", () => {
    expect(COMPOSE_FILES).toEqual(["docker-compose.yml", "docker-compose.dev.yml"]);
  });
});

describe("managementToken persists 0600 and reuses across boots (issue #301)", () => {
  test("generates a random token into the data dir and reuses it on the next read", () => {
    const { cwd, cleanup } = freshCwd();
    try {
      const dataDir = join(cwd, "data");
      const first = managementToken(dataDir);
      const second = managementToken(dataDir);
      expect(first).toMatch(/^[0-9a-f]{32}$/);
      expect(second).toBe(first);
      const file = join(dataDir, "proxy-mgmt-token");
      expect(existsSync(file)).toBe(true);
      expect(readFileSync(file, "utf8").trim()).toBe(first);
    } finally {
      cleanup();
    }
  });

  test("the token file is mode 0600", () => {
    const { cwd, cleanup } = freshCwd();
    try {
      const dataDir = join(cwd, "data");
      managementToken(dataDir);
      const mode = statSync(join(dataDir, "proxy-mgmt-token")).mode & 0o777;
      expect(mode).toBe(0o600);
    } finally {
      cleanup();
    }
  });
});

describe("waitForManagement probes POST /v1/reload until ready or deadline (dev.sh semantics)", () => {
  test("returns true once the probe passes", async () => {
    const probe: ManagementProbe = async (url, token) => {
      expect(url).toBe(MANAGEMENT_URL);
      expect(token).not.toBe("");
      return true;
    };
    await expect(waitForManagement(MANAGEMENT_URL, "tok", probe, 5_000, 10)).resolves.toBe(true);
  });

  test("returns false when the probe never passes before the deadline", async () => {
    const failing: ManagementProbe = async () => false;
    await expect(waitForManagement(MANAGEMENT_URL, "tok", failing, 50, 5)).resolves.toBe(false);
  });

  test("managementProbe carries the token only in the Authorization header, never the URL", async () => {
    // The real probe (not a stub): capture the exact request it sends and
    // prove the token never leaks into the URL or any header value that the
    // proxy logs — the credential boundary's no-secret-echo contract (the
    // #304 "no secrets echoed" rule).
    let sawUrl = "";
    const headers: Record<string, string> = {};
    // SAFETY: assigning a narrower async fn to typeof fetch is sound because
    // the probe only ever invokes it with (URL, RequestInit) and reads only
    // the response `.ok` field; the double calls the global would allow are
    // never exercised here.
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      sawUrl = String(input);
      for (const [k, v] of Object.entries(init?.headers ?? {})) headers[k] = String(v);
      return new Response(null, { status: 200 });
    }) as typeof fetch;

    const ok = await managementProbe(MANAGEMENT_URL, "super-secret-token", fetcher);
    expect(ok).toBe(true);
    // The token is in the Authorization header only — the URL stays the bare
    // management endpoint and no other header carries it.
    expect(sawUrl).toBe(`${MANAGEMENT_URL}/v1/reload`);
    expect(sawUrl).not.toContain("super-secret-token");
    expect(headers["Authorization"]).toBe("Bearer super-secret-token");
    for (const [k, v] of Object.entries(headers)) {
      if (k !== "Authorization") expect(v).not.toContain("super-secret-token");
    }
  });
});

describe("ensureCanaryCa reuses the dev.sh generate-ca command (issue #301, no new crypto)", () => {
  test("generates the CA with the pinned image when ca.crt is missing", () => {
    const { cwd, cleanup } = freshCwd();
    try {
      const calls: string[][] = [];
      const run: DockerRun = (cmd) => {
        calls.push([...cmd]);
        const certs = join(cwd, "certs");
        mkdirSync(certs, { recursive: true });
        writeFileSync(join(certs, "ca.crt"), "ca");
        return { status: 0 };
      };
      const ok = ensureCanaryCa(join(cwd, "certs"), run);
      expect(ok).toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0]![0]).toBe("docker");
      expect(calls[0]!.includes("generate-ca")).toBe(true);
      expect(calls[0]!.includes(CANARY_PROXY_IMAGE)).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("skips generation when ca.crt already exists", () => {
    const { cwd, cleanup } = freshCwd();
    try {
      const certs = join(cwd, "certs");
      mkdirSync(certs, { recursive: true });
      writeFileSync(join(certs, "ca.crt"), "existing");
      const { run, calls } = stubRun();
      expect(ensureCanaryCa(certs, run)).toBe(true);
      expect(calls.length).toBe(0);
    } finally {
      cleanup();
    }
  });

  test("returns false when the generate-ca run fails", () => {
    const { cwd, cleanup } = freshCwd();
    try {
      const { run } = stubRun({ status: 1, error: "image not found" });
      expect(ensureCanaryCa(join(cwd, "certs"), run)).toBe(false);
    } finally {
      cleanup();
    }
  });
});

describe("bootCanaryProxy orchestrates CA → compose up → readiness → credential sync (issue #304)", () => {
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = {};
    for (const k of BOOT_ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test("publishes the boundary env and boots the proxy with a CA + readiness + sync", async () => {
    const { cwd, cleanup } = freshCwd();
    try {
      // Pre-create the MITM CA (the runner's generate-ca does this on first
      // boot); the orchestration tests focus on compose up → readiness → sync.
      mkdirSync(join(cwd, "certs"), { recursive: true });
      writeFileSync(join(cwd, "certs", "ca.crt"), "ca");
      const { run, calls } = stubRun();
      let synced: string | null = null;
      const sync = async (opts: ProxyCredentialSyncOpts) => {
        synced = opts.secretsDir ?? null;
      };

      const env = await bootCanaryProxy(cwd, { run, probe: okProbe, sync });

      // Env contract published for the container interpolation + the sync.
      expect(process.env.BOTTEGA_DEV_CERTS_DIR).toBe(env.certsDir);
      expect(process.env.BOTTEGA_DEV_DATA_DIR).toBe(env.dataDir);
      expect(process.env.BOTTEGA_PROXY_SECRETS_DIR).toBe(env.secretsDir);
      expect(process.env.IRON_MANAGEMENT_API_KEY).toBe(env.controlToken);
      expect(process.env.BOTTEGA_PROXY_CONTROL_URL).toBe(MANAGEMENT_URL);
      expect(process.env.BOTTEGA_PROXY_CONTROL_TOKEN).toBe(env.controlToken);

      // No CA generation (already present) but the compose up ran.
      expect(calls.some((c) => c.includes("compose") && c.includes("up"))).toBe(true);

      // The credential sync ran against the pinned secrets dir.
      expect(synced).toBe(env.secretsDir);
      expect(env.controlToken).not.toBe("");
      expect(env.controlUrl).toBe(MANAGEMENT_URL);
    } finally {
      cleanup();
    }
  });

  test("fails closed when the compose up fails", async () => {
    const { cwd, cleanup } = freshCwd();
    try {
      mkdirSync(join(cwd, "certs"), { recursive: true });
      writeFileSync(join(cwd, "certs", "ca.crt"), "ca");
      const { run } = stubRun({ status: 1, error: "daemon not reachable" });
      await expect(bootCanaryProxy(cwd, { run, probe: okProbe })).rejects.toThrow(/compose up iron-proxy failed/);
    } finally {
      cleanup();
    }
  });

  test("fails closed when the management API never becomes ready", async () => {
    const { cwd, cleanup } = freshCwd();
    try {
      mkdirSync(join(cwd, "certs"), { recursive: true });
      writeFileSync(join(cwd, "certs", "ca.crt"), "ca");
      const { run } = stubRun();
      const probe: ManagementProbe = async () => false;
      await expect(bootCanaryProxy(cwd, { run, probe, waitTimeoutMs: 50 })).rejects.toThrow(/did not become ready/);
    } finally {
      cleanup();
    }
  });

  test("fails closed when the CA generation fails", async () => {
    const { cwd, cleanup } = freshCwd();
    try {
      const run: DockerRun = () => ({ status: 1, error: "unable to pull image" });
      await expect(bootCanaryProxy(cwd, { run })).rejects.toThrow(/CA generation failed/);
    } finally {
      cleanup();
    }
  });
});

describe("image contract (issue #177 tripwire)", () => {
  test("the canary proxy boots the SAME pinned image compose/dev.sh pin", () => {
    expect(CANARY_PROXY_IMAGE).toMatch(/^ironsh\/iron-proxy:/);
    // The tunnel the canary egress rides must match canary-egress.ts's probe.
    expect(PROXY_TUNNEL_URL).toBe("http://127.0.0.1:8080");
  });
});