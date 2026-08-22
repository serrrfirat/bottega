/**
 * Hermetic round-trip test for the SQLite backup/restore tooling (issue
 * #104): scripts/backup.sh snapshots a live DB via bun:sqlite
 * Database.serialize(), and scripts/restore.sh writes a snapshot back over
 * the store atomically. Everything is exercised against real temp files via
 * the actual scripts (Bun.spawnSync) — no Docker, no compose, no live
 * credentials. The snapshot is verified restorable (round-trip), mode 0600,
 * and retention-pruned to the keep N.
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const backupSh = join(import.meta.dir, "backup.sh");
const restoreSh = join(import.meta.dir, "restore.sh");

/** Creates a temp dir with a seeded `bottega.db` (table `t`, rows 1,2). */
function freshStore() {
  const root = mkdtempSync(join(tmpdir(), "bottega-backup-"));
  const dataDir = join(root, "data");
  const backupDir = join(dataDir, "backups");
  mkdirSync(backupDir, { recursive: true });
  const dbPath = join(dataDir, "bottega.db");
  const db = new Database(dbPath);
  db.exec("CREATE TABLE t(x INTEGER)");
  const ins = db.prepare("INSERT INTO t(x) VALUES (?)");
  ins.run(1);
  ins.run(2);
  db.close();
  return { root, dataDir, dbPath, backupDir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function listSnapshots(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^bottega-\d{8}-\d{6}\.db$/.test(f))
    .sort();
}

/** Runs backup.sh; returns exit code + stdout path + stderr. */
function runBackup(dbPath: string, backupDir: string, keep?: number) {
  const env = { ...process.env, BOTTEGA_DB_PATH: dbPath, BACKUP_DIR: backupDir };
  if (keep !== undefined) env.BACKUP_KEEP = String(keep);
  const res = Bun.spawnSync(["bash", backupSh], {
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: res.exitCode, out: res.stdout.toString().trim(), stderr: res.stderr.toString() };
}

function rows(dbPath: string): number[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    // SAFETY: the query selects one INTEGER column `x` from a table we just
    // created, so every row is an object with a numeric `x`.
    return (db.query("SELECT x FROM t ORDER BY x").all() as Array<{ x: number }>).map((r) => r.x);
  } finally {
    db.close();
  }
}

describe("scripts/backup.sh + restore.sh (issue #104)", () => {
  test("backup produces a restorable 0600 snapshot and restore round-trips it", () => {
    const store = freshStore();
    try {
      const backup = runBackup(store.dbPath, store.backupDir);
      expect(backup.code).toBe(0);
      expect(backup.stderr).toContain("backup: wrote");
      expect(backup.out).toMatch(/\.db$/);
      expect(backup.out).not.toEqual(store.dbPath); // never overwrite the source
      expect(rows(backup.out)).toEqual([1, 2]);
      expect(statSync(backup.out).mode & 0o777).toBe(0o600);

      // Round-trip via a TEMP store: make a fresh copy, mutate it, restore
      // the snapshot into it, and assert the original data comes back. The
      // restore target is a temp file, never the repo's data/ dir.
      const tmpDbPath = join(store.dataDir, "restore-target.db");
      const cp = Bun.spawnSync(["cp", store.dbPath, tmpDbPath]);
      expect(cp.exitCode).toBe(0);
      const live = new Database(tmpDbPath);
      live.exec("INSERT INTO t VALUES (999)");
      live.close();

      const restore = Bun.spawnSync(["bash", restoreSh, backup.out, tmpDbPath, "--yes"], {
        env: { ...process.env },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(restore.exitCode).toBe(0);
      expect(restore.stderr.toString()).toContain("restart the server");
      expect(rows(tmpDbPath)).toEqual([1, 2]); // 999 gone: snapshot restored
    } finally {
      store.cleanup();
    }
  });

  test("restore refuses without an explicit 'yes' confirmation", () => {
    const store = freshStore();
    try {
      const backup = runBackup(store.dbPath, store.backupDir);
      expect(backup.code).toBe(0);
      const tmpDbPath = join(store.dataDir, "confirm-target.db");
      const cp = Bun.spawnSync(["cp", store.dbPath, tmpDbPath]);
      expect(cp.exitCode).toBe(0);

      // No --yes and no "yes" on stdin -> refused, target untouched.
      const res = Bun.spawnSync(["bash", restoreSh, backup.out, tmpDbPath], {
        input: "no\n",
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(res.exitCode).not.toBe(0);
      expect(res.stderr.toString()).toContain("aborted");
      expect(rows(tmpDbPath)).toEqual([1, 2]);
    } finally {
      store.cleanup();
    }
  });

  test("backup refuses a missing source DB", () => {
    const store = freshStore();
    try {
      const backup = runBackup(join(store.dataDir, "nope.db"), store.backupDir);
      expect(backup.code).not.toBe(0);
      expect(backup.stderr).toMatch(/no such database file/);
    } finally {
      store.cleanup();
    }
  });

  test("restore refuses a missing target and a foreign / non-SQLite snapshot", () => {
    const store = freshStore();
    try {
      // Missing target DB: refused (never creates one by accident).
      const realSnap = runBackup(store.dbPath, store.backupDir);
      expect(realSnap.code).toBe(0);
      const missingTarget = Bun.spawnSync(["bash", restoreSh, realSnap.out, join(store.dataDir, "absent.db"), "--yes"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(missingTarget.exitCode).not.toBe(0);
      expect(missingTarget.stderr.toString()).toMatch(/does not exist/);
      expect(existsSync(join(store.dataDir, "absent.db"))).toBe(false);
      // Missing snapshot: refused.
      const missingSnap = Bun.spawnSync(["bash", restoreSh, join(store.dataDir, "nope.db"), store.dbPath, "--yes"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(missingSnap.exitCode).not.toBe(0);
      // Non-SQLite file as snapshot: refused by the header check.
      const junk = join(store.dataDir, "junk.db");
      writeFileSync(junk, "this is not a database");
      const junkSnap = Bun.spawnSync(["bash", restoreSh, junk, store.dbPath, "--yes"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(junkSnap.exitCode).not.toBe(0);
      expect(junkSnap.stderr.toString()).toMatch(/not a SQLite database/);
    } finally {
      store.cleanup();
    }
  });

  test("retention prune keeps only the newest N=7 snapshots (10 fake seeds)", () => {
    const store = freshStore();
    try {
      // Pre-seed 10 OLDER snapshots (day-ordered stamps) so the new backup
      // is the 11th; with keep=7 the 4 oldest are pruned and 7 remain.
      const seeds = 10;
      for (let i = 0; i < seeds; i++) {
        const stamp = `202601${String(i + 1).padStart(2, "0")}-000000`;
        const db = new Database(join(store.backupDir, `bottega-${stamp}.db`));
        db.exec("CREATE TABLE t(x INTEGER)");
        db.close();
      }
      expect(listSnapshots(store.backupDir)).toHaveLength(seeds);

      const backup = runBackup(store.dbPath, store.backupDir, /* keep */ 7);
      expect(backup.code).toBe(0);
      const after = listSnapshots(store.backupDir);
      expect(after).toHaveLength(7); // 10 seeds + 1 new - 4 oldest pruned = 7
      // The just-written snapshot is retained.
      expect(after).toContain(backup.out.split("/").pop());
      // The 4 oldest pre-seeded snapshots are gone.
      expect(after.some((f) => f === "bottega-20260101-000000.db")).toBe(false);
      expect(after.some((f) => f === "bottega-20260104-000000.db")).toBe(false);
      // A recent seed (2026-01-10) survives.
      expect(after).toContain("bottega-20260110-000000.db");
    } finally {
      store.cleanup();
    }
  });
});