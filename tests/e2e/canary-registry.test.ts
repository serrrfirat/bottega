/**
 * Built-in-tool coverage gate (issue #298).
 *
 * The hybrid canary's journey registry (canary-registry.ts) declares which
 * built-in tools and capability classes every journey covers. This hermetic
 * test enforces the contract:
 *   - every SURFACED_TOOL_NAMES entry maps to a journey `covers` or an
 *     explicit non-empty exclusion — CI fails on an unmapped surfaced tool,
 *   - every `covers` key is a real surfaced tool or a capability class (a
 *     misspelled tool name is a bug, not a silent gap),
 *   - every coverage/exclusion row bills an explicit non-empty reason when
 *     it cannot be exercised by a runnable journey,
 *   - journey ids are stable and unique; each journey has exactly one layer.
 *
 * A NEW built-in tool surfaced in the session allowlist (SPACE_AGENT_TOOLS /
 * PROJECT_TOOL_NAMES / a new scheduler/admin/KB tool) that is NOT added to a
 * journey's `covers` (or an exclusion row) makes `allToolsCovered` false and
 * this test FAILS — the unmapped tool shows up in CI immediately.
 */
import { describe, expect, test } from "bun:test";
import {
  CAPABILITY_CLASSES,
  JOURNEYS,
  SURFACED_TOOL_NAMES,
  uncoveredTools,
  allToolsCovered,
  parseCanaryFilters,
  selectJourneys,
} from "./canary-registry";

const CLASSES = new Set<string>(CAPABILITY_CLASSES as readonly string[]);
const SURFACED = new Set<string>(SURFACED_TOOL_NAMES);

describe("hybrid canary tool-coverage gate (issue #298)", () => {
  test("every surfaced built-in tool is covered or explicitly excluded", () => {
    const missing = uncoveredTools();
    expect(missing).toEqual([]);
    expect(allToolsCovered()).toBe(true);
  });

  test("every runnable journey `covers` key is a real surfaced tool or a capability class", () => {
    // A runnable journey (no exclusionReason) MUST cover surfaced tools or
    // classes — a misspelled or non-surfaced name there is a real gap. An
    // EXCLUSION row may reference non-surfaced SDK built-ins as its
    // exclusion keys (that is the point of the exclusion), so those are not
    // flagged here — their non-empty reason is validated separately.
    const bogus: string[] = [];
    for (const j of JOURNEYS) {
      if (j.exclusionReason !== undefined) continue;
      for (const key of j.covers) {
        if (!SURFACED.has(key) && !CLASSES.has(key)) bogus.push(`${j.id}:${key}`);
      }
    }
    expect(bogus).toEqual([]);
  });

  test("every coverage/exclusion row bills an explicit non-empty reason when it is not runnable", () => {
    // A row that carries an exclusionReason must have a non-empty one; a runnable
    // journey must NOT carry one (it must be exercised, not waved off).
    for (const j of JOURNEYS) {
      if (j.exclusionReason !== undefined) {
        expect(j.exclusionReason.trim().length, `${j.id} has a blank exclusion reason`).toBeGreaterThan(0);
      }
    }
  });

  test("journey ids are stable and unique", () => {
    const ids = JOURNEYS.map((j) => j.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("every journey has exactly one valid layer and all referenced actors are the fixed identities", () => {
    const FIXED_ACTORS = new Set(["requester", "space-approver", "member", "second-member", "bot"]);
    for (const j of JOURNEYS) {
      expect(["hermetic", "live-api", "browser"]).toContain(j.layer);
      for (const actor of j.actors) {
        expect(FIXED_ACTORS.has(actor), `${j.id} references unknown actor ${actor}`).toBe(true);
      }
    }
  });

  test("each layer has at least one runnable journey (no layer is an empty shell)", () => {
    const runnableLayers = new Set(
      JOURNEYS.filter((j) => j.exclusionReason === undefined).map((j) => j.layer),
    );
    expect(runnableLayers).toContain("hermetic");
    expect(runnableLayers).toContain("live-api");
    expect(runnableLayers).toContain("browser");
  });

  test("focused-run filters parse and select the right journeys; unknown values fail loudly (issue #298)", () => {
    // --layer narrows to one layer.
    expect(selectJourneys(parseCanaryFilters(["--layer", "live-api"])).every((j) => j.layer === "live-api")).toBe(true);
    // --journey selects a single stable id.
    const one = selectJourneys(parseCanaryFilters(["--journey", "roles.cross-user-queue-ownership"]));
    expect(one.map((j) => j.id)).toEqual(["roles.cross-user-queue-ownership"]);
    // --role selects journeys touching an actor.
    const byRole = selectJourneys(parseCanaryFilters(["--role", "requester"]));
    expect(byRole.length).toBeGreaterThan(0);
    expect(byRole.every((j) => j.actors.includes("requester"))).toBe(true);
    // Unknown values THROW — a mistyped filter never silently runs everything.
    expect(() => parseCanaryFilters(["--layer", "nope"])).toThrow(/invalid --layer/);
    expect(() => parseCanaryFilters(["--journey", "nope"])).toThrow(/invalid --journey/);
    expect(() => parseCanaryFilters(["--role", "nobody"])).toThrow(/invalid --role/);
  });
});