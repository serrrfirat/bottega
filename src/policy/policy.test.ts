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
  DEFAULT_OBJECT_MAX_SIZE_BYTES,
  DEFAULT_TIMEOUT_MINUTES,
  applySpaceOverlay,
  decideExtensionCall,
  decidePolicyCall,
  decideToolCall,
  defaultPolicy,
  isKnownTool,
  loadOrgConfig,
  loadOrgPolicy,
  loadSpacePolicy,
  orgCredentialsAllowed,
  parseOrgConfigYaml,
  resolveTier,
  toolAction,
  type Decision,
  type PolicyAction,
  type Tier,
} from "./config";
import createPolicyExtension from "./extension";

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
    for (const t of [
      "read",
      "glob",
      "grep",
      "ast_grep",
      "web_search",
      "inspect_image",
      "lsp",
      "memory.search",
      "session_search",
      "object.list",
      "object.get",
      "list_work_items",
    ]) {
      expect(resolveTier(t)).toBe("read");
      expect(isKnownTool(t)).toBe(true);
    }
  });
  test("write-tier tools", () => {
    for (const t of ["write", "edit", "memory.save", "model_settings", "use_model", "object.create", "complete_work_item"]) {
      expect(resolveTier(t)).toBe("write");
      expect(isKnownTool(t)).toBe(true);
    }
  });
  test("exec-tier tools", () => {
    for (const t of ["bash", "task", "create_work_item", "work_item_cancel", "connect_extension"]) {
      expect(resolveTier(t)).toBe("exec");
    }
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
`);
    expect(p.ok).toBe(true);
    expect(toolAction(p, "bash")).toBe("deny");
    expect(toolAction(p, "git")).toBe("prompt");
    expect(toolAction(p, "write")).toBe("allow");
    expect(p.unknownAction).toBe("deny");
    expect(p.timeoutMinutes).toBe(7);
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

  test("unknown approvals keys warn instead of parsing silently (issue #65)", () => {
    // required_for_org_change was removed in #65 as never-consumed dead
    // surface; a leftover key (or a typo) must not look configured.
    const p = parseOrgConfigYaml("approvals:\n  required_for_org_change: 2\n  timeout_minute: 7\n");
    expect(p.ok).toBe(true);
    expect(p.timeoutMinutes).toBe(DEFAULT_TIMEOUT_MINUTES);
    expect(p.warnings.some((w) => w.includes("approvals.required_for_org_change"))).toBe(true);
    expect(p.warnings.some((w) => w.includes("approvals.timeout_minute"))).toBe(true);
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
    expect(parseOrgConfigYaml("tools:\n\tbash: deny\n").learning.autoExtract).toBe(false);
  });

  test("empty input defaults to fail-closed policy", () => {
    const p = parseOrgConfigYaml("");
    expect(p.ok).toBe(true);
    expect(toolAction(p, "read")).toBe("deny");
    expect(p.unknownAction).toBe("deny");
    expect(p.timeoutMinutes).toBe(DEFAULT_TIMEOUT_MINUTES);
    // Memory-context injection defaults (issue #42): enabled, 5 entries.
    expect(p.memory.injection).toEqual({ enabled: true, maxEntries: 5 });
  });

  test("learning.auto_extract defaults on, parses booleans, and fails closed", () => {
    expect(parseOrgConfigYaml("").learning.autoExtract).toBe(true);
    expect(parseOrgConfigYaml("learning:\n  auto_extract: false\n").learning.autoExtract).toBe(false);
    expect(parseOrgConfigYaml("learning:\n  auto_extract: true\n").learning.autoExtract).toBe(true);

    const invalid = parseOrgConfigYaml("learning:\n  auto_extract: sometimes\n");
    expect(invalid.ok).toBe(true);
    expect(invalid.learning.autoExtract).toBe(false);
    expect(invalid.warnings).toContain("learning.auto_extract: invalid (true|false) — disabled");
  });

  test("objects.max_size_bytes defaults and parses a positive integer", () => {
    expect(defaultPolicy().objects.maxSizeBytes).toBe(DEFAULT_OBJECT_MAX_SIZE_BYTES);
    expect(parseOrgConfigYaml("").objects.maxSizeBytes).toBe(DEFAULT_OBJECT_MAX_SIZE_BYTES);

    const configured = parseOrgConfigYaml("objects:\n  max_size_bytes: 2048\n");
    expect(configured.ok).toBe(true);
    expect(configured.objects.maxSizeBytes).toBe(2048);
  });

  test("a malformed objects section fails the policy closed", () => {
    for (const text of [
      "objects: nope\n",
      "objects:\n  max_size_bytes: nope\n",
      "objects:\n  max_size_bytes: 0\n",
      "objects:\n  max_size_bytes:\n    nested: 1\n",
    ]) {
      const policy = parseOrgConfigYaml(text);
      expect(policy.ok).toBe(false);
      expect(policy.objects.maxSizeBytes).toBe(DEFAULT_OBJECT_MAX_SIZE_BYTES);
    }
  });

  test("space overlays preserve the org object size limit", () => {
    const org = parseOrgConfigYaml("objects:\n  max_size_bytes: 4096\n");
    const policy = applySpaceOverlay(org, JSON.stringify({ tools: { bash: "deny" } }));
    expect(policy.objects.maxSizeBytes).toBe(4096);
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

  test("response_mode parses at the org floor; default is always (issue #55)", () => {
    expect(parseOrgConfigYaml("").responseMode).toBe("always");
    expect(parseOrgConfigYaml("response_mode: mention\n").responseMode).toBe("mention");
    expect(parseOrgConfigYaml("response_mode: request-only\n").responseMode).toBe("request-only");
    expect(parseOrgConfigYaml("response_mode:  MENTION \n").responseMode).toBe("mention");
  });

  test("invalid response_mode warns and keeps the always default", () => {
    const p = parseOrgConfigYaml("response_mode: whenever\n");
    expect(p.ok).toBe(true);
    expect(p.responseMode).toBe("always");
    expect(p.warnings.some((w) => w.includes("response_mode"))).toBe(true);
  });

  test("work_items.auto_pickup defaults to false (opt-in, issue #89)", () => {
    expect(defaultPolicy().autoPickup).toBe(false);
    expect(parseOrgConfigYaml("").autoPickup).toBe(false);
    expect(parseOrgConfigYaml("tools:\n  bash: deny\n").autoPickup).toBe(false);
  });

  test("work_items.auto_pickup parses true and false", () => {
    expect(parseOrgConfigYaml("work_items:\n  auto_pickup: true\n").autoPickup).toBe(true);
    expect(parseOrgConfigYaml("work_items:\n  auto_pickup: false\n").autoPickup).toBe(false);
    expect(parseOrgConfigYaml("work_items:\n  auto_pickup: TRUE\n").autoPickup).toBe(true);
  });

  test("an invalid auto_pickup value disables the flag with a warning (fail closed)", () => {
    const p = parseOrgConfigYaml("work_items:\n  auto_pickup: sometimes\n");
    expect(p.ok).toBe(true);
    expect(p.autoPickup).toBe(false);
    expect(p.warnings.some((w) => w.includes("work_items.auto_pickup"))).toBe(true);
  });

  test("work_items section must be a block mapping", () => {
    const p = parseOrgConfigYaml("work_items: nope\n");
    expect(p.ok).toBe(false);
    expect(p.autoPickup).toBe(false);
  });

  test("pickup_confidence defaults to high and parses all levels (issue #89)", () => {
    expect(defaultPolicy().pickupConfidence).toBe("high");
    expect(parseOrgConfigYaml("").pickupConfidence).toBe("high");
    expect(parseOrgConfigYaml("work_items:\n  pickup_confidence: medium\n").pickupConfidence).toBe("medium");
    expect(parseOrgConfigYaml("work_items:\n  pickup_confidence: low\n").pickupConfidence).toBe("low");
    expect(parseOrgConfigYaml("work_items:\n  pickup_confidence:  HIGH \n").pickupConfidence).toBe("high");
  });

  test("an invalid pickup_confidence warns and keeps the high default", () => {
    const p = parseOrgConfigYaml("work_items:\n  pickup_confidence: whenever\n");
    expect(p.ok).toBe(true);
    expect(p.pickupConfidence).toBe("high");
    expect(p.warnings.some((w) => w.includes("pickup_confidence"))).toBe(true);
  });

  test("unknown keys in the work_items section warn and never enable the flag", () => {
    const p = parseOrgConfigYaml("work_items:\n  auto_pickup_always: true\n");
    expect(p.ok).toBe(true);
    expect(p.autoPickup).toBe(false);
    expect(p.warnings.some((w) => w.includes("work_items.auto_pickup_always"))).toBe(true);
  });
});

describe("extension policy parsing (issue #56)", () => {
  test("parses extensions allow/deny/org_credentials at the org floor", () => {
    const p = parseOrgConfigYaml(`
extensions:
  allow:
    - linear
    - github
  deny:
    - attio
  org_credentials: deny
`);
    expect(p.ok).toBe(true);
    expect(p.extensionsAllow).toEqual(["linear", "github"]);
    expect(p.extensionsDeny).toEqual(["attio"]);
    expect(p.orgCredentials).toBe("deny");
    expect(p.errors).toEqual([]);
  });

  test("extensions default to no restriction and org credentials allowed", () => {
    const p = parseOrgConfigYaml("");
    expect(p.ok).toBe(true);
    expect(p.extensionsAllow).toEqual([]);
    expect(p.extensionsDeny).toEqual([]);
    expect(p.orgCredentials).toBe("allow");
    expect(orgCredentialsAllowed(p)).toBe(true);
  });

  test("extensions section must be a block mapping", () => {
    expect(parseOrgConfigYaml("extensions: nope\n").ok).toBe(false);
  });

  test("allow/deny must be lists of well-formed extension ids", () => {
    expect(parseOrgConfigYaml("extensions:\n  allow: nope\n").ok).toBe(false);
    expect(parseOrgConfigYaml("extensions:\n  allow:\n    - Bad Id\n").ok).toBe(false);
    expect(parseOrgConfigYaml("extensions:\n  deny:\n    - -bad\n").ok).toBe(false);
    expect(parseOrgConfigYaml("extensions:\n  deny:\n    - linear\n    - github\n").ok).toBe(true);
  });

  test("invalid org_credentials warns and keeps the allow default", () => {
    const p = parseOrgConfigYaml("extensions:\n  org_credentials: sometimes\n");
    expect(p.ok).toBe(true);
    expect(p.orgCredentials).toBe("allow");
    expect(p.warnings.some((w) => w.includes("org_credentials"))).toBe(true);
  });

  test("unknown keys in the extensions section warn", () => {
    const p = parseOrgConfigYaml("extensions:\n  telepathy: on\n");
    expect(p.ok).toBe(true);
    expect(p.warnings.some((w) => w.includes("extensions.telepathy"))).toBe(true);
  });
});

describe("extension allowlist decisions (issue #56)", () => {
  test("deny wins over allow", () => {
    const p = parseOrgConfigYaml("extensions:\n  allow:\n    - linear\n  deny:\n    - linear\n");
    expect(decideExtensionCall(p, "linear").decision).toBe("deny");
    expect(decideExtensionCall(p, "linear").reason).toContain("extensions.deny");
  });

  test("a non-empty allow list restricts to the listed ids", () => {
    const p = parseOrgConfigYaml("extensions:\n  allow:\n    - linear\n    - github\n");
    expect(decideExtensionCall(p, "linear").decision).toBe("allow");
    expect(decideExtensionCall(p, "attio").decision).toBe("deny");
    expect(decideExtensionCall(p, "attio").reason).toContain("extensions.allow");
  });

  test("empty allow/deny lists impose no restriction (registry is the base allowlist)", () => {
    expect(decideExtensionCall(parseOrgConfigYaml(""), "linear").decision).toBe("allow");
  });

  test("allowlist deny runs BEFORE tier/approval (preApproved and always_approve do not bypass)", () => {
    const p = parseOrgConfigYaml(`
tools:
  bash: allow
approvals:
  always_approve:
    - bash
extensions:
  deny:
    - linear
`);
    const res = decidePolicyCall(p, "bash", true, "linear");
    expect(res.decision).toBe("deny");
    expect(res.reason).toContain("linear");
    expect(res.autoApproved).toBe(false);
  });

  test("an allowed extension still crosses the tier logic (allowlist is not a bypass)", () => {
    const p = parseOrgConfigYaml("tools:\n  unknown: allow\nextensions:\n  allow:\n    - fixture.weather\n");
    const res = decidePolicyCall(p, "weather.current", false, "fixture.weather");
    expect(res.decision).toBe("deny"); // unknown tool at tier stage
    expect(res.reason).toContain("known tool table");
  });

  test("a call without an extension id is untouched by the allowlist", () => {
    const p = parseOrgConfigYaml("tools:\n  bash: allow\nextensions:\n  deny:\n    - linear\n");
    expect(decidePolicyCall(p, "bash", false).decision).toBe("ask-human");
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

  test("overlay response_mode may change the mode but only tighten (issue #55)", () => {
    const org = parseOrgConfigYaml("");
    expect(org.responseMode).toBe("always");
    expect(applySpaceOverlay(org, JSON.stringify({ response_mode: "mention" })).responseMode).toBe("mention");
    expect(applySpaceOverlay(org, JSON.stringify({ response_mode: "request-only" })).responseMode).toBe(
      "request-only",
    );
    // Loosening is clamped to the org floor (tighten rule).
    const strictOrg = parseOrgConfigYaml("response_mode: request-only\n");
    expect(applySpaceOverlay(strictOrg, JSON.stringify({ response_mode: "always" })).responseMode).toBe(
      "request-only",
    );
    expect(applySpaceOverlay(strictOrg, JSON.stringify({ response_mode: "mention" })).responseMode).toBe(
      "request-only",
    );
    // The org floor stands when the overlay does not mention response_mode.
    expect(applySpaceOverlay(strictOrg, "").responseMode).toBe("request-only");
  });

  test("invalid overlay response_mode warns and keeps the org floor", () => {
    const org = parseOrgConfigYaml("response_mode: mention\n");
    const p = applySpaceOverlay(org, JSON.stringify({ response_mode: "nope" }));
    expect(p.ok).toBe(true);
    expect(p.responseMode).toBe("mention");
    expect(p.warnings.some((w) => w.includes("response_mode"))).toBe(true);
  });

  test("overlay extensions.allow can only remove org-floor entries; deny only adds (issue #56)", () => {
    const org = parseOrgConfigYaml("extensions:\n  allow:\n    - linear\n    - github\n  deny:\n    - attio\n");
    const p = applySpaceOverlay(org, JSON.stringify({ extensions: { allow: ["github"], deny: ["figma"] } }));
    expect(p.ok).toBe(true);
    expect(p.extensionsAllow).toEqual(["linear"]);
    expect(p.extensionsDeny).toEqual(["attio", "figma"]);
    // The overlay can never widen allow: entries absent from the org floor stay absent.
    const widened = applySpaceOverlay(parseOrgConfigYaml(""), JSON.stringify({ extensions: { allow: ["linear"] } }));
    expect(widened.ok).toBe(true);
    expect(widened.extensionsAllow).toEqual([]);
    // An id the org floor does not list is a no-op (removal only tightens).
    const noop = applySpaceOverlay(org, JSON.stringify({ extensions: { allow: ["nope"], deny: ["attio"] } }));
    expect(noop.ok).toBe(true);
    expect(noop.extensionsAllow).toEqual(["linear", "github"]);
    expect(noop.extensionsDeny).toEqual(["attio"]);
  });

  test("overlay extensions.org_credentials can only tighten, never loosen (issue #56)", () => {
    const org = parseOrgConfigYaml("");
    expect(org.orgCredentials).toBe("allow");
    expect(applySpaceOverlay(org, JSON.stringify({ extensions: { org_credentials: "deny" } })).orgCredentials).toBe(
      "deny",
    );
    // Loosening is clamped to the org floor (tighten rule).
    const strictOrg = parseOrgConfigYaml("extensions:\n  org_credentials: deny\n");
    expect(applySpaceOverlay(strictOrg, JSON.stringify({ extensions: { org_credentials: "allow" } })).orgCredentials).toBe(
      "deny",
    );
    // The org floor stands when the overlay does not mention org_credentials.
    expect(applySpaceOverlay(strictOrg, "").orgCredentials).toBe("deny");
  });

  test("invalid overlay extensions.org_credentials warns and keeps the org floor", () => {
    const org = parseOrgConfigYaml("extensions:\n  org_credentials: deny\n");
    const p = applySpaceOverlay(org, JSON.stringify({ extensions: { org_credentials: "nope" } }));
    expect(p.ok).toBe(true);
    expect(p.orgCredentials).toBe("deny");
    expect(p.warnings.some((w) => w.includes("org_credentials"))).toBe(true);
  });

  test("malformed overlay extensions fail the space closed (issue #56)", () => {
    const org = parseOrgConfigYaml("extensions:\n  allow:\n    - linear\n");
    expect(applySpaceOverlay(org, JSON.stringify({ extensions: "nope" })).ok).toBe(false);
    expect(applySpaceOverlay(org, JSON.stringify({ extensions: { allow: "linear" } })).ok).toBe(false);
    expect(applySpaceOverlay(org, JSON.stringify({ extensions: { deny: [1] } })).ok).toBe(false);
    expect(applySpaceOverlay(org, JSON.stringify({ extensions: { allow: ["Bad Id"] } })).ok).toBe(false);
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

  /** Fields on policy decision/approval audit payloads that these tests read. */
  interface PolicyAuditPayload {
    tool?: string;
    tier?: string;
    decision?: string;
    approved?: boolean;
    approver?: string;
    reason?: string;
    args?: string;
  }

  function fakePi() {
    const handlers = new Map<string, ToolCallHandler>();
    // Test double: only the tool_call overload the extension registers.
    // SAFETY: createPolicyExtension registers tool handlers through pi.on only;
    // the double implements exactly that surface and the extension never reads
    // the rest of ExtensionAPI during registration.
    const pi = {
      on(event: "tool_call", handler: ToolCallHandler): void {
        handlers.set(event, handler);
      },
    } as ExtensionAPI;
    return { handlers, pi };
  }

  function makeExtension(
    orgYaml: string,
    router: ApprovalRouter = DenyRouter,
    timeoutMs?: number,
    preApproved = false,
    ext: {
      toolExtensionId?: (toolName: string) => string | undefined;
      toolTier?: (toolName: string) => Tier | undefined;
      knownExtensionIds?: string[];
    } = {},
  ): Map<string, ToolCallHandler> {
    const { handlers, pi } = fakePi();
    createPolicyExtension({
      orgPolicy: parseOrgConfigYaml(orgYaml),
      audit,
      router,
      store,
      timeoutMs,
      preApproved,
      ...ext,
    })(pi);
    return handlers;
  }

  function toolCallEvent(toolName: string, input: Record<string, string>): ToolCallEvent {
    // Test double: toolName/input unions can't be composed statically.
    // SAFETY: the literal carries the type/toolCallId/toolName/input fields the
    // extension reads; the per-toolName input narrowing cannot be composed
    // statically from a string tool name.
    return { type: "tool_call", toolCallId: "tc1", toolName, input } as ToolCallEvent;
  }

  function call(
    handlers: Map<string, ToolCallHandler>,
    toolName: string,
    input: Record<string, string> = {},
    spaceId: string = space.id,
  ): Promise<ToolCallEventResult | void> {
    // SAFETY: the extension reads only sessionManager.getSessionFile() on this
    // path; the double provides it and nothing else is touched.
    const ctx = { sessionManager: { getSessionFile: () => join("/tmp/sessions", `${spaceId}.jsonl`) } } as ExtensionContext;
    const handler = handlers.get("tool_call")!;
    return Promise.resolve(handler(toolCallEvent(toolName, input), ctx));
  }

  /** Asserts the gate returned a block result and returns it for further assertions. */
  function blocked(res: ToolCallEventResult | void): ToolCallEventResult {
    if (res !== undefined && res !== null) {
      expect(res.block).toBe(true);
      return res;
    }
    return expect.unreachable("expected a block result");
  }

  async function lastAudit(eventType: string) {
    const rows = await audit.listAudit({ event_type: eventType });
    // SAFETY: policy decision/approval payloads are flat JSON objects with the
    // tool/tier/decision/approved/approver/reason/args fields these tests read.
    return JSON.parse(rows.at(-1)!.payload) as PolicyAuditPayload;
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
    blocked(await call(handlers, "bash", { command: "ls" }));
    expect(await lastAudit("policy.decision")).toMatchObject({ tool: "bash", decision: "deny" });
    expect(await audit.listAudit({ event_type: "approval.resolved" })).toHaveLength(resolvedBefore);
  });

  test("explicit prompt beats always_approve (issue #45)", async () => {
    const handlers = makeExtension("tools:\n  bash: prompt\napprovals:\n  always_approve:\n    - bash\n");
    blocked(await call(handlers, "bash", { command: "ls" }));
    // The ask-human path ran (DenyRouter), not the auto-approval.
    expect(await lastAudit("approval.resolved")).toMatchObject({ approved: false });
  });

  test("an unknown tool in always_approve fails the policy closed (issue #45)", async () => {
    const handlers = makeExtension("approvals:\n  always_approve:\n    - some_new_tool\n");
    blocked(await call(handlers, "read", { path: "x" }));
    expect(await lastAudit("policy.decision")).toMatchObject({ tool: "read", decision: "deny" });
  });

  test("space overlay removal of always_approve restores ask-human (issue #45)", async () => {
    await store.updatePolicy(space.id, JSON.stringify({ always_approve: ["bash"] }));
    const handlers = makeExtension(
      "tools:\n  bash: allow\napprovals:\n  always_approve:\n    - bash\n",
      DenyRouter,
    );
    // Space with the removal overlay: the exec tool goes back to ask-human → denied.
    blocked(await call(handlers, "bash", { command: "ls" }, space.id));
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
    // SAFETY: the extension reads only sessionManager.getSessionFile() on this
    // path; the double provides it (returning undefined here) and nothing else
    // is touched.
    const ctx = { sessionManager: { getSessionFile: () => undefined } } as ExtensionContext;
    const res = await handlers.get("tool_call")!(toolCallEvent("read", { path: "x" }), ctx);
    expect(res).toBeUndefined();
  });

  test("extension allowlist denies BEFORE tier/approval with reason + audit (issue #56)", async () => {
    const requestedBefore = (await audit.listAudit({ event_type: "approval.requested" })).length;
    const handlers = makeExtension(
      "tools:\n  bash: allow\napprovals:\n  always_approve:\n    - bash\nextensions:\n  deny:\n    - fixture.weather\n",
      DenyRouter,
      undefined,
      true,
      { toolExtensionId: (name) => (name === "bash" ? "fixture.weather" : undefined), knownExtensionIds: ["fixture.weather"] },
    );
    // The exec tool is allowlisted + pre-approved + always_approve — only the
    // extension deny can block it, proving the allowlist runs before them.
    const res = blocked(await call(handlers, "bash", { command: "ls" }));
    expect(res.reason).toContain("fixture.weather");
    const payload = await lastAudit("policy.decision");
    expect(payload).toMatchObject({ tool: "bash", tier: "exec", decision: "deny" });
    expect(String(payload.reason)).toContain("extensions.deny");
    // Deny before approval: no ask-human round-trip happened.
    expect(await audit.listAudit({ event_type: "approval.requested" })).toHaveLength(requestedBefore);
  });

  test("an allowed extension tool passes the allowlist and hits the tier logic (issue #56)", async () => {
    const handlers = makeExtension(
      "tools:\n  unknown: allow\nextensions:\n  allow:\n    - fixture.weather\n",
      DenyRouter,
      undefined,
      false,
      { toolExtensionId: () => "fixture.weather", knownExtensionIds: ["fixture.weather"] },
    );
    blocked(await call(handlers, "weather.current", {}));
    const payload = await lastAudit("policy.decision");
    expect(payload).toMatchObject({ tool: "weather.current", decision: "deny" });
    // The tier reason, not the allowlist reason: the allowlist let it through.
    expect(String(payload.reason)).toContain("known tool table");
  });

  test("an allowed extension with its manifest tier wired passes the gate (issue #53)", async () => {
    const handlers = makeExtension(
      "tools:\n  unknown: allow\nextensions:\n  allow:\n    - fixture.weather\n",
      DenyRouter,
      undefined,
      false,
      {
        toolExtensionId: () => "fixture.weather",
        toolTier: (name) => (name === "weather.current" ? "read" : undefined),
        knownExtensionIds: ["fixture.weather"],
      },
    );
    // Read tier + allow action → runs; the audit reports the manifest tier.
    expect(await call(handlers, "weather.current", { city: "Lisbon" })).toBeUndefined();
    const payload = await lastAudit("policy.decision");
    expect(payload).toMatchObject({ tool: "weather.current", tier: "read", decision: "allow" });
  });

  test("a denied extension stays denied even with a wired tier (issue #53)", async () => {
    const handlers = makeExtension(
      "tools:\n  unknown: allow\nextensions:\n  deny:\n    - fixture.weather\n",
      DenyRouter,
      undefined,
      false,
      {
        toolExtensionId: () => "fixture.weather",
        toolTier: () => "read",
        knownExtensionIds: ["fixture.weather"],
      },
    );
    blocked(await call(handlers, "weather.current", {}));
    const payload = await lastAudit("policy.decision");
    expect(payload).toMatchObject({ tool: "weather.current", decision: "deny" });
    expect(String(payload.reason)).toContain("extensions.deny");
  });

  test("an extension tool with a wired tier but a denied policy action blocks (issue #53)", async () => {
    const handlers = makeExtension(
      "tools:\n  weather.current: deny\n",
      DenyRouter,
      undefined,
      false,
      {
        toolExtensionId: () => "fixture.weather",
        toolTier: () => "read",
        knownExtensionIds: ["fixture.weather"],
      },
    );
    blocked(await call(handlers, "weather.current", {}));
    const payload = await lastAudit("policy.decision");
    expect(payload).toMatchObject({ tool: "weather.current", decision: "deny" });
    expect(String(payload.reason)).toContain("policy denies the tool");
  });

  test("an unknown id in extensions.allow/deny fails the policy closed (issue #56)", async () => {
    const handlers = makeExtension(
      "tools:\n  read: allow\nextensions:\n  allow:\n    - ghost.extension\n",
      DenyRouter,
      undefined,
      false,
      { toolExtensionId: () => undefined, knownExtensionIds: ["fixture.weather"] },
    );
    // Even a plainly allowed read tool denies: the space policy is invalid.
    blocked(await call(handlers, "read", { path: "x" }));
    const payload = await lastAudit("policy.decision");
    expect(payload).toMatchObject({ tool: "read", decision: "deny" });
    expect(String(payload.reason)).toContain("ghost.extension");
  });

  test("extension tools with no extension wiring stay on plain tier logic (fail closed)", async () => {
    const handlers = makeExtension("tools:\n  unknown: allow\n");
    blocked(await call(handlers, "weather.current", {}));
    const payload = await lastAudit("policy.decision");
    expect(payload).toMatchObject({ tool: "weather.current", decision: "deny" });
    expect(String(payload.reason)).toContain("known tool table");
  });
});

describe("DB-first org policy (issue #67)", () => {
  const dir = mkdtempSync(join(tmpdir(), "bottega-dbfirst-"));
  const store = createStore(join(dir, "test.db"));

  afterAll(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function writeConfig(text: string): void {
    writeFileSync(join(dir, "config.yml"), text);
  }

  test("DB settings override the config-file floor; untouched keys keep the file", () => {
    writeConfig(`
tools:
  bash: allow
approvals:
  timeout_minutes: 5
  always_approve:
    - bash
response_mode: always
memory:
  injection:
    enabled: true
    max_entries: 5
objects:
  max_size_bytes: 4096
extensions:
  allow:
    - linear
`);
    store.setOrgSettings({
      approvals: { timeout_minutes: 9, always_approve: [] },
      response_mode: "request-only",
      memory: { injection: { enabled: false, max_entries: 3 } },
      extensions: { allow: [], deny: ["attio"], org_credentials: "deny" },
    });
    const p = loadOrgPolicy(store, dir);
    expect(p.ok).toBe(true);
    expect(p.timeoutMinutes).toBe(9);
    expect(p.alwaysApprove).toEqual([]);
    expect(p.responseMode).toBe("request-only");
    expect(p.memory.injection).toEqual({ enabled: false, maxEntries: 3 });
    expect(p.extensionsAllow).toEqual(["linear"]); // issue #151: an empty DB allow cannot lift the floor allowlist
    expect(p.extensionsDeny).toEqual(["attio"]);
    expect(p.orgCredentials).toBe("deny");
    expect(p.objects.maxSizeBytes).toBe(4096);
    // Keys the DB does not set keep the file floor.
    expect(toolAction(p, "bash")).toBe("allow");
  });

  test("no DB row: the file-only path is unchanged", () => {
    const s = createStore(join(dir, "fileonly.db"));
    try {
      writeConfig("tools:\n  bash: deny\napprovals:\n  timeout_minutes: 11\n");
      const p = loadOrgPolicy(s, dir);
      expect(p.ok).toBe(true);
      expect(p.timeoutMinutes).toBe(11);
      expect(toolAction(p, "bash")).toBe("deny");
      expect(p.responseMode).toBe("always");
    } finally {
      s.close();
    }
  });

  test("no config file: DB settings sit on the built-in defaults", () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "bottega-dbfirst-nofile-"));
    const s = createStore(join(emptyDir, "test.db"));
    try {
      s.setOrgSettings({ response_mode: "mention", approvals: { timeout_minutes: 7 } });
      const p = loadOrgPolicy(s, emptyDir);
      expect(p.ok).toBe(true);
      expect(p.responseMode).toBe("mention");
      expect(p.timeoutMinutes).toBe(7);
      expect(toolAction(p, "read")).toBe("deny"); // fail-closed default floor
      expect(p.memory.injection).toEqual({ enabled: true, maxEntries: 5 });
    } finally {
      s.close();
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  test("malformed DB settings fail the policy closed (never a silent fallback)", () => {
    const s = createStore(join(dir, "malformed.db"));
    try {
      s.getDb()
        .query("INSERT INTO org_settings (id, settings, updated_at) VALUES (1, ?, ?)")
        .run('{"approvals": "nope"}', Date.now());
      const p = loadOrgPolicy(s, dir);
      expect(p.ok).toBe(false);
      expect(p.errors[0]).toContain("org_settings");
      expect(decidePolicyCall(p, "read", false).decision).toBe("deny");
      expect(decidePolicyCall(p, "read", false).reason).toContain("policy invalid");
    } finally {
      s.close();
    }
  });

  test("the space overlay wins over both: tightens the DB-merged org, loosening is clamped", async () => {
    writeConfig("response_mode: always\n");
    store.setOrgSettings({ response_mode: "mention" });
    const org = loadOrgPolicy(store, dir);
    expect(org.responseMode).toBe("mention"); // DB beats file
    // Overlay tightening applies on top of the DB value.
    const tight = await store.getOrCreateSpace({ platform: "slack", channel_id: "DBF1" });
    await store.updatePolicy(tight.id, JSON.stringify({ response_mode: "request-only" }));
    expect((await loadSpacePolicy(org, store, tight.id)).responseMode).toBe("request-only");
    // Overlay loosening is clamped to the DB value (tighten rule).
    const loose = await store.getOrCreateSpace({ platform: "slack", channel_id: "DBF2" });
    await store.updatePolicy(loose.id, JSON.stringify({ response_mode: "always" }));
    expect((await loadSpacePolicy(org, store, loose.id)).responseMode).toBe("mention");
  });

  test("overlay extensions tighten a DB-set allowlist", async () => {
    writeConfig("extensions:\n  allow:\n    - linear\n");
    store.setOrgSettings({ extensions: { allow: ["linear", "github"] } });
    const org = loadOrgPolicy(store, dir);
    // Issue #151 clamp: github is not in the file floor, so the DB cannot
    // add it to the allowlist (tighten-only) — the floor is the ceiling.
    expect(org.extensionsAllow).toEqual(["linear"]);
    const space = await store.getOrCreateSpace({ platform: "slack", channel_id: "DBF3" });
    // Overlay removes github from the DB allowlist and adds attio to deny.
    await store.updatePolicy(space.id, JSON.stringify({ extensions: { allow: ["github"], deny: ["attio"] } }));
    const eff = await loadSpacePolicy(org, store, space.id);
    expect(eff.extensionsAllow).toEqual(["linear"]);
    expect(eff.extensionsDeny).toEqual(["attio"]);
    expect(decideExtensionCall(eff, "linear").decision).toBe("allow");
    expect(decideExtensionCall(eff, "github").decision).toBe("deny"); // removed by the overlay
  });

  test("issue #151 clamp: always_approve cannot widen beyond the file floor; removals apply", () => {
    writeConfig("approvals:\n  always_approve:\n    - bash\n");
    const s = createStore(join(dir, "clamp-always.db"));
    try {
      // task is not in the file floor — adding it would auto-approve an
      // exec tool the floor never approved; the write is stored but the
      // effective list clamps to the floor with a warning.
      s.setOrgSettings({ approvals: { always_approve: ["bash", "task"] } });
      const p = loadOrgPolicy(s, dir);
      expect(p.ok).toBe(true);
      expect(p.alwaysApprove).toEqual(["bash"]);
      expect(p.warnings.join(" ")).toContain("always_approve");
      // Removals still apply: the DB can take entries away (tightens).
      s.setOrgSettings({ approvals: { always_approve: [] } });
      expect(loadOrgPolicy(s, dir).alwaysApprove).toEqual([]);
      // The issue's escalation, at the policy level: a floor that approves
      // bash but lists NOTHING in always_approve + a DB write adding bash →
      // bash stays out of the list and still routes ask-human.
      writeConfig("tools:\n  bash: allow\n");
      s.setOrgSettings({ approvals: { always_approve: ["bash"] } });
      const escalated = loadOrgPolicy(s, dir);
      expect(escalated.alwaysApprove).toEqual([]);
      expect(decidePolicyCall(escalated, "bash", false).decision).toBe("ask-human");
      expect(decidePolicyCall(escalated, "bash", false).autoApproved).toBe(false);
    } finally {
      s.close();
    }
  });

  test("issue #151 clamp: extensions.allow cannot widen beyond the file floor", () => {
    writeConfig("extensions:\n  allow:\n    - linear\n");
    const s = createStore(join(dir, "clamp-allow.db"));
    try {
      // github beyond the floor is clamped (warning); removals apply.
      s.setOrgSettings({ extensions: { allow: ["linear", "github"] } });
      const p = loadOrgPolicy(s, dir);
      expect(p.ok).toBe(true);
      expect(p.extensionsAllow).toEqual(["linear"]);
      expect(p.warnings.join(" ")).toContain("github");
      // An empty list cannot lift the restriction.
      s.setOrgSettings({ extensions: { allow: [] } });
      expect(loadOrgPolicy(s, dir).extensionsAllow).toEqual(["linear"]);
      // From an unrestricted floor, any non-empty DB list restricts (tightens).
      writeConfig("");
      s.setOrgSettings({ extensions: { allow: ["linear"] } });
      expect(loadOrgPolicy(s, dir).extensionsAllow).toEqual(["linear"]);
    } finally {
      s.close();
    }
  });

  test("issue #151 clamp: extensions.deny only adds; org_credentials cannot loosen", () => {
    writeConfig("extensions:\n  deny:\n    - attio\n  org_credentials: deny\n");
    const s = createStore(join(dir, "clamp-ext.db"));
    try {
      s.setOrgSettings({ extensions: { deny: ["linear"], org_credentials: "allow" } });
      const p = loadOrgPolicy(s, dir);
      expect(p.ok).toBe(true);
      expect(p.extensionsDeny).toEqual(["attio", "linear"]); // union with the floor
      expect(p.orgCredentials).toBe("deny"); // allow cannot loosen the floor's deny
      expect(p.warnings.join(" ")).toContain("org_credentials");
    } finally {
      s.close();
    }
  });
});
