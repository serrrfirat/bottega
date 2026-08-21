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
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
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

/**
 * Runs the shared dev Compose project naming exactly as dev.sh sources it,
 * from `cwd`. `adopt` (optional) sets the BOTTEGA_DEV_COMPOSE_ADOPT test
 * seam so the legacy-adoption branch is exercised hermetically: a project
 * name simulates an adoptable legacy `$base` stack owned by this checkout,
 * `"__none__"` simulates no adoptable legacy stack, and omitting it leaves
 * the seam unset (real runtime behavior, but hermetic tests always pass one
 * to avoid a live Docker dependency).
 */
function devComposeProjectFrom(cwd: string, adopt?: string): string {
  const env = { ...Bun.env };
  if (adopt !== undefined) env.BOTTEGA_DEV_COMPOSE_ADOPT = adopt;
  const res = Bun.spawnSync(["bash", "-c", `source "${helper}" && dev_compose_project`], {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(res.exitCode, `dev_compose_project resolution failed from ${cwd}: ${res.stderr.toString()}`).toBe(0);
  return res.stdout.toString().trim();
}

/** Creates a fresh hermetic canonical-checkout topology and returns {top, checkout}. */
function freshTopology(prefix: string): { top: string; checkout: string } {
  const top = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  return { top, checkout: join(top, "camp-flavor") };
}

/**
 * Asserts `dev_compose_project` FAILS CLOSED (non-zero exit, no name output)
 * from `cwd` under the given seam — covers the ambiguous-legacy branch where
 * a `$base` project exists but is not owned by this checkout.
 */
function devComposeProjectFailsFrom(cwd: string, adopt: string): string {
  const env = { ...Bun.env, BOTTEGA_DEV_COMPOSE_ADOPT: adopt };
  const res = Bun.spawnSync(["bash", "-c", `source "${helper}" && dev_compose_project`], {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(res.exitCode, `expected dev_compose_project to fail closed from ${cwd}: stdout="${res.stdout.toString()}" stderr="${res.stderr.toString()}"`).not.toBe(0);
  return res.stderr.toString();
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
  // Each test builds its own fresh hermetic topology so the persistent
  // project-id file (written into the canonical data dir) and the legacy
  // test seam never leak across assertions.

  test("worktrees of one repo resolve ONE canonical project (no legacy, fresh identity)", () => {
    // realpath: see the sibling describe's note re /var vs /private/var.
    const { top, checkout } = freshTopology("bottega-dev-compose-project-");
    const worktreeA = join(checkout, ".worktrees", "feature-a");
    const worktreeB = join(checkout, ".worktrees", "native-dm-card");
    try {
      mkdirSync(worktreeA, { recursive: true });
      mkdirSync(worktreeB, { recursive: true });
      // The bug (#301): each worktree used to get its own dir-basename
      // project (worktree_egress network) with the SAME explicit subnet, so
      // the second `compose up` failed with "invalid pool request: Pool
      // overlaps with other one on this address space". Sharing ONE project
      // (a stable realpath identity, here the deterministic hashed name)
      // gives every worktree of ONE repo the SAME egress network to reuse.
      const nameA = devComposeProjectFrom(worktreeA, "__none__");
      const nameB = devComposeProjectFrom(worktreeB, "__none__");
      expect(nameA).toBe(nameB);
      expect(devComposeProjectFrom(checkout, "__none__")).toBe(nameA);
    } finally {
      rmSync(top, { recursive: true, force: true });
    }
  });

  test("two distinct same-basename canonical roots resolve DIFFERENT project names", () => {
    // Reviewer finding (#301): the first cut pinned the project to the
    // canonical checkout's BASENAME, so two unrelated clones that both happen
    // to be named `camp-flavor` (at DIFFERENT realpaths) would SHARE a Compose
    // project and collide. The identity must encode the canonical REALPATH,
    // not the basename: unrelated same-basename clones must diverge.
    const { top, checkout } = freshTopology("bottega-dev-compose-clone-");
    const clone = join(top, "unrelated-clone", "camp-flavor"); // SAME basename, different realpath
    try {
      const checkoutA = join(checkout, ".worktrees", "feature-a");
      const cloneA = join(clone, ".worktrees", "feature-a");
      const cloneOther = join(clone, ".worktrees", "other");
      mkdirSync(checkoutA, { recursive: true });
      mkdirSync(cloneA, { recursive: true });
      mkdirSync(cloneOther, { recursive: true });
      const ours = devComposeProjectFrom(checkoutA, "__none__");
      const theirs = devComposeProjectFrom(cloneA, "__none__");
      // Both fresh, no legacy: the realpath-hashed names diverge.
      expect(ours).not.toBe(theirs);
      // Each clone's own worktrees stay internally consistent.
      expect(devComposeProjectFrom(cloneOther, "__none__")).toBe(theirs);
    } finally {
      rmSync(top, { recursive: true, force: true });
    }
  });

  test("every worktree derives the SAME egress network name (one subnet, no overlap)", () => {
    const { top, checkout } = freshTopology("bottega-dev-compose-net-");
    const worktreeA = join(checkout, ".worktrees", "feature-a");
    const worktreeB = join(checkout, ".worktrees", "native-dm-card");
    try {
      mkdirSync(worktreeA, { recursive: true });
      mkdirSync(worktreeB, { recursive: true });
      // The egress network is `<project>_egress`. Every worktree shares the
      // canonical project name, so they all reference ONE network that
      // compose reuses — never a fresh per-worktree network with the same
      // explicit 172.30.0.0/24 subnet (the #301 collision).
      const netA = `${devComposeProjectFrom(worktreeA, "__none__")}_egress`;
      const netB = `${devComposeProjectFrom(worktreeB, "__none__")}_egress`;
      expect(netA).toBe(netB);
    } finally {
      rmSync(top, { recursive: true, force: true });
    }
  });

  test("the derived project name is valid, lowercase, and bounded (Compose charset/length)", () => {
    const { top, checkout } = freshTopology("bottega-dev-compose-valid-");
    const worktreeA = join(checkout, ".worktrees", "feature-a");
    try {
      mkdirSync(worktreeA, { recursive: true });
      // Compose project names must be lowercase `[a-z0-9][a-z0-9_-]*` and stay
      // well under Docker's 63-char name limit; the hashed form is
      // `bot-<base>-<10hex>`.
      const name = devComposeProjectFrom(worktreeA, "__none__");
      expect(name.length).toBeLessThanOrEqual(40);
      expect(name).toMatch(/^bot-[a-z0-9-]+-[0-9a-f]{10}$/);
      expect(name).toBe(name.toLowerCase());
      expect(name).not.toMatch(/^[-_]/);
    } finally {
      rmSync(top, { recursive: true, force: true });
    }
  });

  test("adopts a COMPATIBLE legacy canonical-basename stack (secondary worktree reuses it, #301)", () => {
    // Migration: the pre-#301 naming ran the dev stack as project `camp-flavor`
    // (basename); its `camp-flavor_egress` network already owns the fixed
    // 172.30.0.0/24 subnet. A fresh secondary-worktree boot must detect that
    // legacy stack (proven owned by THIS checkout) and reuse `camp-flavor`
    // rather than minting a new `bot-*` project that cannot place its egress
    // network on the same subnet without manual `docker compose down`.
    const { top, checkout } = freshTopology("bottega-dev-compose-adopt-");
    const worktreeA = join(checkout, ".worktrees", "feature-a");
    const worktreeB = join(checkout, ".worktrees", "native-dm-card");
    try {
      mkdirSync(worktreeA, { recursive: true });
      mkdirSync(worktreeB, { recursive: true });
      // Both worktrees see an adoptable legacy `camp-flavor` stack.
      expect(devComposeProjectFrom(worktreeA, "camp-flavor")).toBe("camp-flavor");
      expect(devComposeProjectFrom(worktreeB, "camp-flavor")).toBe("camp-flavor");
    } finally {
      rmSync(top, { recursive: true, force: true });
    }
  });

  test("persists the adopted legacy id so later boots reuse it without re-probing", () => {
    // The persistent project-id file (canonical data/.dev-compose-project)
    // records the adoption: once `camp-flavor` is adopted for this repo,
    // subsequent boots (project-id file present) keep it even when no new
    // legacy probe would detect anything.
    const { top, checkout } = freshTopology("bottega-dev-compose-persist-");
    const worktreeA = join(checkout, ".worktrees", "feature-a");
    try {
      mkdirSync(worktreeA, { recursive: true });
      // First resolution adopts (with the legacy seam present)…
      expect(devComposeProjectFrom(worktreeA, "camp-flavor")).toBe("camp-flavor");
      // …and writes the id file into the SHARED canonical data dir.
      const pidFile = join(checkout, "data", ".dev-compose-project");
      expect(readFileSync(pidFile, "utf8").trim()).toBe("camp-flavor");
      // A later resolution (seam set to "no legacy") still returns the
      // persisted id — the adoption is durable across boots.
      expect(devComposeProjectFrom(worktreeA, "__none__")).toBe("camp-flavor");
    } finally {
      rmSync(top, { recursive: true, force: true });
    }
  });

  test("an unrelated same-basename clone NEVER reads this repo's persisted id", () => {
    // The project-id lives in the canonical data dir, which is per-checkout.
    // An unrelated clone at a different realpath has its OWN data dir (no id
    // file), so even though it shares the `camp-flavor` basename it resolves
    // a DIFFERENT (hashed) project — it cannot silently attach to this repo's
    // adopted `camp-flavor` stack.
    const { top, checkout } = freshTopology("bottega-dev-compose-cross-");
    const clone = join(top, "other-path", "camp-flavor");
    try {
      const worktreeA = join(checkout, ".worktrees", "feature-a");
      const cloneA = join(clone, ".worktrees", "feature-a");
      mkdirSync(worktreeA, { recursive: true });
      mkdirSync(cloneA, { recursive: true });
      // This repo adopts its legacy `camp-flavor` (persisted under checkout/data).
      expect(devComposeProjectFrom(worktreeA, "camp-flavor")).toBe("camp-flavor");
      // The unrelated clone, at a different realpath, has no id file and no
      // adoptable legacy of its own -> it gets ITS OWN project id, not the
      // first repo's `camp-flavor`.
      const ours = devComposeProjectFrom(worktreeA, "__none__");
      expect(ours).toBe("camp-flavor");
      expect(devComposeProjectFrom(cloneA, "__none__")).not.toBe("camp-flavor");
      expect(devComposeProjectFrom(cloneA, "__none__")).not.toBe(ours);
    } finally {
      rmSync(top, { recursive: true, force: true });
    }
  });

  test("FAILS CLOSED when a legacy `$base` project exists but is NOT owned by this checkout", () => {
    // If a legacy compose project named after the canonical basename exists
    // (its `camp-flavor_egress` network owns the fixed subnet) but its
    // iron-proxy working_dir is NOT under this checkout — an unrelated
    // same-basename clone's stack — we must NOT adopt it (never touch a
    // stranger's network) AND NOT mint a parallel project on the same subnet.
    // The only safe boot is a loud failure with a hand remedy.
    const { top, checkout } = freshTopology("bottega-dev-compose-foreign-");
    const worktreeA = join(checkout, ".worktrees", "feature-a");
    try {
      mkdirSync(worktreeA, { recursive: true });
      const err = devComposeProjectFailsFrom(worktreeA, "__foreign__");
      expect(err).toMatch(/NOT under this checkout/);
      expect(err).toMatch(/DIFFERENT clone/);
      // No default name was emitted, no project-id file was written.
      expect(devComposeProjectFailsFrom(worktreeA, "__foreign__")).toContain("refusing to adopt");
    } finally {
      rmSync(top, { recursive: true, force: true });
    }
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
