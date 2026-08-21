import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const workflow = Bun.YAML.parse(
  readFileSync(resolve(ROOT, ".github/workflows/ci.yml"), "utf8"),
) as Record<string, unknown>;
const packageJson = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")) as {
  scripts?: Record<string, string>;
};

describe("required CI workflow", () => {
  test("runs the package lint command after install and before tests", () => {
    expect(packageJson.scripts?.["lint"]).toBeDefined();
    expect(workflow["on"]).toEqual(["push", "pull_request"]);

    const jobs = workflow["jobs"] as Record<string, Record<string, unknown>>;
    const steps = jobs["ci"]?.["steps"] as Array<Record<string, unknown>>;
    const commands = steps.map((step) => step["run"]).filter((run): run is string => typeof run === "string");

    const installIndex = commands.indexOf("bun install --frozen-lockfile");
    const lintIndex = commands.indexOf("bun run lint");
    const testIndex = commands.indexOf("bun run test");

    expect(installIndex).toBeGreaterThanOrEqual(0);
    expect(lintIndex).toBeGreaterThan(installIndex);
    expect(lintIndex).toBeLessThan(testIndex);
    const lintSteps = steps.filter((step) => step["run"] === "bun run lint");
    expect(lintSteps).toHaveLength(1);
    expect(lintSteps[0]?.["continue-on-error"]).toBeUndefined();
    expect(lintSteps[0]?.["if"]).toBeUndefined();
  });
});
