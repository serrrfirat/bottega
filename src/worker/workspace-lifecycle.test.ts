import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../store/db";
import { WORKSPACE_PURGE_EVENT } from "../store/audit-events";
import {
  WORKSPACE_MARKER_FILE,
  WorkspaceLifecycle,
  purgeRetainedWorkspace,
} from "./workspace-lifecycle";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "bottega-workspace-lifecycle-"));
  const root = join(dir, "workspaces");
  const lifecycle = new WorkspaceLifecycle(root);
  return {
    dir,
    root,
    lifecycle,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function makeOwnedWorkspace(lifecycle: WorkspaceLifecycle, itemId: string, repository: string): string {
  const workspace = lifecycle.prepareForClone(itemId, repository);
  mkdirSync(join(workspace, ".git"), { recursive: true });
  lifecycle.markCreated(itemId, repository);
  return workspace;
}

describe("WorkspaceLifecycle authority", () => {
  test("a matching marker authorizes retry replacement and records a secret-free creation identity", () => {
    const fx = fixture();
    try {
      const workspace = makeOwnedWorkspace(fx.lifecycle, "wi_retry", "acme/sandbox");
      writeFileSync(join(workspace, "forensics.txt"), "old failure");

      const marker = JSON.parse(readFileSync(join(workspace, ".git", WORKSPACE_MARKER_FILE), "utf8"));
      expect(marker).toMatchObject({
        schemaVersion: 1,
        owner: "bottega-executor",
        workItemId: "wi_retry",
        repository: "acme/sandbox",
        creationId: expect.any(String),
      });
      expect(JSON.stringify(marker)).not.toContain("token");
      expect(JSON.stringify(marker)).not.toContain("secret");

      expect(fx.lifecycle.prepareForClone("wi_retry", "acme/sandbox")).toBe(workspace);
      expect(existsSync(workspace)).toBe(false);
    } finally {
      fx.cleanup();
    }
  });

  test("mismatched, unmarked, symlinked, escaped, and foreign paths remain untouched", () => {
    const fx = fixture();
    try {
      const mismatched = makeOwnedWorkspace(fx.lifecycle, "wi_mismatch", "acme/sandbox");
      writeFileSync(join(mismatched, "sentinel"), "keep");
      expect(() => fx.lifecycle.prepareForClone("wi_mismatch", "acme/tooling")).toThrow(/repository.*does not match/i);
      expect(readFileSync(join(mismatched, "sentinel"), "utf8")).toBe("keep");

      const unmarked = join(fx.root, "wi_unmarked");
      mkdirSync(unmarked, { recursive: true });
      writeFileSync(join(unmarked, "sentinel"), "keep");
      expect(() => fx.lifecycle.prepareForClone("wi_unmarked", "acme/sandbox")).toThrow(/marker.*missing/i);
      expect(readFileSync(join(unmarked, "sentinel"), "utf8")).toBe("keep");

      const outside = join(fx.dir, "outside");
      mkdirSync(outside, { recursive: true });
      writeFileSync(join(outside, "sentinel"), "keep");
      symlinkSync(outside, join(fx.root, "wi_link"));
      expect(() => fx.lifecycle.prepareForClone("wi_link", "acme/sandbox")).toThrow(/symbolic link/i);
      expect(readFileSync(join(outside, "sentinel"), "utf8")).toBe("keep");

      expect(() => fx.lifecycle.workspacePath("../outside")).toThrow(/direct child/i);
      expect(readFileSync(join(outside, "sentinel"), "utf8")).toBe("keep");

      const foreign = join(fx.root, "not-a-bottega-workspace");
      mkdirSync(foreign, { recursive: true });
      writeFileSync(join(foreign, "sentinel"), "keep");
      fx.lifecycle.removeOwned("wi_mismatch", "acme/sandbox");
      expect(readFileSync(join(foreign, "sentinel"), "utf8")).toBe("keep");
    } finally {
      fx.cleanup();
    }
  });
});

describe("purgeRetainedWorkspace", () => {
  test("removes only a blocked item with matching database and marker authority, and audits attempt and result", async () => {
    const fx = fixture();
    const store = createStore(join(fx.dir, "store.db"));
    try {
      const space = await store.getOrCreateSpace({ platform: "slack", channel_id: "C1" });
      const item = await store.createWorkItem({
        space_id: space.id,
        requester: "U1",
        description: "failed work",
        repo: "acme/sandbox",
      });
      await store.claimWorkItemById(item.id);
      await store.transitionWorkItem(item.id, "claimed", "working", { by: "executor" });
      await store.transitionWorkItem(item.id, "working", "blocked", { evidence: "failed", by: "executor" });
      const workspace = makeOwnedWorkspace(fx.lifecycle, item.id, "acme/sandbox");

      await expect(
        purgeRetainedWorkspace({ store, workspacesDir: fx.root, itemId: item.id, actor: "operator:U_ADMIN" }),
      ).resolves.toEqual({ itemId: item.id, workspace, removed: true });
      expect(existsSync(workspace)).toBe(false);

      const rows = await store.listAudit({ event_type: WORKSPACE_PURGE_EVENT });
      expect(rows.map((row) => JSON.parse(row.payload))).toEqual([
        expect.objectContaining({ id: item.id, decision: "requested", workspace }),
        expect.objectContaining({ id: item.id, decision: "removed", workspace }),
      ]);

      await expect(
        purgeRetainedWorkspace({ store, workspacesDir: fx.root, itemId: item.id, actor: "operator:U_ADMIN" }),
      ).rejects.toThrow(/does not exist/i);
      expect(existsSync(workspace)).toBe(false);
    } finally {
      store.close();
      fx.cleanup();
    }
  });

  test("refuses active database items before touching a marker-matched workspace", async () => {
    const fx = fixture();
    const store = createStore(join(fx.dir, "store.db"));
    try {
      const space = await store.getOrCreateSpace({ platform: "slack", channel_id: "C2" });
      const item = await store.createWorkItem({
        space_id: space.id,
        requester: "U1",
        description: "active work",
        repo: "acme/sandbox",
      });
      const workspace = makeOwnedWorkspace(fx.lifecycle, item.id, "acme/sandbox");
      writeFileSync(join(workspace, "sentinel"), "keep");

      await expect(
        purgeRetainedWorkspace({ store, workspacesDir: fx.root, itemId: item.id, actor: "operator:U_ADMIN" }),
      ).rejects.toThrow(/state open.*only blocked/i);
      expect(readFileSync(join(workspace, "sentinel"), "utf8")).toBe("keep");

      const rows = await store.listAudit({ event_type: WORKSPACE_PURGE_EVENT });
      expect(rows).toHaveLength(1);
      expect(JSON.parse(rows[0].payload)).toMatchObject({ id: item.id, decision: "refused", reason: expect.any(String) });
    } finally {
      store.close();
      fx.cleanup();
    }
  });
});
