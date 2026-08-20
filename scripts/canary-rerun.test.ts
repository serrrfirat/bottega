/**
 * Hermetic proofs for the isolated-rerun classification (issue #298).
 */
import { describe, expect, test } from "bun:test";
import { classifyRerun, verdictOf } from "./canary-rerun";

const PASSED = "live-slack canary PASSED — 9/9 journeys (run abc)";
const FAILED = "live-slack canary FAILED — 1 of 9 journey(s) failed (run abc)";

describe("canary rerun classification (issue #298)", () => {
  test("verdictOf parses the summary line, fail-closed on unknown output", () => {
    expect(verdictOf(PASSED)).toBe("passed");
    expect(verdictOf(FAILED)).toBe("failed");
    expect(verdictOf("some other output")).toBe("unknown");
  });

  test("an original pass is never blocking, never 'recovered'", () => {
    expect(classifyRerun(PASSED, FAILED)).toEqual({ blocking: false, recoveredOnRerun: false });
  });

  test("an original failure stays release-blocking even when the isolated rerun passes (a flake is flagged, never silently cleared)", () => {
    expect(classifyRerun(FAILED, PASSED)).toEqual({ blocking: true, recoveredOnRerun: true });
  });

  test("an original failure with a failing rerun is blocking and not recovered", () => {
    expect(classifyRerun(FAILED, FAILED)).toEqual({ blocking: true, recoveredOnRerun: false });
  });
});