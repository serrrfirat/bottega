/**
 * Mem0 memory backend (issue #21).
 *
 * Wire contract: the mem0 OSS REST server (self-hosted, `server/` in
 * mem0ai/mem0; docs at docs.mem0.ai/open-source). Researched from the server
 * source (server/main.py) and OpenAPI:
 *
 *   POST /memories   — add. Body: `{ messages: [{role, content}],
 *                       user_id?, agent_id?, run_id?, metadata? }`.
 *                       At least one of user_id/agent_id/run_id is required.
 *                       Response: `{ "results": [{ id, memory, event,
 *                       user_id?, agent_id?, metadata?, created_at? }] }`.
 *   POST /search     — semantic search. Body: `{ query, filters?, top_k? }`
 *                       where filters holds identity fields (user_id,
 *                       agent_id, run_id) plus exact-match metadata keys.
 *                       Response: `{ "results": [{ id, memory, score,
 *                       user_id?, agent_id?, metadata?, created_at? }] }`.
 *   Auth             — `X-API-Key: <key>` header when an API key is set.
 *
 * Spec deviations from the issue's expectation (documented, per the issue:
 * "follow the API and document"):
 *  - The OSS server has NO `/v1/` prefix — that path set belongs to the
 *    hosted platform (api.mem0.ai). The OSS endpoints are `/memories` and
 *    `/search` (docs.mem0.ai/open-source/features/rest-api states this
 *    explicitly).
 *  - The OSS server has NO `org_id` param — mem0 only scopes by user_id,
 *    agent_id, run_id. Scope mapping:
 *      org  → `agent_id` = opts.agentId ?? MEM0_ORG_AGENT_ID (a fixed agent
 *             id makes org memory shared across all principals, matching
 *             the MemoryProvider contract). A principal passed for org scope
 *             is ignored (types.ts: "ignored for org scope").
 *      user → `user_id` = principal, plus `agent_id` passthrough when
 *             opts.agentId is configured.
 *  - `text` does not exist on add; content travels as the single
 *    `messages[0].content` (the SDK accepts a bare string as shorthand).
 *
 * Response mapping assumptions:
 *  - content = `results[0].memory` (the extracted/stored fact). When the
 *    server reports a NOOP (no fact extracted, `memory` null) we fall back
 *    to the input content so the entry stays meaningful.
 *  - principal = the entry's `user_id` (top-level, else `metadata.user_id`).
 *  - createdAt = Date.parse of `created_at` (ISO 8601 in the server's
 *    payload); 0 when absent/unparseable.
 *  - metadata values are coerced to strings (our contract is
 *    Record<string, string>; the server stores arbitrary JSON).
 *
 * Errors are never swallowed: non-2xx → Mem0Error with status + body
 * snippet; timeout → Mem0Error naming the op and deadline; network errors
 * are wrapped with context.
 */
import {
  MEMORY_LIMIT_DEFAULT,
  validateSaveInput,
  validateSearchQuery,
} from "./types";
import type {
  MemoryEntry,
  MemoryProvider,
  MemorySaveInput,
  MemorySearchQuery,
  MemoryScope,
} from "./types";

export interface Mem0Options {
  /** Base URL of the mem0 OSS REST server, e.g. http://localhost:8888. */
  baseUrl: string;
  /** Optional `X-API-Key` value (server-side auth; omit when AUTH_DISABLED). */
  apiKey?: string;
  /**
   * Agent id used for org-scope memories and passed through (alongside
   * user_id) on user-scope requests. Defaults to MEM0_ORG_AGENT_ID.
   */
  agentId?: string;
  /** Per-request timeout in ms. Default 10000. */
  timeoutMs?: number;
}

export const MEM0_DEFAULT_TIMEOUT_MS = 10_000;
/** Fixed agent_id backing org-scope memories when no agentId is configured. */
export const MEM0_ORG_AGENT_ID = "bottega";

/** Identity keys mem0 reserves for scoping; caller metadata may not set them. */
const IDENTITY_KEYS = new Set(["user_id", "agent_id", "run_id"]);

export class Mem0Error extends Error {
  readonly status: number | null;
  readonly body: string | null;

  constructor(message: string, opts: { status?: number; body?: string | null; cause?: unknown } = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "Mem0Error";
    this.status = opts.status ?? null;
    this.body = opts.body ?? null;
  }
}

/** Runtime-narrowed copy of arbitrary JSON into a plain record (no casts). */
export function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value));
}

function stringifyMetadata(meta: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(meta)) {
    out[key] = typeof value === "string" ? value : String(value);
  }
  return out;
}

function parseCreatedAt(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

/** Body snippet for error messages (kept short). */
function snippet(text: string, max = 200): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/** Scope mapping, see module docstring. */
function scopeParams(
  scope: MemoryScope,
  principal: string | undefined,
  agentId: string | undefined,
): Record<string, string> {
  if (scope === "org") {
    // Org memory is shared across principals: pin it to one agent id.
    return { agent_id: agentId ?? MEM0_ORG_AGENT_ID };
  }
  const params: Record<string, string> = { user_id: principal as string };
  if (agentId) params.agent_id = agentId;
  return params;
}

/** Strip identity keys from caller metadata (mirrors the SDK's behavior). */
function stripIdentityKeys(metadata: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (!IDENTITY_KEYS.has(key)) out[key] = value;
  }
  return out;
}

async function requestJson(
  baseUrl: string,
  path: string,
  method: "POST",
  body: unknown,
  apiKey: string | undefined,
  timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (apiKey) headers["x-api-key"] = apiKey;
  try {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Mem0Error(
        `mem0 ${method} ${path} failed: HTTP ${res.status} (${snippet(text) || "no body"})`,
        { status: res.status, body: text },
      );
    }
    if (text.trim() === "") return null;
    try {
      return JSON.parse(text) as unknown;
    } catch (err) {
      throw new Mem0Error(
        `mem0 ${method} ${path}: invalid JSON response (${snippet(text)})`,
        { body: text, cause: err },
      );
    }
  } catch (err) {
    if (err instanceof Mem0Error) throw err;
    if (controller.signal.aborted) {
      throw new Mem0Error(`mem0 ${method} ${path} timed out after ${timeoutMs}ms`, { cause: err });
    }
    const detail = err instanceof Error ? err.message : String(err);
    throw new Mem0Error(`mem0 ${method} ${path} request failed: ${detail}`, { cause: err });
  } finally {
    clearTimeout(timer);
  }
}

/** Parse one mem0 result dict (add or search) into a MemoryEntry. */
function parseEntry(result: unknown, scope: MemoryScope, principal: string | null): MemoryEntry {
  const row = asRecord(result);
  const meta = stringifyMetadata(asRecord(row.metadata));
  const entryPrincipal =
    scope === "user"
      ? (typeof row.user_id === "string" ? row.user_id : (meta.user_id ?? principal))
      : null;
  return {
    id: String(row.id ?? ""),
    scope,
    principal: entryPrincipal,
    content: typeof row.memory === "string" ? row.memory : "",
    metadata: meta,
    createdAt: parseCreatedAt(row.created_at),
  };
}

async function saveToMem0(
  baseUrl: string,
  apiKey: string | undefined,
  agentId: string | undefined,
  timeoutMs: number,
  input: MemorySaveInput,
): Promise<MemoryEntry> {
  const identity = scopeParams(input.scope, input.principal, agentId);
  const metadata = input.metadata ? stripIdentityKeys(input.metadata) : undefined;
  const data = await requestJson(
    baseUrl,
    "/memories",
    "POST",
    {
      messages: [{ role: "user", content: input.content }],
      ...identity,
      ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {}),
    },
    apiKey,
    timeoutMs,
  );
  const results = asRecord(data).results;
  const first = Array.isArray(results) ? results[0] : undefined;
  const row = asRecord(first);
  const id = row.id;
  if (id === undefined || id === null || id === "") {
    // e.g. a NOOP extraction with no stored row — nothing to hand back.
    throw new Mem0Error(
      "mem0 save: server returned no results (extraction produced nothing?)",
      { body: data === null ? null : JSON.stringify(data) },
    );
  }
  return {
    id: String(id),
    scope: input.scope,
    principal: input.scope === "user" ? (typeof row.user_id === "string" ? row.user_id : (input.principal ?? null)) : null,
    // NOOP entries carry memory: null — fall back to the input text.
    content: typeof row.memory === "string" && row.memory !== "" ? row.memory : input.content,
    metadata: stringifyMetadata(asRecord(row.metadata)),
    createdAt: parseCreatedAt(row.created_at),
  };
}

async function searchMem0(
  baseUrl: string,
  apiKey: string | undefined,
  agentId: string | undefined,
  timeoutMs: number,
  query: MemorySearchQuery,
): Promise<MemoryEntry[]> {
  // Scope first, then exact-match metadata filters. Identity keys in caller
  // metadata cannot override the scope (mirrors the SDK).
  const filters: Record<string, string> = {
    ...scopeParams(query.scope, query.principal, agentId),
    ...(query.metadata ? stripIdentityKeys(query.metadata) : {}),
  };
  const data = await requestJson(
    baseUrl,
    "/search",
    "POST",
    {
      query: query.query,
      filters,
      top_k: query.limit ?? MEMORY_LIMIT_DEFAULT,
    },
    apiKey,
    timeoutMs,
  );
  const results = asRecord(data).results;
  if (!Array.isArray(results)) return [];
  return results.map((result) =>
    parseEntry(result, query.scope, query.scope === "user" ? (query.principal ?? null) : null),
  );
}

export function createMem0MemoryProvider(opts: Mem0Options): MemoryProvider {
  const baseUrl = opts.baseUrl.trim().replace(/\/+$/, "");
  if (!baseUrl) {
    throw new Error("mem0: baseUrl is required");
  }
  const timeoutMs = opts.timeoutMs ?? MEM0_DEFAULT_TIMEOUT_MS;
  const apiKey = opts.apiKey;
  const agentId = opts.agentId;

  // NOTE: save/search are deliberately NOT async — validation must throw
  // synchronously so callers (and the conformance suite) see contract
  // violations as immediate throws, not rejected promises. Network work
  // happens in the async helpers below.
  return {
    save(input: MemorySaveInput): Promise<MemoryEntry> {
      validateSaveInput(input);
      return saveToMem0(baseUrl, apiKey, agentId, timeoutMs, input);
    },
    search(query: MemorySearchQuery): Promise<MemoryEntry[]> {
      validateSearchQuery(query);
      return searchMem0(baseUrl, apiKey, agentId, timeoutMs, query);
    },
  };
}
