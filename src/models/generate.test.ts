/**
 * models.yml generation tests (issue #67): the agent-dir catalog is a
 * boot-time output of the org settings blob — written only when settings
 * carry model ids (else the committed template stays the default).
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { configuredModelIds, regenerateModelsConfig, renderModelsConfig } from "./generate";

describe("configuredModelIds (issue #67)", () => {
  test("empty settings → no ids", () => {
    expect(configuredModelIds({})).toEqual([]);
    expect(configuredModelIds({ models: {} })).toEqual([]);
    expect(configuredModelIds({ models: { effort: "high" } })).toEqual([]);
  });

  test("default/fast/reasoning ids, order-stable and deduped, blank ids dropped", () => {
    expect(
      configuredModelIds({ models: { default: "a/b", fast: "c/d", reasoning: "a/b" } }),
    ).toEqual(["a/b", "c/d"]);
    expect(configuredModelIds({ models: { default: "  ", fast: "x/y" } })).toEqual(["x/y"]);
  });
});

describe("renderModelsConfig (issue #67)", () => {
  test("no model ids → null (caller keeps the template)", () => {
    expect(renderModelsConfig({})).toBeNull();
    expect(renderModelsConfig({ models: { effort: "low" } })).toBeNull();
  });

  test("keeps the template provider skeleton and lists the configured ids", () => {
    const yaml = renderModelsConfig({ models: { default: "zai-org/GLM-5.1-FP8", fast: "acme/chat" } });
    expect(yaml).not.toBeNull();
    const text = yaml as string;
    expect(text).toContain("opencode-go:");
    expect(text).toContain('apiKey: OPENCODE_API_KEY');
    expect(text).toContain("baseUrl: \"https://cloud-api.near.ai/v1\"");
    expect(text).toContain('id: "zai-org/GLM-5.1-FP8"');
    expect(text).toContain('id: "acme/chat"');
    // Dedup: reasoning repeats default → listed once.
    const yaml2 = renderModelsConfig({
      models: { default: "zai-org/GLM-5.1-FP8", reasoning: "zai-org/GLM-5.1-FP8" },
    }) as string;
    expect(yaml2.match(/id: /g)?.length).toBe(1);
  });
});

describe("regenerateModelsConfig (issue #67)", () => {
  test("writes the rendered catalog to the out path", () => {
    const dir = mkdtempSync(join(tmpdir(), "bottega-models-"));
    try {
      const outPath = join(dir, "models.yml");
      const rendered = regenerateModelsConfig(
        { models: { default: "zai-org/GLM-5.1-FP8" } },
        outPath,
      );
      expect(rendered).not.toBeNull();
      expect(rendered).not.toBeUndefined();
      expect(readFileSync(outPath, "utf8")).toBe(rendered as string);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("no model ids → no file written (template stays)", () => {
    const dir = mkdtempSync(join(tmpdir(), "bottega-models-"));
    try {
      const outPath = join(dir, "models.yml");
      expect(regenerateModelsConfig({}, outPath)).toBeNull();
      expect(existsSync(outPath)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
