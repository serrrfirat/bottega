import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { parseYamlSequence, parseYamlSubset, type YamlNode } from "../yaml-subset";

export interface Persona {
  id: string;
  prompt: string;
  toolFloor: string[];
}

const DEFAULT_PERSONA_ID = "default";
const PERSONA_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const PERSONA_STRING = z.string();
/** Persisted JSON policy shape: `{ "persona": "<id>" }`; anything else yields no persona. */
const PERSONA_JSON = z.object({ persona: z.string().optional() }).catch({});
/** Tool-floor entry: any string that survives trimming. */
const TOOL_NAME = z.string().refine((value) => value.trim().length > 0);

function personaIdFromPolicy(spacePolicyJson: string): string {
  const text = spacePolicyJson.trim();
  if (!text) return DEFAULT_PERSONA_ID;

  let persona: string | undefined;
  try {
    // Space persona overlays use the repository's hand-authored YAML subset (#130).
    const yamlPersona = PERSONA_STRING.safeParse(parseYamlSubset(text)["persona"]);
    persona = yamlPersona.success ? yamlPersona.data : undefined;
  } catch {
    // Existing spaces.policy_json values are JSON. Accept that persisted shape too.
    try {
      persona = PERSONA_JSON.parse(JSON.parse(text)).persona;
    } catch {
      return DEFAULT_PERSONA_ID;
    }
  }

  if (persona === undefined) return DEFAULT_PERSONA_ID;
  const id = persona.trim();
  return id && PERSONA_ID_PATTERN.test(id) ? id : DEFAULT_PERSONA_ID;
}

function parseToolFloor(text: string): string[] | null {
  let values: YamlNode[];
  try {
    values = parseYamlSequence(text);
  } catch {
    return null;
  }
  const validated: string[] = [];
  for (const value of values) {
    const parsed = TOOL_NAME.safeParse(value);
    if (!parsed.success) return null;
    validated.push(parsed.data);
  }
  return [...new Set(validated)];
}

function readPersona(id: string, directories: readonly string[]): Persona | null {
  for (const directory of directories) {
    try {
      const prompt = readFileSync(join(directory, `${id}.md`), "utf8").trim();
      const toolFloor = parseToolFloor(readFileSync(join(directory, `${id}.tools.yml`), "utf8"));
      if (prompt && toolFloor) return { id, prompt, toolFloor };
    } catch {
      // Try the alternate config layout, then the default persona (#130).
    }
  }
  return null;
}

/**
 * Loads the persona selected by spaces.policy_json (issue #130).
 *
 * BOTTEGA_CONFIG_DIR may be the config directory itself, while the local
 * default is the repository root. Both layouts resolve the same
 * config/personas files. Missing or malformed configured files fall back to
 * the default persona so a space session never fails to boot.
 */
export function loadPersona(spacePolicyJson: string, dir?: string): Persona {
  const configDir = dir ?? process.env.BOTTEGA_CONFIG_DIR ?? process.cwd();
  const directories = [join(configDir, "personas"), join(configDir, "config", "personas")];
  const requestedId = personaIdFromPolicy(spacePolicyJson);

  if (requestedId !== DEFAULT_PERSONA_ID) {
    const selected = readPersona(requestedId, directories);
    if (selected) return selected;
    console.warn(`[personas] persona ${JSON.stringify(requestedId)} unavailable; using default`);
  }

  const fallback = readPersona(DEFAULT_PERSONA_ID, directories);
  if (fallback) return fallback;
  console.warn("[personas] default persona unavailable; continuing with no persona tools or prompt");
  return { id: DEFAULT_PERSONA_ID, prompt: "", toolFloor: [] };
}
