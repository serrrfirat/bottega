import { afterAll, describe, expect, test } from "bun:test";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { MemoryProvider } from "../memory/types";
import type { AuditModule } from "../policy/audit";
import { isKnownTool, resolveTier } from "../policy/config";
import { kbToolDefinitions } from "./kb-tools";

const unusedContext = {} as unknown as ExtensionContext;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname;
    return new Response(`<h1>KB</h1><p>Content from ${path}</p>`, {
      headers: { "content-type": "text/html" },
    });
  },
});

afterAll(() => server.stop(true));

describe("kb_ingest", () => {
  test("is a write-tier SDK tool and fails closed for an unknown source id", async () => {
    let saves = 0;
    const memoryProvider: MemoryProvider = {
      async save() {
        saves += 1;
        throw new Error("unexpected save");
      },
      async search() {
        return [];
      },
    };
    const audit: AuditModule = {
      async appendAudit() {
        throw new Error("unexpected audit");
      },
      async listAudit() {
        return [];
      },
    };
    const [tool] = kbToolDefinitions({
      memoryProvider,
      audit,
      config: { sources: [{ id: "handbook", url: "https://docs.example.com", type: "html" }] },
    });

    expect(tool.name).toBe("kb_ingest");
    expect(tool.approval).toBe("write");
    expect(isKnownTool("kb_ingest")).toBe(true);
    expect(resolveTier("kb_ingest")).toBe("write");
    const result = await tool.execute("tc1", { source: "missing" }, undefined, undefined, unusedContext);
    expect(result.isError).toBe(true);
    const firstContent = result.content[0];
    expect(firstContent?.type).toBe("text");
    if (firstContent?.type !== "text") throw new Error("expected text tool output");
    expect(firstContent.text).toContain("unknown KB source");
    expect(saves).toBe(0);
  });

  test("ingests every configured source when source is omitted", async () => {
    const savedContents: string[] = [];
    let audits = 0;
    const memoryProvider: MemoryProvider = {
      async save(input) {
        savedContents.push(input.content);
        return {
          id: `mem-${savedContents.length}`,
          scope: input.scope,
          principal: null,
          content: input.content,
          metadata: input.metadata ?? {},
          createdAt: Date.now(),
        };
      },
      async search() {
        return [];
      },
    };
    const audit: AuditModule = {
      async appendAudit() {
        audits += 1;
        return audits;
      },
      async listAudit() {
        return [];
      },
    };
    const [tool] = kbToolDefinitions({
      memoryProvider,
      audit,
      config: {
        sources: [
          { id: "one", url: new URL("/one", server.url).toString(), type: "html" },
          { id: "two", url: new URL("/two", server.url).toString(), type: "html" },
        ],
      },
    });

    const result = await tool.execute("tc2", {}, undefined, undefined, unusedContext);
    expect(result.isError).not.toBe(true);
    expect(savedContents).toHaveLength(2);
    expect(savedContents[0]).toContain("/one");
    expect(savedContents[1]).toContain("/two");
    expect(audits).toBe(2);
  });
});
