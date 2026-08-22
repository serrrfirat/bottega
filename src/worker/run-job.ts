/**
 * The per-job sandbox runner (issue #101, epic #229 P1): when
 * {@link ExecutorDeps.sandboxRunner} is present, git/extension jobs are
 * executed OUTSIDE the executor's main runWorkItemJob path — through this
 * module's {@link runJobSandboxBody}, which re-derives the job's scope from
 * its envelope id and drives the WHOLE job through the job-scoped store
 * facade ({@link createJobScopedStore}): claim, transitions, completion,
 * outbox row, and audits all write through the scope-guarded facade — never
 * the raw store. The boss loop's parent side ({@link runJobInSandbox})
 * maps the runner's exit code onto the job bus:
 *
 *   0 -> the sandbox completed the job itself (per-job outbox + audit
 *        written; the parent skips its own bookkeeping via selfReported).
 *   2 -> the sandbox already failed the job loudly (job.failed audit +
 *        item blocked written by the sandbox).
 *   3 -> transient lease-reclaim race — the parent requeues with backoff.
 *   other/signal/timeout -> CRASH: the parent fails the job loudly
 *        (failJob + job.failed audit) and unsticks the work item so it can
 *        NEVER hang at working after a sandbox crash (issue #149 question
 *        — the blocked landing guarantees the work item surfaces).
 *
 * P1 scope note: the runner is the per-job ISOLATION BOUNDARY — one job,
 * its own scoped store surface, per-kind resource caps. The PRODUCTION
 * boundary is one disposable Docker container (#101/#338): exactly one
 * validated job envelope enters exactly one container with an allowlisted
 * environment and explicit mounts, and the container is deterministically
 * removed on timeout/lease loss. The child-process and in-process runners
 * are TEST FABRIC ONLY and never used by production wiring (the executor
 * refuses to boot without the Docker runner). The contract — scope
 * re-derivation, fail-closed on anything but that one job, caps, and the
 * exit-code mapping — is implemented here and is what the caller-surface
 * tests pin.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { processItem, runIngestPollJob, runKbJob, type ExecutorConfig, type ExecutorDeps, type JobRunOutcome } from "../executor";
import type { Store } from "../store/db";
import type { OrgSettings } from "../store/org-settings";
import type { ResolvedMemoryProvider } from "../server/memory-provider";
import { JOB_COMPLETED_EVENT, JOB_FAILED_EVENT } from "../store/audit-events";
import { postOutboxRow, type OutboxWrite } from "../store/outbox";
import { createAudit, type AuditModule } from "../policy/audit";
import type { SchedulerActionName } from "../scheduler/types";
import { ingestPollJobPayloadSchema, scheduledJobPayloadSchema, workItemJobPayloadSchema, type WorkerJob } from "./envelope";
import { createJobScopedStore, jobScopeFromEnvelope } from "./scoped-store";
import { resolveKindCaps, type JobResourceCaps } from "./caps";
import { JobStoreRpcServer } from "./store-rpc";
import {
  MAX_SANDBOX_REQUEST_BYTES,
  MAX_SANDBOX_RESPONSE_BYTES,
  SANDBOX_PROTOCOL_VERSION,
  sandboxResponseSchema,
  type SandboxRequest,
} from "./sandbox-protocol";

/** What a sandbox run reported back to the boss loop. */
export interface SandboxResult {
  /** The child/body exit code. null when the runner died by signal or invalid IPC. */
  exitCode: number | null;
  /** The terminating signal, if any. */
  signal: string | null;
  /** True when the run was torn down by the supervisor's deadline. */
  timedOut: boolean;
  /** True when lease renewal proved that the parent no longer owns the job. */
  leaseLost?: boolean;
  /** Bounded protocol validation failure. Never contains child output beyond the cap. */
  protocolError?: string;
}

/** Per-run context handed to the runner. */
export interface SandboxRunnerContext {
  deps: ExecutorDeps;
  cfg: ExecutorConfig;
  /** The kind's resolved resource caps (org overrides on the defaults). */
  caps: JobResourceCaps;
  /** Aborted by the boss loop when lease renewal fails. The runner must kill the full process tree. */
  signal: AbortSignal;
}

/** The injectable runner seam (tests supply fakes; production supplies the Docker container). */
export type SandboxRunner = (job: WorkerJob, ctx: SandboxRunnerContext) => Promise<SandboxResult>;

/** Exit contract (see module doc). */
export const SANDBOX_EXIT_COMPLETED = 0;
export const SANDBOX_EXIT_FAILED = 2;
export const SANDBOX_EXIT_REQUEUE = 3;

/** Resolves the per-kind caps with the org settings `caps` overrides. */
export function capsFor(kind: WorkerJob["kind"], store: Store): JobResourceCaps {
  return resolveKindCaps(kind, store.getOrgSettings()?.caps ?? null);
}

/**
 * In-process body adapter for hermetic unit tests only. Production wiring
 * always uses {@link createDockerSandboxRunner}; the executor refuses
 * to start without an explicitly supplied runner.
 */
export function inProcessSandboxRunner(): SandboxRunner {
  return async (job, ctx) => {
    const deps: ExecutorDeps = {
      ...ctx.deps,
      store: createJobScopedStore(ctx.deps.store, jobScopeFromEnvelope(job)),
    };
    return runIsolatedJobBody(deps, ctx.cfg, ctx.caps, job);
  };
}

export interface ChildProcessSandboxOptions {
  /** The one database file made available to the child. */
  dbPath: string;
  /** Test seam; production uses the checked-in child entrypoint. */
  entrypoint?: string;
  /** Related credential mount used only by extension jobs. Never serialized or copied into other jobs. */
  brokerTokenFile?: string;
  /** Linux deployment must have prlimit; other OSes run the process-boundary lane only. */
  requireOsResourceLimits?: boolean;
}

export interface SandboxProbe {
  pid: number;
  childMarker: "1";
  forbiddenEnvNames: string[];
}

const SANDBOX_CHILD_ENTRYPOINT = fileURLToPath(new URL("./run-job-child.ts", import.meta.url));
const SAFE_CHILD_ENV_NAMES = [
  "PATH",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "TZ",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "SSL_CERT_FILE",
  "NODE_EXTRA_CA_CERTS",
  "BOTTEGA_EXTENSIONS_DIR",
  "BOTTEGA_CONFIG_DIR",
  "OMP_AUTH_BROKER_URL",
  "BOTTEGA_PROXY_CONTROL_URL",
  "BOTTEGA_PROXY_SECRETS_DIR",
] as const;

/**
 * TEST-FABRIC ONLY (never production): one strict DTO over bounded stdin, one
 * bounded reply over fd 3, an allowlisted environment, a new process group,
 * and hard timeout/lease-loss teardown of that entire group. Production uses
 * {@link createDockerSandboxRunner} — a child process is insufficient for the
 * #338 boundary because it shares the host filesystem and kernel namespace.
 */
export function createChildProcessSandboxRunner(options: ChildProcessSandboxOptions): SandboxRunner {
  if (options.dbPath.trim() === "") throw new Error("sandbox database path is required");
  const entrypoint = options.entrypoint ?? SANDBOX_CHILD_ENTRYPOINT;
  const requireLimits = options.requireOsResourceLimits ?? process.platform === "linux";
  const brokerTokenFile =
    options.brokerTokenFile ?? process.env.OMP_AUTH_BROKER_TOKEN_FILE ?? "/app/data/.omp/auth-broker.token";
  return async (job, ctx) => {
    const request: SandboxRequest = {
      version: SANDBOX_PROTOCOL_VERSION,
      mode: "execute",
      dbPath: options.dbPath,
      job,
      config: ctx.cfg,
      caps: ctx.caps,
    };
    const response = await spawnSandboxChild(request, {
      entrypoint,
      caps: ctx.caps,
      signal: ctx.signal,
      tokenFile: ctx.cfg.tokenFile,
      brokerTokenFile,
      requireLimits,
    });
    if ("result" in response) return response.result;
    if ("probe" in response) {
      return { exitCode: null, signal: null, timedOut: false, protocolError: "invalid sandbox IPC: unexpected probe" };
    }
    return response;
  };
}

/** Boot-time proof that the checked-in child entrypoint and sanitized env work. */
export async function probeChildProcessSandbox(options: {
  dbPath: string;
  transcriptDir: string;
  requireOsResourceLimits?: boolean;
}): Promise<SandboxProbe> {
  const response = await spawnSandboxChild(
    { version: SANDBOX_PROTOCOL_VERSION, mode: "probe" },
    {
      entrypoint: SANDBOX_CHILD_ENTRYPOINT,
      caps: { timeoutMs: 10_000, memoryMb: 512 },
      signal: new AbortController().signal,
      tokenFile: "",
      brokerTokenFile: "",
      requireLimits: options.requireOsResourceLimits ?? process.platform === "linux",
    },
  );
  if ("protocolError" in response) throw new Error(response.protocolError);
  if (!("probe" in response)) throw new Error("sandbox probe failed");
  return response.probe;
}

// ---------------------------------------------------------------------------
// Production Docker sandbox runner (issue #101, epic #229 P1, issue #338).
//
// One disposable container per claimed job. The container receives ONLY:
//   - the validated job envelope (a strict DTO over bounded stdin),
//   - the writable work-item workspace and the single SQLite store file
//     (the existing scoped-store/envelope boundary — the job-scoped facade
//     guards every row access to this job's own rows),
//   - job-scoped credential FILE mounts (git PAT / auth-broker token) for
//     the kinds that need them,
//   - an allowlisted environment (no Slack tokens, no parent env),
//   - proxy/CA configuration for egress.
// It receives NO Docker socket, no raw store handle beyond the scoped file,
// no unrelated credentials, and no undeclared mounts. Root filesystem is
// read-only; resource caps and full-container teardown are mandatory.
// stdout carries the single bounded result JSON; stderr streams job logs.
// ---------------------------------------------------------------------------

/** Container-internal mount points (the app image WORKDIR is /app). */
/** No bottega.db is ever mounted: the child reaches the store only over RPC. */
const CONTAINER_WORKSPACES_ROOT = "/workspaces";
const CONTAINER_TRANSCRIPTS_ROOT = "/transcripts";
const CONTAINER_RPC_DIR = "/rpc";
/** The git credential dir (PAT + askpass) mounted exactly for git-authorized jobs. */
const CONTAINER_GIT_SECRETS_DIR = "/app/data/secrets";
const CONTAINER_GIT_TOKEN_FILE = "/app/data/secrets/github-pat";
/** The auth-broker credential dir mounted exactly for extension jobs. */
const CONTAINER_BROKER_DIR = "/app/data/.omp";
const CONTAINER_BROKER_TOKEN_FILE = "/app/data/.omp/auth-broker.token";
const CONTAINER_CA_CERT_PATH = "/etc/iron-proxy/certs/ca.crt";
const CONTAINER_ASKPASS_SCRIPT = "/app/data/secrets/git-askpass.sh";
/** The job container image: the app image builds FROM the curated tools image. */
const DEFAULT_SANDBOX_IMAGE = process.env.BOTTEGA_SANDBOX_IMAGE ?? "bottega:local";
/** Docker-out-of-Docker: the executor mounts the host socket to launch siblings. */
const DEFAULT_DOCKER_SOCKET = "/var/run/docker.sock";
/** Where the checked-in child entrypoint lives inside the app image. */
const CONTAINER_CHILD_ENTRYPOINT = "/app/src/worker/run-job-child.ts";

export interface DockerSandboxOptions {
  /** Host path to the job's own workspace dir (git/extension), mounted exactly. */
  workspacesDir: string;
  /** Host path to the transcripts dir; the job's own subdir is mounted exactly. */
  transcriptDir: string;
  /**
   * When set (e.g. "data"), the runner mounts the named volume via
   * `--mount type=volume,volume-subpath=<exact subdir>` so the job container
   * sees ONLY its own workspace/transcript/credential/socket subpaths — never
   * the whole volume. Used by the compose deployment (Docker-out-of-Docker).
   * Host paths below are the SUPERVISOR's view (the executor container).
   */
  volume?: string;
  /**
   * The supervisor-visible host path at which the named volume root is
   * mounted for the workspaces axis (volume mode). In compose, `data` mounts
   * at `/workspaces`, so this is `/workspaces` and a job workspace
   * `<workspacesDir>/<itemId>` maps to volume-subpath `<itemId>`.
   */
  volumeWorkspacesRoot?: string;
  /**
   * The supervisor-visible host path at which the named volume root is
   * mounted for the transcripts/state axis (volume mode). In compose, `data`
   * mounts at `/app/data`, so this is `/app/data` and a transcript dir
   * `/app/data/transcripts/<itemId>` maps to volume-subpath
   * `transcripts/<itemId>`.
   */
  volumeStateRoot?: string;
  /** The supervisor's job args/request must never reveal a DB path — this is never mounted. */
  /** Job container image (defaults to the app/tools-derived image). */
  image?: string;
  /** Docker network the job container joins (egress). "none" for hermetic. */
  network?: string;
  /** DNS server(s) for the container (iron-proxy default-deny). */
  dns?: string[];
  /** HTTP/HTTPS proxy URL passed into the container (iron-proxy tunnel). */
  proxyUrl?: string;
  /** Host path to the egress MITM CA cert, bind-mounted read-only. */
  caCertHostPath?: string;
  /** Host path to the git PAT file (git kind only). */
  gitTokenFile?: string;
  /** Host path to the auth-broker token file (extension kind only). */
  brokerTokenFile?: string;
  /** Host path to the askpass script (git kind). */
  askpassScript?: string;
  /**
   * The supervisor's REAL store (issue #101). The RPC server the supervisor
   * starts per job wraps THIS store in the job's scope; the job container
   * never sees the raw handle. Required for the production lane.
   */
  hostStore?: Store;
  /**
   * The supervisor's REAL memory provider (issue #101). The RPC server
   * forwards the job's memory calls to it (kb ingest saves org memories;
   * scheduled consolidation runs supervisor-side). Required for production.
   */
  memoryProvider?: ResolvedMemoryProvider;
  /** The supervisor's parsed org settings, serialized into the job request so the child boot needs no sync store read. */
  orgSettings?: OrgSettings | null;
  /** Inject a docker CLI seam (tests). Production uses the real docker CLI. */
  docker?: DockerClient;
  /** Fail closed at boot when docker is unavailable (no in-process/child fallback). */
  requireDocker?: boolean;
  /** Unique container name prefix; tests assert it to prove container identity. */
  namePrefix?: string;
}

/** The docker CLI seam the supervisor talks through (testable without docker). */
export interface DockerClient {
  launch(args: string[]): DockerProcess;
}

/** A running `docker` subprocess driving one job container. */
export interface DockerProcess {
  /** Write the request DTO and end (bounded stdin). */
  stdin: Writable;
  /** The bounded protocol channel (container stdout). */
  stdout: Readable;
  /** Job log stream (container stderr). */
  stderr: Readable;
  /** Resolves when the docker CLI process exits. */
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /** Deterministic full-container teardown. */
  kill(signal?: NodeJS.Signals): void;
}

/** The real docker CLI client. */
export function createDockerClient(socket: string): DockerClient {
  return {
    launch(args: string[]): DockerProcess {
      const child = spawn("docker", args, {
        env: { ...process.env, DOCKER_HOST: socket.startsWith("/") ? `unix://${socket}` : socket },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let spawnError: Error | null = null;
      const processError: Promise<{ code: null; signal: null }> = new Promise((resolve) => {
        child.once("error", (error: Error) => {
          spawnError = error;
          resolve({ code: null, signal: null });
        });
      });
      // A missing docker binary or unreachable socket must fail closed (never
      // hang on a dead stdout). Surface the spawn error on stdout so the
      // bounded read rejects and the exit promise settles fast.
      void processError.then(() => {
        if (child.stdout) child.stdout.destroy(spawnError ?? undefined);
        if (child.stderr) child.stderr.destroy();
      });
      return {
        stdin: child.stdin as Writable,
        stdout: child.stdout as Readable,
        stderr: child.stderr as Readable,
        exit: Promise.race([
          new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
            child.once("exit", (code, signal) => resolve({ code, signal }));
          }),
          processError,
        ]),
        kill(signal: NodeJS.Signals = "SIGKILL") {
          try {
            child.kill(signal);
          } catch {
            // already gone; the exit event is the teardown proof.
          }
        },
      };
    },
  };
}

/** Boot-time proof that docker and the job container image are usable. */
export async function probeDockerSandbox(options: {
  workspacesDir: string;
  transcriptDir: string;
  volume?: string;
  image?: string;
  network?: string;
  gitTokenFile?: string;
  brokerTokenFile?: string;
  requireDocker?: boolean;
}): Promise<SandboxProbe> {
  const docker = options.requireDocker ? requireDockerClient() : optionalDockerClient();
  if (docker === null) throw new Error("sandbox unavailable: docker CLI or socket is not available (no container fallback)");
  const response = await launchDockerContainer(docker, { version: SANDBOX_PROTOCOL_VERSION, mode: "probe" }, {
    workspacesDir: options.workspacesDir,
    transcriptDir: options.transcriptDir,
    volume: options.volume,
    image: options.image ?? DEFAULT_SANDBOX_IMAGE,
    network: options.network ?? process.env.BOTTEGA_SANDBOX_NETWORK ?? "none",
    gitTokenFile: options.gitTokenFile,
    brokerTokenFile: options.brokerTokenFile,
    jobId: "probe",
    caps: { timeoutMs: 10_000, memoryMb: 512 },
    signal: new AbortController().signal,
    containerName: `bottega-sandbox-probe-${Date.now().toString(36)}`,
  });
  if (response.kind === "error") throw new Error(response.protocolError);
  if (response.kind === "result" && response.result.protocolError) throw new Error(response.result.protocolError);
  if (response.kind !== "probe") throw new Error("sandbox probe failed");
  return response.probe;
}

/**
 * Production one-job Docker runner. Exactly one validated job envelope
 * enters exactly one disposable container; container exit, signal, timeout,
 * lease loss, and protocol mismatch all fail closed. There is NO fallback to
 * a host child process or in-process execution.
 */
export function createDockerSandboxRunner(options: DockerSandboxOptions): SandboxRunner {
  if (options.workspacesDir.trim() === "") throw new Error("sandbox workspaces dir is required");
  if (options.hostStore === undefined) throw new Error("sandbox store is required (the supervisor's real store)");
  if (options.memoryProvider === undefined) throw new Error("sandbox memory provider is required (the supervisor's real provider)");
  const docker = options.docker ?? (options.requireDocker ? requireDockerClient() : optionalDockerClient());
  if (docker === null) {
    throw new Error("sandbox unavailable: docker CLI or socket is not available (no container fallback)");
  }
  const image = options.image ?? DEFAULT_SANDBOX_IMAGE;
  const network = options.network ?? process.env.BOTTEGA_SANDBOX_NETWORK ?? "none";
  const namePrefix = options.namePrefix ?? "bottega-sandbox";
  return async (job, ctx) => {
    const request: SandboxRequest = {
      version: SANDBOX_PROTOCOL_VERSION,
      mode: "execute",
      // The job container NEVER opens or mounts a SQLite store file: dbPath is
      // omitted. It reaches the store only over the mounted RPC socket.
      job,
      config: containerConfig(ctx.cfg, options),
      caps: ctx.caps,
      orgSettings: options.orgSettings ?? undefined,
    };
    const containerName = `${namePrefix}-${sanitizeContainerName(job.id)}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const response = await launchDockerContainer(docker, request, {
      workspacesDir: options.workspacesDir,
      transcriptDir: options.transcriptDir,
      volume: options.volume,
      volumeWorkspacesRoot: options.volumeWorkspacesRoot,
      volumeStateRoot: options.volumeStateRoot,
      hostStore: options.hostStore,
      memoryProvider: options.memoryProvider,
      askpassScript: options.askpassScript ?? ctx.cfg.askpassScript,
      image,
      network,
      dns: options.dns,
      proxyUrl: options.proxyUrl,
      caCertHostPath: options.caCertHostPath,
      gitTokenFile: options.gitTokenFile ?? ctx.cfg.tokenFile,
      brokerTokenFile: options.brokerTokenFile,
      job: job,
      jobId: job.id,
      caps: ctx.caps,
      signal: ctx.signal,
      containerName,
    });
    if (response.kind === "result") return response.result;
    if (response.kind === "probe") {
      return { exitCode: null, signal: null, timedOut: false, protocolError: "invalid sandbox IPC: unexpected probe" };
    }
    return { exitCode: null, signal: null, timedOut: false, protocolError: response.protocolError };
  };
}

/** Rewrites the host config paths to their container-internal mount points. */
function containerConfig(cfg: ExecutorConfig, _options: DockerSandboxOptions): ExecutorConfig {
  return {
    ...cfg,
    workspacesDir: CONTAINER_WORKSPACES_ROOT,
    transcriptDir: CONTAINER_TRANSCRIPTS_ROOT,
    tokenFile: CONTAINER_GIT_TOKEN_FILE,
    askpassScript: CONTAINER_ASKPASS_SCRIPT,
  };
}

function sanitizeContainerName(id: string): string {
  return id.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 48);
}

function requireDockerClient(): DockerClient {
  return createDockerClient(process.env.BOTTEGA_SANDBOX_DOCKER_SOCKET ?? DEFAULT_DOCKER_SOCKET);
}

function optionalDockerClient(): DockerClient | null {
  const socket = process.env.BOTTEGA_SANDBOX_DOCKER_SOCKET ?? DEFAULT_DOCKER_SOCKET;
  if (!existsSync(socket)) return null;
  return createDockerClient(socket);
}

type DockerLaunchResult =
  | { kind: "result"; result: SandboxResult }
  | { kind: "probe"; probe: SandboxProbe }
  | { kind: "error"; protocolError: string };

interface DockerLaunchOptions {
  workspacesDir: string;
  transcriptDir: string;
  volume?: string;
  volumeWorkspacesRoot?: string;
  volumeStateRoot?: string;
  askpassScript?: string;
  image: string;
  network: string;
  dns?: string[];
  proxyUrl?: string;
  caCertHostPath?: string;
  gitTokenFile?: string;
  brokerTokenFile?: string;
  /** The supervisor's real store, host-side (job-scoped RPC host). */
  hostStore?: import("../store/db").Store;
  memoryProvider?: ResolvedMemoryProvider;
  job?: WorkerJob;
  jobId: string;
  caps: JobResourceCaps;
  signal: AbortSignal;
  containerName: string;
}

/**
 * Launches one disposable job container, writes the bounded request DTO over
 * stdin, reads the single bounded result JSON from stdout (job logs stream
 * from stderr), and deterministically removes the container on timeout,
 * lease loss, IPC violation, or normal exit. The supervisor starts a
 * job-scoped {@link JobStoreRpcServer} over the shared volume/socket dir
 * before launch and tears it down (with the per-job credential/socket
 * subdirs) after the container exits — the container never sees the DB.
 */
async function launchDockerContainer(
  docker: DockerClient,
  request: SandboxRequest,
  opts: DockerLaunchOptions,
): Promise<DockerLaunchResult> {
  const encoded = JSON.stringify(request);
  if (Buffer.byteLength(encoded) > MAX_SANDBOX_REQUEST_BYTES) {
    return { kind: "error", protocolError: "sandbox request exceeds IPC limit" };
  }
  // Prepare the per-job RPC socket dir + credentials, then start the
  // job-scoped store RPC host (execute lane only; the probe needs no store).
  const prep = request.mode === "execute" ? prepareJobMounts(opts) : null;
  let rpcServer: JobStoreRpcServer | null = null;
  let rpcDirHost = "";
  if (prep !== null) {
    rpcDirHost = prep.rpcDirHost;
    if (opts.hostStore !== undefined && opts.job !== undefined) {
      rpcServer = JobStoreRpcServer.create(opts.hostStore, opts.job, rpcDirHost, {
        memoryProvider: opts.memoryProvider,
      });
      try {
        await rpcServer.listen();
      } catch (error) {
        cleanupJobMounts(prep);
        return { kind: "error", protocolError: `sandbox unavailable: store RPC socket bind failed: ${error instanceof Error ? error.message : String(error)}` };
      }
    }
  }
  const args = dockerRunArgs(request, opts, rpcDirHost);
  let proc: DockerProcess;
  try {
    proc = docker.launch(args);
  } catch (error) {
    rpcServer?.close();
    cleanupJobMounts(prep);
    return { kind: "error", protocolError: `sandbox unavailable: docker launch failed: ${error instanceof Error ? error.message : String(error)}` };
  }

  let responseBytes: Buffer;
  let timedOut = false;
  let leaseLost = false;
  const boundedResponse = readBounded(proc.stdout, MAX_SANDBOX_RESPONSE_BYTES, () => {
    if (proc.stdin.writable) proc.stdin.destroy();
    killDockerContainer(docker, opts.containerName);
  });
  // Job logs (stderr) stream to the supervisor log; never captured past a cap.
  proc.stderr.on("data", (chunk: Buffer | string) => {
    const text = chunk.toString("utf8").trim();
    if (text.length > 0) console.log(`[${opts.jobId}] sandbox: ${text.slice(0, 2000)}`);
  });
  const timeout = setTimeout(() => {
    timedOut = true;
    if (proc.stdin.writable) proc.stdin.destroy();
    killDockerContainer(docker, opts.containerName);
  }, opts.caps.timeoutMs);
  const abort = (): void => {
    leaseLost = true;
    if (proc.stdin.writable) proc.stdin.destroy();
    killDockerContainer(docker, opts.containerName);
  };
  opts.signal.addEventListener("abort", abort, { once: true });
  try {
    proc.stdin.end(encoded);
  } catch {
    // stdin already closed; the container will fail closed on its own IPC read.
  }
  const exited = await proc.exit;
  clearTimeout(timeout);
  opts.signal.removeEventListener("abort", abort);
  // Guaranteed cleanup: never leak a container after the launcher returns
  // (--rm already removes it on exit; the net rm covers unexpected states).
  ensureContainerRemoved(docker, opts.containerName);
  rpcServer?.close();
  cleanupJobMounts(prep);

  if (timedOut || leaseLost) {
    const tornDown: SandboxResult = { exitCode: null, signal: exited.signal ?? "SIGKILL", timedOut };
    if (leaseLost) tornDown.leaseLost = true;
    return { kind: "result", result: tornDown };
  }
  try {
    responseBytes = await boundedResponse;
  } catch (error) {
    return { kind: "result", result: { exitCode: null, signal: exited.signal, timedOut: false, protocolError: `invalid sandbox IPC: ${error instanceof Error ? error.message : String(error)}` } };
  }
  if (responseBytes.length === 0) {
    return { kind: "result", result: { exitCode: null, signal: exited.signal, timedOut: false, protocolError: "invalid sandbox IPC: empty response" } };
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(responseBytes.toString("utf8"));
  } catch {
    return { kind: "result", result: { exitCode: null, signal: exited.signal, timedOut: false, protocolError: "invalid sandbox IPC: response is not JSON" } };
  }
  const parsed = sandboxResponseSchema.safeParse(parsedJson);
  if (!parsed.success || !Number.isInteger(parsed.data.pid) || parsed.data.pid <= 0) {
    return { kind: "result", result: { exitCode: null, signal: exited.signal, timedOut: false, protocolError: "invalid sandbox IPC: schema or PID mismatch" } };
  }
  if (parsed.data.mode === "probe") {
    return { kind: "probe", probe: { pid: parsed.data.pid, childMarker: parsed.data.childMarker, forbiddenEnvNames: parsed.data.forbiddenEnvNames } };
  }
  const expectedProcessExit = parsed.data.result.exitCode ?? 70;
  if (exited.signal !== null || exited.code !== expectedProcessExit) {
    return { kind: "result", result: { exitCode: null, signal: exited.signal, timedOut: false, protocolError: "invalid sandbox IPC: exit mismatch" } };
  }
  return { kind: "result", result: parsed.data.result };
}

/** Builds the one `docker run --rm -i` invocation for a single job container. */
function dockerRunArgs(request: SandboxRequest, opts: DockerLaunchOptions, rpcDirHost: string): string[] {
  const args = [
    "run",
    "--rm",
    "-i",
    "--name",
    opts.containerName,
    "--memory",
    `${opts.caps.memoryMb}m`,
    "--pids-limit",
    "128",
    "--cap-drop",
    "ALL",
    "--read-only",
    "--network",
    opts.network,
  ];
  if (opts.dns !== undefined && opts.dns.length > 0) {
    for (const dns of opts.dns) args.push("--dns", dns);
  }
  // Exact per-job mounts only — NEVER the whole shared volume and NEVER the
  // SQLite store. The job container sees its own workspace subdir, its own
  // transcript subdir, the RPC socket dir, the egress CA, and the exact
  // kind-authorized credential files/subdirs. Root stays read-only.
  appendContainerMounts(args, request, opts, rpcDirHost);

  // Allowlisted environment only: the child marker + Docker lane marker, the
  // job-scoped credential handles, and the allowlisted host passthroughs.
  const env: Record<string, string> = { BOTTEGA_SANDBOX_CHILD: "1", BOTTEGA_SANDBOX_DOCKER: "1" };
  for (const name of SAFE_CHILD_ENV_NAMES) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  if (opts.proxyUrl !== undefined && opts.proxyUrl !== "") {
    env.HTTP_PROXY = opts.proxyUrl;
    env.HTTPS_PROXY = opts.proxyUrl;
    env.NO_PROXY ??= "localhost,127.0.0.1,data,auth-broker,auth-gateway,mem0";
  }
  if (opts.caCertHostPath !== undefined && opts.caCertHostPath !== "") {
    env.NODE_EXTRA_CA_CERTS = CONTAINER_CA_CERT_PATH;
  }
  if (request.mode === "execute") {
    const needsGitToken = jobNeedsGitToken(request.job);
    if (opts.gitTokenFile !== undefined && opts.gitTokenFile !== "" && needsGitToken) {
      env.EXECUTOR_GIT_TOKEN_FILE = CONTAINER_GIT_TOKEN_FILE;
    }
    if (request.job.kind === "extension" && opts.brokerTokenFile !== undefined && opts.brokerTokenFile !== "") {
      env.OMP_AUTH_BROKER_TOKEN_FILE = CONTAINER_BROKER_TOKEN_FILE;
    }
  }
  for (const [name, value] of Object.entries(env)) {
    args.push("--env", `${name}=${value}`);
  }
  args.push(opts.image, "bun", CONTAINER_CHILD_ENTRYPOINT);
  return args;
}

/** Appends the exact per-job mounts to the `docker run` arg list. */
function appendContainerMounts(args: string[], request: SandboxRequest, opts: DockerLaunchOptions, rpcDirHost: string): void {
  const volumeMode = opts.volume !== undefined && opts.volume !== "";
  const itemId = request.mode === "execute" ? jobScopeFromEnvelope(request.job).workItemId : null;

  // Per-job workspace subdir (git/extension only).
  if (itemId !== null) {
    const workspaceHost = join(opts.workspacesDir, itemId);
    if (volumeMode) {
      const sub = relativeSubpath(opts.volumeWorkspacesRoot ?? opts.workspacesDir, workspaceHost);
      args.push("--mount", `type=volume,src=${opts.volume},dst=${join(CONTAINER_WORKSPACES_ROOT, itemId)},volume-subpath=${sub}`);
    } else {
      args.push("-v", `${workspaceHost}:${join(CONTAINER_WORKSPACES_ROOT, itemId)}:rw`);
    }
  }
  // Per-job transcript/session subdir (git/extension only).
  if (itemId !== null) {
    const transcriptHost = join(opts.transcriptDir, itemId);
    if (volumeMode) {
      const sub = relativeSubpath(opts.volumeStateRoot ?? dirname(opts.transcriptDir), transcriptHost);
      args.push("--mount", `type=volume,src=${opts.volume},dst=${join(CONTAINER_TRANSCRIPTS_ROOT, itemId)},volume-subpath=${sub}`);
    } else {
      args.push("-v", `${transcriptHost}:${join(CONTAINER_TRANSCRIPTS_ROOT, itemId)}:rw`);
    }
  }
  // Per-job RPC socket dir (execute lane only).
  if (request.mode === "execute" && rpcDirHost !== "") {
    if (volumeMode) {
      const sub = relativeSubpath(opts.volumeStateRoot ?? dirname(opts.transcriptDir), rpcDirHost);
      args.push("--mount", `type=volume,src=${opts.volume},dst=${CONTAINER_RPC_DIR},volume-subpath=${sub}`);
    } else {
      args.push("-v", `${rpcDirHost}:${CONTAINER_RPC_DIR}:rw`);
    }
  }
  // Egress MITM CA (read-only).
  if (opts.caCertHostPath !== undefined && opts.caCertHostPath !== "") {
    args.push("-v", `${opts.caCertHostPath}:${CONTAINER_CA_CERT_PATH}:ro`);
  }
  // Exact kind-authorized credential material. In volume mode these come
  // from the job-specific prepared credential subdirs (see prepareJobMounts).
  if (request.mode === "execute") {
    if (jobNeedsGitToken(request.job) && opts.gitTokenFile !== undefined && opts.gitTokenFile !== "") {
      if (volumeMode) {
        args.push("--mount", `type=volume,src=${opts.volume},dst=${CONTAINER_GIT_SECRETS_DIR},volume-subpath=${relativeSubpath(opts.volumeStateRoot ?? dirname(opts.transcriptDir), gitCredDirHost(opts, request.job.id))}`);
      } else {
        args.push("-v", `${opts.gitTokenFile}:${CONTAINER_GIT_TOKEN_FILE}:ro`);
        if (opts.askpassScript !== undefined && opts.askpassScript !== "") {
          args.push("-v", `${opts.askpassScript}:${CONTAINER_ASKPASS_SCRIPT}:ro`);
        }
      }
    }
    if (request.job.kind === "extension" && opts.brokerTokenFile !== undefined && opts.brokerTokenFile !== "") {
      if (volumeMode) {
        args.push("--mount", `type=volume,src=${opts.volume},dst=${CONTAINER_BROKER_DIR},volume-subpath=${relativeSubpath(opts.volumeStateRoot ?? dirname(opts.transcriptDir), extensionCredDirHost(opts, request.job.id))}`);
      } else {
        args.push("-v", `${opts.brokerTokenFile}:${CONTAINER_BROKER_TOKEN_FILE}:ro`);
      }
    }
  }
}

/** True when a job kind legitimately authorizes the git PAT file (git delivery + github ingest_poll). */
function jobNeedsGitToken(job: WorkerJob): boolean {
  if (job.kind === "git") return true;
  if (job.kind === "ingest_poll") {
    const parsed = ingestPollJobPayloadSchema.safeParse(job.payload);
    return parsed.success && parsed.data.provider === "github";
  }
  return false;
}

/** The host-space sandbox staging root under the shared volume (via the state axis). */
function sandboxStagingRoot(opts: DockerLaunchOptions): string {
  return join(dirname(opts.transcriptDir), ".omp", "sandbox");
}
/** Host path of the git credential subdir prepared for a job. */
function gitCredDirHost(opts: DockerLaunchOptions, jobId: string): string {
  return join(sandboxStagingRoot(opts), "creds", jobId, "git");
}
/** Host path of the extension credential subdir prepared for a job. */
function extensionCredDirHost(opts: DockerLaunchOptions, jobId: string): string {
  return join(sandboxStagingRoot(opts), "creds", jobId, "extension");
}

interface PreparedJobMounts {
  rpcDirHost: string;
  /** Host paths created; removed on teardown (never shared roots). */
  createdDirs: string[];
}

/**
 * Prepares the per-job writable subdirs the container will see: the RPC
 * socket dir (and, in volume mode, the workspace/transcript/credential
 * subdirs so `volume-subpath` exists). Only the exact subdirs are created —
 * never a shared root. Returns the staging handle for teardown.
 */
function prepareJobMounts(opts: DockerLaunchOptions): PreparedJobMounts {
  const staging = sandboxStagingRoot(opts);
  const rpcDirHost = join(staging, "rpc", opts.jobId);
  const createdDirs: string[] = [rpcDirHost];
  mkdirSync(rpcDirHost, { recursive: true });
  const itemId = opts.job !== undefined ? jobScopeFromEnvelope(opts.job).workItemId : null;
  if (itemId !== null) {
    const workspaceHost = join(opts.workspacesDir, itemId);
    mkdirSync(workspaceHost, { recursive: true });
    createdDirs.push(workspaceHost);
    const transcriptHost = join(opts.transcriptDir, itemId);
    mkdirSync(transcriptHost, { recursive: true });
    createdDirs.push(transcriptHost);
  }
  // Copy the exact kind-authorized credential files into per-job credential
  // dirs (volume mode mounts `volume-subpath` into the container). We copy
  // rather than mount individual files because `--mount volume-subpath` can
  // only address an existing subdir on the shared volume.
  if (opts.job !== undefined) {
    if (jobNeedsGitToken(opts.job) && opts.gitTokenFile !== undefined && opts.gitTokenFile !== "" && opts.askpassScript !== undefined && opts.askpassScript !== "") {
      const gitDir = gitCredDirHost(opts, opts.jobId);
      mkdirSync(gitDir, { recursive: true });
      copyFileInto(opts.gitTokenFile, join(gitDir, "github-pat"), 0o600);
      copyFileInto(opts.askpassScript, join(gitDir, "git-askpass.sh"), 0o700);
      createdDirs.push(gitDir);
    }
    if (opts.job.kind === "extension" && opts.brokerTokenFile !== undefined && opts.brokerTokenFile !== "") {
      const extDir = extensionCredDirHost(opts, opts.jobId);
      mkdirSync(extDir, { recursive: true });
      copyFileInto(opts.brokerTokenFile, join(extDir, "auth-broker.token"), 0o600);
      createdDirs.push(extDir);
    }
  }
  return { rpcDirHost, createdDirs };
}

/** Copies a secret file into the per-job credential dir with the exact mode. */
function copyFileInto(src: string, dest: string, mode: number): void {
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, readFileSync(src), { mode });
  chmodSync(dest, mode);
}

/** Best-effort per-job teardown: removes only the dirs this job created. */
function cleanupJobMounts(prep: PreparedJobMounts | null): void {
  if (prep === null) return;
  for (const dir of prep.createdDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort; the container (--rm) is already gone and a leftover
      // per-job dir is inert, not a shared-root leak.
    }
  }
}

/** The path of `full` relative to `root` (both absolute), with no leading slash. */
function relativeSubpath(root: string, full: string): string {
  const r = root.replace(/\/+$/, "");
  const f = full.replace(/\/+$/, "");
  if (!f.startsWith(r)) {
    throw new Error(`path ${full} is not inside volume root ${root}`);
  }
  return f.slice(r.length).replace(/^\/+/, "");
}

/** Deterministic full-container teardown: SIGKILL the container's cgroup. */
function killDockerContainer(docker: DockerClient, name: string): void {
  // `docker kill` SIGKILLs the container's PID 1; the runtime then tears
  // down the whole container process tree/cgroup. The `--rm` flag removes
  // the filesystem on exit. Fire-and-forget (docker kill runs to completion;
  // the `docker run` process the supervisor is attached to exits once the
  // container dies, and that exit is the teardown proof).
  try {
    docker.launch(["kill", name]);
  } catch {
    // container already gone
  }
}

/** Best-effort, guaranteed no-leak removal after the launcher returns. */
function ensureContainerRemoved(docker: DockerClient, name: string): void {
  try {
    const rm = docker.launch(["rm", "-f", name]);
    void rm.exit.catch(() => undefined);
  } catch {
    // already removed by --rm
  }
}

type SpawnChildResult =
  | { result: SandboxResult }
  | { probe: SandboxProbe }
  | SandboxResult;

/**
 * Environment handed to a sandbox child: the child marker, the two
 * kind-scoped credential mounts (set only for their own job kind), and the
 * allowlisted host passthrough names.
 */
type SandboxChildEnv = {
  BOTTEGA_SANDBOX_CHILD: string;
  EXECUTOR_GIT_TOKEN_FILE?: string;
  OMP_AUTH_BROKER_TOKEN_FILE?: string;
} & Partial<{ [K in (typeof SAFE_CHILD_ENV_NAMES)[number]]: string }>;

async function spawnSandboxChild(
  request: SandboxRequest,
  options: {
    entrypoint: string;
    caps: JobResourceCaps;
    signal: AbortSignal;
    tokenFile: string;
    requireLimits: boolean;
    brokerTokenFile: string;
  },
): Promise<SpawnChildResult> {
  const encoded = JSON.stringify(request);
  if (Buffer.byteLength(encoded) > MAX_SANDBOX_REQUEST_BYTES) {
    return { exitCode: null, signal: null, timedOut: false, protocolError: "sandbox request exceeds IPC limit" };
  }
  const command = sandboxCommand(options.entrypoint, options.caps.memoryMb, options.requireLimits);
  if ("error" in command) {
    return { exitCode: null, signal: null, timedOut: false, protocolError: command.error };
  }
  const env: SandboxChildEnv = { BOTTEGA_SANDBOX_CHILD: "1" };
  for (const name of SAFE_CHILD_ENV_NAMES) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  if (options.tokenFile !== "" && request.mode === "execute" && request.job.kind === "git") {
    env.EXECUTOR_GIT_TOKEN_FILE = options.tokenFile;
  }
  if (options.brokerTokenFile !== "" && request.mode === "execute" && request.job.kind === "extension") {
    env.OMP_AUTH_BROKER_TOKEN_FILE = options.brokerTokenFile;
  }

  let child: ChildProcess;
  try {
    child = spawn(command.file, command.args, {
      detached: process.platform !== "win32",
      env,
      stdio: ["pipe", "inherit", "inherit", "pipe"],
    });
  } catch (error) {
    return {
      exitCode: null,
      signal: null,
      timedOut: false,
      protocolError: `sandbox unavailable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const responseStream = child.stdio[3];
  if (!(responseStream instanceof Readable) || child.stdin === null) {
    killProcessTree(child);
    return { exitCode: null, signal: null, timedOut: false, protocolError: "sandbox IPC pipes unavailable" };
  }

  let responseBytes: Buffer;
  const boundedResponse = readBounded(responseStream, MAX_SANDBOX_RESPONSE_BYTES, () => killProcessTree(child));
  child.stdin.end(encoded);
  let timedOut = false;
  let leaseLost = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    killProcessTree(child);
  }, options.caps.timeoutMs);
  const abort = (): void => {
    leaseLost = true;
    killProcessTree(child);
  };
  options.signal.addEventListener("abort", abort, { once: true });
  const exitWait = Promise.withResolvers<{ code: number | null; signal: NodeJS.Signals | null }>();
  child.once("error", () => exitWait.resolve({ code: null, signal: null }));
  child.once("exit", (code, signal) => exitWait.resolve({ code, signal }));
  const exited = await exitWait.promise;
  clearTimeout(timeout);
  options.signal.removeEventListener("abort", abort);
  try {
    responseBytes = await boundedResponse;
  } catch (error) {
    const invalid: SandboxResult = {
      exitCode: null,
      signal: exited.signal,
      timedOut,
      protocolError: `invalid sandbox IPC: ${error instanceof Error ? error.message : String(error)}`,
    };
    if (leaseLost) invalid.leaseLost = true;
    return invalid;
  }
  if (timedOut || leaseLost) {
    const tornDown: SandboxResult = { exitCode: null, signal: exited.signal ?? "SIGKILL", timedOut };
    if (leaseLost) tornDown.leaseLost = true;
    return tornDown;
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(responseBytes.toString("utf8"));
  } catch {
    return { exitCode: null, signal: exited.signal, timedOut: false, protocolError: "invalid sandbox IPC: response is not JSON" };
  }
  const parsed = sandboxResponseSchema.safeParse(parsedJson);
  if (!parsed.success || parsed.data.pid !== child.pid) {
    return { exitCode: null, signal: exited.signal, timedOut: false, protocolError: "invalid sandbox IPC: schema or PID mismatch" };
  }
  if (parsed.data.mode === "probe") {
    return {
      probe: {
        pid: parsed.data.pid,
        childMarker: parsed.data.childMarker,
        forbiddenEnvNames: parsed.data.forbiddenEnvNames,
      },
    };
  }
  const expectedProcessExit = parsed.data.result.exitCode ?? 70;
  if (exited.signal !== null || exited.code !== expectedProcessExit) {
    return { exitCode: null, signal: exited.signal, timedOut: false, protocolError: "invalid sandbox IPC: exit mismatch" };
  }
  return { result: parsed.data.result };
}

function sandboxCommand(
  entrypoint: string,
  memoryMb: number,
  requireLimits: boolean,
): { file: string; args: string[] } | { error: string } {
  if (process.platform !== "linux") return { file: process.execPath, args: [entrypoint] };
  const prlimit = "/usr/bin/prlimit";
  if (!existsSync(prlimit)) {
    if (requireLimits) return { error: "sandbox unavailable: /usr/bin/prlimit is required for resource caps" };
    return { file: process.execPath, args: [entrypoint] };
  }
  return {
    file: prlimit,
    args: [
      `--as=${memoryMb * 1024 * 1024}`,
      "--nofile=256:256",
      "--nproc=128:128",
      "--",
      process.execPath,
      entrypoint,
    ],
  };
}

function killProcessTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform === "win32") child.kill("SIGKILL");
    else process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      // The process already exited. The exit event below is the teardown proof.
    }
  }
}

function readBounded(
  stream: NodeJS.ReadableStream,
  limit: number,
  onOverflow: () => void,
): Promise<Buffer> {
  const read = Promise.withResolvers<Buffer>();
  const chunks: Buffer[] = [];
  let size = 0;
  stream.on("data", (chunk: Buffer | string) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > limit) {
      onOverflow();
      read.reject(new Error(`response exceeds ${limit} bytes`));
      return;
    }
    chunks.push(bytes);
  });
  stream.once("end", () => read.resolve(Buffer.concat(chunks)));
  stream.once("error", read.reject);
  return read.promise;
}

/** Dispatches every durable worker kind inside the same real isolation boundary. */
export async function runIsolatedJobBody(
  deps: ExecutorDeps,
  cfg: ExecutorConfig,
  caps: JobResourceCaps,
  job: WorkerJob,
): Promise<SandboxResult> {
  switch (job.kind) {
    case "git":
    case "extension":
      return runJobSandboxBody(deps, cfg, caps, job);
    case "scheduled":
      return runScheduledJobBody(deps, cfg, caps, job);
    case "kb":
    case "ingest_poll": {
      const store = createJobScopedStore(deps.store, jobScopeFromEnvelope(job));
      const audit = createAudit(store);
      try {
        const outcome =
          job.kind === "kb" ? await runKbJob({ ...deps, store }, job) : await runIngestPollJob({ ...deps, store }, job);
        await completeSelf(store, audit, job, outcome);
        return { exitCode: SANDBOX_EXIT_COMPLETED, signal: null, timedOut: false };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await failJobSelf(store, audit, job, message);
        return { exitCode: SANDBOX_EXIT_FAILED, signal: null, timedOut: false };
      }
    }
  }
}

/**
 * One job's isolated run body: the code that runs inside the sandbox (the
 * job Docker container in production, an injected runner in tests). Re-derives the scope
 * from the envelope id (fail closed: the facade permits ONLY this job's
 * rows), claims the work item, runs the item's full delivery lifecycle, and
 * writes ITS OWN terminal lifecycle (completeJob + own outbox row + audit)
 * through the scoped facade. Never touches the claim loop's global sweep;
 * never touches another job's rows.
 */
export async function runJobSandboxBody(
  deps: ExecutorDeps,
  cfg: ExecutorConfig,
  _caps: JobResourceCaps,
  job: WorkerJob,
): Promise<SandboxResult> {
  const scope = jobScopeFromEnvelope(job);
  const store = createJobScopedStore(deps.store, scope);
  const audit = createAudit(store);

  const parsed = workItemJobPayloadSchema.safeParse(job.payload);
  if (!parsed.success) {
    // Malformed envelope → loud crash (parent fails the job).
    throw new Error(`job ${job.id} (${job.kind}) payload must be { workItemId } — failing closed`);
  }
  const workItemId = parsed.data.workItemId;

  try {
    const item = await store.claimWorkItemById(workItemId);
    if (item === null) {
      const current = await store.getWorkItem(workItemId);
      if (current === null) {
        throw new Error(`work item ${workItemId} not found`);
      }
      if (current.state === "done" || current.state === "blocked" || current.state === "aborted") {
        // Already settled elsewhere — the sandbox completes as a no-op and
        // writes its own outbox row so the server sees the settlement.
        await completeSelf(store, audit, job, { state: current.state, result: null });
        return { exitCode: SANDBOX_EXIT_COMPLETED, signal: null, timedOut: false };
      }
      // claimed/working under a live owner (lease-reclaim race): requeue,
      // never double-execute.
      return { exitCode: SANDBOX_EXIT_REQUEUE, signal: null, timedOut: false };
    }

    const settled = await processItem(deps, cfg, item);
    await completeSelf(store, audit, job, {
      state: settled.state,
      result: safeParseJson(settled.result),
    });
    return { exitCode: SANDBOX_EXIT_COMPLETED, signal: null, timedOut: false };
  } catch (err) {
    // Loud self-fail: the sandbox owns its failure — job.failed audit +
    // the item lands blocked (never stuck at working).
    const message = err instanceof Error ? err.message : String(err);
    await failSelf(store, audit, job, workItemId, message);
    return { exitCode: SANDBOX_EXIT_FAILED, signal: null, timedOut: false };
  }
}

/**
 * One scheduled job's isolated run body (issue #272, epic #229 P2): the
 * dispatcher-dispatch leg. Re-derives the scope from the envelope id (fail
 * closed: the facade permits ONLY this job's rows), resolves the named
 * action in the executor's scheduled-action registry (an unknown action
 * fails LOUDLY naming it — never a silent no-op), runs it against the
 * job-scoped store facade with the model-call seam from the job context,
 * and writes ITS OWN terminal lifecycle (completeJob + own outbox row +
 * audit) through the scoped facade. The action's return value rides the
 * completion outbox row + audit as the result. Worker actions never post to
 * Slack — the outbox seam is the post path — and have no policy context.
 */
export async function runScheduledJobBody(
  deps: ExecutorDeps,
  _cfg: ExecutorConfig,
  _caps: JobResourceCaps,
  job: WorkerJob,
): Promise<SandboxResult> {
  const scope = jobScopeFromEnvelope(job);
  const store = createJobScopedStore(deps.store, scope);
  const audit = createAudit(store);

  const parsed = scheduledJobPayloadSchema.safeParse(job.payload);
  if (!parsed.success) {
    // Malformed envelope → loud crash (parent fails the job).
    throw new Error(
      `job ${job.id} (scheduled) payload must be { action, ... } — failing closed: ${parsed.error.message}`,
    );
  }
  const { action: actionName, params } = parsed.data;
  // SAFETY: scheduledJobPayloadSchema types action as an arbitrary string; the
  // registry is keyed by the statically known SchedulerActionName union, so a
  // name outside it misses the map and the unknown-action throw below fails closed.
  const action = deps.scheduledActions?.get(actionName as SchedulerActionName);
  if (!action) {
    throw new Error(`scheduled job ${job.id} failed: unknown action "${actionName}" — no silent no-op`);
  }

  try {
    const result = await action.run(params, {
      store,
      audit,
      memoryProvider: deps.memoryProvider,
      postMessage: () => {
        throw new Error(
          `scheduled action ${actionName} attempted to post to Slack — the worker holds no tokens; the outbox seam is the post path`,
        );
      },
      loadPolicy: async () => {
        throw new Error(`scheduled action ${actionName} has no policy context in the worker`);
      },
      log: (line) => console.log(`[${job.id}] ${line}`),
      now: Date.now,
      consolidationModelCall: deps.consolidationModelCall,
      ...(deps.runMemoryConsolidation !== undefined ? { runMemoryConsolidation: deps.runMemoryConsolidation } : undefined),
    });
    await completeSelf(store, audit, job, { state: "completed", result: result ?? null });
    return { exitCode: SANDBOX_EXIT_COMPLETED, signal: null, timedOut: false };
  } catch (err) {
    // Loud self-fail: the action body owns its failure — job.failed audit,
    // no outbox row (the job bus surfaces the failure).
    const message = err instanceof Error ? err.message : String(err);
    await store.failJob(job.id);
    await audit.appendAudit({
      ts: Date.now(),
      space_id: job.spaceId ?? null,
      actor: "executor",
      event_type: JOB_FAILED_EVENT,
      payload: JSON.stringify({ id: job.id, kind: job.kind, error: message.slice(0, 2000) }),
    });
    console.log(`[${job.id}] scheduled job failed (${actionName}): ${message}`);
    return { exitCode: SANDBOX_EXIT_FAILED, signal: null, timedOut: false };
  }
}

/** The boss-loop supervisor: map a runner result onto the job bus. */
export async function runJobInSandbox(
  deps: ExecutorDeps,
  cfg: ExecutorConfig,
  job: WorkerJob,
  runner: SandboxRunner,
): Promise<JobRunOutcome> {
  const caps = capsFor(job.kind, deps.store);
  const leaseAbort = new AbortController();
  let renewing = false;
  let renewTimer: ReturnType<typeof setInterval> | null = null;
  if (cfg.jobLeaseMs > 0) {
    renewTimer = setInterval(() => {
      if (renewing || leaseAbort.signal.aborted) return;
      renewing = true;
      void deps.store
        .renewJobLease(job.id, Date.now() + cfg.jobLeaseMs)
        .then((renewed) => {
          if (!renewed) leaseAbort.abort("lease_lost");
        })
        .catch(() => leaseAbort.abort("lease_lost"))
        .finally(() => {
          renewing = false;
        });
    }, Math.max(10, Math.floor(cfg.jobLeaseMs / 2)));
  }
  let result: SandboxResult;
  try {
    result = await runner(job, { deps, cfg, caps, signal: leaseAbort.signal });
  } finally {
    if (renewTimer !== null) clearInterval(renewTimer);
  }

  if (result.exitCode === SANDBOX_EXIT_COMPLETED || result.exitCode === SANDBOX_EXIT_FAILED) {
    // The sandbox already wrote the terminal lifecycle (completion or
    // failure). The parent must not write a second outbox row or audit.
    return {
      state: result.exitCode === SANDBOX_EXIT_COMPLETED ? "done" : "blocked",
      result: null,
      selfReported: true,
    };
  }
  if (result.exitCode === SANDBOX_EXIT_REQUEUE) {
    throw new Error(`sandbox requested requeue for ${job.id} (lease-reclaim race)`);
  }
  // Crash: fail loud — job.failed audit + the item never hangs at working.
  await failLoud(deps, job, result);
  return { state: "blocked", result: null, selfReported: true };
}

/**
 * Crash recovery (issue #101): the sandbox died without writing a terminal
 * lifecycle, so the PARENT fails the job loudly and unsticks the work item.
 * A crashed git/extension job is NEVER silently requeued — it surfaces as
 * a failed job + a blocked work item (the #149 landing).
 */
async function failLoud(deps: ExecutorDeps, job: WorkerJob, result: SandboxResult): Promise<void> {
  const reason = result.leaseLost
    ? "sandbox lease lost"
    : result.timedOut
      ? "sandbox timeout"
      : result.protocolError
        ? result.protocolError
        : `sandbox crashed (exit ${result.exitCode ?? "signal"}${result.signal ? ` ${result.signal}` : ""})`;
  await deps.store.failJob(job.id);
  await deps.store.appendAudit({
    space_id: job.spaceId ?? null,
    actor: "executor",
    event_type: JOB_FAILED_EVENT,
    payload: JSON.stringify({ id: job.id, kind: job.kind, error: reason, sandbox_crash: true }),
  });
  console.log(`[${job.id}] ${reason} — job failed loudly, work item unstuck`);

  const parsed = workItemJobPayloadSchema.safeParse(job.payload);
  if (!parsed.success) return; // no work item to unstick
  await unstickWorkItem(deps.store, parsed.data.workItemId, reason);
}

/**
 * Moves the job's work item to blocked so a crash never leaves it stuck at
 * working/claimed. Uses the two-step claimed→working→blocked when the item
 * is still claimed (claimed→blocked is not a legal move) and the direct
 * working→blocked otherwise. Failures here are logged, never thrown — the
 * job already failed and the audit trail is the source of truth.
 */
export async function unstickWorkItem(store: Store, workItemId: string, reason: string): Promise<void> {
  const evidence = `sandbox crash: ${reason}`;
  const current = await store.getWorkItem(workItemId);
  if (current === null) return;
  if (current.state === "blocked" || current.state === "aborted" || current.state === "done") return;
  try {
    if (current.state === "claimed") {
      await store.transitionWorkItem(workItemId, "claimed", "working", { by: "executor" });
    }
    await store.transitionWorkItem(workItemId, "working", "blocked", { evidence, by: "executor" });
  } catch (err) {
    console.log(
      `[${workItemId}] could not unstick work item (${err instanceof Error ? err.message : String(err)}) — job already failed loudly`,
    );
  }
}

/**
 * A store that may expose a job-scoped `postOutboxRow` (the container's RPC
 * store, whose outbox write is routed supervisor-side so no SQL handle is
 * needed in the container). The real / child-process / in-process stores
 * lack it and write through the module {@link postOutboxRow} directly.
 */
export type SandboxStore = Store & { postOutboxRow?(input: OutboxWrite): Promise<void> };

/** Writes one job-completion outbox row, routing through RPC when available. */
async function writeOutboxRow(store: SandboxStore, input: OutboxWrite): Promise<void> {
  if (store.postOutboxRow !== undefined) {
    await store.postOutboxRow(input);
  } else {
    postOutboxRow(store, input);
  }
}

/** The sandbox's own success bookkeeping: completeJob + one outbox row + audit. */
async function completeSelf(
  store: SandboxStore,
  audit: AuditModule,
  job: WorkerJob,
  outcome: { state: string; result: unknown },
): Promise<void> {
  await store.completeJob(job.id);
  await writeOutboxRow(store, {
    id: job.id,
    kind: job.kind,
    payload: { state: outcome.state, result: outcome.result ?? null },
    space: job.spaceId ?? null,
  });
  await audit.appendAudit({
    ts: Date.now(),
    space_id: job.spaceId ?? null,
    actor: "executor",
    event_type: JOB_COMPLETED_EVENT,
    payload: JSON.stringify({ id: job.id, kind: job.kind, state: outcome.state, result: outcome.result ?? null }),
  });
}

/** The sandbox's own failure bookkeeping: failJob + job.failed audit + item blocked. */
async function failSelf(
  store: SandboxStore,
  audit: AuditModule,
  job: WorkerJob,
  workItemId: string,
  message: string,
): Promise<void> {
  await failJobSelf(store, audit, job, message);
  await unstickWorkItem(store, workItemId, message);
}

/** Failure bookkeeping for isolated kinds that do not own a work-item row. */
async function failJobSelf(store: SandboxStore, audit: AuditModule, job: WorkerJob, message: string): Promise<void> {
  await store.failJob(job.id);
  await audit.appendAudit({
    ts: Date.now(),
    space_id: job.spaceId ?? null,
    actor: "executor",
    event_type: JOB_FAILED_EVENT,
    payload: JSON.stringify({ id: job.id, kind: job.kind, error: message.slice(0, 2000) }),
  });
  console.log(`[${job.id}] sandbox failed the job (${job.kind}): ${message}`);
}

/** One decoded JSON document — the domain of a work item's stored result column. */
type JsonDocument = string | number | boolean | null | JsonDocument[] | { [key: string]: JsonDocument };

/** Parses a work item's result JSON column; null when absent or corrupt. */
function safeParseJson(text: string | null): JsonDocument {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
