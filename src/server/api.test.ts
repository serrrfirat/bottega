/**
 * Token-authenticated REST API tests (issue #100): hermetic end-to-end
 * through the REAL inbound surface — a real Bun.serve (the OAuth callback's,
 * proving the REST surface joins it), a real SQLite store, and the real
 * audit module. Nothing touches the network, Slack, or a transcript. The
 * bearer token rides the boot-secret env var (`BOTTEGA_API_TOKEN`), read
 * live by the mount's default resolver.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue } from "../memory/mem0";
import { createAudit, type AuditModule } from "../policy/audit";
import { createStore, type Store } from "../store/db";
import { startOAuthCallbackServer } from "../extensions/oauth-callback";
import { mountRestApi } from "./api";
import {
  API_AUDIT_READ_EVENT,
  API_AUTH_DENIED_EVENT,
  API_SPACES_LISTED_EVENT,
  API_WORK_ITEM_CREATED_EVENT,
  API_WORK_ITEMS_LISTED_EVENT,
} from "../store/audit-events";

const TOKEN = "test-rest-api-token";
// The mount's default token resolver reads this env var (the boot-secret
// chain's seed target), so setting it exercises the real auth path.
process.env.BOTTEGA_API_TOKEN = TOKEN;

const dir = mkdtempSync(join(tmpdir(), "bottega-rest-api-"));
const stores: Store[] = [];
const surfaces: Array<ReturnType<typeof startOAuthCallbackServer>> = [];
afterAll(() => {
  for (const surface of surfaces) surface.stop();
  for (const store of stores) store.close();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.BOTTEGA_API_TOKEN;
});

function freshStore(): Store {
  const store = createStore(join(dir, `test-${stores.length}.db`));
  stores.push(store);
  return store;
}

interface Harness {
  store: Store;
  audit: AuditModule;
  baseUrl: string;
}

/** Fresh store + audit + a real REST surface on the callback's Bun.serve. */
function freshHarness(): Harness {
  const store = freshStore();
  const audit = createAudit(store);
  const savedCallbackPort = process.env.BOTTEGA_CALLBACK_PORT;
  process.env.BOTTEGA_CALLBACK_PORT = "0";
  const surface = startOAuthCallbackServer({
    store,
    audit,
    restApi: mountRestApi({ store, audit }),
  });
  surfaces.push(surface);
  if (savedCallbackPort === undefined) delete process.env.BOTTEGA_CALLBACK_PORT;
  else process.env.BOTTEGA_CALLBACK_PORT = savedCallbackPort;
  return { store, audit, baseUrl: surface.baseUrl };
}

function get(h: Harness, path: string, token: string | null = TOKEN): Promise<Response> {
  return fetch(`${h.baseUrl}${path}`, {
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
  });
}

function post(h: Harness, path: string, body: string, token: string | null = TOKEN): Promise<Response> {
  const headerPairs: Array<[string, string]> = [["content-type", "application/json"]];
  if (token !== null) headerPairs.push(["authorization", `Bearer ${token}`]);
  return fetch(`${h.baseUrl}${path}`, {
    method: "POST",
    headers: Object.fromEntries(headerPairs),
    body,
  });
}

async function auditRows(h: Harness, eventType: string): Promise<Array<Record<string, JsonValue>>> {
  const rows = await h.store.listAudit({ event_type: eventType });
  // SAFETY: audit payloads are written via JSON.stringify, so each parsed value is a JSON object.
  return rows.map((row) => JSON.parse(row.payload) as Record<string, JsonValue>);
}

describe("GET /api/v1/spaces (issue #100)", () => {
  test("with a valid token returns every space row and audits the read", async () => {
    const h = freshHarness();
    await h.store.getOrCreateSpace({ platform: "slack", channel_id: "C1" });
    await h.store.getOrCreateSpace({ platform: "slack", channel_id: "C2", name: "second" });

    const res = await get(h, "/api/v1/spaces");
    expect(res.status).toBe(200);
    // SAFETY: the spaces read is cast to a typed shape; the server returns
    // exactly these fields (id, channel_id, name) plus the full row columns.
    const body = (await res.json()) as { count: number; spaces: Array<{ id: string; channel_id: string; name: string | null }> };
    expect(body.count).toBe(2);
    expect(body.spaces.map((s) => s.id)).toEqual(["slack:C1", "slack:C2"]);
    expect(body.spaces[1]!.name).toBe("second");

    expect(await auditRows(h, API_SPACES_LISTED_EVENT)).toEqual([{ count: 2 }]);
    const denied = await auditRows(h, API_AUTH_DENIED_EVENT);
    expect(denied).toHaveLength(0);
  });
});

describe("GET /api/v1/work-items (issue #100)", () => {
  test("with a valid token returns the store rows, narrowable by space and status", async () => {
    const h = freshHarness();
    await h.store.getOrCreateSpace({ platform: "slack", channel_id: "C1" });
    await h.store.getOrCreateSpace({ platform: "slack", channel_id: "C2" });
    const item = await h.store.createWorkItem({ space_id: "slack:C1", requester: "U1", description: "ship the schema" });

    const all = await get(h, "/api/v1/work-items");
    expect(all.status).toBe(200);
    // SAFETY: the work-items read returns `{ count, items }` with each item
    // carrying id/space_id/state (plus the rest of the compact view).
    const allBody = (await all.json()) as { count: number; items: Array<{ id: string; space_id: string; state: string }> };
    expect(allBody.count).toBe(1);
    expect(allBody.items[0]!.id).toBe(item.id);
    expect(allBody.items[0]!.state).toBe("open");

    const bySpace = await get(h, "/api/v1/work-items?space=slack:C2");
    // SAFETY: the read body is a JSON object with a numeric `count` field.
    expect(((await bySpace.json()) as { count: number }).count).toBe(0);

    const byStatus = await get(h, "/api/v1/work-items?space=slack:C1&status=open");
    // SAFETY: the read body is a JSON object with a numeric `count` field.
    expect(((await byStatus.json()) as { count: number }).count).toBe(1);

    // An invalid status fails closed with 400, never a query.
    const bad = await get(h, "/api/v1/work-items?status=bogus");
    expect(bad.status).toBe(400);

    // Exactly the three SUCCESSFUL list reads are audited (the invalid-get
    // 400 short-circuits before the list audit).
    expect(await auditRows(h, API_WORK_ITEMS_LISTED_EVENT)).toHaveLength(3);
  });
});

describe("GET /api/v1/audit (issue #100)", () => {
  test("with a valid token returns filtered rows and audits the read (filters only)", async () => {
    const h = freshHarness();
    await h.audit.appendAudit({ actor: "U1", event_type: "policy.decision", payload: { tool: "a" } });
    await h.audit.appendAudit({ actor: "U1", event_type: "policy.decision", payload: { tool: "b" } });
    await h.audit.appendAudit({ actor: "U2", event_type: "extension.call", payload: { provider: "github" } });

    // `since` accepts an epoch-ms; limit clamps. All three decision rows match.
    const res = await get(h, "/api/v1/audit?event_type=policy.decision&limit=10");
    expect(res.status).toBe(200);
    // SAFETY: the audit read body has count/rows (each row carries
    // event_type/actor) and a nullable next_cursor; only the asserted
    // fields are consumed below.
    const body = (await res.json()) as {
      count: number;
      rows: Array<{ event_type: string; actor: string }>;
      next_cursor: unknown;
    };
    expect(body.count).toBe(2);
    expect(body.rows.map((r) => r.event_type)).toEqual(["policy.decision", "policy.decision"]);

    // The read is itself audited — filters only, never the results.
    const reads = await auditRows(h, API_AUDIT_READ_EVENT);
    expect(reads).toEqual([{ event_type: "policy.decision", limit: 10 }]);

    // The read's own row was appended AFTER the query, so it is not in the
    // returned page (the page had exactly 2 rows, both decision rows).
    expect(body.rows.every((r) => r.event_type === "policy.decision")).toBe(true);
  });

  test("malformed since / limit fail closed with 400", async () => {
    const h = freshHarness();
    expect((await get(h, "/api/v1/audit?since=abc")).status).toBe(400);
    expect((await get(h, "/api/v1/audit?limit=-5")).status).toBe(400);
  });
});

describe("POST /api/v1/work-items (issue #100)", () => {
  test("with a valid token creates an audited work item and returns 201", async () => {
    const h = freshHarness();
    await h.store.getOrCreateSpace({ platform: "slack", channel_id: "C1" });

    const res = await post(
      h,
      "/api/v1/work-items",
      JSON.stringify({
        space: "slack:C1",
        title: "ship the schema",
        body: "with details",
        repo: "acme/sandbox",
      }),
    );
    expect(res.status).toBe(201);
    // SAFETY: a successful create returns `{ id, state }` (both strings).
    const created = (await res.json()) as { id: string; state: string };
    expect(created.state).toBe("open");

    const item = await h.store.getWorkItem(created.id);
    expect(item).not.toBeNull();
    expect(item!.space_id).toBe("slack:C1");
    expect(item!.description).toBe("ship the schema\n\nwith details");
    expect(item!.repo).toBe("acme/sandbox");
    expect(item!.requester).toBe("api:default");

    expect(await auditRows(h, API_WORK_ITEM_CREATED_EVENT)).toEqual([{ id: created.id, requester: "api:default" }]);
  });

  test("fails closed on malformed input — nothing is created", async () => {
    const h = freshHarness();
    await h.store.getOrCreateSpace({ platform: "slack", channel_id: "C1" });

    // Malformed JSON.
    expect((await post(h, "/api/v1/work-items", "{not json")).status).toBe(400);
    // Missing title.
    expect((await post(h, "/api/v1/work-items", JSON.stringify({ space: "slack:C1" }))).status).toBe(400);
    // Missing space.
    expect((await post(h, "/api/v1/work-items", JSON.stringify({ title: "x" }))).status).toBe(400);
    // Empty repo when provided.
    expect((await post(h, "/api/v1/work-items", JSON.stringify({ space: "slack:C1", title: "x", repo: "  " }))).status).toBe(400);
    // Unknown space.
    expect((await post(h, "/api/v1/work-items", JSON.stringify({ space: "slack:nope", title: "x" }))).status).toBe(400);

    expect(await h.store.listWorkItems()).toHaveLength(0);
    expect(await auditRows(h, API_WORK_ITEM_CREATED_EVENT)).toHaveLength(0);
  });
});

describe("auth — bearer BOTTEGA_API_TOKEN (issue #100)", () => {
  test("a missing or bad token is a fail-closed 401, and the denial is audited", async () => {
    const h = freshHarness();

    // Missing token.
    const missing = await get(h, "/api/v1/spaces", null);
    expect(missing.status).toBe(401);

    // Bad token.
    const bad = await get(h, "/api/v1/spaces", "wrong-token");
    expect(bad.status).toBe(401);

    const denials = await auditRows(h, API_AUTH_DENIED_EVENT);
    expect(denials).toEqual([
      { method: "GET", path: "/api/v1/spaces" },
      { method: "GET", path: "/api/v1/spaces" },
    ]);
    // Every denial is attributed to the shared API actor.
    const rows = await h.store.listAudit({ event_type: API_AUTH_DENIED_EVENT });
    expect(rows.map((r) => r.actor)).toEqual(["api:default", "api:default"]);

    // The OpenAPI document is bearer-gated too.
    expect((await get(h, "/openapi.json", null)).status).toBe(401);
  });

  test("an unknown path is a bare 404, never audited (the surface fail-closed posture)", async () => {
    const h = freshHarness();
    expect((await get(h, "/api/v1/nope")).status).toBe(404);
    expect(await auditRows(h, API_AUTH_DENIED_EVENT)).toHaveLength(0);
  });
});

describe("GET /openapi.json (issue #100)", () => {
  test("with a valid token returns OpenAPI 3.1 JSON listing every API route", async () => {
    const h = freshHarness();
    const res = await get(h, "/openapi.json");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");

    // SAFETY: the OpenAPI body is the generated 3.1 document; the paths map
    // (keyed by path) and bearerAuth security scheme are asserted below.
    const doc = (await res.json()) as {
      openapi: string;
      info: { title: string };
      paths: object;
      components: {
        securitySchemes: {
          bearerAuth: { type: string; scheme: string; bearerFormat: string };
        };
      };
    };
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.info.title).toBe("Bottega REST API");

    // All four API routes are listed (openapi.json itself is not an operation).
    const paths = Object.keys(doc.paths).sort();
    expect(paths).toEqual(["/api/v1/audit", "/api/v1/spaces", "/api/v1/work-items"].sort());
    expect(doc.components.securitySchemes.bearerAuth).toEqual({
      type: "http",
      scheme: "bearer",
      bearerFormat: "opaque",
    });
  });
});