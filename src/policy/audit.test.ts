import { afterAll, describe, expect, test } from "bun:test";
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

  test("a payload exactly at the cap boundary is stored whole, one byte over truncates", async () => {
    // Exact boundary: byteLength === MAX_PAYLOAD_BYTES fits without a marker.
    const exact = "a".repeat(MAX_PAYLOAD_BYTES);
    await audit.appendAudit({ actor: "U4", event_type: "cap_test.exact", payload: exact });
    const [exactRow] = await audit.listAudit({ event_type: "cap_test.exact" });
    expect(exactRow!.payload).toBe(exact);
    expect(exactRow!.payload).not.toContain(TRUNCATION_MARKER);

    // One byte over: truncated to budget + marker, never exceeding the cap.
    const over = "a".repeat(MAX_PAYLOAD_BYTES + 1);
    await audit.appendAudit({ actor: "U4", event_type: "cap_test.over", payload: over });
    const [overRow] = await audit.listAudit({ event_type: "cap_test.over" });
    expect(overRow!.payload.endsWith(TRUNCATION_MARKER)).toBe(true);
    expect(Buffer.byteLength(overRow!.payload, "utf8")).toBe(MAX_PAYLOAD_BYTES);
    expect(overRow!.payload.startsWith("a".repeat(MAX_PAYLOAD_BYTES - TRUNCATION_MARKER.length))).toBe(true);
  });

  test("multi-byte payloads truncate on a character boundary without corrupting UTF-8", async () => {
    // Each emoji is 4 UTF-8 bytes; the cap loop slices UTF-16 code units, so
    // the cut must never land inside a surrogate pair (which would store a
    // replacement character and shift the truncation point).
    const body = "🔥".repeat(Math.ceil(MAX_PAYLOAD_BYTES / 4) + 10);
    await audit.appendAudit({ actor: "U4", event_type: "cap_test.multibyte", payload: body });
    const [row] = await audit.listAudit({ event_type: "cap_test.multibyte" });
    expect(row!.payload.endsWith(TRUNCATION_MARKER)).toBe(true);
    expect(Buffer.byteLength(row!.payload, "utf8")).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
    const text = row!.payload.slice(0, -TRUNCATION_MARKER.length);
    expect(text.includes("\uFFFD")).toBe(false); // no lone surrogates survived
    expect(text.length % 2).toBe(0); // complete surrogate pairs only
  });
});

