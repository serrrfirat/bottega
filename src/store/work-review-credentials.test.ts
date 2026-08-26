import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore, type Store, type WorkReviewIdentity } from "./db";

// Work review credential persistence (issue #359, task 2): hashed one-time
// redeem tokens and short-lived browser sessions. Only SHA-256 hashes ever
// reach SQLite — the raw token, session, and CSRF values are high-entropy
// random bytes that live only in the ephemeral review link and a
// Secure/HttpOnly cookie — and redemption is an atomic consume + session
// insert so a replayed link can never mint a second session.

const dir = mkdtempSync(join(tmpdir(), "bottega-work-review-"));
const stores: Store[] = [];
function freshStore(): Store {
  const s = createStore(join(dir, `store-${stores.length}.db`));
  stores.push(s);
  return s;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

afterAll(() => {
  for (const s of stores) s.close();
  rmSync(dir, { recursive: true, force: true });
});

async function fixture(store: Store): Promise<{ identity: WorkReviewIdentity; workItemId: string }> {
  const space = await store.getOrCreateSpace({ platform: "slack", channel_id: "C-WR" });
  const item = await store.createWorkItem({ space_id: space.id, requester: "U-REV", description: "reviewable work" });
  return {
    workItemId: item.id,
    identity: { workItemId: item.id, slackTeamId: "T1", slackUserId: "U-REV", slackChannelId: "C-WR" },
  };
}

describe("work review credentials (issue #359)", () => {
  test("createWorkReviewToken stores only the SHA-256 hash, never the raw token", async () => {
    const store = freshStore();
    const { identity } = await fixture(store);
    const now = Date.now();
    const rawToken = store.createWorkReviewToken(identity, now + 60_000);

    // A high-entropy random token is returned, not a re-derivable value.
    expect(rawToken.length).toBeGreaterThan(16);

    // The row holds only the digested token; the raw value never touches SQLite.
    const row = store
      .getDb()
      .query("SELECT token_hash, consumed_at FROM work_review_tokens WHERE work_item_id = ?")
      .get(identity.workItemId) as { token_hash: string; consumed_at: number | null } | null;
    expect(row).not.toBeNull();
    expect(row!.token_hash).toBe(sha256(rawToken));
    expect(row!.token_hash).not.toBe(rawToken);
    expect(row!.consumed_at).toBeNull();

    // The raw value appears nowhere in a dump of the credential columns.
    const dump = JSON.stringify(
      store.getDb().query("SELECT token_hash, work_item_id, slack_team_id, slack_user_id, slack_channel_id FROM work_review_tokens").all(),
    );
    expect(dump).not.toContain(rawToken);
    expect(row!.token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("redeemWorkReviewToken atomically: first redemption succeeds and mints exactly one session; replay fails", async () => {
    const store = freshStore();
    const { identity } = await fixture(store);
    const now = Date.now();
    const rawToken = store.createWorkReviewToken(identity, now + 60_000);
    const rawSession = "raw-session-" + crypto.randomUUID();
    const csrfHash = sha256("csrf-" + crypto.randomUUID());

    const first = store.redeemWorkReviewToken({
      rawToken,
      rawSession,
      csrfHash,
      sessionExpiresAt: now + 300_000,
      now,
    });
    expect(first).not.toBeNull();
    expect(first!.identity).toEqual(identity);
    expect(first!.csrfHash).toBe(csrfHash);
    expect(first!.expiresAt).toBe(now + 300_000);

    // Token is consumed — a replay (even with a fresh session) cannot mint a second session.
    const replay = store.redeemWorkReviewToken({
      rawToken,
      rawSession: "raw-session-" + crypto.randomUUID(),
      csrfHash: sha256("other"),
      sessionExpiresAt: now + 300_000,
      now,
    });
    expect(replay).toBeNull();

    // Exactly one session row exists, keyed by the hash of the raw session value.
    const sessions = store
      .getDb()
      .query("SELECT session_hash, csrf_hash, work_item_id FROM work_review_sessions")
      .all() as Array<{ session_hash: string; csrf_hash: string; work_item_id: string }>;
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.session_hash).toBe(sha256(rawSession));
    expect(sessions[0]!.session_hash).not.toBe(rawSession);
    expect(sessions[0]!.csrf_hash).toBe(csrfHash);
    expect(sessions[0]!.work_item_id).toBe(identity.workItemId);
  });

  test("redeemWorkReviewToken fails on an expired token and stores no session", async () => {
    const store = freshStore();
    const { identity } = await fixture(store);
    const now = Date.now();
    const rawToken = store.createWorkReviewToken(identity, now + 60_000);

    // Redemption after the short TTL must fail closed — no session is minted.
    const result = store.redeemWorkReviewToken({
      rawToken,
      rawSession: "raw-session-expired-token",
      csrfHash: sha256("csrf"),
      sessionExpiresAt: now + 300_000,
      now: now + 120_000,
    });
    expect(result).toBeNull();
    expect(store.getDb().query("SELECT COUNT(*) AS n FROM work_review_sessions").get() as { n: number }).toEqual({ n: 0 });
  });

  test("redeemWorkReviewToken ignores a token that was never issued", async () => {
    const store = freshStore();
    const { identity } = await fixture(store);
    const now = Date.now();
    const result = store.redeemWorkReviewToken({
      rawToken: "never-minted-token",
      rawSession: "raw-session-ghost",
      csrfHash: sha256("csrf"),
      sessionExpiresAt: now + 300_000,
      now,
    });
    expect(result).toBeNull();
    expect(store.getDb().query("SELECT COUNT(*) AS n FROM work_review_sessions").get() as { n: number }).toEqual({ n: 0 });
  });

  test("getAndTouchWorkReviewSession returns null for an expired session", async () => {
    const store = freshStore();
    const { identity } = await fixture(store);
    const now = Date.now();
    const rawToken = store.createWorkReviewToken(identity, now + 60_000);

    // Redeem with a session that is already past its lifetime.
    store.redeemWorkReviewToken({
      rawToken,
      rawSession: "raw-session-expired",
      csrfHash: sha256("csrf"),
      sessionExpiresAt: now + 10_000,
      now,
    });

    // Asking for it after its expiry returns nothing.
    const result = store.getAndTouchWorkReviewSession("raw-session-expired", now + 20_000);
    expect(result).toBeNull();
  });

  test("getAndTouchWorkReviewSession returns the session and advances last_seen_at", async () => {
    const store = freshStore();
    const { identity } = await fixture(store);
    const now = Date.now();
    const rawToken = store.createWorkReviewToken(identity, now + 60_000);
    const rawSession = "raw-session-touch";
    const csrfHash = sha256("csrf");

    store.redeemWorkReviewToken({
      rawToken,
      rawSession,
      csrfHash,
      sessionExpiresAt: now + 300_000,
      now,
    });

    const first = store.getAndTouchWorkReviewSession(rawSession, now);
    expect(first).not.toBeNull();
    expect(first!.identity).toEqual(identity);
    expect(first!.csrfHash).toBe(csrfHash);
    expect(first!.expiresAt).toBe(now + 300_000);

    // A later touch advances last_seen_at but never stores the raw session value.
    const later = now + 5000;
    store.getAndTouchWorkReviewSession(rawSession, later);
    const row = store
      .getDb()
      .query("SELECT session_hash, last_seen_at FROM work_review_sessions WHERE session_hash = ?")
      .get(sha256(rawSession)) as { session_hash: string; last_seen_at: number } | null;
    expect(row).not.toBeNull();
    expect(row!.last_seen_at).toBe(later);
    expect(row!.session_hash).toBe(sha256(rawSession));

    const dump = JSON.stringify(store.getDb().query("SELECT session_hash, csrf_hash FROM work_review_sessions").all());
    expect(dump).not.toContain(rawSession);
  });
});