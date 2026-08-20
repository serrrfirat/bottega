import { describe, expect, test } from "bun:test";
import type { AuditModule } from "../policy/audit";
import type { MemoryEntry, MemoryProvider, MemorySaveInput, MemorySearchQuery } from "../memory/types";
import { OBSERVER_READ_EVENT } from "../store/audit-events";
import type { Space, Store } from "../store/db";
import type { SchedulerActionContext } from "./types";
import { orgPulseAction } from "./observer";

const NOW = Date.UTC(2026, 7, 17, 12);
const DAY_MS = 24 * 60 * 60 * 1_000;

type AuditInput = Parameters<AuditModule["appendAudit"]>[0];

class FakeMemoryProvider implements MemoryProvider {
  readonly searches: MemorySearchQuery[] = [];

  constructor(private readonly entries: MemoryEntry[], private readonly searchError?: Error) {}

  async save(_input: MemorySaveInput): Promise<MemoryEntry> {
    throw new Error("observer must not save memory");
  }

  async search(query: MemorySearchQuery): Promise<MemoryEntry[]> {
    this.searches.push(query);
    if (this.searchError) throw this.searchError;

    return this.entries
      .filter((entry) => entry.scope === query.scope)
      .filter((entry) =>
        Object.entries(query.metadata ?? {}).every(([key, value]) => entry.metadata[key] === value),
      )
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, query.limit);
  }
}

function memory(
  id: string,
  kind: "reflection" | "digest",
  content: string,
  createdAt: number,
  metadata: Record<string, string> = {},
): MemoryEntry {
  return {
    id,
    scope: "org",
    principal: null,
    content,
    metadata: { kind, ...metadata },
    createdAt,
  };
}

function pulseSpace(id = "pulse"): Space {
  return {
    id,
    platform: "slack",
    channel_id: "C_PULSE",
    name: "company-pulse",
    policy_json: "{}",
    settings: "{}",
    created_at: NOW - DAY_MS,
    updated_at: NOW - DAY_MS,
  };
}

function makeContext(options: {
  entries?: MemoryEntry[];
  space?: Space | null;
  searchError?: Error;
} = {}) {
  const space = options.space === undefined ? pulseSpace() : options.space;
  const provider = new FakeMemoryProvider(options.entries ?? [], options.searchError);
  const audits: AuditInput[] = [];
  const posts: Array<{ spaceId: string; text: string; blocks?: unknown[] }> = [];
  const audit: AuditModule = {
    async appendAudit(entry) {
      audits.push(entry);
      return audits.length;
    },
    async listAudit() {
      return [];
    },
  };
  // SAFETY: orgPulseAction's only store access is getSpace (observer.ts); the
  // stub covers that surface and the suite asserts the action never touches
  // the rest of Store.
  const store = {
    async getSpace(id: string) {
      return space?.id === id ? space : null;
    },
  } as Store;

  return {
    provider,
    audits,
    posts,
    ctx: {
      store,
      audit,
      memoryProvider: provider,
      async postMessage(spaceId: string, text: string, opts?: { blocks?: unknown[] }) {
        posts.push({ spaceId, text, blocks: opts?.blocks });
        return "1712345.6789";
      },
      async loadPolicy() {
        throw new Error("observer must not load space policy");
      },
      log() {},
      now: () => NOW,
    } satisfies SchedulerActionContext,
  };
}

describe("orgPulseAction", () => {
  test("posts a sourced weekly summary and audits both org-memory reads and the post", async () => {
    const { ctx, provider, audits, posts } = makeContext({
      entries: [
        memory("ref_reliability_1", "reflection", "Build queue recovered.", NOW - DAY_MS, {
          topic: "Reliability",
        }),
        memory("ref_reliability_2", "reflection", "Retries increased.", NOW - 2 * DAY_MS, {
          topic: "Reliability",
        }),
        memory("ref_customer", "reflection", "Customers need export controls.", NOW - 3 * DAY_MS, {
          topic: "Customer requests",
        }),
        memory("ref_old", "reflection", "Old pattern.", NOW - 8 * DAY_MS, { topic: "Old" }),
        memory(
          "digest_sso",
          "digest",
          "Customers repeatedly requested SSO. The rest of this digest is not a theme.",
          NOW - DAY_MS,
        ),
        memory("digest_deploy", "digest", "Deployments became more reliable\nMore details follow.", NOW - 2 * DAY_MS),
        memory(
          "digest_long",
          "digest",
          `${"A".repeat(150)}. This second sentence must not appear.`,
          NOW - 3 * DAY_MS,
        ),
        memory("digest_old", "digest", "Old digest theme.", NOW - 9 * DAY_MS),
      ],
    });

    await orgPulseAction.run({ pulse_space: "pulse" }, ctx);

    expect(orgPulseAction.name).toBe("org_pulse");
    expect(provider.searches).toEqual([
      { query: "", scope: "org", metadata: { kind: "reflection" }, limit: 20 },
      { query: "", scope: "org", metadata: { kind: "digest" }, limit: 20 },
    ]);
    expect(posts).toHaveLength(1);
    expect(posts[0]!.spaceId).toBe("pulse");
    expect(posts[0]!.text).toContain("*Weekly company-pattern pulse*");
    expect(posts[0]!.text).toContain("• Reliability — 2");
    expect(posts[0]!.text).toContain("• Customer requests — 1");
    expect(posts[0]!.text).toContain("Customers repeatedly requested SSO.");
    expect(posts[0]!.text).toContain("Deployments became more reliable");
    expect(posts[0]!.text).not.toContain("More details follow");
    expect(posts[0]!.text).toContain("ref_reliability_1 (2026-08-16)");
    expect(posts[0]!.text).toContain("ref_customer (2026-08-14)");
    expect(posts[0]!.text).toContain("digest_sso (2026-08-16)");
    expect(posts[0]!.text).toContain("… — digest_long (2026-08-14)");
    expect(posts[0]!.text).not.toContain("This second sentence must not appear");
    expect(posts[0]!.text).not.toContain("ref_old");
    expect(posts[0]!.text).not.toContain("digest_old");
    // Issue #279: the pulse also ships as Block Kit tables alongside the text.
    const blocks = posts[0]!.blocks as Array<{ text?: { text?: string } }>;
    expect(blocks).toBeDefined();
    const tableText = blocks.map((b) => b.text?.text ?? "").join("\n");
    expect(tableText).toContain("*Reflection topics*");
    expect(tableText).toContain("*Notable digest themes*");
    expect(tableText).toContain("Reliability");
    expect(tableText).toContain("Customer requests");
    expect(tableText).toContain("Customers repeatedly requested SSO.");
    expect(tableText).not.toContain("ref_old");
    expect(tableText).not.toContain("digest_old");

    expect(audits).toHaveLength(3);
    expect(audits.map((entry) => entry.event_type)).toEqual([
      OBSERVER_READ_EVENT,
      OBSERVER_READ_EVENT,
      OBSERVER_READ_EVENT,
    ]);
    expect(audits[0]!.payload).toEqual({ scope: "org", metadata: { kind: "reflection" }, count: 4 });
    expect(audits[1]!.payload).toEqual({ scope: "org", metadata: { kind: "digest" }, count: 4 });
    expect(audits[2]!.payload).toEqual({ pulse_space: "pulse", posted: true });
    expect(audits.every((entry) => entry.actor === "scheduler:org_pulse")).toBe(true);
    expect(audits.every((entry) => entry.space_id === "pulse")).toBe(true);
  });

  test("posts a brief no-patterns pulse when the week has no matching entries", async () => {
    const { ctx, posts } = makeContext({
      entries: [memory("old", "digest", "Too old.", NOW - 8 * DAY_MS)],
    });

    await orgPulseAction.run({ pulse_space: "pulse" }, ctx);

    expect(posts).toHaveLength(1);
    expect(posts[0]!.text).toContain("No company patterns found");
    expect(posts[0]!.text).toContain("last 7 days");
  });

  test("fails closed for an unknown pulse space without reading or posting", async () => {
    const { ctx, provider, audits, posts } = makeContext({ space: null });

    await expect(orgPulseAction.run({ pulse_space: "missing" }, ctx)).resolves.toBeUndefined();

    expect(provider.searches).toHaveLength(0);
    expect(posts).toHaveLength(0);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.event_type).toBe(OBSERVER_READ_EVENT);
    expect(audits[0]!.payload).toEqual({ error: 'pulse space "missing" does not exist' });
  });

  test("audits a memory failure and never throws past the scheduler runner", async () => {
    const { ctx, audits, posts } = makeContext({ searchError: new Error("memory offline") });

    await expect(orgPulseAction.run({ pulse_space: "pulse" }, ctx)).resolves.toBeUndefined();

    expect(posts).toHaveLength(0);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.payload).toEqual({ error: "memory offline" });
  });
});
