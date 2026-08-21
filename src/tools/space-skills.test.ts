
/** Caller-surface coverage for the complete space-skill tool definitions. */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult, ExtensionContext, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { z } from "zod";
import { createAudit } from "../policy/audit";
import { MAX_COMPANION_FILE_BYTES, type SkillsResolveOpts } from "../server/skills";
import {
  SPACE_SKILL_CREATED_EVENT,
  SPACE_SKILL_DELETED_EVENT,
  SPACE_SKILL_LISTED_EVENT,
  SPACE_SKILL_READ_EVENT,
  SPACE_SKILL_UPDATED_EVENT,
} from "../store/audit-events";
import { createStore, type Store } from "../store/db";
import { spaceSkillToolDefinitions } from "./space-skills";

const dir = mkdtempSync(join(tmpdir(), "bottega-space-skill-tools-"));
const stores: Store[] = [];
afterAll(() => {
  for (const store of stores) store.close();
  rmSync(dir, { recursive: true, force: true });
});

interface SpaceSkillHarness {
  store: Store;
  root: string;
  byName: Record<string, ToolDefinition>;
}

interface CompanionFileInput {
  encoding: string;
  content: string;
}

interface SpaceSkillToolParams {
  name?: string;
  document?: string;
  expected_revision?: string;
  companion_files?: Record<string, CompanionFileInput>;
}

const revisionResultSchema = z.object({ revision: z.string() }).passthrough();
const listedSkillSchema = z
  .object({
    name: z.string(),
    description: z.string(),
    source_tier: z.string(),
    revision: z.string(),
    companion_files: z.array(z.string()),
    shadows: z.array(z.string()),
  })
  .passthrough();
const companionFileSchema = z.object({ encoding: z.string(), content: z.string() });
const skillResultSchema = z.object({
  skill: z
    .object({
      document: z.string(),
      revision: z.string(),
      description: z.string(),
      companion_files: z.record(z.string(), companionFileSchema),
    })
    .passthrough(),
  shadowed: z.array(z.object({ source_tier: z.string() }).passthrough()).optional(),
});

function harness(
  name: string,
  mutationHook?: SkillsResolveOpts["mutationHook"],
): SpaceSkillHarness {
  const store = createStore(join(dir, `${name}.db`));
  stores.push(store);
  const root = join(dir, name);
  const byName = Object.fromEntries(
    spaceSkillToolDefinitions(store, {
      audit: createAudit(store),
      skillsRoot: root,
      builtinSkillsDir: join(dir, `${name}-builtin`),
      mutationHook,
    }).map((tool) => [
      tool.name,
      tool,
    ]),
  );
  return { store, root, byName };
}

function context(spaceId: string | undefined): ExtensionContext {
  // SAFETY: Space-skill tools only read the session file path from this
  // extension context, and the fake provides that exact boundary method.
  return { sessionManager: { getSessionFile: () => (spaceId === undefined ? undefined : `${spaceId}.jsonl`) } } as ExtensionContext;
}

async function call(tool: ToolDefinition, params: SpaceSkillToolParams, ctx = context("slack:C1")) {
  return tool.execute("call", params, new AbortController().signal, () => {}, ctx);
}

function text(result: AgentToolResult<unknown>): string {
  const content = result.content[0];
  if (!content || content.type !== "text") throw new Error("space-skill tool did not return text");
  return content.text;
}

function parsedText<T>(result: AgentToolResult<unknown>, schema: z.ZodType<T>): T {
  return schema.parse(JSON.parse(text(result)));
}

const DOC_V1 = "---\nname: review\ndescription: Review v1.\n---\nPrivate procedure one.\n";
const DOC_V2 = "---\nname: review\ndescription: Review v2.\n---\nPrivate procedure two.\n";

describe("space-skill lifecycle tools", () => {
  test("exposes list/get/create/update/delete with bounded schemas", () => {
    const { byName } = harness("schemas");
    expect(Object.keys(byName).sort()).toEqual([
      "create_space_skill",
      "delete_space_skill",
      "get_space_skill",
      "list_space_skills",
      "update_space_skill",
    ]);
    expect(byName.create_space_skill?.approval).toBe("exec");
    expect(byName.update_space_skill?.approval).toBe("exec");
    expect(byName.delete_space_skill?.approval).toBe("exec");
    expect(byName.list_space_skills?.approval).toBe("read");
    expect(byName.get_space_skill?.approval).toBe("read");

    expect(
      byName.create_space_skill?.parameters.safeParse({
        name: "review",
        document: DOC_V1,
        companion_files: { "../outside": { encoding: "text", content: "bad" } },
      }).success,
    ).toBe(false);
    expect(
      byName.create_space_skill?.parameters.safeParse({
        name: "review",
        document: DOC_V1,
        companion_files: { "data.bin": { encoding: "base64", content: "A".repeat(Math.ceil(MAX_COMPANION_FILE_BYTES / 3) * 4 + 1) } },
      }).success,
    ).toBe(false);
    const cappedChunk = "x".repeat(MAX_COMPANION_FILE_BYTES);
    expect(
      byName.create_space_skill?.parameters.safeParse({
        name: "review",
        document: DOC_V1,
        companion_files: {
          "a.bin": { encoding: "text", content: cappedChunk },
          "b.bin": { encoding: "text", content: cappedChunk },
          "c.bin": { encoding: "text", content: cappedChunk },
          "d.bin": { encoding: "text", content: cappedChunk },
        },
      }).success,
    ).toBe(false);
  });

  test("runs the complete lifecycle and audits hashes/metadata without procedure or companion bodies", async () => {
    const { store, byName } = harness("lifecycle");
    const createdResult = await call(byName.create_space_skill!, {
      name: "review",
      document: DOC_V1,
      companion_files: { "scripts/run.sh": { encoding: "text", content: "private-script-one" } },
    });
    expect(createdResult.isError).not.toBe(true);
    const created = parsedText(createdResult, revisionResultSchema);

    const listed = await call(byName.list_space_skills!, {});
    expect(parsedText(listed, z.array(listedSkillSchema))).toEqual([
      expect.objectContaining({ name: "review", revision: created.revision, companion_files: ["scripts/run.sh"] }),
    ]);
    const got = await call(byName.get_space_skill!, { name: "review" });
    expect(parsedText(got, skillResultSchema)).toMatchObject({
      skill: { document: DOC_V1, companion_files: { "scripts/run.sh": { encoding: "text", content: "private-script-one" } } },
    });

    const updatedResult = await call(byName.update_space_skill!, {
      name: "review",
      expected_revision: created.revision,
      document: DOC_V2,
      companion_files: { "scripts/new.sh": { encoding: "text", content: "private-script-two" } },
    });
    expect(updatedResult.isError).not.toBe(true);
    const updated = parsedText(updatedResult, revisionResultSchema);

    const deleted = await call(byName.delete_space_skill!, { name: "review", expected_revision: updated.revision });
    expect(deleted.isError).not.toBe(true);
    expect(existsSync(join(dir, "lifecycle", "slack:C1", "review"))).toBe(false);

    expect(await store.listAudit({ event_type: SPACE_SKILL_CREATED_EVENT })).toHaveLength(1);
    expect(await store.listAudit({ event_type: SPACE_SKILL_LISTED_EVENT })).toHaveLength(1);
    expect(await store.listAudit({ event_type: SPACE_SKILL_READ_EVENT })).toHaveLength(1);
    expect(await store.listAudit({ event_type: SPACE_SKILL_UPDATED_EVENT })).toHaveLength(1);
    expect(await store.listAudit({ event_type: SPACE_SKILL_DELETED_EVENT })).toHaveLength(1);
    const auditText = (await store.listAudit()).map((row) => row.payload).join("\n");
    expect(auditText).not.toContain("Private procedure");
    expect(auditText).not.toContain("private-script");
    expect(auditText).toContain(created.revision);
    expect(auditText).toContain(updated.revision);
  });

  test("server boundary rejects traversal and stale/oversized updates leave the prior revision unchanged", async () => {
    const { store, root, byName } = harness("fail-closed");
    const invalid = await call(byName.create_space_skill!, {
      name: "review",
      document: DOC_V1,
      companion_files: { "../outside": { encoding: "text", content: "escaped" } },
    });
    expect(invalid.isError).toBe(true);
    expect(existsSync(join(dir, "outside"))).toBe(false);

    const createdResult = await call(byName.create_space_skill!, {
      name: "review",
      document: DOC_V1,
      companion_files: { "run.sh": { encoding: "text", content: "before" } },
    });
    const created = parsedText(createdResult, revisionResultSchema);

    const stale = await call(byName.update_space_skill!, {
      name: "review",
      expected_revision: "0".repeat(64),
      document: DOC_V2,
      companion_files: {},
    });
    expect(stale.isError).toBe(true);

    const oversized = await call(byName.update_space_skill!, {
      name: "review",
      expected_revision: created.revision,
      document: DOC_V2,
      companion_files: { "run.sh": { encoding: "text", content: "x".repeat(MAX_COMPANION_FILE_BYTES + 1) } },
    });
    expect(oversized.isError).toBe(true);

    const got = await call(byName.get_space_skill!, { name: "review" });
    expect(parsedText(got, skillResultSchema)).toMatchObject({
      skill: { revision: created.revision, description: "Review v1.", companion_files: { "run.sh": { encoding: "text", content: "before" } } },
    });
    expect(existsSync(join(root, "slack:C1", "review", "run.sh"))).toBe(true);

    const rollbackByName = Object.fromEntries(
      spaceSkillToolDefinitions(store, {
        audit: createAudit(store),
        skillsRoot: root,
        mutationHook(stage) {
          if (stage === "after-backup") throw new Error("injected caller-level commit failure");
        },
      }).map((tool) => [tool.name, tool]),
    );
    const failedCommit = await call(rollbackByName.update_space_skill!, {
      name: "review",
      expected_revision: created.revision,
      document: DOC_V2,
      companion_files: { "run.sh": { encoding: "text", content: "after" } },
    });
    expect(failedCommit.isError).toBe(true);
    const afterRollback = await call(byName.get_space_skill!, { name: "review" });
    expect(parsedText(afterRollback, skillResultSchema)).toMatchObject({
      skill: { revision: created.revision, description: "Review v1.", companion_files: { "run.sh": { encoding: "text", content: "before" } } },
    });
  });

  test("a non-space session cannot read or mutate the skill store", async () => {
    const { root, byName } = harness("wrong-context");
    const badContext = context(undefined);
    for (const [name, params] of [
      ["list_space_skills", {}],
      ["get_space_skill", { name: "review" }],
      ["create_space_skill", { name: "review", document: DOC_V1 }],
      ["update_space_skill", { name: "review", expected_revision: "0".repeat(64), document: DOC_V1, companion_files: {} }],
      ["delete_space_skill", { name: "review", expected_revision: "0".repeat(64) }],
    ] as const) {
      const result = await call(byName[name]!, params, badContext);
      expect(result.isError).toBe(true);
      expect(text(result)).toContain("space session");
    }
    expect(existsSync(root)).toBe(false);
  });
});
