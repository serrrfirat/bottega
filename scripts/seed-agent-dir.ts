/**
 * Agent-dir seeding (issue #24, hardened #78): copies the committed OMP
 * templates into data/omp-agent ONLY when missing. An EXISTING
 * config.yml is never overwritten — operators keep customizations there
 * (e.g. the #78 disabledProviders band-aid) and the modelRoles pin is
 * guaranteed by the boot-time ensureAgentDirModelPin (agent-driver.ts),
 * which appends without clobbering.
 *
 * Shared by scripts/dev.sh (CLI) and hermetic tests (direct import).
 */
import { copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export const AGENT_DIR_TEMPLATES = ["config.yml", "models.yml", "secrets.yml"] as const;

export interface SeedResult {
  seeded: string[];
  kept: string[];
}

/** Copies each missing template; returns what was seeded vs kept. Never overwrites. */
export function seedAgentDir(agentDir: string, templateDir: string): SeedResult {
  const seeded: string[] = [];
  const kept: string[] = [];
  for (const name of AGENT_DIR_TEMPLATES) {
    if (existsSync(join(agentDir, name))) {
      kept.push(name);
      continue;
    }
    copyFileSync(join(templateDir, name), join(agentDir, name));
    seeded.push(name);
  }
  return { seeded, kept };
}

if (import.meta.main) {
  const [agentDir = "data/omp-agent", templateDir = "config/omp"] = Bun.argv.slice(2);
  const { seeded, kept } = seedAgentDir(agentDir, templateDir);
  for (const name of seeded) console.log(`omp agent dir: seeded ${templateDir}/${name} -> ${agentDir}/${name}`);
  for (const name of kept) console.log(`omp agent dir: kept existing ${agentDir}/${name}`);
}
