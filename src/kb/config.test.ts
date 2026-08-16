import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadKbConfig, parseKbConfigYaml } from "./config";

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe("parseKbConfigYaml", () => {
  test("parses sources and defaults the informational type to html", () => {
    expect(
      parseKbConfigYaml(`
sources:
  - id: handbook
    url: "https://docs.example.com/handbook"
  - id: runbooks
    url: "https://docs.example.com/runbooks"
    type: markdown
`),
    ).toEqual({
      sources: [
        { id: "handbook", url: "https://docs.example.com/handbook", type: "html" },
        { id: "runbooks", url: "https://docs.example.com/runbooks", type: "markdown" },
      ],
    });
  });

  test("accepts the committed empty-list form used for commented examples", () => {
    expect(parseKbConfigYaml("sources:\n  # - id: disabled\n")).toEqual({ sources: [] });
  });

  test("fails closed on malformed, unknown, duplicate, or unsafe sources", () => {
    expect(() => parseKbConfigYaml("sources: nope\n")).toThrow("sources must be a sequence");
    expect(() => parseKbConfigYaml("sources:\n  - id: handbook\n    url: https://docs.example.com\n    extra: no\n")).toThrow(
      "unknown key",
    );
    expect(() =>
      parseKbConfigYaml(
        "sources:\n  - id: handbook\n    url: https://docs.example.com/a\n  - id: handbook\n    url: https://docs.example.com/b\n",
      ),
    ).toThrow("duplicate source id");
    expect(() => parseKbConfigYaml("sources:\n  - id: local\n    url: file:///etc/passwd\n")).toThrow(
      "http or https",
    );
  });
});

describe("loadKbConfig", () => {
  test("loads config/kb.yml from the supplied repo root", () => {
    const dir = mkdtempSync(join(tmpdir(), "bottega-kb-config-"));
    tempDirs.push(dir);
    const configDir = join(dir, "config");
    mkdirSync(configDir);
    writeFileSync(
      join(configDir, "kb.yml"),
      "sources:\n  - id: handbook\n    url: https://docs.example.com/guides/start?lang=en\n",
    );

    expect(loadKbConfig(dir)).toEqual({
      sources: [
        {
          id: "handbook",
          url: "https://docs.example.com/guides/start?lang=en",
          type: "html",
        },
      ],
    });
  });

  test("throws with file context when kb.yml is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "bottega-kb-missing-"));
    tempDirs.push(dir);
    expect(() => loadKbConfig(dir)).toThrow("config/kb.yml");
  });
});
