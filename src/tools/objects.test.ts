import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult, ExtensionContext, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { createAudit } from "../policy/audit";
import { defaultPolicy } from "../policy/config";
import { createStore, type SpaceObject, type Store } from "../store/db";
import { objectToolDefinitions } from "./objects";
import { sha256Hex } from "./memory";

const dir = mkdtempSync(join(tmpdir(), "bottega-object-tools-"));
const stores: Store[] = [];

function freshStore(): Store {
  const store = createStore(join(dir, `store-${stores.length}.db`));
  stores.push(store);
  return store;
}

afterAll(() => {
  for (const store of stores) store.close();
  rmSync(dir, { recursive: true, force: true });
});

function ctxFor(spaceId: string): ExtensionContext {
  return {
    sessionManager: { getSessionFile: () => join("/tmp/sessions", `${spaceId}.jsonl`) },
  } as unknown as ExtensionContext;
}

function resultText(result: AgentToolResult<unknown>): string {
  const content = result.content[0];
  if (!content || content.type !== "text") throw new Error("tool did not return text");
  return content.text;
}

function toolsFor(store: Store, maxSizeBytes = 1024): ToolDefinition[] {
  const orgPolicy = defaultPolicy();
  orgPolicy.objects.maxSizeBytes = maxSizeBytes;
  return objectToolDefinitions(store, { orgPolicy, audit: createAudit(store) });
}

function toolNamed(tools: ToolDefinition[], name: string): ToolDefinition {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`missing tool: ${name}`);
  return tool;
}

describe("object tools", () => {
  test("register list/get as read tools and create as a write tool", () => {
    const tools = toolsFor(freshStore());
    expect(tools.map((tool) => tool.name)).toEqual(["object.list", "object.get", "object.create"]);
    expect(toolNamed(tools, "object.list").approval).toBe("read");
    expect(toolNamed(tools, "object.get").approval).toBe("read");
    expect(toolNamed(tools, "object.create").approval).toBe("write");
  });

  test("object.create stores UTF-8 bytes, derives MIME from the extension, and audits", async () => {
    const store = freshStore();
    const spaceId = "slack:C1";
    const create = toolNamed(toolsFor(store), "object.create");

    const result = await create.execute(
      "tc1",
      { name: "report.csv", content: "name,value\nα,1" },
      undefined,
      undefined,
      ctxFor(spaceId),
    );

    expect(result.isError).not.toBe(true);
    const output = JSON.parse(resultText(result)) as {
      id: string;
      name: string;
      mime: string;
      size: number;
      sha256: string;
    };
    expect(output).toEqual({
      id: expect.stringMatching(/^obj_/),
      name: "report.csv",
      mime: "text/csv",
      size: Buffer.byteLength("name,value\nα,1"),
      sha256: sha256Hex("name,value\nα,1"),
    });
    const storedBytes = await store.readObjectBytes(output.id);
    if (!storedBytes) throw new Error("created object bytes are missing");
    expect(new TextDecoder().decode(storedBytes)).toBe("name,value\nα,1");
    expect((await store.getObject(output.id))?.uploaded_by).toBe("agent");

    const rows = await store.listAudit({ space: spaceId, event_type: "object.created" });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor).toBe("agent");
    expect(JSON.parse(rows[0]!.payload)).toEqual({
      id: output.id,
      name: output.name,
      mime: output.mime,
      size: output.size,
      by: "agent",
    });
    expect((await store.getSpace(spaceId))?.channel_id).toBe("C1");
  });

  test("object.create rejects content above the configured byte limit without storing it", async () => {
    const store = freshStore();
    const space = await store.getOrCreateSpace({ platform: "slack", channel_id: "C2" });
    const create = toolNamed(toolsFor(store, 3), "object.create");

    const result = await create.execute(
      "tc1",
      { name: "too-large.txt", content: "four" },
      undefined,
      undefined,
      ctxFor(space.id),
    );

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("3B limit");
    expect(await store.listObjects(space.id)).toEqual([]);
    expect(await store.listAudit({ space: space.id, event_type: "object.created" })).toEqual([]);
  });

  test("object.list returns only the current space's metadata in store order", async () => {
    const store = freshStore();
    const firstSpace = await store.getOrCreateSpace({ platform: "slack", channel_id: "C3" });
    const otherSpace = await store.getOrCreateSpace({ platform: "slack", channel_id: "C4" });
    await store.createObject({
      space_id: firstSpace.id,
      name: "first.txt",
      mime: "text/plain",
      size: 5,
      sha256: sha256Hex("first"),
      uploaded_by: "U1",
      bytes: new TextEncoder().encode("first"),
    });
    await store.createObject({
      space_id: firstSpace.id,
      name: "second.json",
      mime: "application/json",
      size: 2,
      sha256: sha256Hex("{}"),
      uploaded_by: "U1",
      bytes: new TextEncoder().encode("{}"),
    });
    await store.createObject({
      space_id: otherSpace.id,
      name: "private.txt",
      mime: "text/plain",
      size: 7,
      sha256: sha256Hex("private"),
      uploaded_by: "U2",
      bytes: new TextEncoder().encode("private"),
    });

    const list = toolNamed(toolsFor(store), "object.list");
    const result = await list.execute("tc2", {}, undefined, undefined, ctxFor(firstSpace.id));

    expect(result.isError).not.toBe(true);
    const expected = (await store.listObjects(firstSpace.id)).map(
      ({ id, name, mime, size, sha256, created_at }) => ({
        id,
        name,
        mime,
        size,
        sha256,
        created_at,
      }),
    );
    expect(JSON.parse(resultText(result))).toEqual(expected);
  });

  test("object.get extracts supported text and reports unsupported binary formats explicitly", async () => {
    const store = freshStore();
    const space = await store.getOrCreateSpace({ platform: "slack", channel_id: "C5" });
    const supported = [
      { name: "note.txt", mime: "text/plain", content: "hello" },
      { name: "data.csv", mime: "text/csv", content: "a,b\n1,2" },
      { name: "data.json", mime: "application/json", content: "{\"ok\":true}" },
      { name: "readme.md", mime: "text/markdown", content: "# Title" },
    ];
    const textObjects: Array<{ object: SpaceObject; content: string }> = [];
    for (const item of supported) {
      const bytes = new TextEncoder().encode(item.content);
      const object = await store.createObject({
        space_id: space.id,
        name: item.name,
        mime: item.mime,
        size: bytes.byteLength,
        sha256: sha256Hex(item.content),
        uploaded_by: "U1",
        bytes,
      });
      textObjects.push({ object, content: item.content });
    }
    const pdfBytes = new TextEncoder().encode("%PDF");
    const pdf = await store.createObject({
      space_id: space.id,
      name: "paper.pdf",
      mime: "application/pdf",
      size: pdfBytes.byteLength,
      sha256: sha256Hex("%PDF"),
      uploaded_by: "U1",
      bytes: pdfBytes,
    });
    const get = toolNamed(toolsFor(store), "object.get");

    for (const { object, content } of textObjects) {
      const result = await get.execute("tc3", { id: object.id }, undefined, undefined, ctxFor(space.id));
      expect(result.isError).not.toBe(true);
      expect(JSON.parse(resultText(result))).toEqual({
        id: object.id,
        name: object.name,
        mime: object.mime,
        size: object.size,
        sha256: object.sha256,
        created_at: object.created_at,
        content,
      });
    }

    const pdfResult = await get.execute("tc4", { id: pdf.id }, undefined, undefined, ctxFor(space.id));
    expect(pdfResult.isError).toBe(true);
    expect(resultText(pdfResult)).toBe(
      `object ${pdf.id}: cannot extract text from application/pdf (unsupported format)`,
    );
  });

  test("object.get reports a missing object", async () => {
    const store = freshStore();
    const space = await store.getOrCreateSpace({ platform: "slack", channel_id: "C6" });
    const get = toolNamed(toolsFor(store), "object.get");

    const result = await get.execute("tc5", { id: "obj_missing" }, undefined, undefined, ctxFor(space.id));

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("object not found: obj_missing");
  });
});
