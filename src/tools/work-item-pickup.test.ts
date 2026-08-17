import { describe, expect, test } from "bun:test";
import type { ModelCatalogEntry } from "../models/model-pin";
import {
  buildAutoPickupDirective,
  classifyPickupIntent,
  deriveModelPin,
  parseModelEffortPin,
} from "./work-item-pickup";

const catalog: ModelCatalogEntry[] = [
  { id: "gpt-sol-5.6", name: "GPT-Sol 5.6", provider: "opencode-go" },
  { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash (2x usage)", provider: "opencode-go" },
];

describe("pickup decision table (issue #89)", () => {
  test("disabled never drafts, asks, or classifies (opt-in default)", () => {
    for (const text of ["implement X", "research Y", "update the xls", "could you implement X?", "hi"]) {
      expect(classifyPickupIntent(text)).toBe("none");
      expect(classifyPickupIntent(text, { enabled: false })).toBe("none");
    }
  });

  test("high confidence drafts at the default threshold", () => {
    expect(classifyPickupIntent("implement this feature", { enabled: true })).toBe("draft");
    expect(classifyPickupIntent("research Y", { enabled: true })).toBe("draft");
    expect(classifyPickupIntent("update the xls", { enabled: true })).toBe("draft");
    expect(classifyPickupIntent("please implement X", { enabled: true })).toBe("draft");
    expect(classifyPickupIntent("hey, please create an issue for Z", { enabled: true })).toBe("draft");
    expect(classifyPickupIntent("implement X using deepseek v4 at low effort", { enabled: true })).toBe("draft");
  });

  test("hedged-but-concrete requests ask at the default high threshold", () => {
    expect(classifyPickupIntent("could you implement X?", { enabled: true })).toBe("ask");
    expect(classifyPickupIntent("can you research Y?", { enabled: true })).toBe("ask");
    expect(classifyPickupIntent("would you update the xls?", { enabled: true })).toBe("ask");
  });

  test("vague or object-less requests ask (never guess)", () => {
    expect(classifyPickupIntent("implement something", { enabled: true })).toBe("ask");
    expect(classifyPickupIntent("implement", { enabled: true })).toBe("ask");
    expect(classifyPickupIntent("maybe research?", { enabled: true })).toBe("ask");
    expect(classifyPickupIntent("could you implement something for me?", { enabled: true })).toBe("ask");
  });

  test("non-actionable chatter and status updates are none", () => {
    expect(classifyPickupIntent("what do you think about X?", { enabled: true })).toBe("none");
    expect(classifyPickupIntent("good morning", { enabled: true })).toBe("none");
    expect(classifyPickupIntent("thanks!", { enabled: true })).toBe("none");
    expect(classifyPickupIntent("I updated the xls yesterday", { enabled: true })).toBe("none");
  });

  test("the confidence threshold lowers the drafting bar", () => {
    expect(classifyPickupIntent("could you implement X?", { enabled: true, threshold: "medium" })).toBe("draft");
    expect(classifyPickupIntent("implement something", { enabled: true, threshold: "medium" })).toBe("ask");
    expect(classifyPickupIntent("implement something", { enabled: true, threshold: "low" })).toBe("draft");
  });
});

describe("model/effort derivation (issue #89)", () => {
  test("parses 'using <model> [at <effort>]' from a request", () => {
    expect(parseModelEffortPin("implement X using deepseek v4 at low effort")).toEqual({
      model: "deepseek v4",
      reasoningEffort: "low",
    });
    expect(parseModelEffortPin("research Y using gpt sol 5.6")).toEqual({ model: "gpt sol 5.6" });
    expect(parseModelEffortPin("update the xls using deepseek v4 at HIGH effort please")).toEqual({
      model: "deepseek v4",
      reasoningEffort: "high",
    });
  });

  test("no pin mention parses to null", () => {
    expect(parseModelEffortPin("implement X")).toBeNull();
    expect(parseModelEffortPin("")).toBeNull();
    expect(parseModelEffortPin("using")).toBeNull();
  });

  test("the draft carries the RESOLVED pin when the request names one", () => {
    const derived = deriveModelPin("implement X using deepseek v4 at low effort", catalog);
    expect(derived).toEqual({
      ok: true,
      model: { kind: "id", modelId: "deepseek-v4-flash" },
      reasoningEffort: "low",
    });
  });

  test("a role-ref pin passes through to the draft", () => {
    const derived = deriveModelPin("research Y using fast", catalog);
    expect(derived).toEqual({ ok: true, model: { kind: "role", role: "fast" } });
  });

  test("no pin mention → no pin (space settings apply at execution)", () => {
    expect(deriveModelPin("implement X", catalog)).toBeNull();
  });

  test("an unresolvable model name fails closed with an error (never a silent default)", () => {
    const derived = deriveModelPin("implement X using ghost-model", catalog);
    expect(derived?.ok).toBe(false);
    if (derived && !derived.ok) {
      expect(derived.error).toContain("ghost-model");
      expect(derived.error).toContain("deepseek-v4-flash");
    }
  });
});

describe("pickup directive (issue #89)", () => {
  test("embeds the intent vocabulary and the confirmable-draft flow", () => {
    const directive = buildAutoPickupDirective();
    expect(directive).toContain("implement");
    expect(directive).toContain("research");
    expect(directive).toContain("create an issue");
    expect(directive).toContain("update the xls");
    expect(directive).toContain("CONFIRMABLE DRAFT");
    expect(directive).toContain("create_work_item");
    expect(directive).toContain("pickup_confidence=high");
  });

  test("reflects the configured threshold in the confidence-gate wording", () => {
    const medium = buildAutoPickupDirective("medium");
    expect(medium).toContain("pickup_confidence=medium");
    expect(medium).toContain("hedged-but-concrete");
    expect(buildAutoPickupDirective("low")).toContain("pickup_confidence=low");
    const high = buildAutoPickupDirective("high");
    expect(high).toContain("pickup_confidence=high");
    expect(high).toContain("direct explicit requests");
    expect(high).not.toContain("hedged-but-concrete");
  });
});
