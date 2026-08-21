import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { createAudit } from "../policy/audit";
import { decidePolicyCall, loadSpacePolicy, parseOrgConfigYaml } from "../policy/config";
import { createStore, type Store } from "../store/db";
import { operatorReadToolDefinitions } from "./operator-read";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function freshStore(): Store {
  const root = mkdtempSync(join(tmpdir(), "bottega-operator-read-"));
  roots.push(root);
  return createStore(join(root, "operator.db"));
}

interface ToolExecutionResult {
  content: Array<{ type: string; text?: string }>;
}

function resultText(result: ToolExecutionResult): string {
  const first = result.content[0];
  if (!first || first.type !== "text" || first.text === undefined) throw new Error("expected text tool result");
  return first.text;
}

function ctx(spaceId: string) {
  return { sessionManager: { getSessionFile: () => `${spaceId}.jsonl` } } as never;
}

async function run(tool: ToolDefinition, params: Record<string, unknown>, space = "slack:C1") {
  return tool.execute("call-1", params, undefined, undefined, ctx(space));
}

async function seedSpaces(store: Store): Promise<void> {
  await store.getOrCreateSpace({ platform: "slack", channel_id: "C1", name: "one" });
  await store.getOrCreateSpace({ platform: "slack", channel_id: "C2", name: "two" });
}

describe("audit_search caller surface (#161)", () => {
  test("returns allowlisted rows, cursor pages, and one redacted self-audit row", async () => {
    const store = freshStore();
    await seedSpaces(store);
    const audit = createAudit(store);
    const now = Date.UTC(2026, 7, 21, 12);
    for (let i = 0; i < 3; i += 1) {
      await audit.appendAudit({
        ts: now - i,
        space_id: "slack:C1",
        actor: "U1",
        event_type: "policy.decision",
        payload: {
          tool: "bash",
          tier: "exec",
          decision: i === 0 ? "deny" : "ask-human",
          reason: i === 0 ? "policy denies the tool" : "exec-tier tool requires human approval",
          args: `raw prompt body https://example.test/search?q=secret xoxb-1234567890-secret-${i}`,
        },
      });
    }
    const [search] = operatorReadToolDefinitions(store, {
      audit,
      orgPolicy: parseOrgConfigYaml("tools:\n  bash: allow\n"),
      now: () => now,
      actorForSpace: () => "U1",
    });

    const first = await run(search!, { event: "policy.decision", since: "7d", tool: "bash", limit: 2 });
    expect(first.isError).not.toBe(true);
    const page = JSON.parse(resultText(first)) as {
      rows: Array<Record<string, unknown>>;
      next_cursor: string | null;
    };
    expect(page.rows).toHaveLength(2);
    expect(page.next_cursor).toBeString();
    expect(page.rows[0]).toEqual({
      id: expect.any(Number),
      ts: now,
      event: "policy.decision",
      space: "slack:C1",
      actor: "U1",
      tool: "bash",
      tier: "exec",
      decision: "deny",
      reason: "policy_denied",
    });
    const encoded = resultText(first);
    expect(encoded).not.toContain("raw prompt");
    expect(encoded).not.toContain("?q=");
    expect(encoded).not.toContain("xoxb-");
    expect(encoded).not.toContain("args");

    const second = await run(search!, {
      event: "policy.decision",
      since: "7d",
      tool: "bash",
      limit: 2,
      cursor: page.next_cursor,
    });
    expect((JSON.parse(resultText(second)) as { rows: unknown[] }).rows).toHaveLength(1);

    const reads = await store.listAudit({ event_type: "audit.read" });
    expect(reads).toHaveLength(2);
    expect(reads.every((row) => !row.payload.includes("cursor"))).toBe(true);
    expect(JSON.parse(reads[0]!.payload)).toEqual({
      event: "policy.decision",
      since: now - 7 * 24 * 60 * 60 * 1000,
      space: "slack:C1",
      tool: "bash",
      limit: 2,
    });
    store.close();
  });

  test("fails closed for foreign spaces, unknown viewers and malformed filters", async () => {
    const store = freshStore();
    await seedSpaces(store);
    const audit = createAudit(store);
    await audit.appendAudit({ space_id: "slack:C2", actor: "U2", event_type: "approval.resolved", payload: { approved: true } });
    const make = (actor: string | undefined, canReadSpace?: (actor: string, target: string) => Promise<boolean>) =>
      operatorReadToolDefinitions(store, {
        audit,
        orgPolicy: parseOrgConfigYaml("tools:\n  audit_search: allow\n"),
        actorForSpace: () => actor,
        canReadSpace,
      })[0]!;

    expect((await run(make("U1"), { space: "slack:C2" })).isError).toBe(true);
    expect((await run(make(undefined), {})).isError).toBe(true);
    expect((await run(make("U1"), { event: "not.real" })).isError).toBe(true);
    expect((await run(make("U1"), { since: "whenever" })).isError).toBe(true);
    expect((await run(make("U1"), { cursor: "not-a-cursor" })).isError).toBe(true);
    expect(await store.listAudit({ event_type: "audit.read" })).toHaveLength(0);

    const admin = await run(make("U1", async (actor, target) => actor === "U1" && target === "slack:C2"), {
      space: "slack:C2",
      event: "approval.resolved",
    });
    expect(admin.isError).not.toBe(true);
    expect((JSON.parse(resultText(admin)) as { rows: Array<{ space: string }> }).rows[0]!.space).toBe("slack:C2");
    store.close();
  });
});

describe("explain_policy read-only parity (#320)", () => {
  test("reports deny, ask and allow from the same pure decision function without approvals", async () => {
    const store = freshStore();
    await seedSpaces(store);
    const audit = createAudit(store);
    const orgPolicy = parseOrgConfigYaml(
      "unknown: deny\ntools:\n  edit: deny\n  bash: allow\n  list_work_items: allow\n",
    );
    const [, explain] = operatorReadToolDefinitions(store, {
      audit,
      orgPolicy,
      actorForSpace: () => "U1",
    });

    for (const tool of ["edit", "bash", "list_work_items"] as const) {
      const result = await run(explain!, { tool });
      expect(result.isError).not.toBe(true);
      const explanation = JSON.parse(resultText(result)) as {
        decision: string;
        tier: string;
        approval_required: boolean;
        rule_source: string;
      };
      const effective = await loadSpacePolicy(orgPolicy, store, "slack:C1");
      expect(explanation.decision).toBe(decidePolicyCall(effective, tool).decision);
      expect(explanation.approval_required).toBe(explanation.decision === "ask-human");
    }

    const rows = await store.listAudit({ event_type: "policy.explained" });
    expect(rows).toHaveLength(3);
    expect(await store.listAudit({ event_type: "approval.requested" })).toHaveLength(0);
    expect(await store.listAudit({ event_type: "approval.resolved" })).toHaveLength(0);
    store.close();
  });

  test("explains credential choice through the live pure ladder without exposing metadata", async () => {
    const store = freshStore();
    await seedSpaces(store);
    await store.upsertExtensionCredential({
      provider: "github",
      identityKey: "org-secret-identity@example.test",
      owner: null,
      scope: "org",
      brokerCredentialId: 41,
    });
    await store.upsertExtensionCredential({
      provider: "github",
      identityKey: "ada-secret-identity@example.test",
      owner: "U1",
      scope: "personal",
      brokerCredentialId: 42,
    });
    await store.upsertExtensionCredential({
      provider: "github",
      identityKey: "bob-secret-identity@example.test",
      owner: "U2",
      scope: "personal",
      brokerCredentialId: 43,
    });
    const audit = createAudit(store);
    const [, explain] = operatorReadToolDefinitions(store, {
      audit,
      orgPolicy: parseOrgConfigYaml("extensions:\n  org_credentials: allow\n"),
      actorForSpace: () => "U1",
    });

    const me = await run(explain!, { tool: "list_work_items", provider: "github", credential_scope: "me" });
    const auto = await run(explain!, { tool: "list_work_items", provider: "github", credential_scope: "auto" });
    expect(JSON.parse(resultText(me)).credential).toEqual({ kind: "available", provider: "github", scope: "personal" });
    expect(JSON.parse(resultText(auto)).credential).toEqual({ kind: "available", provider: "github", scope: "org" });
    for (const text of [resultText(me), resultText(auto)]) {
      expect(text).not.toContain("identity");
      expect(text).not.toContain("broker");
      expect(text).not.toContain("U2");
      expect(text).not.toContain("example.test");
    }
    expect(await store.listAudit({ event_type: "extension.credential_resolved" })).toHaveLength(0);
    store.close();
  });
});
