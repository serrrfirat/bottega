/**
 * Memory-context injection tests (issue #42, supersedes #23).
 *
 * Hermetic: a fake provider and a minimal ExtensionAPI harness drive the
 * `context` event handler directly — no SDK session, no model, no network.
 */
import { describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { MemoryEntry, MemoryProvider, MemorySaveInput, MemorySearchQuery } from "../memory/types";
import { MEMORY_INJECTION_PREFIX, memoryContextExtension, renderInjection, type MemoryContextExtensionOpts } from "./memory-context";

type TestMessage = { role: "user" | "developer" | "assistant"; content: string; timestamp: number };

function entry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: "mem_1",
    scope: "org",
    principal: null,
    content: "the org ships bottega weekly",
    metadata: {},
    createdAt: 1000,
    ...overrides,
  };
}

class FakeProvider implements MemoryProvider {
  searches: MemorySearchQuery[] = [];
  hits: MemoryEntry[] = [];

  async save(input: MemorySaveInput): Promise<MemoryEntry> {
    return entry({ content: input.content, scope: input.scope, principal: input.principal ?? null, metadata: input.metadata ?? {} });
  }

  async search(query: MemorySearchQuery): Promise<MemoryEntry[]> {
    this.searches.push(query);
    return this.hits;
  }
}

interface Harness {
  provider: FakeProvider;
  context(messages: TestMessage[]): Promise<{ messages: TestMessage[] } | undefined>;
  agentStart(): Promise<void>;
}

/** Events the memory extension registers for; the harness dispatches structural subsets. */
type HarnessEvent = { type: "context"; messages: TestMessage[] } | { type: "agent_start" };

/** Handler shape the extension registers (context returns injected messages, agent_start returns nothing). */
type RegisteredHandler = (
  event: HarnessEvent,
  ctx: ExtensionContext,
) => Promise<{ messages: TestMessage[] } | undefined> | undefined;

/** Minimal ExtensionAPI fake: records the handlers the extension registers. */
function fakeApi(handlers: Map<string, RegisteredHandler>): ExtensionAPI {
  // SAFETY: memoryContextExtension only calls pi.on(...) — the fake implements exactly
  // that surface, and the remaining ExtensionAPI members are never touched.
  return {
    on(event: string, handler: RegisteredHandler): void {
      handlers.set(event, handler);
    },
  } as ExtensionAPI;
}

function loadExtension(opts: MemoryContextExtensionOpts = {}): Harness {
  const provider = new FakeProvider();
  const handlers = new Map<string, RegisteredHandler>();
  memoryContextExtension(provider, opts)(fakeApi(handlers));
  // SAFETY: memoryContextExtension's handlers never read ctx (they only consume the event);
  // an empty object satisfies the ExtensionHandler signature.
  const ctx = {} as ExtensionContext;
  return {
    provider,
    context: async (messages) => {
      const result = handlers.get("context")?.({ type: "context", messages }, ctx);
      return result === undefined ? undefined : await result;
    },
    agentStart: async () => {
      await handlers.get("agent_start")?.({ type: "agent_start" }, ctx);
    },
  };
}

function conversation(lastUser = "what did we decide about deploys?"): TestMessage[] {
  return [
    { role: "user", content: "hello", timestamp: 1 },
    { role: "assistant", content: "hi", timestamp: 2 },
    { role: "user", content: lastUser, timestamp: 3 },
  ];
}

describe("memoryContextExtension", () => {
  test("prepends one developer message with org hits for the latest user text", async () => {
    const h = loadExtension();
    h.provider.hits = [entry({ content: "deploys happen on fridays" }), entry({ content: "rollbacks use git revert" })];
    const result = await h.context(conversation());

    expect(h.provider.searches).toEqual([{ query: "what did we decide about deploys?", scope: "org", limit: 5 }]);
    expect(result).toBeDefined();
    const messages = result!.messages;
    expect(messages.length).toBe(4); // injected + 3 originals
    // SAFETY: the extension prepends its injection as messages[0] with role/content set (memory-context.ts).
    const injected = messages[0] as { role: string; content: string };
    expect(injected.role).toBe("developer");
    expect(injected.content).toBe(
      `${MEMORY_INJECTION_PREFIX}\n- deploys happen on fridays\n- rollbacks use git revert`,
    );
    expect(messages.slice(1)).toEqual(conversation());
  });

  test("searches user scope for the session principal and merges both scopes", async () => {
    const h = loadExtension({ getPrincipal: () => "U42" });
    h.provider.hits = [entry({ content: "org fact" }), entry({ scope: "user", principal: "U42", content: "alice fact" })];
    await h.context(conversation());

    expect(h.provider.searches).toEqual([
      { query: "what did we decide about deploys?", scope: "org", limit: 5 },
      { query: "what did we decide about deploys?", scope: "user", principal: "U42", limit: 5 },
    ]);
    const result = await h.context(conversation()); // re-run: this time skipped (already injected)
    expect(result).toBeUndefined();
  });

  test("falls back to defaultPrincipal when the session has no live principal", async () => {
    const h = loadExtension({ defaultPrincipal: "U7" });
    h.provider.hits = [entry({ content: "x" })];
    await h.context(conversation());
    expect(h.provider.searches.some((s) => s.scope === "user" && s.principal === "U7")).toBe(true);
  });

  test("entry budget: at most maxEntries lines, deduped by content", async () => {
    const h = loadExtension({ maxEntries: 2 });
    h.provider.hits = [
      entry({ content: "one" }),
      entry({ content: "two" }),
      entry({ content: "three" }),
      entry({ content: "one" }), // duplicate of the first hit
    ];
    const result = await h.context(conversation());
    // SAFETY: the extension prepends its injection as messages[0] with content set (memory-context.ts).
    const injected = result!.messages[0] as { content: string };
    expect(injected.content).toBe(`${MEMORY_INJECTION_PREFIX}\n- one\n- two`);
  });

  test("byte budget: the injected message never exceeds maxBytes", async () => {
    const h = loadExtension({ maxBytes: 64 });
    h.provider.hits = [
      entry({ content: "a ".repeat(60) }), // oversized alone
      entry({ content: "b" }),
    ];
    const result = await h.context(conversation());
    // SAFETY: the extension prepends its injection as messages[0] with content set (memory-context.ts).
    const injected = result!.messages[0] as { content: string };
    expect(Buffer.byteLength(injected.content, "utf8")).toBeLessThanOrEqual(64);
    expect(injected.content.startsWith(MEMORY_INJECTION_PREFIX)).toBe(true);
    expect(injected.content).toContain("a");
    expect(injected.content).not.toContain("- b"); // no room for the second entry
  });

  test("no dupes per turn: one injection per agent_start cycle", async () => {
    const h = loadExtension();
    h.provider.hits = [entry({ content: "fact" })];

    const first = await h.context(conversation());
    expect(first).toBeDefined();
    // Same turn, next provider request (e.g. after a tool call): no re-injection.
    const second = await h.context(conversation());
    expect(second).toBeUndefined();
    // New turn: injection is allowed again.
    await h.agentStart();
    const third = await h.context(conversation());
    expect(third).toBeDefined();
  });

  test("skips when the conversation already contains a memory-injection message", async () => {
    const h = loadExtension();
    h.provider.hits = [entry({ content: "fact" })];
    const alreadyInjected = [...conversation(), { role: "developer" as const, content: `${MEMORY_INJECTION_PREFIX}\n- old`, timestamp: 4 }];
    const result = await h.context(alreadyInjected);
    expect(result).toBeUndefined();
    expect(h.provider.searches).toHaveLength(0);
  });

  test("disabled via config leaves messages untouched and never searches", async () => {
    const h = loadExtension({ enabled: false });
    h.provider.hits = [entry({ content: "fact" })];
    const result = await h.context(conversation());
    expect(result).toBeUndefined();
    expect(h.provider.searches).toHaveLength(0);
  });

  test("no user text or no hits means no injection", async () => {
    const h = loadExtension();
    expect(await h.context([{ role: "assistant", content: "only assistant text", timestamp: 1 }])).toBeUndefined();
    expect(await h.context(conversation("   "))).toBeUndefined(); // blank latest user text
    expect(await h.context(conversation())).toBeUndefined(); // no hits
    expect(h.provider.searches).toHaveLength(2); // blank text skipped the search; the last one searched
  });

  test("latest user message wins as the query (steering included)", async () => {
    const h = loadExtension();
    h.provider.hits = [entry({ content: "fact" })];
    await h.context([...conversation(), { role: "user", content: "steer: focus on cost", timestamp: 4 }]);
    expect(h.provider.searches[0].query).toBe("steer: focus on cost");
  });
});

describe("renderInjection", () => {
  test("empty budget or empty entries yields an empty body", () => {
    expect(renderInjection([], 5, 4096)).toBe("");
    expect(renderInjection([entry({ content: "x" })], 5, 10)).toBe(""); // prefix alone overflows
  });
});
