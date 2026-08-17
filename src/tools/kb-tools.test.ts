import { afterAll, describe, expect, test } from "bun:test";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isKnownTool, resolveTier } from "../policy/config";
import { createStore, type Store } from "../store/db";
import { kbToolDefinitions } from "./kb-tools";
import { z } from "zod";

// SAFETY: the kb tools under test never read the extension context; an empty
// stub stands in for the real session context.
const unusedContext = {} as ExtensionContext;

const stores: Store[] = [];
const tempDir = mkdtempSync(join(tmpdir(), "bottega-kb-tools-"));

afterAll(() => {
  for (const store of stores.splice(0)) store.close();
  rmSync(tempDir, { recursive: true, force: true });
});

function freshStore(): Store {
  const store = createStore(join(tempDir, `store-${stores.length}.db`));
  stores.push(store);
  return store;
}

function queuedKbJobs(store: Store): Array<{ id: string; payload: { url: string } }> {
  // SAFETY: the SELECT reads exactly the worker_jobs columns the row mapping
  // below uses; the store's enqueueJob is the only writer in these tests.
  const rows = store
    .getDb()
    .query("SELECT id, payload FROM worker_jobs WHERE kind = 'kb' ORDER BY created_at")
    .all() as Array<{ id: string; payload: string }>;
  return rows.map((row) => {
    const parsed = z.object({ url: z.string() }).safeParse(JSON.parse(row.payload));
    if (!parsed.success) throw new Error(`unexpected kb job payload: ${parsed.error.message}`);
    return { id: row.id, payload: parsed.data };
  });
}

const TWO_SOURCES = {
  sources: [
    { id: "one", url: "https://docs.example.com/one", type: "html" },
    { id: "two", url: "https://docs.example.com/two", type: "html" },
  ],
};

describe("kb_ingest", () => {
  test("is a write-tier SDK tool and dispatches one kind=kb job per configured source", async () => {
    const store = freshStore();
    const [tool] = kbToolDefinitions({ store, config: TWO_SOURCES });

    expect(tool.name).toBe("kb_ingest");
    expect(tool.approval).toBe("write");
    expect(isKnownTool("kb_ingest")).toBe(true);
    expect(resolveTier("kb_ingest")).toBe("write");

    const result = await tool.execute("tc1", {}, undefined, undefined, unusedContext);
    expect(result.isError).not.toBe(true);
    const firstContent = result.content[0];
    expect(firstContent?.type).toBe("text");
    if (firstContent?.type !== "text") throw new Error("expected text tool output");
    const dispatched = z
      .object({ dispatched: z.array(z.string()) })
      .safeParse(JSON.parse(firstContent.text));
    expect(dispatched.success).toBe(true);
    if (!dispatched.success) throw new Error(`unexpected dispatch result: ${dispatched.error.message}`);
    expect(dispatched.data.dispatched).toHaveLength(2);
    expect(queuedKbJobs(store).map((job) => job.payload.url).sort()).toEqual([
      "https://docs.example.com/one",
      "https://docs.example.com/two",
    ]);
    for (const id of dispatched.data.dispatched) {
      const row = await store.getJob(id);
      expect(row).toMatchObject({ kind: "kb", status: "queued" });
      expect(row!.spaceId).toBeUndefined();
    }
  });

  test("a source id dispatches exactly that source", async () => {
    const store = freshStore();
    const [tool] = kbToolDefinitions({ store, config: TWO_SOURCES });

    const result = await tool.execute("tc2", { source: "two" }, undefined, undefined, unusedContext);
    expect(result.isError).not.toBe(true);
    expect(queuedKbJobs(store).map((job) => job.payload.url)).toEqual(["https://docs.example.com/two"]);
  });

  test("fails closed for an unknown source id — nothing dispatched", async () => {
    const store = freshStore();
    const [tool] = kbToolDefinitions({ store, config: TWO_SOURCES });

    const result = await tool.execute("tc3", { source: "missing" }, undefined, undefined, unusedContext);
    expect(result.isError).toBe(true);
    expect(result.content[0]?.type).toBe("text");
    if (result.content[0]?.type !== "text") throw new Error("expected text tool output");
    expect(result.content[0].text).toContain("unknown KB source");
    expect(queuedKbJobs(store)).toHaveLength(0);
  });

  test("fails closed when no sources are configured — nothing dispatched", async () => {
    const store = freshStore();
    const [tool] = kbToolDefinitions({ store, config: { sources: [] } });

    const result = await tool.execute("tc4", {}, undefined, undefined, unusedContext);
    expect(result.isError).toBe(true);
    if (result.content[0]?.type !== "text") throw new Error("expected text tool output");
    expect(result.content[0].text).toContain("no KB sources configured (config/kb.yml)");
    expect(queuedKbJobs(store)).toHaveLength(0);
  });
});
