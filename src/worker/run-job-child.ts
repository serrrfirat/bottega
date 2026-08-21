import { readFileSync, readSync, statSync, writeSync } from "node:fs";
import { bootExecutorRuntime, createDefaultConsolidationModelCall, type ExecutorDeps } from "../executor";
import type { AgentDriver } from "../server/drivers/agent-driver";
import { buildRegistry } from "../scheduler/actions";
import { memoryConsolidationAction } from "../scheduler/memory-consolidation";
import { createJobScopedStore, jobScopeFromEnvelope } from "./scoped-store";
import { runIsolatedJobBody, type SandboxResult } from "./run-job";
import {
  MAX_SANDBOX_REQUEST_BYTES,
  SANDBOX_PROTOCOL_VERSION,
  sandboxRequestSchema,
  type SandboxRequest,
} from "./sandbox-protocol";

const FORBIDDEN_ENV_NAMES = [
  "SLACK_APP_TOKEN",
  "SLACK_BOT_TOKEN",
  "GITHUB_WEBHOOK_SECRET",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "AWS_SECRET_ACCESS_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "OMP_AUTH_BROKER_TOKEN",
] as const;

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
  return FORBIDDEN_ENV_NAMES.filter((name) => process.env[name] !== undefined);
}

function sendResponse(response: unknown): void {
  writeSync(3, JSON.stringify(response));
}

async function execute(request: Extract<SandboxRequest, { mode: "execute" }>): Promise<SandboxResult> {
  const forbidden = forbiddenEnvironment();
  if (forbidden.length > 0) {
    throw new Error(`sandbox received forbidden credential environment: ${forbidden.join(", ")}`);
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
    skipBootSecretEnvNames: FORBIDDEN_ENV_NAMES,
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

async function main(): Promise<void> {
  process.env.BOTTEGA_SANDBOX_CHILD = "1";
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
