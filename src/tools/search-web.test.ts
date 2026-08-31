import { describe, expect, test } from "bun:test";
import { type AgentToolResult, type ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { Server } from "bun";
import { searchWebArgsSchema, searchWebToolDefinition } from "./search-web";

const NONE_CTX = {} as ExtensionContext;

function resultText(result: AgentToolResult): string {
  const content = result.content[0];
  if (content?.type !== "text") throw new Error("expected a text tool result");
  return content.text;
}

interface SearchStubHarness {
  server: Server<undefined>;
  baseUrl: string;
  requests: URL[];
  cleanup: () => void;
}

function stubSearchProvider(responder: (request: Request) => Response | Promise<Response>): SearchStubHarness {
  const requests: URL[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      requests.push(url);
      if (url.pathname !== "/search") return Response.json({ error: "not found" }, { status: 404 });
      return responder(request);
    },
  });
  return {
    server,
    baseUrl: `http://127.0.0.1:${server.port}`,
    requests,
    cleanup: () => server.stop(true),
  };
}

function jsonProvider(body: unknown, status = 200): SearchStubHarness {
  return stubSearchProvider(() => Response.json(body, { status }));
}

function toolHarness(h: SearchStubHarness) {
  return searchWebToolDefinition({ baseUrl: h.baseUrl });
}

describe("search_web registration", () => {
  test("registers as a read-tier tool with search-selection guidance", () => {
    const tool = searchWebToolDefinition({ fetch: async () => new Response() });
    expect(tool.name).toBe("search_web");
    expect(tool.approval).toBe("read");
    expect(tool.description).toContain("current");
    expect(tool.description).toContain("external");
    expect(tool.description).toContain("research");
    expect(tool.description).toContain("news");
    expect(tool.description).toContain("comparison");
    expect(tool.description).toContain("repository-local");
  });

  test("the args schema accepts a query and an optional capped max_results", () => {
    expect(searchWebArgsSchema.safeParse({ query: "bottega" }).success).toBe(true);
    expect(searchWebArgsSchema.safeParse({ query: "bottega", max_results: 3 }).success).toBe(true);
    expect(searchWebArgsSchema.safeParse({ query: "" }).success).toBe(false);
    expect(searchWebArgsSchema.safeParse({ query: "x", max_results: 0 }).success).toBe(false);
    expect(searchWebArgsSchema.safeParse({ query: "x", max_results: 11 }).success).toBe(false);
  });
});

describe("search_web SearXNG client", () => {
  test("uses a keyless GET request and preserves the cited result shape", async () => {
    const h = jsonProvider({
      results: [
        {
          title: "SearXNG documentation",
          url: "https://docs.searxng.org/",
          content: "A self-hosted metasearch engine",
        },
      ],
    });
    try {
      const result = await toolHarness(h).execute(
        "tc1",
        { query: "bottega search" },
        undefined,
        undefined,
        NONE_CTX,
      );
      expect(result.isError).not.toBe(true);
      expect(JSON.parse(resultText(result))).toEqual({
        query: "bottega search",
        count: 1,
        results: [
          {
            title: "SearXNG documentation",
            url: "https://docs.searxng.org/",
            snippet: "A self-hosted metasearch engine",
          },
        ],
      });
      expect(h.requests).toHaveLength(1);
      const request = h.requests[0]!;
      expect(request.pathname).toBe("/search");
      expect(request.searchParams.get("q")).toBe("bottega search");
      expect(request.searchParams.get("format")).toBe("json");
      expect(request.searchParams.get("categories")).toBe("general");
      expect(request.searchParams.get("safesearch")).toBe("1");
    } finally {
      h.cleanup();
    }
  });

  test("returns a valid empty result set", async () => {
    const h = jsonProvider({ results: [] });
    try {
      const result = await toolHarness(h).execute("tc1", { query: "nothing" }, undefined, undefined, NONE_CTX);
      expect(result.isError).not.toBe(true);
      expect(JSON.parse(resultText(result))).toEqual({ query: "nothing", count: 0, results: [] });
    } finally {
      h.cleanup();
    }
  });

  test("filters rows with empty URLs before mapping", async () => {
    const h = jsonProvider({
      results: [
        { title: "valid", url: "https://example.com/valid", content: "first" },
        { title: "missing", url: "   ", content: "discarded" },
        { title: "also valid", url: "https://example.com/also", content: "second" },
      ],
    });
    try {
      const result = await toolHarness(h).execute("tc1", { query: "urls" }, undefined, undefined, NONE_CTX);
      expect(result.isError).not.toBe(true);
      expect(JSON.parse(resultText(result))).toEqual({
        query: "urls",
        count: 2,
        results: [
          { title: "valid", url: "https://example.com/valid", snippet: "first" },
          { title: "also valid", url: "https://example.com/also", snippet: "second" },
        ],
      });
    } finally {
      h.cleanup();
    }
  });

  test("caps mapped results at max_results", async () => {
    const h = jsonProvider({
      results: Array.from({ length: 6 }, (_, index) => ({
        title: `result ${index}`,
        url: `https://example.com/${index}`,
        content: `content ${index}`,
      })),
    });
    try {
      const result = await toolHarness(h).execute("tc1", { query: "many", max_results: 3 }, undefined, undefined, NONE_CTX);
      expect(result.isError).not.toBe(true);
      const body = JSON.parse(resultText(result)) as { count: number; results: unknown[] };
      expect(body.count).toBe(3);
      expect(body.results).toHaveLength(3);
    } finally {
      h.cleanup();
    }
  });

  test("returns a bounded error for a non-2xx response", async () => {
    const h = jsonProvider({ error: "x".repeat(1_000) }, 503);
    try {
      const result = await toolHarness(h).execute("tc1", { query: "failure" }, undefined, undefined, NONE_CTX);
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain("503");
      expect(resultText(result).length).toBeLessThan(280);
    } finally {
      h.cleanup();
    }
  });

  test("fails closed on malformed JSON", async () => {
    const h = stubSearchProvider(() => new Response("not json", { headers: { "content-type": "application/json" } }));
    try {
      const result = await toolHarness(h).execute("tc1", { query: "bad json" }, undefined, undefined, NONE_CTX);
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain("unparseable");
    } finally {
      h.cleanup();
    }
  });

  test("fails closed on malformed result envelopes", async () => {
    for (const body of [{}, { results: "not an array" }]) {
      const h = jsonProvider(body);
      try {
        const result = await toolHarness(h).execute("tc1", { query: "bad envelope" }, undefined, undefined, NONE_CTX);
        expect(result.isError).toBe(true);
        expect(resultText(result)).toContain("unparseable");
      } finally {
        h.cleanup();
      }
    }
  });

  test("returns an error when the local SearXNG service is unreachable", async () => {
    const tool = searchWebToolDefinition({
      baseUrl: "http://127.0.0.1:1",
      fetch: async () => {
        throw new Error("connection refused");
      },
    });
    const result = await tool.execute("tc1", { query: "unreachable" }, undefined, undefined, NONE_CTX);
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("connection refused");
  });
});
