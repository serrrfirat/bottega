import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bootstrapConfig,
  nodeBootstrapFs,
  runBootstrapCli,
  type BootstrapConfig,
  type BootstrapDeps,
  type CommandResult,
  type ProbeResult,
} from "./dev-bootstrap";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): BootstrapConfig {
  const root = mkdtempSync(join(tmpdir(), "bottega-bootstrap-"));
  roots.push(root);
  mkdirSync(join(root, "config", "omp"), { recursive: true });
  for (const name of ["config.yml", "models.yml", "secrets.yml"]) {
    writeFileSync(join(root, "config", "omp", name), `template:${name}\n`);
  }
  writeFileSync(join(root, "docker-compose.yml"), "services: {}\n");
  writeFileSync(join(root, "docker-compose.dev.yml"), "services: {}\n");
  return bootstrapConfig({
    root,
    dataDir: join(root, "home", "shared-data"),
    certsDir: join(root, "shared-certs"),
    home: join(root, "home"),
    uid: process.getuid?.() ?? 0,
  });
}

function files(root: string): Array<{ path: string; mode: number; content: string }> {
  const out: Array<{ path: string; mode: number; content: string }> = [];
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const stat = statSync(path);
      if (stat.isDirectory()) walk(path);
      else out.push({ path: path.slice(root.length), mode: stat.mode & 0o777, content: readFileSync(path, "utf8") });
    }
  };
  walk(root);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

interface Harness {
  deps: BootstrapDeps;
  runs: string[][];
  starts: Array<{ argv: string[]; env: Record<string, string>; logFile: string }>;
  execs: Array<{ argv: string[]; env: Record<string, string> }>;
  output: string[];
  setRun: (fn: (argv: string[]) => Promise<CommandResult>) => void;
  setProbe: (fn: (kind: "proxy-status" | "proxy" | "broker", token?: string) => Promise<ProbeResult>) => void;
  setSleep: (fn: () => Promise<void>) => void;
}

function harness(): Harness {
  const runs: string[][] = [];
  const starts: Array<{ argv: string[]; env: Record<string, string>; logFile: string }> = [];
  const execs: Array<{ argv: string[]; env: Record<string, string> }> = [];
  const output: string[] = [];
  let runImpl: (argv: string[]) => Promise<CommandResult> = async () => ({ exitCode: 0, stdout: "", stderr: "" });
  let probeImpl: BootstrapDeps["probe"] = async () => ({ ok: false });
  let sleepImpl: () => Promise<void> = async () => {};
  const deps: BootstrapDeps = {
    fs: nodeBootstrapFs,
    commands: {
      run: async (argv) => {
        runs.push([...argv]);
        return runImpl(argv);
      },
      startDetached: async (argv, options) => {
        starts.push({ argv: [...argv], env: { ...options.env }, logFile: options.logFile });
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      exec: async (argv, options) => {
        execs.push({ argv: [...argv], env: { ...options.env } });
        return 0;
      },
    },
    clock: { now: () => 1_700_000_000_000, sleep: () => sleepImpl() },
    probe: (kind, token) => probeImpl(kind, token),
    randomHex: (bytes) => "a".repeat(bytes * 2),
    log: (line) => output.push(line),
    error: (line) => output.push(line),
  };
  return {
    deps,
    runs,
    starts,
    execs,
    output,
    setRun: (fn) => {
      runImpl = fn;
    },
    setProbe: (fn) => {
      probeImpl = fn;
    },
    setSleep: (fn) => {
      sleepImpl = fn;
    },
  };
}

function createReadyFiles(config: BootstrapConfig): void {
  mkdirSync(config.agentDir, { recursive: true });
  for (const name of ["config.yml", "models.yml", "secrets.yml"]) {
    writeFileSync(join(config.agentDir, name), `configured:${name}\n`, { mode: 0o600 });
    chmodSync(join(config.agentDir, name), 0o600);
  }
  mkdirSync(config.certsDir, { recursive: true });
  writeFileSync(config.caCertFile, "cert", { mode: 0o644 });
  writeFileSync(config.caKeyFile, "key", { mode: 0o600 });
  chmodSync(config.caCertFile, 0o644);
  chmodSync(config.caKeyFile, 0o600);
  mkdirSync(join(config.dataDir, ".omp"), { recursive: true });
  writeFileSync(config.proxyTokenFile, "proxy-token", { mode: 0o600 });
  writeFileSync(config.brokerTokenFile, "broker-token", { mode: 0o600 });
  chmodSync(config.proxyTokenFile, 0o600);
  chmodSync(config.brokerTokenFile, 0o600);
}

function successPrerequisites(argv: string[]): Promise<CommandResult> {
  if (argv[0] === "openssl" && argv.includes("-modulus")) {
    return Promise.resolve({ exitCode: 0, stdout: "Modulus=ABCD\n", stderr: "" });
  }
  return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
}

describe("development bootstrap caller contract (#311)", () => {
  test("default setup plans a fresh machine without writes or process starts", async () => {
    const config = fixture();
    const h = harness();
    const before = files(config.root);

    expect(await runBootstrapCli(["setup"], h.deps, config, {})).toBe(0);

    expect(files(config.root)).toEqual(before);
    expect(h.runs).toEqual([]);
    expect(h.starts).toEqual([]);
    expect(h.execs).toEqual([]);
    expect(h.output).toEqual([
      "bottega setup: plan",
      `  seed ${config.agentDir}/config.yml (0600, current user)`,
      `  seed ${config.agentDir}/models.yml (0600, current user)`,
      `  seed ${config.agentDir}/secrets.yml (0600, current user)`,
      `  generate ${config.caCertFile} (0644, current user) and ${config.caKeyFile} (0600, current user)`,
      `  create ${config.proxyTokenFile} (0600, current user; value is never printed)`,
      `  start iron-proxy and wait for authenticated reload readiness`,
      `  start auth-broker and wait for ${config.brokerTokenFile} (0600, current user) plus health readiness; local fallback log ${config.brokerLogFile} (0600, current user)`,
      "Run `bun run setup -- --apply` to apply this exact plan.",
    ]);
  });

  test("apply is resumable, applies the displayed fresh plan once, and reruns as a no-op", async () => {
    const config = fixture();
    const h = harness();
    let proxyReady = false;
    let brokerReady = false;
    h.setProbe(async (kind) => ({ ok: kind === "proxy" ? proxyReady : brokerReady }));
    h.setRun(async (argv) => {
      if (argv[0] === "docker" && argv.includes("generate-ca")) {
        mkdirSync(config.certsDir, { recursive: true });
        writeFileSync(config.caCertFile, "cert");
        writeFileSync(config.caKeyFile, "key");
      }
      if (argv.at(-1) === "iron-proxy") proxyReady = true;
      if (argv.at(-1) === "auth-broker") {
        mkdirSync(join(config.dataDir, ".omp"), { recursive: true });
        writeFileSync(config.brokerTokenFile, "broker-token");
        chmodSync(config.brokerTokenFile, 0o600);
        brokerReady = true;
      }
      return successPrerequisites(argv);
    });

    expect(await runBootstrapCli(["setup", "--apply"], h.deps, config, {})).toBe(0);
    const afterFirst = files(config.root);
    const firstRuns = h.runs.length;
    expect(statSync(config.proxyTokenFile).mode & 0o777).toBe(0o600);
    expect(statSync(config.brokerTokenFile).mode & 0o777).toBe(0o600);
    expect(statSync(config.caCertFile).mode & 0o777).toBe(0o644);
    expect(statSync(config.caKeyFile).mode & 0o777).toBe(0o600);
    for (const name of ["config.yml", "models.yml", "secrets.yml"]) {
      expect(statSync(join(config.agentDir, name)).mode & 0o777).toBe(0o600);
    }

    h.output.length = 0;
    expect(await runBootstrapCli(["setup", "--apply"], h.deps, config, {})).toBe(0);
    expect(files(config.root)).toEqual(afterFirst);
    expect(h.runs.length).toBeGreaterThan(firstRuns); // read-only prerequisite/CA validation commands still run
    expect(h.output).toContain("bottega setup: nothing to apply");
    expect(h.starts).toEqual([]);
  });

  test("partial setup resumes only missing actions and never clobbers existing defaults", async () => {
    const config = fixture();
    const h = harness();
    createReadyFiles(config);
    rmSync(join(config.agentDir, "models.yml"));
    const kept = join(config.agentDir, "config.yml");
    const original = readFileSync(kept, "utf8");
    h.setProbe(async () => ({ ok: true }));
    h.setRun(successPrerequisites);

    expect(await runBootstrapCli(["setup", "--apply"], h.deps, config, {})).toBe(0);
    expect(readFileSync(kept, "utf8")).toBe(original);
    expect(readFileSync(join(config.agentDir, "models.yml"), "utf8")).toBe("template:models.yml\n");
    expect(h.output.some((line) => line.includes("seed") && line.includes("models.yml"))).toBe(true);
    expect(h.output.some((line) => line.includes("seed") && line.includes("config.yml"))).toBe(false);
  });

  test("unsafe permissions and unexpected partial CA files fail before commands or writes", async () => {
    const config = fixture();
    const h = harness();
    createReadyFiles(config);
    chmodSync(config.proxyTokenFile, 0o644);
    rmSync(config.caKeyFile);
    const before = files(config.root);

    expect(await runBootstrapCli(["setup", "--apply"], h.deps, config, {})).toBe(1);
    expect(files(config.root)).toEqual(before);
    expect(h.runs).toEqual([]);
    expect(h.output.join("\n")).toContain("refusing unsafe existing file");
    expect(h.output.join("\n")).toContain("partial CA state");
  });

  test("missing Docker reports the prerequisite and performs no setup mutations", async () => {
    const config = fixture();
    const h = harness();
    const before = files(config.root);
    h.setRun(async (argv) =>
      argv[0] === "docker"
        ? { exitCode: 127, stdout: "", stderr: "docker: not found" }
        : { exitCode: 0, stdout: "", stderr: "" },
    );

    expect(await runBootstrapCli(["setup", "--apply"], h.deps, config, {})).toBe(1);
    expect(files(config.root)).toEqual(before);
    expect(h.output.join("\n")).toContain("Docker is required");
    expect(h.runs.some((argv) => argv.includes("up"))).toBe(false);
  });

  test("native addon preflight failure is loud and starts neither services nor server", async () => {
    const config = fixture();
    const h = harness();
    createReadyFiles(config);
    h.setProbe(async () => ({ ok: true }));
    h.setRun(async (argv) =>
      argv[0] === "bun" && argv[1] === "-e"
        ? { exitCode: 1, stdout: "", stderr: "dlopen failed for proxy-token and broker-token" }
        : successPrerequisites(argv),
    );

    expect(await runBootstrapCli(["dev"], h.deps, config, {})).toBe(1);
    expect(h.output.join("\n")).toContain("native runtime check failed");
    expect(h.output.join("\n")).not.toContain("proxy-token");
    expect(h.output.join("\n")).not.toContain("broker-token");
    expect(h.runs.some((argv) => argv.includes("up"))).toBe(false);
    expect(h.execs).toEqual([]);
  });

  test("proxy readiness timeout is deterministic and prevents later starts", async () => {
    const config = fixture();
    const h = harness();
    createReadyFiles(config);
    h.setProbe(async (kind) => ({ ok: kind === "broker" }));
    h.setRun(successPrerequisites);

    expect(await runBootstrapCli(["setup", "--apply"], h.deps, config, {})).toBe(1);
    expect(h.output.join("\n")).toContain("iron-proxy did not become ready");
    expect(h.runs.filter((argv) => argv.at(-1) === "iron-proxy")).toHaveLength(1);
    expect(h.runs.filter((argv) => argv.at(-1) === "auth-broker")).toHaveLength(0);
    expect(h.execs).toEqual([]);
  });

  test("an authenticated stale proxy is force-recreated once before succeeding", async () => {
    const config = fixture();
    const h = harness();
    createReadyFiles(config);
    let proxyProbes = 0;
    h.setProbe(async (kind) => {
      if (kind === "broker") return { ok: true };
      proxyProbes += 1;
      return proxyProbes < 3 ? { ok: false, status: 401 } : { ok: true };
    });
    h.setRun(successPrerequisites);

    expect(await runBootstrapCli(["setup", "--apply"], h.deps, config, {})).toBe(0);
    expect(h.runs.some((argv) => argv.includes("--force-recreate") && argv.at(-1) === "iron-proxy")).toBe(true);
  });

  test("missing broker image falls back to the local broker without exposing its token", async () => {
    const config = fixture();
    const h = harness();
    createReadyFiles(config);
    rmSync(config.brokerTokenFile);
    let brokerReady = false;
    h.setProbe(async (kind) => ({ ok: kind === "proxy" || brokerReady }));
    h.setRun(async (argv) => {
      if (argv[0] === "docker" && argv[1] === "image") return { exitCode: 1, stdout: "", stderr: "missing" };
      return successPrerequisites(argv);
    });
    h.setSleep(async () => {
      brokerReady = true;
    });

    expect(await runBootstrapCli(["setup", "--apply"], h.deps, config, {})).toBe(0);
    expect(h.starts).toHaveLength(1);
    expect(h.starts[0]!.argv).toEqual(["omp", "auth-broker", "serve", "--bind=0.0.0.0:8765"]);
    expect(h.starts[0]!.env.OMP_AUTH_BROKER_TOKEN).toBe("a".repeat(64));
    expect(h.output.join("\n")).not.toContain("a".repeat(16));
    expect(statSync(h.starts[0]!.logFile).mode & 0o777).toBe(0o600);
  });

  test("broker health alone is not ready until its owned mode-0600 token exists", async () => {
    const config = fixture();
    const h = harness();
    createReadyFiles(config);
    rmSync(config.brokerTokenFile);
    let sleeps = 0;
    h.setProbe(async () => ({ ok: true }));
    h.setRun(async (argv) => {
      if (argv[0] === "docker" && argv[1] === "image") return { exitCode: 0, stdout: "", stderr: "" };
      return successPrerequisites(argv);
    });
    h.setSleep(async () => {
      sleeps += 1;
      if (sleeps === 2) {
        writeFileSync(config.brokerTokenFile, "late-token");
        chmodSync(config.brokerTokenFile, 0o600);
      }
    });

    expect(await runBootstrapCli(["setup", "--apply"], h.deps, config, {})).toBe(0);
    expect(sleeps).toBe(2);
  });

  test("dev refuses missing setup and reports every prerequisite before server start", async () => {
    const config = fixture();
    const h = harness();
    h.setProbe(async () => ({ ok: false }));

    expect(await runBootstrapCli(["dev"], h.deps, config, {})).toBe(1);
    const text = h.output.join("\n");
    expect(text).toContain("config.yml");
    expect(text).toContain("ca.crt");
    expect(text).toContain("proxy-mgmt-token");
    expect(text).toContain("auth-broker");
    expect(text).toContain("bun run setup -- --apply");
    expect(h.execs).toEqual([]);
  });

  test("ready dev executes the exact watch argv and final redacted environment", async () => {
    const config = fixture();
    const h = harness();
    createReadyFiles(config);
    h.setProbe(async () => ({ ok: true }));
    h.setRun(successPrerequisites);

    expect(await runBootstrapCli(["dev", "--watch"], h.deps, config, { KEEP_ME: "yes" })).toBe(0);
    expect(h.execs).toHaveLength(1);
    expect(h.execs[0]!.argv).toEqual(["bun", "run", "--watch", "src/server/index.ts"]);
    expect(h.execs[0]!.env).toMatchObject({
      KEEP_ME: "yes",
      COMPOSE_PROJECT_NAME: config.composeProject,
      BOTTEGA_DEV_DATA_DIR: config.dataDir,
      BOTTEGA_DEV_CERTS_DIR: config.certsDir,
      BOTTEGA_PROXY_SECRETS_DIR: join(config.dataDir, "proxy-secrets"),
      HTTP_PROXY: "http://127.0.0.1:8080",
      HTTPS_PROXY: "http://127.0.0.1:8080",
      NO_PROXY: "localhost,127.0.0.1,data,auth-broker,auth-gateway,mem0",
      NODE_EXTRA_CA_CERTS: config.caCertFile,
      SSL_CERT_FILE: config.caCertFile,
      BOTTEGA_PROXY_CONTROL_URL: "http://127.0.0.1:9092",
      BOTTEGA_PROXY_CONTROL_TOKEN: "proxy-token",
      IRON_MANAGEMENT_API_KEY: "proxy-token",
      OMP_AUTH_BROKER_URL: "http://127.0.0.1:8765",
      OMP_AUTH_BROKER_TOKEN: "broker-token",
    });
    expect(h.output.join("\n")).not.toContain("proxy-token");
    expect(h.output.join("\n")).not.toContain("broker-token");
  });

  test("local dev opts the server into the existing Keychain seam so the shared proxy-seed leg can resolve a Keychain-held near key (#333)", async () => {
    // Hermetic caller test: drive the REAL dev composition seam (runBootstrapCli
    // "dev") with fake commands/probes; the observed contract is the env handed
    // to the dev server process. The shared proxy-seed leg (keychainReaderFromEnv
    // in boot-secrets.ts) reads BOTTEGA_KEYCHAIN_SEED off that env: without the
    // opt-in it returns null for bottega-near/bottega-opencode and the boot
    // prints "proxy near.secret REMOVED — no near key anywhere (fail closed)".
    const config = fixture();
    const h = harness();
    createReadyFiles(config);
    h.setProbe(async () => ({ ok: true }));
    h.setRun(successPrerequisites);

    expect(await runBootstrapCli(["dev"], h.deps, config, {})).toBe(0);
    expect(h.execs).toHaveLength(1);
    expect(h.execs[0]!.argv).toEqual(["bun", "run", "src/server/index.ts"]);
    expect(h.execs[0]!.env.BOTTEGA_KEYCHAIN_SEED).toBe("1");
  });

  test("the Keychain opt-in is local-only and never reaches the setup/detached environment (fail closed)", async () => {
    // Non-local (deployment / CI / compose) must never read a developer
    // Keychain: the opt-in flag is a local-dev-only addition to the dev-server
    // env. The only detached process the bootstrap starts outside the server is
    // the local auth-broker fallback (a deployment-adjacent surface); asserting
    // IT never carries the flag guards the non-local boundary. Hermetic: the
    // broker image is absent, forcing the local CLI fallback into h.starts.
    const config = fixture();
    const h = harness();
    createReadyFiles(config);
    rmSync(config.brokerTokenFile);
    let brokerReady = false;
    h.setProbe(async (kind) => ({ ok: kind === "proxy" || brokerReady }));
    h.setRun(async (argv) => {
      if (argv[0] === "docker" && argv[1] === "image") return { exitCode: 1, stdout: "", stderr: "missing" };
      return successPrerequisites(argv);
    });
    h.setSleep(async () => {
      brokerReady = true;
    });

    expect(await runBootstrapCli(["setup", "--apply"], h.deps, config, {})).toBe(0);
    expect(h.starts.length).toBeGreaterThan(0);
    for (const start of h.starts) expect(start.env.BOTTEGA_KEYCHAIN_SEED).toBeUndefined();
    expect(h.execs).toEqual([]);
  });
});
