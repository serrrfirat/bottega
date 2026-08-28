/**
 * Issue #286 acceptance (probe tier): probeMcpEndpoint proves a candidate
 * hosted MCP endpoint actually speaks MCP — or is OAuth-gated — before
 * anything registers or pins. This file pins the probe's own contract
 * (the caller-level wiring lives in catalog-register / connect / admin):
 *
 *   - HTTP 200 + valid initialize result (SDK InitializeResultSchema) → `mcp`
 *   - HTTP 401 (or 403 error=insufficient_scope) + single valid Bearer
 *     WWW-Authenticate challenge (SDK extractWWWAuthenticateParams) →
 *     `oauth_challenge`
 *   - Everything else rejects fail-closed with bounded evidence: 404/405/
 *     other errors, missing/non-Bearer/malformed/duplicate challenges,
 *     HTML/non-JSON bodies, 202/SSE-only, timeout, network error,
 *     redirects, and non-https URLs.
 *   - The Gmail endpoint pair: /mcp/v1 passes, /mcp fails.
 *
 * Hermetic: every request goes through an injected fetchImpl — no network.
 */
import { describe, expect, test } from "bun:test";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { probeMcpEndpoint } from "./mcp-endpoint-probe";
import type { JsonObject } from "./manifest";
/** A valid initialize result the stub serves (the SDK's accepted wire shape). */
const INITIALIZE_RESULT = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  result: {
    protocolVersion: LATEST_PROTOCOL_VERSION,
    capabilities: { tools: {} },
    serverInfo: { name: "stub-mcp", version: "1.0.0" },
  },
});
const SSE_INITIALIZE_RESULT = `event: message\ndata: ${INITIALIZE_RESULT}\n\n`;

function sseMessage(data: string, event = "message"): string {
  return `event: ${event}\ndata: ${data}\n\n`;
}

/** One URL (or prefix) → a scripted response. */
interface Route {
  match: string;
  status: number;
  body?: string;
  headers?: Record<string, string>;
  /** When true, the stub hangs forever unless the signal aborts (timeout leg). */
  hang?: boolean;
}

const CHALLENGE_HEADERS = (resource: string) => ({
  "www-authenticate": `Bearer resource_metadata="${resource}", error="invalid_token"`,
});

/**
 * Routes requests by exact URL, then by longest prefix (so a `/mcp` route
 * never shadows a more specific `/mcp/v1` route). Every un-routed URL is
 * a 404 — fail closed.
 */
/** True when fetch delivered its input as a plain URL string (the probe's own calls do). */
function isUrlString(input: string | URL | Request): input is string {
  // String(x) boxes to a fresh object, so identity holds exactly for non-string inputs.
  return Object(input) !== input;
}

function routeFetch(routes: Route[]): typeof fetch {
  // SAFETY: the stub implements fetch's call contract (input, init?) => Promise<Response>.
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = isUrlString(input) ? input : input instanceof URL ? input.href : input.url;
    const exact = routes.find((r) => r.match === url);
    const route = exact ?? routes.filter((r) => url.startsWith(r.match)).sort((a, b) => b.match.length - a.match.length)[0];
    if (route === undefined) return new Response("", { status: 404 });
    if (route.hang === true) {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation timed out.", "TimeoutError"));
        });
      });
    }
    return new Response(route.body ?? "", {
      status: route.status,
      headers: route.headers,
    });
  }) as typeof fetch;
}

describe("probeMcpEndpoint — accepted verdicts", () => {
  test("HTTP 200 + a valid MCP initialize result → mcp", async () => {
    const verdict = await probeMcpEndpoint("https://mcp.linear.app/mcp", {
      fetchImpl: routeFetch([{ match: "https://mcp.linear.app/mcp", status: 200, body: INITIALIZE_RESULT, headers: { "content-type": "application/json" } }]),
    });
    expect(verdict).toMatchObject({ ok: true, kind: "mcp" });
    if (verdict.ok) expect(verdict.evidence).toContain("valid MCP initialize result");
  });

  test("HTTP 200 Exa-style text/event-stream initialize response → mcp", async () => {
    const verdict = await probeMcpEndpoint("https://mcp.exa.ai/mcp", {
      fetchImpl: routeFetch([
        {
          match: "https://mcp.exa.ai/mcp",
          status: 200,
          body: SSE_INITIALIZE_RESULT,
          headers: { "content-type": "text/event-stream" },
        },
      ]),
    });
    expect(verdict).toMatchObject({ ok: true, kind: "mcp" });
    if (verdict.ok) expect(verdict.evidence).toContain("valid MCP initialize result");
  });

  test("HTTP 401 + a single Bearer WWW-Authenticate challenge → oauth_challenge", async () => {
    const verdict = await probeMcpEndpoint("https://mcp.notion.com/mcp", {
      fetchImpl: routeFetch([
        { match: "https://mcp.notion.com/mcp", status: 401, headers: CHALLENGE_HEADERS("https://mcp.notion.com/.well-known/oauth-protected-resource/mcp") },
      ]),
    });
    expect(verdict).toMatchObject({ ok: true, kind: "oauth_challenge" });
  });

  test("HTTP 403 with error=insufficient_scope + Bearer challenge → oauth_challenge", async () => {
    const verdict = await probeMcpEndpoint("https://gmailmcp.googleapis.com/mcp/v1", {
      fetchImpl: routeFetch([
        {
          match: "https://gmailmcp.googleapis.com/mcp/v1",
          status: 403,
          headers: { "www-authenticate": `Bearer error="insufficient_scope"` },
        },
      ]),
    });
    expect(verdict).toMatchObject({ ok: true, kind: "oauth_challenge" });
  });
});

describe("probeMcpEndpoint — rejected verdicts (fail closed)", () => {
  test("HTTP 404 and 405 are rejected (no initialize, no challenge)", async () => {
    for (const status of [404, 405]) {
      const verdict = await probeMcpEndpoint(`https://mcp.linear.app/mcp`, {
        fetchImpl: routeFetch([{ match: "https://mcp.linear.app/mcp", status }]),
      });
      expect(verdict.ok, `status ${status}`).toBe(false);
      if (!verdict.ok) expect(verdict.evidence).toContain(`HTTP ${status}`);
    }
  });

  test("HTTP 401 without a WWW-Authenticate header is rejected", async () => {
    const verdict = await probeMcpEndpoint("https://mcp.linear.app/mcp", {
      fetchImpl: routeFetch([{ match: "https://mcp.linear.app/mcp", status: 401 }]),
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.evidence).toContain("without a WWW-Authenticate Bearer challenge");
  });

  test("a non-Bearer (Basic) challenge is rejected", async () => {
    const verdict = await probeMcpEndpoint("https://mcp.linear.app/mcp", {
      fetchImpl: routeFetch([
        { match: "https://mcp.linear.app/mcp", status: 401, headers: { "www-authenticate": 'Basic realm="mcp"' } },
      ]),
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.evidence).toContain("non-Bearer");
  });

  test("a malformed Bearer challenge (no usable auth params) is rejected", async () => {
    const verdict = await probeMcpEndpoint("https://mcp.linear.app/mcp", {
      fetchImpl: routeFetch([
        { match: "https://mcp.linear.app/mcp", status: 401, headers: { "www-authenticate": 'Bearer realm="mcp"' } },
      ]),
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.evidence).toContain("malformed Bearer");
  });

  test("duplicate WWW-Authenticate challenges are rejected", async () => {
    const verdict = await probeMcpEndpoint("https://mcp.linear.app/mcp", {
      fetchImpl: routeFetch([
        {
          match: "https://mcp.linear.app/mcp",
          status: 401,
          headers: { "www-authenticate": 'Bearer error="invalid_token", Basic realm="mcp"' },
        },
      ]),
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.evidence).toContain("duplicate WWW-Authenticate challenges");
  });

  test("HTTP 403 without error=insufficient_scope is rejected", async () => {
    const verdict = await probeMcpEndpoint("https://mcp.linear.app/mcp", {
      fetchImpl: routeFetch([
        { match: "https://mcp.linear.app/mcp", status: 403, headers: { "www-authenticate": 'Bearer error="insufficient_resource"' } },
      ]),
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.evidence).toContain("only insufficient_scope is accepted");
  });

  test("HTTP 200 with HTML content is rejected (landing page)", async () => {
    const verdict = await probeMcpEndpoint("https://mcp.linear.app/mcp", {
      fetchImpl: routeFetch([
        { match: "https://mcp.linear.app/mcp", status: 200, body: "<html><body>welcome</body></html>", headers: { "content-type": "text/html" } },
      ]),
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.evidence).toContain("HTML");
  });

  test("HTTP 200 with non-JSON content is rejected", async () => {
    const verdict = await probeMcpEndpoint("https://mcp.linear.app/mcp", {
      fetchImpl: routeFetch([{ match: "https://mcp.linear.app/mcp", status: 200, body: "not json at all" }]),
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.evidence).toContain("non-JSON");
  });

  test("HTTP 200 with text/event-stream content is rejected (SSE-only)", async () => {
    const verdict = await probeMcpEndpoint("https://mcp.linear.app/mcp", {
      fetchImpl: routeFetch([
        { match: "https://mcp.linear.app/mcp", status: 200, body: "event: message\ndata: {}\n\n", headers: { "content-type": "text/event-stream" } },
      ]),
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.evidence).toContain("SSE");
  });
  test("HTTP 200 text/event-stream with a malformed message payload is rejected", async () => {
    const verdict = await probeMcpEndpoint("https://mcp.linear.app/mcp", {
      fetchImpl: routeFetch([
        {
          match: "https://mcp.linear.app/mcp",
          status: 200,
          body: sseMessage("{"),
          headers: { "content-type": "text/event-stream" },
        },
      ]),
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.evidence).toContain("malformed");
  });

  test("HTTP 200 text/event-stream message without data is rejected", async () => {
    const verdict = await probeMcpEndpoint("https://mcp.linear.app/mcp", {
      fetchImpl: routeFetch([
        {
          match: "https://mcp.linear.app/mcp",
          status: 200,
          body: "event: message\n\n",
          headers: { "content-type": "text/event-stream" },
        },
      ]),
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.evidence).toContain("data");
  });

  test("HTTP 200 text/event-stream JSON-RPC error message is rejected", async () => {
    const verdict = await probeMcpEndpoint("https://mcp.linear.app/mcp", {
      fetchImpl: routeFetch([
        {
          match: "https://mcp.linear.app/mcp",
          status: 200,
          body: sseMessage(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "method not found" } })),
          headers: { "content-type": "text/event-stream" },
        },
      ]),
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.evidence).toContain("JSON-RPC error response");
  });

  test("HTTP 200 text/event-stream initialize message with the wrong id is rejected", async () => {
    // SAFETY: INITIALIZE_RESULT is this suite's own serialized JSON-RPC
    // object, and the probe validates its shape before accepting it.
    const wrongId = JSON.parse(INITIALIZE_RESULT) as JsonObject;
    wrongId.id = 2;
    const verdict = await probeMcpEndpoint("https://mcp.linear.app/mcp", {
      fetchImpl: routeFetch([
        {
          match: "https://mcp.linear.app/mcp",
          status: 200,
          body: sseMessage(JSON.stringify(wrongId)),
          headers: { "content-type": "text/event-stream" },
        },
      ]),
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.evidence).toContain("id");
  });

  test("HTTP 200 text/event-stream body over the response cap is rejected", async () => {
    const verdict = await probeMcpEndpoint("https://mcp.linear.app/mcp", {
      fetchImpl: routeFetch([
        {
          match: "https://mcp.linear.app/mcp",
          status: 200,
          body: sseMessage("x".repeat(300_000)),
          headers: { "content-type": "text/event-stream" },
        },
      ]),
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.evidence).toContain("exceeds");
  });

  test("HTTP 200 text/event-stream non-message events are rejected", async () => {
    const verdict = await probeMcpEndpoint("https://mcp.linear.app/mcp", {
      fetchImpl: routeFetch([
        {
          match: "https://mcp.linear.app/mcp",
          status: 200,
          body: sseMessage(INITIALIZE_RESULT, "update"),
          headers: { "content-type": "text/event-stream" },
        },
      ]),
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.evidence).toContain("event");
  });

  test("conflicting text/event-stream initialize messages are rejected", async () => {
    // SAFETY: the first value is parsed from the suite's valid initialize fixture.
    const first = JSON.parse(INITIALIZE_RESULT) as JsonObject;
    // SAFETY: the second value is parsed from the same valid initialize fixture.
    const second = JSON.parse(INITIALIZE_RESULT) as JsonObject;
    // SAFETY: the initialize fixture's result is a JSON object whose serverInfo
    // field is intentionally replaced to create the conflict under test.
    (second.result as JsonObject).serverInfo = { name: "other", version: "2" };
    const verdict = await probeMcpEndpoint("https://mcp.linear.app/mcp", {
      fetchImpl: routeFetch([
        {
          match: "https://mcp.linear.app/mcp",
          status: 200,
          body: `${sseMessage(JSON.stringify(first))}${sseMessage(JSON.stringify(second))}`,
          headers: { "content-type": "text/event-stream" },
        },
      ]),
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.evidence).toContain("multiple");
  });

  test("HTTP 202 is rejected (SSE/streaming accept signal, no initialize result)", async () => {
    const verdict = await probeMcpEndpoint("https://mcp.linear.app/mcp", {
      fetchImpl: routeFetch([{ match: "https://mcp.linear.app/mcp", status: 202 }]),
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.evidence).toContain("HTTP 202");
  });

  test("HTTP 200 with a JSON-RPC error response is rejected (no result)", async () => {
    const verdict = await probeMcpEndpoint("https://mcp.linear.app/mcp", {
      fetchImpl: routeFetch([
        { match: "https://mcp.linear.app/mcp", status: 200, body: JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "method not found" } }) },
      ]),
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.evidence).toContain("JSON-RPC error response");
  });

  test("HTTP 200 with a JSON body lacking an initialize result is rejected", async () => {
    const verdict = await probeMcpEndpoint("https://mcp.linear.app/mcp", {
      fetchImpl: routeFetch([{ match: "https://mcp.linear.app/mcp", status: 200, body: JSON.stringify({ ok: true }) }]),
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.evidence).toContain("no initialize result");
  });

  test("HTTP 200 with an invalid initialize result (missing serverInfo) is rejected", async () => {
    const verdict = await probeMcpEndpoint("https://mcp.linear.app/mcp", {
      fetchImpl: routeFetch([
        {
          match: "https://mcp.linear.app/mcp",
          status: 200,
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: { tools: {} } } }),
        },
      ]),
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.evidence).toContain("initialize result is invalid");
  });

  test("HTTP 200 with an unsupported protocol version is rejected", async () => {
    const verdict = await probeMcpEndpoint("https://mcp.linear.app/mcp", {
      fetchImpl: routeFetch([
        {
          match: "https://mcp.linear.app/mcp",
          status: 200,
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { protocolVersion: "1999-01-01", capabilities: {}, serverInfo: { name: "stub", version: "1" } },
          }),
        },
      ]),
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.evidence).toContain("not supported");
  });

  test("a timeout is rejected with the wall-clock bound (AbortSignal.timeout honored)", async () => {
    const verdict = await probeMcpEndpoint("https://mcp.linear.app/mcp", {
      timeoutMs: 50,
      fetchImpl: routeFetch([{ match: "https://mcp.linear.app/mcp", status: 200, hang: true }]),
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.evidence).toContain("timed out after 50ms");
  });

  test("a network error is rejected with the error evidence", async () => {
    // SAFETY: the throwing stub implements fetch's call contract (input, init?)
    // => Promise<Response>; its never-resolving body is the deliberate shape
    // the probe must reject, and preconnect is never invoked by the probe.
    const throwing: typeof fetch = Object.assign(
      (_input: string | URL | Request, _init?: RequestInit) => {
        throw new Error("connection refused");
      },
      { preconnect: () => {} },
    );
    const verdict = await probeMcpEndpoint("https://mcp.linear.app/mcp", { fetchImpl: throwing });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.evidence).toContain("network error");
  });

  test("a redirect is rejected and the redirect target is never contacted", async () => {
    let targetHits = 0;
    // SAFETY: the stub implements fetch's call contract (input, init?) => Promise<Response>.
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = isUrlString(input) ? input : input instanceof URL ? input.href : input.url;
      if (url === "https://mcp.linear.app/mcp") {
        if ((init?.redirect ?? "follow") !== "error") throw new Error("the probe must never follow redirects");
        return new Response("moved", { status: 301, headers: { location: "https://evil.example/mcp" } });
      }
      targetHits += 1;
      return new Response("", { status: 404 });
    }) as typeof fetch;
    const verdict = await probeMcpEndpoint("https://mcp.linear.app/mcp", { fetchImpl });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.evidence).toContain("redirect");
    expect(targetHits).toBe(0); // the redirect target was never contacted
  });

  test("a non-https URL is refused outright — never probed", async () => {
    let probed = false;
    // SAFETY: the no-param stub implements fetch's call contract (its ignored
    // input/init still arrive as arguments at runtime); preconnect is never
    // invoked because the probe refuses non-https URLs before fetching.
    const fetchImpl: typeof fetch = Object.assign(
      async () => {
        probed = true;
        return new Response("", { status: 200 });
      },
      { preconnect: () => {} },
    );
    const verdict = await probeMcpEndpoint("http://mcp.linear.app/mcp", { fetchImpl });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.evidence).toContain("must be https");
    expect(probed).toBe(false);
  });

  test("an invalid URL is rejected", async () => {
    const verdict = await probeMcpEndpoint("not a url", {});
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.evidence).toContain("invalid URL");
  });
});

describe("Gmail endpoint pair (issue #286 §7) — /mcp/v1 passes, /mcp fails", () => {
  test("https://gmailmcp.googleapis.com/mcp/v1 is a valid MCP endpoint", async () => {
    const verdict = await probeMcpEndpoint("https://gmailmcp.googleapis.com/mcp/v1", {
      fetchImpl: routeFetch([
        { match: "https://gmailmcp.googleapis.com/mcp/v1", status: 200, body: INITIALIZE_RESULT, headers: { "content-type": "application/json" } },
      ]),
    });
    expect(verdict).toMatchObject({ ok: true, kind: "mcp" });
  });

  test("https://gmailmcp.googleapis.com/mcp (the broken pin) is rejected", async () => {
    const verdict = await probeMcpEndpoint("https://gmailmcp.googleapis.com/mcp", {
      fetchImpl: routeFetch([{ match: "https://gmailmcp.googleapis.com/mcp", status: 404 }]),
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.evidence).toContain("HTTP 404");
  });
});
