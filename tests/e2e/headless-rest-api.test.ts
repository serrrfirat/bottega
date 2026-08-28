/**
 * Headless REST coverage for issue #363: authenticates the production API,
 * exercises every documented route, and verifies durable store/audit effects.
 */
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { bootHarness } from "./harness";
import { REST_ROUTES, AUTH_THROTTLE_MAX_PER_IP } from "../../src/server/api";
import {
  API_AUDIT_READ_EVENT,
  API_AUTH_DENIED_EVENT,
  API_WORK_ITEM_CREATED_EVENT,
  API_WORK_ITEM_FORKED_EVENT,
  API_WORK_ITEM_TIMELINE_EVENT,
  WORK_ITEM_TRANSITION_EVENT,
} from "../../src/store/audit-events";
import type { JsonObject } from "../../src/extensions/manifest";

type RestJson = JsonObject;

async function json(response: Response): Promise<RestJson> {
  const value = await response.json();
  const parsed = z.record(z.string(), z.unknown()).safeParse(value);
  if (!parsed.success) throw new Error("REST response was not a JSON object");
  // SAFETY: REST endpoint responses are JSON objects; the parser above rejects
  // null, arrays, and primitive response bodies before this domain projection.
  return parsed.data as RestJson;
}

describe("headless REST API (issue #363)", () => {
  test("covers routes, auth posture, filtering, projections, and audit effects", async () => {
    const h = await bootHarness({ headless: true, rest: { token: "test-token" }, modelTurns: [{ type: "text", text: "ack" }] });
    try {
      expect(h.rest).toBeDefined();
      const rest = h.rest!;
      const unauthorized = await fetch(`${rest.url}/api/v1/spaces`);
      expect(unauthorized.status).toBe(401);
      const wrong = await rest.request("/api/v1/spaces", { headers: { authorization: "Bearer wrong" } });
      expect(wrong.status).toBe(401);
      for (let i = 0; i < AUTH_THROTTLE_MAX_PER_IP - 2; i++) {
        const denied = await rest.request("/api/v1/spaces", { headers: { authorization: "Bearer wrong" } });
        expect(denied.status).toBe(401);
      }
      const throttled = await rest.request("/api/v1/spaces", { headers: { authorization: "Bearer wrong" } });
      expect(throttled.status).toBe(429);
      // Window reset is intentionally not tested: this suite avoids time-based waiting.

      const deniedRows = await h.store.queryAudit({ event_type: API_AUTH_DENIED_EVENT });
      expect(deniedRows.rows.length).toBeGreaterThan(0);
      expect(deniedRows.rows.every((row) => row.actor === "api:default")).toBe(true);

      const empty = await json(await rest.request("/api/v1/spaces"));
      expect(empty.count).toBe(0);
      await h.deliverMessage("C-HEADLESSOPS", "seed space");
      const spaces = await json(await rest.request("/api/v1/spaces"));
      expect(spaces.count).toBe(1);
      expect(Array.isArray(spaces.spaces)).toBe(true);
      // SAFETY: the REST spaces response declares `spaces` as a JSON array;
      // this assertion follows the preceding array-shape check.
      const space = (spaces.spaces as JsonObject[])[0]!;
      expect(z.string().safeParse(space.id).success).toBe(true);

      const created = await rest.request("/api/v1/work-items", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ space: "slack:C-HEADLESSOPS", title: "API item", body: "details" }),
      });
      expect(created.status).toBe(201);
      const createdBody = await json(created);
      expect(z.string().safeParse(createdBody.id).success).toBe(true);
      expect(createdBody.state).toBe("open");
      const itemId = String(createdBody.id);
      expect((await h.store.getWorkItem(itemId))?.description).toContain("details");
      expect((await h.store.queryAudit({ event_type: API_WORK_ITEM_CREATED_EVENT })).rows.length).toBe(1);

      const malformed = await rest.request("/api/v1/work-items", { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
      expect(malformed.status).toBe(400);
      const filtered = await json(await rest.request("/api/v1/work-items?status=open&space=slack:C-HEADLESSOPS"));
      expect(filtered.count).toBe(1);
      expect(Array.isArray(filtered.items)).toBe(true);
      expect((await rest.request("/api/v1/work-items?status=bogus")).status).toBe(400);

      await h.store.transitionWorkItem(itemId, "open", "claimed", { by: "tester" });
      await h.store.transitionWorkItem(itemId, "claimed", "working", { by: "tester" });
      await h.store.transitionWorkItem(itemId, "working", "review", { by: "tester", approval: { approver: "owner" } });
      await h.store.transitionWorkItem(itemId, "review", "done", { by: "tester", result: JSON.stringify({ pr_url: "https://example.test/pr/1", summary: "done" }) });
      const timeline = await json(await rest.request(`/api/v1/work-items/${itemId}/timeline`));
      expect(timeline.id).toBe(itemId);
      expect(Number(timeline.count)).toBeGreaterThan(0);
      expect((await h.store.queryAudit({ event_type: API_WORK_ITEM_TIMELINE_EVENT })).rows.length).toBe(1);

      const fork = await rest.request(`/api/v1/work-items/${itemId}/fork`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ atTimelineIndex: 0 }) });
      expect(fork.status).toBe(201);
      const forkBody = await json(fork);
      expect(z.string().safeParse(forkBody.id).success).toBe(true);
      expect(forkBody.forked_from).toBe(itemId);
      expect((await h.store.queryAudit({ event_type: API_WORK_ITEM_FORKED_EVENT })).rows.length).toBe(1);

      const graphEmpty = await json(await rest.request("/api/v1/graph"));
      expect(Array.isArray(graphEmpty.nodes)).toBe(true);
      const graph = await json(await rest.request("/api/v1/graph?space=slack:C-HEADLESSOPS"));
      expect(Number(graph.count)).toBeGreaterThan(0);

      const audit = await json(await rest.request("/api/v1/audit?limit=2"));
      expect(Number(audit.count)).toBeLessThanOrEqual(2);
      expect(Array.isArray(audit.rows)).toBe(true);
      expect((await h.store.queryAudit({ event_type: API_AUDIT_READ_EVENT })).rows.length).toBe(1);

      const openapiResponse = await rest.request("/openapi.json");
      expect(openapiResponse.status).toBe(200);
      const openapi = await json(openapiResponse);
      // SAFETY: the OpenAPI response declares `paths` as a JSON object; this
      // assertion follows the response parser's object-shape validation.
      const paths = openapi.paths as JsonObject;
      for (const route of REST_ROUTES) if (route.path.startsWith("/api/v1")) expect(paths[route.path]).toBeDefined();

      const before404 = (await h.store.queryAudit()).rows.length;
      expect((await rest.request("/not-a-route")).status).toBe(404);
      expect((await h.store.queryAudit()).rows.length).toBe(before404);
      expect((await h.store.queryAudit({ event_type: WORK_ITEM_TRANSITION_EVENT })).rows.length).toBeGreaterThan(0);
    } finally {
      h.cleanup();
    }
  });
});
