/**
 * Hermetic regression for issue #290: the aggregate coverage gate compared
 * bun's PERCENTAGE output (e.g. 91.34) against FRACTIONAL floors (0.85), so
 * 91.34 < 0.85 was never true and the gate could not fail. These tests pin
 * the parser/evaluator contract of scripts/check-coverage.ts — same units on
 * both sides, fail-closed parsing, and a failing test run fails the gate.
 * They never spawn the suite: only the pure parser/evaluator is exercised.
 */
import { describe, expect, test } from "bun:test";
import { FLOOR, decideGate, meetsFloor, parseAllFilesRow } from "./check-coverage";

/** A realistic `bun test --coverage` table, with the given percentages. */
function bunReport(lines: number, functions: number): string {
  return [
    "--------------------------|---------|---------|-------------------",
    "File                      | % Funcs | % Lines | Uncovered Line #s",
    "--------------------------|---------|---------|-------------------",
    `All files                 | ${functions.toFixed(2).padStart(7)} | ${lines.toFixed(2).padStart(7)} |`,
    " src/index.ts             |   50.00 |   66.67 | 1-10",
    "--------------------------|---------|---------|-------------------",
  ].join("\n");
}

describe("parseAllFilesRow (issue #290)", () => {
  test("parses percentage values exactly as bun prints them", () => {
    const coverage = parseAllFilesRow(bunReport(91.34, 92.01));
    expect(coverage.lines).toBe(91.34);
    expect(coverage.functions).toBe(92.01);
  });

  test("a report without the 'All files' row fails closed", () => {
    expect(() => parseAllFilesRow("no coverage table here\n")).toThrow(/All files/);
  });

  test("a malformed 'All files' row fails closed", () => {
    expect(() => parseAllFilesRow("All files | nope | also-nope |")).toThrow(/All files/);
  });
});

describe("meetsFloor / decideGate (issue #290)", () => {
  test("the floor is enforced in PERCENT units (85, not 0.85)", () => {
    // The regression: a fractional floor made 84.99% >= 0.85 and the gate
    // could never fail. The floor must be the same unit bun prints.
    expect(FLOOR.lines).toBe(85);
    expect(FLOOR.functions).toBe(85);
    // A realistic passing tree (91.34% lines / 92.01% functions) holds the
    // floor — this was the state that could never trip the old gate.
    expect(meetsFloor({ lines: 91.34, functions: 92.01 }, FLOOR)).toBe(true);
  });

  test("84.99% lines fails, 85.00% lines passes", () => {
    expect(decideGate(bunReport(84.99, 85.0), 0).ok).toBe(false);
    expect(decideGate(bunReport(85.0, 85.0), 0).ok).toBe(true);
  });

  test("either metric below the floor fails", () => {
    // Lines at floor, functions below.
    expect(decideGate(bunReport(85.0, 84.99), 0).ok).toBe(false);
    // Functions at floor, lines below.
    expect(decideGate(bunReport(84.99, 85.0), 0).ok).toBe(false);
  });

  test("a failing test run fails the gate even with passing coverage", () => {
    const result = decideGate(bunReport(95.0, 95.0), 1);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/suite itself failed/);
  });

  test("an unparseable report fails the gate, not crashes it", () => {
    const result = decideGate("some output without a coverage table", 0);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/All files/);
  });
});
