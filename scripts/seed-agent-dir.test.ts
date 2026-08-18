/**
 * Hermetic tests for the agent-dir seeding (issue #24, regression #78):
 * an EXISTING data/omp-agent/config.yml is never overwritten — operator
 * customizations (e.g. the disabledProviders band-aid) must survive any
 * re-seed, including after data/ is wiped by a shared-worktree git clean.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedAgentDir, AGENT_DIR_TEMPLATES } from "./seed-agent-dir";

function freshDirs() {
  const root = mkdtempSync(join(tmpdir(), "seed-agent-dir-"));
  const agentDir = join(root, "agent");
  const templateDir = join(root, "templates");
  mkdirSync(agentDir);
  mkdirSync(templateDir);
  writeFileSync(join(templateDir, "config.yml"), "modelRoles:\n  default: near/deepseek-ai/DeepSeek-V4-Flash\n");
  writeFileSync(join(templateDir, "models.yml"), "providers: {}\n");
  writeFileSync(join(templateDir, "secrets.yml"), "secrets: {}\n");
  return { agentDir, templateDir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe("seedAgentDir (issue #24, regression #78)", () => {
  test("a fresh agent dir is seeded with all three templates", () => {
    const { agentDir, templateDir, cleanup } = freshDirs();
    try {
      const { seeded, kept } = seedAgentDir(agentDir, templateDir);
      expect(seeded.sort()).toEqual([...AGENT_DIR_TEMPLATES].sort());
      expect(kept).toEqual([]);
      for (const name of AGENT_DIR_TEMPLATES) expect(readFileSync(join(agentDir, name), "utf8")).toBeTruthy();
    } finally {
      cleanup();
    }
  });

  test("an existing config.yml (operator customizations) is NEVER overwritten", () => {
    const { agentDir, templateDir, cleanup } = freshDirs();
    try {
      writeFileSync(
        join(agentDir, "config.yml"),
        "modelRoles:\n  default: near/deepseek-ai/DeepSeek-V4-Flash\n\ndisabledProviders:\n  - opencode-go\n",
      );
      const { seeded, kept } = seedAgentDir(agentDir, templateDir);
      expect(seeded.sort()).toEqual(["models.yml", "secrets.yml"]);
      expect(kept).toEqual(["config.yml"]);
      // The band-aid block survives; the file is byte-identical.
      expect(readFileSync(join(agentDir, "config.yml"), "utf8")).toContain("disabledProviders:\n  - opencode-go");
    } finally {
      cleanup();
    }
  });

  test("re-seeding a fully populated dir changes nothing", () => {
    const { agentDir, templateDir, cleanup } = freshDirs();
    try {
      seedAgentDir(agentDir, templateDir);
      const configBefore = readFileSync(join(agentDir, "config.yml"), "utf8");
      const { seeded, kept } = seedAgentDir(agentDir, templateDir);
      expect(seeded).toEqual([]);
      expect(kept.sort()).toEqual([...AGENT_DIR_TEMPLATES].sort());
      expect(readFileSync(join(agentDir, "config.yml"), "utf8")).toBe(configBefore);
    } finally {
      cleanup();
    }
  });
});
