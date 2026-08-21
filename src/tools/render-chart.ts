/**
 * render_chart (issue #276): renders Slack's native data-visualization
 * chart block (Block Kit `type: "data_visualization"`) and posts it into
 * the turn's thread through the presenter's blocks-capable post path.
 *
 * The agent drives charts from data it already holds — CSVs (via object.get)
 * or any tabular text — by passing a small structured payload:
 *
 *   - `title`: 1-50 chars (Slack enforces the same cap).
 *   - `type`: `pie` | `bar` | `area` | `line`.
 *   - pie: 1-12 segments of {label (1-20 chars), value (finite number)}.
 *   - bar/area/line: 1-12 series of {label (1-20 chars), values (finite
 *     numbers[])} plus `axis_config.categories` (string[]). Each series'
 *     value count MUST equal the categories count (one value per category);
 *     any mismatch fails closed — a malformed block is never emitted.
 *
 * Validation fails closed: non-finite values, over-cap segments/series,
 * empty labels, and label/category mismatches all return a tool error
 * instead of posting a block Slack would reject.
 *
 * Post path: the tool does NOT write Slack itself — it closes over a
 * `postChart(spaceId, block)` sink the boot wires to the space's turn
 * presenter (SpaceService.postChart → SlackTurnPresenter.postChartBlock),
 * which posts exactly ONE blocks-bearing message per tool result into the
 * same thread the reply uses (never per streamed chunk). The tool's text
 * result is a short confirmation; the text reply path is untouched.
 */
import type { AgentToolResult, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { z } from "@oh-my-pi/pi-coding-agent";
import { sessionIdFromFilePath } from "../server/drivers/agent-driver";
import { toolError } from "./helpers";

/** The label/category char caps Slack enforces; mirrored here so we fail closed early. */
const LABEL_MAX = 20;
/** Slack caps each value list at 20 points; the issue caps categories at 12. */
const POINTS_MAX = 20;

const segmentSchema = z.object({
  /** Slice label shown in the legend/hover (Slack cap: 20). */
  label: z.string().min(1).max(LABEL_MAX),
  /** Numeric slice weight; MUST be finite (and > 0 for pie — Slack rejects <= 0). */
  value: z.number().refine(Number.isFinite, "value must be finite"),
});

const seriesSchema = z.object({
  /** Series name shown in the legend (Slack cap: 20, must be unique per chart). */
  label: z.string().min(1).max(LABEL_MAX),
  /** One y value per x category, in the same order as axis_config.categories. */
  values: z.array(z.number().refine(Number.isFinite, "value must be finite")).min(1).max(POINTS_MAX),
});

const axisConfigSchema = z.object({
  /** X-axis category labels, in left-to-right display order (Slack cap: 20 each). */
  categories: z.array(z.string().min(1).max(LABEL_MAX)).min(1).max(POINTS_MAX),
});

/**
 * The render_chart payload (issue #276). A union on `type` so the pie shape
 * (segments) and the axis shape (series + axis_config) are mutually
 * exclusive at the type level; cross-field checks (series value count ==
 * category count) live in {@link chartToolDefinition} because zod cannot
 * express equality across fields. (The SDK's bundled zod subset has no
 * discriminatedUnion/finite — a plain union + refine mirrors the same
 * fail-closed gate.)
 */
export const chartArgsSchema = z.union([
  z.object({
    type: z.literal("pie"),
    /** Chart title (Slack cap: 50). */
    title: z.string().min(1).max(50),
    /** 1-12 labeled slices. */
    segments: z.array(segmentSchema).min(1).max(12),
  }),
  z.object({
    type: z.enum(["bar", "area", "line"]),
    /** Chart title (Slack cap: 50). */
    title: z.string().min(1).max(50),
    /** 1-12 series, each with one value per axis_config.categories entry. */
    series: z.array(seriesSchema).min(1).max(12),
    /** X-axis category labels and (optionally) axis titles. */
    axis_config: axisConfigSchema,
  }),
]);

type ChartArgs =
  | { type: "pie"; title: string; segments: Array<{ label: string; value: number }> }
  | {
      type: "bar" | "area" | "line";
      title: string;
      series: Array<{ label: string; values: number[] }>;
      axis_config: { categories: string[] };
    };

export type PieChartBlock = {
  type: "data_visualization";
  title: string;
  chart: {
    type: "pie";
    segments: Array<{ label: string; value: number }>;
  };
};

export type AxisChartBlock = {
  type: "data_visualization";
  title: string;
  chart: {
    type: "bar" | "area" | "line";
    series: Array<{
      name: string;
      data: Array<{ label: string; value: number }>;
    }>;
    axis_config: { categories: string[] };
  };
};

export type SlackChartBlock = PieChartBlock | AxisChartBlock;

/**
 * Builds the Slack native chart block (Block Kit `type: "data_visualization"`,
 * issue #276) from an already-validated {@link ChartArgs} payload. Pure and
 * unit-testable. For the axis chart types, each series' values are mapped
 * positionally onto axis_config.categories as labelled data points (Slack
 * requires every data point's label to match a category); the renderer is
 * total — it emits min(values.length, categories.length) points so a caller
 * that skips the cross-field gate can never produce an `undefined` value.
 */
export function buildChartBlock(payload: ChartArgs): SlackChartBlock {
  if (payload.type === "pie") {
    return {
      type: "data_visualization",
      title: payload.title,
      chart: {
        type: "pie",
        segments: payload.segments.map((s) => ({ label: s.label, value: s.value })),
      },
    };
  }
  const categories = payload.axis_config.categories;
  return {
    type: "data_visualization",
    title: payload.title,
    chart: {
      type: payload.type,
      series: payload.series.map((s) => {
        // Total renderer: never index past the shorter of the two lists.
        const n = Math.min(s.values.length, categories.length);
        const data = Array.from({ length: n }, (_, i) => ({
          label: categories[i],
          value: s.values[i],
        }));
        return { name: s.label, data };
      }),
      axis_config: { categories },
    },
  };
}

export interface RenderChartOpts {
  /**
   * Posts one chart block into the target space's turn thread (issue #276):
   * wired to SpaceService.postChart → SlackTurnPresenter.postChartBlock at
   * the boot. Exactly one call per tool result — the block is never
   * duplicated per streamed chunk.
   */
  postChart: (spaceId: string, block: SlackChartBlock) => void;
}

/**
 * The render_chart tool as an SDK {@link ToolDefinition} (issue #276): rides
 * the session toolset's gated custom-tools bridge like the work-item and
 * todo tools. Validates the payload (fail closed), builds the Slack chart
 * block, and posts exactly one block through the provided sink. The returned
 * text result is a short confirmation; it never replaces the reply text.
 */
export function chartToolDefinition(opts: RenderChartOpts): ToolDefinition {
  const tool: ToolDefinition<typeof chartArgsSchema> = {
    name: "render_chart",
    label: "Render a native Slack chart",
    description:
      "Renders a native Slack data-visualization chart (pie, bar, area, or line) into " +
      "the conversation as a Block Kit chart block and posts it to the thread. Provide a " +
      "short `title` (up to 50 chars), a `type` (pie | bar | area | line), and the data: for " +
      "pie, 1-12 `segments` each with a `label` (up to 20 chars) and a finite `value`; for " +
      "bar/area/line, 1-12 `series` each with a `label` and `values` (one finite number per x " +
      "category, in the same order) plus an `axis_config.categories` list of the x labels — " +
      "every series must have exactly one value per category. Great for turning CSV/tabular " +
      "data (e.g. from object.get) into a readable chart. Fails closed on invalid data " +
      "(non-finite values, >12 segments/series, empty labels, or series/category length " +
      "mismatches) and never posts a malformed block. Read-tier: rendering a chart only " +
      "posts a message, it does not mutate state.",
    parameters: chartArgsSchema,
    approval: "read",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx): Promise<AgentToolResult> {
      // Cross-field gate: every axis series must carry exactly one value per
      // category — fail closed before any block is built or posted.
      if (params.type !== "pie") {
        const categories = params.axis_config.categories.length;
        for (const series of params.series) {
          if (series.values.length !== categories) {
            return toolError(
              `render_chart: series "${series.label}" has ${series.values.length} value(s) but ` +
                `${categories} category(ies) — each series must have exactly one value per category.`,
            );
          }
        }
      }
      // Duplicate series names are invalid in Slack (legend collision) —
      // fail closed on that too.
      if (params.type !== "pie") {
        const names = new Set<string>();
        for (const s of params.series) {
          if (names.has(s.label)) {
            return toolError(`render_chart: duplicate series label "${s.label}" — series names must be unique.`);
          }
          names.add(s.label);
        }
      }
      // Pie slice values must be > 0 (Slack rejects zero/negative slices).
      if (params.type === "pie") {
        for (const s of params.segments) {
          if (s.value <= 0) {
            return toolError(`render_chart: pie segment "${s.label}" has value ${s.value} — pie values must be greater than 0.`);
          }
        }
      }

      const block = buildChartBlock(params);
      const spaceId = sessionIdFromFilePath(ctx.sessionManager.getSessionFile());
      // A chart has nowhere to land without a space session — fail closed
      // instead of reporting success without posting (mirrors list_todos).
      if (spaceId === undefined) return toolError("render_chart requires a space session");
      opts.postChart(spaceId, block);
      return {
        content: [
          {
            type: "text",
            text: `Rendered a ${params.type} chart "${params.title}" and posted it to the thread.`,
          },
        ],
      };
    },
  };
  return tool;
}