/**
 * Mnesis memory backend (issue #348, epic #132/#223).
 *
 * Thin ADR-compliant translation: bottega's {@link MemoryProvider} seam →
 * the mnesis memory-server MCP surface over Streamable HTTP (`POST /mcp`).
 * No bespoke memory logic lives in core — this module only maps bottega's
 * save/search/provenance contract onto mnesis's first-class structured
 * fields, exactly as the #348 GO conditions resolved.
 *
 * ## Forget semantics — VERIFIED (issue #348, step 1)
 * The mnesis memory MCP tool surface has **no delete/forget tool**. The
 * canonical manifest `manifests/mcp-tools.json` (checked into the mnesis
 * checkout) lists the complete memory tool catalog: the write side is
 * add-only (`memory_add_fact`, `memory_add_learning`, `memory_add_session`,
 * `memory_feedback`, `memory_record_interaction`, `task_update_status`,
 * `task_write`) and every write tool admits `additionalProperties:false`
 * (verified live in the Aug-18 PoC `/private/tmp/mnesis-poc` schemas). A
 * source sweep of the memory engine found no `memory_delete`/`forget`/
 * `retract`/`remove`/`purge` tool anywhere.
 *
 * Verdict: `capabilities.forget = "unsupported"` and `forget()` rejects
 * loudly — never a silent hard-delete (issue #163), matching the ADR's
 * capability negotiation. This is the capability-flagged gap, not a
 * reimplementation.
 *
 * ## Metadata mapping (GO condition 1) — first-class fields, NOT a
 * `<meta>JSON</meta>` content convention
 * `memory_add_learning` (live schema) exposes these structured fields:
 * `session_id`, `event_type` (enum success|failure|insight|mistake|
 * decision), `context`, `learning`, `approach`, `neurons[]`,
 * `emotional_valence`, `consolidation_strength`, `operation_id`. The
 * adapter maps bottega's save onto those first-class fields:
 *   - `content`                     → `learning` (the extractable knowledge)
 *   - logical `scope`               → `session_id` = `bottega:<scope-label>`
 *     (`bottega:org`, `bottega:person:U1`, `bottega:channel:slack:C1`,
 *     `bottega:team:eng`). mnesis sessions group related learnings, so the
 *     logical scope rides in the exact field the tool exists for.
 *   - `metadata.kind`               → `event_type` (clamped to the mnesis
 *     enum; a kind outside the enum falls back to `insight` and is kept as
 *     a `neurons` tag `kind:…` so nothing is lost).
 *   - `metadata` remaining keys     → `neurons[]` tags `key:value`
 *     (structured array, searchable — mnesis tags are a first-class field).
 *   - provenance `source`/`spaceId` → `neurons` tags `source:…`/`space:…`
 *     plus a `context` line. Provenance is first-class on search results
 *     (the result `provenance` object + `authorization.ownerScope`), so it
 *     round-trips through the response rather than a content hack.
 *   - `operation_id`                → a stable, idempotent retry identity
 *     derived from the save input (mnesis "Stable retry identity").
 *
 * ## Search / provenance
 * `memory_search` returns `structuredContent.results[]`; each result
 * carries `recordId`, the textual memory, and a first-class `provenance`
 * object plus an `authorization.ownerScope` (tenant/principal/agent/
 * project). The adapter maps those back into {@link MemoryProvenance} and
 * re-derives the logical key from the `session_id` the row was written
 * under. Scope filtering stays server-side: tenant isolation is enforced by
 * `x-tenant-id` + the credential, and sub-scope (person/channel/team) by
 * the `session_id` the search targets.
 *
 * ## Auth / tenancy (GO conditions 2 + 3)
 * The adapter is constructed with one org-scope principal credential
 * (minted during first-run onboarding, held in the vault boot-secret
 * chain, rotatable via the settings tool) and the org's workspace binding.
 * Every request carries `x-tenant-id: <tenant>` and
 * `Authorization: Bearer <token>`; the credential's `tenants` allowlist
 * must include the tenant (wrong-tenant → the server 401s, failing closed).
 * The embedding endpoint is a deployment prerequisite checked at BOOT (a
 * separate probe), NOT at adapter construction: writes fail closed against
 * an unreachable memory server. Consistent with mem0, save/search do NOT
 * need the embedding URL — that is the server's write path dependency.
 *
 * ## Capabilities
 *  - consolidation: `on-save` — mnesis consolidates learning during add
 *    (adaptive features + session/event grouping); bottega runs no
 *    scheduled compactor for it.
 *  - digestPruning: `unsupported` — mnesis has no per-space digest-cap
 *    primitive; `pruneDigests` rejects loudly.
 *  - forget: `unsupported` — no delete tool (see verdict above).
 */
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type {
  CallToolResult,
  ClientResult,
} from "@modelcontextprotocol/sdk/types.js";
import {
  MEMORY_LIMIT_DEFAULT,
  decodeScopeKey,
  scopeKeyLabel,
  validateSaveInput,
  validateSearchQuery,
} from "./types";
import type {
  MemoryEntry,
  MemoryProvenance,
  MemoryProvider,
  MemorySaveInput,
  MemorySearchQuery,
  MemoryScopeKey,
  MemoryTombstone,
} from "./types";

export interface MnesisOptions {
  /**
   * Memory-server MCP endpoint, e.g. `http://127.0.0.1:17802/mcp`.
   * Required; trailing slashes are trimmed.
   */
  baseUrl: string;
  /** The org's mnesis workspace / tenant id — sent as `x-tenant-id`. */
  tenantId: string;
  /** Principal label attached to sessions (`bottega:<label>` is the session id). */
  principalId: string;
  /** The org-wide principal credential bearer token (vault-held). */
  token: string;
  /** Optional per-request timeout in ms; default 10000. */
  timeoutMs?: number;
}

const MNESIS_DEFAULT_TIMEOUT_MS = 10_000;

/** Membership map for the static mnesis `event_type` enum (string-keyed). */
type MnesisEventTypeLookup = Record<string, true>;

/** The mnesis `event_type` enum accepted by `memory_add_learning`. */
const MNESIS_EVENT_TYPES = {
  success: true,
  failure: true,
  insight: true,
  mistake: true,
  decision: true,
} satisfies MnesisEventTypeLookup;
const MNESIS_DEFAULT_EVENT = "insight";

/** True when `kind` is a first-class mnesis `event_type`. */
function isMnesisEventType(kind: string | undefined): boolean {
  return kind !== undefined && kind in MNESIS_EVENT_TYPES;
}

/** Prefix for the deterministic `session_id` derived from a logical scope. */
const SESSION_PREFIX = "bottega:";

/** One JSON value — the wire domain of the mnesis MCP payloads. */
export type MnesisJsonValue = string | number | boolean | null | MnesisJsonValue[] | { [key: string]: MnesisJsonValue };

/** Body snippet for error messages (kept short). */
function snippet(text: string, max = 240): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/**
 * Raised on any operational failure (non-2xx, timeout, unreachable server,
 * MCP protocol error, wrong-tenant 401). Distinguishes an unsupported-
 * operation rejection (capability-flagged) from a transport failure so
 * callers can tell "this backend can't forget" from "the server is down".
 */
export class MnesisError extends Error {
  readonly code: number | null;
  readonly status: number | null;

  constructor(
    message: string,
    opts: { code?: number | null; status?: number | null; cause?: unknown } = {},
  ) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "MnesisError";
    this.code = opts.code ?? null;
    this.status = opts.status ?? null;
  }
}

/**
 * Maps a bottega logical scope to its deterministic mnesis `session_id`.
 * Exported (stable domain concept): the conformance + integration suites
 * assert on the exact session id a save targets.
 */
export function mnesisSessionId(scope: MemoryScopeKey): string {
  return `${SESSION_PREFIX}${scopeKeyLabel(scope)}`;
}

/** Decodes a `bottega:<scope-label>` session id back to its logical key. */
function sessionScope(sessionId: string | null, fallback: MemoryScopeKey): MemoryScopeKey {
  if (!sessionId || !sessionId.startsWith(SESSION_PREFIX)) return fallback;
  const label = sessionId.slice(SESSION_PREFIX.length);
  if (label === "org") return { kind: "org" };
  return decodeScopeKey("user", label);
}

/** Clamps a bottega `metadata.kind` to the mnesis `event_type` enum. */
function eventTypeForKind(kind: string | undefined): string {
  if (kind !== undefined && isMnesisEventType(kind)) return kind;
  return MNESIS_DEFAULT_EVENT;
}

/** Encodes one metadata/provenance key to a mnesis `neurons` tag. */
function asTag(key: string, value: string): string {
  return `${key}:${value}`;
}

/**
 * Builds the `neurons[]` tags for a save: provenance (source/space/scope)
 * plus every caller metadata key, plus the raw `kind` when it fell outside
 * the mnesis enum (so `metadata.kind` is never silently dropped).
 */
function buildNeurons(
  metadata: Record<string, string> | undefined,
  source: string,
  spaceId: string | null,
  scopeLabel: string,
  kind: string | undefined,
): string[] {
  const neurons = new Set<string>();
  neurons.add(asTag("source", source));
  if (spaceId) neurons.add(asTag("space", spaceId));
  neurons.add(asTag("scope", scopeLabel));
  for (const [key, value] of Object.entries(metadata ?? {})) {
    if (key === "kind" && isMnesisEventType(value)) continue; // carried as event_type
    neurons.add(asTag(key, value));
  }
  if (kind !== undefined && !isMnesisEventType(kind)) {
    neurons.add(asTag("kind", kind));
  }
  return [...neurons];
}

/** A provenance context line on the real `context` field (not a content hack). */
function buildContext(source: string, spaceId: string | null, principal: string | null, scopeLabel: string): string {
  const parts = [`source=${source}`, `scope=${scopeLabel}`];
  if (spaceId) parts.push(`space=${spaceId}`);
  if (principal) parts.push(`principal=${principal}`);
  return parts.join(", ");
}

/** Maps a caller `emotional_valence`/`tone` metadata value onto the mnesis enum, else neutral. */
function emotionalValenceFor(metadata: Record<string, string>): string {
  const value = metadata.emotional_valence ?? metadata.tone ?? "neutral";
  return value === "positive" || value === "negative" ? value : "neutral";
}

/** A stable short hash for the idempotent operation_id (session-local, non-crypto). */
function stableHash(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) {
    h = (h * 33) ^ text.charCodeAt(i);
  }
  return (h >>> 0).toString(36);
}

/** Extracts the `text` content blocks from an MCP tool result (post-format merge). */
function toolText(result: CallToolResult): string {
  const content = Array.isArray(result.content) ? result.content : [];
  return content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

/**
 * One `structuredContent.results[]` row of a `memory_search` response,
 * decoded at the wire boundary. Non-conforming fields fall back to their
 * absence value so a malformed row still yields a meaningful MemoryEntry
 * (mirrors the mem0 result schema).
 */
const MnesisSearchRowSchema = z.object({
  recordId: z.string().catch(""),
  session_id: z.string().catch(""),
  sessionId: z.string().catch(""),
  memory: z.string().catch(""),
  content: z.string().catch(""),
  text: z.string().catch(""),
  fact: z.string().catch(""),
  neurons: z.array(z.string()).catch([]),
  provenance: z
    .object({
      source: z.string().nullable().catch(null),
      spaceId: z.string().nullable().catch(null),
      principalId: z.string().nullable().catch(null),
      memoryType: z.string().nullable().catch(null),
      confidence: z.number().nullable().catch(null),
    })
    .optional(),
  authorization: z
    .object({
      ownerScope: z
        .object({
          tenantId: z.string().nullable().catch(null),
          principalId: z.string().nullable().catch(null),
          agentId: z.string().nullable().catch(null),
          projectId: z.string().nullable().catch(null),
        })
        .optional(),
    })
    .optional(),
});

/** The seeded memory text extracted from a decoded search row. */
function rowContent(row: z.infer<typeof MnesisSearchRowSchema>): string {
  return row.memory || row.content || row.text || row.fact || "";
}

/** The session id a decoded search row was written under (either casing). */
function rowSessionId(row: z.infer<typeof MnesisSearchRowSchema>): string | null {
  return row.session_id || row.sessionId || null;
}

/** Decodes `neurons[]` tag entries back into a metadata map (provenance tags excluded). */
function tagsToMetadata(row: z.infer<typeof MnesisSearchRowSchema>) {
  const out: Record<string, string> = {};
  for (const tag of row.neurons) {
    const idx = tag.indexOf(":");
    if (idx < 1) continue;
    const key = tag.slice(0, idx);
    const value = tag.slice(idx + 1);
    // Provenance/scope tags are not caller metadata — they re-enter via
    // {@link MemoryProvenance}, not the metadata map.
    if (key === "source" || key === "scope" || key === "space") continue;
    out[key] = value;
  }
  return out;
}

/** Derives {@link MemoryProvenance} from a decoded search row + resolved scope key. */
function provenanceFromRow(
  row: z.infer<typeof MnesisSearchRowSchema>,
  key: MemoryScopeKey,
): MemoryProvenance {
  const prov = row.provenance;
  const ownerScope = row.authorization?.ownerScope;
  const spaceId = prov?.spaceId ?? ownerScope?.agentId ?? null;
  const principal =
    prov?.principalId ??
    ownerScope?.principalId ??
    (key.kind === "person" ? key.principal : null);
  return {
    source: prov?.source ?? "tool",
    spaceId,
    principal,
    scopeLabel: scopeKeyLabel(key),
  };
}

/**
 * A lazily-connected MCP client bound to one tenant + credential. The
 * connection (initialize + server capabilities) is established lazily on
 * the first tool call and reused thereafter, so construction never touches
 * the network and every operation fails closed against an unreachable or
 * unauthorized server.
 */
interface MnesisClient {
  callTool(name: string, args: MnesisJsonValue): Promise<CallToolResult>;
  close(): Promise<void>;
}

async function withTimeout<T>(run: () => Promise<T>, timeoutMs: number, message: string): Promise<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  const timer = setTimeout(() => reject(new MnesisError(message)), timeoutMs);
  let settled = false;
  const settle = (fn: () => void) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    fn();
  };
  run().then(
    (value) => settle(() => resolve(value)),
    // SAFETY: `.then` rejection values are Error-like `unknown`; rejecting
    // with the unwrapped MnesisError (or the original) preserves the cause.
    (err) => settle(() => reject(err as Error)),
  );
  return promise;
}

async function connectClient(opts: MnesisOptions): Promise<MnesisClient> {
  const base = opts.baseUrl.trim().replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new MnesisError(`mnesis: baseUrl is not a valid URL: ${base}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new MnesisError(`mnesis: baseUrl must be an http(s) URL (got "${url.protocol}")`);
  }
  const timeoutMs = opts.timeoutMs ?? MNESIS_DEFAULT_TIMEOUT_MS;
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: {
      headers: {
        "x-tenant-id": opts.tenantId,
        Authorization: `Bearer ${opts.token}`,
      },
    },
  });
  const client = new Client({ name: "bottega-memory", version: "348" });
  try {
    await withTimeout(
      () => client.connect(transport),
      timeoutMs,
      `mnesis: connecting to ${base} timed out after ${timeoutMs}ms`,
    );
  } catch (err) {
    await transport.close().catch(() => undefined);
    if (err instanceof MnesisError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    if (/401|Unauthorized|Invalid Request/.test(`${message} ${err}`)) {
      throw new MnesisError(
        `mnesis: ${base} rejected the credential (wrong tenant or bad token) — ` +
          "the org credential's tenants allowlist must include the configured x-tenant-id",
        { status: 401, cause: err },
      );
    }
    throw new MnesisError(`mnesis: connecting to ${base} failed: ${snippet(message)}`, { cause: err });
  }
  return {
    async callTool(name, args) {
      let result: ClientResult;
      try {
        result = await withTimeout(
          () => {
            // SAFETY: `args` is a MnesisJsonValue object literal (our wire
            // domain); the SDK's params type is unknown-shaped, so the request
            // is projected at the SDK boundary.
            const request = { name, arguments: args } as never;
            return client.callTool(request);
          },
          timeoutMs,
          `mnesis: tool ${name} timed out after ${timeoutMs}ms`,
        );
      } catch (err) {
        if (err instanceof MnesisError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        if (/401|Unauthorized/.test(message)) {
          throw new MnesisError(
            `mnesis: ${base} rejected the credential on ${name} (wrong tenant or bad token)`,
            { status: 401, cause: err },
          );
        }
        if (/-32602|not found|rejects unknown MCP permissions/.test(message)) {
          // The surface is permission-filtered: our credential lacks this tool.
          throw new MnesisError(
            `mnesis: tool ${name} is not available for this credential on ${base} — ` +
              "the principal's permission set does not admit this operation",
            { code: -32602, cause: err },
          );
        }
        throw new MnesisError(`mnesis: tool ${name} (${base}) failed: ${snippet(message)}`, { cause: err });
      }
      // SAFETY: `client.callTool` returns the SDK's CallToolResult (content +
      // structuredContent); ClientResult is its supertype alias, so the
      // returned value is already the concrete result shape.
      return result as CallToolResult;
    },
    async close() {
      await client.close().catch(() => undefined);
      await transport.close().catch(() => undefined);
    },
  };
}

/** The mnesis search tool arguments this adapter targets. */
function searchArgs(query: MemorySearchQuery): MnesisJsonValue {
  return {
    query: query.query,
    session_id: mnesisSessionId(query.scope),
    limit: query.limit ?? MEMORY_LIMIT_DEFAULT,
    ...(query.metadata !== undefined && Object.keys(query.metadata).length > 0
      ? { filters: query.metadata }
      : undefined),
  };
}

async function saveToMnesis(
  client: MnesisClient,
  input: MemorySaveInput,
  principalId: string,
): Promise<MemoryEntry> {
  const metadata = input.metadata ?? {};
  const kind = metadata.kind;
  const scopeLabel = scopeKeyLabel(input.scope);
  const spaceId = metadata.spaceId ?? (input.scope.kind === "channel" ? input.scope.spaceId : null);
  const principal = input.scope.kind === "person" ? input.scope.principal : null;
  const source = input.source ?? "tool";
  const sessionId = mnesisSessionId(input.scope);
  const neurons = buildNeurons(metadata, source, spaceId, scopeLabel, kind);
  // A stable, idempotent retry identity — mnesis "Stable retry identity".
  const operationId = `${principalId}-${sessionId}-${stableHash(input.content)}`;

  const result = await client.callTool("memory_add_learning", {
    session_id: sessionId,
    event_type: eventTypeForKind(kind),
    learning: input.content,
    context: buildContext(source, spaceId, principal, scopeLabel),
    neurons,
    operation_id: operationId,
    emotional_valence: emotionalValenceFor(metadata),
  });

  if (result.isError === true) {
    throw new MnesisError(
      `mnesis: memory_add_learning rejected: ${snippet(toolText(result)) || "MCP error"}`,
      { code: -32602 },
    );
  }

  return {
    id: `${sessionId}-${operationId}`,
    key: input.scope,
    content: input.content,
    metadata: Object.fromEntries(
      Object.entries(metadata).filter(([k]) => k !== "kind" || !isMnesisEventType(k)),
    ),
    createdAt: Date.now(),
    provenance: { source, spaceId, principal, scopeLabel },
  };
}

async function searchMnesis(client: MnesisClient, query: MemorySearchQuery): Promise<MemoryEntry[]> {
  const result = await client.callTool("memory_search", searchArgs(query));
  if (result.isError === true) {
    throw new MnesisError(
      `mnesis: memory_search rejected: ${snippet(toolText(result)) || "MCP error"}`,
      { code: -32602 },
    );
  }
  // SAFETY: `structuredContent` is MCP wire JSON (`Record<string, unknown>`);
  // the `results` array holds the memory_search response rows, each parsed
  // through `MnesisSearchRowSchema` at this I/O boundary.
  const structured = result.structuredContent ?? {};
  const rows = Array.isArray(structured.results) ? structured.results : [];
  return rows.map((row) => {
    const parsed = MnesisSearchRowSchema.parse(row);
    const key = sessionScope(rowSessionId(parsed), query.scope);
    const content = rowContent(parsed);
    return {
      id: parsed.recordId || `${keyToSession(key)}-${stableHash(content)}`,
      key,
      content,
      metadata: tagsToMetadata(parsed),
      createdAt: 0,
      provenance: provenanceFromRow(parsed, key),
    };
  });
}

/** Session id for a key (used for a fallback entry id when the row has none). */
function keyToSession(key: MemoryScopeKey): string {
  return mnesisSessionId(key);
}

export function createMnesisMemoryProvider(opts: MnesisOptions): MemoryProvider {
  const baseUrl = opts.baseUrl.trim().replace(/\/+$/, "");
  if (!baseUrl) throw new Error("mnesis: baseUrl is required");
  if (!opts.tenantId || !opts.tenantId.trim()) throw new Error("mnesis: tenantId is required");
  if (!opts.token) throw new Error("mnesis: token is required");

  let clientPromise: Promise<MnesisClient> | undefined;
  const getClient = (): Promise<MnesisClient> => {
    clientPromise ??= connectClient({ ...opts, baseUrl });
    return clientPromise;
  };

  const capabilities = {
    consolidation: "on-save",
    digestPruning: "unsupported",
    forget: "unsupported",
  } as const;

  // NOTE: save/search are deliberately NOT async — validation must throw
  // synchronously so callers (and the conformance suite) see contract
  // violations as immediate throws, not rejected promises. Network work
  // happens in the async helpers below.
  return {
    capabilities,
    save(input: MemorySaveInput): Promise<MemoryEntry> {
      validateSaveInput(input);
      return getClient().then((client) => saveToMnesis(client, input, opts.principalId));
    },
    search(query: MemorySearchQuery): Promise<MemoryEntry[]> {
      validateSearchQuery(query);
      return getClient().then((client) => searchMnesis(client, query));
    },
    pruneDigests(): Promise<number> {
      return Promise.reject(
        new Error(
          "mnesis memory provider does not support required digest pruning; " +
            "the configured backend cannot enforce the per-space digest cap",
        ),
      );
    },
    forget(): Promise<MemoryTombstone> {
      return Promise.reject(
        new Error(
          "mnesis memory provider does not support forget; the backend's memory MCP surface has " +
            "no delete/forget tool (verified, issue #348), so it cannot leave a tombstone — " +
            "refusing to silently hard-delete (issue #163)",
        ),
      );
    },
  };
}
