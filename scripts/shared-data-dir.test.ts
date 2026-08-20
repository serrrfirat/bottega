/**
 * Shared durable-store dir resolution (issue #293): scripts/dev.sh and
 * scripts/tunnel.sh source scripts/shared-data-dir.sh so a dev server
 * started from ANY repository worktree reads the SAME canonical
 * data/public-base-url the tunnel writes. Chat-discovered bug: a dev
 * server restarted from an isolated feature worktree (whose local data/
 * has no public-base-url) silently fell back to loopback URLs for upload
 * links and OAuth callbacks while the canonical checkout's store held the
 * live tunnel URL.
 *
 * Hermetic: a temp checkout/.worktrees/<name> topology, no repo state.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const helper = join(import.meta.dir, "shared-data-dir.sh");

/** Runs the resolution exactly as dev.sh/tunnel.sh source it, from `cwd`. */
function sharedDataDirFrom(cwd: string): string {
  const res = Bun.spawnSync(["bash", "-c", `source "${helper}" && shared_data_dir`], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(res.exitCode, `bash resolution failed from ${cwd}: ${res.stderr.toString()}`).toBe(0);
  return res.stdout.toString().trim();
}

describe("shared data dir resolution (issue #293)", () => {
  // realpath: macOS /var is a symlink to /private/var — the shell's `pwd`
  // prints the resolved path, so the expected paths must too.
  const top = realpathSync(mkdtempSync(join(tmpdir(), "bottega-shared-data-dir-")));
  const checkout = join(top, "checkout");
  const worktree = join(checkout, ".worktrees", "feature");
  const nested = join(worktree, ".worktrees", "deeper");
  afterAll(() => rmSync(top, { recursive: true, force: true }));

  test("a feature worktree resolves the OWNER checkout's data dir, not its own", () => {
    mkdirSync(nested, { recursive: true });
    // The chat failure: the worktree cwd has no data/ of its own; the
    // canonical checkout's data/ holds the shared store.
    expect(sharedDataDirFrom(worktree)).toBe(join(checkout, "data"));
  });

  test("the canonical checkout itself resolves its own data dir", () => {
    expect(sharedDataDirFrom(checkout)).toBe(join(checkout, "data"));
  });

  test("deeply nested worktrees resolve the same owner checkout", () => {
    expect(sharedDataDirFrom(nested)).toBe(join(checkout, "data"));
  });

  test("a plain directory (no worktree nesting) resolves its own data dir", () => {
    const plain = join(top, "plain");
    mkdirSync(plain, { recursive: true });
    expect(sharedDataDirFrom(plain)).toBe(join(plain, "data"));
  });
});
