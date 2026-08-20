/**
 * search_web (issue #278): the first-party web-search tool with cited
 * sources. The agent queries a search-provider HTTP API and gets back
 * STRUCTURED results (title, url, snippet) that it renders as a table —
 * every claim carries the URL it came from.
 *
 * The credential rides the proxy key seam (issue #208), never the app:
 * the tool sends the placeholder bearer (`bottega-proxy-placeholder`) and
 * iron-proxy's `secrets` transform injects the real key from
 * `data/proxy-secrets/tavily.secret` (seeded at boot by the proxy
 * credential sync, src/extensions/proxy-seed) for the provider host
 * (api.tavily.com — a MODEL_GATEWAY_KEYS entry, require: true). Fail
 * closed: a missing/unseeded key makes the tool UNAVAILABLE (a clear
 * error) and NO network call happens — the tool checks the boundary file
 * exists before it fetches, so it never fabricates an empty result set.
 *
 * Read-tier: the policy table resolves it to read and the definition
 * carries `approval: "read"`.
 */
import type { AgentToolResult, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { z } from "@oh-my-pi/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PROXY_SECRETS_DIR } from "../extensions/boundary";
import { errorMessage, toolError } from "./helpers";

/** The search provider's provider id (matches the proxy secret file name). */
export const SEARCH_PROVIDER = "tavily";

/** The proxy placeholder every provider sends; iron-proxy swaps the real key at egress. */
const PROXY_PLACEHOLDER = "bottega-proxy-placeholder";

/** The default search provider endpoint (the proxy-injected host). */
const DEFAULT_SEARCH_BASE_URL = "https://api.tavily.com";

/** The provider's search path (the `search` operation maps to a POST). */
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

/** One result from the provider's JSON body (tavily's `results` shape, leniently parsed). */
const providerResultSchema = z.object({
  title: z.string().optional().default(""),
  url: z.string().optional().default(""),
  content: z.string().optional().default(""),
  snippet: z.string().optional().default(""),
});

/** The provider search body's `results` array (tavily). */
const providerSearchResponseSchema = z.object({
  results: z.array(providerResultSchema).optional().default(() => []),
});

export interface SearchWebToolOpts {
  /**
   * The search provider's base URL; hermetic tests point this at a local
   * stub search endpoint. Defaults to the live Tavily host.
   */
  baseUrl?: string;
  /**
   * The proxy-secrets directory the boot sync seeds; hermetic tests write
   * a stub key file here. Defaults to the repo boundary dir.
   */
  secretsDir?: string;
  /**
   * The outbound fetch seam; hermetic tests stub the provider response.
   * Defaults to global fetch (Bun's).
   */
  fetch?: typeof fetch;
}

/** The provider base URL (the injection seam's host) for a given opts set. */
export function searchBaseUrl(opts: SearchWebToolOpts = {}): string {
  return opts.baseUrl ?? DEFAULT_SEARCH_BASE_URL;
}

/** The proxy-secrets dir the tool checks for the seeded key (absolute). */
export function searchSecretsDir(opts: SearchWebToolOpts = {}): string {
  return opts.secretsDir ?? PROXY_SECRETS_DIR;
}

/**
 * Whether the Tavily key is seeded (its boundary file exists and is
 * non-empty). The tool never calls the provider without it (fail closed).
 */
export function searchKeySeeded(secretsDir: string): boolean {
  const path = join(secretsDir, `${SEARCH_PROVIDER}.secret`);
  if (!existsSync(path)) return false;
  try {
    return readFileSync(path, "utf8").trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * The search_web tool as an SDK {@link ToolDefinition} (issue #278): rides
 * the session toolset's gated custom-tools bridge like the work-item and
 * list_todos tools. Read-tier; fail-closed on a missing key.
 */
export function searchWebToolDefinition(opts: SearchWebToolOpts = {}): ToolDefinition {
  const baseUrl = searchBaseUrl(opts).replace(/\/+$/, "");
  const secretsDir = searchSecretsDir(opts);
  const doFetch = opts.fetch ?? fetch;
  const tool: ToolDefinition<typeof searchWebArgsSchema> = {
    name: "search_web",
    label: "Search the web with cited sources",
    description:
      "Runs a web search on a search-provider API and returns structured results — each with a title, " +
      "URL, and snippet. Read-only: use it to answer factual questions with CURRENT information, and ALWAYS " +
      "render the returned URLs next to each claim so every assertion carries its source. Returns at most " +
      "`max_results` (default 5, max 10) results. The provider key is injected by the proxy at egress from " +
      "a boot-seeded secret; if no key is configured the tool reports itself unavailable (never a fabricated " +
      "or empty result set).",
    parameters: searchWebArgsSchema,
    approval: "read",
    async execute(_toolCallId, params, _signal, _onUpdate): Promise<AgentToolResult> {
      if (!searchKeySeeded(secretsDir)) {
        return toolError(
          `search_web unavailable: no ${SEARCH_PROVIDER} key is seeded (` +
            `${join(secretsDir, `${SEARCH_PROVIDER}.secret`)} missing/empty). The proxy injects the key at ` +
            `egress; seed TAVILY_API_KEY at boot (data/proxy-secrets/${SEARCH_PROVIDER}.secret).`,
        );
      }
      const query = params.query.trim();
      const max = params.max_results ?? 5;
      if (!query) return toolError("search_web requires a non-empty query");
      try {
        const response = await doFetch(`${baseUrl}${SEARCH_PATH}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${PROXY_PLACEHOLDER}`,
          },
          body: JSON.stringify({
            // The provider key is injected by the proxy (send=the
            // placeholder); the body carries the query + cap only.
            query,
            max_results: max,
            search_depth: "basic",
          }),
        });
        if (!response.ok) {
          const detail = (await response.text().catch(() => "")).slice(0, 200);
          return toolError(
            `search_web provider returned ${response.status}${detail ? `: ${detail}` : ""}`,
          );
        }
        const parsed = providerSearchResponseSchema.safeParse(await response.json());
        if (!parsed.success) {
          return toolError(`search_web provider returned an unparseable body: ${errorMessage(parsed.error)}`);
        }
        const results = parsed.data.results.slice(0, max).map((r) => ({
          title: r.title,
          url: r.url,
          snippet: r.snippet || r.content,
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