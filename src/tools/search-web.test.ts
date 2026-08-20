/**
 * search_web tests (issue #278): the read-tier cited-search tool. Hermetic:
 * the search provider is a LOCAL double served on a temp-dir-backed HTTP
 * stub (Bun.serve), and the boot-seeded provider key is a stub secret file
 * written into a temp proxy-secrets dir — no real network, no live key.
 * The tool fails closed when no key is seeded (never a fabricated result
 * set) and posts the structured result shape the agent renders as a table.
 */
import { describe, expect, test } from "bun:test";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";
import { searchWebArgsSchema, searchWebToolDefinition, SEARCH_PROVIDER, searchKeySeeded } from "./search-web";

interface SearchStubHarness {
  dir: string;
  server: Server<undefined>;
  baseUrl: string;
  requests: Array<{ path: string; auth: string | null; body: unknown }>;
  cleanup: () => void;
}

/** Spins up a local double of the search provider + a temp secrets dir. */
function stubSearchProvider(): SearchStubHarness {
  const dir = mkdtempSync(join(tmpdir(), "bottega-search-web-"));
  const requests: SearchStubHarness["requests"] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body = (await req.json().catch(() => null)) as unknown;
      requests.push({
        path: url.pathname,
        auth: req.headers.get("authorization"),
        body,
      });
      if (url.pathname !== "/search") {
        return Response.json({ error: "not found" }, { status: 404 });
      }
      // A generic search JSON shape the tool accepts (title/url/snippet or
      // title/url/content), independent of the live provider.
      return Response.json({
        results: [
          {
            title: "Bottega — the agent harness",
            url: "https://example.com/bottega",
            content: "Bottega is the Oh My Pi coding harness.",
          },
          {
            title: "Proxy seam docs",
            url: "https://example.com/proxy-seam",
            snippet: "Static provider secrets ride the proxy key seam.",
          },
          { title: "Third result", url: "https://example.com/third", content: "A third sited claim." },
        ],
      });
    },
  });
  return {
    dir,
    server,
    baseUrl: `http://127.0.0.1:${server.port}`,
    requests,
    cleanup: () => {
      server.stop(true);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Writes the boot-seeded provider key file into the temp secrets dir. */
function seedKey(dir: string): void {
  mkdirSync(join(dir, "secrets"), { recursive: true });
  writeFileSync(join(dir, "secrets", `${SEARCH_PROVIDER}.secret`), "tvly-stub-key", { mode: 0o600 });
}

function toolHarness(h: SearchStubHarness) {
  return searchWebToolDefinition({
    baseUrl: h.baseUrl,
    secretsDir: join(h.dir, "secrets"),
  });
}

// The tool never touches ctx (stateless, read-only); a minimal stub satisfies the SDK type.
const NONE_CTX = {} as ExtensionContext;

describe("search_web registration", () => {
  test("registers as a read-tier tool named search_web (NOT the reserved web_search)", () => {
    const h = stubSearchProvider();
    try {
      seedKey(h.dir);
      const tool = toolHarness(h);
      expect(tool.name).toBe("search_web");
      expect(tool.approval).toBe("read");
      expect(tool.label.length).toBeGreaterThan(0);
      expect(tool.description).toContain("source");
      expect(tool.description).toContain("each claim");
    } finally {
      h.cleanup();
    }
  });

  test("the args schema accepts a query and an optional capped max_results", () => {
    expect(searchWebArgsSchema.safeParse({ query: "bottega" }).success).toBe(true);
    expect(searchWebArgsSchema.safeParse({ query: "bottega", max_results: 3 }).success).toBe(true);
    expect(searchWebArgsSchema.safeParse({ query: "" }).success).toBe(false);
    expect(searchWebArgsSchema.safeParse({ query: "x", max_results: 0 }).success).toBe(false);
    expect(searchWebArgsSchema.safeParse({ query: "x", max_results: 11 }).success).toBe(false);
  });
});

describe("search_web execution (hermetic, local double)", () => {
  test("returns structured cited results through the real tool path from a stubbed provider", async () => {
    const h = stubSearchProvider();
    try {
      seedKey(h.dir);
      const tool = toolHarness(h);
      const res = await tool.execute("tc1", { query: "bottega", max_results: 5 }, undefined, undefined, NONE_CTX);
      expect(res.isError).toBeFalsy();
      const parsed = JSON.parse((res.content[0] as { text: string }).text) as {
        query: string;
        count: number;
        results: Array<{ title: string; url: string; snippet: string }>;
      };
      expect(parsed.query).toBe("bottega");
      expect(parsed.count).toBe(3);
      expect(parsed.results).toHaveLength(3);
      // Every row carries its source URL — the shape the agent renders as a table.
      for (const row of parsed.results) {
        expect(row.title.length).toBeGreaterThan(0);
        expect(row.url).toMatch(/^https:\/\//);
        expect(row.snippet.length).toBeGreaterThan(0);
      }
      // The wire request reached the provider double and carried the proxy
      // placeholder bearer (the proxy swaps the real key at egress).
      expect(h.requests).toHaveLength(1);
      expect(h.requests[0].path).toBe("/search");
      expect(h.requests[0].auth).toBe("Bearer bottega-proxy-placeholder");
      expect((h.requests[0].body as { query: string; max_results: number }).query).toBe("bottega");
    } finally {
      h.cleanup();
    }
  });

  test("capes results to max_results", async () => {
    const h = stubSearchProvider();
    try {
      seedKey(h.dir);
      const tool = toolHarness(h);
      const res = await tool.execute("tc1", { query: "bottega", max_results: 2 }, undefined, undefined, NONE_CTX);
      expect(res.isError).toBeFalsy();
      const parsed = JSON.parse((res.content[0] as { text: string }).text) as { count: number };
      expect(parsed.count).toBe(2);
    } finally {
      h.cleanup();
    }
  });

  test("a missing/unseeded key FAILS CLOSED: a clear unavailable error, never a result set", async () => {
    const h = stubSearchProvider();
    try {
      // NOTE: do not seedKey — the secrets dir stays empty.
      const tool = toolHarness(h);
      const res = await tool.execute("tc1", { query: "bottega" }, undefined, undefined, NONE_CTX);
      expect(res.isError).toBe(true);
      expect((res.content[0] as { text: string }).text).toMatch(/unavailable/);
      expect((res.content[0] as { text: string }).text).toContain("tavily");
      // Fail closed: NO network call happened.
      expect(h.requests).toHaveLength(0);
    } finally {
      h.cleanup();
    }
  });

  test("searchKeySeeded reflects the boundary file presence", () => {
    const dir = mkdtempSync(join(tmpdir(), "bottega-search-seeded-"));
    try {
      expect(searchKeySeeded(dir)).toBe(false);
      mkdirSync(join(dir, "secrets"), { recursive: true });
      expect(searchKeySeeded(join(dir, "secrets"))).toBe(false);
      writeFileSync(join(dir, "secrets", "tavily.secret"), "kv", { mode: 0o600 });
      expect(searchKeySeeded(join(dir, "secrets"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a provider non-2xx surfaces a clear error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bottega-search-err-"));
    const server = Bun.serve({
      port: 0,
      fetch: () => Response.json({ error: "rate limited" }, { status: 429 }),
    });
    try {
      mkdirSync(join(dir, "secrets"), { recursive: true });
      writeFileSync(join(dir, "secrets", "tavily.secret"), "kv", { mode: 0o600 });
      const tool = searchWebToolDefinition({
        baseUrl: `http://127.0.0.1:${server.port}`,
        secretsDir: join(dir, "secrets"),
      });
      const res = await tool.execute("tc1", { query: "bottega" }, undefined, undefined, NONE_CTX);
      expect(res.isError).toBe(true);
      expect((res.content[0] as { text: string }).text).toContain("429");
    } finally {
      server.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});