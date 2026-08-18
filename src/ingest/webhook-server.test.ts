/**
 * Webhook ingest route tests (issue #57): hermetic end-to-end through the
 * REAL handler + the SHARED dispatcher — a real SQLite store, the real
 * audit module, a recording postMessage seam, and a real Bun.serve surface
 * (the OAuth callback's, proving the webhook route joins it). Nothing
 * touches the network, GitHub, or Slack.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue } from "../memory/mem0";
import { createAudit } from "../policy/audit";
import { INGEST_WEBHOOK_DISPATCH_EVENT, INGEST_WEBHOOK_REJECTED_EVENT, WORK_ITEM_CREATED_EVENT } from "../store/audit-events";
import { createStore, type Store } from "../store/db";
import { startOAuthCallbackServer } from "../extensions/oauth-callback";
import { handleWebhookRequest, type WebhookRouteDeps } from "./webhook-server";
import { MAX_COMMENT_BODY_CHARS } from "./github/payload";
import { verifyGitHubSignature } from "./github/webhook";

const dir = mkdtempSync(join(tmpdir(), "bottega-ingest-webhook-"));
const stores: Store[] = [];
afterAll(() => {
  for (const store of stores) store.close();
  rmSync(dir, { recursive: true, force: true });
});

const SECRET = "gh-webhook-shared-secret";

function freshStore(): Store {
  const store = createStore(join(dir, `test-${stores.length}.db`));
  stores.push(store);
  return store;
}

/** A mention comment (issue #57): the canonical GitHub webhook shape. */
function mentionBody(overrides: Record<string, JsonValue | undefined> = {}): string {
  return JSON.stringify({
    action: "created",
    comment: {
      body: "Hey @bottega can you look at this",
      html_url: "https://github.com/serrrfirat/bottega/issues/12#issuecomment-1",
      created_at: "2026-08-18T00:00:00Z",
    },
    sender: { login: "alice" },
    repository: {
      full_name: "serrrfirat/bottega",
      html_url: "https://github.com/serrrfirat/bottega",
    },
    issue: {
      number: 12,
      html_url: "https://github.com/serrrfirat/bottega/issues/12",
      title: "Fix the thing",
    },
    ...overrides,
  });
}

function signature(rawBody: string, secret: string = SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(rawBody, "utf8").digest("hex")}`;
}

function post(
  rawBody: string,
  opts: { path?: string; secret?: string; event?: string; contentLength?: number } = {},
): Promise<Response> {
  const path = opts.path ?? "/webhooks/github";
  const headers = {
    "content-type": "application/json",
    "x-hub-signature-256": signature(rawBody, opts.secret ?? SECRET),
    ...(opts.event !== undefined ? { "x-github-event": opts.event } : undefined),
    ...(opts.contentLength !== undefined ? { "content-length": String(opts.contentLength) } : undefined),
  } satisfies Record<string, string>;
  return handleWebhookRequest(new Request(`http://127.0.0.1${path}`, { method: "POST", headers, body: rawBody }), deps());
}

interface Harness {
  store: Store;
  deps: WebhookRouteDeps;
  posts: Array<{ spaceId: string; text: string }>;
}

const harnesses: Harness[] = [];

function deps(overrides: Partial<WebhookRouteDeps> = {}): WebhookRouteDeps {
  const harness = harnesses[harnesses.length - 1]!;
  return { ...harness.deps, ...overrides };
}

/** Fresh store + space + recording post seam for each test. */
function freshHarness(): Harness {
  const store = freshStore();
  const posts: Array<{ spaceId: string; text: string }> = [];
  const harness: Harness = {
    store,
    deps: {
      store,
      audit: createAudit(store),
      postMessage: async (spaceId, text) => {
        posts.push({ spaceId, text });
        return "ts-1";
      },
      spaceId: "slack:C1",
      secretFor: (provider) => (provider === "github" ? SECRET : undefined),
    },
    posts,
  };
  harnesses.push(harness);
  return harness;
}

async function auditPayloads(store: Store, eventType: string): Promise<Record<string, JsonValue>[]> {
  const rows = await store.listAudit({ event_type: eventType });
  // SAFETY: audit payloads are written via JSON.stringify, so the parsed value is a JSON object.
  return rows.map((row) => JSON.parse(row.payload) as Record<string, JsonValue>);
}

describe("webhook route — dispatch on a valid mention (issue #57)", () => {
  test("signature ok + mention payload → work item + Slack post + dispatch audit", async () => {
    const h = freshHarness();
    await h.store.getOrCreateSpace({ platform: "slack", channel_id: "C1" });

    const res = await post(mentionBody());
    expect(res.status).toBe(200);

    // The SHARED dispatch created the work item through the store's existing path.
    expect(await auditPayloads(h.store, WORK_ITEM_CREATED_EVENT)).toHaveLength(1);
    const created = await h.store.listAudit({ event_type: WORK_ITEM_CREATED_EVENT });
    expect(JSON.parse(created[0]!.payload)).toEqual({
      id: expect.any(String),
      requester: "ingest:github",
      assignee: "ingest:github",
    });
    // …and the item row exists with the mention's evidence.
    // SAFETY: WORK_ITEM_CREATED_EVENT rows carry the created item's id (see src/store/db.ts).
    const itemId = (JSON.parse(created[0]!.payload) as { id: string }).id;
    const item = await h.store.getWorkItem(itemId);
    expect(item).not.toBeNull();
    expect(item!.space_id).toBe("slack:C1");
    expect(item!.delivery).toBe("extension");
    expect(item!.repo).toBe("serrrfirat/bottega");
    expect(JSON.parse(item!.evidence)).toEqual([
      { kind: "issue_url", url: "https://github.com/serrrfirat/bottega/issues/12", at: expect.any(Number) },
    ]);

    // The org-channel post went through the existing Slack post seam.
    expect(h.posts).toEqual([
      {
        spaceId: "slack:C1",
        text: "GitHub mention: Fix the thing (serrrfirat/bottega#12) — https://github.com/serrrfirat/bottega/issues/12",
      },
    ]);

    // The webhook dispatch audit row (the shared dispatcher wrote it, leg=webhook).
    const dispatched = await auditPayloads(h.store, INGEST_WEBHOOK_DISPATCH_EVENT);
    expect(dispatched).toEqual([
      {
        provider: "github",
        event_type: "mention",
        url: "https://github.com/serrrfirat/bottega/issues/12",
        work_item_id: itemId,
        space_id: "slack:C1",
      },
    ]);
    expect(await auditPayloads(h.store, INGEST_WEBHOOK_REJECTED_EVENT)).toHaveLength(0);
  });

  test("a PR mention normalizes to the pull_request target", async () => {
    const h = freshHarness();
    await h.store.getOrCreateSpace({ platform: "slack", channel_id: "C1" });

    const body = mentionBody({
      issue: undefined,
      pull_request: {
        number: 57,
        html_url: "https://github.com/serrrfirat/bottega/pull/57",
        title: "Ingest framework",
      },
    });
    const res = await post(body);
    expect(res.status).toBe(200);
    expect(h.posts[0]!.text).toBe(
      "GitHub mention: Ingest framework (serrrfirat/bottega#57) — https://github.com/serrrfirat/bottega/pull/57",
    );
  });

  test("GitHub's ping probe is acknowledged, never dispatched", async () => {
    const h = freshHarness();
    const res = await post(JSON.stringify({ zen: "hi", hook_id: 1 }), { event: "ping" });
    expect(res.status).toBe(200);
    expect(h.posts).toHaveLength(0);
    expect(await auditPayloads(h.store, WORK_ITEM_CREATED_EVENT)).toHaveLength(0);
    expect(await auditPayloads(h.store, INGEST_WEBHOOK_REJECTED_EVENT)).toHaveLength(0);
  });

  test("a valid comment that does not @mention the bot is acknowledged, never dispatched", async () => {
    const h = freshHarness();
    const res = await post(mentionBody({ comment: { ...JSON.parse(mentionBody()).comment, body: "just a comment" } }));
    expect(res.status).toBe(200);
    expect(h.posts).toHaveLength(0);
    expect(await auditPayloads(h.store, WORK_ITEM_CREATED_EVENT)).toHaveLength(0);
    expect(await auditPayloads(h.store, INGEST_WEBHOOK_REJECTED_EVENT)).toHaveLength(0);
  });

  test("an edited/deleted comment is acknowledged, never dispatched", async () => {
    const h = freshHarness();
    const res = await post(mentionBody({ action: "edited" }));
    expect(res.status).toBe(200);
    expect(h.posts).toHaveLength(0);
    expect(await auditPayloads(h.store, WORK_ITEM_CREATED_EVENT)).toHaveLength(0);
  });

  test("the comment body is bounded (truncated) before dispatch", async () => {
    const h = freshHarness();
    await h.store.getOrCreateSpace({ platform: "slack", channel_id: "C1" });
    const longBody = `@bottega ${"x".repeat(MAX_COMMENT_BODY_CHARS * 2)}`;
    const res = await post(mentionBody({ comment: { ...JSON.parse(mentionBody()).comment, body: longBody } }));
    expect(res.status).toBe(200);
    const created = await h.store.listAudit({ event_type: WORK_ITEM_CREATED_EVENT });
    expect(created).toHaveLength(1);
    // SAFETY: WORK_ITEM_CREATED_EVENT rows carry the created item's id (see src/store/db.ts).
    const item = await h.store.getWorkItem((JSON.parse(created[0]!.payload) as { id: string }).id);
    expect(item!.description.length).toBeLessThan(MAX_COMMENT_BODY_CHARS + 64);
  });
});

describe("webhook route — fail closed (issue #57)", () => {
  test("wrong signature → 401 + rejected audit + nothing dispatched", async () => {
    const h = freshHarness();
    await h.store.getOrCreateSpace({ platform: "slack", channel_id: "C1" });

    const res = await post(mentionBody(), { secret: "wrong-secret" });
    expect(res.status).toBe(401);
    expect(h.posts).toHaveLength(0);
    expect(await auditPayloads(h.store, WORK_ITEM_CREATED_EVENT)).toHaveLength(0);
    expect(await auditPayloads(h.store, INGEST_WEBHOOK_DISPATCH_EVENT)).toHaveLength(0);
    expect(await auditPayloads(h.store, INGEST_WEBHOOK_REJECTED_EVENT)).toEqual([
      { provider: "github", event_type: "unknown", reason: "signature_mismatch" },
    ]);
  });

  test("missing signature → 401 + rejected, nothing dispatched", async () => {
    const h = freshHarness();
    const res = await handleWebhookRequest(
      new Request("http://127.0.0.1/webhooks/github", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: mentionBody(),
      }),
      h.deps,
    );
    expect(res.status).toBe(401);
    expect(h.posts).toHaveLength(0);
    expect(await auditPayloads(h.store, WORK_ITEM_CREATED_EVENT)).toHaveLength(0);
  });

  test("an unconfigured secret → 401 + rejected (unconfigured), nothing dispatched", async () => {
    const h = freshHarness();
    const res = await post(mentionBody(), { path: "/webhooks/linear" });
    // linear is registered (the registry) but its secret is never provisioned
    // (no linear-webhook boot secret) — the verifier fails closed.
    expect(res.status).toBe(401);
    expect(h.posts).toHaveLength(0);
    expect(await auditPayloads(h.store, WORK_ITEM_CREATED_EVENT)).toHaveLength(0);
    expect(await auditPayloads(h.store, INGEST_WEBHOOK_REJECTED_EVENT)).toEqual([
      { provider: "linear", event_type: "unknown", reason: "unconfigured" },
    ]);
  });

  test("malformed JSON → 400 + rejected, nothing dispatched", async () => {
    const h = freshHarness();
    const res = await post("this is not json");
    expect(res.status).toBe(400);
    expect(h.posts).toHaveLength(0);
    expect(await auditPayloads(h.store, WORK_ITEM_CREATED_EVENT)).toHaveLength(0);
    expect(await auditPayloads(h.store, INGEST_WEBHOOK_REJECTED_EVENT)).toEqual([
      { provider: "github", event_type: "unknown", reason: "malformed_payload" },
    ]);
  });

  test("a well-formed but invalid mention shape → 422 + rejected, nothing dispatched", async () => {
    const h = freshHarness();
    const res = await post(mentionBody({ comment: undefined }));
    expect(res.status).toBe(422);
    expect(h.posts).toHaveLength(0);
    expect(await auditPayloads(h.store, WORK_ITEM_CREATED_EVENT)).toHaveLength(0);
    expect(await auditPayloads(h.store, INGEST_WEBHOOK_REJECTED_EVENT)).toEqual([
      { provider: "github", event_type: "unknown", reason: "invalid_payload" },
    ]);
  });

  test("unknown provider → 404, nothing written", async () => {
    const h = freshHarness();
    const res = await post(mentionBody(), { path: "/webhooks/not-a-provider" });
    expect(res.status).toBe(404);
    expect(h.posts).toHaveLength(0);
    expect(await auditPayloads(h.store, WORK_ITEM_CREATED_EVENT)).toHaveLength(0);
    expect(await auditPayloads(h.store, INGEST_WEBHOOK_REJECTED_EVENT)).toHaveLength(0);
  });

  test("an oversized body is refused with 413 + rejected", async () => {
    const h = freshHarness();
    const res = await post(mentionBody(), { contentLength: 999_999_999 });
    expect(res.status).toBe(413);
    expect(h.posts).toHaveLength(0);
    expect(await auditPayloads(h.store, INGEST_WEBHOOK_REJECTED_EVENT)).toEqual([
      { provider: "github", event_type: "unknown", reason: "payload_too_large" },
    ]);
  });

  test("non-POST methods are refused with 405", async () => {
    const h = freshHarness();
    const res = await handleWebhookRequest(
      new Request("http://127.0.0.1/webhooks/github", { method: "GET" }),
      h.deps,
    );
    expect(res.status).toBe(405);
  });
});

describe("the signature verifier (X-Hub-Signature-256, issue #57)", () => {
  const body = JSON.stringify({ action: "created" });

  test("a correct HMAC verifies; a wrong secret does not", async () => {
    expect(await verifyGitHubSignature({ "x-hub-signature-256": signature(body) }, body, SECRET)).toBe(true);
    expect(await verifyGitHubSignature({ "x-hub-signature-256": signature(body, "other") }, body, SECRET)).toBe(false);
  });

  test("a missing or malformed signature is false (never throws)", async () => {
    expect(await verifyGitHubSignature({}, body, SECRET)).toBe(false);
    expect(await verifyGitHubSignature({ "x-hub-signature-256": "sha1=deadbeef" }, body, SECRET)).toBe(false);
    expect(await verifyGitHubSignature({ "x-hub-signature-256": "sha256=zzzz" }, body, SECRET)).toBe(false);
    // The `sha256=` prefix is case-sensitive (GitHub always sends it
    // lowercase); the hex digest itself is case-insensitive.
    expect(await verifyGitHubSignature({ "x-hub-signature-256": "SHA256=" + signature(body).slice(7) }, body, SECRET)).toBe(false);
    expect(await verifyGitHubSignature({ "x-hub-signature-256": "sha256=" + signature(body).slice(7).toUpperCase() }, body, SECRET)).toBe(true);
  });
});

describe("the webhook route joins the OAuth callback's surface (issue #57)", () => {
  test("startOAuthCallbackServer serves /webhooks/github on the same Bun.serve", async () => {
    const h = freshHarness();
    await h.store.getOrCreateSpace({ platform: "slack", channel_id: "C1" });
    const callbackPort = process.env.BOTTEGA_CALLBACK_PORT;
    process.env.BOTTEGA_CALLBACK_PORT = "0";
    const surface = startOAuthCallbackServer({ store: h.store, audit: h.deps.audit, webhooks: h.deps });
    try {
      const res = await fetch(`${surface.baseUrl}/webhooks/github`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-hub-signature-256": signature(mentionBody()) },
        body: mentionBody(),
      });
      expect(res.status).toBe(200);
      expect(await auditPayloads(h.store, INGEST_WEBHOOK_DISPATCH_EVENT)).toHaveLength(1);

      // The OAuth callback path still answers on the same surface.
      const callback = await fetch(`${surface.baseUrl}/oauth/callback`);
      expect(callback.status).toBe(400); // incomplete authorization (no code/state)

      // Anything else is a 404 (fail closed).
      expect((await fetch(`${surface.baseUrl}/other`)).status).toBe(404);
    } finally {
      surface.stop();
      if (callbackPort === undefined) delete process.env.BOTTEGA_CALLBACK_PORT;
      else process.env.BOTTEGA_CALLBACK_PORT = callbackPort;
    }
  });
});
