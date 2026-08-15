/**
 * Direct tests for the shared YAML-subset parser (issue #33). The parser is
 * the production reader for config.yml / org.yml as well as the fixture
 * validator for compose/egress templates, so its acceptance and rejection
 * rules are contracts — especially the shapes the old hand-rolled scanners
 * mis-parsed: trailing comments, inline sequences, and tab-indented lists.
 */
import { describe, expect, test } from "bun:test";
import { parseYamlSequence, parseYamlSubset } from "./yaml-subset";

describe("yaml-subset mapping parsing", () => {
  test("parses nested mappings with plain and quoted scalars", () => {
    const doc = parseYamlSubset('tools:\n  bash: deny\n  write: "allow"\napprovals:\n  timeout_minutes: 7\n');
    expect(doc).toEqual({
      tools: { bash: "deny", write: "allow" },
      approvals: { timeout_minutes: "7" },
    });
  });

  test("strips full-line and trailing comments (not inside quotes)", () => {
    const doc = parseYamlSubset(`
# org floor
git_base_url: "https://github.com" # trailing comment
repos:
  - "acme/sandbox" # v1 target
  - acme/other
`);
    expect(doc).toEqual({
      git_base_url: "https://github.com",
      repos: ["acme/sandbox", "acme/other"],
    });
  });

  test("rejects flow collections (inline sequences/mappings) instead of mis-parsing", () => {
    expect(() => parseYamlSubset('repos: ["acme/sandbox"]\n')).toThrow(/flow collections/);
    expect(() => parseYamlSubset("tools: {bash: deny}\n")).toThrow(/flow collections/);
  });

  test("rejects duplicate keys", () => {
    expect(() => parseYamlSubset("tools:\n  bash: deny\n  bash: allow\n")).toThrow(/duplicate key/);
  });

  test("rejects non-mapping roots", () => {
    expect(() => parseYamlSubset("- a\n- b\n")).toThrow(/top level must be a mapping/);
    expect(() => parseYamlSequence("a: b\n")).toThrow(/top level must be a sequence/);
  });

  test("rejects malformed lines and stray content", () => {
    expect(() => parseYamlSubset("tools:\n  bash deny\n")).toThrow(/expected "key:"/);
    expect(() => parseYamlSubset("a: b\nx: y\n  nested: z\n")).toThrow(/unexpected content/);
  });

  test("empty input parses to an empty document", () => {
    expect(parseYamlSubset("")).toEqual({});
    expect(parseYamlSequence("")).toEqual([]);
  });
});

describe("yaml-subset sequence parsing", () => {
  test("parses sequences of scalars and inline maps with deeper children", () => {
    const doc = parseYamlSequence(`
- name: allowlist
  config:
    domains:
      - "api.near.ai"
- plain-item
`);
    expect(doc).toEqual([
      { name: "allowlist", config: { domains: ["api.near.ai"] } },
      "plain-item",
    ]);
  });

  test("parses literal block scalars verbatim (multi-line prompts)", () => {
    const cfg = parseYamlSubset(
      ["prompt: |", "  Decide whether this outbound", "  request is acceptable.", "after: value"].join("\n"),
    );
    expect(cfg["prompt"]).toBe("Decide whether this outbound\nrequest is acceptable.");
    expect(cfg["after"]).toBe("value");
  });

  test("rejects unterminated quotes and quotes inside quoted scalars", () => {
    expect(() => parseYamlSubset('key: "unterminated')).toThrow(/unterminated/);
    expect(() => parseYamlSubset('key: "a"b"')).toThrow(/quotes inside/);
  });

  test("rejects empty sequence items and block scalars inside sequence items", () => {
    expect(() => parseYamlSubset("-\n- x")).toThrow(/empty sequence item/);
    expect(() => parseYamlSequence("- prompt: |\n    body")).toThrow(/block scalar inside sequence item/);
  });
});
