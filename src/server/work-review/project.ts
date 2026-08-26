/**
 * Plain-language work review projection (issue #359).
 *
 * This is deliberately read-only: the work item, timeline, and org graph are
 * the sources of truth. Rendering callers can choose how to collapse the raw
 * activity trail without losing evidence here.
 */
import { z } from "zod";
import type { Store, WorkItem, WorkItemState } from "../../store/db";
import { projectGraph, type GraphNode, type GraphProjection } from "../../graph/view";
import { buildTimeline, type TimelineEntry } from "../../work-items/timeline";

export type PlainWorkReview = {
  workItemId: string;
  title: string;
  state: WorkItemState;
  whatHappened: string[];
  workCompleted: string[];
  stillNeeded: string[];
  relatedPeople: string[];
  relatedMatters: string[];
  relatedDocuments: string[];
  relatedDecisions: string[];
  activity: TimelineEntry[];
};

const PLAIN_TEXT_MAX_CHARS = 280;
const WORK_ITEM_ID = /\b(?:wi|job|mem|run)_[A-Za-z0-9-]+\b/g;
const FILE_PATH = /\b(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+(?::\d+(?::\d+)?)?\b/g;
const FUNCTION_CALL = /\b[A-Za-z_$][\w$]*\([^\n)]*\)/g;
const STACK_TAIL = /\s+\bat\s+\S.*$/i;
const TOOL_NAME = /\b(?:apply_patch|bash|browser|cat|curl|docker|find|git|gh|grep|ls|make|node|npm|pytest|python|rg|sqlite3|tsc|tool_use|tool_call)\b/gi;
const COMMAND_OPTION = /\s+--?[A-Za-z][\w-]*(?:=\S+)?/g;
const NAMED_ARGUMENT = /\b(?:args?|command|tool)\s*[:=]\s*\S+/gi;

/**
 * Keeps only a bounded, sentence-like first line for prose arrays. Raw
 * transcript entries remain untouched in `activity`; this boundary prevents
 * stack traces, command arguments, and stable technical ids leaking into the
 * plain-language sections.
 */
function plainText(value: string): string {
  const firstLine = value.split(/\r?\n/, 1)[0] ?? "";
  const cleaned = firstLine
    .replace(STACK_TAIL, " ")
    .replace(/```[^`]*```/g, " ")
    .replace(FUNCTION_CALL, " ")
    .replace(FILE_PATH, " ")
    .replace(WORK_ITEM_ID, " ")
    .replace(NAMED_ARGUMENT, " ")
    .replace(COMMAND_OPTION, " ")
    .replace(TOOL_NAME, " ")
    .replace(/\{[^{}]*\}/g, " ")
    .replace(/\[args?\s*:[^\]]*\]/gi, " ")
    .replace(/\s+/g, " ")
    .replace(/\(\s*\)/g, "")
    .trim()
    .replace(/^(?:error|exception|failure)\s*:\s*/i, "")
    .trim();
  return cleaned.length > PLAIN_TEXT_MAX_CHARS ? `${cleaned.slice(0, PLAIN_TEXT_MAX_CHARS - 1).trimEnd()}…` : cleaned;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

function firstNonEmptyLine(description: string): string {
  return description.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0) ?? "";
}

function pauseEntry(entry: TimelineEntry): entry is Extract<TimelineEntry, { kind: "failed" | "blocked" }> {
  return entry.kind === "failed" || entry.kind === "blocked";
}

function pauseReason(entry: Extract<TimelineEntry, { kind: "failed" | "blocked" }>): string {
  return plainText(entry.cause);
}

const evidenceSchema = z.array(z.object({ url: z.string().min(1) }).passthrough());

function evidenceNotes(item: WorkItem): string[] {
  // SAFETY: the evidence blob is written by the worker's completion path;
  // the schema parse drops malformed rows instead of trusting the shape.
  let decoded: unknown;
  try {
    decoded = JSON.parse(item.evidence);
  } catch {
    return [];
  }
  const parsed = evidenceSchema.safeParse(decoded);
  return parsed.success ? parsed.data.map((entry) => plainText(entry.url)) : [];
}

function asksForHumanInput(note: string): boolean {
  return /\b(?:human|operator|user)\s+input\b|\b(?:please|need(?:s)?|provide|confirm|decide|specify|awaiting)\b/i.test(note);
}

function nodeLabel(nodes: Map<string, GraphNode>, kind: GraphNode["kind"], id: string): string | null {
  const node = nodes.get(`${kind}:${id}`);
  if (node === undefined) return null;
  const label = kind === "person" || kind === "repo" || kind === "pr" ? node.label.trim() : plainText(node.label);
  if (label.length > 0) return label;
  if (node.provenance !== undefined) return plainText(node.provenance.source);
  return null;
}

function relatedSections(item: WorkItem, graph: GraphProjection): Pick<PlainWorkReview, "relatedPeople" | "relatedMatters" | "relatedDocuments" | "relatedDecisions"> {
  const nodes = new Map(graph.nodes.map((node) => [`${node.kind}:${node.id}`, node]));
  const people: string[] = [];
  const matters: string[] = [];
  const documents: string[] = [];
  const decisions: string[] = [];
  for (const edge of graph.edges) {
    const fromItem = edge.from.kind === "work-item" && edge.from.id === item.id;
    const toItem = edge.to.kind === "work-item" && edge.to.id === item.id;
    if (!fromItem && !toItem) continue;
    const other = fromItem ? edge.to : edge.from;
    if (other.kind === "person" && (edge.rel === "created" || edge.rel === "assigned" || edge.rel === "approved-by")) {
      const label = nodeLabel(nodes, "person", other.id);
      if (label !== null) people.push(label);
    } else if (other.kind === "work-item" && other.id !== item.id) {
      const label = nodeLabel(nodes, "work-item", other.id);
      if (label !== null) matters.push(label);
    } else if (other.kind === "repo" || other.kind === "pr") {
      const label = nodeLabel(nodes, other.kind, other.id);
      if (label !== null) documents.push(label);
    } else if (other.kind === "memory" && edge.rel === "mentions") {
      const label = nodeLabel(nodes, "memory", other.id);
      if (label !== null) decisions.push(label);
    }
  }
  return {
    relatedPeople: unique(people).sort(),
    relatedMatters: unique(matters).sort(),
    relatedDocuments: unique(documents).sort(),
    relatedDecisions: unique(decisions).sort(),
  };
}

function evidenceSummary(item: WorkItem): string[] {
  return unique(evidenceNotes(item).filter(asksForHumanInput));
}

export async function projectWorkReview(
  deps: { store: Store; transcriptDir: string },
  id: string,
): Promise<PlainWorkReview | null> {
  const item = await deps.store.getWorkItem(id);
  if (item === null) return null;

  let activity: TimelineEntry[] | null;
  try {
    activity = await buildTimeline(deps.store, deps.transcriptDir, id);
  } catch {
    return null;
  }
  if (activity === null) return null;
  const title = firstNonEmptyLine(item.description);

  const pauses = activity.flatMap((entry, index) => (pauseEntry(entry) ? [{ entry, index, reason: pauseReason(entry) }] : []));
  const lastPause = pauses.findLast((pause) => pause.reason.length > 0) ?? pauses.at(-1);
  const pauseReasonText = lastPause?.reason ?? "";
  const whatHappened = [plainText(title)];
  if (pauseReasonText.length > 0) whatHappened.push(`This work paused because ${pauseReasonText}`);

  const completedBeforePause = activity.slice(0, lastPause?.index ?? activity.length).flatMap((entry) => {
    if (entry.kind === "turn") return [plainText(entry.summary)];
    if (entry.kind === "completed") return [plainText(entry.cause)];
    if (entry.kind === "delivery-pending") return ["Delivery is pending"];
    return [];
  });
  const stillNeeded = item.state === "blocked" || item.state === "aborted" ? [pauseReasonText, ...evidenceSummary(item)] : [];
  const graph = await projectGraph(deps.store, { spaceId: item.space_id });
  return {
    workItemId: item.id,
    title,
    state: item.state,
    whatHappened: unique(whatHappened),
    workCompleted: unique(completedBeforePause),
    stillNeeded: unique(stillNeeded),
    ...relatedSections(item, graph),
    activity,
  };
}
