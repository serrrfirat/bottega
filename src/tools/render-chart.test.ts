/**
 * render_chart tests (issue #276): the tool builds Slack's native
 * data-visualization chart block and posts exactly ONE block into the turn's
 * thread (never per streamed chunk). Validation fails closed — non-finite
 * values, over-cap segments/series, over-long titles, empty labels, and
 * series/category length mismatches return a tool error and never emit a
 * malformed block. The poster seam (SlackTurnPresenter.postChartBlock) is
 * exercised with a blocks-capturing adapter to prove the block shape and the
 * single-post guarantee.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { chartArgsSchema, chartToolDefinition, buildChartBlock } from "./render-chart";
import { SlackTurnPresenter } from "../server/services/slack-turn-presenter";
import type { SlackAdapter, SlackMessage } from "../server/adapters/slack";
import type { Store } from "../store/db";
import { createStore } from "../store/db";
import { createAudit } from "../policy/audit";
import { DenyRouter } from "../policy/approval-router";
import { parseOrgConfigYaml, resolveTier, isKnownTool } from "../policy/config";
import { withPolicyGate } from "../server/drivers/agent-driver";

// ---------------------------------------------------------------------------
// Tool-level: schema + validation + the pure renderer.
// ---------------------------------------------------------------------------

/** Minimal ctx carrying a space session, so execute() derives the space id. */
function ctxFor(spaceId = "slack:C1"): ExtensionContext {
  return {
    sessionManager: { getSessionFile: (): string | undefined => join("/tmp/sessions", `${spaceId}.jsonl`) },
  } as ExtensionContext;
}

function toolFor(posts: Array<{ spaceId: string; block: unknown }>) {
  return chartToolDefinition({ postChart: (spaceId, block) => posts.push({ spaceId, block }) });
}

describe("render_chart registration (issue #276)", () => {
  test("registers as a read-tier tool named render_chart", () => {
    const tool = toolFor([]);
    expect(tool.name).toBe("render_chart");
    expect(tool.approval).toBe("read");
    expect(tool.label.length).toBeGreaterThan(0);
    expect(tool.description).toContain("pie");
    expect(tool.description).toContain("axis_config.categories");
  });
});

describe("render_chart args schema (issue #276)", () => {
  test("accepts a valid pie payload", () => {
    expect(
      chartArgsSchema.safeParse({
        type: "pie",
        title: "Fruit",
        segments: [
          { label: "Apples", value: 3 },
          { label: "Bananas", value: 7 },
        ],
      }).success,
    ).toBe(true);
  });

  test("accepts a valid bar/area/line payload with matching series lengths", () => {
    expect(
      chartArgsSchema.safeParse({
        type: "line",
        title: "Weekly sales",
        series: [{ label: "North", values: [1, 2, 3] }],
        axis_config: { categories: ["Mon", "Tue", "Wed"] },
      }).success,
    ).toBe(true);
  });

  test("rejects a pie payload missing segments", () => {
    expect(chartArgsSchema.safeParse({ type: "pie", title: "X", segments: [] }).success).toBe(false);
  });

  test("rejects more than 12 segments", () => {
    const segments = Array.from({ length: 13 }, (_, i) => ({ label: `s${i}`, value: i + 1 }));
    expect(chartArgsSchema.safeParse({ type: "pie", title: "X", segments }).success).toBe(false);
  });

  test("rejects more than 12 series", () => {
    const series = Array.from({ length: 13 }, (_, i) => ({ label: `s${i}`, values: [i + 1] }));
    expect(
      chartArgsSchema.safeParse({ type: "bar", title: "X", series, axis_config: { categories: ["A"] } }).success,
    ).toBe(false);
  });

  test("rejects a title longer than 50 characters", () => {
    expect(chartArgsSchema.safeParse({ type: "pie", title: "x".repeat(51), segments: [{ label: "A", value: 1 }] }).success).toBe(false);
  });

  test("rejects an empty label", () => {
    expect(chartArgsSchema.safeParse({ type: "pie", title: "X", segments: [{ label: "", value: 1 }] }).success).toBe(false);
  });

  test("rejects a non-finite value", () => {
    expect(
      chartArgsSchema.safeParse({ type: "pie", title: "X", segments: [{ label: "A", value: Number.NaN }] }).success,
    ).toBe(false);
    expect(
      chartArgsSchema.safeParse({ type: "bar", title: "X", series: [{ label: "S", values: [Infinity] }], axis_config: { categories: ["A"] } }).success,
    ).toBe(false);
  });
});

describe("render_chart execute: validation fails closed (issue #276)", () => {
  test("a series/category length mismatch returns a tool error and posts nothing", async () => {
    const posts: Array<{ spaceId: string; block: unknown }> = [];
    const tool = toolFor(posts);
    const res = await tool.execute("c1", {
      type: "bar",
      title: "Mismatch",
      series: [{ label: "S", values: [1, 2] }], // 2 values
      axis_config: { categories: ["A", "B", "C"] }, // 3 categories
    }, undefined, undefined, ctxFor());
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toContain("exactly one value per category");
    expect(posts).toHaveLength(0);
  });

  test("a duplicate series label returns a tool error and posts nothing", async () => {
    const posts: Array<{ spaceId: string; block: unknown }> = [];
    const tool = toolFor(posts);
    const res = await tool.execute("c1", {
      type: "line",
      title: "Dup",
      series: [
        { label: "S", values: [1] },
        { label: "S", values: [2] },
      ],
      axis_config: { categories: ["A"] },
    }, undefined, undefined, ctxFor());
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toContain("duplicate series label");
    expect(posts).toHaveLength(0);
  });

  test("a non-positive pie segment returns a tool error and posts nothing", async () => {
    const posts: Array<{ spaceId: string; block: unknown }> = [];
    const tool = toolFor(posts);
    const res = await tool.execute("c1", {
      type: "pie",
      title: "Pie",
      segments: [{ label: "Zero", value: 0 }],
    }, undefined, undefined, ctxFor());
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toContain("greater than 0");
    expect(posts).toHaveLength(0);
  });
});

describe("buildChartBlock: the Slack data-visualization shape (issue #276)", () => {
  test("pie renders type data_visualization with labeled segments", () => {
    const block = buildChartBlock({
      type: "pie",
      title: "Fruit",
      segments: [
        { label: "Apples", value: 3 },
        { label: "Bananas", value: 7 },
      ],
    }) as { type: string; title: string; chart: { type: string; segments: Array<{ label: string; value: number }> } };
    expect(block.type).toBe("data_visualization");
    expect(block.title).toBe("Fruit");
    expect(block.chart.type).toBe("pie");
    expect(block.chart.segments).toEqual([
      { label: "Apples", value: 3 },
      { label: "Bananas", value: 7 },
    ]);
  });

  test("bar/area/line render axis_config and series whose data count matches categories", () => {
    for (const type of ["bar", "area", "line"] as const) {
      const block = buildChartBlock({
        type,
        title: `${type} chart`,
        series: [
          { label: "North", values: [1, 2, 3] },
          { label: "South", values: [4, 5, 6] },
        ],
        axis_config: { categories: ["Mon", "Tue", "Wed"] },
      }) as {
        type: string;
        chart: {
          type: string;
          axis_config: { categories: string[] };
          series: Array<{ name: string; data: Array<{ label: string; value: number }> }>;
        };
      };
      expect(block.type).toBe("data_visualization");
      expect(block.chart.type).toBe(type);
      expect(block.chart.axis_config.categories).toEqual(["Mon", "Tue", "Wed"]);
      expect(block.chart.series).toHaveLength(2);
      // Each series emits exactly one labelled point per category, in order.
      expect(block.chart.series[0]!.data).toEqual([
        { label: "Mon", value: 1 },
        { label: "Tue", value: 2 },
        { label: "Wed", value: 3 },
      ]);
      expect(block.chart.series[1]!.data).toEqual([
        { label: "Mon", value: 4 },
        { label: "Tue", value: 5 },
        { label: "Wed", value: 6 },
      ]);
    }
  });
});

// ---------------------------------------------------------------------------
// Poster path: the tool posts exactly ONE chart block into the thread.
// ---------------------------------------------------------------------------

describe("render_chart execute: poster path posts exactly one block (issue #276)", () => {
  test("a valid payload posts exactly one block into the derived space", async () => {
    const posts: Array<{ spaceId: string; block: unknown }> = [];
    const tool = toolFor(posts);
    const res = await tool.execute("c1", {
      type: "pie",
      title: "Fruit",
      segments: [
        { label: "Apples", value: 3 },
        { label: "Bananas", value: 7 },
      ],
    }, undefined, undefined, ctxFor("slack:C1"));
    expect(res.isError).not.toBe(true);
    // Exactly ONE block — never a per-chunk duplication.
    expect(posts).toHaveLength(1);
    expect(posts[0]!.spaceId).toBe("slack:C1");
    expect((posts[0]!.block as { type: string }).type).toBe("data_visualization");
  });
});

// ---------------------------------------------------------------------------
// Presenter seam: SlackTurnPresenter.postChartBlock posts the block through
// the SAME postMessage blocks path, threaded under the inbound message —
// exactly one blocks-bearing message per call.
// ---------------------------------------------------------------------------

interface ChartAdapter {
  adapter: SlackAdapter;
  posts: Array<{ spaceId: string; text?: string; opts?: { threadTs?: string; blocks?: unknown[] } }>;
}

function chartAdapter(): ChartAdapter {
  const posts: Array<{ spaceId: string; text?: string; opts?: { threadTs?: string; blocks?: unknown[] } }> = [];
  const adapter: SlackAdapter = {
    async postMessage(spaceId, text, opts) {
      posts.push({ spaceId, text, opts });
      return `post-${posts.length}`;
    },
    async updateMessage() {},
    async downloadFile() {
      throw new Error("not used");
    },
    async uploadFile() {
      return undefined;
    },
    async addReaction() {},
    async removeReaction() {},
    async startStream() {
      throw new Error("not used");
    },
    async appendText() {},
    async appendTask() {},
    async stopStream() {},
    streamingSupported: () => false,
    async start() {},
    async stop() {},
  };
  return { adapter, posts };
}

function chartStore(): Store {
  // SAFETY: the presenter only calls appendAudit; the rest is never touched
  // for a plain chart post, so a double exposing just that member satisfies
  // the executed surface (mirrors slack-turn-presenter.test.ts).
  return {
    appendAudit: async () => 0,
  } as unknown as Store;
}

function inboundMsg(overrides: Partial<SlackMessage> = {}): SlackMessage {
  return { spaceId: "slack:C1", principal: "U1", text: "chart it", ts: "1.1", ...overrides };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("SlackTurnPresenter.postChartBlock: exact one-block post to the thread (issue #276)", () => {
  test("posts exactly ONE blocks-bearing message threaded under the inbound ts", async () => {
    const rec = chartAdapter();
    const presenter = new SlackTurnPresenter({
      spaceId: "slack:C1",
      adapter: rec.adapter,
      store: chartStore(),
      onboardingChecks: () => [],
    });
    // The turn's inbound message sets the threading base.
    presenter.onInbound(inboundMsg({ ts: "1.1" }));
    await flush();

    const block = buildChartBlock({ type: "pie", title: "Fruit", segments: [{ label: "A", value: 2 }] });
    presenter.postChartBlock(block);
    await flush();

    // The chart lands as exactly ONE blocks-bearing post (the inbound's
    // phrase post has no blocks) — never a per-chunk duplication.
    const chartPosts = rec.posts.filter((p) => p.opts?.blocks !== undefined);
    expect(chartPosts).toHaveLength(1);
    const post = chartPosts[0]!;
    expect(post.spaceId).toBe("slack:C1");
    expect(post.opts?.threadTs).toBe("1.1");
    expect(post.opts?.blocks).toHaveLength(1);
    expect(post.opts?.blocks?.[0]).toEqual(block);
  });
});

// ---------------------------------------------------------------------------
// Reachability through the policy gate (issue #276): render_chart must be a
// KNOWN read-tier tool so withPolicyGate lets it through under "read: allow"
// instead of resolving to the exec default and denying every runtime call.
// ---------------------------------------------------------------------------

describe("render_chart policy reachability (issue #276)", () => {
  test("registering render_chart as read tier makes it known and non-exec", () => {
    expect(isKnownTool("render_chart")).toBe(true);
    expect(resolveTier("render_chart")).toBe("read");
  });

  test("withPolicyGate reaches the underlying execute under a read: allow policy", async () => {
    const dir = mkdtempSync(join(tmpdir(), "chart-gate-"));
    const store = createStore(join(dir, "test.db"));
    try {
      const audit = createAudit(store);
      const orgPolicy = parseOrgConfigYaml("tools:\n  render_chart: allow\n");
      const posts: Array<{ spaceId: string; block: unknown }> = [];
      const tool = withPolicyGate(chartToolDefinition({ postChart: (spaceId, block) => posts.push({ spaceId, block }) }), {
        orgPolicy,
        audit,
        router: DenyRouter,
        store,
      });
      const ctx = {
        sessionManager: { getSessionFile: (): string | undefined => join(dir, "sessions", "slack:C1.jsonl") },
      } as ExtensionContext;
      const result = await tool.execute("c1", {
        type: "pie",
        title: "Fruit",
        segments: [{ label: "Apples", value: 3 }],
      }, undefined, undefined, ctx);
      // Read tier + read:allow → the gate lets the call through and the
      // underlying execute runs (it would throw a gate deny if it resolved
      // to exec). The chart posts exactly once.
      expect(result.isError).not.toBe(true);
      expect(posts).toHaveLength(1);
      expect(posts[0]!.spaceId).toBe("slack:C1");
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("render_chart execute: missing space session fails closed (issue #276)", () => {
  test("no session file returns a tool error and posts nothing — never a false success", async () => {
    const posts: Array<{ spaceId: string; block: unknown }> = [];
    const tool = toolFor(posts);
    // A headless/no-session context: getSessionFile yields no space id.
    const ctx = {
      sessionManager: { getSessionFile: (): string | undefined => undefined },
    } as ExtensionContext;
    const res = await tool.execute("c1", {
      type: "pie",
      title: "Fruit",
      segments: [{ label: "Apples", value: 3 }],
    }, undefined, undefined, ctx);
    expect(res.isError).toBe(true);
    expect((res.content[0] as { text: string }).text).toBe("render_chart requires a space session");
    expect(posts).toHaveLength(0);
  });
});