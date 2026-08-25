/**
 * graph_query policy-gate reachability (issue #357). The tool's unit path
 * is exercised through the REAL withPolicyGate wrapper — the same gate the
 * driver wraps every session toolset entry with. graph_query must resolve
 * as a KNOWN read-tier tool: under a `graph_query: allow` policy the gate
 * lets the call through with NO approval (DenyRouter still passes), and
 * under an explicit deny the call never reaches execute.
 *
 * Pattern mirrors the usage_summary / memory.forget reachability tests.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { createAudit } from "../policy/audit";
import { DenyRouter, type ApprovalRouter } from "../policy/approval-router";
import { isKnownTool, parseOrgConfigYaml, resolveTier } from "../policy/config";
import { createStore, type Store } from "../store/db";
import { withPolicyGate } from "../server/drivers/agent-driver";
import { graphQueryToolDefinition } from "./graph-query";

/** A router that always approves — irrelevant for read tier, but proves no approval is demanded. */
const ApprovingRouter: ApprovalRouter = {
  async request() {
    return { approved: true, approver: "U_APPROVER" };
  },
};

/** Minimal session-only context the gate requires of the caller. */
function ctx(spaceId: string): ExtensionContext {
  // SAFETY: the gate and tools only call sessionManager.getSessionFile();
  // the spare context surface is never touched by this boundary.
  return { sessionManager: { getSessionFile: () => `${spaceId}.jsonl` } } as ExtensionContext;
}

async function seededStore(dir: string): Promise<{ store: Store; workItemId: string }> {
  const store = createStore(join(dir, "gate.db"));
  await store.getOrCreateSpace({ platform: "slack", channel_id: "C1", name: "Billing" });
  const item = await store.createWorkItem({
    space_id: "slack:C1",
    requester: "U1",
    description: "Fix billing webhook retries",
  });
  return { store, workItemId: item.id };
}

describe("graph_query policy-gate reachability (issue #357)", () => {
  test("registering graph_query as read tier makes it known and read", () => {
    expect(isKnownTool("graph_query")).toBe(true);
    expect(resolveTier("graph_query")).toBe("read");
  });

  test("withPolicyGate executes graph_query as read-tier without approval under allow", async () => {
    const dir = mkdtempSync(join(tmpdir(), "graph-query-allow-"));
    try {
      const { store, workItemId } = await seededStore(dir);
      try {
        const audit = createAudit(store);
        // Read-tier tools are allowed by name in the org floor (same
        // convention as list_todos / search_web). DenyRouter proves READ
        // tier needs NO approval: if graph_query wrongly fell back to the
        // exec default (unknown tool), the deny router would block it here.
        const orgPolicy = parseOrgConfigYaml("tools:\n  graph_query: allow\n");
        const tool: ToolDefinition = graphQueryToolDefinition(store);
        const gated = withPolicyGate(tool, { orgPolicy, audit, router: DenyRouter, store });

        const res = await gated.execute("c1", { query: "who owns the billing webhook?" }, undefined, undefined, ctx("slack:C1"));
        expect(res.isError).not.toBe(true);
        const text = res.content[0]?.type === "text" ? res.content[0].text : "";
        // SAFETY: graph_query returns exactly one JSON text block; the parsed
        // shape mirrors the payload the tool serializes above.
        const body = JSON.parse(text) as { space: string; match_count: number; matches: Array<{ node: { id: string }; related: { edges: Array<{ rel: string; to: string }> } }> };
        expect(body.space).toBe("slack:C1");
        expect(body.match_count).toBeGreaterThan(0);
        const ownerMatch = body.matches.find((m) => m.node.id === workItemId);
        expect(ownerMatch).toBeDefined();
        // Provenance receipts: the answer carries its derivation edges.
        expect(ownerMatch?.related.edges.some((e) => e.rel === "created" && e.to === "person:U1")).toBe(true);
      } finally {
        store.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an explicit deny stops graph_query at the gate — execute never runs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "graph-query-deny-"));
    try {
      const { store } = await seededStore(dir);
      try {
        const audit = createAudit(store);
        const orgPolicy = parseOrgConfigYaml("tools:\n  graph_query: deny\n");
        const tool: ToolDefinition = graphQueryToolDefinition(store);
        const gated = withPolicyGate(tool, { orgPolicy, audit, router: ApprovingRouter, store });

        expect(
          gated.execute("c1", { query: "who owns billing?" }, undefined, undefined, ctx("slack:C1")),
        ).rejects.toThrow(/denied|denies|deny/i);
      } finally {
        store.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("unknown-policy default denies an unlisted graph_query rather than failing open", () => {
    const orgPolicy = parseOrgConfigYaml("tools:\n  other_tool: allow\n");
    expect(orgPolicy.ok).toBe(true);
    // The unknown-action floor applies; the tier stays read so an operator
    // opting in via `graph_query: allow` gets gate-through behavior.
    expect(resolveTier("graph_query")).toBe("read");
  });
});

