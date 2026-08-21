
/** Filesystem-boundary tests for the revisioned space-skill lifecycle. */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSpaceSkill,
  deleteSpaceSkill,
  getSpaceSkill,
  listSpaceSkills,
  MAX_COMPANION_FILE_BYTES,
  MAX_SKILL_DOCUMENT_BYTES,
  MAX_SKILL_TOTAL_BYTES,
  resolveSpaceSkills,
  resolveWorkItemSkills,
  updateSpaceSkill,
} from "./skills";

const dir = mkdtempSync(join(tmpdir(), "bottega-skills-lifecycle-"));
const SPACE = "slack:C123";
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function root(name: string): string {
  return join(dir, name);
}

function document(name: string, description: string, body = "Procedure."): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`;
}

describe("space-skill storage lifecycle", () => {
  test("creates, lists, reads, replaces the complete declared file set, and deletes only the space tier", async () => {
    const skillsRoot = root("lifecycle-space");
    const builtinDir = root("lifecycle-builtin");
    mkdirSync(join(builtinDir, "review"), { recursive: true });
    writeFileSync(join(builtinDir, "review", "SKILL.md"), document("review", "Built-in."));

    const created = await createSpaceSkill(
      SPACE,
      {
        name: "review",
        document: document("review", "Space v1."),
        companionFiles: { "scripts/run.sh": { encoding: "text", content: "echo v1" }, "assets/data.bin": { encoding: "base64", content: "AAEC" } },
      },
      { root: skillsRoot, builtinDir },
    );
    expect(created).toMatchObject({
      name: "review",
      source_tier: "space",
      companion_files: ["assets/data.bin", "scripts/run.sh"],
      shadows: [],
    });
    expect(created.revision).toMatch(/^[a-f0-9]{64}$/);

    expect(await listSpaceSkills(SPACE, { root: skillsRoot, builtinDir })).toEqual([
      expect.objectContaining({ name: "review", source_tier: "space", shadows: ["builtin"] }),
    ]);
    const got = await getSpaceSkill(SPACE, "review", { root: skillsRoot, builtinDir });
    expect(got.skill.companion_files).toEqual({
      "assets/data.bin": { encoding: "base64", content: "AAEC" },
      "scripts/run.sh": { encoding: "text", content: "echo v1" },
    });
    expect(got.shadowed).toEqual([expect.objectContaining({ source_tier: "builtin" })]);

    await expect(
      createSpaceSkill(
        SPACE,
        { name: "review", document: document("review", "Silent replacement."), companionFiles: {} },
        { root: skillsRoot, builtinDir },
      ),
    ).rejects.toThrow(/already exists/);
    expect((await getSpaceSkill(SPACE, "review", { root: skillsRoot, builtinDir })).skill.revision).toBe(created.revision);

    const updated = await updateSpaceSkill(
      SPACE,
      {
        name: "review",
        expectedRevision: created.revision,
        document: document("review", "Space v2."),
        companionFiles: { "scripts/new.sh": { encoding: "text", content: "echo v2" } },
      },
      { root: skillsRoot, builtinDir },
    );
    expect(updated.skill.revision).not.toBe(created.revision);
    expect(existsSync(join(skillsRoot, SPACE, "review", "scripts", "run.sh"))).toBe(false);
    expect(existsSync(join(skillsRoot, SPACE, "review", "assets", "data.bin"))).toBe(false);
    expect((await getSpaceSkill(SPACE, "review", { root: skillsRoot, builtinDir })).skill.companion_files).toEqual({
      "scripts/new.sh": { encoding: "text", content: "echo v2" },
    });

    const removed = await deleteSpaceSkill(SPACE, "review", updated.skill.revision, { root: skillsRoot, builtinDir });
    expect(removed.deleted.source_tier).toBe("space");
    expect(removed.revealed?.source_tier).toBe("builtin");
    expect((await getSpaceSkill(SPACE, "review", { root: skillsRoot, builtinDir })).skill.source_tier).toBe("builtin");
  });

  test("rejects traversal, absolute, platform-separator, hidden, and reserved companion paths before touching disk", async () => {
    for (const [index, path] of [
      "../escape",
      "nested/../../escape",
      "/absolute",
      "C:\\absolute",
      "nested\\escape",
      ".hidden",
      "nested/.hidden",
      "SKILL.md",
      "nested/SKILL.md",
      ".bottega-skill.json",
    ].entries()) {
      const skillsRoot = root(`invalid-path-${index}`);
      await expect(
        createSpaceSkill(
          SPACE,
          { name: "safe", document: document("safe", "Safe."), companionFiles: { [path]: { encoding: "text", content: "no" } } },
          { root: skillsRoot },
        ),
      ).rejects.toThrow(/companion path|reserved|relative/);
      expect(existsSync(join(skillsRoot, SPACE))).toBe(false);
    }
  });

  test("rejects symlink roots, skill directories, and companion entries without crossing the configured root", async () => {
    const outside = root("symlink-outside");
    mkdirSync(outside, { recursive: true });
    const linkedRoot = root("linked-root");
    symlinkSync(outside, linkedRoot, "dir");
    await expect(
      createSpaceSkill(SPACE, { name: "safe", document: document("safe", "Safe.") }, { root: linkedRoot }),
    ).rejects.toThrow(/symlink/);
    expect(existsSync(join(outside, SPACE))).toBe(false);

    const skillsRoot = root("symlink-entry");
    const created = await createSpaceSkill(
      SPACE,
      { name: "safe", document: document("safe", "Safe."), companionFiles: { "run.sh": { encoding: "text", content: "inside" } } },
      { root: skillsRoot },
    );
    const outsideFile = join(outside, "outside.txt");
    writeFileSync(outsideFile, "outside");
    rmSync(join(skillsRoot, SPACE, "safe", "run.sh"));
    symlinkSync(outsideFile, join(skillsRoot, SPACE, "safe", "run.sh"));
    await expect(getSpaceSkill(SPACE, "safe", { root: skillsRoot })).rejects.toThrow(/symlink/);
    await expect(
      updateSpaceSkill(
        SPACE,
        {
          name: "safe",
          expectedRevision: created.revision,
          document: document("safe", "Changed."),
          companionFiles: {},
        },
        { root: skillsRoot },
      ),
    ).rejects.toThrow(/symlink/);
    expect(await Bun.file(outsideFile).text()).toBe("outside");
  });

  test("enforces document, per-file, and total byte caps at the filesystem boundary", async () => {
    await expect(
      createSpaceSkill(
        SPACE,
        { name: "large_doc", document: document("large_doc", "Large.", "é".repeat(MAX_SKILL_DOCUMENT_BYTES)) },
        { root: root("large-doc") },
      ),
    ).rejects.toThrow(/SKILL\.md exceeds/);

    await expect(
      createSpaceSkill(
        SPACE,
        {
          name: "large_file",
          document: document("large_file", "Large."),
          companionFiles: { "data.bin": new Uint8Array(MAX_COMPANION_FILE_BYTES + 1) },
        },
        { root: root("large-file") },
      ),
    ).rejects.toThrow(/companion file.*exceeds/);

    const chunk = new Uint8Array(Math.floor(MAX_SKILL_TOTAL_BYTES / 4));
    await expect(
      createSpaceSkill(
        SPACE,
        {
          name: "large_total",
          document: document("large_total", "Large."),
          companionFiles: {
            "a.bin": chunk,
            "b.bin": chunk,
            "c.bin": chunk,
            "d.bin": chunk,
          },
        },
        { root: root("large-total") },
      ),
    ).rejects.toThrow(/total bytes/);
  });

  test("stale revisions and commit failures roll back without changing the existing tree or cache", async () => {
    const skillsRoot = root("rollback");
    const created = await createSpaceSkill(
      SPACE,
      { name: "atomic", document: document("atomic", "Before."), companionFiles: { "run.sh": { encoding: "text", content: "before" } } },
      { root: skillsRoot },
    );
    const activeSnapshot = await resolveSpaceSkills(SPACE, { root: skillsRoot });

    await expect(
      updateSpaceSkill(
        SPACE,
        { name: "atomic", expectedRevision: "0".repeat(64), document: document("atomic", "Stale."), companionFiles: {} },
        { root: skillsRoot },
      ),
    ).rejects.toThrow(/stale skill revision/);

    await expect(
      updateSpaceSkill(
        SPACE,
        {
          name: "atomic",
          expectedRevision: created.revision,
          document: document("atomic", "After."),
          companionFiles: { "run.sh": { encoding: "text", content: "after" } },
        },
        {
          root: skillsRoot,
          mutationHook(stage) {
            if (stage === "after-backup") throw new Error("injected commit failure");
          },
        },
      ),
    ).rejects.toThrow("injected commit failure");

    const after = await getSpaceSkill(SPACE, "atomic", { root: skillsRoot });
    expect(after.skill).toMatchObject({ revision: created.revision, description: "Before." });
    expect(after.skill.companion_files).toEqual({ "run.sh": { encoding: "text", content: "before" } });
    expect(activeSnapshot[0]?.description).toBe("Before.");
    expect(readdirSync(join(skillsRoot, SPACE)).filter((name) => name.startsWith("."))).toEqual([]);
  });

  test("metadata rejects undeclared leftovers and successful mutations refresh only future resolutions", async () => {
    const skillsRoot = root("manifest-and-cache");
    const builtinDir = root("manifest-builtin");
    mkdirSync(join(builtinDir, "memo"), { recursive: true });
    writeFileSync(join(builtinDir, "memo", "SKILL.md"), document("memo", "Built-in memo."));
    const created = await createSpaceSkill(SPACE, { name: "memo", document: document("memo", "Space memo.") }, { root: skillsRoot, builtinDir });
    const sessionOne = await resolveWorkItemSkills(SPACE, ["memo"], { root: skillsRoot, builtinDir });

    writeFileSync(join(skillsRoot, SPACE, "memo", "undeclared.txt"), "leftover");
    await expect(getSpaceSkill(SPACE, "memo", { root: skillsRoot, builtinDir })).rejects.toThrow(/undeclared/);
    rmSync(join(skillsRoot, SPACE, "memo", "undeclared.txt"));

    const updated = await updateSpaceSkill(
      SPACE,
      { name: "memo", expectedRevision: created.revision, document: document("memo", "New memo."), companionFiles: {} },
      { root: skillsRoot, builtinDir },
    );
    expect(sessionOne[0]?.description).toBe("Space memo.");
    expect((await resolveWorkItemSkills(SPACE, ["memo"], { root: skillsRoot, builtinDir }))[0]?.description).toBe("New memo.");

    await deleteSpaceSkill(SPACE, "memo", updated.skill.revision, { root: skillsRoot, builtinDir });
    expect(sessionOne[0]?.description).toBe("Space memo.");
    expect((await resolveWorkItemSkills(SPACE, ["memo"], { root: skillsRoot, builtinDir }))[0]?.description).toBe("Built-in memo.");
  });
});
