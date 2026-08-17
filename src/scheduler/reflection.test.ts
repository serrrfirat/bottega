import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteMemoryProvider } from "../memory/sqlite";
import type { MemoryProvider } from "../memory/types";
import { createAudit } from "../policy/audit";
import { defaultPolicy, type ResponseMode } from "../policy/config";
import {
  DIGEST_FAILED_EVENT,
  EXTENSION_CALL_EVENT,
  MEMORY_WRITE_EVENT,
  MESSAGE_DROPPED_EVENT,
  WORK_ITEM_FAILED_EVENT,
  WORK_ITEM_TRANSITION_EVENT,
} from "../store/audit-events";
import { createStore, type Store, type WorkItemState } from "../store/db";
import { sha256Hex } from "../tools/memory";
import { reflectionAction } from "./reflection";
import type { SchedulerActionContext } from "./types";

const FIXED_NOW = Date.UTC(2026, 7, 17, 18, 45);
const DAY_START = Date.UTC(2026, 7, 17);
const DATE = "2026-08-17";
const stores: Store[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function freshStore(): Store {
  const dir = mkdtempSync(join(tmpdir(), "bottega-reflection-"));
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

function context(
  store: Store,
  options: { responseMode?: ResponseMode; memoryProvider?: MemoryProvider } = {},
): SchedulerActionContext {
  return {
    store,
    audit: createAudit(store),
    memoryProvider: options.memoryProvider ?? createSqliteMemoryProvider(store.getDb()),
    async postMessage() {
      return undefined;
    },
    async loadPolicy() {
      return { ...defaultPolicy(), responseMode: options.responseMode ?? "always" };
    },
    log() {},
    now: () => FIXED_NOW,
  };
}

async function createSpace(store: Store, channel: string, policyJson: string): Promise<string> {
  const space = await store.getOrCreateSpace({ platform: "slack", channel_id: channel });
  await store.updatePolicy(space.id, policyJson);
  return space.id;
}

function reflectionRows(store: Store): Array<{ id: string; content: string; metadata_json: string }> {
  return store
    .getDb()
    .query(`SELECT id, content, metadata_json FROM memories WHERE metadata_json LIKE '%"kind":"reflection"%' ORDER BY rowid`)
    .all() as Array<{ id: string; content: string; metadata_json: string }>;
}

describe("reflectionAction (issue #93)", () => {
  test("honors both the per-space opt-in and the always response-mode gate", async () => {
    const disabledStore = freshStore();
    const disabledSpace = await createSpace(disabledStore, "DISABLED", '{"proactive": [');
    await reflectionAction.run({ space: disabledSpace }, context(disabledStore));
    expect(reflectionRows(disabledStore)).toHaveLength(0);

    const mentionStore = freshStore();
    const mentionSpace = await createSpace(
      mentionStore,
      "MENTION",
      JSON.stringify({ proactive: { reflection: true } }),
    );
    await reflectionAction.run({ space: mentionSpace }, context(mentionStore, { responseMode: "request-only" }));
    expect(reflectionRows(mentionStore)).toHaveLength(0);
  });

  test("derives factual finished, blocked, error, and volume entries with audited metadata", async () => {
    const store = freshStore();
    const space = await createSpace(store, "ACTIVE", JSON.stringify({ proactive: { reflection: true } }));
    insertWorkItem(store, {
      id: "wi_finished",
      space,
      state: "done",
      description: "Ship digest action",
      result: JSON.stringify({ pr_url: "https://github.com/acme/repo/pull/12" }),
      updatedAt: DAY_START + 1_000,
    });
    insertWorkItem(store, {
      id: "wi_blocked",
      space,
      state: "blocked",
      description: "Publish deployment",
      evidence: JSON.stringify([{ kind: "note", url: "missing production access" }]),
      updatedAt: DAY_START + 2_000,
    });
    await store.appendAudit({
      ts: DAY_START + 3_000,
      space_id: space,
      actor: "executor",
      event_type: WORK_ITEM_TRANSITION_EVENT,
      payload: JSON.stringify({ from: "review", to: "done", by: "executor", id: "wi_finished" }),
    });
    await store.appendAudit({
      ts: DAY_START + 4_000,
      space_id: space,
      actor: "executor",
      event_type: WORK_ITEM_FAILED_EVENT,
      payload: JSON.stringify({ id: "wi_blocked", error: "permission denied" }),
    });
    await store.appendAudit({
      ts: DAY_START + 4_500,
      space_id: space,
      actor: "scheduler",
      event_type: DIGEST_FAILED_EVENT,
      payload: JSON.stringify({ reason: "digest timeout" }),
    });
    await store.appendAudit({
      ts: DAY_START + 5_000,
      space_id: space,
      actor: "server",
      event_type: MESSAGE_DROPPED_EVENT,
      payload: JSON.stringify({ reason: "duplicate", ts: "1" }),
    });
    await store.appendAudit({
      ts: DAY_START + 6_000,
      space_id: space,
      actor: "extension",
      event_type: EXTENSION_CALL_EVENT,
      payload: JSON.stringify({ extension: "github", tool: "merge", decision: "deny" }),
    });
    await store.appendAudit({
      ts: DAY_START + 7_000,
      space_id: space,
      actor: "server",
      event_type: "message.in",
      payload: "{}",
    });
    await store.appendAudit({
      ts: DAY_START + 8_000,
      space_id: space,
      actor: "server",
      event_type: "message.in",
      payload: "{}",
    });

    await reflectionAction.run({ space }, context(store));

    const rows = reflectionRows(store);
    expect(rows).toHaveLength(4);
    const byTopic = new Map(
      rows.map((row) => {
        const metadata = JSON.parse(row.metadata_json) as Record<string, string>;
        expect(metadata).toEqual({ kind: "reflection", space, date: DATE, topic: metadata.topic });
        return [metadata.topic, row] as const;
      }),
    );
    expect([...byTopic.keys()]).toEqual(["finished", "blocked", "errors", "volume"]);
    expect(byTopic.get("finished")!.content).toContain("wi_finished");
    expect(byTopic.get("finished")!.content).toContain("Ship digest action");
    expect(byTopic.get("blocked")!.content).toContain("wi_blocked");
    expect(byTopic.get("blocked")!.content).toContain("missing production access");
    expect(byTopic.get("blocked")!.content).toContain("permission denied");
    expect(byTopic.get("errors")!.content).toContain("message_dropped");
    expect(byTopic.get("errors")!.content).toContain("digest timeout");
    expect(byTopic.get("errors")!.content).toContain("extension.call");
    expect(byTopic.get("errors")!.content).toContain("deny");
    expect(byTopic.get("volume")!.content).toContain("2 inbound messages");

    const writes = await store.listAudit({ space, event_type: MEMORY_WRITE_EVENT });
    expect(writes).toHaveLength(4);
    for (const row of rows) {
      const write = writes.find((candidate) => JSON.parse(candidate.payload).id === row.id);
      expect(write).toBeDefined();
      expect(JSON.parse(write!.payload)).toEqual({
        scope: "org",
        principal: null,
        id: row.id,
        content_hash: sha256Hex(row.content),
      });
    }
  });

  test("writes nothing when the current UTC day has no derivable activity", async () => {
    const store = freshStore();
    const space = await createSpace(store, "EMPTY", JSON.stringify({ proactive: { reflection: true } }));
    insertWorkItem(store, {
      id: "wi_old_done",
      space,
      state: "done",
      description: "Finished before today",
      result: JSON.stringify({ pr_url: "https://github.com/acme/repo/pull/2" }),
      updatedAt: DAY_START - 1,
    });
    await store.appendAudit({
      ts: DAY_START - 1,
      space_id: space,
      actor: "server",
      event_type: "message.in",
      payload: "{}",
    });

    await reflectionAction.run({ space }, context(store));

    expect(reflectionRows(store)).toHaveLength(0);
    expect(await store.listAudit({ space, event_type: MEMORY_WRITE_EVENT })).toHaveLength(0);
  });

  test("audits a failure and never throws past the runner", async () => {
    const store = freshStore();
    const space = await createSpace(store, "FAIL", JSON.stringify({ proactive: { reflection: true } }));
    await store.appendAudit({
      ts: DAY_START + 1_000,
      space_id: space,
      actor: "server",
      event_type: "message.in",
      payload: "{}",
    });
    const failingMemory: MemoryProvider = {
      async save() {
        throw new Error("reflection memory unavailable");
      },
      async search() {
        return [];
      },
    };

    await expect(
      reflectionAction.run({ space }, context(store, { memoryProvider: failingMemory })),
    ).resolves.toBeUndefined();

    const failures = await store.listAudit({ space, event_type: DIGEST_FAILED_EVENT });
    expect(failures).toHaveLength(1);
    expect(JSON.parse(failures[0].payload)).toEqual({ reason: "reflection memory unavailable" });
  });
});
