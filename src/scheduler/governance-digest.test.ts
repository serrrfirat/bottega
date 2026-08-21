import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemoryEntry, MemoryProvider } from "../memory/types";
import { createAudit } from "../policy/audit";
import { loadSpacePolicy, parseOrgConfigYaml } from "../policy/config";
import { createStore, type Store } from "../store/db";
import { buildRegistry } from "./actions";
import { governanceDigestAction } from "./governance-digest";
import { tickScheduler } from "./runner";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function freshStore(): Store {
  const root = mkdtempSync(join(tmpdir(), "bottega-governance-digest-"));
  roots.push(root);
  return createStore(join(root, "governance.db"));
}

const memory: MemoryProvider = {
  capabilities: { consolidation: "explicit", digestPruning: "explicit" },
  async save(input): Promise<MemoryEntry> {
    return { id: "unused", key: input.scope, content: input.content, metadata: input.metadata ?? {}, createdAt: 0 };
  },
  async search(): Promise<MemoryEntry[]> {
    return [];
  },
  async pruneDigests(): Promise<number> {
    return 0;
  },
};

async function seedWeek(store: Store, now: number): Promise<void> {
  const audit = createAudit(store);
  const rows = [
    ["approval.resolved", { tool: "settings_org_write", approved: true, approver: "UADMIN" }],
    ["approval.resolved", { tool: "bash", approved: true, approver: "policy" }],
    ["approval.resolved", { tool: "bash", approved: false, approver: null }],
    ["policy.decision", { tool: "edit", tier: "write", decision: "deny", reason: "policy denies the tool", args: "raw prompt xoxb-1234567890-secret" }],
    ["policy.decision", { tool: "unknown", tier: "exec", decision: "deny", reason: "tool is not in the known tool table", args: "https://example.test/?q=hidden" }],
    ["extension.credential_resolved", { provider: "github", scope: "org", identity_key: "secret@example.test", credential_id: "ec1" }],
    ["extension.credential_resolved", { provider: "github", scope: "personal", identity_key: "other@example.test", credential_id: "ec2" }],
    ["settings.changed", { scope: "org", before: { secret: "hidden" }, after: { secret: "hidden" } }],
  ] as const;
  for (const [event_type, payload] of rows) {
    await audit.appendAudit({ ts: now - 1_000, space_id: "slack:CGOV", actor: "UADMIN", event_type, payload });
  }
  await audit.appendAudit({
    ts: now - 8 * 24 * 60 * 60 * 1_000,
    space_id: "slack:CGOV",
    actor: "UADMIN",
    event_type: "approval.resolved",
    payload: { tool: "old", approved: true, approver: "UOLD" },
  });
}

async function dueGovernanceJob(store: Store, now: number): Promise<void> {
  const job = await store.createSchedulerJob({
    action: "governance_digest",
    cron: "0 12 * * 5",
    params: { space: "slack:CGOV" },
    spaceId: "slack:CGOV",
    createdBy: "UADMIN",
  });
  await store.updateSchedulerNextFire(job.id, now);
}

describe("weekly governance digest caller surface (#161)", () => {
  test("registered scheduler action posts one deterministic redacted weekly summary", async () => {
    const now = Date.UTC(2026, 7, 21, 12);
    const store = freshStore();
    await store.getOrCreateSpace({ platform: "slack", channel_id: "CGOV", name: "governance" });
    await store.updatePolicy("slack:CGOV", JSON.stringify({ proactive: { governance: true } }));
    await seedWeek(store, now);
    await dueGovernanceJob(store, now);
    const audit = createAudit(store);
    const posts: Array<{ space: string; text: string }> = [];
    const orgPolicy = parseOrgConfigYaml("response_mode: always\n");

    await tickScheduler({
      store,
      audit,
      registry: buildRegistry([governanceDigestAction]),
      memoryProvider: memory,
      postMessage: async (space, text) => {
        posts.push({ space, text });
        return "1.1";
      },
      loadPolicy: (space) => loadSpacePolicy(orgPolicy, store, space),
      log: () => {},
      now: () => now,
    });

    expect(posts).toHaveLength(1);
    expect(posts[0]!.space).toBe("slack:CGOV");
    expect(posts[0]!.text).toContain("Approvals granted: 1");
    expect(posts[0]!.text).toContain("UADMIN — settings_org_write: 1");
    expect(posts[0]!.text).toContain("Automatic approvals: 1");
    expect(posts[0]!.text).toContain("Denials: 2");
    expect(posts[0]!.text).toContain("policy_denied: 1");
    expect(posts[0]!.text).toContain("unknown_tool: 1");
    expect(posts[0]!.text).toContain("Approval timeouts: 1");
    expect(posts[0]!.text).toContain("Credential use: org 1, personal 1");
    expect(posts[0]!.text).toContain("Org settings changes: 1");
    expect(posts[0]!.text).not.toContain("UOLD");
    expect(posts[0]!.text).not.toContain("raw prompt");
    expect(posts[0]!.text).not.toContain("?q=");
    expect(posts[0]!.text).not.toContain("xoxb-");
    expect(posts[0]!.text).not.toContain("example.test");
    expect(await store.listAudit({ event_type: "governance_digest.posted" })).toHaveLength(1);
    store.close();
  });

  test("disabled policy posts nothing and delivery failure is audited without escaping the action", async () => {
    const now = Date.UTC(2026, 7, 21, 12);
    const store = freshStore();
    const space = await store.getOrCreateSpace({ platform: "slack", channel_id: "CGOV", name: "governance" });
    await seedWeek(store, now);
    const audit = createAudit(store);
    const orgPolicy = parseOrgConfigYaml("response_mode: always\n");
    let calls = 0;
    const run = () =>
      governanceDigestAction.run(
        { space: space.id },
        {
          store,
          audit,
          memoryProvider: memory,
          postMessage: async () => {
            calls += 1;
            throw new Error("Slack failed xoxb-1234567890-secret");
          },
          loadPolicy: (target) => loadSpacePolicy(orgPolicy, store, target),
          log: () => {},
          now: () => now,
        },
      );

    await expect(run()).resolves.toBeUndefined();
    expect(calls).toBe(0);
    await store.updatePolicy(space.id, JSON.stringify({ proactive: { governance: true } }));
    await expect(run()).resolves.toBeUndefined();
    expect(calls).toBe(1);
    const failures = await store.listAudit({ event_type: "governance_digest.failed" });
    expect(failures).toHaveLength(1);
    expect(failures[0]!.payload).not.toContain("xoxb-");
    store.close();
  });
});
