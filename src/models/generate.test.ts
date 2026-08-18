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
    const yaml = renderModelsConfig({ models: { default: "deepseek-ai/DeepSeek-V4-Flash", fast: "acme/chat" } });
    expect(yaml).not.toBeNull();
    const text = yaml!;
    expect(text).toContain("opencode-go:");
    expect(text).toContain("apiKey: bottega-proxy-placeholder");
    expect(text).toContain("baseUrl: \"https://cloud-api.near.ai/v1\"");
    expect(text).toContain('id: "deepseek-ai/DeepSeek-V4-Flash"');
    expect(text).toContain('id: "acme/chat"');
    // The openai/anthropic gateway skeleton survives settings regeneration.
    expect(text).toContain("baseUrl: \"https://api.openai.com/v1\"");
    expect(text).toContain("apiKey: bottega-proxy-placeholder");
    expect(text).toContain('id: "gpt-5-mini"');
    expect(text).toContain("baseUrl: \"https://api.anthropic.com/v1\"");
    expect(text).toContain("apiKey: bottega-proxy-placeholder");
    expect(text).toContain('id: "claude-sonnet-4-5"');
    // The placeholder literal is the ONLY key shape (issue #208) — never an
    // env-name reference (the unset-env fail-open is dead).
    expect(text).not.toMatch(/apiKey: [A-Z][A-Z0-9_]+$/m);
    // Dedup: reasoning repeats default → listed once under near (the
    // openai/anthropic anchors add their own id lines, which is expected).
    const yaml2 = renderModelsConfig({
      models: { default: "deepseek-ai/DeepSeek-V4-Flash", reasoning: "deepseek-ai/DeepSeek-V4-Flash" },
    })!;
    expect(yaml2.match(/id: "deepseek-ai\/DeepSeek-V4-Flash"/g)?.length).toBe(1);
  });
});

describe("regenerateModelsConfig (issue #67)", () => {
  test("writes the rendered catalog to the out path", () => {
    const dir = mkdtempSync(join(tmpdir(), "bottega-models-"));
    try {
      const outPath = join(dir, "models.yml");
      const rendered = regenerateModelsConfig(
        { models: { default: "deepseek-ai/DeepSeek-V4-Flash" } },
        outPath,
      );
      expect(rendered).not.toBeNull();
      expect(rendered).not.toBeUndefined();
      expect(readFileSync(outPath, "utf8")).toBe(rendered!);
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
