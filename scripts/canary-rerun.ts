/**
 * One-isolated-rerun classification for the hybrid canary (issue #298).
 *
 * When the scheduled live-API run fails, the workflow reruns once in
 * isolation. This helper classifies that rerun so a flake is reported
 * distinctly while the ORIGINAL failure stays release-blocking:
 *   - original passed            → { blocking: false, recoveredOnRerun: false }
 *   - original failed, rerun fail → { blocking: true,  recoveredOnRerun: false }
 *   - original failed, rerun pass → { blocking: true,  recoveredOnRerun: true  }
 *
 * The release-blocking verdict ALWAYS derives from the ORIGINAL run — a
 * flake never silently becomes a pass; it is merely flagged as recovered so
 * a human can confirm the root cause is not a real regression (issue #298:
 * "the original failure remains release-blocking; report recovered-on-rerun
 * distinctly").
 */
import { readFileSync } from "node:fs";

export interface RerunClassification {
  /** Whether the ORIGINAL run failed (the release-blocking signal). */
  blocking: boolean;
  /** True when the original failed but the isolated rerun passed (a flake). */
  recoveredOnRerun: boolean;
}

/** The pass/fail verdict of a canary report file's "PASSED"/"FAILED" summary line. */
export function verdictOf(report: string): "passed" | "failed" | "unknown" {
  if (report.includes("live-slack canary PASSED")) return "passed";
  if (report.includes("live-slack canary FAILED")) return "failed";
  return "unknown";
}

/** Pure classification given the two reports (testable with no I/O). */
export function classifyRerun(original: string, rerun: string): RerunClassification {
  const originalVerdict = verdictOf(original);
  const rerunVerdict = verdictOf(rerun);
  if (originalVerdict !== "failed") {
    return { blocking: false, recoveredOnRerun: false };
  }
  return { blocking: true, recoveredOnRerun: rerunVerdict === "passed" };
}

/** CLI entry: classify the original + optional rerun and print a status line. */
export function main(argv: string[], env: Record<string, string | undefined> = process.env): number {
  const originalPath = argv[2] ?? env.CANARY_REPORT ?? "canary-report.txt";
  const rerunPath = argv[3] ?? env.CANARY_RERUN_REPORT;
  let original: string;
  try {
    original = readFileSync(originalPath, "utf8");
  } catch {
    console.error(`canary-rerun: cannot read the original report at ${originalPath}`);
    return 1;
  }
  const classification: RerunClassification =
    rerunPath === undefined ? { blocking: true, recoveredOnRerun: false } : classifyRerun(original, readOrEmpty(rerunPath));
  const label = classification.blocking
    ? classification.recoveredOnRerun
      ? "RECOVERED-ON-RERUN (original remains release-blocking — confirm the root cause)"
      : "FAILED (release-blocking)"
    : "PASSED";
  console.log(`canary verdict: ${label}`);
  return classification.blocking && !classification.recoveredOnRerun ? 1 : 0;
}

function readOrEmpty(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

if (import.meta.main) {
  process.exit(main(process.argv));
}