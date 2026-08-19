/**
 * Skills store (issues #234/#235): module-level unit tests for the write
 * path's fail-closed validation, the frontmatter contract, the in-process
 * cache invalidation that makes a written skill claimable on the NEXT
 * session, and Tier-3 resolution (space shadows builtin, unknown skipped).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveBuiltinSkills,
  resolveSpaceSkills,
  resolveWorkItemSkills,
  writeSpaceSkill,
} from "./skills";

const dir = mkdtempSync(join(tmpdir(), "bottega-skills-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const SPACE = "slack:C1";

describe("writeSpaceSkill", () => {
  test("rejects names with path separators, leading dots, and empty descriptions (fail closed)", async () => {
    const root = join(dir, "deny");
    for (const bad of ["../evil", ".hidden", "a/b", "with space", "a:b"]) {
      await expect(writeSpaceSkill(SPACE, { name: bad, description: "d" }, { root })).rejects.toThrow(
        /invalid skill name/,
      );
    }
    await expect(
      writeSpaceSkill(SPACE, { name: "ok_name", description: "", }, { root }),
    ).rejects.toThrow(/description/);
    // No file was touched by any rejected write.
    expect(existsSync(join(root, SPACE))).toBe(false);
  });

  test("writes a SKILL.md whose frontmatter the SDK loader round-trips", async () => {
    const root = join(dir, "write");
    const { name, path } = await writeSpaceSkill(
      SPACE,
      { name: "code_review_1", description: "Review diffs against the checklist.", body: "Step one.\n\nStep two.", triggers: ["review", 'say "hi"'] },
      { root },
    );
    expect(name).toBe("code_review_1");
    expect(path).toBe(join(root, SPACE, "code_review_1", "SKILL.md"));
    expect(existsSync(path)).toBe(true);

    const doc = readFileSync(path, "utf8");
    expect(doc).toContain("name: code_review_1");
    expect(doc).toContain("description: Review diffs against the checklist.");
    expect(doc).toContain('  - "say \\"hi\\""'); // trigger quotes are escaped
    expect(doc).toContain("Step two.");

    // The same loader the sessions use reads name + description back.
    const skills = await resolveSpaceSkills(SPACE, { root });
    expect(skills.map((s) => s.name)).toContain("code_review_1");
    const loaded = skills.find((s) => s.name === "code_review_1")!;
    expect(loaded.description).toBe("Review diffs against the checklist.");
    expect(loaded.source).toBe(`space:${SPACE}`);
  });
});

describe("resolveSpaceSkills", () => {
  test("a missing space dir resolves to an empty list (never an error, never a create-on-read)", async () => {
    const root = join(dir, "empty");
    const skills = await resolveSpaceSkills(SPACE, { root });
    expect(skills).toEqual([]);
    expect(existsSync(join(root, SPACE))).toBe(false);
  });

  test("a write busts the cache so the space's next resolution sees the new skill", async () => {
    const root = join(dir, "cache");
    const first = await resolveSpaceSkills(SPACE, { root });
    expect(first).toEqual([]);

    await writeSpaceSkill(SPACE, { name: "alpha", description: "A." }, { root });
    // Without a reload the cached empty list would hide it; write busted the cache.
    const second = await resolveSpaceSkills(SPACE, { root });
    expect(second.map((s) => s.name)).toEqual(["alpha"]);
  });
});

describe("resolveWorkItemSkills (Tier 3 merge)", () => {
  test("space-authored skills shadow the same-named builtin", async () => {
    const root = join(dir, "shadow");
    await writeSpaceSkill(SPACE, { name: "pr_review", description: "space's own loop" }, { root });
    const skills = await resolveWorkItemSkills(SPACE, ["pr_review"], { root });
    expect(skills).toHaveLength(1);
    expect(skills[0].source).toBe(`space:${SPACE}`);
    expect(skills[0].description).toBe("space's own loop");
  });

  test("unknown names are skipped, the rest still resolve (no new skills are ever fabricated)", async () => {
    const root = join(dir, "unknown");
    const skills = await resolveWorkItemSkills(SPACE, ["no_such_skill_zz", "pr_review"], { root });
    expect(skills.map((s) => s.name)).toEqual(["pr_review"]);
    expect(skills[0].source).toBe("builtin");
  });

  test("empty pins resolve to nothing", async () => {
    const skills = await resolveWorkItemSkills(SPACE, [], { root: join(dir, "none") });
    expect(skills).toEqual([]);
  });
});

describe("resolveBuiltinSkills", () => {
  test("the committed builtins ship the pr_review skill", async () => {
    const skills = await resolveBuiltinSkills();
    const pr = skills.find((s) => s.name === "pr_review");
    expect(pr).toBeDefined();
    expect(pr!.description.length).toBeGreaterThan(0);
    expect(pr!.source).toBe("builtin");
    // skill://pr_review resolves against the committed SKILL.md's dir.
    expect(existsSync(join(pr!.baseDir, "SKILL.md"))).toBe(true);
  });
});
