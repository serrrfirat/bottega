import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";
import { createAudit } from "../policy/audit";
import { WORKSPACE_PURGE_EVENT } from "../store/audit-events";
import type { Store } from "../store/db";

export const WORKSPACE_MARKER_FILE = "bottega-workspace.json";

const workspaceMarkerSchema = z
  .object({
    schemaVersion: z.literal(1),
    owner: z.literal("bottega-executor"),
    workItemId: z.string().min(1),
    repository: z.string().min(1),
    creationId: z.uuid(),
    createdAt: z.number().int().nonnegative(),
  })
  .strict();

/** Shared deployment default used by the executor and the operator purge command. */
export function defaultWorkspaceRoot(): string {
  return existsSync("/workspaces") ? "/workspaces" : "data/workspaces";
}
export type WorkspaceMarker = z.infer<typeof workspaceMarkerSchema>;

/** Returns null only when the path does not exist. Dangling symlinks still return their link stat. */
function lstatIfPresent(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") return null;
    throw err;
  }
}

function authorityError(workspace: string, reason: string): Error {
  return new Error(`workspace authority rejected "${workspace}": ${reason}`);
}

/**
 * The only component allowed to replace or remove executor Git workspaces.
 * A path convention is never authority: the canonical direct-child path and
 * the marker under the clone's private .git directory must both match.
 */
export class WorkspaceLifecycle {
  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  /** Derives one lexical direct child without touching the filesystem. */
  workspacePath(itemId: string): string {
    if (itemId.length === 0 || basename(itemId) !== itemId || itemId === "." || itemId === "..") {
      throw authorityError(this.root, `work item id "${itemId}" does not name a direct child`);
    }
    const workspace = resolve(this.root, itemId);
    if (dirname(workspace) !== this.root) {
      throw authorityError(workspace, "path is not a direct child of the configured workspace root");
    }
    return workspace;
  }

  /**
   * Creates a checkout through the caller's Git seam, then immediately
   * establishes marker authority before later setup or agent work can fail.
   */
  async create(
    itemId: string,
    repository: string,
    createCheckout: (workspace: string) => Promise<void>,
  ): Promise<string> {
    const workspace = this.prepareForClone(itemId, repository);
    await createCheckout(workspace);
    this.markCreated(itemId, repository);
    return workspace;
  }

  /**
   * Returns the exact clone destination. A prior checkout is removed only
   * after full path and marker validation for this same item and repository.
   */
  prepareForClone(itemId: string, repository: string): string {
    const workspace = this.workspacePath(itemId);
    if (lstatIfPresent(workspace) === null) {
      this.ensureCanonicalRoot();
      return workspace;
    }
    this.validateOwned(workspace, itemId, repository);
    rmSync(workspace, { recursive: true, force: false });
    return workspace;
  }

  /** Writes the marker immediately after clone, before any further Git/session work. */
  markCreated(itemId: string, repository: string): WorkspaceMarker {
    const workspace = this.workspacePath(itemId);
    const canonicalRoot = this.ensureCanonicalRoot();
    const canonicalWorkspace = this.validateWorkspaceDirectory(workspace, canonicalRoot);
    const gitDir = join(workspace, ".git");
    const gitStat = lstatIfPresent(gitDir);
    if (gitStat === null) throw authorityError(workspace, "clone has no .git directory");
    if (gitStat.isSymbolicLink()) throw authorityError(workspace, ".git is a symbolic link");
    if (!gitStat.isDirectory()) throw authorityError(workspace, ".git is not a directory");
    const canonicalGitDir = realpathSync(gitDir);
    if (dirname(canonicalGitDir) !== canonicalWorkspace) {
      throw authorityError(workspace, ".git escapes the workspace");
    }

    const marker: WorkspaceMarker = {
      schemaVersion: 1,
      owner: "bottega-executor",
      workItemId: itemId,
      repository,
      creationId: randomUUID(),
      createdAt: Date.now(),
    };
    writeFileSync(join(gitDir, WORKSPACE_MARKER_FILE), `${JSON.stringify(marker)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    return marker;
  }

  /** Removes one exact owned workspace. Missing or uncertain authority is an error. */
  removeOwned(itemId: string, repository: string): void {
    const workspace = this.workspacePath(itemId);
    this.validateOwned(workspace, itemId, repository);
    rmSync(workspace, { recursive: true, force: false });
  }

  private ensureCanonicalRoot(): string {
    mkdirSync(this.root, { recursive: true });
    const rootStat = lstatSync(this.root);
    if (rootStat.isSymbolicLink()) throw authorityError(this.root, "configured workspace root is a symbolic link");
    if (!rootStat.isDirectory()) throw authorityError(this.root, "configured workspace root is not a directory");
    return realpathSync(this.root);
  }

  private validateWorkspaceDirectory(workspace: string, canonicalRoot: string): string {
    const workspaceStat = lstatIfPresent(workspace);
    if (workspaceStat === null) throw authorityError(workspace, "workspace does not exist");
    if (workspaceStat.isSymbolicLink()) throw authorityError(workspace, "workspace is a symbolic link");
    if (!workspaceStat.isDirectory()) throw authorityError(workspace, "workspace is not a directory");
    const canonicalWorkspace = realpathSync(workspace);
    if (dirname(canonicalWorkspace) !== canonicalRoot) {
      throw authorityError(workspace, "canonical path is not a direct child of the configured workspace root");
    }
    return canonicalWorkspace;
  }

  private validateOwned(workspace: string, itemId: string, repository: string): WorkspaceMarker {
    const canonicalRoot = this.ensureCanonicalRoot();
    const canonicalWorkspace = this.validateWorkspaceDirectory(workspace, canonicalRoot);
    const gitDir = join(workspace, ".git");
    const gitStat = lstatIfPresent(gitDir);
    if (gitStat === null) throw authorityError(workspace, "ownership marker is missing (.git directory absent)");
    if (gitStat.isSymbolicLink()) throw authorityError(workspace, ".git is a symbolic link");
    if (!gitStat.isDirectory()) throw authorityError(workspace, ".git is not a directory");
    const canonicalGitDir = realpathSync(gitDir);
    if (dirname(canonicalGitDir) !== canonicalWorkspace) {
      throw authorityError(workspace, ".git escapes the workspace");
    }

    const markerPath = join(gitDir, WORKSPACE_MARKER_FILE);
    const markerStat = lstatIfPresent(markerPath);
    if (markerStat === null) throw authorityError(workspace, `ownership marker ${WORKSPACE_MARKER_FILE} is missing`);
    if (markerStat.isSymbolicLink()) throw authorityError(workspace, "ownership marker is a symbolic link");
    if (!markerStat.isFile()) throw authorityError(workspace, "ownership marker is not a regular file");
    if (dirname(realpathSync(markerPath)) !== canonicalGitDir) {
      throw authorityError(workspace, "ownership marker escapes the workspace");
    }

    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(markerPath, "utf8"));
    } catch {
      throw authorityError(workspace, "ownership marker is invalid JSON");
    }
    const parsed = workspaceMarkerSchema.safeParse(raw);
    if (!parsed.success) throw authorityError(workspace, "ownership marker has an invalid schema");
    if (parsed.data.workItemId !== itemId) {
      throw authorityError(workspace, `marker work item ${parsed.data.workItemId} does not match ${itemId}`);
    }
    if (parsed.data.repository !== repository) {
      throw authorityError(
        workspace,
        `marker repository ${parsed.data.repository} does not match requested repository ${repository}`,
      );
    }
    return parsed.data;
  }
}

export interface PurgeRetainedWorkspaceResult {
  itemId: string;
  workspace: string;
  removed: true;
}

/**
 * Explicit operator-only purge. Database state is checked before filesystem
 * authority, and every refusal/request/result is redacted into the audit trail.
 * There is intentionally no directory scan or automatic age-based deletion.
 */
export async function purgeRetainedWorkspace(opts: {
  store: Store;
  workspacesDir: string;
  itemId: string;
  actor: string;
}): Promise<PurgeRetainedWorkspaceResult> {
  const actor = opts.actor.trim();
  if (actor.length === 0) throw new Error("workspace purge requires a non-empty operator actor");
  const audit = createAudit(opts.store);
  const lifecycle = new WorkspaceLifecycle(opts.workspacesDir);
  const item = await opts.store.getWorkItem(opts.itemId);
  if (item === null) {
    const reason = "database authority has no matching work item";
    await audit.appendAudit({
      actor,
      event_type: WORKSPACE_PURGE_EVENT,
      payload: { id: opts.itemId, workspace: lifecycle.root, decision: "refused", reason },
    });
    throw new Error(`workspace purge refused for ${opts.itemId}: ${reason}`);
  }

  const candidateWorkspace = join(lifecycle.root, item.id);
  if (item.state !== "blocked") {
    const reason = `database item is in state ${item.state}; only blocked items may be purged`;
    await audit.appendAudit({
      space_id: item.space_id,
      actor,
      event_type: WORKSPACE_PURGE_EVENT,
      payload: { id: item.id, workspace: candidateWorkspace, decision: "refused", reason },
    });
    throw new Error(`workspace purge refused for ${item.id}: ${reason}`);
  }
  if (item.repo === null) {
    const reason = "database item has no repository authority";
    await audit.appendAudit({
      space_id: item.space_id,
      actor,
      event_type: WORKSPACE_PURGE_EVENT,
      payload: { id: item.id, workspace: candidateWorkspace, decision: "refused", reason },
    });
    throw new Error(`workspace purge refused for ${item.id}: ${reason}`);
  }

  let workspace: string;
  try {
    workspace = lifecycle.workspacePath(item.id);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await audit.appendAudit({
      space_id: item.space_id,
      actor,
      event_type: WORKSPACE_PURGE_EVENT,
      payload: { id: item.id, workspace: candidateWorkspace, decision: "refused", reason },
    });
    throw err;
  }
  await audit.appendAudit({
    space_id: item.space_id,
    actor,
    event_type: WORKSPACE_PURGE_EVENT,
    payload: { id: item.id, workspace, decision: "requested" },
  });
  try {
    lifecycle.removeOwned(item.id, item.repo);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await audit.appendAudit({
      space_id: item.space_id,
      actor,
      event_type: WORKSPACE_PURGE_EVENT,
      payload: { id: item.id, workspace, decision: "refused", reason },
    });
    throw err;
  }
  await audit.appendAudit({
    space_id: item.space_id,
    actor,
    event_type: WORKSPACE_PURGE_EVENT,
    payload: { id: item.id, workspace, decision: "removed" },
  });
  return { itemId: item.id, workspace, removed: true };
}
