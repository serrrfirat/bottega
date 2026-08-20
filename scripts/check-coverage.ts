/**
 * Suite-wide coverage gate (testing-gaps audit 2026-08-17, gap #3; #290).
 *
 * bun's native `coverageThreshold` (bunfig.toml) enforces PER FILE, not on
 * the suite aggregate (oven-sh/bun#17028) — any file under the number fails
 * the whole run, so a meaningful global threshold is impossible in bun
 * 1.3.14. This gate runs the full suite with coverage and enforces the
 * AGGREGATE ("All files" row): lines and functions must stay at or above
 * the floor, in PERCENT units (bun prints 91.34, not 0.9134 — issue #290
 * compared percentage output against fractional floors, so the gate could
 * never fail). The floor is the current tree's measured aggregate
 * (2026-08-17: 92.01% functions / 91.34% lines; re-measured serially
 * 2026-08-20: 92.68% / 91.78%) with ~6 points of headroom, and live-only
 * helpers are excluded via bunfig.toml (coveragePathIgnorePatterns).
 *
 * The suite runs with `--parallel=1` — the WHOLE suite serial. That keeps
 * the package test script's stability contract (issue #260: e2e/journey
 * stub-harness response windows hold when the e2e files never run
 * concurrently with the unit group) by construction: nothing is ever
 * concurrent, so the e2e windows hold on ANY host while coverage is
 * measured. One invocation yields ONE honest whole-suite "All files"
 * aggregate — no leg-splitting, no file omitted. A failing suite
 * (nonzero exit), an unparseable/missing "All files" row, or either metric
 * below the floor fails the gate. When the suite itself fails, the gate
 * prints bounded, scrubbed failing-test diagnostics (test name + assertion/
 * timeout detail) so a red run is diagnosable from CI output alone — the
 * coverage wrapper no longer swallows the child output (issue #300).
 *
 * Usage: bun run scripts/check-coverage.ts
 */
import { spawnSync } from "node:child_process";

/** Aggregate floor, in PERCENT units — the same unit bun prints. */
export const FLOOR = { lines: 85, functions: 85 } as const;

export interface CoverageFloor {
  lines: number;
  functions: number;
}

export interface CoverageReport {
  /** function coverage, percent */
  functions: number;
  /** line coverage, percent */
  lines: number;
}

export interface GateResult {
  ok: boolean;
  message: string;
}

const ALL_FILES_ROW = /All files\s+\|\s+([\d.]+)\s+\|\s+([\d.]+)\s+\|/;

/**
 * Parse the "All files" aggregate row from `bun test --coverage` output
 * (columns: File | % Funcs | % Lines | Uncovered Line #s). Throws when the
 * row is missing or unparseable — the gate FAILS CLOSED on such output.
 */
export function parseAllFilesRow(report: string): CoverageReport {
  const match = report.match(ALL_FILES_ROW);
  if (match === null) {
    throw new Error("could not parse the 'All files' row from `bun test --coverage` output");
  }
  const functions = Number(match[1]);
  const lines = Number(match[2]);
  if (!Number.isFinite(functions) || !Number.isFinite(lines)) {
    throw new Error("malformed 'All files' row in `bun test --coverage` output");
  }
  return { functions, lines };
}

/** True when both metrics hold the floor (same percent units on both sides). */
export function meetsFloor(coverage: CoverageReport, floor: CoverageFloor = FLOOR): boolean {
  return coverage.lines >= floor.lines && coverage.functions >= floor.functions;
}

/**
 * Bounded failure diagnostics shown when the suite itself fails (issue #300).
 * `bun test --coverage` prints, per failing test, an `error:` message plus
 * an anchor line `(fail) <test name> [<duration>ms]`; a timed-out test adds
 * `this test timed out after <n>ms.`. The coverage wrapper used to swallow
 * ALL child output and report only "the suite itself failed", so a red run
 * gave CI no way to find the failing test. These bounds keep the gate's
 * stderr concise and secret-safe:
 * - at most {@link MAX_FAILURES} failing tests are surfaced;
 * - each snippet is truncated to at most {@link MAX_SNIPPET_LINES} lines;
 * - token-shaped values are scrubbed so a caught fixture PAT or live token
 *   never leaks into CI logs.
 */
export const MAX_FAILURES = 5;
export const MAX_SNIPPET_LINES = 4;

/** Anchors a failing test report: `(fail) <test name> [<duration>ms]`. */
const FAIL_ANCHOR = /^\s*\(fail\)\s+.+?\s+\[\d+(?:\.\d+)?ms\]\s*$/;
/** A line that names the failure and is contiguous with its own `(fail)` anchor. */
const FAIL_DETAIL = /^(?:error[: ]|Expected:|Received:|AssertionError|this test timed out|✗ )/i;
/** Stack/continuation lines inside the same failure block (kept contiguous with the anchor). */
const FAIL_CONNECTOR = /^(\s*at\s+<|^\s*$)/;
/** A timeout message: `this test timed out after 5000ms.` */
const TIMEOUT_RE = /timed out after\s+\d+\s*ms/i;
/** Long token-shaped runs: Bearer tokens, github_pat_* secrets, hex/base64 blobs. */
const SECRET_RE = /(?:Bearer\s+[A-Za-z0-9_\-.]{12,}|github_pat_[A-Za-z0-9_]+|[A-Za-z0-9+/]{40,}={0,2})/g;
const SECRET_REDACTED = "[redacted]";

/**
 * Scrub token-shaped values from a snippet so child output (fixture PATs,
 * live tokens) never reaches the CI log.
 */
export function scrubSecrets(text: string): string {
  return text.replace(SECRET_RE, SECRET_REDACTED);
}

/**
 * Extract bounded, scrubbed failing-test diagnostics from a `bun test
 * --coverage` report (combined stdout+stderr). Each entry names the failing
 * test plus its assertion/timeout detail when bun printed one. Never
 * throws; returns [] on a report with no recognizable failure so a caller
 * can still fail closed with a generic message.
 */
export function summarizeSuiteFailure(report: string): string[] {
  const lines = report.split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length && out.length < MAX_FAILURES; i++) {
    const anchorLine = lines[i];
    if (!FAIL_ANCHOR.test(anchorLine)) continue;
    // A timeout bun prints on the line(s) right AFTER the anchor
    // (`this test timed out after 5000ms.`); it belongs to this same test.
    const following = lines.slice(i + 1, i + 3).find((l) => TIMEOUT_RE.test(l))?.trim();
    // Reserve the timeout's slot up front so the final snippet (upward +
    // optional timeout) is ALWAYS <= MAX_SNIPPET_LINES — never +1 (P3).
    const budget = MAX_SNIPPET_LINES - (following === undefined ? 0 : 1);
    // Associate ONLY the detail/stack lines contiguous with THIS anchor —
    // scanning upward, stopping at the first line that does not belong to
    // this failure (source preview, caret, file header, coverage row). A
    // passing test's logged `error: ...` line (console.error) is separated
    // by such lines, so it never bleeds into a later test's snippet.
    const upward: string[] = [anchorLine.trim()];
    for (let j = i - 1; j >= 0 && upward.length < budget; j--) {
      const t = lines[j].trim();
      if (FAIL_DETAIL.test(t) || FAIL_CONNECTOR.test(lines[j])) {
        upward.unshift(t);
      } else {
        // A non-detail, non-connector line ends this failure's contiguous
        // detail run (most-important, anchor-adjacent detail is kept).
        break;
      }
    }
    if (following !== undefined) upward.push(following);
    out.push(scrubSecrets(upward.join("\n")));
  }
  return out;
}

/**
 * The gate decision for one coverage run: a failing suite (status !== 0),
 * an unparseable/missing "All files" row, or either metric below the floor
 * all fail the gate. Pure — never spawns the suite. On a failing suite the
 * message carries bounded, scrubbed failing-test diagnostics so a red run
 * can be diagnosed from CI output alone (issue #300).
 */
export function decideGate(report: string, status: number | null, floor: CoverageFloor = FLOOR): GateResult {
  if (status !== 0) {
    const failures = summarizeSuiteFailure(report);
    const base = `the suite itself failed (bun test --coverage exited ${status})`;
    const detail = failures.length > 0 ? `\n${failures.map((f) => `  ${f}`).join("\n")}` : "";
    return { ok: false, message: base + detail };
  }
  let coverage: CoverageReport;
  try {
    coverage = parseAllFilesRow(report);
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
  if (!meetsFloor(coverage, floor)) {
    return {
      ok: false,
      message:
        `aggregate below floor — lines ${coverage.lines.toFixed(2)}% (floor ${floor.lines}%), ` +
        `functions ${coverage.functions.toFixed(2)}% (floor ${floor.functions}%)`,
    };
  }
  return {
    ok: true,
    message: `OK (lines ${coverage.lines.toFixed(2)}%, functions ${coverage.functions.toFixed(2)}%)`,
  };
}

function main(): number {
  // Whole suite, serial (--parallel=1): issue #260's e2e harness windows
  // hold by construction (nothing runs concurrently), and the one "All
  // files" row IS the honest whole-suite aggregate.
  const run = spawnSync("bun", ["test", "--coverage", "--parallel=1"], { encoding: "utf8", timeout: 600_000 });
  const report = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
  const verdict = decideGate(report, run.status, FLOOR);
  if (!verdict.ok) {
    console.error(`coverage gate: ${verdict.message}`);
    return 1;
  }
  console.log(`coverage gate: ${verdict.message}`);
  return 0;
}

if (import.meta.main) {
  process.exit(main());
}
