import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionHandler,
  ToolCallEvent,
  ToolCallEventResult,
} from "@oh-my-pi/pi-coding-agent";
import { createStore, type Space } from "../store/db";
import { createAudit } from "./audit";
import { DenyRouter, type ApprovalRequest, type ApprovalRouter, type ApprovalResolution } from "./approval-router";
import {
  DEFAULT_TIMEOUT_MINUTES,
  applySpaceOverlay,
  decideToolCall,
  defaultPolicy,
  isKnownTool,
  loadOrgConfig,
  parseOrgConfigYaml,
  resolveTier,
  toolAction,
  type PolicyAction,
  type Tier,
} from "./config";
import createPolicyExtension from "./extension";

type Decision = "allow" | "deny" | "ask-human";

const ALL_ACTIONS: PolicyAction[] = ["allow", "deny", "prompt"];
const ALL_TIERS: Tier[] = ["read", "write", "exec"];

describe("decision table", () => {
  test("known tools: tier × policy action", () => {
    const cases: [Tier, PolicyAction, Decision][] = [
      ["read", "allow", "allow"],
      ["read", "prompt", "ask-human"],
      ["read", "deny", "deny"],
      ["write", "allow", "allow"],
      ["write", "prompt", "ask-human"],
      ["write", "deny", "deny"],
      // exec tier asks a human even when policy allows (never fail open).
      ["exec", "allow", "ask-human"],
      ["exec", "prompt", "ask-human"],
      ["exec", "deny", "deny"],
    ];
    for (const [tier, action, expected] of cases) {
      expect(decideToolCall({ tier, action, toolKnown: true }).decision, `${tier}×${action}`).toBe(expected);
    }
  });

  test("unknown tools always deny, regardless of tier or policy", () => {
    for (const tier of ALL_TIERS) {
      for (const action of ALL_ACTIONS) {
        expect(decideToolCall({ tier, action, toolKnown: false }).decision, `${tier}×${action}×unknown`).toBe("deny");
      }
    }
  });
});

describe("tier resolution", () => {
  test("read-tier tools", () => {
    for (const t of ["read", "glob", "grep", "ast_grep", "web_search", "inspect_image", "lsp", "memory.search"]) {
      expect(resolveTier(t)).toBe("read");
    }
  });
  test("write-tier tools", () => {
    for (const t of ["write", "edit", "memory.save"]) expect(resolveTier(t)).toBe("write");
  });
  test("exec-tier tools", () => {
    for (const t of ["bash", "task", "create_work_item", "work_item_cancel"]) expect(resolveTier(t)).toBe("exec");
  });
  test("unknown tools resolve to exec (unknown/malformed → exec)", () => {
    expect(resolveTier("some_custom_tool")).toBe("exec");
    expect(isKnownTool("some_custom_tool")).toBe(false);
    expect(isKnownTool("bash")).toBe(true);
  });
});

describe("org config parsing", () => {
  test("parses a valid org config", () => {
    const p = parseOrgConfigYaml(`
# org floor
tools:
  bash: deny
  git: prompt
  write: allow
approvals:
  timeout_minutes: 7
  required_for_org_change: 2
`);
    expect(p.ok).toBe(true);
    expect(toolAction(p, "bash")).toBe("deny");
    expect(toolAction(p, "git")).toBe("prompt");
    expect(toolAction(p, "write")).toBe("allow");
    expect(p.unknownAction).toBe("deny");
    expect(p.timeoutMinutes).toBe(7);
    expect(p.requiredApprovers).toBe(2);
    expect(p.approvers).toEqual([]);
    expect(p.alwaysApprove).toEqual([]);
    expect(p.errors).toEqual([]);
  });

  test("approvals.always_approve parses a known-tool allowlist (issue #45)", () => {
    const p = parseOrgConfigYaml(`
approvals:
  always_approve:
    - create_work_item
    - bash
`);
    expect(p.ok).toBe(true);
    expect(p.alwaysApprove).toEqual(["create_work_item", "bash"]);
  });

  test("always_approve with an unknown tool fails the policy closed (issue #45)", () => {
    const p = parseOrgConfigYaml("approvals:\n  always_approve:\n    - some_new_tool\n");
    expect(p.ok).toBe(false);
    expect(p.errors[0]).toContain("some_new_tool");
  });

  test("always_approve must be a list of tool names (issue #45)", () => {
    expect(parseOrgConfigYaml("approvals:\n  always_approve: nope\n").ok).toBe(false);
    expect(parseOrgConfigYaml("approvals:\n  always_approve:\n    - 42\n").ok).toBe(false);
  });

  test("trailing comments and quoted actions parse (shared YAML parser)", () => {
    const p = parseOrgConfigYaml('tools:\n  bash: deny # block shells\n  write: "allow"\napprovals:\n  timeout_minutes: 7 # minutes\n');
    expect(p.ok).toBe(true);
    expect(toolAction(p, "bash")).toBe("deny");
    expect(toolAction(p, "write")).toBe("allow");
    expect(p.timeoutMinutes).toBe(7);
  });

  test("malformed tool entry denies that tool only", () => {
    const p = parseOrgConfigYaml("tools:\n  bash: maybe\n  write: allow\n");
    expect(p.ok).toBe(true);
    expect(toolAction(p, "bash")).toBe("deny");
    expect(toolAction(p, "write")).toBe("allow");
    expect(p.errors).toHaveLength(1);
  });

  test("structural parse errors deny everything (fail closed)", () => {
    // Tab indentation is outside the supported subset.
    expect(parseOrgConfigYaml("tools:\n\tbash: deny\n").ok).toBe(false);
    // Not a `key: value` line.
    expect(parseOrgConfigYaml("tools:\n  bash deny\n").ok).toBe(false);
    // Duplicate key.
    expect(parseOrgConfigYaml("tools:\n  bash: deny\n  bash: allow\n").ok).toBe(false);
    // tools must be a mapping.
    expect(parseOrgConfigYaml("tools: nope\n").ok).toBe(false);
    // approvals must be a mapping.
    expect(parseOrgConfigYaml("approvals: nope\n").ok).toBe(false);
  });

  test("empty input defaults to fail-closed policy", () => {
    const p = parseOrgConfigYaml("");
    expect(p.ok).toBe(true);
    expect(toolAction(p, "read")).toBe("deny");
    expect(p.unknownAction).toBe("deny");
    expect(p.timeoutMinutes).toBe(DEFAULT_TIMEOUT_MINUTES);
    expect(p.requiredApprovers).toBe(1);
    // Memory-context injection defaults (issue #42): enabled, 5 entries.
    expect(p.memory.injection).toEqual({ enabled: true, maxEntries: 5 });
  });

  test("memory.injection parses and invalid values warn, not fail", () => {
    const p = parseOrgConfigYaml(`
memory:
  injection:
    enabled: false
    max_entries: 3
`);
    expect(p.ok).toBe(true);
    expect(p.memory.injection).toEqual({ enabled: false, maxEntries: 3 });
    expect(p.errors).toEqual([]);
    expect(p.warnings).toEqual([]);

    const bad = parseOrgConfigYaml("memory:\n  injection:\n    enabled: sometimes\n    max_entries: 0\n");
    expect(bad.ok).toBe(true);
    expect(bad.memory.injection).toEqual({ enabled: true, maxEntries: 5 }); // defaults kept
    expect(bad.warnings).toHaveLength(2);
  });

  test("memory.injection.max_entries over 20 is capped with a warning", () => {
    const p = parseOrgConfigYaml("memory:\n  injection:\n    max_entries: 50\n");
    expect(p.ok).toBe(true);
    expect(p.memory.injection.maxEntries).toBe(20);
    expect(p.warnings).toHaveLength(1);
  });

  test("a non-mapping memory.injection is a structural error (fail closed)", () => {
    expect(parseOrgConfigYaml("memory:\n  injection: nope\n").ok).toBe(false);
    expect(parseOrgConfigYaml("memory: nope\n").ok).toBe(false);
  });

  test("the space overlay cannot change memory.injection (org floor only)", () => {
    const org = parseOrgConfigYaml("memory:\n  injection:\n    enabled: false\n    max_entries: 2\n");
    const p = applySpaceOverlay(org, JSON.stringify({ memory: { injection: { enabled: true, max_entries: 9 } } }));
    expect(p.ok).toBe(true);
    expect(p.memory.injection).toEqual({ enabled: false, maxEntries: 2 });
  });

  test("toolAction falls back to the unknown default", () => {
    const p = parseOrgConfigYaml("tools:\n  unknown: allow\n  bash: deny\n");
    expect(toolAction(p, "read")).toBe("allow");
    expect(toolAction(p, "grep")).toBe("allow");
    expect(toolAction(p, "bash")).toBe("deny");
  });

  test("loadOrgConfig reads config.yml and defaults when absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "bottega-orgcfg-"));
    try {
      const absent = loadOrgConfig(dir);
      expect(absent.ok).toBe(true);
      expect(Object.keys(absent.tools)).toHaveLength(0);
      writeFileSync(join(dir, "config.yml"), "tools:\n  bash: allow\n  unknown: deny\n");
      const present = loadOrgConfig(dir);
      expect(present.ok).toBe(true);
      expect(toolAction(present, "bash")).toBe("allow");
      expect(toolAction(present, "read")).toBe("deny");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("agent.driver defaults to omp-sdk", () => {
    expect(defaultPolicy().agentDriver).toBe("omp-sdk");
    expect(parseOrgConfigYaml("").agentDriver).toBe("omp-sdk");
    expect(parseOrgConfigYaml("tools:\n  bash: deny\n").agentDriver).toBe("omp-sdk");
  });

  test("agent.driver: acp selects the ACP driver", () => {
    const p = parseOrgConfigYaml("agent:\n  driver: acp\n");
    expect(p.ok).toBe(true);
    expect(p.agentDriver).toBe("acp");
    expect(p.errors).toEqual([]);
  });

  test("agent.driver: invalid value warns and keeps the omp-sdk default", () => {
    const p = parseOrgConfigYaml("agent:\n  driver: telepathy\n");
    expect(p.ok).toBe(true);
    expect(p.agentDriver).toBe("omp-sdk");
    expect(p.warnings.some((w) => w.includes("agent.driver"))).toBe(true);
  });

  test("agent section must be a block mapping", () => {
    const p = parseOrgConfigYaml("agent: nope\n");
    expect(p.ok).toBe(false);
    expect(p.agentDriver).toBe("omp-sdk");
  });
});

describe("space overlay", () => {
  test("can only tighten the org floor", () => {
    const org = parseOrgConfigYaml("tools:\n  bash: deny\n  write: allow\n  read: prompt\n");
    const p = applySpaceOverlay(org, JSON.stringify({ tools: { write: "prompt", read: "allow", bash: "prompt" } }));
    expect(p.ok).toBe(true);
    expect(toolAction(p, "write")).toBe("prompt"); // allow → prompt
    expect(toolAction(p, "read")).toBe("prompt"); // overlay allow cannot loosen org prompt
    expect(toolAction(p, "bash")).toBe("deny"); // org deny wins over overlay prompt
  });

  test("invalid overlay entry denies that tool", () => {
    const org = parseOrgConfigYaml("tools:\n  write: allow\n");
    const p = applySpaceOverlay(org, JSON.stringify({ tools: { write: "whenever" } }));
    expect(p.ok).toBe(true);
    expect(toolAction(p, "write")).toBe("deny");
    expect(p.errors).toHaveLength(1);
  });

  test("unparseable overlay denies everything for the space", () => {
    const org = parseOrgConfigYaml("tools:\n  write: allow\n");
    const p = applySpaceOverlay(org, "{ not json");
    expect(p.ok).toBe(false);
  });

  test("empty overlay leaves the org policy untouched", () => {
    const org = parseOrgConfigYaml("tools:\n  write: allow\n");
    expect(applySpaceOverlay(org, "")).toBe(org);
    expect(applySpaceOverlay(org, "   ")).toBe(org);
  });

  test("overlay approvers is parsed and replaces the org floor default", () => {
    const org = parseOrgConfigYaml("");
    expect(org.approvers).toEqual([]);
    const p = applySpaceOverlay(org, JSON.stringify({ approvers: ["U1", "U2"] }));
    expect(p.ok).toBe(true);
    expect(p.approvers).toEqual(["U1", "U2"]);
    // Malformed approvers is a structural error → deny everything for the space.
    expect(applySpaceOverlay(org, JSON.stringify({ approvers: "U1" })).ok).toBe(false);
    expect(applySpaceOverlay(org, JSON.stringify({ approvers: [1] })).ok).toBe(false);
  });

  test("overlay always_approve can only remove org-floor entries (issue #45)", () => {
    const org = parseOrgConfigYaml("approvals:\n  always_approve:\n    - bash\n    - create_work_item\n");
    const p = applySpaceOverlay(org, JSON.stringify({ always_approve: ["bash"] }));
    expect(p.ok).toBe(true);
    expect(p.alwaysApprove).toEqual(["create_work_item"]);
    // An entry the org floor does not list is a no-op (removal only tightens).
    const noop = applySpaceOverlay(org, JSON.stringify({ always_approve: ["task", "nope"] }));
    expect(noop.ok).toBe(true);
    expect(noop.alwaysApprove).toEqual(["bash", "create_work_item"]);
    // The overlay can never widen: entries absent from the org list stay absent.
    const empty = applySpaceOverlay(parseOrgConfigYaml(""), JSON.stringify({ always_approve: ["bash"] }));
    expect(empty.ok).toBe(true);
    expect(empty.alwaysApprove).toEqual([]);
    // Malformed always_approve is a structural error → deny everything for the space.
    expect(applySpaceOverlay(org, JSON.stringify({ always_approve: "bash" })).ok).toBe(false);
    expect(applySpaceOverlay(org, JSON.stringify({ always_approve: [1] })).ok).toBe(false);
  });
});

describe("policy extension wiring", () => {
  const dir = mkdtempSync(join(tmpdir(), "bottega-policy-"));
  const store = createStore(join(dir, "test.db"));
  const audit = createAudit(store);
  let space: Space;
  let space2: Space;

  beforeAll(async () => {
    space = await store.getOrCreateSpace({ platform: "slack", channel_id: "C1" });
    space2 = await store.getOrCreateSpace({ platform: "slack", channel_id: "C2" });
  });

  afterAll(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  type ToolCallHandler = ExtensionHandler<ToolCallEvent, ToolCallEventResult>;

  function fakePi() {
    const handlers = new Map<string, ToolCallHandler>();
    // Test double: only the tool_call overload the extension registers.
    const pi = {
      on(event: "tool_call", handler: ToolCallHandler): void {
        handlers.set(event, handler);
      },
    } as unknown as ExtensionAPI;
    return { handlers, pi };
  }

  function makeExtension(
    orgYaml: string,
    router: ApprovalRouter = DenyRouter,
    timeoutMs?: number,
    preApproved = false,
  ): Map<string, ToolCallHandler> {
    const { handlers, pi } = fakePi();
    createPolicyExtension({
      orgPolicy: parseOrgConfigYaml(orgYaml),
      audit,
      router,
      store,
      timeoutMs,
      preApproved,
    })(pi);
    return handlers;
  }

  function toolCallEvent(toolName: string, input: Record<string, unknown>): ToolCallEvent {
    // Test double: toolName/input unions can't be composed statically.
    return { type: "tool_call", toolCallId: "tc1", toolName, input } as ToolCallEvent;
  }

  function call(
    handlers: Map<string, ToolCallHandler>,
    toolName: string,
    input: Record<string, unknown> = {},
    spaceId: string = space.id,
  ): Promise<ToolCallEventResult | void> {
    const ctx = { sessionManager: { getSessionFile: () => join("/tmp/sessions", `${spaceId}.jsonl`) } } as ExtensionContext;
    const handler = handlers.get("tool_call")!;
    return Promise.resolve(handler(toolCallEvent(toolName, input), ctx));
  }

  /** Asserts the gate returned a block result and returns it for further assertions. */
  function blocked(res: ToolCallEventResult | void): ToolCallEventResult {
    if (typeof res === "object" && res !== null) {
      expect(res.block).toBe(true);
      return res;
    }
    return expect.unreachable("expected a block result");
  }

  async function lastAudit(eventType: string) {
    const rows = await audit.listAudit({ event_type: eventType });
    return JSON.parse(rows.at(-1)!.payload) as Record<string, unknown>;
  }

  test("allow decision lets the tool run and writes a policy.decision row", async () => {
    const handlers = makeExtension("tools:\n  read: allow\n");
    const res = await call(handlers, "read", { path: "x" });
    expect(res).toBeUndefined();
    const payload = await lastAudit("policy.decision");
    expect(payload).toMatchObject({ tool: "read", tier: "read", decision: "allow" });
  });

  test("deny decision blocks the tool and writes a policy.decision row", async () => {
    const handlers = makeExtension("tools:\n  bash: deny\n");
    const res = blocked(await call(handlers, "bash", { command: "rm -rf /" }));
    expect(res.reason).toContain("denies");
    const payload = await lastAudit("policy.decision");
    expect(payload).toMatchObject({ tool: "bash", tier: "exec", decision: "deny" });
  });

  test("unknown tool is blocked even with a permissive policy", async () => {
    const handlers = makeExtension("tools:\n  unknown: allow\n");
    blocked(await call(handlers, "some_new_tool", {}));
    const payload = await lastAudit("policy.decision");
    expect(payload).toMatchObject({ tool: "some_new_tool", tier: "exec", decision: "deny" });
  });

  test("structural policy error denies everything", async () => {
    const handlers = makeExtension("tools:\n  bash deny\n");
    blocked(await call(handlers, "read", {}));
  });

  test("exec-tier ask-human: approved router lets the tool run", async () => {
    const approvals: ApprovalRequest[] = [];
    const router: ApprovalRouter = {
      request: async (d) => {
        approvals.push(d);
        return { approved: true, approver: "U1" };
      },
    };
    const handlers = makeExtension("tools:\n  bash: allow\n", router);
    const res = await call(handlers, "bash", { command: "ls" });
    expect(res).toBeUndefined();
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({ tool: "bash", spaceId: space.id, reason: expect.any(String) });
    expect(approvals[0].args).toEqual({ command: "ls" });
    expect(await lastAudit("approval.requested")).toMatchObject({ tool: "bash" });
    expect(await lastAudit("approval.resolved")).toMatchObject({ approved: true, approver: "U1" });
  });

  test("exec-tier ask-human: DenyRouter blocks (headless)", async () => {
    const handlers = makeExtension("tools:\n  bash: allow\n");
    blocked(await call(handlers, "bash", { command: "ls" }));
    expect(await lastAudit("approval.resolved")).toMatchObject({ approved: false });
  });

  test("preApproved session: exec-tier allowlist tools run without a human prompt", async () => {
    const approvalsBefore = (await audit.listAudit({ event_type: "approval.requested" })).length;
    const handlers = makeExtension("tools:\n  bash: allow\n", DenyRouter, undefined, true);
    const res = await call(handlers, "bash", { command: "ls" });
    expect(res).toBeUndefined();
    const decision = await lastAudit("policy.decision");
    expect(decision).toMatchObject({ tool: "bash", tier: "exec", decision: "allow" });
    expect(String(decision.reason)).toContain("pre-approved");
    // No approval round-trip happened: the audit table did not grow.
    expect(await audit.listAudit({ event_type: "approval.requested" })).toHaveLength(approvalsBefore);
  });

  test("preApproved session: unknown tools still deny", async () => {
    const handlers = makeExtension("tools:\n  unknown: allow\n", DenyRouter, undefined, true);
    blocked(await call(handlers, "some_new_tool", {}));
    expect(await lastAudit("policy.decision")).toMatchObject({ tool: "some_new_tool", decision: "deny" });
  });

  test("preApproved session: an explicit policy prompt still asks a human", async () => {
    const handlers = makeExtension("tools:\n  bash: prompt\n", DenyRouter, undefined, true);
    blocked(await call(handlers, "bash", { command: "ls" }));
    expect(await lastAudit("approval.resolved")).toMatchObject({ approved: false });
  });

  test("always_approve lets a listed exec tool run without a prompt (issue #45)", async () => {
    const requestedBefore = (await audit.listAudit({ event_type: "approval.requested" })).length;
    const handlers = makeExtension("tools:\n  bash: allow\napprovals:\n  always_approve:\n    - bash\n");
    const res = await call(handlers, "bash", { command: "ls" });
    expect(res).toBeUndefined();
    const decision = await lastAudit("policy.decision");
    expect(decision).toMatchObject({ tool: "bash", tier: "exec", decision: "allow" });
    expect(String(decision.reason)).toContain("always_approve");
    // No prompt was posted; the resolved row records approver "policy".
    expect(await audit.listAudit({ event_type: "approval.requested" })).toHaveLength(requestedBefore);
    expect(await lastAudit("approval.resolved")).toMatchObject({ tool: "bash", approved: true, approver: "policy" });
  });

  test("explicit deny beats always_approve (issue #45)", async () => {
    const resolvedBefore = (await audit.listAudit({ event_type: "approval.resolved" })).length;
    const handlers = makeExtension("tools:\n  bash: deny\napprovals:\n  always_approve:\n    - bash\n");
    const res = await call(handlers, "bash", { command: "ls" });
    if (typeof res === "object" && res !== null) {
      expect(res.block).toBe(true);
    } else {
      expect.unreachable("expected a block result");
    }
    expect(await lastAudit("policy.decision")).toMatchObject({ tool: "bash", decision: "deny" });
    expect(await audit.listAudit({ event_type: "approval.resolved" })).toHaveLength(resolvedBefore);
  });

  test("explicit prompt beats always_approve (issue #45)", async () => {
    const handlers = makeExtension("tools:\n  bash: prompt\napprovals:\n  always_approve:\n    - bash\n");
    const res = await call(handlers, "bash", { command: "ls" });
    if (typeof res === "object" && res !== null) {
      expect(res.block).toBe(true);
    } else {
      expect.unreachable("expected a block result");
    }
    // The ask-human path ran (DenyRouter), not the auto-approval.
    expect(await lastAudit("approval.resolved")).toMatchObject({ approved: false });
  });

  test("an unknown tool in always_approve fails the policy closed (issue #45)", async () => {
    const handlers = makeExtension("approvals:\n  always_approve:\n    - some_new_tool\n");
    const res = await call(handlers, "read", { path: "x" });
    if (typeof res === "object" && res !== null) {
      expect(res.block).toBe(true);
    } else {
      expect.unreachable("expected a block result");
    }
    expect(await lastAudit("policy.decision")).toMatchObject({ tool: "read", decision: "deny" });
  });

  test("space overlay removal of always_approve restores ask-human (issue #45)", async () => {
    await store.updatePolicy(space.id, JSON.stringify({ always_approve: ["bash"] }));
    const handlers = makeExtension(
      "tools:\n  bash: allow\napprovals:\n  always_approve:\n    - bash\n",
      DenyRouter,
    );
    // Space with the removal overlay: the exec tool goes back to ask-human → denied.
    const blocked = await call(handlers, "bash", { command: "ls" }, space.id);
    if (typeof blocked === "object" && blocked !== null) {
      expect(blocked.block).toBe(true);
    } else {
      expect.unreachable("expected a block result");
    }
    // Space without the overlay (org floor list intact): auto-approved.
    expect(await call(handlers, "bash", { command: "ls" }, space2.id)).toBeUndefined();
    expect(await lastAudit("approval.resolved")).toMatchObject({ approved: true, approver: "policy" });
  });

  test("approval timeout denies", async () => {
    const { promise } = Promise.withResolvers<ApprovalResolution>();
    const router: ApprovalRouter = { request: () => promise };
    const handlers = makeExtension("tools:\n  bash: allow\n", router, 50);
    blocked(await call(handlers, "bash", { command: "ls" }));
    expect(await lastAudit("approval.resolved")).toMatchObject({ approved: false });
  });

  test("router failure blocks the tool (fail closed)", async () => {
    const router: ApprovalRouter = {
      request: async () => {
        throw new Error("slack down");
      },
    };
    const handlers = makeExtension("tools:\n  bash: allow\n", router, 50);
    blocked(await call(handlers, "bash", { command: "ls" }));
  });

  test("space overlay tightens policy per space", async () => {
    await store.updatePolicy(space.id, JSON.stringify({ tools: { read: "deny" } }));
    const handlers = makeExtension("tools:\n  read: allow\n");
    // Space with a tightening overlay: blocked.
    blocked(await call(handlers, "read", { path: "x" }, space.id));
    // Space without an overlay: still allowed.
    expect(await call(handlers, "read", { path: "x" }, space2.id)).toBeUndefined();
  });

  test("missing session file falls back to the org policy", async () => {
    const handlers = makeExtension("tools:\n  read: allow\n");
    const ctx = { sessionManager: { getSessionFile: () => undefined } } as ExtensionContext;
    const res = await handlers.get("tool_call")!(toolCallEvent("read", { path: "x" }), ctx);
    expect(res).toBeUndefined();
  });
});
