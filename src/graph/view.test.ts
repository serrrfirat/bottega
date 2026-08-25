/**
 * Org graph view projection tests (issue #357). Hermetic: a seeded temp
 * store (two spaces), the shared SQLite memory provider, and real store
 * APIs — the same tables production queries. Covers the issue's test list:
 * projection correctness across two spaces, multi-hop neighbors at depth
 * ≤2, provenance on every decision/memory node, fail-closed resource
 * bounds, and mnesis-style remote recall stitching.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteMemoryProvider } from "../memory/sqlite";
import type { MemoryEntry } from "../memory/types";
import { createStore, type Store } from "../store/db";
import {
  DEFAULT_MAX_NODES,
  GraphBoundError,
  type GraphMemoryRecall,
  memoryProviderRecall,
  neighbors,
  projectGraph,
} from "./view";

const dir = mkdtempSync(join(tmpdir(), "graph-view-"));
let harnessCount = 0;

function harness() {
  harnessCount += 1;
  const created = createStore(join(dir, `view-${harnessCount}.db`));
  return { store: created, db: created.getDb(), cleanup: () => created.close() };
}

async function seedTwoSpaces(target: Store): Promise<{ wiA1: string; wiA2: string; wiB1: string }> {
  await target.getOrCreateSpace({ platform: "slack", channel_id: "C1", name: "Billing" });
  await target.getOrCreateSpace({ platform: "slack", channel_id: "C2", name: "Pricing" });
  // Space A item one: requester U1, claimed by an executor, repo-pinned.
  const a1 = await target.createWorkItem({
    space_id: "slack:C1",
    requester: "U1",
    description: "Fix billing webhook retries\nsecond line detail",
    repo: "acme/billing",
  });
  await target.claimWorkItemById(a1.id, "agent:exec-1");
  // Space A item two: carries a PR url — the delivered edge's anchor.
  const a2 = await target.createWorkItem({
    space_id: "slack:C1",
    requester: "U2",
    description: "Refresh pricing page copy",
    pr_url: "https://github.com/acme/billing/pull/42",
  });
  // Space B item: must stay out of space A's scoped projection.
  const b1 = await target.createWorkItem({
    space_id: "slack:C2",
    requester: "U3",
    description: "Evaluate vendor X contract",
  });
  // Scheduled job owned by U1 in space A.
  await target.createSchedulerJob({ action: "standup_digest", cron: "0 12 * * *", spaceId: "slack:C1", createdBy: "U1" });
  return { wiA1: a1.id, wiA2: a2.id, wiB1: b1.id };
}

describe("projectGraph (issue #357)", () => {
  test("projects nodes and derived edges across two spaces", async () => {
    const h = harness();
    try {
      const seeded = await seedTwoSpaces(h.store);
      const projection = await projectGraph(h.store);

      const kinds = (kind: string) => projection.nodes.filter((node) => node.kind === kind);
      expect(kinds("space").map((s) => s.id).sort()).toEqual(["slack:C1", "slack:C2"]);
      expect(kinds("work-item").map((n) => n.id).sort()).toEqual([seeded.wiA1, seeded.wiA2, seeded.wiB1].sort());
      expect(kinds("person").map((n) => n.id).sort()).toEqual(["U1", "U2", "U3", "agent:exec-1"].sort());
      expect(kinds("repo").map((n) => n.id)).toEqual(["acme/billing"]);
      expect(kinds("job").length).toBe(1);
      expect(kinds("pr").map((n) => n.id)).toEqual(["https://github.com/acme/billing/pull/42"]);

      const jobId = kinds("job")[0]?.id ?? "";
      const edge = (rel: string, from: string, to: string) =>
        projection.edges.some(
          (e) => e.rel === rel && `${e.from.kind}:${e.from.id}` === from && `${e.to.kind}:${e.to.id}` === to,
        );
      expect(edge("created", `work-item:${seeded.wiA1}`, "person:U1")).toBe(true);
      expect(edge("assigned", `work-item:${seeded.wiA1}`, "person:agent:exec-1")).toBe(true);
      expect(edge("targets", `work-item:${seeded.wiA1}`, "repo:acme/billing")).toBe(true);
      expect(edge("delivered", `work-item:${seeded.wiA2}`, "pr:https://github.com/acme/billing/pull/42")).toBe(true);
      expect(edge("created", `job:${jobId}`, "person:U1")).toBe(true);
      expect(edge("scheduled-in", `job:${jobId}`, "space:slack:C1")).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  test("a scoped projection excludes other spaces' nodes", async () => {
    const h = harness();
    try {
      const seeded = await seedTwoSpaces(h.store);
      const projection = await projectGraph(h.store, { spaceId: "slack:C1" });
      expect(projection.nodes.some((n) => n.kind === "work-item" && n.id === seeded.wiB1)).toBe(false);
      expect(projection.nodes.some((n) => n.kind === "work-item" && n.id === seeded.wiA1)).toBe(true);
      expect(projection.nodes.some((n) => n.kind === "space" && n.id === "slack:C2")).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  test("memory nodes carry provenance and decided-in/mentions edges", async () => {
    const h = harness();
    try {
      const seeded = await seedTwoSpaces(h.store);
      const provider = createSqliteMemoryProvider(h.db);
      await provider.save({
        scope: { kind: "channel", spaceId: "slack:C1" },
        content: `Decision: retry budget raised to 5 — tracked by ${seeded.wiA1}`,
        source: "auto_extract",
      });

      const projection = await projectGraph(h.store, { spaceId: "slack:C1" });
      const memories = projection.nodes.filter((n) => n.kind === "memory");
      expect(memories.length).toBe(1);
      // Issue acceptance: provenance present on EVERY decision/memory node.
      for (const memory of memories) {
        expect(memory.provenance).toBeDefined();
        expect(memory.provenance?.source).toBe("auto_extract");
        expect(memory.provenance?.principal).toBeNull();
        // Channel-scope entries decode their space even without consolidation columns.
        expect(memory.provenance?.spaceId).toBe("slack:C1");
      }
      expect(
        projection.edges.some(
          (e) => e.rel === "decided-in" && e.from.id === memories[0]?.id && e.to.id === "slack:C1",
        ),
      ).toBe(true);
      expect(projection.edges.some((e) => e.rel === "mentions" && e.to.id === seeded.wiA1)).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  test("result JSON contributes additional delivered edges", async () => {
    const h = harness();
    try {
      const seeded = await seedTwoSpaces(h.store);
      h.db
        .prepare("UPDATE work_items SET result = ? WHERE id = ?")
        .run(JSON.stringify({ pr_url: "https://github.com/acme/billing/pull/99", summary: "done" }), seeded.wiA1);
      const projection = await projectGraph(h.store);
      expect(projection.nodes.some((n) => n.kind === "pr" && n.id.endsWith("/pull/99"))).toBe(true);
      expect(
        projection.edges.some((e) => e.rel === "delivered" && e.from.id === seeded.wiA1 && e.to.id.endsWith("/pull/99")),
      ).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  test("fail-closed bounds: tiny maxNodes throws instead of truncating", async () => {
    const h = harness();
    try {
      await seedTwoSpaces(h.store);
      expect(projectGraph(h.store, { maxNodes: 3 })).rejects.toBeInstanceOf(GraphBoundError);
    } finally {
      h.cleanup();
    }
  });
});

describe("neighbors (issue #357)", () => {
  test("multi-hop walk respects depth ≤2", async () => {
    const h = harness();
    try {
      await seedTwoSpaces(h.store);
      // U2 --created--> wiA2 --delivered--> PR: exactly two hops.
      const hood = await neighbors(h.store, { kind: "person", id: "U2" }, { spaceId: "slack:C1" });
      expect(hood.nodes.some((n) => n.kind === "work-item")).toBe(true);
      expect(hood.nodes.some((n) => n.kind === "pr")).toBe(true);
      // Depth cap: from the job, U1 is 1 hop and wiA1 is 2 hops, but
      // wiA1's repo would be a THIRD hop — excluded at maxDepth 2.
      const jobNode = (await projectGraph(h.store)).nodes.find((n) => n.kind === "job");
      if (jobNode === undefined) throw new Error("expected a job node");
      const jobHood = await neighbors(h.store, jobNode, {});
      expect(jobHood.nodes.some((n) => n.kind === "person" && n.id === "U1")).toBe(true);
      expect(jobHood.nodes.some((n) => n.kind === "work-item")).toBe(true);
      expect(jobHood.nodes.some((n) => n.kind === "repo")).toBe(false);

      // One more hop IS reachable when explicitly allowed.
      const deeper = await neighbors(h.store, jobNode, { maxDepth: 3 });
      expect(deeper.nodes.some((n) => n.kind === "repo")).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  test("rel filter restricts traversal to one relationship kind", async () => {
    const h = harness();
    try {
      await seedTwoSpaces(h.store);
      const hood = await neighbors(h.store, { kind: "person", id: "U1" }, { rel: "created", spaceId: "slack:C1" });
      expect(hood.nodes.some((n) => n.kind === "work-item")).toBe(true);
      // assigned edges lead to agent:exec-1 — not on the created-only walk.
      expect(hood.edges.every((edge) => edge.rel === "created")).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  test("bounds are fail-closed: over-deep or over-wide walks throw", async () => {
    const h = harness();
    try {
      await seedTwoSpaces(h.store);
      expect(neighbors(h.store, { kind: "person", id: "U1" }, { maxDepth: 9 })).rejects.toBeInstanceOf(GraphBoundError);
      expect(neighbors(h.store, { kind: "person", id: "U1" }, { maxNodes: 2 })).rejects.toBeInstanceOf(GraphBoundError);
      expect(DEFAULT_MAX_NODES).toBeGreaterThan(0);
    } finally {
      h.cleanup();
    }
  });
});

describe("remote recall stitching (issue #357 mnesis delegation)", () => {
  test("term-driven seam results join the projection with provenance", async () => {
    const h = harness();
    try {
      await seedTwoSpaces(h.store);
      let calls = 0;
      const entry: MemoryEntry = {
        id: "mem_mnesis_1",
        key: { kind: "channel", spaceId: "slack:C1" },
        content: "Decision: adopt vendor X usage-based pricing",
        metadata: {},
        createdAt: Date.now(),
        provenance: { source: "reflection", spaceId: null, principal: null, scopeLabel: "channel:slack:C1" },
      };
      const seam: GraphMemoryRecall = {
        async recall(terms, scope, limit) {
          calls += 1;
          expect(terms.join(" ")).toContain("vendor");
          expect(scope).toEqual({ kind: "channel", spaceId: "slack:C1" });
          expect(limit).toBeGreaterThan(0);
          return [entry];
        },
      };
      const withTerms = await projectGraph(h.store, { spaceId: "slack:C1", terms: ["vendor"], memoryRecall: seam });
      const stitched = withTerms.nodes.find((n) => n.kind === "memory" && n.id === "mem_mnesis_1");
      expect(stitched).toBeDefined();
      expect(stitched?.provenance?.source).toBe("reflection");
      expect(
        withTerms.edges.some((e) => e.rel === "decided-in" && e.to.id === "slack:C1" && e.from.id === "mem_mnesis_1"),
      ).toBe(true);

      // Fail-closed posture: no terms → the remote backend is never called.
      await projectGraph(h.store, { spaceId: "slack:C1", memoryRecall: seam });
      expect(calls).toBe(1);
    } finally {
      h.cleanup();
    }
  });

  test("memoryProviderRecall adapts a provider search and yields nothing without terms", async () => {
    let searched = "";
    const fake = {
      async search(query: { query: string }) {
        searched = query.query;
        return [];
      },
    };
    // SAFETY: the fake supplies the exact `search` seam memoryProviderRecall
    // calls; the remaining MemoryProvider surface is unreachable here.
    const seam = memoryProviderRecall(fake as never);
    expect(await seam.recall(["pricing", "vendor"], { kind: "org" }, 20)).toEqual([]);
    expect(searched).toBe("pricing vendor");
    expect(await seam.recall([], { kind: "org" }, 20)).toEqual([]);
  });
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});
