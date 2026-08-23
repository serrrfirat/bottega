/**
 * Policy-gate reachability for memory.forget (#163) and usage_summary
 * (#103). Both tools carry a tier on their definitions (write / read) but
 * their unit tests drive execute() directly, bypassing the live policy gate.
 * These tests prove the tools are registered in the static TIER_BY_TOOL
 * table so the real withPolicyGate path (agent-driver line ~785 →
 * resolveTier / isKnownTool → decideToolCall) handles them correctly:
 *
 * - memory.forget is a KNOWN write-tier tool: under `memory.forget: allow`
 *   it routes to write-tier ask-human approval (denied only if the human
 *   router denies) instead of denying as an unknown tool.
 * - usage_summary is a KNOWN read-tier tool: under a read: allow org policy
 *   the gate lets it through with no approval (DenyRouter still passes),
 *   instead of falling back to the exec default and denying every call.
 *
 * The patterns mirror the render_chart reachability tests (issue #276).
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult, ExtensionAPI, ExtensionContext, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { createAudit } from "../policy/audit";
import { DenyRouter, type ApprovalResolution, type ApprovalRouter } from "../policy/approval-router";
import { isKnownTool, parseOrgConfigYaml, resolveTier } from "../policy/config";
import { createStore } from "../store/db";
import { createSqliteMemoryProvider } from "../memory/sqlite";
import { withPolicyGate } from "../server/drivers/agent-driver";
import { memoryToolsExtension } from "./memory";
import { operatorReadToolDefinitions } from "./operator-read";

/** A router that always approves, so a write-tier ask-human resolves and runs. */
const ApprovingRouter: ApprovalRouter = {
  async request(): Promise<ApprovalResolution> {
    return { approved: true, approver: "U_APPROVER" };
  },
};

/** Minimal session-only context the gated tools require of the gate. */
function ctx(spaceId: string): ExtensionContext {
  // SAFETY: the gate and tools only call sessionManager.getSessionFile();
  // the spare context surface is never touched by this boundary.
  return { sessionManager: { getSessionFile: () => `${spaceId}.jsonl` } } as ExtensionContext;
}

/** Reads the single text block of a successful tool result (guard-narrowed). */
function resultText(result: AgentToolResult): string {
  const content = result.content;
  if (Array.isArray(content) && content.length > 0 && content[0] && "text" in content[0]) {
    // SAFETY: the `"text" in content[0]` guard above narrows the block to an
    // object bearing `text`, and the memory/usage tools return text blocks
    // only; the read is checked, not fabricated.
    return content[0].text as string;
  }
  throw new Error("expected a text tool result");
}

function registerMemoryTools(provider: Parameters<typeof memoryToolsExtension>[0]): ToolDefinition[] {
  const tools: ToolDefinition[] = [];
  // SAFETY: registerMemoryTools only exercises the extension's registerTool
  // seam; the rest of the ExtensionAPI surface is never touched by the
  // memory extension.
  const pi = { registerTool: (t: ToolDefinition) => void tools.push(t) } as ExtensionAPI;
  memoryToolsExtension(provider)(pi);
  return tools;
}

describe("memory.forget policy-gate reachability (#163)", () => {
  test("registering memory.forget as write tier makes it known and non-exec", () => {
    expect(isKnownTool("memory.forget")).toBe(true);
    expect(resolveTier("memory.forget")).toBe("write");
  });

  test("withPolicyGate routes memory.forget to write-tier approval rather than denying as unknown", async () => {
    const dir = mkdtempSync(join(tmpdir(), "memforget-gate-"));
    try {
      const db = new Database(join(dir, "memory.db"));
      const provider = createSqliteMemoryProvider(db);
      const store = createStore(join(dir, "gate.db"));
      const audit = createAudit(store);
      try {
        // Seed one org entry so the underlying forget has something to remove.
        const seed = registerMemoryTools(provider).find((t) => t.name === "memory.save")!;
        const saved = await seed.execute(
          "s1",
          { content: "forget me via the gate", scope: "org" },
          undefined,
          undefined,
          ctx("slack:C1"),
        );
        expect(saved.isError).not.toBe(true);
        const { id } = JSON.parse(resultText(saved));

        const orgPolicy = parseOrgConfigYaml("tools:\n  memory.forget: allow\n");
        const forget = registerMemoryTools(provider).find((t) => t.name === "memory.forget")!;
        const gated = withPolicyGate(forget, {
          orgPolicy,
          audit,
          router: ApprovingRouter,
          store,
        });

        // Old code: memory.forget is NOT in TIER_BY_TOOL → decideToolCall
        // returns deny ("tool is not in the known tool table") no matter the
        // policy, so withPolicyGate throws before execute. New code: the
        // write-tier allow routes ask-human, the approving router grants it,
        // and the underlying execute runs and succeeds.
        const res = await gated.execute("c1", { id, scope: "org" }, undefined, undefined, ctx("slack:C1"));
        expect(res.isError).not.toBe(true);
        expect(JSON.parse(resultText(res))).toEqual({ id, scope: "org", forgotten: true });
      } finally {
        store.close();
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("usage_summary policy-gate reachability (#103)", () => {
  test("registering usage_summary as read tier makes it known and read", () => {
    expect(isKnownTool("usage_summary")).toBe(true);
    expect(resolveTier("usage_summary")).toBe("read");
  });

  test("withPolicyGate executes usage_summary as read-tier without approval under a read: allow policy", async () => {
    const dir = mkdtempSync(join(tmpdir(), "usage-gate-"));
    try {
      const store = createStore(join(dir, "gate.db"));
      try {
        const audit = createAudit(store);
        // Read-tier tools are allowed by name in the org floor (same
        // convention as slack_read / render_chart). The read tier means the
        // gate lets the call through with NO approval — DenyRouter still
        // passes — rather than routing ask-human.
        const orgPolicy = parseOrgConfigYaml("tools:\n  usage_summary: allow\n");
        const tools = operatorReadToolDefinitions(store, {
          audit,
          orgPolicy,
          actorForSpace: () => "U1",
        });
        const usage = tools.find((t) => t.name === "usage_summary")!;
        const gated = withPolicyGate(usage, {
          orgPolicy,
          audit,
          // DenyRouter proves READ-tier needs NO approval: if usage_summary
          // wrongly fell back to the exec default (old code, unknown tool)
          // or demanded approval, the deny router would block it here.
          router: DenyRouter,
          store,
        });

        const res = await gated.execute("c1", { window: "7d" }, undefined, undefined, ctx("slack:C1"));
        // Read tier + read:allow → the gate lets the call through with no
        // approval and the underlying execute runs (it would throw a gate
        // deny if it resolved to exec or unknown).
        expect(res.isError).not.toBe(true);
        const body = JSON.parse(resultText(res));
        expect(body.space).toBe("slack:C1");
        expect(Array.isArray(body.buckets)).toBe(true);
      } finally {
        store.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
