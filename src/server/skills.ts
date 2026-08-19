/**
 * Skills (issues #234/#235): the Tier-1 per-space skill store and the
 * Tier-3 task-level injection seam, shared by the server and the executor.
 *
 * Two sources compose:
 * - Per-space authored skills, under `data/skills/<spaceId>/` (the runtime
 *   root, gitignored by the existing `data/` rule; `BOTTEGA_SKILLS_DIR`
 *   overrides it). Authored through the policy-gated `write_space_skill`
 *   tool, read back at session creation and at work-item claim.
 * - Committed built-in skills under `skills/` (a fresh clone ships them;
 *   `BOTTEGA_BUILTIN_SKILLS_DIR` overrides). `pr_review` (issue #87) is the
 *   first one; git-delivery work items get it injected by default.
 *
 * All reads happen through the SDK's `loadSkillsFromDir`, which scans
 * `<dir>/<name>/SKILL.md` into the {@link Skill} shape the sessions consume
 * (`skill://<name>` resolves against each skill's baseDir at runtime).
 * Reads are cached in-process and invalidated when the write path lands, so
 * a space's owns skills become claimable on the space's NEXT session (there
 * is no live-session reload — documented, see architecture.md).
 *
 * The SDK does not validate skill frontmatter (it returns whatever `name` a
 * SKILL.md declares), so every write path validates here, fail closed.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadSkillsFromDir, type Skill } from "@oh-my-pi/pi-coding-agent";

/** Runtime root for per-space authored skills (gitignored via the `data/` rule). */
export const DEFAULT_SKILLS_ROOT = "data/skills";
/** Env override for the per-space skills root. */
export const SKILLS_ROOT_ENV = "BOTTEGA_SKILLS_DIR";
/** Env override for the committed built-in skills dir. */
export const BUILTIN_SKILLS_DIR_ENV = "BOTTEGA_BUILTIN_SKILLS_DIR";
/** Committed built-in skills root, relative to the repo (a fresh clone ships it). */
export const DEFAULT_BUILTIN_SKILLS_DIR = "skills";
/** The `source` label built-in skills carry (space skills carry `space:<spaceId>`). */
export const BUILTIN_SKILL_SOURCE = "builtin";

/** Skill-name charset (mirrors the SDK authoring rules): no path separators, no leading dot. */
export const SKILL_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export interface SkillsResolveOpts {
  /** Per-space skills root (default {@link DEFAULT_SKILLS_ROOT}, env `BOTTEGA_SKILLS_DIR`). */
  root?: string;
  /** Built-in skills dir (default `skills`, env `BOTTEGA_BUILTIN_SKILLS_DIR`). */
  builtinDir?: string;
  /** Bypass the in-process cache (used after a write and by tests). */
  reload?: boolean;
}

export function builtinSkillsDir(opts: SkillsResolveOpts = {}): string {
  return opts.builtinDir ?? process.env[BUILTIN_SKILLS_DIR_ENV] ?? DEFAULT_BUILTIN_SKILLS_DIR;
}

/** The per-space skill directory on disk: `<root>/<spaceId>` with one `<name>/SKILL.md` per skill. */
export function spaceSkillsDir(spaceId: string, opts: SkillsResolveOpts = {}): string {
  return join(opts.root ?? process.env[SKILLS_ROOT_ENV] ?? DEFAULT_SKILLS_ROOT, spaceId);
}

const spaceCache = new Map<string, Skill[]>();
const builtinCache = new Map<string, Skill[]>();

/** Invalidate the in-process cache for one space (the write tool calls this after every write). */
export function bustSpaceSkillsCache(spaceId: string, opts: SkillsResolveOpts = {}): void {
  spaceCache.delete(spaceSkillsDir(spaceId, opts));
}

/** Invalidate the built-in skill cache (tests only). */
export function bustBuiltinSkillsCache(opts: SkillsResolveOpts = {}): void {
  builtinCache.delete(builtinSkillsDir(opts));
}

/**
 * A space's authored skills, loaded from its dir and cached in-process until
 * a write busts the cache. A missing dir (no skills yet) resolves to an
 * empty list — never an error, and never a create-on-read side effect.
 */
export async function resolveSpaceSkills(spaceId: string, opts: SkillsResolveOpts = {}): Promise<Skill[]> {
  const dir = spaceSkillsDir(spaceId, opts);
  if (!opts.reload && spaceCache.has(dir)) return spaceCache.get(dir)!;
  const { skills } = await loadSkillsFromDir({ dir, source: `space:${spaceId}` });
  spaceCache.set(dir, skills);
  return skills;
}

/** The committed built-in skills, loaded once per process (tests bust the cache with `reload`). */
export async function resolveBuiltinSkills(opts: SkillsResolveOpts = {}): Promise<Skill[]> {
  const dir = builtinSkillsDir(opts);
  if (!opts.reload && builtinCache.has(dir)) return builtinCache.get(dir)!;
  const { skills } = await loadSkillsFromDir({ dir, source: BUILTIN_SKILL_SOURCE });
  builtinCache.set(dir, skills);
  return skills;
}

/**
 * Resolve a work item's injected skills (Tier 3): `names` (the explicit
 * task-level set from `work_items.skills`) resolved against the space's
 * authored skills first, then the built-ins. Space-authored skills shadow
 * built-ins with the same name (a space can override `pr_review`). Unknown
 * names are skipped with a log, never an error — a task pin naming a skill
 * that no longer exists degrades to the other injected skills.
 */
export async function resolveWorkItemSkills(
  spaceId: string,
  names: readonly string[],
  opts: SkillsResolveOpts = {},
): Promise<Skill[]> {
  const [spaceSkills, builtinSkills] = await Promise.all([
    resolveSpaceSkills(spaceId, opts),
    resolveBuiltinSkills(opts),
  ]);
  const byName = new Map<string, Skill>();
  for (const skill of [...spaceSkills, ...builtinSkills]) {
    if (!byName.has(skill.name)) byName.set(skill.name, skill);
  }
  const out: Skill[] = [];
  for (const name of names) {
    const skill = byName.get(name);
    if (!skill) {
      console.log(`[skills] work item in space ${spaceId} pinned unknown skill '${name}' — skipped`);
      continue;
    }
    out.push(skill);
  }
  return out;
}

export interface SkillWriteInput {
  name: string;
  description: string;
  /** The skill's procedure body (markdown). May be empty. */
  body?: string;
  /** Optional trigger phrases surfaced in the frontmatter for the SDK's prompt assembly. */
  triggers?: string[];
}

/**
 * A skill's SKILL.md document: validated frontmatter (name + description)
 * followed by the procedure body. The SDK reads `name`/`description` from
 * here and resolves `skill://` reads against the skill's own directory, so
 * any files the body references must be placed next to SKILL.md.
 */
export function renderSkillDoc(input: { name: string; description: string; body?: string; triggers?: string[] }): string {
  const lines = ["---", `name: ${input.name}`, `description: ${input.description}`];
  if (input.triggers && input.triggers.length > 0) {
    lines.push("triggers:", ...input.triggers.map((t) => `  - "${t.replace(/"/g, '\\"')}"`));
  }
  const body = input.body ?? "";
  lines.push("---", "", body.trim());
  return lines.join("\n");
}

/**
 * Write a skill into a space's dir (Tier 1 governance path; the
 * `write_space_skill` tool is policy-gated before this runs). Validates fail
 * closed — an invalid name (path separators, leading dot) or an empty
 * description is rejected before any file is touched. The write busts the
 * in-process cache so the space's NEXT session claims the new skill.
 *
 * @throws {Error} on validation failure or filesystem error.
 */
export async function writeSpaceSkill(
  spaceId: string,
  input: SkillWriteInput,
  opts: SkillsResolveOpts = {},
): Promise<{ name: string; path: string }> {
  const name = input.name.trim();
  if (!SKILL_NAME_RE.test(name)) {
    throw new Error(
      `invalid skill name '${input.name}': must match ${SKILL_NAME_RE.source} (letters, digits, '.', '_', '-'; no separators)`,
    );
  }
  const description = input.description.trim();
  if (!description) {
    throw new Error("skill description must be a non-empty string (the space agent claims skills by name + description)");
  }
  const dir = spaceSkillsDir(spaceId, opts);
  const path = join(dir, name, "SKILL.md");
  // mkdir parents: the space dir does not exist until its first skill write.
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(path, renderSkillDoc({ name, description, body: input.body, triggers: input.triggers }), "utf8");
  bustSpaceSkillsCache(spaceId, opts);
  return { name, path };
}
