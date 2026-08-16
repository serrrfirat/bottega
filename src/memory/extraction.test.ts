import { describe, expect, test } from "bun:test";
import { buildExtractionPrompt, createBurstBuffer, filterFacts, parseFacts, type ExtractionTurn } from "./extraction";

describe("memory extraction", () => {
  test("prompt makes human messages the only valid provenance", () => {
    const prompt = buildExtractionPrompt(
      [{ input: "Thanks for checking.", reply: "You prefer pnpm and your project is Atlas." }],
      "user",
    );

    expect(prompt).toContain("ONLY when a HUMAN MESSAGE explicitly states it");
    expect(prompt).toContain("NEVER derive, confirm, infer, or copy a fact from an ASSISTANT REPLY");
    expect(prompt).toContain("ASSISTANT REPLY (CONTEXT ONLY; NEVER EVIDENCE)");
    expect(prompt).toContain("durable preferences, identifiers, ongoing projects, and how people like to work");
    expect(prompt).toContain("For a standing system, record only that it exists, never its internals");
    expect(prompt).toContain('HUMAN MESSAGE:\n"Thanks for checking."');
    expect(prompt).toContain('ASSISTANT REPLY (CONTEXT ONLY; NEVER EVIDENCE):\n"You prefer pnpm and your project is Atlas."');
    expect(prompt).toContain("Output ONLY a Markdown bullet list");
    expect(prompt).toContain("output exactly NONE");
  });

  test("parseFacts accepts bullets and treats NONE as empty", () => {
    expect(parseFacts("NONE")).toEqual([]);
    expect(parseFacts("  none  ")).toEqual([]);
    expect(parseFacts("- Ada prefers short pull requests.\nnot a bullet\n- Ada works on Atlas.\n- Ada works on Atlas.")).toEqual([
      "Ada prefers short pull requests.",
      "Ada works on Atlas.",
    ]);
  });

  test("filterFacts drops secret-shaped facts and reports the count", () => {
    const result = filterFacts([
      "Ada prefers concise status updates.",
      "Ada's API key is sk-secretvalue123.",
      "The deployment URL is https://admin:hunter2@example.test/private.",
      "The team uses an internal deployment system.",
      "The access_token=abcd1234 should be reused.",
    ]);

    expect(result).toEqual({
      facts: [
        "Ada prefers concise status updates.",
        "The team uses an internal deployment system.",
      ],
      dropped: 3,
    });
  });
});

describe("burst buffer", () => {
  test("flushes each space after injected-clock quiet time", async () => {
    let now = 1_000;
    const flushed: Array<{ spaceId: string; turns: readonly ExtractionTurn[] }> = [];
    const buffer = createBurstBuffer({
      quietMs: 100,
      maxTurns: 10,
      now: () => now,
      flush: (spaceId, turns) => flushed.push({ spaceId, turns }),
    });

    buffer.add("slack:C1", { input: "one", reply: "first" });
    now += 99;
    buffer.flushDue();
    expect(flushed).toEqual([]);

    now += 1;
    buffer.flushDue();
    await buffer.drain();
    expect(flushed).toEqual([
      { spaceId: "slack:C1", turns: [{ input: "one", reply: "first" }] },
    ]);
    buffer.close();
  });

  test("flushes immediately at maxTurns without mixing spaces", async () => {
    const flushed: Array<{ spaceId: string; turns: readonly ExtractionTurn[] }> = [];
    const buffer = createBurstBuffer({
      quietMs: 10_000,
      maxTurns: 2,
      flush: (spaceId, turns) => flushed.push({ spaceId, turns }),
    });

    buffer.add("slack:C1", { input: "one", reply: "first" });
    buffer.add("slack:C2", { input: "other", reply: "other reply" });
    buffer.add("slack:C1", { input: "two", reply: "second" });
    await buffer.drain();

    expect(flushed[0]).toEqual({
      spaceId: "slack:C1",
      turns: [
        { input: "one", reply: "first" },
        { input: "two", reply: "second" },
      ],
    });
    expect(flushed[1]).toEqual({
      spaceId: "slack:C2",
      turns: [{ input: "other", reply: "other reply" }],
    });
    buffer.close();
  });
});
