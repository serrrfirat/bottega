/**
 * Manifest tool generator — PURE-LOGIC tests (issue #157): tier
 * classification, wire-name → manifest-name conversion, and the re-discovery
 * merge. No SDK transport is constructed here; the transport-leg tests (fake
 * tools/list over the SDK's InMemoryTransport seam, dead-server bounds) live
 * in generate-tools.transport.test.ts.
 *
 * SPLIT RATIONALE (2026-08-26): under `bun test --coverage --parallel=1` on
 * Linux CI the combined file went silent for ~1085s inside the SDK transport
 * legs and the coverage gate had to kill the whole suite (runs
 * 32949859379/32953011447). Pure logic stays in this file inside the
 * coverage invocation; transport legs run in their own file with per-test
 * runner timeouts so a wedged leg can never stall the gate again.
 */
import { describe, expect, test } from "bun:test";
import { classifyTier, refreshManifestTools, toolsFromMcpList } from "./generate-tools";
import type { ExtensionTool } from "./manifest";

describe("classifyTier (issue #157 conservative default tiers)", () => {
  test("the server's own hints win", () => {
    expect(classifyTier("anything", { readOnlyHint: true })).toBe("read");
    expect(classifyTier("anything", { destructiveHint: true })).toBe("exec");
    // Contradictory hints resolve to the SAFER tier: destructive wins.
    expect(classifyTier("anything", { readOnlyHint: true, destructiveHint: true })).toBe("exec");
  });

  test("confident read verbs classify read", () => {
    for (const name of ["get_issue", "list_repositories", "search_issues", "fetch_commit", "describe_entity"]) {
      expect(classifyTier(name)).toBe("read");
    }
  });

  test("clearly destructive verbs classify exec", () => {
    for (const name of ["delete_issue", "remove_label", "purge_cache", "wipe_all_data", "cancel_workflow_run"]) {
      expect(classifyTier(name)).toBe("exec");
    }
  });

  test("everything unknown or mutating lands on write (approval)", () => {
    for (const name of ["create_issue", "update_issue", "set_status", "merge_pull_request", "repository", "blob"]) {
      expect(classifyTier(name)).toBe("write");
    }
  });
});

describe("toolsFromMcpList (issue #157 pure conversion)", () => {
  test("unrepresentable wire names and missing inputSchema are skipped, never silently dropped", () => {
    const generation = toolsFromMcpList(
      [
        { name: "createIssue", description: "camelCase wire name", inputSchema: { type: "object", properties: {} } },
        { name: "with space", description: "space in wire name", inputSchema: { type: "object" } },
        { name: "no_schema_tool", description: "omits the MCP-required inputSchema" },
        { name: "get_ok", description: "representable", inputSchema: { type: "object" } },
      ],
      "fake",
    );
    expect(generation.tools.map((tool) => tool.name)).toEqual(["fake.get_ok"]);
    expect(generation.skipped.map((entry) => entry.tool)).toEqual(["createIssue", "with space", "no_schema_tool"]);
    expect(generation.skipped[0]!.reason).toContain("not a valid manifest identifier");
    expect(generation.skipped[2]!.reason).toContain("no inputSchema");
  });

  test("a missing server description yields an honest fallback, never an empty description", () => {
    const generation = toolsFromMcpList([{ name: "get_thing", inputSchema: { type: "object" } }], "fake");
    expect(generation.tools[0]!.description).toContain("no description from the MCP server");
  });
});

describe("refreshManifestTools (issue #157 re-discovery)", () => {
  test("existing tools keep their reviewed tiers; new tools are added for review, never silent", () => {
    const existing: ExtensionTool[] = [
      {
        name: "fake.delete_issue",
        providerName: "delete_issue",
        tier: "write", // human-reviewed: delete needs approval only, not exec
        description: "reviewed",
        params: [],
      },
      { name: "fake.search_issues", providerName: "search_issues", tier: "read", description: "reviewed", params: [] },
    ];
    const generated: ExtensionTool[] = [
      {
        name: "fake.delete_issue",
        providerName: "delete_issue",
        tier: "exec", // the heuristic's default — MUST NOT clobber the review
        description: "server default",
        params: [],
      },
      { name: "fake.search_issues", providerName: "search_issues", tier: "read", description: "server default", params: [] },
      { name: "fake.create_issue", providerName: "create_issue", tier: "write", description: "server default", params: [] },
    ];

    const refreshed = refreshManifestTools(existing, generated);
    expect(refreshed.tools.map((tool) => [tool.name, tool.tier])).toEqual([
      ["fake.delete_issue", "write"],
      ["fake.search_issues", "read"],
      ["fake.create_issue", "write"],
    ]);
    expect(refreshed.added.map((tool) => tool.name)).toEqual(["fake.create_issue"]);
    expect(refreshed.added[0]!.tier).toBe("write");
  });

  test("an unchanged surface reports no additions", () => {
    const existing: ExtensionTool[] = [
      { name: "fake.get_issue", providerName: "get_issue", tier: "read", description: "d", params: [] },
    ];
    const refreshed = refreshManifestTools(existing, [
      { name: "fake.get_issue", providerName: "get_issue", tier: "read", description: "d", params: [] },
    ]);
    expect(refreshed.added).toEqual([]);
    expect(refreshed.tools).toHaveLength(1);
  });
});
