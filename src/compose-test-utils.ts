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

export const services = compose["services"] as Record<string, YamlNode>;
export const networks = compose["networks"] as Record<string, YamlNode>;
export const volumes = compose["volumes"] as Record<string, YamlNode>;

export function service(name: string): Record<string, YamlNode> {
  return services[name] as Record<string, YamlNode>;
}

export function serviceEnv(name: string): Record<string, YamlNode> {
  return service(name)["environment"] as Record<string, YamlNode>;
}

export function serviceDns(name: string): string[] {
  return service(name)["dns"] as string[];
}
