import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteMemoryProvider } from "../memory/sqlite";
import type { MemoryProvider } from "../memory/types";
import { createAudit } from "../policy/audit";
import { defaultPolicy, type ResponseMode } from "../policy/config";
import { DIGEST_FAILED_EVENT, MEMORY_WRITE_EVENT } from "../store/audit-events";
import { createStore, type Store, type WorkItemState } from "../store/db";
import { sha256Hex } from "../tools/helpers";
import type { SchedulerActionContext } from "./types";
import { standupDigestAction } from "./standup";

const FIXED_NOW = Date.UTC(2026, 7, 17, 10, 30);
const DAY_START = Date.UTC(2026, 7, 17);
const PREVIOUS_DAY_START = Date.UTC(2026, 7, 16);
const stores: Store[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function freshStore(): Store {
  const dir = mkdtempSync(join(tmpdir(), "bottega-standup-"));
  dirs.push(dir);
  const store = createStore(join(dir, "test.db"));
  stores.push(store);
  return store;
}

function insertWorkItem(
  store: Store,
  input: {
    id: string;
    space: string;
    state: WorkItemState;
    description: string;
    requester?: string;
    result?: string | null;
    evidence?: string;
    updatedAt: number;
  },
): void {
  store
    .getDb()
    .query(
      `INSERT INTO work_items
       (id, space_id, requester, description, repo, state, approvals, evidence, result, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, ?, '[]', ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      input.space,
      input.requester ?? "U_REQUESTER",
      input.description,
      input.state,
      input.evidence ?? "[]",
      input.result ?? null,
      input.updatedAt - 1_000,
      input.updatedAt,
    );
}

/** The context fixture: the scheduler action context plus posted messages. */
interface StandupTestContext {
  ctx: SchedulerActionContext;
  posted: Array<{ space: string; text: string; blocks?: unknown[] }>;
}

function context(
  store: Store,
  options: {
    responseMode?: ResponseMode;
    memoryProvider?: MemoryProvider;
  } = {},
): StandupTestContext {
  const posted: Array<{ space: string; text: string; blocks?: unknown[] }> = [];
  return {
    posted,
    ctx: {
      store,
      audit: createAudit(store),
      memoryProvider: options.memoryProvider ?? createSqliteMemoryProvider(store.getDb()),
      async postMessage(space, text, opts) {
        posted.push({ space, text, blocks: opts?.blocks });
        return "171.001";
      },
      async loadPolicy() {
        return { ...defaultPolicy(), responseMode: options.responseMode ?? "always" };
      },
      log() {},
      now: () => FIXED_NOW,
    },
  };
}

async function createSpace(store: Store, channel: string, policyJson: string): Promise<string> {
  const space = await store.getOrCreateSpace({ platform: "slack", channel_id: channel });
  await store.updatePolicy(space.id, policyJson);
  return space.id;
}

function memoryRows(store: Store): Array<{ id: string; content: string; metadata_json: string }> {
  // SAFETY: the SELECT lists exactly these three TEXT columns; SQLite
  // returns TEXT values as strings, so every row matches the annotation.
  return store
    .getDb()
    .query("SELECT id, content, metadata_json FROM memories ORDER BY created_at, rowid")
    .all() as Array<{ id: string; content: string; metadata_json: string }>;
}

describe("standupDigestAction (issue #92)", () => {
  test("fails closed when the per-space opt-in is disabled or malformed", async () => {
    for (const [channel, policy] of [
      ["DISABLED", JSON.stringify({ proactive: { standup: false } })],
      ["MALFORMED", '{"proactive": ['],
    ] as const) {
      const store = freshStore();
      const space = await createSpace(store, channel, policy);
      const { ctx, posted } = context(store);

      await standupDigestAction.run({ space }, ctx);

      expect(posted).toHaveLength(0);
      expect(memoryRows(store)).toHaveLength(0);
    }
  });

  test("does not post or save unless the effective response mode is always", async () => {
    const store = freshStore();
    const space = await createSpace(store, "MODE", JSON.stringify({ proactive: { standup: true } }));
    const { ctx, posted } = context(store, { responseMode: "mention" });

    await standupDigestAction.run({ space }, ctx);

    expect(posted).toHaveLength(0);
    expect(memoryRows(store)).toHaveLength(0);
  });

  test("posts yesterday/open/blocked store facts, saves audited memory, and keeps only 20 digests", async () => {
    const store = freshStore();
    const space = await createSpace(store, "ACTIVE", JSON.stringify({ proactive: { standup: true } }));
    const otherSpace = await createSpace(store, "OTHER", JSON.stringify({ proactive: { standup: true } }));
    insertWorkItem(store, {
      id: "wi_done_yesterday",
      space,
      state: "done",
      description: "Ship scheduler",
      requester: "U_FINISHER",
      result: JSON.stringify({ pr_url: "https://github.com/acme/repo/pull/7" }),
      updatedAt: PREVIOUS_DAY_START + 60_000,
    });
    insertWorkItem(store, {
      id: "wi_done_today",
      space,
      state: "done",
      description: "Not in yesterday window",
      result: JSON.stringify({ pr_url: "https://github.com/acme/repo/pull/8" }),
      updatedAt: DAY_START + 60_000,
    });
    insertWorkItem(store, {
      id: "wi_open",
      space,
      state: "working",
      description: "Implement reflection",
      requester: "U_WORKER",
      result: "not-json",
      updatedAt: PREVIOUS_DAY_START - 60_000,
    });
    insertWorkItem(store, {
      id: "wi_blocked",
      space,
      state: "blocked",
      description: "Waiting for access",
      requester: "U_BLOCKED",
      evidence: JSON.stringify([{ kind: "note", url: "needs repository permission" }]),
      updatedAt: DAY_START + 120_000,
    });
    insertWorkItem(store, {
      id: "wi_other",
      space: otherSpace,
      state: "open",
      description: "Other space work",
      updatedAt: DAY_START,
    });

    const memoryProvider = createSqliteMemoryProvider(store.getDb());
    for (let i = 0; i < 20; i++) {
      await memoryProvider.save({
        scope: { kind: "org" },
        content: `old digest ${i}`,
        metadata: { kind: "digest", space, since: "", until: String(i) },
      });
    }
    const { ctx, posted } = context(store, { memoryProvider });

    await standupDigestAction.run({ space }, ctx);

    expect(posted).toHaveLength(1);
    const digest = posted[0].text;
    expect(digest).toContain("1 finished yesterday");
    expect(digest).toContain("1 still open");
    expect(digest).toContain("1 blocked");
    expect(digest).toContain("wi_done_yesterday");
    expect(digest).toContain("Ship scheduler");
    expect(digest).toContain("U_FINISHER");
    expect(digest).toContain("https://github.com/acme/repo/pull/7");
    expect(digest).toContain("wi_open");
    expect(digest).toContain("wi_blocked");
    expect(digest).not.toContain("wi_done_today");
    expect(digest).not.toContain("wi_other");
    // Issue #279: the same facts render as table cards alongside the text.
    // SAFETY: standupDigestAction constructs opts.blocks from its typed table-card
    // renderer; this fixture records that array without transforming its entries.
    const blocks = posted[0].blocks as Array<{ text?: { text?: string } }>;
    expect(blocks).toBeDefined();
    const tableText = blocks.map((b) => b.text?.text ?? "").join("\n");
    expect(tableText).toContain("wi_done_yesterday");
    expect(tableText).toContain("Ship scheduler");
    expect(tableText).toContain("wi_open");
    expect(tableText).toContain("wi_blocked");
    expect(tableText).not.toContain("wi_other");

    const memories = memoryRows(store);
    expect(memories).toHaveLength(20);
    const saved = memories.find((row) => row.content === digest);
    expect(saved).toBeDefined();
    expect(JSON.parse(saved!.metadata_json)).toEqual({
      kind: "digest",
      space,
      since: String(PREVIOUS_DAY_START),
      until: String(FIXED_NOW),
    });

    const writes = await store.listAudit({ space, event_type: MEMORY_WRITE_EVENT });
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0].payload)).toEqual({
      scope: "org",
      principal: null,
      id: saved!.id,
      content_hash: sha256Hex(digest),
    });
  });

  test("caps the table renders at the row cap and notes the elided tail (issue #279)", async () => {
    const store = freshStore();
    const space = await createSpace(store, "CAP", JSON.stringify({ proactive: { standup: true } }));
    // More open items than the table row cap (12) so the elided-tail note fires.
    for (let i = 0; i < 20; i++) {
      insertWorkItem(store, {
        id: `wi_open_${i}`,
        space,
        state: "working",
        description: `Open work ${i}`,
        requester: "U_WORKER",
        updatedAt: PREVIOUS_DAY_START - 60_000 + i,
      });
    }
    const { ctx, posted } = context(store);

    await standupDigestAction.run({ space }, ctx);

    expect(posted).toHaveLength(1);
    // SAFETY: standupDigestAction constructs opts.blocks from its typed table-card
    // renderer; this fixture records that array without transforming its entries.
    const blocks = posted[0].blocks as Array<{ text?: { text?: string } }>;
    const tableText = blocks.map((b) => b.text?.text ?? "").join("\n");
    expect(tableText).toContain("wi_open_0");
    expect(tableText).toContain("wi_open_11");
    // Tail is elided, not rendered row-by-row.
    expect(tableText).not.toContain("wi_open_12");
    expect(tableText).toContain("8 more not shown");
  });

  test("fails before posting or saving when digest pruning is unsupported", async () => {
    const store = freshStore();
    const space = await createSpace(store, "NO_PRUNE", JSON.stringify({ proactive: { standup: true } }));
    let saves = 0;
    const unsupportedMemory: MemoryProvider = {
      capabilities: { consolidation: "on-save", digestPruning: "unsupported" },
      async save(input) {
        saves += 1;
        return {
          id: "unexpected",
          key: input.scope,
          content: input.content,
          metadata: input.metadata ?? {},
          createdAt: FIXED_NOW,
        };
      },
      async search() {
        return [];
      },
      async pruneDigests() {
        throw new Error("must not reach prune after the capability check");
      },
    };
    const { ctx, posted } = context(store, { memoryProvider: unsupportedMemory });

    await standupDigestAction.run({ space }, ctx);

    expect(posted).toHaveLength(0);
    expect(saves).toBe(0);
    const failures = await store.listAudit({ space, event_type: DIGEST_FAILED_EVENT });
    expect(failures).toHaveLength(1);
    expect(JSON.parse(failures[0]!.payload)).toEqual({
      reason:
        "configured memory provider does not support required digest pruning; " +
        "digest production cannot enforce the per-space retention cap",
    });
  });

  test("audits a failure and never throws past the runner", async () => {
    const store = freshStore();
    const space = await createSpace(store, "FAIL", JSON.stringify({ proactive: { standup: true } }));
    const failingMemory: MemoryProvider = {
      capabilities: { consolidation: "explicit", digestPruning: "explicit" },
      async pruneDigests() {
        return 0;
      },
      async save() {
        throw new Error("memory backend unavailable");
      },
      async search() {
        return [];
      },
    };
    const { ctx } = context(store, { memoryProvider: failingMemory });

    await expect(standupDigestAction.run({ space }, ctx)).resolves.toBeUndefined();

    const failures = await store.listAudit({ space, event_type: DIGEST_FAILED_EVENT });
    expect(failures).toHaveLength(1);
    expect(JSON.parse(failures[0].payload)).toEqual({ reason: "memory backend unavailable" });
  });
});
