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
 *    agent_id, run_id. Scope mapping (issue #137: SQLite and Mem0 share the
 *    same logical mapping):
 *      org   → `agent_id` = opts.agentId ?? MEM0_ORG_AGENT_ID (a fixed agent
 *             id makes org memory shared across all principals, matching
 *             the MemoryProvider contract).
 *      other → `user_id` = the logical key's physical principal composite
 *             (person → the raw principal; channel → `channel:<spaceId>`;
 *             team → `team:<teamId>`), so result rows decode to the same
 *             logical keys SQLite returns.
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
 * Operational failures are never swallowed: non-2xx → Mem0Error with status
 * + body snippet; timeout → Mem0Error naming the op and deadline; network
 * errors are wrapped with context. Capability discovery alone fails soft.
 */
import { z } from "zod";
import {
  MEMORY_LIMIT_DEFAULT,
  decodeScopeKey,
  encodeScopeKey,
  validateSaveInput,
  validateSearchQuery,
} from "./types";
import type {
  MemoryEntry,
  MemoryProvider,
  MemorySaveInput,
  MemorySearchQuery,
  MemoryScopeKey,
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

const MEM0_DEFAULT_TIMEOUT_MS = 10_000;
/** Fixed agent_id backing org-scope memories when no agentId is configured. */
export const MEM0_ORG_AGENT_ID = "bottega";

/** Identity keys mem0 reserves for scoping; caller metadata may not set them. */
const IDENTITY_KEYS = new Set(["user_id", "agent_id", "run_id"]);

/** One JSON value — the wire domain of the mem0 REST payloads. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** True when `value` is a non-array object (the typeof-free object test). */
function isPlainRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
  // Object(x) === x holds exactly for objects (primitives get boxed, so the
  // identity comparison fails) — equivalent to `typeof x === "object"`.
  return value !== undefined && value !== null && !Array.isArray(value) && Object(value) === value;
}

/** True when `value` is a string primitive (the typeof-free string test). */
function isString(value: JsonValue): value is string {
  // String(x) returns x itself exactly for string primitives.
  return String(value) === value;
}

/**
 * One `results[]` row of the mem0 add/search payloads, decoded at the HTTP
 * boundary. Non-conforming fields fall back to their absence value so a
 * malformed row still yields a meaningful MemoryEntry (the pre-schema code
 * narrowed the same fields ad hoc).
 */
const Mem0ResultSchema = z.object({
  id: z.union([z.string(), z.number()]).catch(""),
  user_id: z.string().catch("").transform((value) => (value === "" ? undefined : value)),
  memory: z.string().catch("").transform((value) => (value === "" ? undefined : value)),
  metadata: z.record(z.string(), z.json()).catch({}),
  created_at: z
    .union([z.number().finite(), z.string().transform((text) => Date.parse(text.trim()))])
    .catch(0)
    .transform((value) => (Number.isNaN(value) ? 0 : value)),
});

interface GraphCapabilities {
  add: boolean;
  search: boolean;
}

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
export function asRecord(value: JsonValue): Record<string, JsonValue> {
  if (!isPlainRecord(value)) return {};
  return Object.fromEntries(Object.entries(value));
}

/** Metadata values are coerced to strings (our contract is Record<string, string>). */
export function stringifyMetadata(meta: Record<string, JsonValue>) {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(meta)) {
    // String(s) === s for strings, and String(x) renders every other JSON value.
    out[key] = String(value);
  }
  return out;
}

/** Body snippet for error messages (kept short). */
function snippet(text: string, max = 200): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

type Mem0ScopeParams = { agent_id: string } | { user_id: string };

/** Scope mapping, see module docstring. */
function scopeParams(
  scope: MemoryScopeKey,
  agentId: string | undefined,
): Mem0ScopeParams {
  if (scope.kind === "org") {
    // Org memory is shared across principals: pin it to one agent id.
    return { agent_id: agentId ?? MEM0_ORG_AGENT_ID };
  }
  // Non-org logical scopes map to the physical principal composite key
  // (person → raw principal; channel/team → prefixed), matching SQLite.
  const physical = encodeScopeKey(scope);
  return { user_id: physical.principal ?? "" };
}

/** Strip identity keys from caller metadata (mirrors the SDK's behavior). */
function stripIdentityKeys(metadata: Record<string, string>) {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (!IDENTITY_KEYS.has(key)) out[key] = value;
  }
  return out;
}

async function requestJson(
  baseUrl: string,
  path: string,
  body: JsonValue,
  apiKey: string | undefined,
  timeoutMs: number,
): Promise<JsonValue | null> {
  const method = "POST";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers: Record<string, string> = {};
  headers["content-type"] = "application/json";
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
      // SAFETY: mem0's wire contract is JSON, so the parsed body is a JsonValue.
      return JSON.parse(text) as JsonValue;
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

function resolveOpenApiRef(document: Record<string, JsonValue>, ref: string): JsonValue | undefined {
  if (!ref.startsWith("#/")) return undefined;
  let current: JsonValue = document;
  for (const rawSegment of ref.slice(2).split("/")) {
    const segment = rawSegment.replaceAll("~1", "/").replaceAll("~0", "~");
    current = asRecord(current)[segment];
  }
  return current;
}

function schemaAdvertisesField(
  document: Record<string, JsonValue>,
  value: JsonValue | undefined,
  field: string,
  seen: Set<unknown> = new Set(),
): boolean {
  if (!isPlainRecord(value) || seen.has(value)) return false;
  seen.add(value);
  const record = value;
  if (Object.hasOwn(asRecord(record.properties), field)) return true;
  if (isString(record.$ref)) {
    return schemaAdvertisesField(document, resolveOpenApiRef(document, record.$ref), field, seen);
  }
  for (const key of ["allOf", "anyOf", "oneOf"]) {
    const variants = record[key];
    if (Array.isArray(variants) && variants.some((item) => schemaAdvertisesField(document, item, field, seen))) {
      return true;
    }
  }
  return false;
}

function operationAdvertisesGraph(document: Record<string, JsonValue>, path: string): boolean {
  const operation = asRecord(asRecord(asRecord(document.paths)[path]).post);
  const content = asRecord(asRecord(operation.requestBody).content);
  const schema = asRecord(content["application/json"]).schema;
  return schemaAdvertisesField(document, schema, "enable_graph");
}

/**
 * Older graph-store-enabled mem0 servers advertise `enable_graph` in their
 * OpenAPI request schemas. Newer servers have native graph ranking always on
 * and omit the flag, so a normal vector-shaped request is also the correct
 * request for them. A missing/unreachable OpenAPI document must not disable
 * ordinary memory operations.
 */
async function discoverGraphCapabilities(
  baseUrl: string,
  apiKey: string | undefined,
  timeoutMs: number,
): Promise<GraphCapabilities> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers: Record<string, string> = {};
  if (apiKey) headers["x-api-key"] = apiKey;
  try {
    const response = await fetch(`${baseUrl}/openapi.json`, {
      headers,
      signal: controller.signal,
    });
    if (!response.ok) return { add: false, search: false };
    const document = asRecord(z.json().parse(await response.json()));
    return {
      add: operationAdvertisesGraph(document, "/memories"),
      search: operationAdvertisesGraph(document, "/search"),
    };
  } catch {
    return { add: false, search: false };
  } finally {
    clearTimeout(timer);
  }
}

async function requestWithOptionalGraph(
  baseUrl: string,
  path: string,
  body: Record<string, JsonValue>,
  apiKey: string | undefined,
  timeoutMs: number,
  graphEnabled: boolean,
  disableGraph: () => void,
): Promise<JsonValue | null> {
  if (!graphEnabled) return requestJson(baseUrl, path, body, apiKey, timeoutMs);
  try {
    return await requestJson(baseUrl, path, { ...body, enable_graph: true }, apiKey, timeoutMs);
  } catch (error) {
    // Only a schema-rejection that names the optional field proves graph is
    // unsupported. Retrying other 400/422 failures could duplicate an add.
    const unsupported =
      error instanceof Mem0Error &&
      (error.status === 400 || error.status === 422) &&
      /enable_graph/i.test(error.body ?? "");
    if (!unsupported) throw error;
    disableGraph();
    return requestJson(baseUrl, path, body, apiKey, timeoutMs);
  }
}

/** Parse one mem0 result dict (add or search) into a MemoryEntry. */
function parseEntry(result: JsonValue, scope: MemoryScopeKey): MemoryEntry {
  const parsed = Mem0ResultSchema.safeParse(result);
  const row = parsed.success ? parsed.data : Mem0ResultSchema.parse({});
  const meta = stringifyMetadata(row.metadata);
  // The identity field holds the physical principal composite key; decode it
  // back to the logical key (matches the SQLite decode, so both backends
  // expose identical logical scope behavior). The requested scope is the
  // authority; the row's user_id only refines the person key when present.
  const identity = row.user_id ?? undefined;
  let key = scope;
  if (scope.kind === "org") {
    key = { kind: "org" };
  } else {
    const physical = identity !== undefined ? identity : encodeScopeKey(scope).principal ?? "";
    key = decodeScopeKey("user", physical);
  }
  return {
    id: String(row.id ?? ""),
    key,
    content: row.memory ?? "",
    metadata: meta,
    createdAt: row.created_at,
  };
}

async function saveToMem0(
  baseUrl: string,
  apiKey: string | undefined,
  agentId: string | undefined,
  timeoutMs: number,
  getGraphCapabilities: () => Promise<GraphCapabilities>,
  input: MemorySaveInput,
): Promise<MemoryEntry> {
  const identity = scopeParams(input.scope, agentId);
  const metadata = input.metadata ? stripIdentityKeys(input.metadata) : undefined;
  const body = {
    messages: [{ role: "user", content: input.content }],
    ...identity,
    ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : undefined),
  };
  const graph = await getGraphCapabilities();
  const data = await requestWithOptionalGraph(
    baseUrl,
    "/memories",
    body,
    apiKey,
    timeoutMs,
    graph.add,
    () => {
      graph.add = false;
    },
  );
  // mem0 consolidates server-side during add: it extracts candidate facts,
  // compares them with the scoped active pool, then emits ADD/UPDATE/DELETE
  // (or no change) while retaining its own history. Our save maps the active
  // result to MemoryEntry; bottega's separate audit remains append-only.
  const results = asRecord(data).results;
  const first = Array.isArray(results) ? results[0] : undefined;
  const parsed = Mem0ResultSchema.safeParse(first ?? null);
  const row = parsed.success ? parsed.data : Mem0ResultSchema.parse({});
  const id = row.id;
  if (id === "") {
    // e.g. a NOOP extraction with no stored row — nothing to hand back.
    throw new Mem0Error(
      "mem0 save: server returned no results (extraction produced nothing?)",
      { body: data === null ? null : JSON.stringify(data) },
    );
  }
  return {
    id: String(id),
    key: input.scope,
    // NOOP entries carry memory: null — fall back to the input text.
    content: row.memory !== undefined && row.memory !== "" ? row.memory : input.content,
    metadata: stringifyMetadata(row.metadata),
    createdAt: row.created_at,
  };
}

async function searchMem0(
  baseUrl: string,
  apiKey: string | undefined,
  agentId: string | undefined,
  timeoutMs: number,
  getGraphCapabilities: () => Promise<GraphCapabilities>,
  query: MemorySearchQuery,
): Promise<MemoryEntry[]> {
  // Scope first, then exact-match metadata filters. Identity keys in caller
  // metadata cannot override the scope (mirrors the SDK).
  const filters = {
    ...scopeParams(query.scope, agentId),
    ...(query.metadata ? stripIdentityKeys(query.metadata) : undefined),
  };
  const body = {
    query: query.query,
    filters,
    top_k: query.limit ?? MEMORY_LIMIT_DEFAULT,
  };
  const graph = await getGraphCapabilities();
  const data = await requestWithOptionalGraph(
    baseUrl,
    "/search",
    body,
    apiKey,
    timeoutMs,
    graph.search,
    () => {
      graph.search = false;
    },
  );
  const results = asRecord(data).results;
  if (!Array.isArray(results)) return [];
  return results.map((result) => parseEntry(result, query.scope));
}

export function createMem0MemoryProvider(opts: Mem0Options): MemoryProvider {
  const baseUrl = opts.baseUrl.trim().replace(/\/+$/, "");
  if (!baseUrl) {
    throw new Error("mem0: baseUrl is required");
  }
  const timeoutMs = opts.timeoutMs ?? MEM0_DEFAULT_TIMEOUT_MS;
  const apiKey = opts.apiKey;
  const agentId = opts.agentId;
  let graphCapabilities: Promise<GraphCapabilities> | undefined;
  const getGraphCapabilities = (): Promise<GraphCapabilities> => {
    graphCapabilities ??= discoverGraphCapabilities(baseUrl, apiKey, timeoutMs);
    return graphCapabilities;
  };

  const capabilities = {
    consolidation: "on-save",
    digestPruning: "unsupported",
  } as const;

  // NOTE: save/search are deliberately NOT async — validation must throw
  // synchronously so callers (and the conformance suite) see contract
  // violations as immediate throws, not rejected promises. Network work
  // happens in the async helpers below.
  return {
    capabilities,
    save(input: MemorySaveInput): Promise<MemoryEntry> {
      validateSaveInput(input);
      return saveToMem0(baseUrl, apiKey, agentId, timeoutMs, getGraphCapabilities, input);
    },
    search(query: MemorySearchQuery): Promise<MemoryEntry[]> {
      validateSearchQuery(query);
      return searchMem0(baseUrl, apiKey, agentId, timeoutMs, getGraphCapabilities, query);
    },
    pruneDigests(_spaceId: string, _keep: number): Promise<number> {
      return Promise.reject(
        new Error(
          "mem0 memory provider does not support required digest pruning; " +
            "the configured backend cannot enforce the per-space digest cap",
        ),
      );
    },
  };
}
