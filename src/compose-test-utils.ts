/**
 * Shared docker-compose.yml fixture (test-only): parses the hand-authored
 * compose file once and exposes typed node accessors so the egress
 * topology, secrets credential-boundary, and deploy packaging suites
 * assert against a single parse instead of each re-parsing the file.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseYamlSubset, type YamlNode } from "./yaml-subset";

export const compose = parseYamlSubset(
  readFileSync(resolve(import.meta.dir, "../docker-compose.yml"), "utf8"),
);

// SAFETY: the hand-authored docker-compose.yml declares `services`,
// `networks`, and `volumes` as top-level mappings; parseYamlSubset renders
// mappings as Record<string, YamlNode> and a shape change surfaces as
// undefined/type errors in the consuming assertions.
const composeSections = compose as Record<
  "services" | "networks" | "volumes",
  Record<string, YamlNode>
>;
export const services = composeSections["services"];
export const networks = composeSections["networks"];
export const volumes = composeSections["volumes"];

export function service(name: string): Record<string, YamlNode> {
  // SAFETY: every compose service is a mapping (key: value block) in the
  // hand-authored fixture; a missing service surfaces as undefined and the
  // assertion on it fails loudly.
  return services[name] as Record<string, YamlNode>;
}

export function serviceEnv(name: string): Record<string, YamlNode> {
  // SAFETY: `environment` is a mapping in the hand-authored fixture.
  return service(name)["environment"] as Record<string, YamlNode>;
}

export function serviceDns(name: string): string[] {
  // SAFETY: `dns` is a block sequence of scalars, rendered as string[].
  return service(name)["dns"] as string[];
}
