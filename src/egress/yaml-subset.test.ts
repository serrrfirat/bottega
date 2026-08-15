/**
 * Direct tests for the test-only YAML-subset parser (issue #29): its own
 * rejection/acceptance rules, independent of the fixtures it parses. This is
 * the parser every structural test (compose, egress, secrets, deploy) leans
 * on, so its edges deserve direct coverage.
 */
import { describe, expect, test } from "bun:test";
import { parseYamlSequence, parseYamlSubset } from "./yaml-subset";

describe("yaml-subset parser", () => {
  test("parses nested mappings, plain scalars, and quoted scalars", () => {
    const cfg = parseYamlSubset(
      [
        "top:",
        "  inner:",
        "    leaf: value",
        '  quoted: "two words"',
        "  number: 8080",
        "  empty_ok:",
        "",
      ].join("\n"),
    );
    expect(cfg["top"]).toEqual({
      inner: { leaf: "value" },
      quoted: "two words",
      number: "8080",
      empty_ok: {},
    });
  });

  test("parses sequences of scalars and inline map items with continuation keys", () => {
    const list = parseYamlSequence(
      [
        "- alpha",
        "- beta",
        "- name: first",
        "  config:",
        "    domains:",
        '      - "api.near.ai"',
        "  enabled: true",
        "- gamma",
      ].join("\n"),
    );
    expect(list).toEqual([
      "alpha",
      "beta",
      { name: "first", config: { domains: ["api.near.ai"] }, enabled: "true" },
      "gamma",
    ]);
  });

  test("parses literal block scalars verbatim (multi-line prompts)", () => {
    const cfg = parseYamlSubset(
      ["prompt: |", "  Decide whether this outbound", "  request is acceptable.", "after: value"].join("\n"),
    );
    expect(cfg["prompt"]).toBe("Decide whether this outbound\nrequest is acceptable.");
    expect(cfg["after"]).toBe("value");
  });

  test("strips full-line and trailing comments but not # inside quotes", () => {
    const cfg = parseYamlSubset(['key: value # trailing', '# full-line comment', 'path: "a#b"'].join("\n"));
    expect(cfg).toEqual({ key: "value", path: "a#b" });
  });

  test("rejects flow collections", () => {
    expect(() => parseYamlSubset("key: [a, b]")).toThrow(/flow collections/);
    expect(() => parseYamlSubset("key: {a: b}")).toThrow(/flow collections/);
    // A flow collection at the root is not a mapping at all.
    expect(() => parseYamlSubset("[a, b]")).toThrow();
  });

  test("rejects unsupported keys, duplicate keys, and malformed scalars", () => {
    expect(() => parseYamlSubset('"quoted key": value')).toThrow(/unsupported key/);
    expect(() => parseYamlSubset("key: value\nkey: again")).toThrow(/duplicate key/);
    expect(() => parseYamlSubset("a: 1\n  b: 2")).toThrow(/unexpected content/);
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
