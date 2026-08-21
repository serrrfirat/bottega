import { z } from "zod";
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

export const sandboxExecuteRequestSchema = z
  .object({
    version: z.literal(SANDBOX_PROTOCOL_VERSION),
    mode: z.literal("execute"),
    dbPath: z.string().min(1).max(4_096),
    job: workerJobSchema,
    config: sandboxConfigSchema,
    caps: capsSchema,
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
