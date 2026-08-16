/** Knowledge-base source configuration (issue #91). */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseYamlSubset, type YamlNode } from "../yaml-subset";

export interface KbSource {
  id: string;
  url: string;
  /** Informational source format. Ingestion detects HTML from the response. */
  type: string;
}

export interface KbConfig {
  sources: KbSource[];
}

const SOURCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SOURCE_KEYS: Record<string, true> = { id: true, url: true, type: true };

function sourceMapping(node: YamlNode, index: number): Record<string, YamlNode> {
  if (typeof node === "string" || Array.isArray(node)) {
    throw new Error(`config/kb.yml: sources[${index}] must be a mapping`);
  }
  for (const key of Object.keys(node)) {
    if (SOURCE_KEYS[key] !== true) throw new Error(`config/kb.yml: sources[${index}] has unknown key '${key}'`);
  }
  return node;
}

function requiredScalar(source: Record<string, YamlNode>, key: "id" | "url", index: number): string {
  const value = source[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`config/kb.yml: sources[${index}].${key} must be a non-empty string`);
  }
  return value.trim();
}

function validateHttpUrl(value: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`config/kb.yml: ${label} must be a valid URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`config/kb.yml: ${label} must use http or https`);
  }
  if (url.username || url.password) {
    throw new Error(`config/kb.yml: ${label} must not contain credentials`);
  }
  return url;
}

/** Strictly parses the committed `config/kb.yml` contract. */
export function parseKbConfigYaml(text: string): KbConfig {
  let document: Record<string, YamlNode>;
  try {
    document = parseYamlSubset(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`config/kb.yml: ${message}`);
  }

  const topLevelKeys = Object.keys(document);
  if (topLevelKeys.some((key) => key !== "sources")) {
    const unknown = topLevelKeys.find((key) => key !== "sources");
    throw new Error(`config/kb.yml: unknown top-level key '${unknown}'`);
  }
  if (!("sources" in document)) throw new Error("config/kb.yml: sources is required");

  const sourcesNode = document.sources;
  // The shared YAML subset represents `sources:` with only commented items as
  // an empty mapping. Accept that one shape so the shipped #91 example stays disabled.
  if (!Array.isArray(sourcesNode)) {
    if (typeof sourcesNode === "object" && Object.keys(sourcesNode).length === 0) return { sources: [] };
    throw new Error("config/kb.yml: sources must be a sequence");
  }

  const ids = new Set<string>();
  const sources = sourcesNode.map((node, index): KbSource => {
    const source = sourceMapping(node, index);
    const id = requiredScalar(source, "id", index);
    if (!SOURCE_ID_PATTERN.test(id)) {
      throw new Error(`config/kb.yml: sources[${index}].id has an invalid format`);
    }
    if (ids.has(id)) throw new Error(`config/kb.yml: duplicate source id '${id}'`);
    ids.add(id);

    const url = requiredScalar(source, "url", index);
    validateHttpUrl(url, `sources[${index}].url`);
    const typeNode = source.type;
    if (typeNode !== undefined && (typeof typeNode !== "string" || !typeNode.trim())) {
      throw new Error(`config/kb.yml: sources[${index}].type must be a non-empty string`);
    }
    return { id, url, type: typeof typeNode === "string" ? typeNode.trim() : "html" };
  });
  return { sources };
}

/** Loads `config/kb.yml` from `dir`, `BOTTEGA_CONFIG_DIR`, or the repo root. */
export function loadKbConfig(dir?: string): KbConfig {
  const configDir = dir ?? process.env.BOTTEGA_CONFIG_DIR ?? process.cwd();
  let text: string;
  try {
    text = readFileSync(join(configDir, "config", "kb.yml"), "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`config/kb.yml: ${message}`);
  }

  return parseKbConfigYaml(text);
}
