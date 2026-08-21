import { afterEach, describe, expect, test } from "bun:test";
import { App } from "@slack/bolt";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConnectionReadModel } from "../extensions/lifecycle";
import { createAudit } from "../policy/audit";
import { parseOrgConfigYaml } from "../policy/config";
import { createStore, type Store } from "../store/db";
import { createOperatorHomeService } from "./operator-home";
import { registerAppHomeHandler } from "./adapters/slack";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function freshStore(): Store {
  const root = mkdtempSync(join(tmpdir(), "bottega-operator-home-"));
  roots.push(root);
  return createStore(join(root, "home.db"));
}

type PublishedView = { user_id: string; view: { type: "home"; blocks: unknown[] } };

async function seededConnections(store: Store, viewer: string): Promise<ConnectionReadModel[]> {
  const byProvider = await Promise.all(
    ["linear", "github", "jira"].map((provider) => store.listExtensionCredentials(provider)),
  );
  return byProvider
    .flat()
    .filter((connection) => connection.scope === "org" || connection.owner === viewer)
    .map((connection): ConnectionReadModel => ({
      id: connection.id,
      provider: connection.provider,
      label: connection.provider,
      identity_label: "API key",
      scope: connection.scope,
      owner: connection.scope === "org" ? "organization" : "you",
      status: connection.status,
      revision: connection.revision,
      reconnect_needed: connection.status !== "active",
      created_at: connection.created_at,
      updated_at: connection.updated_at,
    }));
}
async function seed(store: Store, now: number): Promise<void> {

  await store.getOrCreateSpace({ platform: "slack", channel_id: "C1", name: "operations" });
  await store.getOrCreateSpace({ platform: "slack", channel_id: "C2", name: "engineering" });
  await store.createWorkItem({ space_id: "slack:C2", requester: "UOTHER", description: "raw customer prompt must stay hidden" });
  const running = await store.createWorkItem({ space_id: "slack:C1", requester: "UADMIN", description: "secret body" });
  await store.transitionWorkItem(running.id, "open", "claimed", { by: "executor" });
  await store.transitionWorkItem(running.id, "claimed", "working", { by: "executor" });
  const blocked = await store.createWorkItem({ space_id: "slack:C1", requester: "UADMIN", description: "blocked secret body" });
  await store.transitionWorkItem(blocked.id, "open", "claimed", { by: "executor" });
  await store.transitionWorkItem(blocked.id, "claimed", "working", { by: "executor" });
  await store.transitionWorkItem(blocked.id, "working", "blocked", { by: "executor", evidence: "safe evidence" });
  await store.createSchedulerJob({
    action: "standup_digest",
    cron: "0 9 * * 1",
    params: { space: "slack:C2", query: "raw query must stay hidden" },
    spaceId: "slack:C2",
    createdBy: "UADMIN",
  });
  await store.upsertExtensionCredential({
    provider: "linear",
    identityKey: "org-secret@example.test",
    owner: null,
    scope: "org",
    brokerCredentialId: 10,
  });
  await store.upsertExtensionCredential({
    provider: "github",
    identityKey: "admin-secret@example.test",
    owner: "UADMIN",
    scope: "personal",
    brokerCredentialId: 11,
  });
  await store.upsertExtensionCredential({
    provider: "jira",
    identityKey: "other-secret@example.test",
    owner: "UOTHER",
    scope: "personal",
    brokerCredentialId: 12,
  });
  await store.appendAudit({
    ts: now - 1,
    space_id: "slack:C2",
    actor: "UOTHER",
    event_type: "policy.decision",
    payload: JSON.stringify({
      tool: "bash",
      tier: "exec",
      decision: "deny",
      reason: "policy denies the tool",
      args: "raw prompt https://example.test/search?q=secret xoxb-1234567890-secret",
    }),
  });
  await store.appendAudit({
    ts: now - 2,
    space_id: "slack:C1",
    actor: "system",
    event_type: "scheduler.error",
    payload: "malformed raw body xoxb-1234567890-secret ?q=hidden",
  });
}

function textOf(view: PublishedView): string {
  return JSON.stringify(view.view.blocks);
}

describe("admin-only Slack operator Home caller surface (#320)", () => {
  test("drives the real Bolt event router, scopes two viewers, redacts rows, and dedupes unchanged refreshes", async () => {
    const now = Date.UTC(2026, 7, 21, 12);
    const store = freshStore();
    await seed(store, now);
    const audit = createAudit(store);
    const home = createOperatorHomeService({
      store,
      audit,
      orgPolicy: parseOrgConfigYaml("tools:\n  bash: deny\n"),
      setupChecks: () => [
        { name: "database", ok: true },
        { name: "proxy", ok: false },
      ],
      listConnections: (viewer) => seededConnections(store, viewer),
      pendingApprovals: () => [{ spaceId: "slack:C2", tool: "bash" }],
      memoryStatus: async (viewer) => ({ provider: "sqlite", available: true, personal: viewer === "UADMIN" ? 2 : 1, org: 3 }),
      now: () => now,
    });
    const published: PublishedView[] = [];
    const logs: string[] = [];
    const app = new App({
      signingSecret: "test",
      tokenVerificationEnabled: false,
      authorize: async () => ({ botToken: "xoxb-test-token" }),
      logger: {
        info: () => {},
        debug: () => {},
        warn: (...args: unknown[]) => void logs.push(args.join(" ")),
        error: (...args: unknown[]) => void logs.push(args.join(" ")),
        setLevel: () => {},
        getLevel: () => "info" as never,
        setName: () => {},
      },
    });
    registerAppHomeHandler(app, {
      resolveViewer: async (user) => ({ id: user, isAdmin: user === "UADMIN" || user === "UOTHER" }),
      render: (viewer) => home.render(viewer),
      publish: async (input) => void published.push(input),
      onPublished: (viewer, revision) => home.recordRead(viewer, revision),
    });
    const deliver = async (user: string) => {
      await app.processEvent({
        body: {
          type: "event_callback",
          event: { type: "app_home_opened", user, tab: "home", event_ts: `${now}.000001` },
        },
        ack: async () => {},
      });
    };

    await deliver("UADMIN");
    await deliver("UADMIN");
    await deliver("UOTHER");
    await deliver("UMEMBER");

    expect(published).toHaveLength(3);
    const admin = textOf(published[0]!);
    expect(admin).toContain("Operator Home");
    expect(admin).toContain("Setup health");
    expect(admin).toContain("Running and blocked work");
    expect(admin).toContain("Pending approvals");
    expect(admin).toContain("Schedules");
    expect(admin).toContain("Connections");
    expect(admin).toContain("Memory");
    expect(admin).toContain("Recent outcomes");
    expect(admin).toContain("github");
    expect(admin).toContain("linear");
    expect(admin).not.toContain("jira");
    expect(admin).toContain("slack:C2");
    expect(admin).toContain("policy_denied");
    expect(admin).not.toContain("raw customer prompt");
    expect(admin).not.toContain("secret body");
    expect(admin).not.toContain("raw query");
    expect(admin).not.toContain("raw prompt");
    expect(admin).not.toContain("?q=");
    expect(admin).not.toContain("xoxb-");
    expect(admin).not.toContain("example.test");

    const other = textOf(published[1]!);
    expect(other).toContain("jira");
    expect(other).toContain("linear");
    expect(other).not.toContain("github");
    const denied = textOf(published[2]!);
    expect(denied).toContain("Operator access required");
    expect(denied).not.toContain("slack:C1");
    expect(denied).not.toContain("github");

    expect(await store.listAudit({ event_type: "operator.home_read" })).toHaveLength(3);
    expect(logs).toEqual([]);
    store.close();
  });

  test("a changed revision refreshes, while a Slack API failure is bounded and retried", async () => {
    const now = Date.UTC(2026, 7, 21, 12);
    const store = freshStore();
    await seed(store, now);
    const home = createOperatorHomeService({
      store,
      audit: createAudit(store),
      orgPolicy: parseOrgConfigYaml("tools:\n  bash: deny\n"),
      setupChecks: () => [],
      listConnections: (viewer) => seededConnections(store, viewer),
      pendingApprovals: () => [],
      memoryStatus: async () => ({ provider: "sqlite", available: true, personal: 0, org: 0 }),
      now: () => now,
    });
    const published: PublishedView[] = [];
    const logs: string[] = [];
    let failPublish = true;
    const app = new App({
      signingSecret: "test",
      tokenVerificationEnabled: false,
      authorize: async () => ({ botToken: "xoxb-test-token" }),
    });
    registerAppHomeHandler(app, {
      resolveViewer: async (user) => ({ id: user, isAdmin: true }),
      render: (viewer) => home.render(viewer),
      publish: async (input) => {
        if (failPublish) {
          failPublish = false;
          throw new Error("Slack views.publish unavailable xoxb-must-not-log");
        }
        published.push(input);
      },
      onPublished: (viewer, revision) => home.recordRead(viewer, revision),
      log: (line) => logs.push(line),
    });
    const deliver = () =>
      app.processEvent({
        body: {
          type: "event_callback",
          event: { type: "app_home_opened", user: "UADMIN", tab: "home", event_ts: `${now}.000001` },
        },
        ack: async () => {},
      });

    await expect(deliver()).resolves.toBeUndefined();
    expect(published).toHaveLength(0);
    expect(logs).toEqual(["slack: operator Home publish failed"]);
    await deliver();
    expect(published).toHaveLength(1);
    await deliver();
    expect(published).toHaveLength(1);

    const changed = await store.createWorkItem({ space_id: "slack:C1", requester: "UADMIN", description: "new hidden body" });
    await store.transitionWorkItem(changed.id, "open", "claimed", { by: "executor" });
    await deliver();
    expect(published).toHaveLength(2);
    store.close();
  });
});
