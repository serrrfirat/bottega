/**
 * Per-kind per-job resource caps (issue #101, epic #229 P1). The sandbox
 * supervisor needs a hard timeout and a memory ceiling for every job kind;
 * the numbers below are the DOCUMENTED worker defaults and are never
 * hardcoded at the call site — use {@link resolveKindCaps} everywhere. An
 * org may override them via the `caps:` section of config/org.yml, and the
 * org-settings parser validates shape + fails the section closed on any
 * unknown kind/key (see src/store/org-settings.ts).
 */
export interface JobCapKnob {
  /** Hard wall-clock deadline for one job run, in minutes. */
  timeoutMinutes: number;
  /** Memory ceiling for one job run, in MiB. */
  memoryMb: number;
}

/** Raw org override shape — only the kinds an org may tune. */
export type OrgCapKind = "git" | "extension" | "kb" | "ingest_poll";

export type OrgJobCaps = Partial<Record<OrgCapKind, Partial<JobCapKnob>>>;

/** Fully-resolved caps for a job kind after applying org overrides. */
export type JobResourceCaps = {
  timeoutMs: number;
  memoryMb: number;
};

/** Documented worker defaults per kind (see module doc). */
const DEFAULT_CAPS: Record<OrgCapKind, JobCapKnob> = {
  git: { timeoutMinutes: 30, memoryMb: 256 },
  extension: { timeoutMinutes: 15, memoryMb: 512 },
  kb: { timeoutMinutes: 30, memoryMb: 256 },
  ingest_poll: { timeoutMinutes: 10, memoryMb: 128 },
};

/**
 * Resolves the effective caps for a job kind: the org override (if present
 * and valid) layered on the documented default. Fail-closed — overrides
 * below a sane floor are ignored, never applied.
 */
export function resolveKindCaps(kind: WorkerJobKindLike, orgCaps: OrgJobCaps | null): JobResourceCaps {
  const base = DEFAULT_CAPS[kind as OrgCapKind] ?? DEFAULT_CAPS.git;
  const override = orgCaps?.[kind as OrgCapKind];
  const timeoutSeconds = override?.timeoutMinutes;
  const memoryMb = override?.memoryMb;
  const timeoutMinutes = timeoutSeconds !== undefined && timeoutSeconds >= 1 ? timeoutSeconds : base.timeoutMinutes;
  return {
    timeoutMs: timeoutMinutes * 60_000,
    memoryMb: memoryMb !== undefined && memoryMb >= 32 ? memoryMb : base.memoryMb,
  };
}

// Avoid a type import cycle with the envelope: the kind union is the one
// string set this module is keyed by, spelled out inline.
export type WorkerJobKindLike = OrgCapKind | (string & {});
