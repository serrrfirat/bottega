/**
 * Journey 4 (issue #69): the RESTRICTED real-SDK session proves the space
 * agent's live surface. `createOmpSdkDriver` builds every session with
 * `restrictToolNames: true`; the OMP SDK (sdk.ts) only evaluates inline
 * extension factories when `restrictToolNames` is false, so extension-only
 * wiring (the policy gate, work-item tools, memory tools, the memory-context
 * injection extension) is INERT in production sessions. This journey drives
 * the REAL `createAgentSession` through the e2e harness and pins the
 * driver-level replacement wiring: the gate fires on every gated tool call
 * (decision + audit + approval), the work-item/memory tools are present,
 * built-ins stay callable THROUGH the gate, and the memory-context injection
 * rides the driver's appendSystemPrompt seam.
 *
 * All assertions are observable-contract: audit rows, durable state, and the
 * model request the stub actually received.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { bootHarness, type Harness, type StubTurn } from "./harness";
import { APPROVAL_RESOLVED_EVENT, POLICY_DECISION_EVENT } from "../../src/store/audit-events";

const dirs: Array<{ cleanup(): Promise<void> }> = [];
afterAll(async () => {
  for (const h of dirs.splice(0)) await h.cleanup();
});

async function harness(turns: StubTurn[], orgConfigYaml: string): Promise<Harness> {
  const h = await bootHarness({ modelTurns: turns, orgConfigYaml });
  dirs.push(h);
  return h;
}

/** Audit rows for one event type, payload parsed. */
async function auditRows(h: Harness, eventType: string) {
  const rows = (await h.audit.listAudit({})).filter((r) => r.event_type === eventType);
  return rows.map((row) => JSON.parse(row.payload) as Record<string, unknown>);
}

/** Polls the emulator for an outbound message (posts land a beat after the turn). */
async function waitForReply(h: Harness, text: string, timeoutMs = 5_000): Promise<unknown> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const reply = h.messages(h.slack.dmChannelId).find((m) => m.text === text);
    if (reply) return reply;
    await Bun.sleep(50);
  }
  return undefined;
}

describe("journey 4: restricted real-SDK session (issue #69)", () => {
  test(
    "the policy gate denies a gated tool call in a restricted session (decision + audit, no side effect)",
    async () => {
      const h = await harness(
        [
          { type: "tool_calls", calls: [{ name: "memory.save", args: { scope: "org", content: "denied payload" } }] },
          { type: "text", text: "blocked" },
        ],
        "tools:\n  memory.save: deny\n",
      );
      try {
        await h.deliverMessage(h.slack.dmChannelId, "save this");
        await h.modelStub.waitForRequests(2);

        // The gate decision is audited with the deny reason...
        const decisions = await auditRows(h, POLICY_DECISION_EVENT);
        const saveDecision = decisions.find((row) => row.tool === "memory.save");
        expect(saveDecision).toBeDefined();
        expect(saveDecision!.decision).toBe("deny");

        // ...and the denied call never ran: nothing reached the provider.
        const found = await h.memory.search({ query: "denied", scope: "org" });
        expect(found.map((e) => e.content)).not.toContain("denied payload");
      } finally {
        await h.cleanup();
      }
    },
    30_000,
  );

  test(
    "exec-tier work-item tools are present and cross the approval router in a restricted session",
    async () => {
      const h = await harness(
        [
          {
            type: "tool_calls",
            calls: [{ name: "create_work_item", args: { description: "fix the flaky checkout" } }],
          },
          { type: "text", text: "queued" },
        ],
        // Fail-closed default: unlisted tools deny, so the org config
        // explicitly allows the exec-tier queue tool.
        "tools:\n  create_work_item: allow\n",
      );
      try {
        await h.deliverMessage(h.slack.dmChannelId, "handle: fix the flaky checkout");
        await h.modelStub.waitForRequests(2);

        // Exec tier → ask-human → the harness's auto-approving router
        // resolves it; the item lands in the queue.
        const rows = h.store.getDb().query("SELECT id FROM work_items WHERE description = ?");
        const items = rows.all("fix the flaky checkout") as Array<{ id: string }>;
        expect(items.length).toBe(1);

        const decisions = await auditRows(h, POLICY_DECISION_EVENT);
        const createDecision = decisions.find((row) => row.tool === "create_work_item");
        expect(createDecision).toBeDefined();
        expect(createDecision!.decision).toBe("ask-human");
        expect(createDecision!.tier).toBe("exec");

        const resolutions = await auditRows(h, APPROVAL_RESOLVED_EVENT);
        expect(resolutions.some((row) => row.tool === "create_work_item" && row.approved === true)).toBe(true);
      } finally {
        await h.cleanup();
      }
    },
    30_000,
  );

  test(
    "built-in read stays callable through the gate in a restricted session (allow decision audited)",
    async () => {
      const h = await harness(
        [{ type: "tool_calls", calls: [{ name: "read", args: { path: "package.json" } }] }, { type: "text", text: "read done" }],
        "tools:\n  read: allow\n",
      );
      try {
        await h.deliverMessage(h.slack.dmChannelId, "read package.json");
        await h.modelStub.waitForRequests(2);

        // Read tier + allow policy → allow, audited like every call.
        const decisions = await auditRows(h, POLICY_DECISION_EVENT);
        const readDecision = decisions.find((row) => row.tool === "read");
        expect(readDecision).toBeDefined();
        expect(readDecision!.decision).toBe("allow");
        expect(readDecision!.tier).toBe("read");

        // The turn completed: the scripted reply landed in the channel
        // (posts land a beat after the turn).
        const reply = await waitForReply(h, "read done");
        expect(reply).toBeDefined();
      } finally {
        await h.cleanup();
      }
    },
    30_000,
  );

  test(
    "turn-start memory injection rides the driver in a restricted session (issue #42 seam)",
    async () => {
      const h = await harness([{ type: "text", text: "injected" }], "");
      try {
        await h.memory.save({ scope: "org", content: "the build runs on arm64", metadata: { inject: "1" } });
        await h.deliverMessage(h.slack.dmChannelId, "deploy");
        await h.modelStub.waitForRequests(1);

        const system = h.modelStub.latestMessages().find((m) => m.role === "system" && typeof m.content === "string");
        expect(system).toBeDefined();
        expect(String(system!.content)).toContain("Relevant memory:");
        expect(String(system!.content)).toContain("the build runs on arm64");
      } finally {
        await h.cleanup();
      }
    },
    30_000,
  );
});
