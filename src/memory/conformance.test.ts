/**
 * Shared MemoryProvider conformance suite (memory epic, issue #19).
 *
 * Every backend must pass this suite — it proves interface parity across
 * SQLite, Mem0, and any future provider. Backends run it against a fresh
 * provider instance; external backends run it against a stub of their wire
 * contract (never a live service).
 */
import { describe, expect, test } from "bun:test";
import type { ConsolidationModelCall } from "./consolidation";
import type { MemoryProvider, MemoryScopeKey } from "./types";

export interface MemoryConformanceHarness {
  provider: MemoryProvider;
  runExplicitConsolidation?: (modelCall: ConsolidationModelCall) => Promise<void>;
}

export function runMemoryConformanceTests(
  makeHarness: () => Promise<MemoryConformanceHarness>,
) {
  describe("MemoryProvider conformance", () => {
    test("save + search round-trip (org scope)", async () => {
      const { provider: p } = await makeHarness();
      const saved = await p.save({
        scope: { kind: "org" },
        content: "The org deploys bottega per company.",
      });
      expect(saved.id).toBeTruthy();
      expect(saved.key).toEqual({ kind: "org" });
      const hits = await p.search({ scope: { kind: "org" }, query: "bottega" });
      expect(hits.length).toBeGreaterThanOrEqual(1);
      expect(hits[0].content).toContain("bottega");
    });

    test("org memory is shared across principals", async () => {
      const { provider: p } = await makeHarness();
      await p.save({ scope: { kind: "org" }, content: "shared fact about the company" });
      const hits = await p.search({
        scope: { kind: "org" },
        query: "shared fact",
      });
      expect(hits.length).toBeGreaterThanOrEqual(1);
    });

    test("user memory is isolated by principal", async () => {
      const { provider: p } = await makeHarness();
      await p.save({ scope: { kind: "person", principal: "alice" }, content: "alice prefers kebab case" });
      await p.save({ scope: { kind: "person", principal: "bob" }, content: "bob prefers snake case" });
      const alice = await p.search({ scope: { kind: "person", principal: "alice" }, query: "prefers" });
      expect(alice.length).toBe(1);
      expect(alice[0].key).toEqual({ kind: "person", principal: "alice" });
      const bob = await p.search({ scope: { kind: "person", principal: "bob" }, query: "prefers" });
      expect(bob.length).toBe(1);
      expect(bob[0].key).toEqual({ kind: "person", principal: "bob" });
    });

    test("user scope requires a principal", async () => {
      const { provider: p } = await makeHarness();
      // SAFETY: this malformed fixture intentionally omits the person principal to exercise each provider's runtime validation.
      expect(() => p.save({ scope: { kind: "person" } as MemoryScopeKey, content: "x" })).toThrow(/principal/);
    });

    test("limit is honored and capped", async () => {
      const { provider: p } = await makeHarness();
      for (let i = 0; i < 3; i++) {
        await p.save({ scope: { kind: "org" }, content: `limit probe ${i}` });
      }
      const hits = await p.search({ scope: { kind: "org" }, query: "limit probe", limit: 2 });
      expect(hits.length).toBe(2);
      expect(() => p.search({ scope: { kind: "org" }, query: "x", limit: 100 })).toThrow(/limit/);
    });

    test("metadata filter applies exactly", async () => {
      const { provider: p } = await makeHarness();
      await p.save({ scope: { kind: "org" }, content: "tagged fact", metadata: { source: "slack" } });
      await p.save({ scope: { kind: "org" }, content: "untagged fact" });
      const hits = await p.search({ scope: { kind: "org" }, query: "fact", metadata: { source: "slack" } });
      expect(hits.length).toBe(1);
      expect(hits[0].metadata.source).toBe("slack");
    });

    test("reports and honors its consolidation mode", async () => {
      const { provider: p, runExplicitConsolidation } = await makeHarness();
      expect(["explicit", "on-save"]).toContain(p.capabilities.consolidation);

      if (p.capabilities.consolidation === "explicit") {
        expect(runExplicitConsolidation).toBeDefined();
        await p.save({
          scope: { kind: "org" },
          content: "conformance consolidation source",
          metadata: { source: "conformance" },
        });
        await runExplicitConsolidation!(async () => "ADD conformance consolidated summary");
        const summaries = await p.search({
          scope: { kind: "org" },
          query: "conformance consolidated summary",
        });
        expect(summaries).toHaveLength(1);
        expect(summaries[0]!.metadata).toEqual({
          source: "consolidation",
          consolidated: "1",
        });
        return;
      }

      const first = await p.save({
        scope: { kind: "org" },
        content: "conformance duplicate active fact",
        metadata: { contract: "consolidation" },
      });
      const duplicate = await p.save({
        scope: { kind: "org" },
        content: "conformance duplicate active fact",
        metadata: { contract: "consolidation" },
      });
      expect(duplicate.id).toBe(first.id);
      const active = await p.search({
        scope: { kind: "org" },
        query: "conformance duplicate active fact",
        metadata: { contract: "consolidation" },
      });
      expect(active.filter((entry) => entry.content === "conformance duplicate active fact")).toHaveLength(1);
    });

    test("prunes through the provider seam or rejects the required operation loudly", async () => {
      const { provider: p } = await makeHarness();
      for (let i = 1; i <= 3; i++) {
        await p.save({
          scope: { kind: "org" },
          content: `conformance digest ${i}`,
          metadata: {
            kind: "digest",
            space: "slack:conformance",
            since: String(i - 1),
            until: String(i),
          },
        });
      }

      if (p.capabilities.digestPruning === "explicit") {
        await expect(p.pruneDigests("slack:conformance", 2)).resolves.toBe(1);
        const retained = await p.search({
          scope: { kind: "org" },
          query: "",
          metadata: { kind: "digest", space: "slack:conformance" },
          limit: 20,
        });
        expect(retained.map((entry) => entry.content)).toEqual([
          "conformance digest 3",
          "conformance digest 2",
        ]);
        return;
      }

      await expect(p.pruneDigests("slack:conformance", 2)).rejects.toThrow(
        /does not support required digest pruning/,
      );
      const retained = await p.search({
        scope: { kind: "org" },
        query: "",
        metadata: { kind: "digest", space: "slack:conformance" },
        limit: 20,
      });
      expect(retained).toHaveLength(3);
    });

    test("has no general delete/update paths", async () => {
      const { provider: p } = await makeHarness();
      const providerKeys = Object.keys(p);
      expect(providerKeys).toContain("save");
      expect(providerKeys).toContain("search");
      expect(providerKeys).toContain("pruneDigests");
      expect(providerKeys).not.toContain("delete");
      expect(providerKeys).not.toContain("update");
    });
  });
}
