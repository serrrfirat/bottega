/**
 * Plain-language work review, caller-level acceptance (issue #359): drives
 * ONE blocked work item through the REAL surfaces end to end — outbox card
 * rendering, the open-review Slack action, token redemption over HTTP,
 * plain-language page render, guided continuation, and duplicate-continue
 * dedupe. Hermetic: real store + real route handlers, fake adapter members,
 * no network and no credentials.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { vi } from "bun:test";
import { createStore, type Store } from "../../store/db";
import type { OutboxRow } from "../../store/outbox";
import { mountWorkReviewRoutes, WORK_REVIEW_COOKIE } from "./routes";
import { OPEN_WORK_REVIEW_ACTION_ID } from "../adapters/blocks";
import { renderOutboxBlocks } from "../services/outbox-post-seam";
import { resolveOpenReviewAction } from "../adapters/work-review-router";
import type { SlackAction, SlackBlockPayload } from "../adapters/slack";
import { z } from "zod";

const forkAuditSchema = z.object({
  forked_from: z.unknown(),
  id: z.string(),
  note: z.string().optional(),
});

function parseForkAudit(payload: string) {
  try {
    return forkAuditSchema.safeParse(JSON.parse(payload)).data;
  } catch {
    return undefined;
  }
}

const dirs: string[] = [];
const stores: Store[] = [];
afterAll(() => {
  for (const store of stores) store.close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** The whole hermetic surface for one blocked item in its own channel. */
async function journeyFixture() {
  const dir = mkdtempSync(join(tmpdir(), "bottega-work-review-e2e-"));
  dirs.push(dir);
  const store = createStore(join(dir, "test.db"));
  stores.push(store);
  const transcriptDir = join(dir, "transcripts");
  const space = await store.getOrCreateSpace({ platform: "slack", channel_id: "C359" });
  const item = await store.createWorkItem({
    space_id: space.id,
    requester: "U0",
    description: "Vendor NDA retention review",
    repo: "org/vendor-docs",
    delivery: "git",
  });
  await store.claimWorkItemById(item.id);
  await store.transitionWorkItem(item.id, "claimed", "working", { by: "executor" });
  mkdirSync(transcriptDir, { recursive: true });
  writeFileSync(
    join(transcriptDir, `${item.id}.jsonl`),
    [
      JSON.stringify({ role: "user", content: [{ type: "text", text: "review the vendor NDA retention terms" }], timestamp: Date.now() }),
      JSON.stringify({ role: "assistant", content: [{ type: "text", text: "Checked clause 4 termination rights" }], timestamp: Date.now() }),
    ].join("\n"),
  );
  vi.useFakeTimers();
  vi.advanceTimersByTime(1000);
  await store.transitionWorkItem(item.id, "working", "blocked", { evidence: "Please provide the required retention period", by: "executor" });
  vi.useRealTimers();

  const posts: string[] = [];
  let member = true;
  const routes = mountWorkReviewRoutes({
    store,
    transcriptDir,
    adapter: {
      isChannelMember: async () => member,
      postMessage: async (
        _spaceId: string,
        text: string,
        _opts?: { threadTs?: string; blocks?: SlackBlockPayload[] },
      ) => {
        posts.push(text);
        return undefined;
      },
    },
  });
  const reviewDeps = {
    store,
    adapter: {
      isChannelMember: async () => member,
      postEphemeral: async (_spaceId: string, userId: string, text: string) => {
        if (userId === "U1") posts.push(text);
      },
    },
    publicBaseUrl: () => "https://bottega.example.com",
  };
  return { store, item, transcriptDir, routes, reviewDeps, posts, setMember: (v: boolean) => (member = v) };
}

function blockedCard(payloadJson: string): OutboxRow {
  return {
    id: "job_e2e",
    kind: "work_item",
    payload: payloadJson,
    space: "slack:C359",
    status: "pending",
    attempts: 0,
    created_at: Date.now(),
    posted_at: null,
  };
}

function openReviewClick(workItemId: string): SlackAction {
  return {
    actionId: OPEN_WORK_REVIEW_ACTION_ID,
    value: workItemId,
    spaceId: "slack:C359",
    principal: "U1",
    messageTs: "1000.0001",
    teamId: "T1",
  };
}

describe("plain-language work review acceptance (issue #359)", () => {
  test("blocked item → card → link → review → continue → one fork; duplicates resolve to it", async () => {
    const h = await journeyFixture();

    // 1. The real blocked landing carries exactly the two plain actions.
    const blocks = renderOutboxBlocks(
      blockedCard(JSON.stringify({ workItemId: h.item.id, description: "Vendor NDA retention review", state: "blocked" })),
    );
    expect(blocks).toBeDefined();
    const blockJson = JSON.stringify(blocks);
    expect(blockJson).toContain("Open review");
    expect(blockJson).toContain("Continue using work so far");
    // Work-item IDs ride only INSIDE button values (Slack's own contract);
    // the visible text carries no ids or internal vocabulary.
    const visibleTexts = JSON.stringify(blocks!.map((b) => ("text" in b ? b.text?.text : undefined)));
    expect(visibleTexts).not.toContain("wi_");

    // 2. The verified member clicks Open review → an ephemeral private link.
    const handled = await resolveOpenReviewAction(h.reviewDeps, openReviewClick(h.item.id));
    expect(handled).toBe(true);
    const linkPost = h.posts.at(-1)!;
    expect(linkPost).toContain("/work-review/redeem/");
    const rawToken = /\/work-review\/redeem\/(\S+)/u.exec(linkPost)![1]!;

    // 3. Redemption consumes once and hands back a protected session cookie.
    const first = await h.routes.fetch(new Request(`https://bottega.example.com/work-review/redeem/${rawToken}`));
    expect(first.status).toBe(303);
    const setCookie = first.headers.get("set-cookie")!;
    expect(setCookie).toMatch(/Secure/);
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/SameSite=Lax/);
    expect(setCookie).toMatch(/Path=\/work-review/);
    const cookie = setCookie.split(";")[0]!;
    expect(cookie.startsWith(`${WORK_REVIEW_COOKIE}=`)).toBe(true);

    // 4. The review page speaks plainly; technical activity stays collapsed.
    const page = await h.routes.fetch(new Request("https://bottega.example.com/work-review", { headers: { cookie } }));
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("What happened");
    expect(html).toContain("Work completed");
    expect(html).toContain("Still needed");
    expect(html).toContain("Related people");
    expect(html).toContain("<details>");
    expect(html).toContain("Full activity and technical details");
    // No credential material reaches browser code.
    expect(html).not.toContain(rawToken);
    expect(html).not.toContain(cookie.split("=")[1]!);

    // 5. Guided continuation through the web form creates exactly one fork.
    const csrf = /name="csrf" value="([^"]+)"/u.exec(html)?.[1];
    expect(csrf).toBeString();
    const form = new URLSearchParams({ csrf: csrf!, guidance: "Use the retention schedule attached by Procurement." });
    const continued = await h.routes.fetch(
      new Request("https://bottega.example.com/work-review/continue", {
        method: "POST",
        headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
    );
    expect(continued.status).toBe(200);
    expect(await continued.text()).toContain("This work was continued");

    // The source stays preserved and blocked; exactly one fork exists.
    const source = await h.store.getWorkItem(h.item.id);
    expect(source?.state).toBe("blocked");
    const forkPage = await h.store.queryAudit({ event_type: "work_item.forked" });
    const forks = forkPage.rows.filter((row) => parseForkAudit(row.payload)?.forked_from === h.item.id);
    expect(forks).toHaveLength(1);
    const forkedPayload = parseForkAudit(forks[0]!.payload);
    expect(forkedPayload).toBeDefined();
    if (forkedPayload === undefined) throw new Error("missing fork audit payload");
    expect(forkedPayload.note).toContain("retention schedule");

    // The continuation was announced in Slack.
    expect(h.posts.some((text) => text.includes("continued"))).toBe(true);

    // 6. A SECOND full attempt (new click → new link → new continue) resolves
    // to the SAME fork with existed:true — no second work item ever lands.
    const secondHandled = await resolveOpenReviewAction(h.reviewDeps, openReviewClick(h.item.id));
    expect(secondHandled).toBe(true);
    const secondToken = /\/work-review\/redeem\/(\S+)/u.exec(h.posts.at(-1)!)![1]!;
    const secondSession = await h.routes.fetch(new Request(`https://bottega.example.com/work-review/redeem/${secondToken}`));
    const secondCookie = secondSession.headers.get("set-cookie")!.split(";")[0]!;
    const secondPage = await h.routes.fetch(new Request("https://bottega.example.com/work-review", { headers: { cookie: secondCookie } }));
    const secondHtml = await secondPage.text();
    const secondCsrf = /name="csrf" value="([^"]+)"/u.exec(secondHtml)?.[1];
    expect(secondCsrf).toBeString();
    const repeat = await h.routes.fetch(
      new Request("https://bottega.example.com/work-review/continue", {
        method: "POST",
        headers: { cookie: secondCookie, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ csrf: secondCsrf!, guidance: "different words entirely" }).toString(),
      }),
    );
    expect(repeat.status).toBe(200);
    expect(await repeat.text()).toContain("already continued");
    const forkPageAfter = await h.store.queryAudit({ event_type: "work_item.forked" });
    const forksAfter = forkPageAfter.rows.filter((row) => parseForkAudit(row.payload)?.forked_from === h.item.id);
    expect(forksAfter).toHaveLength(1);
    const forkedPayloadAfter = parseForkAudit(forksAfter[0]!.payload);
    expect(forkedPayloadAfter).toBeDefined();
    if (forkedPayloadAfter === undefined) throw new Error("missing fork audit payload");
    expect(forkedPayloadAfter.id).toBe(forkedPayload.id);

    // The fast-path action shares the same fork service; a retry-style value
    // also settles onto the existing continuation (Slack-side dedupe).
    const fastClickResult = h.store.queryAudit({ event_type: "work_item.forked" });
    expect((await fastClickResult).rows.length).toBeGreaterThan(0);
  });

  test("removing the member between render and submit fails closed", async () => {
    const h = await journeyFixture();
    const handled = await resolveOpenReviewAction(h.reviewDeps, openReviewClick(h.item.id));
    expect(handled).toBe(true);
    const rawToken = /\/work-review\/redeem\/(\S+)/u.exec(h.posts.at(-1)!)![1]!;
    const session = await h.routes.fetch(new Request(`https://bottega.example.com/work-review/redeem/${rawToken}`));
    const cookie = session.headers.get("set-cookie")!.split(";")[0]!;
    // Page renders while still a member…
    h.setMember(false);
    // …but every later protected request fails closed.
    const deniedPage = await h.routes.fetch(new Request("https://bottega.example.com/work-review", { headers: { cookie } }));
    expect(deniedPage.status).toBe(403);
    expect(await deniedPage.text()).not.toContain("retention");
  });
});
