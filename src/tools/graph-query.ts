/**
 * graph_query (issue #357): the read-tier chat surface of the org graph
 * view. The agent asks "who owns X?" / "what happened to Y?" in natural
 * language; the tool projects the graph over existing tables, matches the
 * question's terms against node labels/ids and decision/memory bodies,
 * and returns each match with its neighborhood (multi-hop, bounded) plus
 * per-claim provenance (#163 receipts pattern — every answer carries WHERE
 * it came from: source, space, principal).
 *
 * Read-tier: pure reads over existing stores — registered read in the
 * policy table like list_todos, definition carries `approval: "read"`.
 *
 * Bounds are fail-closed: term count capped at {@link MAX_TERMS}, matched
 * nodes expanded at {@link MAX_MATCHES}, each walk bounded by
 * DEFAULT_MAX_DEPTH hops; a GraphBoundError surfaces as a tool error
 * rather than a truncated silent result.
 */
import type { AgentToolResult, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { z } from "@oh-my-pi/pi-coding-agent";
import {
  DEFAULT_MAX_DEPTH,
  type EdgeRel,
  type GraphEdge,
  type GraphMemoryRecall,
  type GraphNode,
  type GraphNodeKind,
  neighbors,
  projectGraph,
} from "../graph/view";
import { sessionIdFromFilePath } from "../server/drivers/agent-driver";
import type { Store } from "../store/db";
import { errorMessage, toolError } from "./helpers";

export const graphQueryArgsSchema = z.object({
  /** Natural-language question; its significant terms drive node matching. */
  query: z.string().min(2),
  /** Space id ("slack:C123") to project; defaults to this conversation's space. */
  space: z.string().optional(),
});

/** Options for {@link graphQueryToolDefinition}. */
export interface GraphQueryOpts {
  /**
   * Remote memory seam (mnesis): when provided, the question's terms also
   * recall remote decisions into the match set (term-driven only). Absent
   * → shared-table memories only.
   */
  memoryRecall?: GraphMemoryRecall;
}

/** Question words that never identify a node. */
const STOPWORDS: ReadonlySet<string> = new Set([
  "who",
  "what",
  "owns",
  "own",
  "happened",
  "does",
  "did",
  "how",
  "why",
  "when",
  "which",
  "about",
  "from",
  "into",
  "was",
  "were",
  "has",
  "have",
  "had",
  "are",
  "the",
  "and",
  "for",
  "with",
  "this",
  "that",
]);

/** Term/match ceilings — the tool's fail-closed resource bounds. */
const MAX_TERMS = 8;
const MAX_MATCHES = 5;

function refKey(ref: { kind: GraphNodeKind; id: string }): string {
  return `${ref.kind}:${ref.id}`;
}

interface SerializedEdge {
  from: string;
  to: string;
  rel: EdgeRel;
}

/** Serializes projected edges into compact "kind:id" endpoint strings. */
function serializeEdges(edges: readonly GraphEdge[]): SerializedEdge[] {
  return edges.map((edge) => ({ from: refKey(edge.from), to: refKey(edge.to), rel: edge.rel }));
}

/**
 * Tokenizes a question into matching terms: lowercase words of ≥3 chars,
 * stopwords removed, capped at {@link MAX_TERMS}.
 */
function queryTerms(query: string): string[] {
  return [...new Set(query.toLowerCase().match(/[a-z0-9_:/-]{3,}/g) ?? [])]
    .filter((word) => !STOPWORDS.has(word))
    .slice(0, MAX_TERMS);
}

/** True when a node's label or id contains ANY term (case-insensitive). */
function nodeMatches(node: GraphNode, terms: readonly string[]): boolean {
  const haystack = `${node.label}\n${node.id}`.toLowerCase();
  return terms.some((term) => haystack.includes(term));
}

/**
 * The graph_query tool as an SDK {@link ToolDefinition}: rides the session
 * toolset's gated custom-tools bridge like list_todos / search_web.
 */
export function graphQueryToolDefinition(store: Store, opts: GraphQueryOpts = {}): ToolDefinition {
  const tool: ToolDefinition<typeof graphQueryArgsSchema> = {
    name: "graph_query",
    label: "Query the org graph",
    description:
      "Answers people↔projects↔decisions questions over the org graph: who owns a work item, what was " +
      "delivered for it, which decisions/memories mention a topic, what runs in a space. Matches the " +
      "question's terms against work items, decisions/memories, scheduled jobs, people, repos, and PRs, " +
      "then walks each match's relationships up to two hops. Every match carries provenance (source, " +
      "space, principal) so claims can be traced. Read-only.",
    parameters: graphQueryArgsSchema,
    approval: "read",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx): Promise<AgentToolResult> {
      const spaceId = params.space?.trim() || sessionIdFromFilePath(ctx.sessionManager.getSessionFile());
      if (!spaceId) return toolError("graph_query requires a space session or an explicit `space`");
      try {
        const terms = queryTerms(params.query);
        // Term-driven projection: narrows decision/memory bodies on both the
        // shared-SQLite path and (via the seam) remote backends.
        const scoped = await projectGraph(store, { spaceId, terms, memoryRecall: opts.memoryRecall });
        const matches = scoped.nodes.filter((node) => nodeMatches(node, terms)).slice(0, MAX_MATCHES);
        const results = [];
        for (const match of matches) {
          // Bounded multi-hop context per match (depth ≤2 default).
          const hood = await neighbors(store, match, { spaceId, maxDepth: DEFAULT_MAX_DEPTH });
          results.push({
            node: { kind: match.kind, id: match.id, label: match.label },
            provenance: match.provenance ?? null,
            related: { nodes: hood.nodes.filter((n) => refKey(n) !== refKey(match)), edges: serializeEdges(hood.edges) },
          });
        }
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                query: params.query,
                space: spaceId,
                match_count: results.length,
                matches: results,
                note:
                  matches.length === 0
                    ? "no graph nodes matched the question's terms"
                    : "each match lists its related nodes/edges; use provenance to cite where a claim came from",
              }),
            },
          ],
        };
      } catch (err) {
        // GraphBoundError and store failures alike fail loudly — never a
        // silently truncated answer.
        return toolError(errorMessage(err));
      }
    },
  };
  return tool;
}
