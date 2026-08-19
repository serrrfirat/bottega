/**
 * `write_space_skill` (issues #234/#235, Tier 1 governance): caller-surface
 * tests driving the real tool against a real store + real audit. A valid
 * write lands a SKILL.md the loader reads back on the next session (cache
 * bust) and appends the `space_skill.written` audit row; every malformed
 * write is rejected without touching disk or the audit trail.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { createStore, type Store } from "../store/db";
import { createAudit } from "../policy/audit";
import { resolveSpaceSkills } from "../server/skills";
import { SPACE_SKILL_WRITTEN_EVENT } from "../store/audit-events";
import { writeSpaceSkillToolDefinition } from "./space-skills";

const dir = mkdtempSync(join(tmpdir(), "bottega-space-skills-"));
const stores: Store[] = [];
const roots: string[] = [];

function freshStore(): Store {
  const s = createStore(join(dir, `store-${stores.length}.db`));
  stores.push(s);
  return s;
}

function freshRoot(): string {
  const root = join(dir, `root-${roots.length}`);
  roots.push(root);
  return root;
}

afterAll(() => {
  for (const s of stores) s.close();
  rmSync(dir, { recursive: true, force: true });
});

function ctxFor(spaceId: string): ExtensionContext {
  // SAFETY: the tool reads only sessionManager.getSessionFile(); the rest of
  // the ExtensionContext surface is inert for this path.
  return { sessionManager: { getSessionFile: () => join("/tmp/sessions", `${spaceId}.jsonl`) } } as ExtensionContext;
}

function resultText(res: Awaited<ReturnType<ReturnType<typeof writeSpaceSkillToolDefinition>["execute"]>>): string {
  return (res.content[0] as { text: string }).text;
}

describe("write_space_skill", () => {
  test("a valid write lands SKILL.md, audits, and loads on the space's next resolution", async () => {
    const store = freshStore();
    const root = freshRoot();
    const audit = createAudit(store);
    const tool = writeSpaceSkillToolDefinition(store, { audit, skillsRoot: root });

    const res = await tool.execute("call-1", { name: "code_review", description: "Review diffs.", body: "Follow the checklist." }, new AbortController().signal, () => {}, ctxFor("slack:C1"));

    // The caller-facing result names the artifact and its space.
    const out = JSON.parse(resultText(res)) as { name: string; path: string; space: string };
    expect(out).toMatchObject({ name: "code_review", space: "slack:C1" });

    // Durable evidence: the SKILL.md sits in the space's dir + the audit row.
    const docPath = join(root, "slack:C1", "code_review", "SKILL.md");
    expect(out.path).toBe(docPath);
    expect(existsSync(docPath)).toBe(true);
    const auditRows = await store.listAudit({ event_type: SPACE_SKILL_WRITTEN_EVENT });
    expect(JSON.parse(auditRows[0].payload)).toMatchObject({ name: "code_review", path: docPath });

    // The space's NEXT session claims it (the loader round-trips the frontmatter).
    const skills = await resolveSpaceSkills("slack:C1", { root });
    expect(skills.map((s) => s.name)).toContain("code_review");
    const loaded = skills.find((s) => s.name === "code_review")!;
    expect(loaded.description).toBe("Review diffs.");
    expect(loaded.source).toBe("space:slack:C1");
  });

  test("a second write is visible after the first without a process restart (cache bust)", async () => {
    const store = freshStore();
    const root = freshRoot();
    const audit = createAudit(store);
    const tool = writeSpaceSkillToolDefinition(store, { audit, skillsRoot: root });

    await tool.execute("call-1", { name: "alpha", description: "A." }, new AbortController().signal, () => {}, ctxFor("slack:C1"));
    await tool.execute("call-2", { name: "beta", description: "B." }, new AbortController().signal, () => {}, ctxFor("slack:C1"));

    const skills = await resolveSpaceSkills("slack:C1", { root });
    expect(skills.map((s) => s.name).sort()).toEqual(["alpha", "beta"]);
  });

  test("malformed writes are rejected without touching disk or the audit trail", async () => {
    const store = freshStore();
    const root = freshRoot();
    const audit = createAudit(store);
    const tool = writeSpaceSkillToolDefinition(store, { audit, skillsRoot: root });

    for (const params of [
      { name: "../evil", description: "d" },
      { name: ".hidden", description: "d" },
      { name: "with space", description: "d" },
      { name: "ok_name", description: "" },
    ]) {
      const res = await tool.execute("call-x", params, new AbortController().signal, () => {}, ctxFor("slack:C1"));
      expect(res.isError).toBe(true);
      expect(resultText(res)).toMatch(/invalid skill name|description/);
    }

    expect(existsSync(join(root, "slack:C1"))).toBe(false);
    const auditRows = await store.listAudit({ event_type: SPACE_SKILL_WRITTEN_EVENT });
    expect(auditRows).toHaveLength(0);
  });

  test("rejects outside a space session (no session file → no space id)", async () => {
    const store = freshStore();
    const root = freshRoot();
    const tool = writeSpaceSkillToolDefinition(store, { audit: createAudit(store), skillsRoot: root });
    const res = await tool.execute(
      "call-1",
      { name: "whatever", description: "d" },
      new AbortController().signal,
      () => {},
      // SAFETY: getSessionFile returns undefined → the tool must refuse.
      { sessionManager: { getSessionFile: () => undefined } } as ExtensionContext,
    );
    expect(res.isError).toBe(true);
    expect(resultText(res)).toMatch(/space session/);
    expect(existsSync(join(root))).toBe(false);
  });
});
