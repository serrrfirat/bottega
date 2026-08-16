import { describe, expect, test } from "bun:test";
import { proactiveEnabled } from "./proactive-config";

describe("proactiveEnabled (issues #92 and #93)", () => {
  test("requires an explicit true scalar for each feature", () => {
    const policy = ["proactive:", "  standup: true", "  reflection: false"].join("\n");

    expect(proactiveEnabled(policy, "standup")).toBe(true);
    expect(proactiveEnabled(policy, "reflection")).toBe(false);
  });

  test("fails closed for absent, malformed, and non-scalar settings", () => {
    expect(proactiveEnabled("response_mode: always", "standup")).toBe(false);
    expect(proactiveEnabled("proactive: [", "standup")).toBe(false);
    expect(proactiveEnabled(["proactive:", "  standup:", "    nested: true"].join("\n"), "standup")).toBe(false);
  });
});
