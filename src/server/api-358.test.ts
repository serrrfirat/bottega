/**
 * Timeline + fork REST routes (issue #358): end-to-end through the REAL
 * inbound surface — a real Bun.serve (the OAuth callback's), a real SQLite
 * store, and the real work-items projection/fork modules. Fails on any
 * pre-#358 tree: neither route exists there.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "bun:test";
import type { JsonValue } from "../memory/mem0";
import { createAudit, type AuditModule } from "../policy/audit";
import { createStore, type Store } from "../store/db";
import { startOAuthCallbackServer } from "../extensions/oauth-callback";
import { mountRestApi } from "./api";

const TOKEN = "test-timeline-fork-token";
process.env.BOTTEGA_API_TOKEN = TOKEN;

const dir = mkdtempSync(join(tmpdir(), "bottega-rest-358-"));
const stores: Store[] = [];
const surfaces: Array<ReturnType<typeof startOAuthCallbackServer>> = [];
afterAll(() => {
  for (const surface of surfaces) surface.stop();
  for (const store of stores) store.close();
  rmSync(dir, { recursive: true, force: true });
  delete process.env.BOTTEGA_API_TOKEN;
});

interface Harness {
  store: Store;
  audit: AuditModule;
  transcriptDir: string;
  baseUrl: string;
}

function freshHarness(): Harness {
  const store = freshStore();
  const audit = createAudit(store);
  const transcriptDir = join(dir, `transcripts-${stores.length}`);
  const savedCallbackPort = process.env.BOTTEGA_CALLBACK_PORT;
  process.env.BOTTEGA_CALLBACK_PORT = "0";
  const surface = startOAuthCallbackServer({
    store,
    audit,
    restApi: mountRestApi({ store, audit, transcriptDir }),
  });
  surfaces.push(surface);
  if (savedCallbackPort === undefined) delete process.env.BOTTEGA_CALLBACK_PORT;
  else process.env.BOTTEGA_CALLBACK_PORT = savedCallbackPort;
  return { store, audit, transcriptDir, baseUrl: surface.baseUrl };
}

function freshStore(): Store {
  const store = createStore(join(dir, `test-${stores.length}.db`));
  stores.push(store);
  return store;
}

function get(h: Harness, path: string): Promise<Response> {
  return fetch(`${h.baseUrl}${path}`, { headers: { authorization: `Bearer ${TOKEN}` } });
}

function post(h: Harness, path: string, body: Record<string, string | number | undefined>): Promise<Response> {
  return fetch(`${h.baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  });
}

async function auditRows(h: Harness, eventType: string): Promise<Array<Record<string, JsonValue>>> {
  const rows = await h.store.listAudit({ event_type: eventType });
  // SAFETY: audit payloads are written via JSON.stringify, so each parsed value is a JSON object.
  return rows.map((row) => JSON.parse(row.payload) as Record<string, JsonValue>);
}

/** Seeds a blocked git item with a transcript in space slack:C1. */
async function seedBlockedItem(h: Harness) {
  const space = await h.store.getOrCreateSpace({ platform: "slack", channel_id: "C1" });
  const item = await h.store.createWorkItem({
    space_id: space.id,
    requester: "U1",
    description: "ship the thing",
    repo: "acme/repo",
    delivery: "git",
  });
  await h.store.claimWorkItemById(item.id);
  await h.store.transitionWorkItem(item.id, "claimed", "working", { by: "executor" });
  mkdirSync(h.transcriptDir, { recursive: true });
  writeFileSync(
    join(h.transcriptDir, `${item.id}.jsonl`),
    [
      '{"type":"title","title":"session"}',
      `{"type":"message","message":{"content":"explore the repo"},"timestamp":"${new Date(item.created_at + 10).toISOString()}"}`,
      "",
    ].join("\n"),
  );
  vi.useFakeTimers();
  vi.advanceTimersByTime(1000);
  await h.store.transitionWorkItem(item.id, "working", "blocked", { evidence: "sandbox crashed", by: "executor" });
  await h.store.appendAudit({
    space_id: space.id,
    actor: "executor",
    event_type: "work_item.failed",
    payload: JSON.stringify({ id: item.id, error: "sandbox crashed" }),
  });
  vi.useRealTimers();
  return item;
}

describe("GET /api/v1/work-items/:id/timeline (issue #358)", () => {
  test("projects the seeded lifecycle in order and audits the read", async () => {
    const h = freshHarness();
    const item = await seedBlockedItem(h);

    const res = await get(h, `/api/v1/work-items/${item.id}/timeline`);
    expect(res.status).toBe(200);
    // SAFETY: the timeline read returns `{id, count, entries}` per the route
    // contract; each entry is a TimelineEntry JSON shape.
    const body = (await res.json()) as {
      id: string;
      count: number;
      entries: Array<{ at: number; kind: string; cause?: string; by?: string; runner?: string; summary?: string }>;
    };
    expect(body.id).toBe(item.id);
    expect(body.count).toBe(body.entries.length);
    expect(body.entries[0]).toMatchObject({ kind: "created", by: "U1" });
    expect(body.entries.map((e) => e.kind)).toContain("blocked");
    expect(body.entries.map((e) => e.kind)).toContain("turn");
    expect(body.entries.at(-1)).toMatchObject({ kind: "failed", cause: "sandbox crashed" });

    expect(await auditRows(h, "api.work_item_timeline")).toEqual([{ id: item.id, count: body.count }]);
  });

  test("unknown items are a fail-closed 404", async () => {
    const h = freshHarness();
    const res = await get(h, "/api/v1/work-items/wi_nope/timeline");
    expect(res.status).toBe(404);
    // SAFETY: error responses are `Response.json({error})` — a single-field object.
    expect(((await res.json()) as { error: string }).error).toContain("wi_nope");
  });

  test("a missing or bad token is a fail-closed 401", async () => {
    const h = freshHarness();
    const item = await seedBlockedItem(h);
    const denied = await fetch(`${h.baseUrl}/api/v1/work-items/${item.id}/timeline`);
    expect(denied.status).toBe(401);
  });
});

describe("POST /api/v1/work-items/:id/fork (issue #358)", () => {
  test("fork afterKind failed creates an audited fork; original untouched", async () => {
    const h = freshHarness();
    const source = await seedBlockedItem(h);

    const res = await post(h, `/api/v1/work-items/${source.id}/fork`, { afterKind: "failed", note: "retry" });
    expect(res.status).toBe(201);
    // SAFETY: the 201 body is `{id, state, forked_from}` per the route contract.
    const body = (await res.json()) as { id: string; state: string; forked_from: string };
    expect(body.forked_from).toBe(source.id);
    expect(body.state).toBe("open");

    const fork = await h.store.getWorkItem(body.id);
    expect(JSON.parse(fork!.fork_json!)).toMatchObject({ cause: "sandbox crashed", note: "retry", spanEnd: 2 });
    expect((await h.store.getWorkItem(source.id))!.state).toBe("blocked");
    expect(await auditRows(h, "api.work_item_forked")).toEqual([{ id: body.id, forked_from: source.id }]);
    // The store-level edge audit also landed on the fork's creation.
    expect(await auditRows(h, "work_item.forked")).toContainEqual(
      expect.objectContaining({ id: body.id, forked_from: source.id }),
    );
  });

  test("malformed bodies and ambiguous selectors are fail-closed 400s", async () => {
    const h = freshHarness();
    const source = await seedBlockedItem(h);

    for (const body of [
      {},
      { afterKind: "failed", atTimelineIndex: 0 },
      { afterKind: "completed" },
      { atTimelineIndex: -1 },
      { atTimelineIndex: 999 },
      { afterKind: "failed", note: "" },
    ]) {
      const res = await post(h, `/api/v1/work-items/${source.id}/fork`, body);
      expect(res.status).toBe(400);
    }
    // Nothing was created across all rejections.
    expect(await auditRows(h, "work_item.forked")).toHaveLength(0);
  });

  test("an out-of-range index on a real timeline is a 400, not a crash", async () => {
    const h = freshHarness();
    const source = await seedBlockedItem(h);
    const res = await post(h, `/api/v1/work-items/${source.id}/fork`, { atTimelineIndex: 999 });
    expect(res.status).toBe(400);
    // SAFETY: error responses are `Response.json({error})` — a single-field object.
    expect(((await res.json()) as { error: string }).error).toContain("out of range");
  });

  test("forking an unknown item is a 404", async () => {
    const h = freshHarness();
    const res = await post(h, "/api/v1/work-items/wi_nope/fork", { afterKind: "failed" });
    expect(res.status).toBe(404);
  });

  test("the OpenAPI document lists both new routes", async () => {
    const h = freshHarness();
    const res = await get(h, "/openapi.json");
    expect(res.status).toBe(200);
    // SAFETY: buildOpenApiJson emits a spec whose paths map to operation objects.
    const doc = (await res.json()) as { paths: { [path: string]: { summary: string } } };
    expect(Object.keys(doc.paths)).toContain("/api/v1/work-items/:id/timeline");
    expect(Object.keys(doc.paths)).toContain("/api/v1/work-items/:id/fork");
  });
});
