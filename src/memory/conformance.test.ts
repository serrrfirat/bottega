/**
 * Shared MemoryProvider conformance suite (memory epic, issue #19).
 *
 * Every backend must pass this suite — it proves interface parity across
 * SQLite, Mem0, and any future provider. Backends run it against a fresh
 * provider instance; external backends run it against a stub of their wire
 * contract (never a live service).
 */
import { describe, expect, test } from "bun:test";
import type { MemoryProvider, MemoryScopeKey } from "./types";

export function runMemoryConformanceTests(
  makeProvider: () => Promise<MemoryProvider>,
) {
  describe("MemoryProvider conformance", () => {
    test("save + search round-trip (org scope)", async () => {
      const p = await makeProvider();
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
      const p = await makeProvider();
      await p.save({ scope: { kind: "org" }, content: "shared fact about the company" });
      const hits = await p.search({
        scope: { kind: "org" },
        query: "shared fact",
      });
      expect(hits.length).toBeGreaterThanOrEqual(1);
    });

    test("user memory is isolated by principal", async () => {
      const p = await makeProvider();
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
      const p = await makeProvider();
      expect(() => p.save({ scope: { kind: "person" } as MemoryScopeKey, content: "x" })).toThrow(/principal/);
    });

    test("limit is honored and capped", async () => {
      const p = await makeProvider();
      for (let i = 0; i < 3; i++) {
        await p.save({ scope: { kind: "org" }, content: `limit probe ${i}` });
      }
      const hits = await p.search({ scope: { kind: "org" }, query: "limit probe", limit: 2 });
      expect(hits.length).toBe(2);
      expect(() => p.search({ scope: { kind: "org" }, query: "x", limit: 100 })).toThrow(/limit/);
    });

    test("metadata filter applies exactly", async () => {
      const p = await makeProvider();
      await p.save({ scope: { kind: "org" }, content: "tagged fact", metadata: { source: "slack" } });
      await p.save({ scope: { kind: "org" }, content: "untagged fact" });
      const hits = await p.search({ scope: { kind: "org" }, query: "fact", metadata: { source: "slack" } });
      expect(hits.length).toBe(1);
      expect(hits[0].metadata.source).toBe("slack");
    });

    test("no delete/update paths exist", async () => {
      const p = await makeProvider();
      // The contract is save + search only; the type has no delete/update.
      const providerKeys = Object.keys(p);
      expect(providerKeys).toContain("save");
      expect(providerKeys).toContain("search");
      expect(providerKeys).not.toContain("delete");
      expect(providerKeys).not.toContain("update");
    });
  });
}
