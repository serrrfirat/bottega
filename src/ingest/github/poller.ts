/**
 * GitHub mentions poller (issue #57) — the polling leg's reference
 * implementation. Each pass asks the GitHub search API for open issues and
 * pull requests that mention the bot account, and emits one
 * {@link IngestEvent} (eventType "mention") per issue whose `updated_at`
 * is newer than the previous poll.
 *
 * Credentials: the SAME git PAT file the executor uses
 * (`EXECUTOR_GIT_TOKEN_FILE`, default `data/secrets/github-pat`, mode
 * 0600). The file is re-read every poll so rotation applies without a
 * restart. A MISSING file means the poller is unconfigured → poll returns
 * [] (no-op, like the Linear skeleton); a present-but-unreadable or empty
 * file is a misconfiguration → poll throws (the scheduler action logs it
 * loudly, the loop survives).
 *
 * Egress: `api.github.com` must be on the iron-proxy allowlist
 * (config/egress.yml) for the poll to leave the container network.
 *
 * Boot policy mirrors the scheduler runner: the first poll only emits
 * mentions updated after poller construction — a backlog of old mentions
 * is never replayed after downtime.
 */
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { githubMentionPayloadSchema, type GithubMentionPayload } from "../dispatch";
import type { IngestEvent, Poller } from "../types";

export const DEFAULT_GITHUB_API_BASE_URL = "https://api.github.com";
export const DEFAULT_GITHUB_TOKEN_FILE = "data/secrets/github-pat";
const SEARCH_PER_PAGE = 50;

export interface GithubPollerOpts {
  /** GitHub REST API base; default https://api.github.com (org settings override). */
  apiBaseUrl?: string;
  /** PAT file; default `EXECUTOR_GIT_TOKEN_FILE` ?? data/secrets/github-pat. */
  tokenFile?: string;
  /** Bot account login; unset → resolved from GET /user and cached. */
  login?: string;
  /** Test seam; the poller only issues GETs against string URLs. */
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
  /** Injectable clock (ms epoch) for hermetic tests. */
  now?: () => number;
  /**
   * Durable poll boundary (issue #101): when set, the poller seeds
   * lastPolledAt from the persisted cursor at construction and persists the
   * advanced boundary after every poll. This turns the in-memory
   * boot-baseline into a restart-safe watermark — the worker's poll-fetch
   * leg supplies this seam backed by the ingest_watermark table. Absent
   * (the scheduler's in-process instance), the poller keeps its in-memory
   * boot baseline exactly as before.
   */
  watermark?: {
    getCursor(): string | null | Promise<string | null>;
    setCursor(cursor: string): void | Promise<void>;
  };
}

const GITHUB_API_HEADERS = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
} as const;

const userSchema = z.object({ login: z.string().min(1) });

const searchItemSchema = z.object({
  html_url: z.string().url(),
  title: z.string().min(1),
  body: z.string().nullable().optional(),
  user: z.object({ login: z.string() }).nullable(),
  number: z.number().int().positive(),
  repository_url: z.string(),
  /** Present on pull requests; its shape is irrelevant to the poller. */
  pull_request: z.unknown().optional(),
  updated_at: z.string(),
});
const searchResponseSchema = z.object({ items: z.array(searchItemSchema) });

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** "https://api.github.com/repos/owner/name" → "owner/name". */
function repoFromRepositoryUrl(repositoryUrl: string): string {
  const match = repositoryUrl.match(/\/repos\/([^/]+\/[^/]+)$/);
  if (!match) throw new Error(`github search item has an unexpected repository_url: ${repositoryUrl}`);
  return match[1]!;
}

function mentionEvent(item: z.infer<typeof searchItemSchema>): IngestEvent {
  const payload: GithubMentionPayload = {
    kind: "mention",
    repo: repoFromRepositoryUrl(item.repository_url),
    number: item.number,
    isPullRequest: item.pull_request !== undefined,
    title: item.title,
    url: item.html_url,
    body: item.body ?? "",
    author: item.user?.login ?? "unknown",
    updatedAt: item.updated_at,
  };
  // The payload above is built to satisfy the dispatcher's schema; the
  // dispatcher re-validates it anyway (fail-closed second gate).
  githubMentionPayloadSchema.parse(payload);
  return {
    provider: "github",
    eventType: "mention",
    payload,
    occurredAt: item.updated_at,
  };
}

/** The GitHub mentions poller (see module doc). */
export function createGithubPoller(opts: GithubPollerOpts = {}): Poller {
  const apiBaseUrl = (opts.apiBaseUrl ?? DEFAULT_GITHUB_API_BASE_URL).replace(/\/+$/, "");
  const tokenFile = opts.tokenFile ?? process.env.EXECUTOR_GIT_TOKEN_FILE ?? DEFAULT_GITHUB_TOKEN_FILE;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  // Boot-time baseline: mentions updated before construction are never
  // replayed (mirrors the scheduler runner's no-catch-up boot policy). With
  // the durable watermark seam, the first poll resumes from the persisted
  // cursor so a restart continues after the last processed event.
  let lastPolledAt = now();
  let watermarkSeeded = false;

  async function seedWatermark(): Promise<void> {
    if (!opts.watermark || watermarkSeeded) return;
    const cursor = await opts.watermark.getCursor();
    if (cursor !== null && cursor !== "") {
      const millis = Number(cursor);
      if (!Number.isNaN(millis)) lastPolledAt = millis;
    }
    watermarkSeeded = true;
  }
  let resolvedLogin: string | null = opts.login ?? null;

  function readToken(): string | null {
    if (!existsSync(tokenFile)) return null; // unconfigured → no-op
    try {
      const content = readFileSync(tokenFile, "utf8").trim();
      if (content.length === 0) throw new Error(`git token file is empty: ${tokenFile}`);
      return content;
    } catch (err) {
      throw new Error(`failed to read git token file ${tokenFile}: ${errorMessage(err)}`);
    }
  }

  async function resolveLogin(token: string): Promise<string> {
    if (resolvedLogin !== null) return resolvedLogin;
    const res = await fetchImpl(`${apiBaseUrl}/user`, {
      method: "GET",
      headers: { ...GITHUB_API_HEADERS, Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`github /user failed: ${res.status} ${res.statusText}`);
    const parsed = userSchema.safeParse(await res.json());
    if (!parsed.success) throw new Error("github /user returned an unexpected shape");
    resolvedLogin = parsed.data.login;
    return resolvedLogin;
  }

  async function poll(): Promise<IngestEvent[]> {
    await seedWatermark();
    const token = readToken();
    if (token === null) return [];
    const login = await resolveLogin(token);
    const query = encodeURIComponent(`mentions:${login} is:open`);
    const url = `${apiBaseUrl}/search/issues?q=${query}&sort=updated&order=desc&per_page=${SEARCH_PER_PAGE}`;
    const res = await fetchImpl(url, {
      method: "GET",
      headers: { ...GITHUB_API_HEADERS, Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`github search failed: ${res.status} ${res.statusText}`);
    const parsed = searchResponseSchema.safeParse(await res.json());
    if (!parsed.success) throw new Error("github search returned an unexpected shape");

    const cutoff = lastPolledAt;
    // The boundary advances past BOTH the wall clock and the newest item in
    // the response, so an item can never re-emit even when the API's
    // updated_at outruns our clock (skew, frozen test clocks).
    let boundary = now();
    const events: IngestEvent[] = [];
    for (const item of parsed.data.items) {
      const updated = Date.parse(item.updated_at);
      if (!Number.isNaN(updated) && updated > boundary) boundary = updated;
      if (Number.isNaN(updated) || updated <= cutoff) continue;
      events.push(mentionEvent(item));
    }
    lastPolledAt = boundary;
    await opts.watermark?.setCursor(String(boundary));
    return events;
  }

  return { poll };
}
