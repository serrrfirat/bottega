import { spawn as nodeSpawn } from "node:child_process";
import { constants, closeSync, copyFileSync, lstatSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { PROXY_TUNNEL_URL, NO_PROXY_LIST } from "./canary-egress";

const COMPOSE_FILES = ["-f", "docker-compose.yml", "-f", "docker-compose.dev.yml"] as const;
const AGENT_TEMPLATES = ["config.yml", "models.yml", "secrets.yml"] as const;
const PROXY_ATTEMPTS = 30;
const BROKER_ATTEMPTS = 30;

export interface FileInfo {
  kind: "file" | "directory" | "other";
  mode: number;
  uid: number;
  size: number;
}

export interface BootstrapFs {
  stat(path: string): FileInfo | null;
  mkdir(path: string, mode: number): void;
  mkdirExclusive(path: string, mode: number): boolean;
  read(path: string): string;
  writeExclusive(path: string, value: string, mode: number): void;
  copyExclusive(source: string, destination: string, mode: number): void;
  chmod(path: string, mode: number): void;
  remove(path: string, recursive?: boolean): void;
}

function fileInfo(path: string): FileInfo | null {
  try {
    const stat = lstatSync(path);
    return {
      kind: stat.isFile() ? "file" : stat.isDirectory() ? "directory" : "other",
      mode: stat.mode & 0o777,
      uid: stat.uid,
      size: stat.size,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export const nodeBootstrapFs: BootstrapFs = {
  stat: fileInfo,
  mkdir(path, mode) {
    mkdirSync(path, { recursive: true, mode });
  },
  mkdirExclusive(path, mode) {
    try {
      mkdirSync(path, { mode });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
  },
  read: (path) => readFileSync(path, "utf8"),
  writeExclusive(path, value, mode) {
    writeFileSync(path, value, { flag: "wx", mode });
    chmodSync(path, mode);
  },
  copyExclusive(source, destination, mode) {
    copyFileSync(source, destination, constants.COPYFILE_EXCL);
    chmodSync(destination, mode);
  },
  chmod(path, mode) {
    chmodSync(path, mode);
  },
  remove(path, recursive = false) {
    rmSync(path, { recursive, force: true });
  },
};

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CommandOptions {
  cwd: string;
  env: Record<string, string>;
  timeoutMs?: number;
}

export interface DetachedCommandOptions extends CommandOptions {
  logFile: string;
}

export interface CommandPort {
  run(argv: string[], options: CommandOptions): Promise<CommandResult>;
  startDetached(argv: string[], options: DetachedCommandOptions): Promise<CommandResult>;
  exec(argv: string[], options: CommandOptions): Promise<number>;
}

export interface ProbeResult {
  ok: boolean;
  status?: number;
}
export type ProbeKind = "proxy-status" | "proxy" | "broker";

export interface BootstrapDeps {
  fs: BootstrapFs;
  commands: CommandPort;
  clock: { now(): number; sleep(ms: number): Promise<void> };
  probe(kind: ProbeKind, token?: string): Promise<ProbeResult>;
  randomHex(bytes: number): string;
  log(line: string): void;
  error(line: string): void;
}

export interface BootstrapConfig {
  root: string;
  dataDir: string;
  certsDir: string;
  home: string;
  uid: number;
  gid: number;
  composeProject: string;
  agentDir: string;
  templateDir: string;
  proxyTokenFile: string;
  brokerTokenFile: string;
  caCertFile: string;
  caKeyFile: string;
  brokerLogFile: string;
  publicBaseFile: string;
}

export function bootstrapConfig(input: {
  root: string;
  dataDir: string;
  certsDir: string;
  home: string;
  uid: number;
  gid?: number;
  composeProject?: string;
  publicBaseFile?: string;
}): BootstrapConfig {
  const root = resolve(input.root);
  const dataDir = resolve(input.dataDir);
  const certsDir = resolve(input.certsDir);
  return {
    root,
    dataDir,
    certsDir,
    home: resolve(input.home),
    uid: input.uid,
    gid: input.gid ?? process.getgid?.() ?? 0,
    composeProject: input.composeProject ?? basename(root),
    agentDir: join(root, "data", "omp-agent"),
    templateDir: join(root, "config", "omp"),
    proxyTokenFile: join(dataDir, "proxy-mgmt-token"),
    brokerTokenFile: join(dataDir, ".omp", "auth-broker.token"),
    caCertFile: join(certsDir, "ca.crt"),
    caKeyFile: join(certsDir, "ca.key"),
    brokerLogFile: join(dataDir, "auth-broker.log"),
    publicBaseFile: input.publicBaseFile ?? join(dataDir, "public-base-url"),
  };
}

interface PlanAction {
  id: "seed" | "ca" | "proxy-token" | "proxy" | "broker";
  description: string;
  fileName?: (typeof AGENT_TEMPLATES)[number];
  initialProbe?: ProbeResult;
}

interface SetupPlan {
  actions: PlanAction[];
  errors: string[];
}

function modeText(mode: number): string {
  return mode.toString(8).padStart(4, "0");
}

function ownedRegularError(fs: BootstrapFs, path: string, uid: number, acceptedModes: readonly number[]): string | null {
  const stat = fs.stat(path);
  if (stat === null) return null;
  if (stat.kind !== "file") return `refusing unsafe existing file ${path}: expected a regular file`;
  if (stat.uid !== uid) return `refusing unsafe existing file ${path}: owner uid ${stat.uid}, expected ${uid}`;
  if (!acceptedModes.includes(stat.mode)) {
    return `refusing unsafe existing file ${path}: mode ${modeText(stat.mode)}, expected ${acceptedModes.map(modeText).join(" or ")}`;
  }
  return null;
}

function presentOwnedFile(fs: BootstrapFs, path: string, uid: number, mode: number): boolean {
  const stat = fs.stat(path);
  return stat?.kind === "file" && stat.uid === uid && stat.mode === mode && stat.size > 0;
}

async function inspectSetup(deps: BootstrapDeps, config: BootstrapConfig, authenticateProxy: boolean): Promise<SetupPlan> {
  const actions: PlanAction[] = [];
  const errors: string[] = [];

  for (const name of AGENT_TEMPLATES) {
    const destination = join(config.agentDir, name);
    const existing = deps.fs.stat(destination);
    if (existing === null) {
      actions.push({ id: "seed", fileName: name, description: `seed ${destination} (0600, current user)` });
      continue;
    }
    const unsafe = ownedRegularError(deps.fs, destination, config.uid, name === "secrets.yml" ? [0o600] : [0o600, 0o644]);
    if (unsafe !== null) errors.push(unsafe);
  }

  const cert = deps.fs.stat(config.caCertFile);
  const key = deps.fs.stat(config.caKeyFile);
  if ((cert === null) !== (key === null)) {
    errors.push(
      `refusing partial CA state: ${config.caCertFile} and ${config.caKeyFile} must either both exist or both be absent`,
    );
  } else if (cert === null && key === null) {
    actions.push({
      id: "ca",
      description: `generate ${config.caCertFile} (0644, current user) and ${config.caKeyFile} (0600, current user)`,
    });
  } else {
    const certError = ownedRegularError(deps.fs, config.caCertFile, config.uid, [0o644]);
    const keyError = ownedRegularError(deps.fs, config.caKeyFile, config.uid, [0o600]);
    if (certError !== null) errors.push(certError);
    if (keyError !== null) errors.push(keyError);
  }

  const proxyToken = deps.fs.stat(config.proxyTokenFile);
  if (proxyToken === null) {
    actions.push({
      id: "proxy-token",
      description: `create ${config.proxyTokenFile} (0600, current user; value is never printed)`,
    });
  } else {
    const tokenError = ownedRegularError(deps.fs, config.proxyTokenFile, config.uid, [0o600]);
    if (tokenError !== null) errors.push(tokenError);
    if (proxyToken.size === 0) errors.push(`refusing unsafe existing file ${config.proxyTokenFile}: token is empty`);
  }

  let proxyProbe: ProbeResult = { ok: false };
  if (errors.length === 0 && presentOwnedFile(deps.fs, config.proxyTokenFile, config.uid, 0o600)) {
    proxyProbe = authenticateProxy
      ? await deps.probe("proxy", deps.fs.read(config.proxyTokenFile).trim())
      : await deps.probe("proxy-status");
  }
  if (!proxyProbe.ok) {
    actions.push({
      id: "proxy",
      initialProbe: proxyProbe,
      description: "start iron-proxy and wait for authenticated reload readiness",
    });
  }

  const brokerToken = deps.fs.stat(config.brokerTokenFile);
  if (brokerToken !== null) {
    const tokenError = ownedRegularError(deps.fs, config.brokerTokenFile, config.uid, [0o600]);
    if (tokenError !== null) errors.push(tokenError);
    if (brokerToken.size === 0) errors.push(`refusing unsafe existing file ${config.brokerTokenFile}: token is empty`);
  }
  if (deps.fs.stat(config.brokerLogFile) !== null) {
    const logError = ownedRegularError(deps.fs, config.brokerLogFile, config.uid, [0o600]);
    if (logError !== null) errors.push(logError);
  }
  const brokerProbe = await deps.probe("broker");
  if (!brokerProbe.ok || !presentOwnedFile(deps.fs, config.brokerTokenFile, config.uid, 0o600)) {
    actions.push({
      id: "broker",
      initialProbe: brokerProbe,
      description: `start auth-broker and wait for ${config.brokerTokenFile} (0600, current user) plus health readiness; local fallback log ${config.brokerLogFile} (0600, current user)`,
    });
  }

  return { actions, errors };
}

function printPlan(deps: BootstrapDeps, plan: SetupPlan, apply: boolean): void {
  if (plan.actions.length === 0) {
    deps.log("bottega setup: nothing to apply");
  } else {
    deps.log("bottega setup: plan");
    for (const action of plan.actions) deps.log(`  ${action.description}`);
    if (!apply) deps.log("Run `bun run setup -- --apply` to apply this exact plan.");
  }
  for (const error of plan.errors) deps.error(`bottega setup: ${error}`);
}

function commandOptions(config: BootstrapConfig, env: Record<string, string>, timeoutMs?: number): CommandOptions {
  return { cwd: config.root, env, ...(timeoutMs === undefined ? {} : { timeoutMs }) };
}

async function prerequisites(deps: BootstrapDeps, config: BootstrapConfig, env: Record<string, string>): Promise<string[]> {
  const checks: Array<{ argv: string[]; failure: string }> = [
    { argv: ["docker", "version"], failure: "Docker is required and its daemon must be reachable; start Docker Desktop" },
    { argv: ["docker", "compose", "version"], failure: "Docker Compose v2 is required (`docker compose version`)" },
    {
      argv: ["bun", "-e", 'import { Database } from "bun:sqlite"; const db = new Database(":memory:"); db.close();'],
      failure: "native runtime check failed (bun:sqlite could not load); reinstall the current Bun release and dependencies",
    },
  ];
  const errors: string[] = [];
  for (const check of checks) {
    const result = await deps.commands.run(check.argv, commandOptions(config, env, 10_000));
    if (result.exitCode !== 0) errors.push(`${check.failure}${result.stderr.trim() ? `: ${result.stderr.trim()}` : ""}`);
  }
  for (const name of AGENT_TEMPLATES) {
    const source = join(config.templateDir, name);
    if (deps.fs.stat(source)?.kind !== "file") errors.push(`setup template is missing: ${source}`);
  }
  return errors;
}

async function validateCa(deps: BootstrapDeps, config: BootstrapConfig, env: Record<string, string>): Promise<string | null> {
  if (deps.fs.stat(config.caCertFile) === null || deps.fs.stat(config.caKeyFile) === null) return null;
  const cert = await deps.commands.run(
    ["openssl", "x509", "-in", config.caCertFile, "-noout", "-modulus"],
    commandOptions(config, env, 10_000),
  );
  const key = await deps.commands.run(
    ["openssl", "rsa", "-in", config.caKeyFile, "-noout", "-modulus"],
    commandOptions(config, env, 10_000),
  );
  if (cert.exitCode !== 0 || key.exitCode !== 0 || cert.stdout.trim() === "" || cert.stdout.trim() !== key.stdout.trim()) {
    return `MITM CA validation failed for ${config.caCertFile}/${config.caKeyFile} (unreadable or cert/key mismatch)`;
  }
  return null;
}

function runtimeEnv(config: BootstrapConfig, env: Record<string, string>): Record<string, string> {
  return {
    ...env,
    COMPOSE_PROJECT_NAME: config.composeProject,
    BOTTEGA_DEV_DATA_DIR: config.dataDir,
    BOTTEGA_DEV_CERTS_DIR: config.certsDir,
    BOTTEGA_PROXY_SECRETS_DIR: join(config.dataDir, "proxy-secrets"),
    BOTTEGA_PUBLIC_BASE_URL_FILE: config.publicBaseFile,
  };
}
function composeRuntimeEnv(deps: BootstrapDeps, config: BootstrapConfig, env: Record<string, string>): Record<string, string> {
  const result = runtimeEnv(config, env);
  if (presentOwnedFile(deps.fs, config.proxyTokenFile, config.uid, 0o600)) {
    result.IRON_MANAGEMENT_API_KEY = deps.fs.read(config.proxyTokenFile).trim();
  }
  return result;
}

async function generateCa(deps: BootstrapDeps, config: BootstrapConfig, env: Record<string, string>): Promise<string | null> {
  deps.fs.mkdir(config.certsDir, 0o700);
  const lock = join(config.certsDir, ".gen-lock");
  if (!deps.fs.mkdirExclusive(lock, 0o700)) {
    const deadline = deps.clock.now() + 60_000;
    for (
      let attempt = 0;
      attempt < 60 && deps.clock.now() < deadline && deps.fs.stat(config.caCertFile) === null;
      attempt += 1
    ) {
      await deps.clock.sleep(1_000);
    }
    if (deps.fs.stat(config.caCertFile) === null || deps.fs.stat(config.caKeyFile) === null) {
      return `timed out waiting for the shared CA generation lock ${lock}`;
    }
    const certError = ownedRegularError(deps.fs, config.caCertFile, config.uid, [0o644]);
    const keyError = ownedRegularError(deps.fs, config.caKeyFile, config.uid, [0o600]);
    if (certError !== null || keyError !== null) return certError ?? keyError;
    return validateCa(deps, config, env);
  }
  try {
    const result = await deps.commands.run(
      [
        "docker",
        "run",
        "--rm",
        "--user",
        `${config.uid}:${config.gid}`,
        "-v",
        `${config.certsDir}:/certs`,
        "ironsh/iron-proxy:0.49.0",
        "generate-ca",
        "-outdir",
        "/certs",
      ],
      commandOptions(config, env, 120_000),
    );
    if (result.exitCode !== 0) {
      deps.fs.remove(config.caCertFile);
      deps.fs.remove(config.caKeyFile);
      return "iron-proxy CA generation failed; verify `ironsh/iron-proxy:0.49.0` is pullable";
    }
    if (deps.fs.stat(config.caCertFile) === null || deps.fs.stat(config.caKeyFile) === null) {
      return "iron-proxy CA generation exited successfully but did not create both declared files";
    }
    for (const path of [config.caCertFile, config.caKeyFile]) {
      const state = deps.fs.stat(path);
      if (state?.kind !== "file" || state.uid !== config.uid) {
        return `iron-proxy CA generation created unsafe ${path}: expected a regular file owned by uid ${config.uid}`;
      }
    }
    deps.fs.chmod(config.caCertFile, 0o644);
    deps.fs.chmod(config.caKeyFile, 0o600);
    const error = await validateCa(deps, config, env);
    if (error !== null) {
      deps.fs.remove(config.caCertFile);
      deps.fs.remove(config.caKeyFile);
    }
    return error;
  } finally {
    deps.fs.remove(lock, true);
  }
}

function composeArgv(...args: string[]): string[] {
  return ["docker", "compose", ...COMPOSE_FILES, ...args];
}

async function waitForProxy(deps: BootstrapDeps, token: string): Promise<ProbeResult> {
  let last: ProbeResult = { ok: false };
  const deadline = deps.clock.now() + PROXY_ATTEMPTS * 1_000;
  for (let attempt = 0; attempt < PROXY_ATTEMPTS && deps.clock.now() < deadline; attempt += 1) {
    last = await deps.probe("proxy", token);
    if (last.ok) return last;
    if (last.status === 401) return last;
    if (attempt + 1 < PROXY_ATTEMPTS) await deps.clock.sleep(1_000);
  }
  return last;
}

async function startProxy(
  deps: BootstrapDeps,
  config: BootstrapConfig,
  env: Record<string, string>,
): Promise<string | null> {
  const started = await deps.commands.run(composeArgv("up", "-d", "iron-proxy"), commandOptions(config, env, 120_000));
  if (started.exitCode !== 0) return `iron-proxy failed to start: ${started.stderr.trim() || `exit ${started.exitCode}`}`;
  const token = deps.fs.read(config.proxyTokenFile).trim();
  let ready = await waitForProxy(deps, token);
  if (!ready.ok && ready.status === 401) {
    deps.log("iron-proxy: stale management token detected; force-recreating the shared container once");
    const recreated = await deps.commands.run(
      composeArgv("up", "-d", "--force-recreate", "iron-proxy"),
      commandOptions(config, env, 120_000),
    );
    if (recreated.exitCode !== 0) return `iron-proxy stale-state recovery failed: ${recreated.stderr.trim() || `exit ${recreated.exitCode}`}`;
    ready = await waitForProxy(deps, token);
  }
  if (!ready.ok) {
    return `iron-proxy did not become ready before the deterministic deadline; run \
${composeArgv("logs", "iron-proxy").join(" ")}`;
  }
  return null;
}

function brokerTokenReady(deps: BootstrapDeps, config: BootstrapConfig): boolean {
  return presentOwnedFile(deps.fs, config.brokerTokenFile, config.uid, 0o600);
}

async function waitForBroker(deps: BootstrapDeps, config: BootstrapConfig): Promise<boolean> {
  const deadline = deps.clock.now() + BROKER_ATTEMPTS * 1_000;
  for (let attempt = 0; attempt < BROKER_ATTEMPTS && deps.clock.now() < deadline; attempt += 1) {
    const health = await deps.probe("broker");
    if (health.ok && brokerTokenReady(deps, config)) return true;
    if (attempt + 1 < BROKER_ATTEMPTS) await deps.clock.sleep(1_000);
  }
  return false;
}

async function startBroker(
  deps: BootstrapDeps,
  config: BootstrapConfig,
  env: Record<string, string>,
  initialProbe: ProbeResult | undefined,
): Promise<string | null> {
  if (!initialProbe?.ok) {
    const image = await deps.commands.run(
      ["docker", "image", "inspect", "oh-my-pi/pi:dev"],
      commandOptions(config, env, 10_000),
    );
    if (image.exitCode === 0) {
      const result = await deps.commands.run(
        composeArgv("up", "-d", "auth-broker"),
        commandOptions(config, env, 60_000),
      );
      if (result.exitCode !== 0) return `auth-broker compose start failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`;
    } else {
      if (config.dataDir !== config.home && !config.dataDir.startsWith(`${config.home}/`)) {
        return `canonical data dir (${config.dataDir}) is outside HOME (${config.home}); the local omp broker requires a HOME-relative PI_CONFIG_DIR. Pull oh-my-pi/pi:dev and retry`;
      }
      deps.fs.mkdir(join(config.dataDir, ".omp"), 0o700);
      if (deps.fs.stat(config.brokerTokenFile) === null) {
        deps.fs.writeExclusive(config.brokerTokenFile, deps.randomHex(32), 0o600);
      }
      deps.fs.mkdir(config.dataDir, 0o700);
      if (deps.fs.stat(config.brokerLogFile) === null) deps.fs.writeExclusive(config.brokerLogFile, "", 0o600);
      const localRelative = relative(config.home, config.dataDir);
      const token = deps.fs.read(config.brokerTokenFile).trim();
      const result = await deps.commands.startDetached(
        ["omp", "auth-broker", "serve", "--bind=0.0.0.0:8765"],
        {
          ...commandOptions(config, {
            ...env,
            PI_CONFIG_DIR: join(localRelative, ".omp"),
            OMP_AUTH_BROKER_TOKEN: token,
          }),
          logFile: config.brokerLogFile,
        },
      );
      if (result.exitCode !== 0) return `local omp auth-broker failed to start: ${result.stderr.trim() || `exit ${result.exitCode}`}`;
      deps.log(`auth-broker: local fallback started; logs: ${config.brokerLogFile}`);
    }
  }
  if (!(await waitForBroker(deps, config))) {
    return `auth-broker did not become ready before the deterministic deadline; token and health must both be ready`;
  }
  return null;
}
function redactOutput(
  text: string,
  deps: BootstrapDeps,
  config: BootstrapConfig,
  env: Record<string, string>,
): string {
  const values = new Set<string>();
  for (const path of [config.proxyTokenFile, config.brokerTokenFile]) {
    if (presentOwnedFile(deps.fs, path, config.uid, 0o600)) values.add(deps.fs.read(path).trim());
  }
  for (const [name, value] of Object.entries(env)) {
    if (/(?:TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY|PRIVATE_KEY|AUTHORIZATION)/i.test(name)) values.add(value);
  }
  let redacted = text;
  for (const value of values) {
    if (value.length >= 4) redacted = redacted.replaceAll(value, "[REDACTED]");
  }
  return redacted;
}

async function applyPlan(
  deps: BootstrapDeps,
  config: BootstrapConfig,
  plan: SetupPlan,
  baseEnv: Record<string, string>,
): Promise<number> {
  const env = runtimeEnv(config, baseEnv);
  const prereqErrors = await prerequisites(deps, config, env);
  const caError = await validateCa(deps, config, env);
  if (caError !== null) prereqErrors.push(caError);
  if (prereqErrors.length > 0) {
    for (const error of prereqErrors) {
      deps.error(`bottega setup: prerequisite failed: ${redactOutput(error, deps, config, env)}`);
    }
    return 1;
  }

  for (const action of plan.actions) {
    let error: string | null = null;
    if (action.id === "seed") {
      const name = action.fileName;
      if (name === undefined) throw new Error("seed action omitted its file name");
      deps.fs.mkdir(config.agentDir, 0o700);
      deps.fs.copyExclusive(join(config.templateDir, name), join(config.agentDir, name), 0o600);
    } else if (action.id === "ca") {
      error = await generateCa(deps, config, env);
    } else if (action.id === "proxy-token") {
      deps.fs.mkdir(config.dataDir, 0o700);
      deps.fs.writeExclusive(config.proxyTokenFile, deps.randomHex(16), 0o600);
    } else if (action.id === "proxy") {
      if (!presentOwnedFile(deps.fs, config.proxyTokenFile, config.uid, 0o600)) {
        error = `iron-proxy cannot start without owned mode-0600 token ${config.proxyTokenFile}`;
      } else {
        error = await startProxy(deps, config, composeRuntimeEnv(deps, config, baseEnv));
      }
    } else if (action.id === "broker") {
      error = await startBroker(deps, config, composeRuntimeEnv(deps, config, baseEnv), action.initialProbe);
    }
    if (error !== null) {
      deps.error(`bottega setup: ${redactOutput(error, deps, config, env)}`);
      return 1;
    }
    deps.log(`bottega setup: applied ${action.description}`);
  }
  deps.log("bottega setup: complete. Credential values stay in the auth-broker vault; use `connect_upload_link` and `first_run_wizard` for guided credential checks.");
  return 0;
}

async function runDev(
  args: string[],
  deps: BootstrapDeps,
  config: BootstrapConfig,
  baseEnv: Record<string, string>,
): Promise<number> {
  const invalid = args.filter((arg) => arg !== "--watch");
  if (invalid.length > 0 || args.filter((arg) => arg === "--watch").length > 1) {
    deps.error(`bottega dev: expected only optional --watch (got ${args.join(" ")})`);
    return 2;
  }
  const plan = await inspectSetup(deps, config, true);
  if (plan.errors.length > 0 || plan.actions.length > 0) {
    deps.error("bottega dev: setup is incomplete; the server was not started");
    for (const error of plan.errors) deps.error(`  ${error}`);
    for (const action of plan.actions) deps.error(`  missing: ${action.description}`);
    deps.error("Run `bun run setup` to preview, then `bun run setup -- --apply`.");
    return 1;
  }

  const env = runtimeEnv(config, baseEnv);
  const prereqErrors = await prerequisites(deps, config, env);
  const caError = await validateCa(deps, config, env);
  if (caError !== null) prereqErrors.push(caError);
  const proxyToken = deps.fs.read(config.proxyTokenFile).trim();
  const brokerToken = deps.fs.read(config.brokerTokenFile).trim();
  const proxy = await deps.probe("proxy", proxyToken);
  const broker = await deps.probe("broker");
  if (!proxy.ok) prereqErrors.push("iron-proxy authenticated reload probe failed; run setup --apply for guarded stale-state recovery");
  if (!broker.ok || !brokerTokenReady(deps, config)) prereqErrors.push("auth-broker token + health readiness failed; run setup --apply");
  if (prereqErrors.length > 0) {
    for (const error of prereqErrors) {
      deps.error(`bottega dev: prerequisite failed: ${redactOutput(error, deps, config, env)}`);
    }
    return 1;
  }

  const finalEnv: Record<string, string> = {
    ...env,
    HTTP_PROXY: PROXY_TUNNEL_URL,
    HTTPS_PROXY: PROXY_TUNNEL_URL,
    NO_PROXY: NO_PROXY_LIST,
    NODE_EXTRA_CA_CERTS: config.caCertFile,
    SSL_CERT_FILE: config.caCertFile,
    IRON_MANAGEMENT_API_KEY: proxyToken,
    BOTTEGA_PROXY_CONTROL_URL: "http://127.0.0.1:9092",
    BOTTEGA_PROXY_CONTROL_TOKEN: proxyToken,
    OMP_AUTH_BROKER_URL: "http://127.0.0.1:8765",
    OMP_AUTH_BROKER_TOKEN: brokerToken,
  };
  deps.log("bottega dev: prerequisites ready; starting the server (credential values redacted)");
  return deps.commands.exec(
    ["bun", "run", ...(args.includes("--watch") ? ["--watch"] : []), "src/server/index.ts"],
    commandOptions(config, finalEnv),
  );
}

export async function runBootstrapCli(
  args: string[],
  deps: BootstrapDeps,
  config: BootstrapConfig,
  env: Record<string, string>,
): Promise<number> {
  const [mode, ...rawRest] = args;
  const rest = rawRest[0] === "--" ? rawRest.slice(1) : rawRest;
  if (mode === "setup") {
    const invalid = rest.filter((arg) => arg !== "--apply" && arg !== "--check");
    const apply = rest.includes("--apply");
    if (invalid.length > 0 || (apply && rest.includes("--check"))) {
      deps.error("bottega setup: usage: bun run setup [-- --check|--apply]");
      return 2;
    }
    const plan = await inspectSetup(deps, config, apply);
    printPlan(deps, plan, apply);
    if (plan.errors.length > 0) return 1;
    if (!apply) return 0;
    return applyPlan(deps, config, plan, env);
  }
  if (mode === "dev") return runDev(rest, deps, config, env);
  deps.error("bottega bootstrap: expected setup or dev");
  return 2;
}

async function httpProbe(kind: ProbeKind, token?: string): Promise<ProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3_000);
  try {
    let url = "http://127.0.0.1:8765/v1/healthz";
    if (kind === "proxy") url = "http://127.0.0.1:9092/v1/reload";
    if (kind === "proxy-status") url = "http://127.0.0.1:9092/";
    const response = await fetch(
      url,
      {
        method: kind === "proxy" ? "POST" : "GET",
        headers: kind === "proxy" && token !== undefined ? { Authorization: `Bearer ${token}` } : undefined,
        signal: controller.signal,
      },
    );
    return { ok: kind === "proxy-status" || response.ok, status: response.status };
  } catch {
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
}

function processEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) if (value !== undefined) result[key] = value;
  return result;
}

const systemCommands: CommandPort = {
  async run(argv, options) {
    const child = Bun.spawn(argv, {
      cwd: options.cwd,
      env: options.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => child.kill(), options.timeoutMs ?? 300_000);
    try {
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { exitCode, stdout, stderr };
    } finally {
      clearTimeout(timer);
    }
  },
  async startDetached(argv, options) {
    const fd = openSync(options.logFile, "a", 0o600);
    try {
      return await new Promise<CommandResult>((complete) => {
        const child = nodeSpawn(argv[0]!, argv.slice(1), {
          cwd: options.cwd,
          env: options.env,
          detached: true,
          stdio: ["ignore", fd, fd],
        });
        child.once("spawn", () => {
          child.unref();
          complete({ exitCode: 0, stdout: "", stderr: "" });
        });
        child.once("error", (error) => {
          complete({ exitCode: 1, stdout: "", stderr: error.message });
        });
      });
    } catch (error) {
      return { exitCode: 1, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
    } finally {
      closeSync(fd);
    }
  },
  async exec(argv, options) {
    const child = Bun.spawn(argv, {
      cwd: options.cwd,
      env: options.env,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    return child.exited;
  },
};

export const systemBootstrapDeps: BootstrapDeps = {
  fs: nodeBootstrapFs,
  commands: systemCommands,
  clock: { now: () => Date.now(), sleep: (ms) => Bun.sleep(ms) },
  probe: httpProbe,
  randomHex: (bytes) => randomBytes(bytes).toString("hex"),
  log: (line) => console.log(line),
  error: (line) => console.error(line),
};

function configFromProcess(): BootstrapConfig {
  const root = process.cwd();
  const dataDir = process.env.BOTTEGA_DEV_DATA_DIR ?? join(root, "data");
  const certsDir = process.env.BOTTEGA_DEV_CERTS_DIR ?? join(root, "certs");
  return bootstrapConfig({
    root,
    dataDir,
    certsDir,
    home: process.env.HOME ?? root,
    uid: process.getuid?.() ?? 0,
    gid: process.getgid?.() ?? 0,
    composeProject: process.env.COMPOSE_PROJECT_NAME,
    publicBaseFile: process.env.BOTTEGA_PUBLIC_BASE_URL_FILE,
  });
}

if (import.meta.main) {
  const exitCode = await runBootstrapCli(Bun.argv.slice(2), systemBootstrapDeps, configFromProcess(), processEnv(process.env));
  process.exit(exitCode);
}
