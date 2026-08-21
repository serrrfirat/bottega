import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

const WorkflowStepSchema = z.object({
  run: z.string().optional(),
  "continue-on-error": z.boolean().optional(),
  if: z.string().optional(),
});
const WorkflowSchema = z.object({
  on: z.array(z.string()),
  jobs: z.object({
    ci: z.object({
      steps: z.array(WorkflowStepSchema),
    }),
  }),
});
const PackageJsonSchema = z.object({
  scripts: z.record(z.string(), z.string()),
});


const ROOT = resolve(import.meta.dir, "..");
const workflow = WorkflowSchema.parse(Bun.YAML.parse(
  readFileSync(resolve(ROOT, ".github/workflows/ci.yml"), "utf8"),
));
const packageJson = PackageJsonSchema.parse(JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")));

describe("required CI workflow", () => {
  test("runs the package lint command after install and before tests", () => {
    expect(packageJson.scripts["lint"]).toBeDefined();
    expect(workflow.on).toEqual(["push", "pull_request"]);

    const steps = workflow.jobs.ci.steps;
    const commands = steps.flatMap((step) => (step.run === undefined ? [] : [step.run]));

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
