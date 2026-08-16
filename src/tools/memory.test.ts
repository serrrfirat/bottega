import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import type { AuditModule } from "../policy/audit";
import type { MemoryProvider, MemorySaveInput, MemorySearchQuery } from "../memory/types";
import { createSqliteMemoryProvider } from "../memory/sqlite";
import { memoryToolsExtension, sha256Hex } from "./memory";

/** The memory tools never read the extension context; only the arity needs it. */
const noopCtx = {} as unknown as ExtensionContext;

class FakeProvider implements MemoryProvider {
  saved: MemorySaveInput[] = [];
  searched: MemorySearchQuery[] = [];
  private next = 1;

  async save(input: MemorySaveInput) {
    this.saved.push(input);
    return {
      id: `mem_${this.next++}`,
      scope: input.scope,
      principal: input.principal ?? null,
      content: input.content,
      metadata: input.metadata ?? {},
      createdAt: 1000,
    };
  }

  async search(query: MemorySearchQuery) {
    this.searched.push(query);
    return [
      {
        id: "mem_1",
        scope: query.scope,
        principal: query.principal ?? null,
        content: "found",
        metadata: {},
        createdAt: 2000,
      },
    ];
  }
}

interface AuditRow {
  actor: string;
  event_type: string;
  payload: Record<string, unknown>;
}

function fakeAudit(): { audit: Pick<AuditModule, "appendAudit">; rows: AuditRow[] } {
  const rows: AuditRow[] = [];
  const audit: Pick<AuditModule, "appendAudit"> = {
    appendAudit: async (entry) => {
      const text = typeof entry.payload === "string" ? entry.payload : JSON.stringify(entry.payload);
      rows.push({ actor: entry.actor, event_type: entry.event_type, payload: JSON.parse(text) });
      return rows.length;
    },
  };
  return { audit, rows };
}

function loadTools(
  provider: MemoryProvider,
  opts?: { defaultPrincipal?: string; audit?: Pick<AuditModule, "appendAudit"> },
): ToolDefinition[] {
  const tools: ToolDefinition[] = [];
  const pi = { registerTool: (t: ToolDefinition) => void tools.push(t) } as unknown as ExtensionAPI;
  memoryToolsExtension(provider, opts)(pi);
  return tools;
}

function resultText(res: Awaited<ReturnType<ToolDefinition["execute"]>>): string {
  return (res.content[0] as { text: string }).text;
}

describe("memoryToolsExtension registration", () => {
  test("registers memory.save and memory.search with the right tiers", () => {
    const [saveTool, searchTool] = loadTools(new FakeProvider());
    expect(saveTool.name).toBe("memory.save");
    expect(searchTool.name).toBe("memory.search");
    for (const t of [saveTool, searchTool]) {
      expect(t.description.length).toBeGreaterThan(0);
      expect(t.label.length).toBeGreaterThan(0);
      expect(t.parameters).toBeDefined();
    }
    // save mutates durable state → write tier (prompts in non-yolo modes);
    // search only queries → read tier.
    expect(saveTool.approval).toBe("write");
    expect(searchTool.approval).toBe("read");
  });
});

describe("memory.save", () => {
  test("saves org-scope content and audits a hash-only memory.write row", async () => {
    const provider = new FakeProvider();
    const { audit, rows } = fakeAudit();
    const [saveTool] = loadTools(provider, { audit });

    const res = await saveTool.execute(
      "tc1",
      { content: "the vault combination is 1234", scope: "org", metadata: { topic: "vault" } },
      undefined,
      undefined,
      noopCtx,
    );
    expect(res.isError).not.toBe(true);
    const { id } = JSON.parse(resultText(res));
    expect(id).toBe("mem_1");

    expect(provider.saved).toHaveLength(1);
    expect(provider.saved[0]).toEqual({ scope: "org", content: "the vault combination is 1234", metadata: { topic: "vault" } });

    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor).toBe("agent");
    expect(rows[0]!.event_type).toBe("memory.write");
    const payload = rows[0]!.payload;
    expect(payload.scope).toBe("org");
    expect(payload.principal).toBeNull();
    expect(payload.id).toBe("mem_1");
    // Hash only — the raw content must never land in the audit row.
    expect(payload.content_hash).toBe(sha256Hex("the vault combination is 1234"));
    const auditText = JSON.stringify(rows[0]!.payload);
    expect(auditText).not.toContain("vault combination");
    expect(auditText).not.toContain("1234");
  });

  test("user scope uses the explicit principal and audits it as actor", async () => {
    const provider = new FakeProvider();
    const { audit, rows } = fakeAudit();
    const [saveTool] = loadTools(provider, { audit });

    const res = await saveTool.execute("tc1", { content: "prefers dark mode", scope: "user", principal: "U123" }, undefined, undefined, noopCtx);
    expect(res.isError).not.toBe(true);
    expect(provider.saved[0]!.principal).toBe("U123");
    expect(rows[0]!.actor).toBe("U123");
    expect(rows[0]!.payload.principal).toBe("U123");
  });

  test("user scope without principal falls back to defaultPrincipal", async () => {
    const provider = new FakeProvider();
    const { audit, rows } = fakeAudit();
    const [saveTool] = loadTools(provider, { audit, defaultPrincipal: "U9" });

    const res = await saveTool.execute("tc1", { content: "likes llamas", scope: "user" }, undefined, undefined, noopCtx);
    expect(res.isError).not.toBe(true);
    expect(provider.saved[0]!.principal).toBe("U9");
    expect(rows[0]!.actor).toBe("U9");
  });

  test("user scope without principal and no default errors, saves nothing, audits nothing", async () => {
    const provider = new FakeProvider();
    const { audit, rows } = fakeAudit();
    const [saveTool] = loadTools(provider, { audit });

    const res = await saveTool.execute("tc1", { content: "orphaned", scope: "user" }, undefined, undefined, noopCtx);
    expect(res.isError).toBe(true);
    expect(resultText(res)).toMatch(/principal/);
    expect(provider.saved).toHaveLength(0);
    expect(rows).toHaveLength(0);
  });

  test("rejects empty content", async () => {
    const provider = new FakeProvider();
    const [saveTool] = loadTools(provider);
    for (const content of ["", "   "]) {
      const res = await saveTool.execute("tc1", { content, scope: "org" }, undefined, undefined, noopCtx);
      expect(res.isError).toBe(true);
      expect(resultText(res)).toMatch(/non-empty/);
    }
    expect(provider.saved).toHaveLength(0);
  });

  test("provider failures surface as tool errors", async () => {
    const failing: MemoryProvider = {
      save: async () => {
        throw new Error("disk full");
      },
      search: async () => [],
    };
    const [saveTool] = loadTools(failing);
    const res = await saveTool.execute("tc1", { content: "x", scope: "org" }, undefined, undefined, noopCtx);
    expect(res.isError).toBe(true);
    expect(resultText(res)).toMatch(/disk full/);
  });

  test("rejects credential-shaped content with nothing written and nothing audited (issue #121)", async () => {
    const provider = new FakeProvider();
    const { audit, rows } = fakeAudit();
    const [saveTool] = loadTools(provider, { audit });

    // The exact family from the #121 incident: a fine-grained GitHub PAT
    // the user pasted into chat after the agent asked for one.
    const secrets = [
      "github_pat_11ABCDEFG_0abcdef1234567890abcdef1234567890abc",
      "ghp_1234567890abcdefghijklmnopqrstuvwxyzABCD",
      "gho_1234567890abcdefghijklmnopqrstuvwxyzABCD",
      "my token is xoxb-1234567890-abcdefghijklmnop",
      "sk-abcdefghijklmnopqrstuvwxyz1234567890ABCD",
      "AKIAIOSFODNN7EXAMPLE",
      "near-abcdefghijklmnopqrstuvwxyz1234567890ABCD",
    ];
    for (const content of secrets) {
      const res = await saveTool.execute("tc1", { content, scope: "org" }, undefined, undefined, noopCtx);
      expect(res.isError).toBe(true);
      expect(resultText(res)).toMatch(/secrets don't belong in memory/i);
    }
    // Fail closed: nothing persisted, no audit row — the token never lands
    // in durable memory or the audit trail.
    expect(provider.saved).toHaveLength(0);
    expect(rows).toHaveLength(0);
  });

  test("does not reject prose that merely mentions a token prefix (issue #121)", async () => {
    const provider = new FakeProvider();
    const { audit, rows } = fakeAudit();
    const [saveTool] = loadTools(provider, { audit });

    for (const content of [
      "the PAT file lives at data/secrets/github-pat with mode 0600",
      "github_pat_ is the prefix of fine-grained tokens",
      "we keep the xoxb- format tokens in the vault, not memory",
      "sk- keys are for OpenAI",
    ]) {
      const res = await saveTool.execute("tc1", { content, scope: "org" }, undefined, undefined, noopCtx);
      expect(res.isError).not.toBe(true);
    }
    expect(provider.saved).toHaveLength(4);
    expect(rows).toHaveLength(4);
  });
});

describe("memory.search", () => {
  test("passes the query through and returns entries", async () => {
    const provider = new FakeProvider();
    const { audit, rows } = fakeAudit();
    const [, searchTool] = loadTools(provider, { audit });

    const res = await searchTool.execute(
      "tc1",
      { query: "llamas", scope: "user", principal: "U9", limit: 3 },
      undefined,
      undefined,
      noopCtx,
    );
    expect(res.isError).not.toBe(true);
    expect(provider.searched).toEqual([{ query: "llamas", scope: "user", principal: "U9", limit: 3 }]);
    const entries = JSON.parse(resultText(res));
    expect(entries).toHaveLength(1);
    expect(entries[0].content).toBe("found");
    expect(entries[0].createdAt).toBe(2000);
    // Search is read-tier: policy decisions are audited by the gate, the tool appends nothing.
    expect(rows).toHaveLength(0);
  });

  test("org-scope search without principal passes nothing through", async () => {
    const provider = new FakeProvider();
    const [, searchTool] = loadTools(provider);
    const res = await searchTool.execute("tc1", { query: "anything", scope: "org" }, undefined, undefined, noopCtx);
    expect(res.isError).not.toBe(true);
    expect(provider.searched[0]!.principal).toBeUndefined();
  });

  test("rejects an empty query and out-of-range limits", async () => {
    const provider = new FakeProvider();
    const [, searchTool] = loadTools(provider);
    const empty = await searchTool.execute("tc1", { query: "  ", scope: "org" }, undefined, undefined, noopCtx);
    expect(empty.isError).toBe(true);
    expect(resultText(empty)).toMatch(/non-empty/);

    for (const limit of [0, 21]) {
      const res = await searchTool.execute("tc1", { query: "x", scope: "org", limit }, undefined, undefined, noopCtx);
      expect(res.isError).toBe(true);
      expect(resultText(res)).toMatch(/limit/);
    }
    expect(provider.searched).toHaveLength(0);
  });
});

describe("memory tools against the real SQLite provider (issue #29)", () => {
  test("save + search round-trip persists and scopes through the real provider", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bottega-memtools-"));
    try {
      const db = new Database(join(dir, "memory.db"));
      const provider = createSqliteMemoryProvider(db);
      const { audit, rows } = fakeAudit();
      const [saveTool, searchTool] = loadTools(provider, { audit });

      const saved = await saveTool.execute(
        "tc1",
        { content: "the vault combination is 1234", scope: "org", metadata: { topic: "vault" } },
        undefined,
        undefined,
        noopCtx,
      );
      expect(saved.isError).not.toBe(true);
      const { id } = JSON.parse(resultText(saved));
      expect(id).toMatch(/^mem_/);

      const found = await searchTool.execute("tc1", { query: "vault combination", scope: "org" }, undefined, undefined, noopCtx);
      expect(found.isError).not.toBe(true);
      const entries = JSON.parse(resultText(found)) as Array<Record<string, unknown>>;
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        id,
        scope: "org",
        principal: null,
        content: "the vault combination is 1234",
        metadata: { topic: "vault" },
      });

      // Audit carries only the content hash — the raw content never lands in
      // the trail, even though the real provider holds it in SQLite.
      expect(rows).toHaveLength(1);
      expect(rows[0]!.event_type).toBe("memory.write");
      expect(rows[0]!.payload.content_hash).toBe(sha256Hex("the vault combination is 1234"));
      expect(JSON.stringify(rows[0]!.payload)).not.toContain("vault combination");

      // Principal isolation through the real provider: a user never sees
      // another user's memory, and org rows stay org-scoped.
      const userSave = await saveTool.execute("tc1", { content: "prefers dark mode", scope: "user", principal: "U123" }, undefined, undefined, noopCtx);
      expect(userSave.isError).not.toBe(true);
      const other = await searchTool.execute("tc1", { query: "dark mode", scope: "user", principal: "U456" }, undefined, undefined, noopCtx);
      expect(JSON.parse(resultText(other))).toHaveLength(0);
      const own = await searchTool.execute("tc1", { query: "dark mode", scope: "user", principal: "U123" }, undefined, undefined, noopCtx);
      expect(JSON.parse(resultText(own))).toHaveLength(1);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
