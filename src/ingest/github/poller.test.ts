import { afterEach, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { githubMentionPayloadSchema } from "../dispatch";
import { createGithubPoller } from "./poller";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "bottega-ingest-github-"));
  dirs.push(dir);
  return dir;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** One open issue mentioning the bot, updated 30s after the test baseline. */
function mentionItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    html_url: "https://github.com/acme/bottega/issues/42",
    title: "Fix the flaky checkout",
    body: "Can you look at this?",
    user: { login: "someone" },
    number: 42,
    repository_url: "https://api.github.com/repos/acme/bottega",
    updated_at: "2026-08-17T12:00:30.000Z",
    ...overrides,
  };
}

const BASELINE = Date.UTC(2026, 7, 17, 12, 0, 0); // 2026-08-17T12:00:00Z

describe("createGithubPoller (issue #57)", () => {
  test("a missing token file is unconfigured → no-op (empty poll)", async () => {
    const dir = freshDir();
    const poller = createGithubPoller({
      tokenFile: join(dir, "does-not-exist"),
      fetchImpl: async () => {
        throw new Error("fetch must not be called when unconfigured");
      },
    });
    expect(await poller.poll()).toEqual([]);
  });

  test("an empty token file is a misconfiguration → poll throws", async () => {
    const dir = freshDir();
    const tokenFile = join(dir, "github-pat");
    writeFileSync(tokenFile, "\n", { mode: 0o600 });
    const poller = createGithubPoller({
      tokenFile,
      fetchImpl: async () => {
        throw new Error("fetch must not be called");
      },
    });
    await expect(poller.poll()).rejects.toThrow(/empty/);
  });

  test("emits one mention event per issue updated after the poller baseline", async () => {
    const dir = freshDir();
    const tokenFile = join(dir, "github-pat");
    writeFileSync(tokenFile, "github_pat_test_secret\n", { mode: 0o600 });

    const seenUrls: string[] = [];
    const fetchImpl = async (url: string): Promise<Response> => {
      seenUrls.push(url);
      if (url.includes("/search/issues")) {
        return jsonResponse({ items: [mentionItem()] });
      }
      throw new Error(`unexpected fetch: ${url}`);
    };

    const poller = createGithubPoller({
      tokenFile,
      login: "bottega-bot",
      fetchImpl,
      now: () => BASELINE,
    });

    const events = await poller.poll();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      provider: "github",
      eventType: "mention",
      occurredAt: "2026-08-17T12:00:30.000Z",
    });
    // The payload satisfies the dispatcher's mention schema.
    expect(githubMentionPayloadSchema.safeParse(events[0]!.payload).success).toBe(true);
    expect(events[0]!.payload).toMatchObject({
      kind: "mention",
      repo: "acme/bottega",
      number: 42,
      isPullRequest: false,
      title: "Fix the flaky checkout",
      url: "https://github.com/acme/bottega/issues/42",
      author: "someone",
      updatedAt: "2026-08-17T12:00:30.000Z",
    });
    // Search query targets open mentions of the bot account.
    expect(seenUrls.join("\n")).toContain("mentions%3Abottega-bot");
    expect(seenUrls.join("\n")).toContain("is%3Aopen");
  });

  test("resolves the bot login from GET /user once and caches it", async () => {
    const dir = freshDir();
    const tokenFile = join(dir, "github-pat");
    writeFileSync(tokenFile, "github_pat_test_secret\n", { mode: 0o600 });

    let userCalls = 0;
    const fetchImpl = async (url: string): Promise<Response> => {
      if (url.includes("/user")) {
        userCalls += 1;
        return jsonResponse({ login: "bottega-bot" });
      }
      if (url.includes("/search/issues")) {
        return jsonResponse({ items: [mentionItem()] });
      }
      throw new Error(`unexpected fetch: ${url}`);
    };

    const poller = createGithubPoller({ tokenFile, fetchImpl, now: () => BASELINE });
    await poller.poll();
    await poller.poll(); // second poll must reuse the cached login
    expect(userCalls).toBe(1);
  });

  test("marks pull requests via the pull_request field", async () => {
    const dir = freshDir();
    const tokenFile = join(dir, "github-pat");
    writeFileSync(tokenFile, "github_pat_test_secret\n", { mode: 0o600 });

    const fetchImpl = async (url: string): Promise<Response> => {
      if (url.includes("/search/issues")) {
        return jsonResponse({
          items: [
            mentionItem({
              html_url: "https://github.com/acme/bottega/pull/43",
              number: 43,
              pull_request: { url: "https://api.github.com/repos/acme/bottega/pulls/43" },
            }),
          ],
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    };

    const poller = createGithubPoller({ tokenFile, login: "bottega-bot", fetchImpl, now: () => BASELINE });
    const events = await poller.poll();
    expect(events[0]!.payload).toMatchObject({ isPullRequest: true, url: "https://github.com/acme/bottega/pull/43" });
  });

  test("dedupes: nothing updated since the previous poll → empty", async () => {
    const dir = freshDir();
    const tokenFile = join(dir, "github-pat");
    writeFileSync(tokenFile, "github_pat_test_secret\n", { mode: 0o600 });

    const fetchImpl = async (url: string): Promise<Response> => {
      if (url.includes("/search/issues")) return jsonResponse({ items: [mentionItem()] });
      throw new Error(`unexpected fetch: ${url}`);
    };

    let t = BASELINE;
    const poller = createGithubPoller({ tokenFile, login: "bottega-bot", fetchImpl, now: () => t });

    expect(await poller.poll()).toHaveLength(1);
    // Advance past the mention's updated_at; the same item must not re-emit.
    t = Date.UTC(2026, 7, 17, 12, 5, 0);
    expect(await poller.poll()).toEqual([]);
  });

  test("a malformed search response throws (fail closed, never garbage events)", async () => {
    const dir = freshDir();
    const tokenFile = join(dir, "github-pat");
    writeFileSync(tokenFile, "github_pat_test_secret\n", { mode: 0o600 });

    const fetchImpl = async (url: string): Promise<Response> => {
      if (url.includes("/search/issues")) {
        return jsonResponse({ items: [{ html_url: "not-a-url", title: 42 }] });
      }
      throw new Error(`unexpected fetch: ${url}`);
    };

    const poller = createGithubPoller({ tokenFile, login: "bottega-bot", fetchImpl, now: () => BASELINE });
    await expect(poller.poll()).rejects.toThrow(/unexpected shape/);
  });

  test("a non-ok API response throws", async () => {
    const dir = freshDir();
    const tokenFile = join(dir, "github-pat");
    writeFileSync(tokenFile, "github_pat_test_secret\n", { mode: 0o600 });

    const fetchImpl = async (url: string): Promise<Response> => {
      if (url.includes("/search/issues")) return jsonResponse({ message: "rate limited" }, 403);
      throw new Error(`unexpected fetch: ${url}`);
    };

    const poller = createGithubPoller({ tokenFile, login: "bottega-bot", fetchImpl, now: () => BASELINE });
    await expect(poller.poll()).rejects.toThrow(/search failed: 403/);
  });
});
