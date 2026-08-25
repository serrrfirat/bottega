/**
 * Stale-procedure alert tests (issue #356 M4 seed): the whole feature is a
 * reactive-core behavior registration — a daily sweep flags space skills
 * that were created long ago and never read, posts one alert per procedure,
 * and records `procedure.stale_alerted` as the dedupe marker.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROCEDURE_STALE_ALERTED_EVENT, SPACE_SKILL_CREATED_EVENT } from "../../store/audit-events";
import { createStore, type Store } from "../../store/db";
import {
  DEFAULT_PROCEDURE_STALE_AFTER_MS,
  staleProcedureAlertBehavior,
} from "./stale-procedure-alert";

const stores: Store[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function freshStore(): Store {
  const dir = mkdtempSync(join(tmpdir(), "bottega-stale-procedure-"));
  dirs.push(dir);
  const store = createStore(join(dir, "store.db"));
  stores.push(store);
  return store;
}

class FakeAdapter {
  posted: Array<{ spaceId: string; text: string }> = [];
  async postMessage(spaceId: string, text: string): Promise<string | undefined> {
    this.posted.push({ spaceId, text });
    return undefined;
  }
}

const SPACE = "slack:C123";
const OLD = Date.now() - DEFAULT_PROCEDURE_STALE_AFTER_MS - 24 * 60 * 60 * 1000;

function createSkill(store: Store, name: string, ts: number): Promise<number> {
  return store.appendAudit({
    space_id: SPACE,
    actor: "agent:test",
    event_type: SPACE_SKILL_CREATED_EVENT,
    payload: JSON.stringify({ name, revision: 1 }),
    ts,
  });
}

function markRead(store: Store, name: string): Promise<number> {
  return store.appendAudit({
    space_id: SPACE,
    actor: "agent:test",
    event_type: "space_skill.read",
    payload: JSON.stringify({ name }),
  });
}

describe("staleProcedureAlertBehavior (issue #356 M4 seed)", () => {
  test("alerts once for an old never-read procedure and dedupes on the marker row", async () => {
    const store = freshStore();
    await createSkill(store, "deploy-checklist", OLD);
    const adapter = new FakeAdapter();
    const behavior = staleProcedureAlertBehavior({ store, adapter });

    await behavior.sweep!();
    expect(adapter.posted).toHaveLength(1);
    expect(adapter.posted[0]).toMatchObject({ spaceId: SPACE });
    expect(adapter.posted[0]!.text).toContain("deploy-checklist");
    const alerts = await store.listAudit({ event_type: PROCEDURE_STALE_ALERTED_EVENT });
    expect(alerts).toHaveLength(1);

    // The second sweep must not re-alert: the audit marker is the dedupe.
    await behavior.sweep!();
    expect(adapter.posted).toHaveLength(1);
    expect(await store.listAudit({ event_type: PROCEDURE_STALE_ALERTED_EVENT })).toHaveLength(1);
  });

  test("never alerts a recent or an actively-read procedure", async () => {
    const store = freshStore();
    await createSkill(store, "fresh-procedure", Date.now() - 24 * 60 * 60 * 1000);
    await createSkill(store, "well-read-procedure", OLD);
    await markRead(store, "well-read-procedure");
    const adapter = new FakeAdapter();
    const behavior = staleProcedureAlertBehavior({ store, adapter });

    await behavior.sweep!();
    expect(adapter.posted).toHaveLength(0);
    expect(await store.listAudit({ event_type: PROCEDURE_STALE_ALERTED_EVENT })).toHaveLength(0);
  });

  test("a revision restarts the clock (new created row clears staleness)", async () => {
    const store = freshStore();
    await createSkill(store, "updated-procedure", OLD);
    const adapter = new FakeAdapter();
    const behavior = staleProcedureAlertBehavior({ store, adapter });
    await behavior.sweep!();
    expect(adapter.posted).toHaveLength(1);

    // The procedure gets rewritten recently: the old alert no longer applies
    // and the fresh created row is not stale.
    await createSkill(store, "updated-procedure", Date.now());
    await behavior.sweep!();
    expect(adapter.posted).toHaveLength(1);
  });
});
