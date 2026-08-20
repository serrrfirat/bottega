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
 * below the floor fails the gate.
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
 * The gate decision for one coverage run: a failing suite (status !== 0),
 * an unparseable/missing "All files" row, or either metric below the floor
 * all fail the gate. Pure — never spawns the suite.
 */
export function decideGate(report: string, status: number | null, floor: CoverageFloor = FLOOR): GateResult {
  if (status !== 0) {
    return { ok: false, message: `the suite itself failed (bun test --coverage exited ${status})` };
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
