import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../store/db";
import { MAX_PAYLOAD_BYTES, TRUNCATION_MARKER, createAudit, redact } from "./audit";

const dir = mkdtempSync(join(tmpdir(), "bottega-audit-"));
const store = createStore(join(dir, "test.db"));
const audit = createAudit(store);

afterAll(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("redact", () => {
  test("masks secret-shaped values deterministically", () => {
    const cases: [string, string][] = [
      ["https://hooks.slack.com/services/xoxb-123456-abcdef", "https://hooks.slack.com/services/[REDACTED]"],
      ["sk-proj-9f8e7d6c5b4a", "sk-[REDACTED]"],
      ["AKIAIOSFODNN7EXAMPLE", "[REDACTED]"],
      ["github_pat_11ABCDEFG_0abcdef123", "[REDACTED]"],
      ["Authorization: Bearer eyJhbGciOi.eyJzdWI.e30.sig", "Authorization: Bearer [REDACTED]"],
      ['{"api_key": "supersecretvalue123", "ok": true}', '{"api_key": "[REDACTED]", "ok": true}'],
    ];
    for (const [input, expected] of cases) {
      expect(redact(input)).toBe(expected);
    }
    // Deterministic: same input, same output.
    const input = "token xoxp-98765-zyxwvu and sk-test123";
    expect(redact(input)).toBe(redact(input));
  });
});

describe("appendAudit", () => {
  test("round-trips Record payloads through listAudit with filters", async () => {
    const space = await store.getOrCreateSpace({ platform: "slack", channel_id: "A1" });
    const id1 = await audit.appendAudit({
      ts: 1000,
      space_id: space.id,
      actor: "U1",
      event_type: "tool_call",
      payload: { tool: "task", tier: "exec", decision: "allow", reason: "ok" },
    });
    const id2 = await audit.appendAudit({
      ts: 2000,
      actor: "agent:work:wi_x",
      event_type: "tool_result",
      payload: { tool: "task", is_error: false },
    });
    const id3 = await audit.appendAudit({
      ts: 3000,
      space_id: space.id,
      actor: "U1",
      event_type: "approval.resolved",
      payload: "{\"approver\":\"U1\"}",
    });

    expect(id2).toBeGreaterThan(id1);
    expect(id3).toBeGreaterThan(id2);

    const bySpace = await audit.listAudit({ space: space.id });
    expect(bySpace.map((r) => r.id)).toEqual([id1, id3]);
    expect(JSON.parse(bySpace[0]!.payload)).toEqual({
      tool: "task",
      tier: "exec",
      decision: "allow",
      reason: "ok",
    });

    const byType = await audit.listAudit({ event_type: "tool_result" });
    expect(byType.map((r) => r.id)).toEqual([id2]);

    const bySince = await audit.listAudit({ since: 2000 });
    expect(bySince.map((r) => r.id)).toEqual([id2, id3]);

    const limited = await audit.listAudit({ limit: 2 });
    expect(limited).toHaveLength(2);
    expect(limited.map((r) => r.id)).toEqual([id1, id2]);
  });

  test("string payloads pass through unmodified", async () => {
    const id = await audit.appendAudit({
      actor: "U2",
      event_type: "message.in",
      payload: '{"text":"hello"}',
    });
    const [row] = await audit.listAudit({ event_type: "message.in" });
    expect(row?.id).toBe(id);
    expect(row?.payload).toBe('{"text":"hello"}');
  });
});

describe("redaction on write", () => {
  test("secrets in Record and string payloads never appear in returned rows", async () => {
    const secret = "sk-abcdef1234567890";
    await audit.appendAudit({
      actor: "U3",
      event_type: "redaction_test.record",
      payload: { tool: "bash", is_error: false, output: `token ${secret}` },
    });
    await audit.appendAudit({
      actor: "U3",
      event_type: "redaction_test.string",
      payload: `{"headers":{"Authorization":"Bearer xoxb-9876543210-abcdef"}}`,
    });

    const rows = await audit.listAudit({ event_type: "redaction_test.record" });
    expect(rows).toHaveLength(1);
    rows.push(...(await audit.listAudit({ event_type: "redaction_test.string" })));
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.payload).not.toContain(secret);
      expect(row.payload).not.toContain("xoxb-9876543210-abcdef");
      expect(row.payload).toContain("[REDACTED]");
    }
  });
});

describe("payload cap", () => {
  test("oversized payloads are truncated with a marker, not dropped", async () => {
    await audit.appendAudit({
      actor: "U4",
      event_type: "cap_test.oversized",
      payload: { tool: "read", is_error: false, output: `secret sk-999999999999\n` + "x".repeat(5000) },
    });

    const [row] = await audit.listAudit({ event_type: "cap_test.oversized" });
    expect(row).toBeDefined();
    expect(row!.payload).toContain(TRUNCATION_MARKER);
    expect(row!.payload).not.toContain("sk-999999999999");
    expect(Buffer.byteLength(row!.payload, "utf8")).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
    // Leading content survives truncation.
    expect(row!.payload.startsWith('{"tool":"read"')).toBe(true);
  });

  test("payloads under the cap are stored whole", async () => {
    const body = "y".repeat(100);
    await audit.appendAudit({ actor: "U4", event_type: "cap_test.small", payload: { text: body } });
    const [row] = await audit.listAudit({ event_type: "cap_test.small" });
    expect(row!.payload).toBe(JSON.stringify({ text: body }));
  });
});

describe("immutability", () => {
  test("raw UPDATE and DELETE on audit raise ABORT via triggers", async () => {
    const id = await audit.appendAudit({ actor: "U5", event_type: "policy.decision", payload: { allow: true } });
    const raw = new Database(join(dir, "test.db"));
    try {
      expect(() => raw.query("UPDATE audit SET payload = 'tampered' WHERE id = ?").run(id)).toThrow(/append-only/);
      expect(() => raw.query("DELETE FROM audit WHERE id = ?").run(id)).toThrow(/append-only/);
    } finally {
      raw.close();
    }
    const rows = await audit.listAudit({ event_type: "policy.decision" });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload).toBe('{"allow":true}');
  });
});
