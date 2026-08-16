/**
 * Suite-wide coverage gate (testing-gaps audit 2026-08-17, gap #3).
 *
 * bun's native `coverageThreshold` (bunfig.toml) enforces PER FILE, not on
 * the suite aggregate (oven-sh/bun#17028) — any file under the number fails
 * the whole run, so a meaningful global threshold is impossible in bun
 * 1.3.14. This gate runs the full suite with coverage and enforces the
 * AGGREGATE ("All files" row): lines and functions must stay at or above
 * the floor. The floor is the current tree's measured aggregate
 * (2026-08-17: 92.01% functions / 91.34% lines) with ~6 points of
 * headroom, and live-only helpers are excluded via bunfig.toml
 * (coveragePathIgnorePatterns).
 *
 * Usage: bun run scripts/check-coverage.ts
 */
import { spawnSync } from "node:child_process";

const FLOOR = { lines: 0.85, functions: 0.85 } as const;

const run = spawnSync("bun", ["test", "--coverage"], { encoding: "utf8", timeout: 600_000 });
const report = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
const match = report.match(/All files\s+\|\s+([\d.]+)\s+\|\s+([\d.]+)\s+\|/);
if (match === null) {
  console.error("coverage gate: could not parse the 'All files' row from `bun test --coverage` output");
  process.exit(1);
}
if (run.status !== 0) {
  console.error(`coverage gate: the suite itself failed (bun test --coverage exited ${run.status})`);
  process.exit(run.status ?? 1);
}
const functions = Number(match[1]);
const lines = Number(match[2]);
if (lines < FLOOR.lines || functions < FLOOR.functions) {
  console.error(
    `coverage gate: aggregate below floor — lines ${lines.toFixed(2)}% (floor ${FLOOR.lines * 100}%), ` +
      `functions ${functions.toFixed(2)}% (floor ${FLOOR.functions * 100}%)`,
  );
  process.exit(1);
}
console.log(`coverage gate: OK (lines ${lines.toFixed(2)}%, functions ${functions.toFixed(2)}%)`);
