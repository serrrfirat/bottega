import { afterEach, describe, expect, test, vi } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPersona } from "./personas";

const tempDirs: string[] = [];

function personaConfig(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "bottega-personas-"));
  const dir = join(root, "config", "personas");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "default.md"), "Default department guidance.");
  writeFileSync(join(dir, "default.tools.yml"), "- memory.search\n- memory.save\n- create_work_item\n");
  for (const [name, contents] of Object.entries(files)) writeFileSync(join(dir, name), contents);
  tempDirs.push(root);
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("loadPersona (issue #130)", () => {
  test("uses the default persona when the space has no persona key", () => {
    const dir = personaConfig();

    expect(loadPersona("tools:\n  bash: deny", dir)).toEqual({
      id: "default",
      prompt: "Default department guidance.",
      toolFloor: ["memory.search", "memory.save", "create_work_item"],
    });
  });

  test("logs and uses the default persona for an unknown id", () => {
    const dir = personaConfig();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(loadPersona("persona: finance", dir).id).toBe("default");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("finance"));
  });

  test("uses the default persona when the space policy is malformed", () => {
    const dir = personaConfig();

    expect(loadPersona("persona: [ops]", dir).id).toBe("default");
  });

  test("uses the complete default persona when one configured persona file is missing", () => {
    const dir = personaConfig({ "partial.md": "This fragment must not leak into the fallback." });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(loadPersona("persona: partial", dir)).toEqual({
      id: "default",
      prompt: "Default department guidance.",
      toolFloor: ["memory.search", "memory.save", "create_work_item"],
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("partial"));
  });

  test("loads the selected persona prompt and tool floor", () => {
    const dir = personaConfig({
      "ops.md": "Operations department guidance.",
      "ops.tools.yml": "- memory.search\n- create_work_item\n- linear.create_issue\n",
    });

    expect(loadPersona("persona: ops", dir)).toEqual({
      id: "ops",
      prompt: "Operations department guidance.",
      toolFloor: ["memory.search", "create_work_item", "linear.create_issue"],
    });
  });
});
