import { readFileSync, readSync, statSync, writeSync } from "node:fs";
import { bootExecutorRuntime, createDefaultConsolidationModelCall, type ExecutorBoot, type ExecutorDeps } from "../executor";
import type { AgentDriver } from "../server/drivers/agent-driver";
import { buildRegistry } from "../scheduler/actions";
import { memoryConsolidationAction } from "../scheduler/memory-consolidation";
import { createJobScopedStore, jobScopeFromEnvelope } from "./scoped-store";
import type { Store } from "../store/db";
import { runIsolatedJobBody, FORBIDDEN_CHILD_ENV_NAMES, type SandboxResult, type SandboxStore } from "./run-job";
import { connectStoreRpc } from "./store-rpc";
import {
  MAX_SANDBOX_REQUEST_BYTES,
  SANDBOX_PROTOCOL_VERSION,
  orgSettingsWireSchema,
  sandboxRequestSchema,
  sandboxResponseSchema,
  type SandboxRequest,
  type SandboxResponse,
} from "./sandbox-protocol";

function readRequest(): SandboxRequest {
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const chunk = Buffer.allocUnsafe(Math.min(8 * 1024, MAX_SANDBOX_REQUEST_BYTES + 1 - total));
    const read = readSync(0, chunk, 0, chunk.length, null);
    if (read === 0) break;
    total += read;
    if (total > MAX_SANDBOX_REQUEST_BYTES) throw new Error("sandbox request exceeds IPC limit");
    chunks.push(chunk.subarray(0, read));
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("sandbox request is not JSON");
  }
  const parsed = sandboxRequestSchema.safeParse(value);
  if (!parsed.success) throw new Error(`sandbox request schema rejected: ${parsed.error.message}`);
  return parsed.data;
}

function forbiddenEnvironment(): string[] {
  return FORBIDDEN_CHILD_ENV_NAMES.filter((name) => process.env[name] !== undefined);
}

/**
 * The Docker lane has no extra file descriptor like the child lane's fd 3:
 * the container's stdout is the single bounded protocol channel and every
 * job log is redirected to stderr, so stdout carries ONLY the response JSON.
 * The child lane (tests/protocol mechanics) keeps fd 3 for the response.
 */
const DOCKER_LANE = process.env.BOTTEGA_SANDBOX_DOCKER === "1";

function sendResponse(response: SandboxResponse): void {
  const parsed = sandboxResponseSchema.parse(response);
  const payload = JSON.stringify(parsed);
  if (DOCKER_LANE) {
    // Reserved channel: stdout must stay a single bounded JSON document.
    process.stdout.write(payload + "\n");
    return;
  }
  writeSync(3, payload);
}

async function execute(request: Extract<SandboxRequest, { mode: "execute" }>): Promise<SandboxResult> {
  const forbidden = forbiddenEnvironment();
  if (forbidden.length > 0) {
    throw new Error(`sandbox received forbidden credential environment: ${forbidden.join(", ")}`);
  }
  if (DOCKER_LANE) {
    return await executeViaRpc(request);
  }
  if (request.job.kind === "extension") {
    const tokenFile = process.env.OMP_AUTH_BROKER_TOKEN_FILE;
    if (tokenFile === undefined || tokenFile === "") {
      throw new Error("extension sandbox requires the mounted auth-broker token file");
    }
    const stat = statSync(tokenFile);
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600) {
      throw new Error("extension sandbox auth-broker token mount must be a mode-0600 file");
    }
    const token = readFileSync(tokenFile, "utf8").trim();
    if (token === "") throw new Error("extension sandbox auth-broker token mount is empty");
    process.env.OMP_AUTH_BROKER_TOKEN = token;
    delete process.env.OMP_AUTH_BROKER_TOKEN_FILE;
  }
  const boot = await bootExecutorRuntime({
    dbPath: request.dbPath,
    skipBootSecretEnvNames: FORBIDDEN_CHILD_ENV_NAMES,
    skipBootSecretSeed: true,
    skipProxyCredentialSync: true,
  });
  const baseStore = boot.runtime.store;
  const store = createJobScopedStore(baseStore, jobScopeFromEnvelope(request.job));
  let driver: AgentDriver | Promise<AgentDriver> | undefined;
  const consolidationModelCall = createDefaultConsolidationModelCall(boot.getDriver());
  const deps: ExecutorDeps = {
    store,
    dbPath: request.dbPath,
    memoryProvider: boot.runtime.memoryProvider,
    get driver(): AgentDriver | Promise<AgentDriver> {
      return (driver ??= boot.getDriver());
    },
    getExtensionWorkerToolset: boot.getExtensionWorkerToolset,
    orgConfigDir: process.env.BOTTEGA_CONFIG_DIR ?? "config",
    transcriptDir: request.config.transcriptDir,
    scheduledActions: buildRegistry([memoryConsolidationAction()]),
    consolidationModelCall,
  };
  try {
    return await runIsolatedJobBody(deps, request.config, request.caps, request.job);
  } finally {
    baseStore.close();
  }
}

/**
 * The Docker lane boots the job-scoped runtime over the mounted store RPC
 * socket (no bottega.db bytes reach the container) and runs the same
 * isolated job body. The scoped store + memory cross the bounded socket; the
 * supervisor enforces the job-scope allowlist and denies global/unknown ops.
 */
async function executeViaRpc(request: Extract<SandboxRequest, { mode: "execute" }>): Promise<SandboxResult> {
  const socketPath = process.env.BOTTEGA_SANDBOX_RPC_SOCKET;
  if (socketPath === undefined || socketPath === "") {
    throw new Error("Docker lane sandbox requires the mounted store RPC socket (BOTTEGA_SANDBOX_RPC_SOCKET)");
  }
  const rpc = connectStoreRpc(socketPath);
  // SAFETY: rpc.store is the explicit allowlisted store facade (issue #101);
  // the job runtime only invokes the facade's allowlisted methods, and any
  // non-allowlisted access fails closed at the socket. Widening the narrow
  // facade to the full Store/SandboxStore boundary types needs an unknown
  // intermediate because TypeScript sees no direct overlap between the facade
  // and the full Store interface (the facade deliberately omits most members).
  const bootStore: unknown = rpc.store;
  let boot: ExecutorBoot;
  try {
    await rpc.ready();
    const relayedOrgSettings = orgSettingsWireSchema.safeParse(request.orgSettings);
    boot = await bootExecutorRuntime({
      // SAFETY: bootStore is the explicit allowlisted RPC store facade,
      // widened to the full Store at the boot boundary; the runtime only
      // invokes facade methods, and non-allowlisted access fails closed at
      // the socket (issue #101).
      store: bootStore as Store,
      memoryProvider: rpc.memoryProvider,
      orgSettings: relayedOrgSettings.success ? relayedOrgSettings.data : undefined,
      skipRuntimeRegistryMerge: true,
      skipBootSecretEnvNames: FORBIDDEN_CHILD_ENV_NAMES,
      skipBootSecretSeed: true,
      skipProxyCredentialSync: true,
    });
    let driver: AgentDriver | Promise<AgentDriver> | undefined;
    const consolidationModelCall = createDefaultConsolidationModelCall(boot.getDriver());
    // The scheduled consolidation DB leg is routed supervisor-side; the LLM
    // leg comes back into the worker over the RPC socket (issue #272).
    rpc.setConsolidationModelCall(consolidationModelCall);
    // SAFETY: bootStore is the explicit allowlisted RPC store facade, widened
    // to SandboxStore at the session boundary; the job body / scoped-store
    // layers only invoke facade methods, and any non-allowlisted access fails
    // closed at the socket.
    const deps: ExecutorDeps = {
      // The RPC facade exposes only the job-relevant Store subset + the
      // supervisor-routed postOutboxRow; typed up to the full SandboxStore at
      // the session boundary (the job body / scoped-store layers never invoke
      // non-allowlisted methods — those fail closed at the socket).
      store: bootStore as SandboxStore,
      memoryProvider: rpc.memoryProvider,
      get driver(): AgentDriver | Promise<AgentDriver> {
        return (driver ??= boot.getDriver());
      },
      getExtensionWorkerToolset: boot.getExtensionWorkerToolset,
      orgConfigDir: process.env.BOTTEGA_CONFIG_DIR ?? "config",
      transcriptDir: request.config.transcriptDir,
      scheduledActions: buildRegistry([memoryConsolidationAction()]),
      consolidationModelCall,
      runMemoryConsolidation: () => rpc.maintainMemory(),
    };
    return await runIsolatedJobBody(deps, request.config, request.caps, request.job);
  } finally {
    rpc.close();
  }
}

async function main(): Promise<void> {
  process.env.BOTTEGA_SANDBOX_CHILD = "1";
  if (DOCKER_LANE) {
    // stdout is the reserved bounded protocol channel; every job log goes to
    // stderr so it can never corrupt or exceed the single result document.
    // Redirect every stdout-writing console method (not just log).
    console.log = (...args: unknown[]) => console.error(...args);
    console.info = (...args: unknown[]) => console.error(...args);
    console.debug = (...args: unknown[]) => console.error(...args);
    console.dir = (...args: unknown[]) => console.error(...args);
    console.trace = (...args: unknown[]) => console.error(...args);
  }
  const request = readRequest();
  if (request.mode === "probe") {
    sendResponse({
      version: SANDBOX_PROTOCOL_VERSION,
      mode: "probe",
      pid: process.pid,
      childMarker: "1",
      forbiddenEnvNames: forbiddenEnvironment(),
    });
    return;
  }
  let result: SandboxResult;
  try {
    result = await execute(request);
  } catch (error) {
    console.error(`sandbox child failed before lifecycle completion: ${error instanceof Error ? error.message : String(error)}`);
    result = { exitCode: null, signal: null, timedOut: false };
  }
  sendResponse({ version: SANDBOX_PROTOCOL_VERSION, mode: "execute", pid: process.pid, result });
  if (result.exitCode !== 0) process.exitCode = result.exitCode ?? 70;
}

await main();
