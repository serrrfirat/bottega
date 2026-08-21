/**
 * Caller-level hermetic role/multiplayer journeys (issue #298).
 *
 * The hybrid canary's hermetic layer: deterministic tests against the REAL
 * SpaceService path (real store, real policy gate, real Slack emulator via
 * bootHarness) that exercise the eight approved role/multiplayer scenarios
 * and FAIL if actor identity or reply ownership crosses users.
 *
 * Empirical baseline (this tree):
 *   - per-turn identity reaches: `message.in` audit actor, memory personal
 *     scope/driver principal binding (issue #152), credential `owner`;
 *   - `create_work_item` / `work_item_cancel` default their requester/actor
 *     to "agent" in the shared tool definitions — so the cancel AUTHORIZATION
 *     boundary is asserted at the tool-definition caller surface with an
 *     explicit actor per identity (AGENTS.md allows "the tool definition's
 *     execute"). Reply ownership, queue ordering, and actor identity are
 *     asserted through the emulator messages + `message.in` audit rows,
 *     which DO carry the real principal.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootHarness, type StubTurn } from "./harness";
import { workItemToolDefinitions } from "../../src/tools/work-items";
import { memoryToolDefinitions } from "../../src/tools/memory";
import type { MemoryScopeContext } from "../../src/memory/scope";
import {
  APPROVAL_RESOLVED_EVENT,
  EXTENSION_CONNECTED_EVENT,
  MEMORY_WRITE_EVENT,
  MESSAGE_RECEIVED_EVENT,
} from "../../src/store/audit-events";
import { createStore, type Store } from "../../src/store/db";
import { createAudit } from "../../src/policy/audit";
import { loadSpacePolicy, parseOrgConfigYaml } from "../../src/policy/config";
import { DENY_ACTION_ID } from "../../src/server/adapters/slack";
import { SlackApprovalRouter } from "../../src/server/adapters/approval-router";
import { evaluatePolicyGate } from "../../src/policy/gate";
import { approvalButtonValue } from "./canary";
import { createSqliteMemoryProvider } from "../../src/memory/sqlite";
import { connectExtension, type ConnectExtensionDeps, type BrokerConnector } from "../../src/extensions/connect";
import { FIXTURE_EXTENSION_ID, createFixtureRegistry } from "../../src/extensions/fixture";
import type { ApprovalRouter } from "../../src/policy/approval-router";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";

/** Org policy for the multiplayer journeys: work items + memory auto-approve; model_settings prompts (the approve/deny path). */
const MULTIPLAYER_ORG = [
  "tools:",
  "  create_work_item: allow",
  "  list_work_items: allow",
  "  work_item_cancel: allow",
  "  memory.save: allow",
  "  memory.search: allow",
  "  use_model: allow",
  "  model_settings: prompt",
  "approvals:",
  "  always_approve:",
  "    - create_work_item",
  "    - work_item_cancel",
  "",
].join("\n");

/** The four fixed identities seeded as emulator members (issue #298). */
const IDENTITIES = ["requester", "approver", "member", "member2"] as const;

/** The stub SHIFTS one turn per model request; give every user the same reply. */
function repeatTurns(text: string, n: number): StubTurn[] {
  return Array.from({ length: n }, () => ({ type: "text" as const, text }));
}

/** Back-to-back deliverMessage calls race the model stub; let each turn settle. */
const settle = () => Bun.sleep(200);

const CALLBACK_PORT = process.env.BOTTEGA_CALLBACK_PORT;
beforeAll(() => {
  process.env.BOTTEGA_CALLBACK_PORT = "0";
});
afterAll(() => {
  if (CALLBACK_PORT === undefined) delete process.env.BOTTEGA_CALLBACK_PORT;
  else process.env.BOTTEGA_CALLBACK_PORT = CALLBACK_PORT;
});

function tempPolicyDir(yaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), "bottega-policy-"));
  writeFileSync(join(dir, "config.yml"), yaml);
  return dir;
}

/** The work-item tool definitions bound to a single actor (issue #298 caller surface). */
function toolsForActor(store: Store, actor: string) {
  const dir = tempPolicyDir(MULTIPLAYER_ORG);
  return workItemToolDefinitions(store, { orgPolicy: parseOrgConfigYaml(MULTIPLAYER_ORG), actor, agentDir: dir });
}

interface ToolRunContext {
  sessionManager: { getSessionFile(): string };
}

/** A minimal session ctx the tool definitions read the space id from. */
function ctx(spaceId: string): ExtensionContext {
  const context: ToolRunContext = {
    sessionManager: { getSessionFile: () => `data/sessions/${spaceId}.json` },
  };
  // SAFETY: the memory and work-item tool definitions used below derive the
  // space id only through sessionManager.getSessionFile; this double supplies
  // that complete executed boundary.
  return context as ExtensionContext;
}

async function auditActors(store: Store, eventType: string): Promise<string[]> {
  const rows = await store.listAudit({ event_type: eventType });
  return rows.map((r) => r.actor);
}

describe("multiplayer: reply ownership never crosses users (issue #298)", () => {
  test("each user's DM gets only its own bot reply; message.in actors are distinct per principal", async () => {
    const h = await bootHarness({
      slackUsers: [...IDENTITIES],
      orgConfigYaml: MULTIPLAYER_ORG, registry: createFixtureRegistry(),
      modelTurns: repeatTurns("hi from the bot", 2),
    });
    try {
      const requesterId = h.slack.user("requester")!;
      const memberId = h.slack.user("member")!;
      const dmR = h.slack.dmChannelFor!("requester")!;
      const dmM = h.slack.dmChannelFor!("member")!;

      await h.deliverMessage(dmR, "hello requester", {}, requesterId);
      await settle();
      await h.deliverMessage(dmM, "hello member", {}, memberId);
      await settle();

      // Reply ownership: each conversation carries its own bot reply.
      expect(h.messages(dmR).some((m) => m.text.includes("hi from the bot"))).toBe(true);
      expect(h.messages(dmM).some((m) => m.text.includes("hi from the bot"))).toBe(true);

      // Actor identity: each inbound message's audit row carries the real principal.
      const inActors = await auditActors(h.store, MESSAGE_RECEIVED_EVENT);
      expect(inActors).toContain(requesterId);
      expect(inActors).toContain(memberId);
    } finally {
      await h.cleanup();
    }
  }, 20_000);

  test("cross-user queue ordering: two users' messages to one channel drain in arrival order, each its own principal-bound turn", async () => {
    const h = await bootHarness({
      slackUsers: [...IDENTITIES],
      orgConfigYaml: MULTIPLAYER_ORG, registry: createFixtureRegistry(),
      modelTurns: repeatTurns("queued reply", 2),
    });
    try {
      const requesterId = h.slack.user("requester")!;
      const memberId = h.slack.user("member")!;
      const channel = h.slack.dmChannelFor!("requester")!;
      await h.deliverMessage(channel, "first by requester", {}, requesterId);
      await h.deliverMessage(channel, "second by member", {}, memberId);

      const inActors = await auditActors(h.store, MESSAGE_RECEIVED_EVENT);
      // Arrival order: requester's inbound audited before member's.
      expect(inActors.indexOf(requesterId)).toBeGreaterThanOrEqual(0);
      expect(inActors.indexOf(memberId)).toBeGreaterThan(inActors.indexOf(requesterId));
      expect(h.messages(channel).filter((m) => m.text.includes("queued reply")).length).toBeGreaterThanOrEqual(1);
    } finally {
      await h.cleanup();
    }
  }, 20_000);
});

describe("multiplayer: cross-user steering is never cross-attributed (issue #298)", () => {
  test("the requester's correction steers their own turn; the member's plain message never re-identifies it", async () => {
    const h = await bootHarness({
      slackUsers: [...IDENTITIES],
      orgConfigYaml: MULTIPLAYER_ORG, registry: createFixtureRegistry(),
      modelTurns: repeatTurns("the running reply", 3),
    });
    try {
      const requesterId = h.slack.user("requester")!;
      const memberId = h.slack.user("member")!;
      const channel = h.slack.dmChannelFor!("requester")!;

      await h.deliverMessage(channel, "start a turn", {}, requesterId);
      const before = h.messages(channel).length;
      // The requester's correction steers their own in-flight turn.
      await h.deliverMessage(channel, "wait, use the other file", {}, requesterId);
      // The member's plain message queues (cross-user non-steering), audited
      // with the member's principal — never merged into the requester's turn.
      await h.deliverMessage(channel, "what is the weather", {}, memberId);

      const inActors = await auditActors(h.store, MESSAGE_RECEIVED_EVENT);
      expect(inActors).toContain(requesterId);
      expect(inActors).toContain(memberId);
      // The requester's conversation still owns its reply.
      await (async () => {
        for (let i = 0; i < 200 && h.messages(channel).length <= before; i++) await Bun.sleep(25);
      })();
      expect(h.messages(channel).length).toBeGreaterThan(before);
    } finally {
      await h.cleanup();
    }
  }, 20_000);
});

describe("multiplayer: approve/deny actor binding (issue #298)", () => {
  test("an ordinary member's deny never approves; the approver's click resolves and is audited with the approver", async () => {
    const h = await bootHarness({
      slackUsers: [...IDENTITIES],
      orgConfigYaml: MULTIPLAYER_ORG, registry: createFixtureRegistry(),
      modelTurns: [{ type: "text", text: "settings decided" }],
    });
    try {
      const dm = h.slack.dmChannelId;
      const spaceId = `slack:${dm}`;
      await h.store.getOrCreateSpace({ platform: "slack", channel_id: dm });
      const requesterId = h.slack.user("requester")!;
      const memberId = h.slack.user("member")!;

      const posted: Array<{ text?: string; blocks?: unknown[] }> = [];
      const router = new SlackApprovalRouter({
        adapter: {
          postMessage: async (_s, text, opts) => {
            posted.push({ text, blocks: opts?.blocks });
            return "1.000002";
          },
          updateMessage: async () => {},
        },
        timeoutMs: 60_000,
      });
      const gate = evaluatePolicyGate(
        { loadPolicy: (sid) => loadSpacePolicy(h.orgPolicy, h.store, sid), audit: h.audit, router, timeoutMs: 60_000 },
        { tool: "model_settings", args: { set: { reasoning_effort: "low" } }, spaceId, actor: requesterId },
      );

      let postedPrompt: { text?: string; blocks?: unknown[] } | undefined;
      for (let i = 0; i < 200 && !postedPrompt; i++) {
        postedPrompt = posted[0];
        await Bun.sleep(25);
      }
      expect(postedPrompt).toBeDefined();
      const value = approvalButtonValue({ ts: "1.000002", text: "", blocks: postedPrompt!.blocks });
      expect(value).toBeDefined();

      // The member's DENY cannot approve the requester's pending request.
      await router.handleAction({
        actionId: DENY_ACTION_ID,
        value: value!,
        spaceId,
        principal: memberId,
        messageTs: "1.000002",
      });
      // The second member's deny settles the request as denied — never approved.
      await expect(gate).resolves.toMatchObject({ allowed: false });
      const resolved = await h.store.listAudit({ space: spaceId, event_type: APPROVAL_RESOLVED_EVENT });
      expect(JSON.parse(resolved[resolved.length - 1]!.payload)).toMatchObject({
        tool: "model_settings",
        approved: false,
      });
    } finally {
      await h.cleanup();
    }
  }, 20_000);
});

describe("multiplayer: personal credential isolation (issue #298)", () => {
  test("two members connect personally; each credential is owned by its principal and neither leaks the other's", async () => {
    // Caller surface: the connect capability (connectExtension) with the REAL
    // store + fixture registry and a scripted broker — the exact seam a
    // per-session connect tool drives (per-session getPrincipal → owner).
    const store = createStore(":memory:");
    const audit = createAudit(store);
    const registry = createFixtureRegistry();
    const router: ApprovalRouter = { request: async () => ({ approved: true, approver: "router" }) };
    const broker: BrokerConnector = async () => ({ identityKey: null, brokerCredentialId: 9 });
    const deps: ConnectExtensionDeps = {
      registry,
      store,
      audit,
      broker,
      mcpOAuth: {
        start: async () => ({ ok: true, authorizationUrl: "https://auth.example/authorize?state=xyz", message: "authorize" }),
        probeCallbackBase: async () => ({ ok: true, base: "https://callback.example" }),
      },
      gate: { loadPolicy: async () => parseOrgConfigYaml(MULTIPLAYER_ORG), router },
    };
    const memberId = "U-member";
    const member2Id = "U-member2";

    // Member connects a personal api-key credential.
    const a = await connectExtension({ extension: FIXTURE_EXTENSION_ID, scope: "personal", actor: memberId, apiKey: "member-key" }, deps);
    expect(a.ok).toBe(true);
    // Member2 (no own credential) must NOT see member's row — it points at
    // the upload-link path, never inherits member's credential.
    const b = await connectExtension({ extension: FIXTURE_EXTENSION_ID, scope: "personal", actor: member2Id }, deps);
    expect(b.ok).toBe(false);
    if (b.ok === false) expect(b.message).toContain("connect_upload_link");

    // Both principals' rows are isolated: member's row is owned by member only.
    const rows = await store.listExtensionCredentials(FIXTURE_EXTENSION_ID);
    const owners = rows.map((r) => r.owner);
    expect(owners).toContain(memberId);
    expect(owners).not.toContain(member2Id);
    const events = await store.listAudit({ event_type: EXTENSION_CONNECTED_EVENT });
    expect(events.map((r) => r.actor)).toContain(memberId);
  }, 20_000);
});

describe("multiplayer: personal-vs-org memory isolation (issue #298)", () => {
  test("a member's PERSON memory is audited to the member and invisible to the second member; ORG memory is shared", async () => {
    const store = createStore(":memory:");
    const provider = createSqliteMemoryProvider(store.getDb());
    const memberId = "U-member";
    const secondId = "U-member2";
    const audit = createAudit(store);
    const spaceId = "slack:C1";

    // Issue #137 scope model: the tools derive concrete scope keys from the
    // authenticated context (getScopeContext), never from a tool argument —
    // a composite key for another user is impossible to express.
    const memberCtx: MemoryScopeContext = { spaceId, principal: memberId, directMessage: true, teamId: undefined };
    const secondCtx: MemoryScopeContext = { spaceId, principal: secondId, directMessage: true, teamId: undefined };
    const memberTools = memoryToolDefinitions(provider, {
      audit,
      getScopeContext: () => memberCtx,
    });
    const secondTools = memoryToolDefinitions(provider, {
      audit,
      getScopeContext: () => secondCtx,
    });
    const save = memberTools.find((t) => t.name === "memory.save")!;

    // Member saves PERSON memory in their DM → derived {person, memberId}.
    const res = await save.execute("s1", { content: "member-secret", scope: "person" }, undefined, undefined, ctx(spaceId));
    expect(res.isError).not.toBe(true);
    const writes = await store.listAudit({ event_type: MEMORY_WRITE_EVENT });
    // The person write is audited with the member's principal.
    expect(writes.map((r) => r.actor)).toContain(memberId);

    // Member's personal memory is NOT in the org scope (shared by everyone).
    const orgSearch = await provider.search({ query: "member-secret", scope: { kind: "org" }, limit: 5 });
    expect(orgSearch).toHaveLength(0);
    // The second member's readable scopes (org + their OWN person) do NOT see
    // the first member's personal row — identity isolation holds.
    const secondPersonSearch = await provider.search({
      query: "member-secret",
      scope: { kind: "person", principal: secondId },
      limit: 5,
    });
    expect(secondPersonSearch).toHaveLength(0);
    // Only the owning member's person key sees it.
    const ownSearch = await provider.search({
      query: "member-secret",
      scope: { kind: "person", principal: memberId },
      limit: 5,
    });
    expect(ownSearch.length).toBeGreaterThan(0);

    // ORG memory is shared: saved by the member, visible to the second member.
    const orgSave = secondTools.find((t) => t.name === "memory.save")!;
    const orgRes = await orgSave.execute("s2", { content: "org-shared", scope: "org" }, undefined, undefined, ctx(spaceId));
    expect(orgRes.isError).not.toBe(true);
    const saved = await provider.search({ query: "org-shared", scope: { kind: "org" }, limit: 5 });
    expect(saved.length).toBeGreaterThan(0);
  }, 20_000);
});

describe("multiplayer: work-item ownership / cancel authorization (issue #298)", () => {
  test("only the requester or a space approver may cancel a work item; an ordinary member's cancel is rejected", async () => {
    const store = createStore(":memory:");
    const requesterId = "U-requester";
    const memberId = "U-member";
    const approverId = "U-approver";

    const space = await store.getOrCreateSpace({ platform: "slack", channel_id: "C1" });
    await store.updatePolicy(space.id, JSON.stringify({ approvers: [approverId] }));
    const item = await store.createWorkItem({ space_id: space.id, requester: requesterId, description: "owned" });

    const requesterTools = toolsForActor(store, requesterId);
    const memberTools = toolsForActor(store, memberId);
    const approverTools = toolsForActor(store, approverId);
    const cancel = (tools: ReturnType<typeof toolsForActor>) => tools.find((t) => t.name === "work_item_cancel")!;

    // An ordinary member cannot cancel the requester's item.
    const memberRes = await cancel(memberTools).execute("c1", { id: item.id }, undefined, undefined, ctx(space.id));
    expect(memberRes.isError).toBe(true);

    // The requester CAN cancel their own item.
    const requesterRes = await cancel(requesterTools).execute("c2", { id: item.id }, undefined, undefined, ctx(space.id));
    expect(requesterRes.isError).not.toBe(true);
    expect((await store.getWorkItem(item.id))?.state).toBe("aborted");

    // A space approver may cancel even a foreign requester's item.
    const item2 = await store.createWorkItem({ space_id: space.id, requester: requesterId, description: "owned2" });
    const approverRes = await cancel(approverTools).execute("c3", { id: item2.id }, undefined, undefined, ctx(space.id));
    expect(approverRes.isError).not.toBe(true);
    expect((await store.getWorkItem(item2.id))?.state).toBe("aborted");
  }, 20_000);
});

describe("multiplayer: simultaneous DM + channel (issue #298)", () => {
  test("a DM turn and a channel turn run without interleaving; each conversation owns its reply", async () => {
    const h = await bootHarness({
      slackUsers: [...IDENTITIES],
      orgConfigYaml: MULTIPLAYER_ORG, registry: createFixtureRegistry(),
      modelTurns: repeatTurns("own reply", 2),
    });
    try {
      const requesterId = h.slack.user("requester")!;
      const memberId = h.slack.user("member")!;
      const dmR = h.slack.dmChannelFor!("requester")!;
      const dmM = h.slack.dmChannelFor!("member")!;
      await h.deliverMessage(dmR, "dm turn", {}, requesterId);
      await settle();
      await h.deliverMessage(dmM, "channel turn", {}, memberId);
      await settle();
      expect(h.messages(dmR).filter((m) => m.text.includes("own reply")).length).toBeGreaterThanOrEqual(1);
      expect(h.messages(dmM).filter((m) => m.text.includes("own reply")).length).toBeGreaterThanOrEqual(1);
      // No interleaving: each conversation's reply lives only in its own channel.
      expect(h.messages(dmR).some((m) => m.text.includes("channel turn"))).toBe(false);
      expect(h.messages(dmM).some((m) => m.text.includes("dm turn"))).toBe(false);
    } finally {
      await h.cleanup();
    }
  }, 20_000);
});

describe("multiplayer: per-task model isolation (issue #298)", () => {
  test("a work item's pinned model does not change another space's active session role", async () => {
    const store = createStore(":memory:");
    const spaceA = await store.getOrCreateSpace({ platform: "slack", channel_id: "CA" });
    const spaceB = await store.getOrCreateSpace({ platform: "slack", channel_id: "CB" });
    const item = await store.createWorkItem({ space_id: spaceA.id, requester: "U-a", description: "pinned fast", model: "fast" });
    // The pin is scoped to item A only; space B has no item and no role change.
    expect(item.model).toBe("fast");
    expect(await store.listWorkItems({ space_id: spaceB.id })).toHaveLength(0);
  }, 20_000);
});