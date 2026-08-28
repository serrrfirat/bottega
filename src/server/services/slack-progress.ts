import type { TodoPhase } from "@oh-my-pi/pi-coding-agent";

export type TurnProgressState =
  | "accepted"
  | "planning"
  | "working"
  | "waiting"
  | "finishing";

export type SourceOutcomeState =
  | "complete"
  | "skipped"
  | "blocked"
  | "failed"
  | "needs_reauthorization";

export type TerminalOutcome = "complete" | "partial" | "blocked" | "failed" | "stopped";

export interface TurnProgressSnapshot {
  state: TurnProgressState;
  detail?: string;
  completedStages?: number;
  totalStages?: number;
  startedAt: number;
  lastMeaningfulProgressAt: number;
}

export interface SourceOutcome {
  label: string;
  state: SourceOutcomeState;
  action?: string;
}

export interface TurnOutcomeSummary {
  outcome: TerminalOutcome;
  elapsedMs: number;
  sources: SourceOutcome[];
  action?: string;
}

const LABEL_BY_STATE: Record<TurnProgressState, string> = {
  accepted: "Accepted",
  planning: "Planning",
  working: "Working",
  waiting: "Waiting",
  finishing: "Finishing",
};

const LABEL_BY_SOURCE_STATE: Record<SourceOutcomeState, string> = {
  complete: "complete",
  skipped: "skipped",
  blocked: "blocked",
  failed: "failed",
  needs_reauthorization: "needs reauthorization",
};

export function createTurnProgress(now: number): TurnProgressSnapshot {
  return {
    state: "accepted",
    detail: "Request received",
    startedAt: now,
    lastMeaningfulProgressAt: now,
  };
}

export function todoStageCounts(
  phases: readonly TodoPhase[],
): { completed: number; total: number } | undefined {
  const tasks = phases.flatMap((phase) => phase.tasks);
  if (tasks.length < 2) return undefined;
  return {
    completed: tasks.filter((task) => task.status === "completed").length,
    total: tasks.length,
  };
}

function duration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes === 0 ? `${seconds}s` : `${minutes}m ${remainder}s`;
}

export function renderTurnProgress(
  progress: TurnProgressSnapshot,
  now: number,
  waitingCount: number,
): string {
  const heading = `${LABEL_BY_STATE[progress.state]}${progress.detail ? ` — ${progress.detail}` : ""}`;
  const metadata: string[] = [];
  if (progress.completedStages !== undefined && progress.totalStages !== undefined) {
    metadata.push(`${progress.completedStages} of ${progress.totalStages} stages complete`);
  }
  metadata.push(`${duration(now - progress.startedAt)} elapsed`);
  if (waitingCount > 0) metadata.push(`+${waitingCount} waiting`);
  return `${heading}\n${metadata.join(" · ")}`;
}

export function renderOutcomeSummary(summary: TurnOutcomeSummary): string | undefined {
  if (summary.outcome === "complete" && summary.sources.length <= 1 && summary.action === undefined) {
    return undefined;
  }

  const heading: Record<TerminalOutcome, string> = {
    complete: "Completed",
    partial: "Partial result",
    blocked: "Blocked",
    failed: "Failed",
    stopped: "Stopped",
  };
  const lines = [`${heading[summary.outcome]} in ${duration(summary.elapsedMs)}`];
  if (summary.sources.length > 0) {
    const ordered = [...summary.sources].sort(
      (left, right) => Number(right.state === "complete") - Number(left.state === "complete"),
    );
    const visible = ordered.slice(0, 3);
    const remainder = ordered.length > visible.length ? ` · +${ordered.length - visible.length} more` : "";
    lines.push(
      `${visible.map((source) => `${source.label}: ${LABEL_BY_SOURCE_STATE[source.state]}`).join(" · ")}${remainder}`,
    );
  }
  const action = summary.action ?? summary.sources.find((source) => source.action)?.action;
  if (action) lines.push(`Action: ${action}`);
  if (summary.outcome === "stopped") lines.push("Completed actions may remain applied");
  return lines.slice(0, 4).join("\n");
}
