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

/** Runs the shared dev Compose project naming exactly as dev.sh sources it, from `cwd`. */
function devComposeProjectFrom(cwd: string): string {
  const res = Bun.spawnSync(["bash", "-c", `source "${helper}" && dev_compose_project`], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(res.exitCode, `dev_compose_project resolution failed from ${cwd}: ${res.stderr.toString()}`).toBe(0);
  return res.stdout.toString().trim();
}

/** Runs the canonical MITM CA dir resolution exactly as dev.sh sources it, from `cwd`. */
function sharedCertsDirFrom(cwd: string): string {
  const res = Bun.spawnSync(["bash", "-c", `source "${helper}" && shared_certs_dir`], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(res.exitCode, `shared_certs_dir resolution failed from ${cwd}: ${res.stderr.toString()}`).toBe(0);
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

describe("shared dev Compose project name (issue #301)", () => {
  // realpath: see the sibling describe's note re /var vs /private/var.
  const top = realpathSync(mkdtempSync(join(tmpdir(), "bottega-dev-compose-project-")));
  const checkout = join(top, "camp-flavor");
  const worktreeA = join(checkout, ".worktrees", "feature-a");
  const worktreeB = join(checkout, ".worktrees", "native-dm-card");
  afterAll(() => rmSync(top, { recursive: true, force: true }));

  test("two sibling worktree paths resolve the SAME canonical dev project name", () => {
    mkdirSync(worktreeA, { recursive: true });
    mkdirSync(worktreeB, { recursive: true });
    // The bug (#301): each worktree used to get its own dir-basename project
    // (worktree_egress network) with the SAME explicit subnet, so the second
    // `compose up` failed with "invalid pool request: Pool overlaps with other
    // one on this address space". Sharing ONE project (a stable hash of the
    // canonical checkout's realpath) gives every worktree of ONE repo the
    // SAME egress network to reuse.
    const nameA = devComposeProjectFrom(worktreeA);
    const nameB = devComposeProjectFrom(worktreeB);
    expect(nameA).toBe(nameB);
    // The canonical checkout itself resolves the same name (primary dev
    // worktree is the same canonical checkout every worktree pins to).
    expect(devComposeProjectFrom(checkout)).toBe(nameA);
  });

  test("two distinct same-basename canonical roots resolve DIFFERENT project names", () => {
    // Reviewer finding (#301): the first cut pinned the project to the
    // canonical checkout's BASENAME, so two unrelated clones that both happen
    // to be named `camp-flavor` (at DIFFERENT realpaths) would SHARE a Compose
    // project and collide. The name must encode the canonical REALPATH, not
    // the basename: unrelated same-basename clones must diverge.
    const other = join(top, "unrelated-clone", "camp-flavor"); // SAME basename, different parent realpath than checkout
    const otherA = join(other, ".worktrees", "feature-a");
    const otherB = join(other, ".worktrees", "native-dm-card");
    mkdirSync(otherA, { recursive: true });
    mkdirSync(otherB, { recursive: true });
    const cloneNameA = devComposeProjectFrom(otherA);
    const cloneNameB = devComposeProjectFrom(otherB);
    // The unrelated clone's two worktrees share ITS OWN canonical name…
    expect(cloneNameA).toBe(cloneNameB);
    // The two CLONES share a basename but live at different realpaths, so
    // their derived names differ — their egress networks (and container
    // sets) never collide.
    expect(cloneNameA).not.toBe(devComposeProjectFrom(checkout));
  });

  test("every worktree derives the SAME egress network name (one subnet, no overlap)", () => {
    // The egress network is `<project>_egress`. Because every worktree shares
    // the canonical project name, they all reference ONE network that compose
    // reuses — never a fresh per-worktree network with the same explicit
    // 172.30.0.0/24 subnet (the #301 collision).
    const netA = `${devComposeProjectFrom(worktreeA)}_egress`;
    const netB = `${devComposeProjectFrom(worktreeB)}_egress`;
    expect(netA).toBe(netB);
  });

  test("the derived project name is valid, lowercase, and bounded (Compose charset/length)", () => {
    // Compose project names must be lowercase `[a-z0-9][a-z0-9_-]*` and stay
    // well under Docker's 63-char name limit; ours is `bot-<base>-<10hex>`.
    const name = devComposeProjectFrom(worktreeA);
    expect(name.length).toBeLessThanOrEqual(40);
    expect(name).toMatch(/^bot-[a-z0-9-]+-[0-9a-f]{10}$/);
    // No uppercase, no path separators, no leading dash — safe as a Compose
    // project name AND as a shell-exported/git-branch-safe token fragment.
    expect(name).toBe(name.toLowerCase());
    expect(name).not.toMatch(/^[-_]/);
  });
});

describe("shared canonical MITM CA dir (issue #301)", () => {
  // realpath: see the sibling describe's note re /var vs /private/var.
  const top = realpathSync(mkdtempSync(join(tmpdir(), "bottega-shared-certs-dir-")));
  const checkout = join(top, "camp-flavor");
  const worktree = join(checkout, ".worktrees", "feature");
  afterAll(() => rmSync(top, { recursive: true, force: true }));

  test("a worktree resolves the OWNER checkout's certs dir, never its own", () => {
    mkdirSync(join(worktree, ".worktrees", "deeper"), { recursive: true });
    // The second-worktree bug (#301): a worktree used to generate/MITM with
    // its OWN local certs/, which the SHARED proxy is not terminating with.
    // shared_certs_dir must resolve the canonical checkout's certs/ so every
    // worktree trusts the SAME CA.
    expect(sharedCertsDirFrom(worktree)).toBe(join(checkout, "certs"));
  });

  test("the canonical checkout itself resolves its own certs dir", () => {
    expect(sharedCertsDirFrom(checkout)).toBe(join(checkout, "certs"));
  });
});
