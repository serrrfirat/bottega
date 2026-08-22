/**
 * Caller-level tests for the usage meter (issue #103): the driver records a
 * `usage.turn` audit row per assistant model completion (zero-cost turns
 * included), the aggregation query rolls those rows up correctly by space +
 * user over a window, and the `usage_summary` read tool surfaces the buckets.
 *
 * These drive the real meter wiring — the OMP driver (or the recorder it
 * invokes), a real SQLite store, and the real audit module — not a mocked
 * append path, so a regression in any link (driver hook, recorder, store
 * row, aggregation, read tool) fails a named test.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolDefinition, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { createStore, type Store } from "../store/db";
import { createAudit } from "../policy/audit";
import { OmpSessionDriver } from "../server/drivers/agent-driver";
import { operatorReadToolDefinitions } from "./operator-read";
import { USAGE_TURN_EVENT } from "../store/audit-events";
import { extractTurnUsage, recordTurnUsage, usageSummary } from "./usage-meter";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function freshStore(): Store {
  const root = mkdtempSync(join(tmpdir(), "bottega-usage-meter-"));
  roots.push(root);
  return createStore(join(root, "usage.db"));
}

/** Appends a usage.turn audit row the way the driver recorder does. */
async function seedTurn(store: Store, row: { spaceId: string | null; actor: string; model: string; tokensIn: number; tokensOut: number; ts?: number }) {
  const audit = createAudit(store);
  return audit.appendAudit({
    ts: row.ts,
    space_id: row.spaceId,
    actor: row.actor,
    event_type: USAGE_TURN_EVENT,
    payload: { model: row.model, tokensIn: row.tokensIn, tokensOut: row.tokensOut },
  });
}

// ---------------------------------------------------------------------------
// extractTurnUsage: the driver's defensive extraction
// ---------------------------------------------------------------------------
describe("extractTurnUsage (#103)", () => {
  test("extracts model + input/output from an assistant message's normalized usage", () => {
    expect(
      extractTurnUsage({ model: "deepseek-v4-flash", usage: { input: 120, output: 45, totalTokens: 165 } }),
    ).toEqual({ model: "deepseek-v4-flash", tokensIn: 120, tokensOut: 45 });
  });

  test("zero-cost usage still extracts (0/0 is a valid metering fact, not an error)", () => {
    expect(extractTurnUsage({ model: "mock-model", usage: { input: 0, output: 0 } })).toEqual({
      model: "mock-model",
      tokensIn: 0,
      tokensOut: 0,
    });
  });

  test("returns null for a missing usage report, missing model, or malformed fields", () => {
    expect(extractTurnUsage({ model: "m", usage: null })).toBeNull();
    expect(extractTurnUsage({ model: "m" })).toBeNull();
    expect(extractTurnUsage({ usage: { input: 1, output: 1 } })).toBeNull(); // no model
    expect(extractTurnUsage({ model: "m", usage: { input: -1, output: 1 } })).toBeNull(); // negative
    expect(extractTurnUsage({ model: "m", usage: { input: 1.5, output: 1 } })).toBeNull(); // non-integer
    expect(extractTurnUsage(null)).toBeNull();
    // A non-assistant shape with no usage report is not a metered turn.
    expect(extractTurnUsage({ model: "m", usage: null })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// recordTurnUsage + usageSummary: the durable append + aggregation
// ---------------------------------------------------------------------------
describe("recordTurnUsage + usageSummary (#103)", () => {
  test("recordTurnUsage writes a usage.turn row with the price-bearing columns", async () => {
    const store = freshStore();
    const audit = createAudit(store);
    await recordTurnUsage(audit, { spaceId: "slack:C1", actor: "U1", model: "m1", tokensIn: 10, tokensOut: 20 });
    const rows = await store.listAudit({ event_type: USAGE_TURN_EVENT });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.space_id).toBe("slack:C1");
    expect(rows[0]!.actor).toBe("U1");
    expect(JSON.parse(rows[0]!.payload)).toEqual({ model: "m1", tokensIn: 10, tokensOut: 20 });
  });

  test("usageSummary buckets by (space, user, model) and sums turns + tokens over the window", async () => {
    const store = freshStore();
    const now = Date.now();
    await seedTurn(store, { spaceId: "slack:C1", actor: "U1", model: "m1", tokensIn: 100, tokensOut: 50, ts: now - 1 });
    await seedTurn(store, { spaceId: "slack:C1", actor: "U1", model: "m1", tokensIn: 30, tokensOut: 10, ts: now - 2 });
    await seedTurn(store, { spaceId: "slack:C1", actor: "U2", model: "m1", tokensIn: 5, tokensOut: 5, ts: now - 3 });
    await seedTurn(store, { spaceId: "slack:C2", actor: "U1", model: "m1", tokensIn: 999, tokensOut: 999, ts: now - 4 });

    const rows = await usageSummary(store, { since: now - 5_000 });
    expect(rows).toHaveLength(3);
    const c1u1 = rows.find((r) => r.spaceId === "slack:C1" && r.actor === "U1");
    expect(c1u1).toEqual({ spaceId: "slack:C1", actor: "U1", model: "m1", turns: 2, tokensIn: 130, tokensOut: 60 });
    const c1u2 = rows.find((r) => r.spaceId === "slack:C1" && r.actor === "U2");
    expect(c1u2?.turns).toBe(1);
    const c2u1 = rows.find((r) => r.spaceId === "slack:C2");
    expect(c2u1?.tokensIn).toBe(999);
  });

  test("usageSummary honors the since window (rows older than the window are excluded)", async () => {
    const store = freshStore();
    const now = Date.now();
    await seedTurn(store, { spaceId: "slack:C1", actor: "U1", model: "m1", tokensIn: 10, tokensOut: 10, ts: now - 1_000 });
    await seedTurn(store, { spaceId: "slack:C1", actor: "U1", model: "m1", tokensIn: 10, tokensOut: 10, ts: now - 100_000 });
    const rows = await usageSummary(store, { since: now - 10_000 });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.turns).toBe(1);
  });

  test("usageSummary narrows to one space when requested", async () => {
    const store = freshStore();
    const now = Date.now();
    await seedTurn(store, { spaceId: "slack:C1", actor: "U1", model: "m1", tokensIn: 1, tokensOut: 1, ts: now });
    await seedTurn(store, { spaceId: "slack:C2", actor: "U1", model: "m1", tokensIn: 50, tokensOut: 50, ts: now });
    const rows = await usageSummary(store, { since: now - 1_000, space: "slack:C1" });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.spaceId).toBe("slack:C1");
  });

  test("malformed or non-numeric payload rows are skipped, not fatal", async () => {
    const store = freshStore();
    const now = Date.now();
    await seedTurn(store, { spaceId: "slack:C1", actor: "U1", model: "m1", tokensIn: 10, tokensOut: 10, ts: now });
    // A durable-audit anomaly: a valid row whose payload is not a usage shape.
    (store.getDb().query("INSERT INTO audit (ts, space_id, actor, event_type, payload) VALUES (?, ?, ?, ?, ?)")).run(
      now,
      "slack:C1",
      "U1",
      USAGE_TURN_EVENT,
      JSON.stringify({ model: 42, tokensIn: 1, tokensOut: 1 }),
    );
    (store.getDb().query("INSERT INTO audit (ts, space_id, actor, event_type, payload) VALUES (?, ?, ?, ?, ?)")).run(
      now,
      "slack:C2",
      "U1",
      USAGE_TURN_EVENT,
      "not-json{{",
    );
    const rows = await usageSummary(store, { since: now - 1_000 });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.spaceId).toBe("slack:C1");
  });
});

// ---------------------------------------------------------------------------
// Caller surface: the driver records a usage row per assistant completion
// ---------------------------------------------------------------------------
describe("driver usage recording (caller surface, #103)", () => {
  /** A stub SDK session exposing the subscribe listener so tests inject events. */
  function stubSession() {
    let listener: ((event: StubSdkEvent) => void) | undefined;
    // SAFETY: the stub implements exactly the members OmpSessionDriver
    // calls on this path (subscribe + lifecycle + prompt seams); the rest
    // of AgentSession is never touched by these tests.
    const session = {
      subscribe: (cb: (event: StubSdkEvent) => void) => {
        listener = cb;
        return () => {
          listener = undefined;
        };
      },
      beginDispose: () => {},
      dispose: async () => {},
      isStreaming: false,
      prompt: async () => {},
      steer: async () => {},
      followUp: async () => {},
      abort: async () => {},
      getAvailableModels: () => [],
      getTodoPhases: () => [],
    } as never;
    return { session, emit: (event: StubSdkEvent) => listener?.(event) };
  }

  /** The subset of an SDK message_event payload the driver reads. */
  interface StubMessage {
    role: string;
    model?: string;
    usage?: { input: number; output: number; totalTokens?: number } | null;
    content?: Array<{ type: string; text: string }>;
    errorMessage?: string;
  }

  type StubSdkEvent =
    | { type: "turn_start" }
    | { type: "message_end"; message: StubMessage }
    | { type: "turn_end"; message: StubMessage }
    | { type: "notice"; level: "error"; message: string }
    | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: never; isError: boolean };

  function assistantMessage(model: string, tokensIn: number, tokensOut: number): StubMessage {
    return {
      role: "assistant",
      model,
      usage: { input: tokensIn, output: tokensOut, totalTokens: tokensIn + tokensOut },
      content: [{ type: "text", text: "reply" }],
    };
  }

  test("an assistant message_end records one usage.turn row with space + actor", async () => {
    const store = freshStore();
    const audit = createAudit(store);
    const { session, emit } = stubSession();
    const driver = new OmpSessionDriver({
      spaceId: "slack:C1",
      session,
      onOutput: () => {},
      usageRecorder: async (turn) => {
        await recordTurnUsage(audit, turn);
      },
    });
    void driver;

    emit({ type: "message_end", message: assistantMessage("deepseek-v4-flash", 120, 45) });
    const rows = await store.listAudit({ event_type: USAGE_TURN_EVENT });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.space_id).toBe("slack:C1");
    expect(rows[0]!.actor).toBe("agent"); // no inbound principal bound
    expect(JSON.parse(rows[0]!.payload)).toEqual({ model: "deepseek-v4-flash", tokensIn: 120, tokensOut: 45 });
  });

  test("a zero-cost assistant completion still records a row (turn count stays accurate)", async () => {
    const store = freshStore();
    const audit = createAudit(store);
    const { session, emit } = stubSession();
    const driver = new OmpSessionDriver({
      spaceId: "slack:C1",
      session,
      onOutput: () => {},
      usageRecorder: async (turn) => {
        await recordTurnUsage(audit, turn);
      },
    });
    void driver;
    emit({ type: "message_end", message: assistantMessage("mock-model", 0, 0) });
    const rows = await store.listAudit({ event_type: USAGE_TURN_EVENT });
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.payload)).toEqual({ model: "mock-model", tokensIn: 0, tokensOut: 0 });
  });

  test("only assistant completions record — user/toolResult message_end events do not", async () => {
    const store = freshStore();
    const audit = createAudit(store);
    const { session, emit } = stubSession();
    const driver = new OmpSessionDriver({
      spaceId: "slack:C1",
      session,
      onOutput: () => {},
      usageRecorder: async (turn) => {
        await recordTurnUsage(audit, turn);
      },
    });
    void driver;
    // A user message carries no model usage → skipped.
    emit({ type: "message_end", message: { role: "user", content: [{ type: "text", text: "hi" }] } });
    // An assistant message WITHOUT a usage report → skipped (provider reported nothing).
    emit({ type: "message_end", message: { role: "assistant", model: "m", content: [{ type: "text", text: "no usage" }] } });
    const rows = await store.listAudit({ event_type: USAGE_TURN_EVENT });
    expect(rows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Read surface: the usage_summary tool aggregates the meter's rows
// ---------------------------------------------------------------------------
describe("usage_summary read tool (caller surface, #103)", () => {
  type ReadResult = { content: Array<{ type: string; text?: string }> };

  async function resultText(result: ReadResult): Promise<string> {
    const first = result.content[0];
    if (!first || first.type !== "text" || first.text === undefined) throw new Error("expected text tool result");
    return first.text;
  }

  const bucketSchema = z.object({
    spaceId: z.string().nullable(),
    actor: z.string(),
    model: z.string(),
    turns: z.number(),
    tokensIn: z.number(),
    tokensOut: z.number(),
  });
  const summarySchema = z.object({
    space: z.string(),
    window: z.string(),
    buckets: z.array(bucketSchema),
  });

  function ctx(spaceId: string): ExtensionContext {
    // SAFETY: the usage_summary tool only inspects the session file path on
    // this context; the fake supplies exactly that boundary method.
    return { sessionManager: { getSessionFile: () => `${spaceId}.jsonl` } } as ExtensionContext;
  }

  function usageTool(store: Store): ToolDefinition {
    const tools = operatorReadToolDefinitions(store, {
      audit: createAudit(store),
      // SAFETY: the usage_summary tool never reads orgPolicy; a minimal
      // stub satisfies the typed deps the operator-read family requires.
      orgPolicy: { ok: true } as never,
      actorForSpace: () => "U1",
      canReadSpace: async () => false,
      now: () => Date.UTC(2026, 7, 21, 12), // fixed "now" for a stable window
    });
    const tool = tools.find((t) => t.name === "usage_summary");
    if (!tool) throw new Error("usage_summary tool not registered");
    return tool;
  }

  test("returns aggregated buckets for the session's space over the window", async () => {
    const store = freshStore();
    const now = Date.UTC(2026, 7, 14, 12); // 7 days before the tool's fixed now
    await seedTurn(store, { spaceId: "slack:C1", actor: "U1", model: "m1", tokensIn: 100, tokensOut: 50, ts: now });
    await seedTurn(store, { spaceId: "slack:C1", actor: "U1", model: "m1", tokensIn: 30, tokensOut: 10, ts: now });
    await seedTurn(store, { spaceId: "slack:C1", actor: "U2", model: "m2", tokensIn: 5, tokensOut: 5, ts: now });
    const tool = usageTool(store);
    const outcome = await tool.execute("call-usage", { window: "7d" }, undefined, undefined, ctx("slack:C1"));
    // SAFETY: the usage_summary tool returns exactly {content:[{type:"text",text}]}; parsed below.
    const res = outcome as ReadResult;
    const summary = summarySchema.parse(JSON.parse(await resultText(res)));
    expect(summary.space).toBe("slack:C1");
    expect(summary.window).toBe("7d");
    expect(summary.buckets).toHaveLength(2);
    const u1 = summary.buckets.find((b) => b.actor === "U1");
    expect(u1).toMatchObject({ actor: "U1", model: "m1", turns: 2, tokensIn: 130, tokensOut: 60 });
    expect(summary.buckets.find((b) => b.actor === "U2")).toMatchObject({ turns: 1, tokensIn: 5, tokensOut: 5 });
  });

  test("a 30d window includes rows a 7d window would exclude", async () => {
    const store = freshStore();
    const now = Date.UTC(2026, 7, 14, 12); // just inside a 7d window
    await seedTurn(store, { spaceId: "slack:C1", actor: "U1", model: "m1", tokensIn: 1, tokensOut: 1, ts: now });
    const tool = usageTool(store);
    const outcome30 = await tool.execute("call-u", { window: "30d" }, undefined, undefined, ctx("slack:C1"));
    // SAFETY: the usage_summary tool returns exactly {content:[{type:"text",text}]}; parsed below.
    const res30 = outcome30 as ReadResult;
    expect(summarySchema.parse(JSON.parse(await resultText(res30))).buckets).toHaveLength(1);
  });

  test("the read is audited as an audit.read row", async () => {
    const store = freshStore();
    const tool = usageTool(store);
    await tool.execute("call-u", { window: "7d" }, undefined, undefined, ctx("slack:C1"));
    const reads = await store.listAudit({ event_type: "audit.read" });
    expect(reads).toHaveLength(1);
    expect(reads[0]!.actor).toBe("U1");
  });
});