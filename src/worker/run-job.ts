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
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname, isAbsolute } from "node:path";
import {
  type ExecutorConfig,
  type ExecutorDeps,
  type JobRunOutcome,
  type SandboxResult,
  type SandboxRunner,
  SANDBOX_EXIT_COMPLETED,
  SANDBOX_EXIT_FAILED,
  SANDBOX_EXIT_REQUEUE,
  unstickWorkItem,
} from "./job-bodies";
import type { Store } from "../store/db";
import type { OrgSettings } from "../store/org-settings";
import type { ExtensionTool } from "../extensions/manifest";
import type { PolicyConfig } from "../policy/config";
import type { ResolvedMemoryProvider } from "../server/memory-provider";
import { JOB_FAILED_EVENT } from "../store/audit-events";
import { ingestPollJobPayloadSchema, workItemJobPayloadSchema, type WorkerJob } from "./envelope";
import { jobScopeFromEnvelope } from "./scoped-store";
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

/** Resolves the per-kind caps with the org settings `caps` overrides. */
export function capsFor(kind: WorkerJob["kind"], store: Store): JobResourceCaps {
  return resolveKindCaps(kind, store.getOrgSettings()?.caps ?? null);
}

/**
 * Parses a scheduled job's envelope payload (shared by the executor's
 * {@link runJob} supervisor path and the sandbox's {@link runScheduledJobBody}
 * body), failing closed on a malformed envelope so a bad scheduled job is
 * ALWAYS a loud crash (the parent fails the job), never a silent no-op.
 */

/**
 * The per-run sandbox probe contract (issue #101): what a boot-time probe of
 * a runner reports back. Shared by the Docker lane (production) and the
 * child-process test fabric (run-job-test-fabric.ts).
 */
export interface SandboxProbe {
  pid: number;
  childMarker: "1";
  forbiddenEnvNames: string[];
}

export const SAFE_CHILD_ENV_NAMES = [
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
  "BOTTEGA_PROXY_CONFIG_PATH",
  "BOTTEGA_PROXY_SECRETS_DIR",
] as const;

/**
 * Credential/provider secrets that must NEVER cross into a sandbox child,
 * regardless of how the child environment is assembled. This is the single
 * source of truth shared with the checked-in child's FAIL-CLOSED self-report
 * ({@link forbiddenEnvironment} in run-job-child.ts): the parent strips them
 * defensively from the constructed env, and the child independently verifies
 * none are present. Because the env is built only from {@link SAFE_CHILD_ENV_NAMES}
 * plus job-scoped credential *file* handles, none of these can enter through
 * normal construction — the strip is defense-in-depth against a merged
 * environment or a future allowlist drift.
 */
export const FORBIDDEN_CHILD_ENV_NAMES = [
  "BOTTEGA_API_TOKEN",
  "SLACK_APP_TOKEN",
  "SLACK_BOT_TOKEN",
  "GITHUB_WEBHOOK_SECRET",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "AWS_SECRET_ACCESS_KEY",
  "NEAR_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENCODE_API_KEY",
  "OMP_AUTH_BROKER_TOKEN",
] as const;

/** Mutates the given child env object, dropping any forbidden credential name. */
export function sanitizeSandboxEnv(env: Record<string, string>): void {
  for (const name of FORBIDDEN_CHILD_ENV_NAMES) delete env[name];
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
// read-only (the only writable scratch is a bounded /tmp tmpfs with
// nosuid,nodev,noexec); all capabilities are dropped, no-new-privileges and
// an init reaper are set, and memory/PID/CPU/file-descriptor caps are
// bounded. On its own internal-only network the container CANNOT route out
// directly — DNS resolves through iron-proxy and HTTP(S) egress traverses
// the proxy's allowlist, so the proxy is the only external seam. Resource
// caps and full-container teardown are mandatory.
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
  /** Docker network the job container joins (the internal-only `sandbox` network in compose). "none" for hermetic. */
  network?: string;
  /** DNS server(s) for the container (iron-proxy sandbox IP — default-deny sinkhole). */
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
  /**
   * The supervisor's REGISTERED extension manifest/provider ids (issue
   * #101): the only providers any job container may enumerate credentials
   * for. Derived from the immutable runtime extension registry that built
   * the job's toolset; absent → an empty set, so listExtensionCredentials
   * is denied outright (fail closed).
   */
  extensionProviderIds?: Iterable<string>;
  /** Supervisor-resolved tool metadata; credentials never cross this boundary. */
  extensionSurfaces?: ReadonlyMap<string, readonly ExtensionTool[]>;
  /** Supervisor-resolved org policy floor, applied before space overlays. */
  orgPolicy?: PolicyConfig;
  /** Sanitized supervisor reauthorization guidance; contains no credentials. */
  extensionReauthDirective?: string;
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
      // Node never emits `exit` for a failed spawn (ENOENT — e.g. the
      // supervisor itself running inside a bare container without the
      // docker CLI), so the exit promise MUST also settle on the error
      // event or launchDockerContainer hangs forever (#344 CI: the
      // executor boot probe stalled before its own PAT fail-closed guard).
      const { promise: processError, resolve: settleExit } =
        Promise.withResolvers<{ code: null; signal: null }>();
      child.once("error", (error: Error) => {
        spawnError = error;
        settleExit({ code: null, signal: null });
      });
      // A missing docker binary or unreachable socket must fail closed (never
      // hang on a dead stdout). Surface the spawn error on stdout so the
      // bounded read rejects and the exit promise settles fast.
      void processError.then(() => {
        if (child.stdout) child.stdout.destroy(spawnError ?? undefined);
        if (child.stderr) child.stderr.destroy();
      });
      // SAFETY: stdio is configured as ["pipe", "pipe", "pipe"], so child.stdin/stdout/stderr
      // are non-null streams; node's types leave them nullable only because the stdio option is dynamic.
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
  volumeWorkspacesRoot?: string;
  volumeStateRoot?: string;
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
    volumeWorkspacesRoot: options.volumeWorkspacesRoot,
    volumeStateRoot: options.volumeStateRoot,
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
      orgPolicy: options.orgPolicy ?? undefined,
      extensionReauthDirective: options.extensionReauthDirective,
      extensionSurfaces:
        options.extensionSurfaces === undefined
          ? undefined
          : Object.fromEntries([...options.extensionSurfaces].map(([id, tools]) => [id, [...tools]])),
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
      extensionProviderIds: options.extensionProviderIds,
      orgPolicy: options.orgPolicy,
      extensionReauthDirective: options.extensionReauthDirective,
      extensionSurfaces: request.extensionSurfaces,
      image,
      network,
      dns: options.dns,
      proxyUrl: options.proxyUrl,
      caCertHostPath: options.caCertHostPath,
      askpassScript: options.askpassScript ?? ctx.cfg.askpassScript,
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
  hostStore?: Store;
  memoryProvider?: ResolvedMemoryProvider;
  extensionProviderIds?: Iterable<string>;
  orgPolicy?: PolicyConfig;
  extensionReauthDirective?: string;
  extensionSurfaces?: Record<string, readonly ExtensionTool[]>;
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
  // EVERY per-job staging dir created here is removed in the finally below —
  // including when subpath validation (relativeSubpath), the docker launch,
  // or any later step throws — so a pre-launch failure can never leak a
  // prepared credential/workspace/transcript/RPC dir.
  const prep = request.mode === "execute" ? prepareJobMounts(opts) : null;
  let rpcServer: JobStoreRpcServer | null = null;
  try {
    let rpcDirHost = "";
    if (prep !== null) {
      rpcDirHost = prep.rpcDirHost;
      if (opts.hostStore !== undefined && opts.job !== undefined) {
        rpcServer = JobStoreRpcServer.create(opts.hostStore, opts.job, rpcDirHost, {
          memoryProvider: opts.memoryProvider,
          extensionProviderIds: opts.extensionProviderIds,
        });
        try {
          await rpcServer.listen();
        } catch (error) {
          return { kind: "error", protocolError: `sandbox unavailable: store RPC socket bind failed: ${error instanceof Error ? error.message : String(error)}` };
        }
      }
    }
    let proc: DockerProcess;
    try {
      const args = dockerRunArgs(request, opts, rpcDirHost);
      try {
        proc = docker.launch(args);
      } catch (error) {
        return { kind: "error", protocolError: `sandbox unavailable: docker launch failed: ${error instanceof Error ? error.message : String(error)}` };
      }
    } catch (error) {
      // Subpath/config validation (relativeSubpath) threw before docker was
      // reached. The finally below still removes every staged per-job dir —
      // this is the fail-closed, no-leak path (issue #101).
      return { kind: "error", protocolError: `sandbox unavailable: mount/request validation failed: ${error instanceof Error ? error.message : String(error)}` };
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

    // A late lease-loss abort that lands AFTER the container already exited
    // cleanly must not discard the terminal IPC reply: the supervisor's
    // renew tick fires every half-lease and sees `status != 'running'` the
    // moment the child has self-completed the job, so the exact success path
    // would be torn down as lease_lost on fast hosts (#344 CI). For a clean
    // exit the PID-checked response below is authoritative — the job bus
    // transitions stay serialized by the store's status-guarded writes. A
    // genuine mid-flight loss still kills the container (signal exit),
    // keeps `exitedCleanly` false, and returns the torn-down result here.
    const exitedCleanly = exited.signal === null && exited.code !== null;
    if (timedOut || (leaseLost && !exitedCleanly)) {
      const tornDown: SandboxResult = { exitCode: null, signal: exited.signal ?? "SIGKILL", timedOut };
      if (leaseLost) tornDown.leaseLost = true;
      return { kind: "result", result: tornDown };
    }
    // A failed `docker` spawn (no CLI / no socket — e.g. the supervisor
    // running inside a bare container) settles exit as {code:null,
    // signal:null} WITHOUT any stdout bytes: a destroyed never-started pipe
    // never emits `end`, so awaiting boundedResponse here would hang
    // forever (#344 CI: the executor boot probe stalled before its own PAT
    // fail-closed guard). The null/null sentinel with zero output is the
    // spawn-failure signature — fail closed loudly instead.
    if (exited.code === null && exited.signal === null && !timedOut && !leaseLost) {
      return { kind: "error", protocolError: "sandbox unavailable: the docker CLI could not be spawned (missing binary or socket)" };
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
  } finally {
    // Guaranteed per-job teardown on EVERY path — including a throw from
    // subpath validation (relativeSubpath), docker launch, the container
    // run, or IPC parsing. The staged credential/workspace/transcript/RPC
    // dirs are removed and the job-scoped RPC host is closed, so a
    // pre-launch failure can never leak prepared credential dirs (#101).
    rpcServer?.close();
    cleanupJobMounts(prep);
  }
}

/**
 * Environment handed to a Docker-lane job container: the child + Docker lane
 * markers, the kind-scoped credential file handles, the egress proxy/CA
 * vars, the mounted store RPC socket path, and the allowlisted host
 * passthrough names. Built only from the allowlist plus job-scoped
 * credential *file* handles — never from the coordinator's process.env.
 */
type DockerChildEnv = {
  BOTTEGA_SANDBOX_CHILD: string;
  BOTTEGA_SANDBOX_DOCKER: string;
  HTTP_PROXY?: string;
  HTTPS_PROXY?: string;
  NO_PROXY?: string;
  NODE_EXTRA_CA_CERTS?: string;
  BOTTEGA_SANDBOX_RPC_SOCKET?: string;
  EXECUTOR_GIT_TOKEN_FILE?: string;
  OMP_AUTH_BROKER_TOKEN_FILE?: string;
} & Partial<{ [K in (typeof SAFE_CHILD_ENV_NAMES)[number]]: string }>;

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
    "--cpus",
    "1",
    "--ulimit",
    "nofile=1024",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges:true",
    "--read-only",
    "--init",
    "--network",
    opts.network,
    // Bounded writable /tmp: the only writable scratch outside the exact
    // per-job mounts. noexec+nosuid+nodev keep it from becoming a
    // privilege-escalation or execution surface; the size cap bounds disk use.
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,noexec,size=64m",
    // The SDK writes its per-job agent config/cache during boot. Keep that
    // state ephemeral and bounded while leaving the image root immutable.
    "--tmpfs",
    "/app/data/omp-agent:rw,nosuid,nodev,noexec,size=16m",
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
  const env: DockerChildEnv = { BOTTEGA_SANDBOX_CHILD: "1", BOTTEGA_SANDBOX_DOCKER: "1" };
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
    // The store RPC socket file is mounted inside the container at
    // /rpc/store.sock. The child's executeViaRpc requires this exact path; it
    // is supervisor-generated (never a host passthrough) and immutable per
    // container so the child cannot be steered to an attacker-chosen socket.
    env.BOTTEGA_SANDBOX_RPC_SOCKET = join(CONTAINER_RPC_DIR, "store.sock");
    const needsGitToken = jobNeedsGitToken(request.job);
    if (opts.gitTokenFile !== undefined && opts.gitTokenFile !== "" && needsGitToken) {
      env.EXECUTOR_GIT_TOKEN_FILE = CONTAINER_GIT_TOKEN_FILE;
    }
    if (request.job.kind === "extension" && opts.brokerTokenFile !== undefined && opts.brokerTokenFile !== "") {
      env.OMP_AUTH_BROKER_TOKEN_FILE = CONTAINER_BROKER_TOKEN_FILE;
    }
  }

  // Defense-in-depth: every var is emitted as an explicit `--env NAME=VALUE`
  // flag (never `--env-file` or an inherited image env), but strip forbidden
  // credential names anyway so the container can never receive a secret that
  // slipped into the allowlist or a merged environment.
  sanitizeSandboxEnv(env);
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
  // Volume-mode subpath root for the state axis (validated present in volume
  // mode by stateTranscriptHost). The transcript/credential/RPC subpaths are
  // all under this root in the supervisor's host view.
  const stateHost = volumeMode ? stateVolumeRoot(opts) : "";

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
    const transcriptHost = join(stateTranscriptHost(opts), itemId);
    if (volumeMode) {
      const sub = relativeSubpath(stateHost, transcriptHost);
      args.push("--mount", `type=volume,src=${opts.volume},dst=${join(CONTAINER_TRANSCRIPTS_ROOT, itemId)},volume-subpath=${sub}`);
    } else {
      args.push("-v", `${transcriptHost}:${join(CONTAINER_TRANSCRIPTS_ROOT, itemId)}:rw`);
    }
  }
  // Per-job RPC socket dir (execute lane only).
  if (request.mode === "execute" && rpcDirHost !== "") {
    if (volumeMode) {
      const sub = relativeSubpath(stateHost, rpcDirHost);
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
        args.push("--mount", `type=volume,src=${opts.volume},dst=${CONTAINER_GIT_SECRETS_DIR},volume-subpath=${relativeSubpath(stateHost, gitCredDirHost(opts, request.job.id))}`);
      } else {
        args.push("-v", `${opts.gitTokenFile}:${CONTAINER_GIT_TOKEN_FILE}:ro`);
        if (opts.askpassScript !== undefined && opts.askpassScript !== "") {
          args.push("-v", `${opts.askpassScript}:${CONTAINER_ASKPASS_SCRIPT}:ro`);
        }
      }
    }
    if (request.job.kind === "extension" && opts.brokerTokenFile !== undefined && opts.brokerTokenFile !== "") {
      if (volumeMode) {
        args.push("--mount", `type=volume,src=${opts.volume},dst=${CONTAINER_BROKER_DIR},volume-subpath=${relativeSubpath(stateHost, extensionCredDirHost(opts, request.job.id))}`);
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

/**
 * The supervisor-visible host transcript dir. In volume mode a RELATIVE
 * transcriptDir (the executor default `data/transcripts`, which from the
 * compose WORKDIR `/app` resolves inside the `/app/data` volume mount) is
 * resolved against the state volume root so the host-visible path becomes
 * `/app/data/transcripts` — compatible with `volumeStateRoot=/app/data` and
 * the `relativeSubpath` validation that prefixes the transcript <itemId>
 * subpath with it. In bind mode the host transcript dir is the configured
 * host path, unchanged.
 */
function stateTranscriptHost(opts: DockerLaunchOptions): string {
  if (opts.volume === undefined || opts.volume === "") return opts.transcriptDir;
  const root = opts.volumeStateRoot;
  if (root === undefined || root === "") {
    throw new Error("sandbox volume mode requires a state volume root (volumeStateRoot)");
  }
  return isAbsolute(opts.transcriptDir) ? opts.transcriptDir : join(root, opts.transcriptDir);
}

/** The host-space sandbox staging root under the shared volume (via the state axis). */
function sandboxStagingRoot(opts: DockerLaunchOptions): string {
  return join(dirname(stateTranscriptHost(opts)), ".omp", "sandbox");
}

/**
 * The volume-mode host root for the state axis (transcripts/credentials/RPC):
 * validated present when volume mode is on. Every state-axis subpath mount is
 * computed relative to this root.
 */
function stateVolumeRoot(opts: DockerLaunchOptions): string {
  if (opts.volume === undefined || opts.volume === "") {
    throw new Error("stateVolumeRoot requires volume mode");
  }
  const root = opts.volumeStateRoot;
  if (root === undefined || root === "") {
    throw new Error("sandbox volume mode requires a state volume root (volumeStateRoot)");
  }
  return root;
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
    const transcriptHost = join(stateTranscriptHost(opts), itemId);
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

/**
 * Reads exactly one bounded byte document off a stream, rejecting with
 * {@link onOverflow} when the document exceeds `limit` bytes. Shared by the
 * Docker lane (production stdout) and the child-process test fabric
 * (run-job-test-fabric.ts fd 3).
 */
export function readBounded(
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


// Re-export the sandbox contract + isolated bodies from the leaf for external
// consumers (run-job-child.ts, run-job-test-fabric.ts, and the worker test
// suites) that import them from this module — the dependency stays one-way
// (job-bodies <- run-job) but the public surface is unchanged.
export {
  type SandboxResult,
  type SandboxRunner,
  type SandboxRunnerContext,
  type SandboxStore,
  SANDBOX_EXIT_COMPLETED,
  SANDBOX_EXIT_FAILED,
  SANDBOX_EXIT_REQUEUE,
  runIsolatedJobBody,
  runJobSandboxBody,
  runScheduledJobBody,
  unstickWorkItem,
} from "./job-bodies";
