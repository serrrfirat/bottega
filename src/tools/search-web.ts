/**
 * search_web (issue #388): the first-party web-search tool with cited
 * sources. The agent queries the internal SearXNG JSON API and gets back
 * structured results (title, url, snippet) that it renders as a table —
 * every claim carries the URL it came from.
 *
 * Read-tier: the policy table resolves it to read and the definition carries
 * `approval: "read"`.
 */
import type { AgentToolResult, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { z } from "@oh-my-pi/pi-coding-agent";
import { errorMessage, toolError } from "./helpers";

/** The internal SearXNG service endpoint. */
const DEFAULT_SEARCH_BASE_URL = "http://searxng:8080";
const SEARCH_PATH = "/search";

/** One structured search result the tool returns; the agent renders it as a table row. */
export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export const searchWebArgsSchema = z.object({
  /** The natural-language search query ("bottega pricing page"). */
  query: z.string().min(1),
  /** Maximum results to return (1-10, capped server-side). */
  max_results: z.number().int().min(1).max(10).optional(),
});

/** One result from SearXNG's JSON body. */
const providerResultSchema = z.object({
  title: z.string().optional().default(""),
  url: z.string().optional().default(""),
  content: z.string().optional().default(""),
});

/** SearXNG's JSON search body. */
const providerSearchResponseSchema = z.object({
  results: z.array(providerResultSchema),
});

export interface SearchWebToolOpts {
  /** SearXNG's base URL; hermetic tests point this at a local stub endpoint. */
  baseUrl?: string;
  /** Outbound fetch seam; defaults to global fetch. */
  fetch?: typeof fetch;
}

/** The SearXNG base URL for a given opts set. */
export function searchBaseUrl(opts: SearchWebToolOpts = {}): string {
  return opts.baseUrl ?? DEFAULT_SEARCH_BASE_URL;
}

/**
 * The search_web tool as an SDK {@link ToolDefinition} (issue #388): rides
 * the session toolset's gated custom-tools bridge like the work-item and
 * list_todos tools. Read-tier.
 */
export function searchWebToolDefinition(opts: SearchWebToolOpts = {}): ToolDefinition {
  const baseUrl = searchBaseUrl(opts);
  const doFetch = opts.fetch ?? fetch;
  const tool: ToolDefinition<typeof searchWebArgsSchema> = {
    name: "search_web",
    label: "Search the web with cited sources",
    description:
      "Search the public web for current, external, research, news, comparison, or source-verifiable information; use the cited URLs in the answer, and do not use this tool for repository-local facts.",
    parameters: searchWebArgsSchema,
    approval: "read",
    async execute(_toolCallId, params, _signal, _onUpdate): Promise<AgentToolResult> {
      const query = params.query.trim();
      const max = params.max_results ?? 5;
      if (!query) return toolError("search_web requires a non-empty query");
      try {
        const url = new URL(SEARCH_PATH, `${baseUrl}/`);
        url.searchParams.set("q", query);
        url.searchParams.set("format", "json");
        url.searchParams.set("categories", "general");
        url.searchParams.set("safesearch", "1");
        const response = await doFetch(url, { method: "GET" });
        if (!response.ok) {
          const detail = (await response.text().catch(() => "")).slice(0, 200);
          return toolError(
            `search_web provider returned ${response.status}${detail ? `: ${detail}` : ""}`,
          );
        }
        let body: unknown;
        try {
          body = await response.json();
        } catch {
          return toolError("search_web provider returned an unparseable body: invalid JSON");
        }
        const parsed = providerSearchResponseSchema.safeParse(body);
        if (!parsed.success) {
          return toolError(`search_web provider returned an unparseable body: ${errorMessage(parsed.error)}`);
        }
        const results = parsed.data.results
          .filter((row) => row.url.trim() !== "")
          .slice(0, max)
          .map((row) => ({
            title: row.title,
            url: row.url,
            snippet: row.content,
          }));
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ query, count: results.length, results }),
            },
          ],
        };
      } catch (err) {
        return toolError(`search_web failed: ${errorMessage(err)}`);
      }
    },
  };
  return tool;
}
