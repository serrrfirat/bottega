import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createStore, type Store } from "../../store/db";
import { mountWorkReviewRoutes, WORK_REVIEW_COOKIE } from "./routes";

const root = mkdtempSync(join(tmpdir(), "bottega-work-review-routes-"));
const stores: Store[] = [];

afterAll(() => {
  for (const store of stores) store.close();
  rmSync(root, { recursive: true, force: true });
});

async function fixture() {
  const store = createStore(join(root, `${stores.length}.db`));
  stores.push(store);
  const space = await store.getOrCreateSpace({ platform: "slack", channel_id: "C359" });
  const item = await store.createWorkItem({ space_id: space.id, requester: "U1", description: "Review vendor retention terms", delivery: "git" });
  await store.claimWorkItemById(item.id, "worker");
  await store.transitionWorkItem(item.id, "claimed", "working", { by: "worker" });
  await store.transitionWorkItem(item.id, "working", "blocked", { by: "worker", evidence: "Please provide the retention period" });
  const token = store.createWorkReviewToken({ workItemId: item.id, slackTeamId: "T1", slackUserId: "U1", slackChannelId: "C359" }, Date.now() + 60_000);
  const posts: string[] = [];
  const routes = mountWorkReviewRoutes({
    store,
    transcriptDir: join(root, "transcripts"),
    adapter: {
      isChannelMember: async () => true,
      postMessage: async (_space, text) => { posts.push(text); return undefined; },
    },
  });
  return { store, item, token, routes, posts };
}

function cookieFrom(response: Response): string {
  const value = response.headers.get("set-cookie");
  expect(value).toContain(`${WORK_REVIEW_COOKIE}=`);
  return value!.split(";")[0]!;
}

describe("authenticated work-review routes", () => {
  test("redeems once, sets a protected cookie, renders plain sections, and continues", async () => {
    const { store, routes, token, posts } = await fixture();
    const redeem = await routes.fetch(new Request(`http://127.0.0.1/work-review/redeem/${token}`));
    expect(redeem.status).toBe(303);
    expect(redeem.headers.get("location")).toBe("/work-review");
    expect(redeem.headers.get("set-cookie")).toMatch(/Secure/);
    expect(redeem.headers.get("set-cookie")).toMatch(/HttpOnly/);
    expect(redeem.headers.get("set-cookie")).toMatch(/SameSite=Lax/);
    const cookie = cookieFrom(redeem);
    // A fresh route mount represents a process restart: the persisted session
    // remains usable and the page rotates its CSRF verifier.
    const restarted = mountWorkReviewRoutes({
      store,
      transcriptDir: join(root, "transcripts"),
      adapter: {
        isChannelMember: async () => true,
        postMessage: async (_space, text) => { posts.push(text); return undefined; },
      },
      log: console.error,
    });
    const page = await restarted.fetch(new Request("http://127.0.0.1/work-review", { headers: { cookie } }));
    const html = await page.text();
    expect(page.status).toBe(200);
    expect(html).toContain("What happened");
    expect(html).toContain("Work completed");
    expect(html).toContain("Still needed");
    expect(html).toContain("Full activity and technical details");
    expect(html).toContain('name="csrf"');
    const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1];
    expect(csrf).toBeString();
    const form = new URLSearchParams({ csrf: csrf!, guidance: "Use the retention schedule attached by Procurement." });
    const continued = await restarted.fetch(new Request("http://127.0.0.1/work-review/continue", { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: form }));
    expect(continued.status).toBe(200);
    expect(await continued.text()).toContain("This work was continued");
    expect(posts).toHaveLength(1);
  });

  test("rejects CSRF mismatch and removed members", async () => {
    const { routes, token } = await fixture();
    const redeem = await routes.fetch(new Request(`http://127.0.0.1/work-review/redeem/${token}`));
    const cookie = cookieFrom(redeem);
    const denied = await routes.fetch(new Request("http://127.0.0.1/work-review/continue", { method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: "csrf=wrong" }));
    expect(denied.status).toBe(403);
  });

  test("consumed token reveals no work details", async () => {
    const { routes, token } = await fixture();
    await routes.fetch(new Request(`http://127.0.0.1/work-review/redeem/${token}`));
    const replay = await routes.fetch(new Request(`http://127.0.0.1/work-review/redeem/${token}`));
    expect(replay.status).toBe(404);
    expect(await replay.text()).not.toContain("retention");
  });
});
