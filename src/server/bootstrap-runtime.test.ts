/**
 * Bootstrap surface authorization (issue #373): tools-less API-key MCP
 * discovery uses the same call-scoped credential boundary as execution.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { AuthorizationContext } from "../extensions/boundary";
import {
  SCOPED_AUTHORIZATIONS_BEGIN,
  SCOPED_AUTHORIZATIONS_END,
} from "../extensions/boundary";
import type { McpBinding } from "../extensions/manifest";
import { resetToolSurfaceCache } from "../extensions/surface";
import { createStore } from "../store/db";
import { DenyRouter } from "../policy/approval-router";
import { bootstrapRuntime } from "./bootstrap-runtime";

const SNAPSHOT = resolve(import.meta.dir, "../../config/extensions/github.json");
const suiteNodeEnv = process.env.NODE_ENV;

let originalNodeEnv: string | undefined;

function toolsTransport(fail = false): (binding: McpBinding) => Transport {
  return () => {
    if (fail) throw new Error("provider tools/list unavailable");
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = new Server({ name: "bootstrap-test", version: "1.0.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [{ name: "search_issues", description: "Search", inputSchema: { type: "object" } }],
    }));
    void server.connect(serverTransport);
    return clientTransport;
  };
}

function authorizedTransport(seen: AuthorizationContext[], fail = false) {
  return (binding: McpBinding, _auth?: OAuthClientProvider, authorization?: AuthorizationContext): Transport => {
    if (authorization !== undefined) seen.push(authorization);
    return toolsTransport(fail)(binding);
  };
}

function testFetch(implementation: () => Promise<Response>): typeof fetch {
  return Object.assign(implementation, { preconnect: fetch.preconnect });
}

interface Fixture {
  dir: string;
  dbPath: string;
  extensionsDir: string;
  secretsDir: string;
  proxyConfigPath: string;
  cleanup(): void;
}

function fixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "bottega-bootstrap-surface-"));
  const extensionsDir = join(dir, "extensions");
  const secretsDir = join(dir, "secrets");
  const proxyConfigPath = join(dir, "egress.yml");
  mkdirSync(extensionsDir, { recursive: true });
  copyFileSync(SNAPSHOT, join(extensionsDir, "github.json"));
  writeFileSync(proxyConfigPath, `${SCOPED_AUTHORIZATIONS_BEGIN}\n${SCOPED_AUTHORIZATIONS_END}\n`);
  return {
    dir,
    dbPath: join(dir, "bottega.db"),
    extensionsDir,
    secretsDir,
    proxyConfigPath,
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

beforeEach(() => {
  originalNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "test";
  resetToolSurfaceCache();
});
afterEach(() => {
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
});
afterAll(() => {
  expect(process.env.NODE_ENV).toBe(suiteNodeEnv);
});

describe("bootstrapRuntime API-key surface authorization", () => {
  test("passes a random placeholder to tools/list and revokes its mapping", async () => {
    const f = fixture();
    const seen: AuthorizationContext[] = [];
    const store = createStore(f.dbPath);
    try {
      await store.upsertExtensionCredential({
        provider: "github",
        identityKey: "org-github",
        owner: null,
        scope: "org",
        brokerCredentialId: 42,
      });
      const runtime = await bootstrapRuntime({
        router: DenyRouter,
        dbPath: f.dbPath,
        extensionsDir: f.extensionsDir,
        skipRuntimeRegistryMerge: true,
        mcpTransport: authorizedTransport(seen),
        boundary: {
          secretsDir: f.secretsDir,
          proxyConfigPath: f.proxyConfigPath,
          proxyControlUrl: "http://proxy.test",
          proxyControlToken: "reload-token",
          resolveSecret: async () => "super-secret-pat",
          fetchImpl: testFetch(async () => new Response(null, { status: 200 })),
        },
      });

      expect(runtime.surfaces.get("github")).toHaveLength(1);
      expect(seen).toHaveLength(1);
      expect(seen[0]?.placeholder).toMatch(/^bottega-call-/);
      expect(seen[0]?.placeholder).not.toContain("super-secret-pat");
      expect(readdirSync(join(f.secretsDir, "scoped"))).toEqual([]);
      expect(readFileSync(f.proxyConfigPath, "utf8")).not.toContain(seen[0]?.placeholder ?? "missing");
    } finally {
      store.close();
      f.cleanup();
    }
  });

  test("without an active credential row, discovery remains unauthenticated", async () => {
    const f = fixture();
    const seen: AuthorizationContext[] = [];
    const store = createStore(f.dbPath);
    try {
      const runtime = await bootstrapRuntime({
        router: DenyRouter,
        dbPath: f.dbPath,
        extensionsDir: f.extensionsDir,
        skipRuntimeRegistryMerge: true,
        mcpTransport: authorizedTransport(seen),
      });

      expect(runtime.surfaces.get("github")).toHaveLength(1);
      expect(seen).toHaveLength(0);
    } finally {
      store.close();
      f.cleanup();
    }
  });

  test("boundary failure skips the provider with provider-specific evidence and leaves no mapping", async () => {
    const f = fixture();
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => errors.push(args.join(" "));
    const store = createStore(f.dbPath);
    try {
      await store.upsertExtensionCredential({
        provider: "github",
        identityKey: "org-github",
        owner: null,
        scope: "org",
        brokerCredentialId: 42,
      });
      const runtime = await bootstrapRuntime({
        router: DenyRouter,
        dbPath: f.dbPath,
        extensionsDir: f.extensionsDir,
        skipRuntimeRegistryMerge: true,
        mcpTransport: authorizedTransport([], true),
        boundary: {
          secretsDir: f.secretsDir,
          proxyConfigPath: f.proxyConfigPath,
          proxyControlUrl: "http://proxy.test",
          proxyControlToken: "reload-token",
          resolveSecret: async () => {
            throw new Error("secret resolver unavailable");
          },
          fetchImpl: testFetch(async () => new Response(null, { status: 200 })),
        },
      });

      expect(runtime.surfaces.has("github")).toBe(false);
      expect(errors.some((line) => line.includes('provider "github"') && line.includes("secret resolver unavailable"))).toBe(true);
      expect(existsSync(join(f.secretsDir, "scoped"))).toBe(false);
    } finally {
      console.error = originalError;
      store.close();
      f.cleanup();
    }
  });
});
