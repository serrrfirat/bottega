import { afterAll, describe, expect, test, vi } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createStore,
  parseSpaceSettings,
  recoverStaleWorkItems,
  type Store,
  type WorkItemDelivery,
  type WorkItemState,
} from "./db";
import type { OrgSettingsInput } from "./org-settings";

const dir = mkdtempSync(join(tmpdir(), "bottega-store-"));
const dbPath = join(dir, "test.db");
const store = createStore(dbPath);

// Queue-sensitive tests (claim/transition/markStale) must not see items
// left behind by earlier tests: each gets a fresh DB file.
const stores: Store[] = [];
function freshStore(): Store {
  const s = createStore(join(dir, `store-${stores.length}.db`));
  stores.push(s);
  return s;
}

afterAll(() => {
  for (const s of stores) s.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("spaces", () => {
  test("getOrCreateSpace creates a space; re-contact never clobbers settings/policy, only bumps updated_at", async () => {
    const space = await store.getOrCreateSpace({ platform: "slack", channel_id: "C0123" });
    expect(space.id).toBe("slack:C0123");
    expect(space.platform).toBe("slack");
    expect(space.channel_id).toBe("C0123");
    expect(space.name).toBeNull();
    expect(space.policy_json).toBe("{}");
    expect(space.created_at).toBeGreaterThan(0);
    expect(space.updated_at).toBe(space.created_at);

    // Per-space settings/policy land on the row (issue #64/#130)...
    const policy = '{"tools":{"bash":"deny"}}';
    await store.updatePolicy(space.id, policy);
    await store.updateSpaceSettings(space.id, { model: "deepseek-v4-flash" });
    const before = await store.getSpace(space.id);

    // ...and a later contact (the inbound-path upsert, issue #188) is
    // idempotent: settings, policy, and the first-contact name survive;
    // only updated_at advances.
    vi.useFakeTimers();
    try {
      vi.advanceTimersByTime(1000);
      const again = await store.getOrCreateSpace({ platform: "slack", channel_id: "C0123", name: "late name" });
      expect(again.id).toBe(space.id);
      expect(again.name).toBeNull();
      expect(again.policy_json).toBe(policy);
      expect(again.settings).toBe(before!.settings);
      expect(again.updated_at).toBe(before!.updated_at + 1000);
    } finally {
      vi.useRealTimers();
    }
  });

  test("getSpace returns the row or null", async () => {
    expect(await store.getSpace("slack:missing")).toBeNull();
    const space = await store.getOrCreateSpace({ platform: "telegram", channel_id: "T1" });
    const got = await store.getSpace(space.id);
    expect(got).toEqual(space);
  });

  test("updatePolicy sets policy_json and bumps updated_at", async () => {
    vi.useFakeTimers();
    try {
      const space = await store.getOrCreateSpace({ platform: "slack", channel_id: "C2" });
      vi.advanceTimersByTime(1000);
      const updated = await store.updatePolicy(space.id, '{"tools":{"bash":"deny"}}');
      expect(updated.id).toBe(space.id);
      expect(updated.policy_json).toBe('{"tools":{"bash":"deny"}}');
      expect(updated.updated_at).toBe(space.updated_at + 1000);
    } finally {
      vi.useRealTimers();
    }
  });

  test("model settings default to {} and round-trip per space (issue #64)", async () => {
    const s = freshStore();
    const space = await s.getOrCreateSpace({ platform: "slack", channel_id: "C2M" });
    expect(await s.getSpaceSettings(space.id)).toEqual({});
    expect(await s.getSpaceSettings("slack:missing")).toEqual({});

    const updated = await s.updateSpaceSettings(space.id, {
      model: "deepseek-v4-flash",
      reasoning_effort: "medium",
      fast_model: "flash-lite",
      reasoning_model: "deepseek-reasoner",
    });
    expect(updated.settings).toBe(
      JSON.stringify({
        model: "deepseek-v4-flash",
        reasoning_effort: "medium",
        fast_model: "flash-lite",
        reasoning_model: "deepseek-reasoner",
      }),
    );
    expect(await s.getSpaceSettings(space.id)).toEqual({
      model: "deepseek-v4-flash",
      reasoning_effort: "medium",
      fast_model: "flash-lite",
      reasoning_model: "deepseek-reasoner",
    });

    // Another space is untouched (settings are per-space).
    const other = await s.getOrCreateSpace({ platform: "telegram", channel_id: "T2M" });
    expect(await s.getSpaceSettings(other.id)).toEqual({});

    // updateSpaceSettings throws for a missing space.
    expect(s.updateSpaceSettings("slack:missing", { model: "x" })).rejects.toThrow(/space not found/);
  });

  test("model settings survive a store reopen on the same file (issue #64)", async () => {
    const dbPath = join(dir, "store-settings-persist.db");
    const s1 = createStore(dbPath);
    const space = await s1.getOrCreateSpace({ platform: "slack", channel_id: "C2P" });
    await s1.updateSpaceSettings(space.id, { model: "deepseek-v4-flash", reasoning_effort: "high" });
    s1.close();

    const s2 = createStore(dbPath);
    expect(await s2.getSpaceSettings(space.id)).toEqual({ model: "deepseek-v4-flash", reasoning_effort: "high" });
    s2.close();
  });

  test("the settings column migration is idempotent on a pre-settings database (issue #64)", async () => {
    const dbPath = join(dir, "store-settings-legacy.db");
    // A database created before issue #64: spaces has no settings column.
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE spaces (
        id          TEXT PRIMARY KEY,
        platform    TEXT NOT NULL,
        channel_id  TEXT NOT NULL,
        name        TEXT,
        policy_json TEXT NOT NULL DEFAULT '{}',
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      );
    `);
    legacy.close();

    // First open migrates (column added with the '{}' default); a second
    // open must be a no-op (idempotent).
    const s1 = createStore(dbPath);
    const space = await s1.getOrCreateSpace({ platform: "slack", channel_id: "C2L" });
    expect(await s1.getSpaceSettings(space.id)).toEqual({});
    await s1.updateSpaceSettings(space.id, { model: "migrated-model" });
    s1.close();

    const s2 = createStore(dbPath);
    expect(await s2.getSpaceSettings(space.id)).toEqual({ model: "migrated-model" });
    s2.close();
  });

  test("parseSpaceSettings drops unknown keys and invalid values", async () => {
    expect(parseSpaceSettings(null)).toEqual({});
    expect(parseSpaceSettings("not json")).toEqual({});
    expect(parseSpaceSettings('{"model":"m","bogus":1}')).toEqual({ model: "m" });
    expect(parseSpaceSettings('{"model":"  m  ","reasoning_effort":"ultra"}')).toEqual({ model: "m" });
    expect(parseSpaceSettings('{"reasoning_effort":"high"}')).toEqual({ reasoning_effort: "high" });
  });
});

describe("objects", () => {
  test("createObject writes one content-addressed blob and one row per object", async () => {
    const space = await store.getOrCreateSpace({ platform: "slack", channel_id: "COBJECT1" });
    const bytes = new TextEncoder().encode("shared content");
    const differentBytes = new TextEncoder().encode("different content");
    const sha256 = "a".repeat(64);
    const first = await store.createObject({
      space_id: space.id,
      name: "first.txt",
      mime: "text/plain",
      size: bytes.byteLength,
      sha256,
      uploaded_by: "U1",
      bytes,
    });
    const second = await store.createObject({
      space_id: space.id,
      name: "second.txt",
      mime: "text/plain",
      size: differentBytes.byteLength,
      sha256,
      uploaded_by: "U2",
      bytes: differentBytes,
    });

    expect(first.id).toMatch(/^obj_/);
    expect(second.id).toMatch(/^obj_/);
    expect(second.id).not.toBe(first.id);
    expect(await store.getObject(first.id)).toEqual(first);
    expect(await store.getObject(second.id)).toEqual(second);
    expect(readFileSync(join(dir, "objects", sha256), "utf8")).toBe("shared content");
    expect(readdirSync(join(dir, "objects")).filter((name) => name === sha256)).toHaveLength(1);
    expect(await store.listObjects(space.id)).toHaveLength(2);
  });

  test("listObjects is scoped to a space and returns newest first", async () => {
    vi.useFakeTimers();
    try {
      const firstSpace = await store.getOrCreateSpace({ platform: "slack", channel_id: "COBJECT2" });
      const otherSpace = await store.getOrCreateSpace({ platform: "slack", channel_id: "COBJECT3" });
      const bytes = new TextEncoder().encode("x");
      const older = await store.createObject({
        space_id: firstSpace.id,
        name: "older.txt",
        mime: "text/plain",
        size: bytes.byteLength,
        sha256: "b".repeat(64),
        uploaded_by: "U1",
        bytes,
      });
      vi.advanceTimersByTime(1);
      const newer = await store.createObject({
        space_id: firstSpace.id,
        name: "newer.txt",
        mime: "text/plain",
        size: bytes.byteLength,
        sha256: "c".repeat(64),
        uploaded_by: "U1",
        bytes,
      });
      await store.createObject({
        space_id: otherSpace.id,
        name: "other.txt",
        mime: "text/plain",
        size: bytes.byteLength,
        sha256: "d".repeat(64),
        uploaded_by: "U1",
        bytes,
      });

      expect((await store.listObjects(firstSpace.id)).map((object) => object.id)).toEqual([
        newer.id,
        older.id,
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  test("getObject and readObjectBytes return null when data is missing", async () => {
    expect(await store.getObject("obj_missing")).toBeNull();
    expect(await store.readObjectBytes("obj_missing")).toBeNull();

    const space = await store.getOrCreateSpace({ platform: "slack", channel_id: "COBJECT4" });
    const bytes = new TextEncoder().encode("round trip");
    const sha256 = "e".repeat(64);
    const object = await store.createObject({
      space_id: space.id,
      name: "round-trip.txt",
      mime: "text/plain",
      size: bytes.byteLength,
      sha256,
      uploaded_by: "U1",
      bytes,
    });
    expect(await store.readObjectBytes(object.id)).toEqual(bytes);

    unlinkSync(join(dir, "objects", sha256));
    expect(await store.readObjectBytes(object.id)).toBeNull();
  });
});

describe("work items", () => {
  test("createWorkItem round-trips with defaults", async () => {
    const s = freshStore();
    const space = await s.getOrCreateSpace({ platform: "slack", channel_id: "C10" });
    const item = await s.createWorkItem({ space_id: space.id, requester: "U1", description: "ship the schema" });
    expect(item.id).toMatch(/^wi_/);
    expect(item.space_id).toBe(space.id);
    expect(item.requester).toBe("U1");
    expect(item.repo).toBeNull();
    expect(item.delivery).toBe("git");
    expect(item.state).toBe("open");
    expect(item.approvals).toBe("[]");
    expect(item.evidence).toBe("[]");
    expect(item.result).toBeNull();
    expect(item.created_at).toBeGreaterThan(0);

    const got = await s.getWorkItem(item.id);
    expect(got).toEqual(item);
  });

  test("createWorkItem round-trips explicit extension and chat delivery kinds", async () => {
    const s = freshStore();
    const space = await s.getOrCreateSpace({ platform: "slack", channel_id: "C10-delivery" });
    for (const delivery of ["extension", "chat"] satisfies WorkItemDelivery[]) {
      const item = await s.createWorkItem({
        space_id: space.id,
        requester: "U1",
        description: `${delivery} work`,
        delivery,
      });
      expect(item.delivery).toBe(delivery);
      expect((await s.getWorkItem(item.id))?.delivery).toBe(delivery);
    }
  });

  test("createWorkItem stores an optional repo (issue #47)", async () => {
    const s = freshStore();
    const space = await s.getOrCreateSpace({ platform: "slack", channel_id: "C10b" });
    const item = await s.createWorkItem({
      space_id: space.id,
      requester: "U1",
      description: "fix the flaky checkout",
      repo: "acme/bottega",
    });
    expect(item.repo).toBe("acme/bottega");

    const got = await s.getWorkItem(item.id);
    expect(got?.repo).toBe("acme/bottega");
    // claim/transition round-trips carry the repo untouched.
    const claimed = await s.claimNextWorkItem();
    expect(claimed?.id).toBe(item.id);
    expect(claimed?.repo).toBe("acme/bottega");
  });

  test("the repo column migration is idempotent on a pre-repo database", async () => {
    const dbPath = join(dir, "store-legacy.db");
    // A database created before issue #47: work_items has no repo column.
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE work_items (
        id           TEXT PRIMARY KEY,
        space_id     TEXT NOT NULL REFERENCES spaces(id),
        requester    TEXT NOT NULL,
        description  TEXT NOT NULL,
        state        TEXT NOT NULL DEFAULT 'open'
                     CHECK (state IN ('open','claimed','working','review','done','blocked','aborted')),
        approvals    TEXT NOT NULL DEFAULT '[]',
        evidence     TEXT NOT NULL DEFAULT '[]',
        result       TEXT,
        created_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL
      );
    `);
    legacy.close();

    // First open migrates; a second open must be a no-op (idempotent).
    const s1 = createStore(dbPath);
    const space = await s1.getOrCreateSpace({ platform: "slack", channel_id: "C10c" });
    const item = await s1.createWorkItem({
      space_id: space.id,
      requester: "U1",
      description: "migrated",
      repo: "acme/sandbox",
    });
    expect(item.repo).toBe("acme/sandbox");
    s1.close();

    const s2 = createStore(dbPath);
    const got = await s2.getWorkItem(item.id);
    expect(got?.repo).toBe("acme/sandbox");
    s2.close();
  });

  test("the delivery column migration defaults existing work items to git and is idempotent (issue #128)", async () => {
    const dbPath = join(dir, "store-pre-delivery.db");
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE spaces (
        id          TEXT PRIMARY KEY,
        platform    TEXT NOT NULL,
        channel_id  TEXT NOT NULL,
        name        TEXT,
        policy_json TEXT NOT NULL DEFAULT '{}',
        settings    TEXT NOT NULL DEFAULT '{}',
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      );
      CREATE TABLE work_items (
        id           TEXT PRIMARY KEY,
        space_id     TEXT NOT NULL REFERENCES spaces(id),
        requester    TEXT NOT NULL,
        description  TEXT NOT NULL,
        repo         TEXT,
        state        TEXT NOT NULL DEFAULT 'open'
                     CHECK (state IN ('open','claimed','working','review','done','blocked','aborted')),
        approvals    TEXT NOT NULL DEFAULT '[]',
        evidence     TEXT NOT NULL DEFAULT '[]',
        result       TEXT,
        created_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL
      );
      INSERT INTO spaces (id, platform, channel_id, policy_json, settings, created_at, updated_at)
      VALUES ('slack:legacy', 'slack', 'legacy', '{}', '{}', 1, 1);
      INSERT INTO work_items
        (id, space_id, requester, description, repo, state, approvals, evidence, result, created_at, updated_at)
      VALUES ('wi_legacy', 'slack:legacy', 'U1', 'existing work', NULL, 'open', '[]', '[]', NULL, 1, 1);
    `);
    legacy.close();

    const s1 = createStore(dbPath);
    const columns = s1.getDb().query("PRAGMA table_info(work_items)").all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toContain("delivery");
    expect((await s1.getWorkItem("wi_legacy"))?.delivery).toBe("git");
    s1.close();

    const s2 = createStore(dbPath);
    expect((await s2.getWorkItem("wi_legacy"))?.delivery).toBe("git");
    s2.close();
  });

  test("the model-pin columns migration is idempotent on a pre-#185 database", async () => {
    const dbPath = join(dir, "store-pre-pin.db");
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE spaces (
        id          TEXT PRIMARY KEY,
        platform    TEXT NOT NULL,
        channel_id  TEXT NOT NULL,
        name        TEXT,
        policy_json TEXT NOT NULL DEFAULT '{}',
        settings    TEXT NOT NULL DEFAULT '{}',
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL
      );
      CREATE TABLE work_items (
        id           TEXT PRIMARY KEY,
        space_id     TEXT NOT NULL REFERENCES spaces(id),
        requester    TEXT NOT NULL,
        description  TEXT NOT NULL,
        repo         TEXT,
        delivery     TEXT NOT NULL DEFAULT 'git'
                     CHECK (delivery IN ('git','extension','chat')),
        state        TEXT NOT NULL DEFAULT 'open'
                     CHECK (state IN ('open','claimed','working','review','done','blocked','aborted')),
        approvals    TEXT NOT NULL DEFAULT '[]',
        evidence     TEXT NOT NULL DEFAULT '[]',
        result       TEXT,
        created_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL
      );
      INSERT INTO spaces (id, platform, channel_id, policy_json, settings, created_at, updated_at)
      VALUES ('slack:prepin', 'slack', 'prepin', '{}', '{}', 1, 1);
      INSERT INTO work_items
        (id, space_id, requester, description, repo, delivery, state, approvals, evidence, result, created_at, updated_at)
      VALUES ('wi_prepin', 'slack:prepin', 'U1', 'existing work', NULL, 'git', 'open', '[]', '[]', NULL, 1, 1);
    `);
    legacy.close();

    // First open migrates the pin columns; existing rows backfill to null.
    const s1 = createStore(dbPath);
    const columns = s1.getDb().query("PRAGMA table_info(work_items)").all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining(["model", "reasoning_effort"]));
    expect((await s1.getWorkItem("wi_prepin"))?.model).toBeNull();
    expect((await s1.getWorkItem("wi_prepin"))?.reasoning_effort).toBeNull();
    // A pinned item round-trips through the migrated schema.
    const space = await s1.getOrCreateSpace({ platform: "slack", channel_id: "prepin2" });
    const pinned = await s1.createWorkItem({
      space_id: space.id,
      requester: "U1",
      description: "pinned",
      model: "deepseek-v4-flash",
      reasoning_effort: "low",
    });
    expect(pinned.model).toBe("deepseek-v4-flash");
    expect(pinned.reasoning_effort).toBe("low");
    s1.close();

    // Second open is a no-op (idempotent).
    const s2 = createStore(dbPath);
    expect((await s2.getWorkItem(pinned.id))?.reasoning_effort).toBe("low");
    s2.close();
  });

  test("createWorkItem rejects an unknown space (foreign key)", async () => {
    const s = freshStore();
    await expect(
      s.createWorkItem({ space_id: "slack:nope", requester: "U1", description: "x" }),
    ).rejects.toThrow();
  });

  test("claimNextWorkItem claims oldest open first, then null", async () => {
    const s = freshStore();
    vi.useFakeTimers();
    try {
      const space = await s.getOrCreateSpace({ platform: "slack", channel_id: "C11" });
      const first = await s.createWorkItem({ space_id: space.id, requester: "U1", description: "first" });
      vi.advanceTimersByTime(10);
      const second = await s.createWorkItem({ space_id: space.id, requester: "U1", description: "second" });

      const claimed = await s.claimNextWorkItem();
      expect(claimed?.id).toBe(first.id);
      expect(claimed?.state).toBe("claimed");

      const claimed2 = await s.claimNextWorkItem();
      expect(claimed2?.id).toBe(second.id);

      expect(await s.claimNextWorkItem()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  test("claimNextWorkItem prioritizes executable delivery while still claiming a lone chat item (issue #128)", async () => {
    const s = freshStore();
    const space = await s.getOrCreateSpace({ platform: "slack", channel_id: "C11-delivery" });
    const chat = await s.createWorkItem({
      space_id: space.id,
      requester: "U1",
      description: "answer in channel",
      delivery: "chat",
    });
    const extension = await s.createWorkItem({
      space_id: space.id,
      requester: "U1",
      description: "create a ticket",
      delivery: "extension",
    });

    expect((await s.claimNextWorkItem())?.id).toBe(extension.id);
    expect((await s.claimNextWorkItem())?.id).toBe(chat.id);
  });

  test("two concurrent claimNextWorkItem calls have exactly one winner", async () => {
    const racePath = join(dir, "race.db");
    const a = createStore(racePath);
    const b = createStore(racePath);
    try {
      const space = await a.getOrCreateSpace({ platform: "slack", channel_id: "C12" });
      await a.createWorkItem({ space_id: space.id, requester: "U1", description: "one slot" });

      const [ra, rb] = await Promise.all([a.claimNextWorkItem(), b.claimNextWorkItem()]);
      const winners = [ra, rb].filter((r) => r !== null);
      expect(winners).toHaveLength(1);
      expect(winners[0]!.state).toBe("claimed");
    } finally {
      a.close();
      b.close();
    }
  });

  test("transitionWorkItem rejects a wrong from-state", async () => {
    const s = freshStore();
    const space = await s.getOrCreateSpace({ platform: "slack", channel_id: "C13" });
    const item = await s.createWorkItem({ space_id: space.id, requester: "U1", description: "t" });
    await expect(s.transitionWorkItem(item.id, "claimed", "working")).rejects.toThrow();
    await expect(s.transitionWorkItem("wi_does-not-exist", "open", "working")).rejects.toThrow();
  });

  test("transitionWorkItem applies state, evidence, approval and result", async () => {
    const s = freshStore();
    const space = await s.getOrCreateSpace({ platform: "slack", channel_id: "C14" });
    const item = await s.createWorkItem({ space_id: space.id, requester: "U1", description: "t2" });
    await s.claimNextWorkItem();

    const moved = await s.transitionWorkItem(item.id, "claimed", "working", {
      evidence: "picked up",
      result: JSON.stringify({ pr_url: "https://example.com/pr/1" }),
    });
    expect(moved.state).toBe("working");
    expect(moved.result).toBe(JSON.stringify({ pr_url: "https://example.com/pr/1" }));
    expect(JSON.parse(moved.evidence)).toEqual([{ kind: "note", url: "picked up", at: expect.any(Number) }]);

    const reviewed = await s.transitionWorkItem(item.id, "working", "review", {
      approval: { approver: "U9" },
      evidence: "needs review",
    });
    expect(reviewed.state).toBe("review");
    expect(JSON.parse(reviewed.approvals)).toEqual([{ approver: "U9", at: expect.any(Number) }]);
    expect(JSON.parse(reviewed.evidence)).toHaveLength(2);
  });

  test("markStaleWorkItems blocks only items older than the cutoff", async () => {
    const s = freshStore();
    vi.useFakeTimers();
    try {
      const space = await s.getOrCreateSpace({ platform: "slack", channel_id: "C15" });
      const old = await s.createWorkItem({ space_id: space.id, requester: "U1", description: "old" });
      await s.claimNextWorkItem(); // -> claimed
      vi.advanceTimersByTime(100);
      const fresh = await s.createWorkItem({ space_id: space.id, requester: "U1", description: "fresh" });

      // cutoff = now - 20 = old.updated_at + 80: blocks old, keeps fresh
      const changed = await s.markStaleWorkItems(20, "claimed");
      expect(changed).toBe(1);

      const stale = await s.getWorkItem(old.id);
      expect(stale?.state).toBe("blocked");
      expect(JSON.parse(stale!.evidence)).toEqual([
        { kind: "note", text: "interrupted by restart", at: expect.any(Number) },
      ]);

      const untouched = await s.getWorkItem(fresh.id);
      expect(untouched?.state).toBe("open");
    } finally {
      vi.useRealTimers();
    }
  });

  test("all legal transitions succeed with obligations satisfied", async () => {
    const s = freshStore();
    const space = await s.getOrCreateSpace({ platform: "slack", channel_id: "C1A" });

    // claimed -> open (executor crash before start)
    const item = await s.createWorkItem({ space_id: space.id, requester: "U1", description: "legal" });
    const claimed = await s.claimNextWorkItem();
    expect(claimed?.id).toBe(item.id);
    expect(claimed?.state).toBe("claimed");
    const reset = await s.transitionWorkItem(item.id, "claimed", "open");
    expect(reset.state).toBe("open");

    // open -> aborted (cancel before pickup)
    const cancelled = await s.transitionWorkItem(item.id, "open", "aborted");
    expect(cancelled.state).toBe("aborted");

    // claimed -> working -> blocked (evidence required)
    const item2 = await s.createWorkItem({ space_id: space.id, requester: "U1", description: "legal2" });
    await s.claimNextWorkItem();
    const working = await s.transitionWorkItem(item2.id, "claimed", "working");
    expect(working.state).toBe("working");
    const blocked = await s.transitionWorkItem(item2.id, "working", "blocked", { evidence: "the build broke" });
    expect(blocked.state).toBe("blocked");

    // claimed -> working -> review -> blocked
    const item3 = await s.createWorkItem({ space_id: space.id, requester: "U1", description: "legal3" });
    await s.claimNextWorkItem();
    await s.transitionWorkItem(item3.id, "claimed", "working");
    const review = await s.transitionWorkItem(item3.id, "working", "review", { approval: { approver: "U9" } });
    expect(review.state).toBe("review");
    expect(JSON.parse(review.approvals)).toEqual([{ approver: "U9", at: expect.any(Number) }]);
    const rb = await s.transitionWorkItem(item3.id, "review", "blocked", { evidence: "abandoned" });
    expect(rb.state).toBe("blocked");

    // claimed -> working -> review -> done (result.pr_url required)
    const item4 = await s.createWorkItem({ space_id: space.id, requester: "U1", description: "legal4" });
    await s.claimNextWorkItem();
    await s.transitionWorkItem(item4.id, "claimed", "working");
    await s.transitionWorkItem(item4.id, "working", "review", { approval: { approver: "U9" } });
    const done = await s.transitionWorkItem(item4.id, "review", "done", {
      result: JSON.stringify({ pr_url: "https://example.com/pr/42", summary: "shipped" }),
    });
    expect(done.state).toBe("done");
    expect(JSON.parse(done.result!)).toEqual({ pr_url: "https://example.com/pr/42", summary: "shipped" });

    // claimed -> working -> review -> aborted
    const item5 = await s.createWorkItem({ space_id: space.id, requester: "U1", description: "legal5" });
    await s.claimNextWorkItem();
    await s.transitionWorkItem(item5.id, "claimed", "working");
    await s.transitionWorkItem(item5.id, "working", "review", { approval: { approver: "U9" } });
    const aborted = await s.transitionWorkItem(item5.id, "review", "aborted");
    expect(aborted.state).toBe("aborted");
  });

  test("illegal transitions are rejected from every state", async () => {
    const LEGAL: Record<WorkItemState, WorkItemState[]> = {
      open: ["claimed", "aborted"],
      claimed: ["working", "open", "aborted"],
      working: ["review", "blocked", "aborted"],
      review: ["done", "blocked", "aborted"],
      done: [],
      blocked: [],
      aborted: [],
    };
    const STATES: WorkItemState[] = ["open", "claimed", "working", "review", "done", "blocked", "aborted"];

    async function itemInState(s: Store, spaceId: string, target: WorkItemState): Promise<string> {
      const item = await s.createWorkItem({ space_id: spaceId, requester: "U1", description: `to ${target}` });
      switch (target) {
        case "open":
          return item.id;
        case "claimed":
          await s.claimNextWorkItem();
          return item.id;
        case "working":
          await s.claimNextWorkItem();
          await s.transitionWorkItem(item.id, "claimed", "working");
          return item.id;
        case "review":
          await s.claimNextWorkItem();
          await s.transitionWorkItem(item.id, "claimed", "working");
          await s.transitionWorkItem(item.id, "working", "review", { approval: { approver: "U9" } });
          return item.id;
        case "done":
          await s.claimNextWorkItem();
          await s.transitionWorkItem(item.id, "claimed", "working");
          await s.transitionWorkItem(item.id, "working", "review", { approval: { approver: "U9" } });
          await s.transitionWorkItem(item.id, "review", "done", {
            result: JSON.stringify({ pr_url: "x", summary: "done" }),
          });
          return item.id;
        case "blocked":
          await s.claimNextWorkItem();
          await s.transitionWorkItem(item.id, "claimed", "working");
          await s.transitionWorkItem(item.id, "working", "blocked", { evidence: "e" });
          return item.id;
        case "aborted":
          await s.transitionWorkItem(item.id, "open", "aborted");
          return item.id;
      }
    }

    for (const from of STATES) {
      const s = freshStore();
      const space = await s.getOrCreateSpace({ platform: "slack", channel_id: "C1B" });
      const id = await itemInState(s, space.id, from);
      for (const to of STATES) {
        if (LEGAL[from].includes(to)) continue;
        const obligationOpts =
          to === "done"
            ? { result: JSON.stringify({ pr_url: "x", summary: "done" }) }
            : to === "blocked"
              ? { evidence: "e" }
              : to === "review"
                ? { approval: { approver: "U9" } }
                : undefined;
        await expect(s.transitionWorkItem(id, from, to, obligationOpts), `${from} -> ${to}`).rejects.toThrow(
          /illegal work item transition/,
        );
      }
    }
  });

  test("done enforces the result obligations for each delivery kind (issue #128)", async () => {
    const cases: Array<{
      delivery: WorkItemDelivery;
      result: Record<string, string>;
      succeeds: boolean;
      error?: RegExp;
    }> = [
      { delivery: "git", result: { summary: "shipped" }, succeeds: false, error: /pr_url/ },
      {
        delivery: "git",
        result: { pr_url: "https://example.com/pr/1", summary: "shipped" },
        succeeds: true,
      },
      { delivery: "git", result: { pr_url: "https://example.com/pr/1" }, succeeds: false, error: /summary/ },
      {
        delivery: "extension",
        result: { url: "https://example.com/ticket/1", summary: "created ticket" },
        succeeds: true,
      },
      { delivery: "extension", result: { summary: "created ticket" }, succeeds: false, error: /result\.url/ },
      {
        delivery: "extension",
        result: { url: "https://example.com/ticket/1" },
        succeeds: false,
        error: /summary/,
      },
      { delivery: "chat", result: { summary: "the answer" }, succeeds: true },
      { delivery: "chat", result: { summary: "" }, succeeds: false, error: /summary/ },
    ];

    for (const [index, entry] of cases.entries()) {
      const s = freshStore();
      const space = await s.getOrCreateSpace({ platform: "slack", channel_id: `C1C-${index}` });
      const item = await s.createWorkItem({
        space_id: space.id,
        requester: "U1",
        description: `${entry.delivery} done obligations`,
        delivery: entry.delivery,
      });
      await s.claimNextWorkItem();
      await s.transitionWorkItem(item.id, "claimed", "working");
      await s.transitionWorkItem(item.id, "working", "review", { approval: { approver: "U9" } });

      const transition = s.transitionWorkItem(item.id, "review", "done", {
        result: JSON.stringify(entry.result),
      });
      if (entry.succeeds) {
        expect((await transition).state).toBe("done");
      } else {
        await expect(transition).rejects.toThrow(entry.error);
        expect((await s.getWorkItem(item.id))?.state).toBe("review");
      }
    }
  });

  test("extension delivery can complete from working while git still requires review (issue #128)", async () => {
    const s = freshStore();
    const space = await s.getOrCreateSpace({ platform: "slack", channel_id: "C1C-direct" });

    const extension = await s.createWorkItem({
      space_id: space.id,
      requester: "U1",
      description: "create an external object",
      delivery: "extension",
    });
    await s.claimNextWorkItem();
    await s.transitionWorkItem(extension.id, "claimed", "working");
    const completed = await s.transitionWorkItem(extension.id, "working", "done", {
      result: JSON.stringify({ url: "https://example.com/ticket/1", summary: "created ticket" }),
    });
    expect(completed.state).toBe("done");

    const git = await s.createWorkItem({
      space_id: space.id,
      requester: "U1",
      description: "ship code",
      delivery: "git",
    });
    await s.claimNextWorkItem();
    await s.transitionWorkItem(git.id, "claimed", "working");
    await expect(
      s.transitionWorkItem(git.id, "working", "done", {
        result: JSON.stringify({ pr_url: "https://example.com/pr/1", summary: "shipped" }),
      }),
    ).rejects.toThrow(/illegal work item transition/);
  });

  test("blocked requires non-empty evidence", async () => {
    const s = freshStore();
    const space = await s.getOrCreateSpace({ platform: "slack", channel_id: "C1D" });
    const item = await s.createWorkItem({ space_id: space.id, requester: "U1", description: "blocked obligations" });
    await s.claimNextWorkItem();
    await s.transitionWorkItem(item.id, "claimed", "working");

    await expect(s.transitionWorkItem(item.id, "working", "blocked")).rejects.toThrow(/evidence/);
    await expect(s.transitionWorkItem(item.id, "working", "blocked", { evidence: "   " })).rejects.toThrow(/evidence/);

    const blocked = await s.transitionWorkItem(item.id, "working", "blocked", { evidence: "out of time" });
    expect(blocked.state).toBe("blocked");
  });

  test("review requires a recorded approval", async () => {
    const s = freshStore();
    const space = await s.getOrCreateSpace({ platform: "slack", channel_id: "C1E" });
    const item = await s.createWorkItem({ space_id: space.id, requester: "U1", description: "review obligations" });
    await s.claimNextWorkItem();
    await s.transitionWorkItem(item.id, "claimed", "working");

    await expect(s.transitionWorkItem(item.id, "working", "review")).rejects.toThrow(/approval/);
    const review = await s.transitionWorkItem(item.id, "working", "review", { approval: { approver: "U9" } });
    expect(review.state).toBe("review");
  });

  test("recoverStaleWorkItems blocks stale claimed and working items with a restart note", async () => {
    const s = freshStore();
    vi.useFakeTimers();
    try {
      const space = await s.getOrCreateSpace({ platform: "slack", channel_id: "C1F" });
      const staleClaimed = await s.createWorkItem({ space_id: space.id, requester: "U1", description: "claimed stale" });
      await s.claimNextWorkItem();
      vi.advanceTimersByTime(1000);
      const staleWorking = await s.createWorkItem({ space_id: space.id, requester: "U1", description: "working stale" });
      await s.claimNextWorkItem();
      await s.transitionWorkItem(staleWorking.id, "claimed", "working");
      vi.advanceTimersByTime(1000);
      const fresh = await s.createWorkItem({ space_id: space.id, requester: "U1", description: "fresh" });

      const count = await recoverStaleWorkItems(s, 500);
      expect(count).toBe(2);

      const c = await s.getWorkItem(staleClaimed.id);
      expect(c?.state).toBe("blocked");
      expect(JSON.parse(c!.evidence)).toEqual([{ kind: "note", text: "interrupted by restart", at: expect.any(Number) }]);
      const w = await s.getWorkItem(staleWorking.id);
      expect(w?.state).toBe("blocked");
      const f = await s.getWorkItem(fresh.id);
      expect(f?.state).toBe("open");
      expect(f?.evidence).toBe("[]");
    } finally {
      vi.useRealTimers();
    }
  });

  test("recoverStaleWorkItems audits each stale recovery transition", async () => {
    const s = freshStore();
    vi.useFakeTimers();
    try {
      const space = await s.getOrCreateSpace({ platform: "slack", channel_id: "C1G" });
      await s.createWorkItem({ space_id: space.id, requester: "U1", description: "stale audited" });
      await s.claimNextWorkItem();
      vi.advanceTimersByTime(1000);
      await recoverStaleWorkItems(s, 100);

      const rows = await s.listAudit({ space: space.id, event_type: "work_item.transition" });
      expect(rows).toHaveLength(1);
      expect(JSON.parse(rows[0]!.payload)).toEqual({ from: "claimed", to: "blocked", by: "system" });
      expect(rows[0]!.actor).toBe("system");
    } finally {
      vi.useRealTimers();
    }
  });

  test("every transition writes a work_item.transition audit row", async () => {
    const s = freshStore();
    const space = await s.getOrCreateSpace({ platform: "slack", channel_id: "C1H" });
    const item = await s.createWorkItem({ space_id: space.id, requester: "U1", description: "audited" });
    await s.claimNextWorkItem();
    await s.transitionWorkItem(item.id, "claimed", "working", { by: "executor:1" });
    await s.transitionWorkItem(item.id, "working", "review", { approval: { approver: "U9" }, by: "executor:1" });
    await s.transitionWorkItem(item.id, "review", "done", {
      result: JSON.stringify({ pr_url: "https://example.com/pr/9", summary: "shipped" }),
      by: "executor:1",
    });

    const rows = await s.listAudit({ space: space.id, event_type: "work_item.transition" });
    expect(rows).toHaveLength(3);
    expect(JSON.parse(rows[0]!.payload)).toEqual({ from: "claimed", to: "working", by: "executor:1" });
    expect(JSON.parse(rows[1]!.payload)).toEqual({ from: "working", to: "review", by: "executor:1" });
    expect(JSON.parse(rows[2]!.payload)).toEqual({ from: "review", to: "done", by: "executor:1" });
  });

  test("createWorkItem writes a work_item.created audit row", async () => {
    const s = freshStore();
    const space = await s.getOrCreateSpace({ platform: "slack", channel_id: "C1I" });
    const item = await s.createWorkItem({ space_id: space.id, requester: "U7", description: "audited create" });

    const rows = await s.listAudit({ space: space.id, event_type: "work_item.created" });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor).toBe("U7");
    expect(JSON.parse(rows[0]!.payload)).toEqual({ id: item.id, requester: "U7" });
  });
});

describe("extension credentials", () => {
  test("upsert org credential round-trips and re-binds on re-connect", async () => {
    const s = freshStore();
    const first = await s.upsertExtensionCredential({
      provider: "github",
      identityKey: "email:ada@example.com",
      owner: null,
      scope: "org",
      brokerCredentialId: 7,
    });
    expect(first.owner).toBeNull();
    expect(first.scope).toBe("org");

    const rebound = await s.upsertExtensionCredential({
      provider: "github",
      identityKey: "email:ada@example.com",
      owner: null,
      scope: "org",
      brokerCredentialId: 42,
    });
    expect(rebound.id).toBe(first.id); // re-bind, not a duplicate row
    expect(rebound.broker_credential_id).toBe(42);

    const rows = await s.listExtensionCredentials("github");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(first.id);
  });

  test("personal credentials are unique per (provider, owner) and isolated across owners", async () => {
    const s = freshStore();
    const adas = await s.upsertExtensionCredential({
      provider: "github",
      identityKey: "email:ada@example.com",
      owner: "UADA",
      scope: "personal",
      brokerCredentialId: 1,
    });
    const bobs = await s.upsertExtensionCredential({
      provider: "github",
      identityKey: "email:bob@example.com",
      owner: "UBOB",
      scope: "personal",
      brokerCredentialId: 2,
    });
    expect(bobs.id).not.toBe(adas.id);

    const rebound = await s.upsertExtensionCredential({
      provider: "github",
      identityKey: "email:ada@new.example.com",
      owner: "UADA",
      scope: "personal",
      brokerCredentialId: 3,
    });
    expect(rebound.id).toBe(adas.id);

    const rows = await s.listExtensionCredentials("github");
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.owner).sort()).toEqual(["UADA", "UBOB"]);
  });

  test("upsert validates scope/owner pairing", async () => {
    const s = freshStore();
    await expect(
      s.upsertExtensionCredential({ provider: "github", identityKey: "k", owner: "U1", scope: "org", brokerCredentialId: 1 }),
    ).rejects.toThrow(/org extension credentials cannot have an owner/);
    await expect(
      s.upsertExtensionCredential({ provider: "github", identityKey: "k", owner: null, scope: "personal", brokerCredentialId: 1 }),
    ).rejects.toThrow(/personal extension credentials need an owner/);
    await expect(
      s.upsertExtensionCredential({ provider: "", identityKey: "k", owner: null, scope: "org", brokerCredentialId: 1 }),
    ).rejects.toThrow(/provider and an identity key/);
  });

  test("listExtensionCredentials filters by provider and orders org before personal", async () => {
    const s = freshStore();
    await s.upsertExtensionCredential({ provider: "linear", identityKey: "email:a@x.com", owner: "U1", scope: "personal", brokerCredentialId: 1 });
    await s.upsertExtensionCredential({ provider: "github", identityKey: "org-key", owner: null, scope: "org", brokerCredentialId: 2 });
    await s.upsertExtensionCredential({ provider: "github", identityKey: "email:a@x.com", owner: "U1", scope: "personal", brokerCredentialId: 3 });

    const rows = await s.listExtensionCredentials("github");
    expect(rows.map((r) => r.scope)).toEqual(["org", "personal"]);
  });

  test("schema CHECK rejects an unknown scope through the raw handle", () => {
    const s = freshStore();
    expect(() =>
      s.getDb().query("INSERT INTO extension_credentials (id, provider, identity_key, owner, scope, broker_credential_id, created_at) VALUES (?, ?, ?, NULL, 'team', ?, ?)").run("ec_x", "github", "k", 1, 1),
    ).toThrow(/CHECK/);
  });
});

describe("audit", () => {
  test("appendAudit returns ids and listAudit filters", async () => {
    const space = await store.getOrCreateSpace({ platform: "slack", channel_id: "C20" });
    const since = Date.now();
    const id1 = await store.appendAudit({ space_id: space.id, actor: "U1", event_type: "message.in", payload: "{}" });
    const id2 = await store.appendAudit({ actor: "agent:work:wi_x", event_type: "tool_call", payload: "{}" });
    expect(id2).toBeGreaterThan(id1);

    const bySpace = await store.listAudit({ space: space.id });
    expect(bySpace.map((r) => r.id)).toEqual([id1]);

    const byType = await store.listAudit({ event_type: "tool_call" });
    expect(byType.map((r) => r.id)).toEqual([id2]);

    const after = await store.listAudit({ since });
    expect(after.length).toBeGreaterThanOrEqual(2);

    const limited = await store.listAudit({ limit: 1 });
    expect(limited).toHaveLength(1);

    const full = await store.listAudit({});
    expect(full.length).toBeGreaterThanOrEqual(2);
    expect(full[0]!.ts).toBeGreaterThan(0);
    expect(full[0]!.payload).toBeTypeOf("string");
  });

  test("audit is append-only: UPDATE and DELETE are rejected by triggers", async () => {
    const id = await store.appendAudit({ actor: "U1", event_type: "x", payload: "{}" });
    const raw = new Database(dbPath);
    try {
      expect(() => raw.query("UPDATE audit SET payload = 'tampered' WHERE id = ?").run(id)).toThrow(/append-only/);
      expect(() => raw.query("DELETE FROM audit WHERE id = ?").run(id)).toThrow(/append-only/);
    } finally {
      raw.close();
    }
    const rows = await store.listAudit({ event_type: "x" });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload).toBe("{}");
  });
});

describe("migration", () => {
  test("schema.sql re-runs are no-ops across connections", () => {
    const migratePath = join(dir, "migrate.db");
    const s1 = createStore(migratePath);
    const s2 = createStore(migratePath); // re-runs the same schema on a second connection
    s1.close();
    s2.close();
    const s3 = createStore(migratePath); // still fine after close/reopen
    s3.close();
  });

  test("extension_credentials survives schema re-runs and stays writable", async () => {
    const migratePath = join(dir, "migrate-creds.db");
    const s1 = createStore(migratePath);
    const s2 = createStore(migratePath); // idempotent re-run
    const row = await s2.upsertExtensionCredential({
      provider: "github",
      identityKey: "email:a@x.com",
      owner: "U1",
      scope: "personal",
      brokerCredentialId: 9,
    });
    expect(row.scope).toBe("personal");
    s1.close();
    s2.close();
  });
});

describe("org settings (issue #67)", () => {
  test("getOrgSettings returns null when no row exists", () => {
    const s = freshStore();
    expect(s.getOrgSettings()).toBeNull();
  });

  test("set/get round-trips the validated camelCase shape", () => {
    const s = freshStore();
    const parsed = s.setOrgSettings({
      approvals: { timeout_minutes: 7, always_approve: ["bash", "create_work_item"] },
      response_mode: "mention",
      memory: { injection: { enabled: false, max_entries: 3 } },
      extensions: { allow: ["linear"], deny: ["attio"], org_credentials: "deny" },
      repos: ["acme/sandbox"],
      models: { default: "deepseek-v4-flash", fast: "deepseek-v4-flash", reasoning: "glm-5", effort: "medium" },
    });
    expect(parsed.ok).toBe(true);
    expect(s.getOrgSettings()).toEqual({
      ok: true,
      errors: [],
      warnings: [],
      approvals: { timeoutMinutes: 7, alwaysApprove: ["bash", "create_work_item"] },
      responseMode: "mention",
      memoryInjection: { enabled: false, maxEntries: 3 },
      extensions: { allow: ["linear"], deny: ["attio"], orgCredentials: "deny" },
      repos: ["acme/sandbox"],
      models: { default: "deepseek-v4-flash", fast: "deepseek-v4-flash", reasoning: "glm-5", effort: "medium" },
    });
  });

  test("setOrgSettings upserts the singleton row (id=1) and the CHECK pins it", () => {
    const s = freshStore();
    s.setOrgSettings({ response_mode: "mention" });
    s.setOrgSettings({ response_mode: "request-only" });
    expect(s.getOrgSettings()?.responseMode).toBe("request-only");
    const rows = s.getDb().query("SELECT id FROM org_settings").all() as { id: number }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(1);
    expect(() =>
      s.getDb().query("INSERT INTO org_settings (id, settings, updated_at) VALUES (2, '{}', 0)").run(),
    ).toThrow(/CHECK/);
  });

  test("setOrgSettings rejects malformed input and writes nothing (fail closed)", () => {
    const s = freshStore();
    // Deliberately malformed values: cast across the typed-input boundary so
    // the runtime validator is exercised (the API type already rejects these).
    const malformed = (v: object): OrgSettingsInput => v as unknown as OrgSettingsInput;
    expect(() => s.setOrgSettings(malformed({ approvals: { timeout_minutes: -1 } }))).toThrow(/timeout_minutes/);
    expect(() => s.setOrgSettings(malformed({ response_mode: "whenever" }))).toThrow(/response_mode/);
    expect(() => s.setOrgSettings(malformed({ extensions: { allow: ["Bad Id"] } }))).toThrow(/extensions\.allow/);
    expect(() => s.setOrgSettings(malformed({ approvals: { always_approve: ["some_new_tool"] } }))).toThrow(/always_approve/);
    expect(() => s.setOrgSettings(malformed({ repos: ["no-slash"] }))).toThrow(/repos/);
    expect(() => s.setOrgSettings(malformed({ models: { effort: "" } }))).toThrow(/models\.effort/);
    expect(() => s.setOrgSettings(malformed({ unknown_key: 1 }))).toThrow(/unknown key/);
    expect(s.getOrgSettings()).toBeNull();
  });

  test("a malformed blob already in the DB fails getOrgSettings closed", () => {
    const s = freshStore();
    s.getDb()
      .query("INSERT INTO org_settings (id, settings, updated_at) VALUES (1, ?, ?)")
      .run('{"approvals": "nope"}', Date.now());
    expect(() => s.getOrgSettings()).toThrow(/approvals must be an object/);
  });

  test("empty and partial blobs validate", () => {
    const s = freshStore();
    expect(s.setOrgSettings({}).ok).toBe(true);
    expect(s.setOrgSettings({ approvals: { timeout_minutes: 9 } })).toEqual({
      ok: true,
      errors: [],
      warnings: [],
      approvals: { timeoutMinutes: 9 },
    });
  });

  test("onboarding.space_id round-trips; empty clears; malformed fails closed (issue #116)", () => {
    const s = freshStore();
    const parsed = s.setOrgSettings({ onboarding: { space_id: "slack:C123" } });
    expect(parsed.ok).toBe(true);
    expect(parsed.onboarding).toEqual({ spaceId: "slack:C123" });
    expect(s.getOrgSettings()?.onboarding).toEqual({ spaceId: "slack:C123" });

    // An empty space_id clears the setting (no boot post), mirroring
    // memory_backend.base_url.
    s.setOrgSettings({ onboarding: { space_id: "" } });
    expect(s.getOrgSettings()?.onboarding).toBeUndefined();
    expect(s.setOrgSettings({ onboarding: {} }).onboarding).toBeUndefined();

    // Malformed values fail closed and write nothing.
    const malformed = (v: object): OrgSettingsInput => v as unknown as OrgSettingsInput;
    expect(() => s.setOrgSettings(malformed({ onboarding: { space_id: 42 } }))).toThrow(/onboarding\.space_id/);
    expect(() => s.setOrgSettings(malformed({ onboarding: { channel: "C1" } }))).toThrow(/onboarding\.channel: unknown key/);
    expect(() => s.setOrgSettings(malformed({ onboarding: "slack:C1" }))).toThrow(/onboarding must be an object/);
    expect(s.getOrgSettings()?.onboarding).toBeUndefined();
  });

  test("memory.injection.max_entries over the cap is clamped with a warning", () => {
    const s = freshStore();
    const parsed = s.setOrgSettings({ memory: { injection: { max_entries: 50 } } });
    expect(parsed.ok).toBe(true);
    expect(parsed.memoryInjection).toEqual({ maxEntries: 20 });
    expect(parsed.warnings).toHaveLength(1);
  });

  test("the org_settings migration is idempotent and adds the table to pre-#67 databases", () => {
    const legacyPath = join(dir, "store-org-settings-legacy.db");
    // A database created before issue #67: no org_settings table.
    const legacy = new Database(legacyPath);
    legacy.exec(
      "CREATE TABLE audit (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, space_id TEXT, actor TEXT NOT NULL, event_type TEXT NOT NULL, payload TEXT NOT NULL);",
    );
    legacy.close();

    const s1 = createStore(legacyPath);
    const parsed = s1.setOrgSettings({ response_mode: "mention" });
    expect(parsed.responseMode).toBe("mention");
    s1.close();

    // A second open re-runs the migration: no-op, data intact.
    const s2 = createStore(legacyPath);
    expect(s2.getOrgSettings()?.responseMode).toBe("mention");
    s2.close();
  });
});
