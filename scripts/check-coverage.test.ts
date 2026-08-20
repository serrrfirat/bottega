/**
 * Hermetic regression for issue #290: the aggregate coverage gate compared
 * bun's PERCENTAGE output (e.g. 91.34) against FRACTIONAL floors (0.85), so
 * 91.34 < 0.85 was never true and the gate could not fail. These tests pin
 * the parser/evaluator contract of scripts/check-coverage.ts — same units on
 * both sides, fail-closed parsing, and a failing test run fails the gate.
 * They never spawn the suite: only the pure parser/evaluator is exercised.
 *
 * Also pins the failing-suite diagnostics (issue #300): the coverage wrapper
 * must surface bounded, secret-scrubbed failing-test snippets (test name +
 * assertion/timeout) rather than swallowing the child output — so a red run
 * is diagnosable from CI output alone.
 */
import { describe, expect, test } from "bun:test";
import {
  FLOOR,
  MAX_FAILURES,
  MAX_SNIPPET_LINES,
  decideGate,
  meetsFloor,
  parseAllFilesRow,
  scrubSecrets,
  summarizeSuiteFailure,
} from "./check-coverage";

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

// --- Failing-suite diagnostics (issue #300) ---------------------------------
// The coverage wrapper used to swallow ALL child output and print only "the
// suite itself failed", leaving a red run undiagnosable from CI alone. These
// tests pin the bounded, scrubbed failing-test diagnostics a failing suite
// now carries.

/** The exact failure shape seen in CI for issue #300 (a 5s-default timeout). */
function timeoutReport(): string {
  return [
    "bun test v1.3.14 (0d9b296a) 1x PARALLEL",
    "--------------------------|---------|---------|",
    "File                      | % Funcs | % Lines |",
    "--------------------------|---------|---------|",
    "All files                 |   91.20 |   90.15 |",
    "(fail) journey 2: work items + approvals + executor > DM with a GitHub issue URL [5000.97ms]",
    "this test timed out after 5000ms.",
    " 1 pass",
    " 1 fail",
  ].join("\n");
}

/** An assertion failure with detail lines (the other common red-run shape). */
function assertionReport(): string {
  return [
    "tests/e2e/work-items.test.ts:",
    "1 | test(\"a > failing branch\", () => {",
    "error: expect(received).toBe(expected)",
    "Expected: 2",
    "Received: 1",
    "(fail) suite a > failing branch [3.12ms]",
    " 0 pass",
    " 1 fail",
  ].join("\n");
}

describe("summarizeSuiteFailure (issue #300)", () => {
  test("names the timed-out journey and its timeout on a suite failure", () => {
    const failures = summarizeSuiteFailure(timeoutReport());
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("DM with a GitHub issue URL");
    expect(failures[0]).toMatch(/timed out after 5000ms/i);
  });

  test("carries assertion detail (error:/Expected:/Received:) for a failed test", () => {
    const failures = summarizeSuiteFailure(assertionReport());
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("suite a > failing branch");
    expect(failures[0]).toContain("Expected: 2");
    expect(failures[0]).toContain("Received: 1");
  });

  test("is bounded to the first MAX_FAILURES failures", () => {
    const many = Array.from(
      { length: MAX_FAILURES + 3 },
      (_, i) => `error: boom\n(fail) suite > failing #${i} [1.00ms]`,
    ).join("\n");
    expect(summarizeSuiteFailure(many)).toHaveLength(MAX_FAILURES);
    // Each snippet carries its own test name; no more than the bound.
    expect(summarizeSuiteFailure(many)[0]).toContain("failing #0");
  });

  test("scrubs token-shaped secrets from child output", () => {
    // The e2e fixture's PAT / Bearer auth / long blobs must never reach CI.
    expect(scrubSecrets("github_pat_e2e_journey_secret_456")).toBe("[redacted]");
    expect(scrubSecrets("Bearer abcdefghijklmnopqrstuvwxyz123456")).toBe("[redacted]");
    expect(scrubSecrets("aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff6666")).toBe("[redacted]");
  });

  test("a report with no failures yields [] (caller still fails closed)", () => {
    expect(summarizeSuiteFailure("All files | 91.20 | 90.15 |")).toEqual([]);
  });

  test("does not attribute a passing test's logged error: to the next failure", () => {
    // Regression (issue #300): bun prints a PASSING test's console.error
    // line into the shared buffer, then the failing test's real error and
    // (fail) anchor. The older extractor buffered 'error:' lines across
    // tests and dumped them onto the NEXT anchor — so a red suite's
    // diagnostics could show 'error: slack unreachable' (from an unrelated
    // passing test) attached to the actual failing test. Detail must be
    // contiguous with its own anchor; source-preview/caret lines break it.
    const report = [
      "tests/e2e/foo.test.ts:",
      "error: slack unreachable", // a passing test that logs an error: line
      "1 | test(\"a > unrelated\", async () => {});",
      "2 | test(\"b > the real failure\", () => {",
      "  ^",
      "error: expect(received).toBe(expected)",
      "Expected: 2",
      "      at <anonymous> (tests/e2e/foo.test.ts:2:8)",
      "(fail) suite b > the real failure [3.12ms]",
    ].join("\n");
    const failures = summarizeSuiteFailure(report);
    expect(failures).toHaveLength(1);
    // The real failure's detail is present…
    expect(failures[0]).toContain("expect(received).toBe(expected)");
    expect(failures[0]).toContain("the real failure");
    // …and the unrelated passing test's log line is NOT attributed.
    expect(failures[0]).not.toContain("slack unreachable");
  });

  test("every snippet stays within MAX_SNIPPET_LINES, timeout included (P3)", () => {
    // Regression (review P3): the extractor could emit MAX_SNIPPET_LINES + 1
    // lines by filling the pre-anchor detail budget AND then unconditionally
    // appending the trailing timeout. The timeout's slot must be reserved up
    // front so the snippet never exceeds the bound.
    const withTimeout = [
      "error: detail-furthest",
      "Expected: detail-middle",
      "Received: detail-nearest",
      "(fail) suite > capped [1.00ms]",
      "this test timed out after 5000ms.",
    ].join("\n");
    const failures = summarizeSuiteFailure(withTimeout);
    expect(failures).toHaveLength(1);
    const linesOut = failures[0]!.split("\n");
    // Retains the timeout AND stays within the bound (never MAX+1).
    expect(linesOut).toHaveLength(MAX_SNIPPET_LINES);
    expect(failures[0]).toContain("timed out after 5000ms");
    expect(linesOut.length).toBeLessThanOrEqual(MAX_SNIPPET_LINES);

    // No timeout: the anchor-adjacent detail is still within the bound.
    const noTimeout = [
      "error: one",
      "Expected: two",
      "Received: three",
      "Expected: four",
      "(fail) suite > capped-no-timeout [1.00ms]",
    ].join("\n");
    const noTimeoutLines = summarizeSuiteFailure(noTimeout)[0]!.split("\n");
    expect(noTimeoutLines.length).toBeLessThanOrEqual(MAX_SNIPPET_LINES);
  });
});

describe("decideGate failure diagnostics (issue #300)", () => {
  test("a failing suite names the failing test in the gate message", () => {
    // The regression: the old gate printed only "the suite itself failed";
    // the message now carries the failing journey + its timeout.
    const result = decideGate(timeoutReport(), 1);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/suite itself failed/);
    expect(result.message).toContain("DM with a GitHub issue URL");
    expect(result.message).toMatch(/timed out after 5000ms/i);
  });

  test("failing-suite diagnostics never leak token-shaped secrets", () => {
    const report = [
      "All files |   91.20 |   90.15 |",
      "error: Bearer abcdefghijklmnopqrstuvwxyz123456 rejected",
      "(fail) suite > live auth [12.00ms]",
    ].join("\n");
    expect(decideGate(report, 1).message).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
    expect(decideGate(report, 1).message).toContain("[redacted]");
  });

  test("a failing suite with no recognizable failure still fails closed", () => {
    const result = decideGate("bun test v1.3.14\n 0 pass\n 1 fail\n", 1);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/suite itself failed/);
  });
});
