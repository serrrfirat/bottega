import { describe, expect, test } from "bun:test";
import type { TodoPhase } from "@oh-my-pi/pi-coding-agent";
import {
  createTurnProgress,
  renderOutcomeSummary,
  renderTurnProgress,
  todoStageCounts,
  type TurnOutcomeSummary,
} from "./slack-progress";

describe("Slack turn progress", () => {
  test("creates accepted snapshot defaults", () => {
    expect(createTurnProgress(1_000)).toEqual({
      state: "accepted",
      detail: "Request received",
      startedAt: 1_000,
      lastMeaningfulProgressAt: 1_000,
    });
  });

  test("renders an evidence-based state and elapsed time", () => {
    const progress = createTurnProgress(1_000);
    progress.state = "working";
    progress.detail = "Searching Notion";

    expect(renderTurnProgress(progress, 73_000, 0)).toBe(
      "Working — Searching Notion\n1m 12s elapsed",
    );
  });

  test("renders plan counts, elapsed time, and queue count", () => {
    const progress = createTurnProgress(1_000);
    progress.completedStages = 1;
    progress.totalStages = 4;

    expect(renderTurnProgress(progress, 73_000, 2)).toBe(
      "Accepted — Request received\n1 of 4 stages complete · 1m 12s elapsed · +2 waiting",
    );
  });

  test("counts completed versus blocked and abandoned stages", () => {
    const phases: TodoPhase[] = [{
      name: "Run",
      tasks: [
        { content: "Done", status: "completed" },
        { content: "Blocked", status: "blocked", blocker: "auth" },
        { content: "Dropped", status: "abandoned" },
      ],
    }];

    expect(todoStageCounts(phases)).toEqual({ completed: 1, total: 3 });
  });

  test("omits a simple one-source success", () => {
    const summary: TurnOutcomeSummary = {
      outcome: "complete",
      elapsedMs: 12_000,
      sources: [{ label: "GitHub", state: "complete" }],
    };

    expect(renderOutcomeSummary(summary)).toBeUndefined();
  });

  test("renders a one-source failure summary", () => {
    const summary: TurnOutcomeSummary = {
      outcome: "complete",
      elapsedMs: 12_000,
      sources: [{ label: "Notion", state: "failed" }],
    };

    expect(renderOutcomeSummary(summary)).toBe(
      ["Completed in 12s", "Notion: failed"].join("\n"),
    );
  });

  test("renders successful sources before reauthorization", () => {
    const summary: TurnOutcomeSummary = {
      outcome: "partial",
      elapsedMs: 102_000,
      sources: [
        { label: "Notion", state: "needs_reauthorization", action: "connect notion" },
        { label: "GitHub", state: "complete" },
      ],
    };

    expect(renderOutcomeSummary(summary)).toBe([
      "Partial result in 1m 42s",
      "GitHub: complete · Notion: needs reauthorization",
      "Action: connect notion",
    ].join("\n"));
  });

  test("never claims no changes after stop", () => {
    const summary: TurnOutcomeSummary = { outcome: "stopped", elapsedMs: 24_000, sources: [] };
    const rendered = renderOutcomeSummary(summary)!;
    expect(rendered).toContain("Completed actions may remain applied");
    expect(rendered).not.toContain("No external changes were made");
  });

  test("caps sources to three and reports the remainder", () => {
    const summary: TurnOutcomeSummary = {
      outcome: "partial",
      elapsedMs: 5_000,
      sources: [
        { label: "One", state: "complete" },
        { label: "Two", state: "failed" },
        { label: "Three", state: "blocked" },
        { label: "Four", state: "skipped" },
        { label: "Five", state: "complete" },
      ],
    };
    expect(renderOutcomeSummary(summary)).toContain("+2 more");
    expect(renderOutcomeSummary(summary)!.split("\n")[1]).not.toContain("Four:");
  });

  test("keeps outcome summaries to four lines", () => {
    const summary: TurnOutcomeSummary = {
      outcome: "stopped",
      elapsedMs: 5_000,
      action: "recover safely",
      sources: [
        { label: "One", state: "failed", action: "retry one" },
        { label: "Two", state: "blocked" },
        { label: "Three", state: "skipped" },
        { label: "Four", state: "failed" },
      ],
    };
    expect(renderOutcomeSummary(summary)!.split("\n")).toHaveLength(4);
  });
});
