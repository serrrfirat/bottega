/**
 * MCP surface tests (issue #25): conformance of the spawned bottega MCP
 * server against a real MCP client (the official SDK), and enforcement of
 * the policy gate + audit at execution time.
 *
 * Every test spawns the real entrypoint (`src/mcp/server.ts`) as a child
 * process with a temp DB + temp config dir, and drives it with the official
 * MCP TypeScript client over the stdio transport — the same transport the
 * agent's MCP client uses when bottega attaches the server to an ACP
 * session. No ports, no global state; each test cleans up its process, DB,
 * and temp dir.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createStore, type AuditRow, type Store } from "../store/db";

const SERVER_ENTRY = join(import.meta.dir, "server.ts");

/** Expected content hash — same SHA-256 the tools and the server compute. */
function sha256(text: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(text);
  return hasher.digest("hex");
}

interface LaunchOpts {
  configYaml: string;
  /** Space overlay JSON; seeds a space row and boots the server pinned to it. */
  policyJson?: string;
  defaultPrincipal?: string;
}

interface Harness {
  client: Client;
  store: Store;
  dir: string;
  /** The seeded space id (present when policyJson was given). */
  spaceId?: string;
  cleanup: () => Promise<void>;
}

async function launch(opts: LaunchOpts): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "bottega-mcp-"));
  const dbPath = join(dir, "test.db");
  const configDir = join(dir, "config");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "config.yml"), opts.configYaml);

  // Seed the space overlay before the server boots (server reads it at boot).
  let spaceId: string | undefined;
  if (opts.policyJson) {
    const seed = createStore(dbPath);
    try {
      const space = await seed.getOrCreateSpace({ platform: "slack", channel_id: "C1" });
      spaceId = space.id;
      await seed.updatePolicy(space.id, opts.policyJson);
    } finally {
      seed.close();
    }
  }

  const env: Record<string, string> = {
    BOTTEGA_DB_PATH: dbPath,
    BOTTEGA_CONFIG_DIR: configDir,
  };
  if (spaceId) env.BOTTEGA_SPACE_ID = spaceId;
  if (opts.defaultPrincipal) env.BOTTEGA_MCP_DEFAULT_PRINCIPAL = opts.defaultPrincipal;

  const transport = new StdioClientTransport({
    command: "bun",
    args: [SERVER_ENTRY],
    env,
    stderr: "pipe",
  });
  const client = new Client({ name: "bottega-mcp-test", version: "0.0.1" }, { capabilities: {} });
  await client.connect(transport);
  const store = createStore(dbPath);
  return {
    client,
    store,
    dir,
    spaceId,
    cleanup: async () => {
      await client.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function auditRows(store: Store, eventType: string): Promise<AuditRow[]> {
  return store.listAudit({ event_type: eventType });
}

function payload(row: AuditRow): Record<string, unknown> {
  return JSON.parse(row.payload) as Record<string, unknown>;
}

/** The SDK's callTool return type is index-signature-heavy; narrow it here. */
interface ToolCallResult {
  content: Array<{ type?: string; text?: string }>;
  isError?: boolean;
}

/** Org floor allowing both memory tools; the common case for conformance tests. */
const ALLOW_ALL = "tools:\n  memory.save: allow\n  memory.search: allow\n";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("MCP server conformance (spawned entrypoint)", () => {
  test("initialize + tools/list returns memory.save and memory.search with schemas", async () => {
    const h = await launch({ configYaml: ALLOW_ALL });
    dirs.push(h.dir);
    try {
      const { tools } = await h.client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(["memory.save", "memory.search"]);

      const save = tools.find((t) => t.name === "memory.save")!;
      expect((save.description ?? "").length).toBeGreaterThan(0);
      const saveProps = save.inputSchema.properties as Record<string, { type?: string; enum?: string[] }>;
      expect(Object.keys(saveProps).sort()).toEqual(["content", "metadata", "principal", "scope"]);
      expect(saveProps.scope?.enum).toEqual(["org", "user"]);
      expect(saveProps.content?.type).toBe("string");
      expect(save.inputSchema.required).toContain("content");
      expect(save.inputSchema.required).toContain("scope");

      const search = tools.find((t) => t.name === "memory.search")!;
      const searchProps = search.inputSchema.properties as Record<string, { type?: string }>;
      expect(Object.keys(searchProps).sort()).toEqual(["limit", "principal", "query", "scope"]);
      expect(searchProps.query?.type).toBe("string");
      expect(search.inputSchema.required).toContain("query");
      expect(search.inputSchema.required).toContain("scope");
    } finally {
      await h.cleanup();
    }
  });

  test("tools/call memory.save writes an audit row with content_hash, never the content", async () => {
    const h = await launch({ configYaml: ALLOW_ALL });
    dirs.push(h.dir);
    try {
      const res = (await h.client.callTool({
        name: "memory.save",
        arguments: { scope: "org", content: "the vault combination is 1234", metadata: { topic: "vault" } },
      })) as ToolCallResult;
      expect(res.isError).not.toBe(true);
      const text = (res.content[0] as { type: string; text: string }).text;
      const { id } = JSON.parse(text) as { id: string };
      expect(id).toMatch(/^mem_/);

      const rows = await auditRows(h.store, "memory.write");
      expect(rows).toHaveLength(1);
      expect(rows[0]!.actor).toBe("agent");
      expect(rows[0]!.space_id).toBeNull();
      const p = payload(rows[0]!);
      expect(p.scope).toBe("org");
      expect(p.principal).toBeNull();
      expect(p.id).toBe(id);
      expect(p.content_hash).toBe(sha256("the vault combination is 1234"));
      const auditText = rows[0]!.payload;
      expect(auditText).not.toContain("vault combination");
      expect(auditText).not.toContain("1234");

      // The save was also policy-gated: a policy.decision row records it.
      const decisions = await auditRows(h.store, "policy.decision");
      expect(decisions).toHaveLength(1);
      expect(payload(decisions[0]!).decision).toBe("allow");
    } finally {
      await h.cleanup();
    }
  });

  test("user-scope save requires and audits the principal; search scopes by principal", async () => {
    const h = await launch({ configYaml: ALLOW_ALL });
    dirs.push(h.dir);
    try {
      const res = await h.client.callTool({
        name: "memory.save",
        arguments: { scope: "user", principal: "U123", content: "prefers dark mode" },
      });
      expect(res.isError).not.toBe(true);

      const rows = await auditRows(h.store, "memory.write");
      expect(rows).toHaveLength(1);
      expect(rows[0]!.actor).toBe("U123");
      expect(payload(rows[0]!).principal).toBe("U123");
      expect(payload(rows[0]!).scope).toBe("user");
    } finally {
      await h.cleanup();
    }
  });

  test("user-scope save without principal fails as an MCP error and saves nothing", async () => {
    const h = await launch({ configYaml: ALLOW_ALL });
    dirs.push(h.dir);
    try {
      await expect(
        h.client.callTool({ name: "memory.save", arguments: { scope: "user", content: "orphaned" } }),
      ).rejects.toThrow(/principal/);
      expect(await auditRows(h.store, "memory.write")).toHaveLength(0);
    } finally {
      await h.cleanup();
    }
  });

  test("empty content fails as an MCP error and saves nothing", async () => {
    const h = await launch({ configYaml: ALLOW_ALL });
    dirs.push(h.dir);
    try {
      await expect(
        h.client.callTool({ name: "memory.save", arguments: { scope: "org", content: "   " } }),
      ).rejects.toThrow(/non-empty/);
      expect(await auditRows(h.store, "memory.write")).toHaveLength(0);
    } finally {
      await h.cleanup();
    }
  });

  test("out-of-range limit fails as an MCP error", async () => {
    const h = await launch({ configYaml: ALLOW_ALL });
    dirs.push(h.dir);
    try {
      await expect(
        h.client.callTool({ name: "memory.search", arguments: { scope: "org", query: "x", limit: 100 } }),
      ).rejects.toThrow(/limit/);
    } finally {
      await h.cleanup();
    }
  });

  test("unknown tool fails as an MCP error", async () => {
    const h = await launch({ configYaml: ALLOW_ALL });
    dirs.push(h.dir);
    try {
      await expect(h.client.callTool({ name: "memory.nonexistent", arguments: {} })).rejects.toThrow();
    } finally {
      await h.cleanup();
    }
  });

  test("search scopes org vs user and filters by principal", async () => {
    const h = await launch({ configYaml: ALLOW_ALL });
    dirs.push(h.dir);
    try {
      await h.client.callTool({ name: "memory.save", arguments: { scope: "org", content: "alpha org fact" } });
      await h.client.callTool({ name: "memory.save", arguments: { scope: "user", principal: "U1", content: "alpha user fact" } });
      await h.client.callTool({ name: "memory.save", arguments: { scope: "user", principal: "U2", content: "alpha other user" } });

      const org = (await h.client.callTool({ name: "memory.search", arguments: { scope: "org", query: "alpha" } })) as ToolCallResult;
      const orgEntries = JSON.parse((org.content[0] as { text: string }).text) as Array<{ scope: string }>;
      expect(orgEntries.map((e) => e.scope)).toEqual(["org"]);

      const mine = (await h.client.callTool({
        name: "memory.search",
        arguments: { scope: "user", query: "alpha", principal: "U1" },
      })) as ToolCallResult;
      const mineEntries = JSON.parse((mine.content[0] as { text: string }).text) as Array<{ principal: string | null }>;
      expect(mineEntries.map((e) => e.principal)).toEqual(["U1"]);
    } finally {
      await h.cleanup();
    }
  });

  test("defaultPrincipal from env applies to user-scope saves that omit principal", async () => {
    const h = await launch({ configYaml: ALLOW_ALL, defaultPrincipal: "U9" });
    dirs.push(h.dir);
    try {
      const res = await h.client.callTool({ name: "memory.save", arguments: { scope: "user", content: "likes llamas" } });
      expect(res.isError).not.toBe(true);
      const rows = await auditRows(h.store, "memory.write");
      expect(rows).toHaveLength(1);
      expect(rows[0]!.actor).toBe("U9");
      expect(payload(rows[0]!).principal).toBe("U9");
    } finally {
      await h.cleanup();
    }
  });
});

describe("MCP server policy + audit enforcement", () => {
  test("policy-denied call fails as an MCP error with no execution", async () => {
    const h = await launch({ configYaml: "tools:\n  memory.save: deny\n  memory.search: allow\n" });
    dirs.push(h.dir);
    try {
      await expect(
        h.client.callTool({ name: "memory.save", arguments: { scope: "org", content: "blocked" } }),
      ).rejects.toThrow(/policy/);
      expect(await auditRows(h.store, "memory.write")).toHaveLength(0);
      // The denial itself is audited as a policy decision.
      const decisions = await auditRows(h.store, "policy.decision");
      expect(decisions).toHaveLength(1);
      expect(payload(decisions[0]!).decision).toBe("deny");
      expect(payload(decisions[0]!).tool).toBe("memory.save");
    } finally {
      await h.cleanup();
    }
  });

  test("ask-human policy fails closed in the headless MCP context", async () => {
    const h = await launch({ configYaml: "tools:\n  memory.save: prompt\n  memory.search: allow\n" });
    dirs.push(h.dir);
    try {
      await expect(
        h.client.callTool({ name: "memory.save", arguments: { scope: "org", content: "needs approval" } }),
      ).rejects.toThrow(/policy/);
      expect(await auditRows(h.store, "memory.write")).toHaveLength(0);
      const decisions = await auditRows(h.store, "policy.decision");
      expect(payload(decisions[0]!).decision).toBe("ask-human");
    } finally {
      await h.cleanup();
    }
  });

  test("space overlay tightens the org floor for the session's space", async () => {
    // Org floor allows; the space overlay denies — the server must apply the
    // overlay because BOTTEGA_SPACE_ID pins the session to that space.
    const h = await launch({
      configYaml: ALLOW_ALL,
      policyJson: JSON.stringify({ tools: { "memory.save": "deny" } }),
    });
    dirs.push(h.dir);
    try {
      await expect(
        h.client.callTool({ name: "memory.save", arguments: { scope: "org", content: "tightened" } }),
      ).rejects.toThrow(/policy/);
      expect(await auditRows(h.store, "memory.write")).toHaveLength(0);
      // Audit rows for the session's space carry the space id.
      const decisions = await auditRows(h.store, "policy.decision");
      expect(decisions[0]!.space_id).toBe(h.spaceId!);
      expect(payload(decisions[0]!).decision).toBe("deny");

      // search stays allowed by both org and overlay.
      const res = await h.client.callTool({ name: "memory.search", arguments: { scope: "org", query: "nothing" } });
      expect(res.isError).not.toBe(true);
    } finally {
      await h.cleanup();
    }
  });
});
