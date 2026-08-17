import { describe, expect, test } from "bun:test";
import { proactiveEnabled } from "./proactive-config";

describe("proactiveEnabled (issues #92 and #93)", () => {
  test("requires an explicit true boolean for each feature", () => {
    const policy = JSON.stringify({ proactive: { standup: true, reflection: false } });

    expect(proactiveEnabled(policy, "standup")).toBe(true);
    expect(proactiveEnabled(policy, "reflection")).toBe(false);
  });

  test("fails closed for absent, malformed, and non-boolean settings", () => {
    expect(proactiveEnabled(JSON.stringify({ response_mode: "always" }), "standup")).toBe(false);
    expect(proactiveEnabled('{"proactive": [', "standup")).toBe(false);
    expect(proactiveEnabled('{"proactive": "yes"}', "standup")).toBe(false);
    expect(proactiveEnabled('{"proactive": {"standup": "true"}}', "standup")).toBe(false);
    expect(proactiveEnabled(JSON.stringify({ proactive: { standup: { nested: true } } }), "standup")).toBe(false);
  });
});
