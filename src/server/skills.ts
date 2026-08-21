
/**
 * Tiered skill loading plus the bounded, revisioned per-space lifecycle.
 *
 * Space mutations replace one whole skill directory. Companion paths are
 * validated before disk access, writes stage beside the destination, and a
 * failed commit restores the prior directory. Session skill arrays remain
 * immutable snapshots; successful mutations only invalidate the cache used
 * by the next session.
 */
import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Skill } from "@oh-my-pi/pi-coding-agent";

export const DEFAULT_SKILLS_ROOT = "data/skills";
export const SKILLS_ROOT_ENV = "BOTTEGA_SKILLS_DIR";
export const BUILTIN_SKILLS_DIR_ENV = "BOTTEGA_BUILTIN_SKILLS_DIR";
export const DEFAULT_BUILTIN_SKILLS_DIR = "skills";
export const BUILTIN_SKILL_SOURCE = "builtin";
export const SKILL_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/** Hard limits apply at both the tool schema and this filesystem boundary. */
export const MAX_SKILL_DOCUMENT_BYTES = 64 * 1024;
export const MAX_COMPANION_FILE_BYTES = 256 * 1024;
export const MAX_SKILL_TOTAL_BYTES = 1024 * 1024;
export const MAX_COMPANION_FILES = 32;
export const MAX_COMPANION_PATH_BYTES = 240;
export const MAX_COMPANION_PATH_DEPTH = 8;

const MANIFEST_FILE = ".bottega-skill.json";
const MANIFEST_SCHEMA = "bottega.space-skill.v1";
const SPACE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9:._-]*$/;

export interface SkillsResolveOpts {
  root?: string;
  builtinDir?: string;
  reload?: boolean;
  /** Hermetic failure seam used to prove rollback after the old tree moves. */
  mutationHook?: (stage: "before-commit" | "after-backup") => void;
}

export type CompanionFileInput =
  | string
  | Uint8Array
  | { encoding: "text"; content: string }
  | { encoding: "base64"; content: string };
export type CompanionFileOutput =
  | { encoding: "text"; content: string }
  | { encoding: "base64"; content: string };

export interface SkillMutationInput {
  name: string;
  document: string;
  companionFiles?: Record<string, CompanionFileInput>;
}

export interface SkillSummary {
  name: string;
  description: string;
  source_tier: "space" | "builtin";
  source: string;
  revision: string;
  companion_files: string[];
  shadows: Array<"builtin">;
}

export interface SkillDetail {
  name: string;
  description: string;
  source_tier: "space" | "builtin";
  source: string;
  revision: string;
  document: string;
  companion_files: Record<string, CompanionFileOutput>;
}

export interface SkillGetResult {
  skill: SkillDetail;
  shadowed: SkillSummary[];
}

interface FileEntry {
  path: string;
  bytes: Uint8Array;
  size: number;
  sha256: string;
}

interface StoredSkill {
  name: string;
  description: string;
  tier: "space" | "builtin";
  source: string;
  baseDir: string;
  revision: string;
  document: string;
  files: FileEntry[];
}

interface PreparedSkill {
  name: string;
  description: string;
  documentBytes: Uint8Array;
  documentSha256: string;
  files: FileEntry[];
  revision: string;
}

interface StoredManifest {
  schema: typeof MANIFEST_SCHEMA;
  revision: string;
  document_sha256: string;
  files: Array<{ path: string; size: number; sha256: string }>;
}

const spaceCache = new Map<string, Skill[]>();
const builtinCache = new Map<string, Skill[]>();

function hashBytes(bytes: Uint8Array): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(bytes);
  return hasher.digest("hex");
}

function contentRevision(documentBytes: Uint8Array, files: readonly FileEntry[]): string {
  const hasher = new Bun.CryptoHasher("sha256");
  const add = (label: string, bytes: Uint8Array): void => {
    hasher.update(`${Buffer.byteLength(label, "utf8")}:${label}:${bytes.byteLength}:`);
    hasher.update(bytes);
  };
  add("SKILL.md", documentBytes);
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) add(file.path, file.bytes);
  return hasher.digest("hex");
}

function assertSkillName(raw: string): string {
  const name = raw.trim();
  if (!SKILL_NAME_RE.test(name)) {
    throw new Error(`invalid skill name '${raw}': must match ${SKILL_NAME_RE.source}`);
  }
  return name;
}

function assertSpaceId(spaceId: string): void {
  if (!SPACE_ID_RE.test(spaceId) || spaceId === "." || spaceId === "..") {
    throw new Error("invalid space id");
  }
}

function rootDir(opts: SkillsResolveOpts): string {
  return resolve(opts.root ?? process.env[SKILLS_ROOT_ENV] ?? DEFAULT_SKILLS_ROOT);
}

export function builtinSkillsDir(opts: SkillsResolveOpts = {}): string {
  return resolve(opts.builtinDir ?? process.env[BUILTIN_SKILLS_DIR_ENV] ?? DEFAULT_BUILTIN_SKILLS_DIR);
}

function assertNotSymlink(path: string, label: string): void {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new Error(`${label} must not be a symlink`);
}

function assertDirectory(path: string, label: string): void {
  assertNotSymlink(path, label);
  if (!lstatSync(path).isDirectory()) throw new Error(`${label} must be a directory`);
}

export function spaceSkillsDir(spaceId: string, opts: SkillsResolveOpts = {}): string {
  assertSpaceId(spaceId);
  const root = rootDir(opts);
  assertNotSymlink(root, "configured skills root");
  const dir = resolve(root, spaceId);
  const rel = relative(root, dir);
  if (rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) throw new Error("space skills path escapes configured root");
  assertNotSymlink(dir, "space skills root");
  return dir;
}

function decodeYamlScalar(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === "string") return parsed;
    } catch {
      throw new Error("skill frontmatter contains an invalid quoted scalar");
    }
  }
  return trimmed;
}

function parseSkillDocument(name: string, document: string): string {
  const bytes = Buffer.byteLength(document, "utf8");
  if (bytes > MAX_SKILL_DOCUMENT_BYTES) {
    throw new Error(`SKILL.md exceeds ${MAX_SKILL_DOCUMENT_BYTES} bytes`);
  }
  if (document.includes("\0")) throw new Error("SKILL.md must not contain NUL bytes");
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(document);
  if (!match) throw new Error("SKILL.md must start with YAML frontmatter bounded by --- lines");
  const names: string[] = [];
  const descriptions: string[] = [];
  for (const line of match[1]!.split(/\r?\n/)) {
    if (line.startsWith("name:")) names.push(decodeYamlScalar(line.slice(5)));
    if (line.startsWith("description:")) descriptions.push(decodeYamlScalar(line.slice(12)));
  }
  if (names.length !== 1 || names[0] !== name) throw new Error("SKILL.md frontmatter name must exactly match the requested skill name");
  if (descriptions.length !== 1 || descriptions[0]!.trim() === "") {
    throw new Error("SKILL.md frontmatter description must be a non-empty one-line string");
  }
  return descriptions[0]!.trim();
}

export function validateCompanionPath(path: string): string {
  if (path === "" || isAbsolute(path) || path.includes("\\") || path.includes("\0")) {
    throw new Error(`invalid companion path '${path}': expected a relative POSIX path`);
  }
  if (Buffer.byteLength(path, "utf8") > MAX_COMPANION_PATH_BYTES) throw new Error(`companion path '${path}' is too long`);
  const parts = path.split("/");
  if (parts.length > MAX_COMPANION_PATH_DEPTH) throw new Error(`companion path '${path}' is too deep`);
  if (parts.some((part) => part === "" || part === "." || part === ".." || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(part))) {
    throw new Error(`invalid companion path '${path}': empty, dot, hidden, and traversal segments are forbidden`);
  }
  const leaf = basename(path).toLowerCase();
  if (leaf === "skill.md" || leaf === MANIFEST_FILE.toLowerCase()) throw new Error(`companion path '${path}' is reserved`);
  return parts.join("/");
}

function decodeCompanion(value: CompanionFileInput, path: string): Uint8Array {
  if (typeof value === "string") return Buffer.from(value, "utf8");
  if (value instanceof Uint8Array) return value;
  if (value.encoding === "text") return Buffer.from(value.content, "utf8");
  const encoded = value.content;
  if (encoded.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new Error(`companion file '${path}' has invalid base64 content`);
  }
  return Buffer.from(encoded, "base64");
}

function prepareSkill(input: SkillMutationInput): PreparedSkill {
  const name = assertSkillName(input.name);
  const description = parseSkillDocument(name, input.document);
  const documentBytes = Buffer.from(input.document, "utf8");
  const companion = input.companionFiles ?? {};
  const paths = Object.keys(companion);
  if (paths.length > MAX_COMPANION_FILES) throw new Error(`a skill may contain at most ${MAX_COMPANION_FILES} companion files`);
  const files = paths.map((rawPath): FileEntry => {
    const path = validateCompanionPath(rawPath);
    const bytes = decodeCompanion(companion[rawPath]!, path);
    if (bytes.byteLength > MAX_COMPANION_FILE_BYTES) {
      throw new Error(`companion file '${path}' exceeds ${MAX_COMPANION_FILE_BYTES} bytes`);
    }
    return { path, bytes, size: bytes.byteLength, sha256: hashBytes(bytes) };
  });
  files.sort((a, b) => a.path.localeCompare(b.path));
  const total = documentBytes.byteLength + files.reduce((sum, file) => sum + file.size, 0);
  if (total > MAX_SKILL_TOTAL_BYTES) throw new Error(`skill content exceeds ${MAX_SKILL_TOTAL_BYTES} total bytes`);
  return {
    name,
    description,
    documentBytes,
    documentSha256: hashBytes(documentBytes),
    files,
    revision: contentRevision(documentBytes, files),
  };
}

function manifestFor(skill: PreparedSkill): StoredManifest {
  return {
    schema: MANIFEST_SCHEMA,
    revision: skill.revision,
    document_sha256: skill.documentSha256,
    files: skill.files.map(({ path, size, sha256 }) => ({ path, size, sha256 })),
  };
}

function writePreparedSkill(dir: string, skill: PreparedSkill): void {
  writeFileSync(join(dir, "SKILL.md"), skill.documentBytes, { flag: "wx" });
  for (const file of skill.files) {
    const target = resolve(dir, file.path);
    const rel = relative(dir, target);
    if (rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) throw new Error("companion path escapes staged skill directory");
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.bytes, { flag: "wx" });
  }
  writeFileSync(join(dir, MANIFEST_FILE), `${JSON.stringify(manifestFor(skill))}\n`, { flag: "wx" });
}

function walkSkillFiles(dir: string, prefix = ""): Array<{ path: string; bytes: Uint8Array }> {
  const out: Array<{ path: string; bytes: Uint8Array }> = [];
  for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = join(dir, path);
    if (entry.isSymbolicLink()) throw new Error(`skill contains forbidden symlink '${path}'`);
    if (entry.isDirectory()) {
      if (path.split("/").length > MAX_COMPANION_PATH_DEPTH) throw new Error(`skill directory '${path}' is too deep`);
      out.push(...walkSkillFiles(dir, path));
      continue;
    }
    if (!entry.isFile()) throw new Error(`skill contains unsupported filesystem entry '${path}'`);
    out.push({ path, bytes: readFileSync(absolute) });
  }
  return out;
}

function parseStoredManifest(bytes: Uint8Array): StoredManifest {
  if (bytes.byteLength > MAX_SKILL_DOCUMENT_BYTES) throw new Error("skill metadata is oversized");
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    throw new Error("skill metadata is invalid JSON");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("skill metadata is invalid");
  const record = value as Record<string, unknown>;
  if (record.schema !== MANIFEST_SCHEMA || typeof record.revision !== "string" || typeof record.document_sha256 !== "string" || !Array.isArray(record.files)) {
    throw new Error("skill metadata is invalid");
  }
  const files = record.files.map((item) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) throw new Error("skill metadata file entry is invalid");
    const file = item as Record<string, unknown>;
    if (typeof file.path !== "string" || typeof file.size !== "number" || typeof file.sha256 !== "string") {
      throw new Error("skill metadata file entry is invalid");
    }
    return { path: validateCompanionPath(file.path), size: file.size, sha256: file.sha256 };
  });
  return {
    schema: MANIFEST_SCHEMA,
    revision: record.revision,
    document_sha256: record.document_sha256,
    files,
  };
}

function readStoredSkill(dir: string, name: string, tier: "space" | "builtin", source: string): StoredSkill {
  assertDirectory(dir, `${tier} skill '${name}'`);
  const entries = walkSkillFiles(dir);
  const documentEntry = entries.find((entry) => entry.path === "SKILL.md");
  if (!documentEntry) throw new Error(`skill '${name}' is missing SKILL.md`);
  const document = Buffer.from(documentEntry.bytes).toString("utf8");
  const description = parseSkillDocument(name, document);
  const companions = entries
    .filter((entry) => entry.path !== "SKILL.md" && entry.path !== MANIFEST_FILE)
    .map(({ path, bytes }): FileEntry => {
      validateCompanionPath(path);
      if (bytes.byteLength > MAX_COMPANION_FILE_BYTES) throw new Error(`companion file '${path}' exceeds ${MAX_COMPANION_FILE_BYTES} bytes`);
      return { path, bytes, size: bytes.byteLength, sha256: hashBytes(bytes) };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
  if (companions.length > MAX_COMPANION_FILES) throw new Error(`skill '${name}' has too many companion files`);
  const total = documentEntry.bytes.byteLength + companions.reduce((sum, file) => sum + file.size, 0);
  if (total > MAX_SKILL_TOTAL_BYTES) throw new Error(`skill '${name}' exceeds ${MAX_SKILL_TOTAL_BYTES} total bytes`);
  const revision = contentRevision(documentEntry.bytes, companions);
  const manifestEntry = entries.find((entry) => entry.path === MANIFEST_FILE);
  if (manifestEntry) {
    const manifest = parseStoredManifest(manifestEntry.bytes);
    const actualFiles = companions.map(({ path, size, sha256 }) => ({ path, size, sha256 }));
    if (
      manifest.revision !== revision ||
      manifest.document_sha256 !== hashBytes(documentEntry.bytes) ||
      JSON.stringify(manifest.files) !== JSON.stringify(actualFiles)
    ) {
      throw new Error(`skill '${name}' contains undeclared, missing, or modified files`);
    }
  }
  return { name, description, tier, source, baseDir: dir, revision, document, files: companions };
}

function readTier(dir: string, tier: "space" | "builtin", source: string): StoredSkill[] {
  if (!existsSync(dir)) return [];
  assertDirectory(dir, `${tier} skills root`);
  const skills: StoredSkill[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".txn-") || entry.name.startsWith(".backup-")) continue;
    if (entry.isSymbolicLink()) throw new Error(`${tier} skill '${entry.name}' must not be a symlink`);
    if (!entry.isDirectory()) throw new Error(`${tier} skills root contains unsupported entry '${entry.name}'`);
    const name = assertSkillName(entry.name);
    skills.push(readStoredSkill(join(dir, name), name, tier, source));
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

function summary(skill: StoredSkill, shadows: Array<"builtin"> = []): SkillSummary {
  return {
    name: skill.name,
    description: skill.description,
    source_tier: skill.tier,
    source: skill.source,
    revision: skill.revision,
    companion_files: skill.files.map((file) => file.path),
    shadows,
  };
}

function outputCompanion(file: FileEntry): CompanionFileOutput {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
    if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(text)) {
      return { encoding: "base64", content: Buffer.from(file.bytes).toString("base64") };
    }
    return { encoding: "text", content: text };
  } catch {
    return { encoding: "base64", content: Buffer.from(file.bytes).toString("base64") };
  }
}

function detail(skill: StoredSkill): SkillDetail {
  return {
    name: skill.name,
    description: skill.description,
    source_tier: skill.tier,
    source: skill.source,
    revision: skill.revision,
    document: skill.document,
    companion_files: Object.fromEntries(skill.files.map((file) => [file.path, outputCompanion(file)])),
  };
}

function tierRecords(spaceId: string, opts: SkillsResolveOpts): { space: StoredSkill[]; builtin: StoredSkill[] } {
  const space = readTier(spaceSkillsDir(spaceId, opts), "space", `space:${spaceId}`);
  const builtin = readTier(builtinSkillsDir(opts), "builtin", BUILTIN_SKILL_SOURCE);
  return { space, builtin };
}

function loadedSkill(skill: StoredSkill): Skill {
  return {
    name: skill.name,
    description: skill.description,
    filePath: join(skill.baseDir, "SKILL.md"),
    baseDir: skill.baseDir,
    source: skill.source,
  };
}

export function bustSpaceSkillsCache(spaceId: string, opts: SkillsResolveOpts = {}): void {
  spaceCache.delete(spaceSkillsDir(spaceId, opts));
}

export function bustBuiltinSkillsCache(opts: SkillsResolveOpts = {}): void {
  builtinCache.delete(builtinSkillsDir(opts));
}

export async function resolveSpaceSkills(spaceId: string, opts: SkillsResolveOpts = {}): Promise<Skill[]> {
  const dir = spaceSkillsDir(spaceId, opts);
  if (!opts.reload && spaceCache.has(dir)) return spaceCache.get(dir)!;
  const skills = readTier(dir, "space", `space:${spaceId}`).map(loadedSkill);
  spaceCache.set(dir, skills);
  return skills;
}

export async function resolveBuiltinSkills(opts: SkillsResolveOpts = {}): Promise<Skill[]> {
  const dir = builtinSkillsDir(opts);
  if (!opts.reload && builtinCache.has(dir)) return builtinCache.get(dir)!;
  const skills = readTier(dir, "builtin", BUILTIN_SKILL_SOURCE).map(loadedSkill);
  builtinCache.set(dir, skills);
  return skills;
}

export async function resolveWorkItemSkills(spaceId: string, names: readonly string[], opts: SkillsResolveOpts = {}): Promise<Skill[]> {
  const [spaceSkills, builtinSkills] = await Promise.all([resolveSpaceSkills(spaceId, opts), resolveBuiltinSkills(opts)]);
  const byName = new Map<string, Skill>();
  for (const skill of [...spaceSkills, ...builtinSkills]) if (!byName.has(skill.name)) byName.set(skill.name, skill);
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

export async function listSpaceSkills(spaceId: string, opts: SkillsResolveOpts = {}): Promise<SkillSummary[]> {
  const { space, builtin } = tierRecords(spaceId, opts);
  const builtinNames = new Set(builtin.map((skill) => skill.name));
  const spaceNames = new Set(space.map((skill) => skill.name));
  return [
    ...space.map((skill) => summary(skill, builtinNames.has(skill.name) ? ["builtin"] : [])),
    ...builtin.filter((skill) => !spaceNames.has(skill.name)).map((skill) => summary(skill)),
  ].sort((a, b) => a.name.localeCompare(b.name));
}

export async function getSpaceSkill(spaceId: string, nameInput: string, opts: SkillsResolveOpts = {}): Promise<SkillGetResult> {
  const name = assertSkillName(nameInput);
  const { space, builtin } = tierRecords(spaceId, opts);
  const spaceSkill = space.find((skill) => skill.name === name);
  const builtinSkill = builtin.find((skill) => skill.name === name);
  const active = spaceSkill ?? builtinSkill;
  if (!active) throw new Error(`skill '${name}' was not found`);
  return {
    skill: detail(active),
    shadowed: spaceSkill && builtinSkill ? [summary(builtinSkill)] : [],
  };
}

function ensureMutationRoot(spaceId: string, opts: SkillsResolveOpts): string {
  const root = rootDir(opts);
  mkdirSync(root, { recursive: true });
  assertDirectory(root, "configured skills root");
  const spaceDir = spaceSkillsDir(spaceId, opts);
  if (existsSync(spaceDir)) assertDirectory(spaceDir, "space skills root");
  else mkdirSync(spaceDir, { recursive: false });
  return spaceDir;
}

function cleanup(path: string): void {
  if (existsSync(path)) rmSync(path, { recursive: true, force: true });
}

export async function createSpaceSkill(spaceId: string, input: SkillMutationInput, opts: SkillsResolveOpts = {}): Promise<SkillSummary> {
  const prepared = prepareSkill(input);
  const spaceDir = ensureMutationRoot(spaceId, opts);
  const target = join(spaceDir, prepared.name);
  if (existsSync(target)) {
    assertNotSymlink(target, `space skill '${prepared.name}'`);
    throw new Error(`space skill '${prepared.name}' already exists; use update_space_skill with its expected revision`);
  }
  const stage = mkdtempSync(join(spaceDir, ".txn-"));
  try {
    writePreparedSkill(stage, prepared);
    opts.mutationHook?.("before-commit");
    renameSync(stage, target);
  } catch (error) {
    cleanup(stage);
    throw error;
  }
  bustSpaceSkillsCache(spaceId, opts);
  return summary(readStoredSkill(target, prepared.name, "space", `space:${spaceId}`));
}

export async function updateSpaceSkill(
  spaceId: string,
  input: SkillMutationInput & { expectedRevision: string },
  opts: SkillsResolveOpts = {},
): Promise<{ previous_revision: string; skill: SkillSummary }> {
  const prepared = prepareSkill(input);
  const spaceDir = ensureMutationRoot(spaceId, opts);
  const target = join(spaceDir, prepared.name);
  if (!existsSync(target)) throw new Error(`space skill '${prepared.name}' was not found`);
  const previous = readStoredSkill(target, prepared.name, "space", `space:${spaceId}`);
  if (previous.revision !== input.expectedRevision) {
    throw new Error(`stale skill revision for '${prepared.name}': expected ${input.expectedRevision}, current ${previous.revision}`);
  }
  const stage = mkdtempSync(join(spaceDir, ".txn-"));
  const backup = join(spaceDir, `.backup-${prepared.name}-${randomUUID()}`);
  let oldMoved = false;
  let newMoved = false;
  try {
    writePreparedSkill(stage, prepared);
    opts.mutationHook?.("before-commit");
    renameSync(target, backup);
    oldMoved = true;
    opts.mutationHook?.("after-backup");
    renameSync(stage, target);
    newMoved = true;
    rmSync(backup, { recursive: true });
  } catch (error) {
    try {
      if (newMoved) {
        const failed = `${stage}-failed`;
        renameSync(target, failed);
        renameSync(backup, target);
        cleanup(failed);
      } else if (oldMoved) {
        renameSync(backup, target);
      }
    } finally {
      cleanup(stage);
      cleanup(backup);
    }
    throw error;
  }
  bustSpaceSkillsCache(spaceId, opts);
  return {
    previous_revision: previous.revision,
    skill: summary(readStoredSkill(target, prepared.name, "space", `space:${spaceId}`)),
  };
}

export async function deleteSpaceSkill(
  spaceId: string,
  nameInput: string,
  expectedRevision: string,
  opts: SkillsResolveOpts = {},
): Promise<{ deleted: SkillSummary; revealed?: SkillSummary }> {
  const name = assertSkillName(nameInput);
  const spaceDir = spaceSkillsDir(spaceId, opts);
  const target = join(spaceDir, name);
  if (!existsSync(target)) throw new Error(`space skill '${name}' was not found in the space tier`);
  const previous = readStoredSkill(target, name, "space", `space:${spaceId}`);
  if (previous.revision !== expectedRevision) {
    throw new Error(`stale skill revision for '${name}': expected ${expectedRevision}, current ${previous.revision}`);
  }
  const backup = join(spaceDir, `.backup-${name}-${randomUUID()}`);
  renameSync(target, backup);
  try {
    opts.mutationHook?.("after-backup");
    rmSync(backup, { recursive: true });
  } catch (error) {
    if (existsSync(backup) && !existsSync(target)) renameSync(backup, target);
    throw error;
  }
  bustSpaceSkillsCache(spaceId, opts);
  const builtin = readTier(builtinSkillsDir(opts), "builtin", BUILTIN_SKILL_SOURCE).find((skill) => skill.name === name);
  return { deleted: summary(previous), ...(builtin ? { revealed: summary(builtin) } : undefined) };
}
