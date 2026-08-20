/**
 * Caller-level acceptance suite for permission-aware memory scopes (issue #137).
 *
 * Drives `SpaceService.handleInboundMessage` through the real boot harness —
 * real SQLite memory provider, real driver, real memory.save + memory.search
 * tools wired with the per-session `getScopeContext` (space id + TURN
 * principal + DM/channel classification + effective `memory.team`). Only the
 * model, Slack, and filesystem are emulated (the harness's normal hermetic
 * contract).
 *
 * A BROKEN IDENTITY SEAM fails these tests: if the derived scopes leaked a
 * person's key into a channel recall, or wrongly granted a team, the
 * `memory.recalled` scope evidence and the provider-isolation assertions
 * below would catch it.
 *
 * The recall tool's server-side work is evidenced two ways:
 *  1. `memory.recalled` audit rows record exactly which logical scopes a
 *     recall queried and their counts (never query/memory content) — proving
 *     the derived-scope set (the identity seam).
 *  2. Direct provider isolation: a channel-scope (or another-team) query
 *     returns no person (or foreign-team) fact.
 */
import { describe, expect, test } from "bun:test";
import type { MemoryScopeKey } from "../../src/memory/types";
import type { StubTurn } from "./harness";
import { bootHarness, type Harness } from "./harness";

async function waitFor<T>(
  fn: () => T | undefined | null | Promise<T | undefined | null>,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value !== undefined && value !== null) return value;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await Bun.sleep(20);
  }
}

/** One scripted turn: a memory.search call (scope all) then a text reply. */
function recallTurn(query: string): StubTurn[] {
  return [
    { type: "tool_calls", calls: [{ name: "memory_search", args: { scope: "all", query } }] },
    { type: "text", text: "recalled" },
  ];
}

/** The logical scopes a `memory.recalled` row reports, keyed by kind. */
async function recalledScopes(h: Harness, actor: string, spaceId: string): Promise<Array<{ scope: string; key: string; count: number }>> {
  const rows = (await h.store.listAudit({ event_type: "memory.recalled", space: spaceId })).filter((r) => r.actor === actor);
  if (rows.length === 0) return [];
  const payload = JSON.parse(rows[rows.length - 1]!.payload) as { scopes: Array<{ scope: string; key: string; count: number }> };
  return payload.scopes;
}

/** Seed a logical-scope fact through the real provider. */
async function seed(h: Harness, scope: MemoryScopeKey, content: string): Promise<void> {
  await h.memory.save({ scope, content });
}

describe("permission-aware memory recall (issue #137, caller-level)", () => {
  test(
    "DM recall derives person + org scopes and sees both; a channel never derives a person's key",
    async () => {
      const h = await bootHarness({
        orgConfigYaml: "tools:\n  memory.search: allow\n",
        modelTurns: recallTurn("llamas"),
      });
      const dm = h.slack.dmChannelId;
      const dmSpace = `slack:${dm}`;
      const principal = h.liveSlack?.qaUserId ?? h.slack.user("owner")!;
      try {
        // A person fact + an org fact the DM should see.
        await seed(h, { kind: "person", principal }, "prefers llamas");
        await seed(h, { kind: "org" }, "the org ships with bun");

        await h.deliverMessage(dm, "remember llamas");
        await h.modelStub.waitForRequests(2);

        // Identity seam (DM): the recall derived person + org scopes.
        const scopes = await waitFor(async () => {
          const s = await recalledScopes(h, principal, dmSpace);
          return s.length ? s : undefined;
        });
        const kinds = scopes.map((s) => s.scope).sort();
        expect(kinds).toEqual(["org", "person"]);

        // Provider isolation: the person's fact is reachable only via the
        // person key — never a channel key (a channel cannot derive it).
        const personHits = await h.memory.search({ query: "llamas", scope: { kind: "person", principal } });
        expect(personHits.some((e) => e.content.includes("prefers llamas"))).toBe(true);
        const channelHits = await h.memory.search({ query: "llamas", scope: { kind: "channel", spaceId: dmSpace } });
        expect(channelHits.some((e) => e.content.includes("prefers llamas"))).toBe(false);
      } finally {
        await h.cleanup();
      }
    },
    30_000,
  );

  test(
    "channel recall derives channel + configured team + org; a channel never retrieves a person's private fact",
    async () => {
      const h = await bootHarness({
        orgConfigYaml: "tools:\n  memory.search: allow\n",
        // The ops channel carries an explicit team.
        spacePolicy: { ops: JSON.stringify({ memory: { team: "eng" } }) },
        modelTurns: recallTurn("builds"),
      });
      const channelId = h.slack.channelId("ops") ?? "C1";
      const spaceId = `slack:${channelId}`;
      // The DM channel (different space) and a different team.
      const dm = h.slack.dmChannelId;
      const dmSpace = `slack:${dm}`;
      try {
        // seed: a channel fact, a team fact, an org fact, a PERSON fact
        // (from a DM), and a fact under ANOTHER channel + ANOTHER team.
        await seed(h, { kind: "channel", spaceId }, "our channel builds weekly");
        await seed(h, { kind: "team", teamId: "eng" }, "the eng team ships on Thursdays");
        await seed(h, { kind: "org" }, "the org builds daily");
        await seed(h, { kind: "person", principal: h.slack.user("owner")! }, "the owner's private fact");
        await seed(h, { kind: "channel", spaceId: dmSpace }, "the DM's channel fact");
        await seed(h, { kind: "team", teamId: "design" }, "design team confidential fact");

        await h.deliverMessage(channelId, "how do we build?");
        await h.modelStub.waitForRequests(2);

        // Identity seam (channel): the recall derived channel + team + org —
        // NEVER the person scope, never the other channel/team.
        const scopes = await waitFor(async () => {
          const s = await recalledScopes(h, h.slack.user("owner")!, spaceId);
          return s.length ? s : undefined;
        });
        const kinds = scopes.map((s) => s.scope).sort();
      expect(kinds).toEqual(["channel", "org", "team"]);
      const teamKey = scopes.find((s) => s.scope === "team")!.key;
      // The team's audit key is the full physical composite (`team:<id>`).
      expect(teamKey).toBe("team:eng");

        // Provider isolation — the channel scope cannot reach a person's fact.
        const channelFact = await h.memory.search({ query: "private", scope: { kind: "channel", spaceId } });
        expect(channelFact.some((e) => e.content.includes("owner's private"))).toBe(false);
        // The person-scope fact lives only under the person key.
        const personHits = await h.memory.search({
          query: "private",
          scope: { kind: "person", principal: h.slack.user("owner")! },
        });
        expect(personHits.some((e) => e.content.includes("owner's private"))).toBe(true);
        // Another channel's fact is not under THIS channel's key.
        const dmsChannel = await h.memory.search({ query: "channel fact", scope: { kind: "channel", spaceId } });
        expect(dmsChannel.some((e) => e.content.includes("DM's channel"))).toBe(false);
        // Another team's fact is not under THIS team's key.
        const engTeam = await h.memory.search({ query: "confidential", scope: { kind: "team", teamId: "eng" } });
        expect(engTeam.some((e) => e.content.includes("design team"))).toBe(false);
      } finally {
        await h.cleanup();
      }
    },
    30_000,
  );

  test(
    "malformed memory.team fails closed: no team scope is granted and no team fact is recalled",
    async () => {
      const h = await bootHarness({
        orgConfigYaml: "tools:\n  memory.search: allow\n",
        // Space overlay sets an ILLEGAL team id (colon) → fail closed.
        spacePolicy: { ops: JSON.stringify({ memory: { team: "bad:team" } }) },
        modelTurns: recallTurn("secret"),
      });
      const channelId = h.slack.channelId("ops") ?? "C1";
      const spaceId = `slack:${channelId}`;
      try {
        await h.deliverMessage(channelId, "what is the team secret?");
        await h.modelStub.waitForRequests(2);

        const scopes = await waitFor(async () => {
          const s = await recalledScopes(h, h.slack.user("owner")!, spaceId);
          return s.length ? s : undefined;
        });
        const kinds = scopes.map((s) => s.scope).sort();
        // Fail closed: NO team scope derived for the malformed team value.
        expect(kinds).toEqual(["channel", "org"]);
      } finally {
        await h.cleanup();
      }
    },
    30_000,
  );

  test(
    "legacy physical user rows remain readable as the matching person, and a channel cannot see them",
    async () => {
      const h = await bootHarness({
        orgConfigYaml: "tools:\n  memory.search: allow\n",
      });
      const channelId = h.slack.channelId("ops") ?? "C1";
      const spaceId = `slack:${channelId}`;
      const principal = h.slack.user("owner")!;
      try {
        // Seed a LEGACY physical row: scope='user', principal=<id> (the
        // pre-#137 format). It must decode to {kind:"person", principal}.
        h.store
          .getDb()
          .query(
            "INSERT INTO memories (id, scope, principal, content, metadata_json, created_at) VALUES (?, 'user', ?, ?, '{}', ?)",
          )
          .run("mem_legacy", principal, "legacy personal fact", Date.now());

        // The matching person can read it.
        const personHits = await h.memory.search({ query: "legacy", scope: { kind: "person", principal } });
        expect(personHits.some((e) => e.content.includes("legacy personal fact"))).toBe(true);

        // A channel (whose derived scopes are channel + org) cannot retrieve it.
        const channelHits = await h.memory.search({ query: "legacy", scope: { kind: "channel", spaceId } });
        expect(channelHits.some((e) => e.content.includes("legacy personal fact"))).toBe(false);

        // And a different person cannot read the legacy row either.
        const other = await h.memory.search({ query: "legacy", scope: { kind: "person", principal: "someone-else" } });
        expect(other.some((e) => e.content.includes("legacy personal fact"))).toBe(false);
      } finally {
        await h.cleanup();
      }
    },
    30_000,
  );

  test("recall audit carries requester/space/scopes/counts and never query or memory content", async () => {
    const h = await bootHarness({
      orgConfigYaml: "tools:\n  memory.search: allow\n",
      modelTurns: recallTurn("supersecretquery"),
    });
    const channelId = h.slack.channelId("ops") ?? "C1";
    const spaceId = `slack:${channelId}`;
    const principal = h.slack.user("owner")!;
    try {
      await seed(h, { kind: "channel", spaceId }, "classified channels-only fact");
      await h.deliverMessage(channelId, "supersecretquery contents");
      await h.modelStub.waitForRequests(2);

      const rows = await waitFor(async () => {
        const all = await h.audit.listAudit({ event_type: "memory.recalled" });
        return all.length ? all : undefined;
      });
      const row = rows[rows.length - 1]!;
      expect(row.actor).toBe(principal);
      expect(row.space_id).toBe(spaceId);
      const payload = JSON.parse(row.payload) as { scopes?: unknown };
      // Scopes + counts present; the query and the fact content are absent.
      expect(payload.scopes).toBeDefined();
      expect(row.payload).not.toContain("supersecretquery");
      expect(row.payload).not.toContain("classified channels-only fact");
    } finally {
      await h.cleanup();
    }
  });
});