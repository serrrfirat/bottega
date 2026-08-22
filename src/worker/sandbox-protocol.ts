import { z } from "zod";
import type { OrgSettings } from "../store/org-settings";
import { WORKER_JOB_KINDS, WORKER_JOB_STATUSES } from "./envelope";

export const SANDBOX_PROTOCOL_VERSION = 1 as const;
export const MAX_SANDBOX_REQUEST_BYTES = 64 * 1024;
export const MAX_SANDBOX_RESPONSE_BYTES = 16 * 1024;

const workerJobSchema = z
  .object({
    id: z.string().min(1).max(256),
    kind: z.enum(WORKER_JOB_KINDS),
    payload: z.unknown(),
    spaceId: z.string().min(1).max(512).optional(),
    attempts: z.number().int().nonnegative(),
    leaseUntil: z.number().finite().nullable().optional(),
    status: z.enum(WORKER_JOB_STATUSES),
  })
  .strict();

export const sandboxConfigSchema = z
  .object({
    repoAllowlist: z.array(z.string().min(1).max(512)).max(1_000),
    gitBaseUrl: z.string().url().max(4_096),
    apiBaseUrl: z.string().url().max(4_096),
    workspacesDir: z.string().min(1).max(4_096),
    transcriptDir: z.string().min(1).max(4_096),
    tokenFile: z.string().min(1).max(4_096),
    askpassScript: z.string().min(1).max(4_096),
    jobLeaseMs: z.number().int().positive(),
    maxJobAttempts: z.number().int().positive(),
    jobBackoffMs: z.number().int().nonnegative(),
    jobBackoffMaxMs: z.number().int().nonnegative(),
    jobUnclaimedTtlMs: z.number().int().positive(),
    jobSweepIntervalMs: z.number().int().positive(),
  })
  .strict();

const capsSchema = z
  .object({
    timeoutMs: z.number().int().positive().max(24 * 60 * 60_000),
    memoryMb: z.number().int().min(32).max(32 * 1024),
  })
  .strict();

// Validates the supervisor-relayed org-settings blob's settings-read markers
// (ok/errors/warnings) and carries the blob onward as the OrgSettings the
// supervisor produced (parseOrgSettingsJson already validated the full blob);
// a malformed/absent relay fails closed — the boot falls back to no settings.
// The passthrough object carries the relayed blob verbatim (unknown keys
// preserved so a settings knob is never silently dropped).
const orgSettingsMarkersSchema = z
  .object({
    ok: z.boolean(),
    errors: z.array(z.string()),
    warnings: z.array(z.string()).optional(),
  })
  .passthrough();
// SAFETY: the supervisor's validated org-settings blob is relayed into the
// job request; this boundary re-checks only its settings-read markers and
// carries the validated object onward as OrgSettings (issue #101).
const orgSettingsWireSchemaImpl = orgSettingsMarkersSchema as z.ZodType<OrgSettings>;
export const orgSettingsWireSchema = orgSettingsWireSchemaImpl;

export const sandboxExecuteRequestSchema = z
  .object({
    version: z.literal(SANDBOX_PROTOCOL_VERSION),
    mode: z.literal("execute"),
    // The child-process (test-fabric) lane opens the one allowlisted store
    // file at `dbPath`. The PRODUCTION Docker lane OMITS it entirely: the job
    // container never holds/opens a SQLite file and reaches the store only
    // over the mounted RPC socket, so the request carries no dbPath and the
    // job env/args never reveal one.
    dbPath: z.string().min(1).max(4_096).optional(),
    job: workerJobSchema,
    config: sandboxConfigSchema,
    caps: capsSchema,
    // The supervisor's parsed org settings blob (JSON-safe), injected so the
    // child's shared composition chain (loadOrgPolicy, secret resolver, agent
    // dir pin) never needs a synchronous store read over the async RPC socket.
    // Present in the Docker lane (and any lane that boots over RPC).
    orgSettings: z.unknown().optional(),
  })
  .strict();

export const sandboxProbeRequestSchema = z
  .object({
    version: z.literal(SANDBOX_PROTOCOL_VERSION),
    mode: z.literal("probe"),
  })
  .strict();

export const sandboxRequestSchema = z.discriminatedUnion("mode", [sandboxExecuteRequestSchema, sandboxProbeRequestSchema]);
export type SandboxRequest = z.infer<typeof sandboxRequestSchema>;

const sandboxResultSchema = z
  .object({
    exitCode: z.number().int().nullable(),
    signal: z.string().max(64).nullable(),
    timedOut: z.boolean(),
  })
  .strict();

export const sandboxResponseSchema = z.discriminatedUnion("mode", [
  z
    .object({
      version: z.literal(SANDBOX_PROTOCOL_VERSION),
      mode: z.literal("execute"),
      pid: z.number().int().positive(),
      result: sandboxResultSchema,
    })
    .strict(),
  z
    .object({
      version: z.literal(SANDBOX_PROTOCOL_VERSION),
      mode: z.literal("probe"),
      pid: z.number().int().positive(),
      childMarker: z.literal("1"),
      forbiddenEnvNames: z.array(z.string().min(1).max(256)).max(128),
    })
    .strict(),
]);
export type SandboxResponse = z.infer<typeof sandboxResponseSchema>;
