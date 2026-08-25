/**
 * Org graph view (issue #357): a READ-MODEL people↔projects↔decisions
 * projection assembled by querying the tables that already exist — zero new
 * storage, zero new dependencies. The graph is a VIEW, not a migration
 * (#351/#138 acceleration): work items, principals, spaces, repos,
 * scheduler jobs, and durable memories already carry every edge the org
 * needs; what was missing was one queryable shape over them.
 *
 * Edges derived from existing columns/JSON blobs:
 *   work-item --created-->      person (requester)
 *   work-item --assigned-->     person (assignee, issue #159)
 *   work-item --approved-by-->  person (approvals JSON array)
 *   work-item --delivered-->    pr     (pr_url column / result.pr_url /
 *                                       evidence[].url pull requests)
 *   work-item --targets-->      repo   (repo column)
 *   job       --created-->      person (scheduler_jobs.created_by)
 *   job       --scheduled-in--> space  (scheduler_jobs.space_id)
 *   memory    --decided-in-->   space  (channel scope key / mem_space_id)
 *   memory    --created-->      person (person scope key / provenance)
 *   memory    --mentions-->     work-item (body references the item id)
 *
 * `depends-on` (#165) and `forked-from` (#358) are part of {@link EdgeRel}
 * so the executor can land dependency/fork checks on this edge model
 * without another migration; no table writes them yet, so the projection
 * never emits them until their columns exist.
 *
 * Multi-hop traversal (`neighbors`) runs as a SQLite recursive CTE — the
 * traversal never leaves the database engine. Every query is BOUNDED and
 * FAIL-CLOSED: depth capped at {@link DEFAULT_MAX_DEPTH} hops (validated to
 * 1..8) and a hard node ceiling of {@link DEFAULT_MAX_NODES}; exceeding
 * either throws {@link GraphBoundError} rather than silently truncating.
 *
 * Memory backends: the default SQLite provider SHARES the store database,
 * so decision/memory nodes are plain reads here. Remote backends (mnesis)
 * are stitched in through the {@link GraphMemoryRecall} seam ONLY for
 * term-driven queries ({@link ProjectGraphOpts.terms}) — entity recall via
 * the provider's own search. A remote backend with no terms contributes
 * nothing (fail-closed: this layer never bulk-dumps a remote system).
 */
import { z } from "@oh-my-pi/pi-coding-agent";
import type { Database } from "bun:sqlite";
import {
  CHANNEL_KEY_PREFIX,
  decodeScopeKey,
  type MemoryEntry,
  type MemoryProvider,
  type MemoryScopeKey,
  type MemorySearchQuery,
} from "../memory/types";
import type { Store } from "../store/db";

/** Node kinds in the projected graph. */
export type GraphNodeKind = "work-item" | "memory" | "person" | "space" | "repo" | "job" | "pr";

/** A node reference — the stable handle used in queries and edges. */
export interface NodeRef {
  kind: GraphNodeKind;
  id: string;
}

/**
 * Edge relationships. See the module docstring for each relation's
 * derivation; `depends-on`/`forked-from` are reserved (#165/#358).
 */
export type EdgeRel =
  | "created"
  | "assigned"
  | "approved-by"
  | "delivered"
  | "targets"
  | "scheduled-in"
  | "decided-in"
  | "mentions"
  | "depends-on"
  | "forked-from";

/** Where a node came from (#163 receipts pattern): producer, space, principal. */
export interface GraphProvenance {
  source: string;
  spaceId: string | null;
  principal: string | null;
}

/** One projected node. `provenance` is ALWAYS present on memory nodes. */
export interface GraphNode extends NodeRef {
  label: string;
  createdAt: number | null;
  provenance?: GraphProvenance;
}

/** One projected directed edge. */
export interface GraphEdge {
  from: NodeRef;
  to: NodeRef;
  rel: EdgeRel;
}

/** A node/edge projection. */
export interface GraphProjection {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** Default traversal depth cap for {@link neighbors} (issue test: depth ≤2). */
export const DEFAULT_MAX_DEPTH = 2;
/** Hard node ceiling for any projection or traversal (fail-closed bound). */
export const DEFAULT_MAX_NODES = 500;
/** Depth validation ceiling — a walk deeper than this is a caller bug. */
const MAX_DEPTH_LIMIT = 8;
/** Term-clause ceiling for local memory recall. */
const TERM_LIMIT_MAX = 8;
/** Per-call cap on remote memory recall (provider limits validate 1..20). */
const RECALL_LIMIT_MAX = 20;

/** Thrown when a query would exceed its resource bounds — fail closed, never truncate silently. */
export class GraphBoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GraphBoundError";
  }
}

/**
 * Entity-recall seam for remote memory backends (mnesis): the view hands
 * over the caller's terms and scope, the adapter drives the backend's own
 * search and returns entries with provenance. Never called without terms —
 * this layer never bulk-enumerates a remote system.
 */
export interface GraphMemoryRecall {
  recall(terms: readonly string[], scope: MemoryScopeKey, limit: number): Promise<MemoryEntry[]>;
}

/**
 * Adapts any {@link MemoryProvider} (mem0, mnesis) into a
 * {@link GraphMemoryRecall}: the joined terms drive one provider search per
 * scope. Empty/absent terms yield nothing — the fail-closed posture above.
 */
export function memoryProviderRecall(provider: MemoryProvider): GraphMemoryRecall {
  return {
    async recall(terms, scope, limit) {
      const query = terms.join(" ").trim();
      if (query === "") return [];
      const search: MemorySearchQuery = { query, scope, limit: Math.min(limit, RECALL_LIMIT_MAX) };
      return provider.search(search);
    },
  };
}

// ---------------------------------------------------------------------------
// shared SQL scope + row shapes
// ---------------------------------------------------------------------------

/** Shared scope binding for the raw SQL in this module (?1=spaceId ?2=since). */
interface SqlScope {
  spaceId: string | null;
  since: number | null;
}

interface SpaceRow {
  id: string;
  name: string | null;
}

interface WorkItemRow {
  id: string;
  space_id: string;
  requester: string;
  assignee: string | null;
  description: string;
  repo: string | null;
  pr_url: string | null;
  result: string | null;
  approvals: string;
  evidence: string;
  created_at: number;
}

interface SchedulerJobRow {
  id: string;
  action: string;
  space_id: string | null;
  created_by: string;
  created_at: number;
}

interface MemoryRow {
  id: string;
  scope: string;
  principal: string | null;
  content: string;
  created_at: number;
  mem_source: string | null;
  mem_space_id: string | null;
  mem_principal: string | null;
  mem_scope_label: string | null;
}

/**
 * One memory source row resolved into a graph node plus the ids its
 * decided-in/created edges need. `content` carries the FULL body so
 * mention matching sees past the truncated label.
 */
interface GraphMemorySource {
  node: GraphNode;
  spaceId: string | null;
  principal: string | null;
  content: string;
}

const APPROVALS_SCHEMA = z.array(z.object({ approver: z.string().min(1) }));
const RESULT_PAYLOAD_SCHEMA = z.object({ pr_url: z.string().min(1) });
const EVIDENCE_SCHEMA = z.array(z.object({ url: z.string().min(1) }));

// ---------------------------------------------------------------------------
// pure shaping helpers (shared by projectGraph and neighbors)
// ---------------------------------------------------------------------------

function nodeLabel(text: string): string {
  const firstLine = text.split("\n")[0] ?? "";
  return firstLine.length > 120 ? `${firstLine.slice(0, 117)}…` : firstLine;
}

function refKey(ref: NodeRef): string {
  return `${ref.kind}:${ref.id}`;
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Decodes a physical memory row's logical scope key (mirrors decodeScopeKey). */
function memoryRowScope(rowScope: string, principal: string | null): MemoryScopeKey {
  return rowScope === "org" ? { kind: "org" } : decodeScopeKey("user", principal);
}

/** The space a memory belongs to: provenance column first, channel scope key second. */
function memorySpaceId(entryScope: MemoryScopeKey, memSpaceId: string | null): string | null {
  if (memSpaceId !== null && memSpaceId !== "") return memSpaceId;
  return entryScope.kind === "channel" ? entryScope.spaceId : null;
}

/** The person a memory is attributable to: person scope key first, provenance second. */
function memoryPrincipal(entryScope: MemoryScopeKey, memPrincipal: string | null): string | null {
  if (entryScope.kind === "person") return entryScope.principal;
  return memPrincipal !== null && memPrincipal !== "" ? memPrincipal : null;
}

/**
 * Shapes one physical memory row. Issue acceptance: provenance is present
 * on EVERY decision/memory node — legacy pre-#163 rows fall back to the
 * documented defaults (`tool`, nulls).
 */
function memoryRowToSource(row: MemoryRow): GraphMemorySource {
  const entryScope = memoryRowScope(row.scope, row.principal);
  const spaceId = memorySpaceId(entryScope, row.mem_space_id);
  const principal = memoryPrincipal(entryScope, row.mem_principal);
  return {
    node: {
      kind: "memory",
      id: row.id,
      label: nodeLabel(row.content),
      createdAt: row.created_at,
      provenance: { source: row.mem_source ?? "tool", spaceId, principal },
    },
    spaceId,
    principal,
    content: row.content,
  };
}

/** Extracts PR urls from a work item row: pr_url column, result JSON, evidence urls. */
function workItemPrUrls(item: WorkItemRow): string[] {
  const urls = new Set<string>();
  if (item.pr_url !== null && item.pr_url !== "") urls.add(item.pr_url);
  // Each JSON blob is DECODED at this I/O boundary — malformed legacy rows
  // contribute no urls rather than throwing.
  const result = RESULT_PAYLOAD_SCHEMA.safeParse(JSON.parse(item.result ?? "null"));
  if (result.success) urls.add(result.data.pr_url);
  const evidence = EVIDENCE_SCHEMA.safeParse(JSON.parse(item.evidence ?? "null"));
  if (evidence.success) {
    for (const entry of evidence.data) {
      // Issue #128 delivery receipts: pull-request evidence carries /pull/ urls.
      if (entry.url.includes("/pull/")) urls.add(entry.url);
    }
  }
  return [...urls];
}

/** True when `name` is an existing table (remote backends never migrate the shared tables). */
function hasTable(db: Database, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== null;
}

/**
 * The memory decided-in edge branch of the traversal CTE — spliced in only
 * when the shared `memories` table exists (remote backends contribute
 * nothing locally). Includes its own leading UNION ALL.
 */
const MEMORY_EDGE_SQL = `
         UNION ALL
         SELECT 'memory', id, 'space',
                CASE WHEN mem_space_id IS NOT NULL AND mem_space_id != '' THEN mem_space_id
                     WHEN principal LIKE 'channel:%' THEN SUBSTR(principal, 9)
                     ELSE NULL END,
                'decided-in'
           FROM memories
          WHERE (?2 IS NULL OR created_at >= ?2)
            AND (?1 IS NULL OR mem_space_id = ?1 OR principal = '${CHANNEL_KEY_PREFIX}' || ?1)
         UNION ALL
         SELECT 'memory', id, 'work-item', w.id, 'mentions'
           FROM memories m, work_items w
          WHERE instr(lower(m.content), lower(w.id)) > 0
            AND (?2 IS NULL OR m.created_at >= ?2)
            AND (?1 IS NULL OR w.space_id = ?1)`;

/**
 * Reads durable memories from the SHARED store database (the default
 * SQLite backend shares it with the store). Scope narrowing: a scoped
 * projection takes that space's channel-scope rows (scope key or
 * consolidation-written mem_space_id); org rows appear only in the
 * unscoped whole-org projection. Non-empty `terms` narrow further to
 * bodies matching ANY term (entity recall on the local path).
 */
function readSharedMemories(db: Database, sqlScope: SqlScope, terms: readonly string[] = []): GraphMemorySource[] {
  // A remote memory backend (mnesis/mem0) leaves no shared `memories`
  // table behind — nothing to read locally, contribute nothing.
  if (!hasTable(db, "memories")) return [];
  const meaningful = terms.map((term) => term.trim()).filter((term) => term !== "").slice(0, TERM_LIMIT_MAX);
  const termFilters = meaningful.map((_, index) => `instr(lower(content), ?${index + 3}) > 0`);
  // SAFETY: the memories table's columns are fixed by this module's known
  // migrations; every projected column maps 1:1 onto the MemoryRow shape.
  const rows = db
    .prepare(
      `SELECT id, scope, principal, content, created_at,
              mem_source, mem_space_id, mem_principal, mem_scope_label
       FROM memories
       WHERE (?2 IS NULL OR created_at >= ?2)
         AND (?1 IS NULL OR mem_space_id = ?1
              OR principal = '${CHANNEL_KEY_PREFIX}' || ?1)
         ${termFilters.length > 0 ? `AND (${termFilters.join(" OR ")})` : ""}`,
    )
    .all(sqlScope.spaceId, sqlScope.since, ...meaningful.map((term) => term.toLowerCase())) as MemoryRow[];
  return rows.map(memoryRowToSource);
}

/**
 * Stitches remote-backend memories (mnesis) into the projection via the
 * recall seam — term-driven only, deduped by entry id, provenance mapped
 * from the entries themselves.
 */
async function recallRemoteMemories(
  recall: GraphMemoryRecall,
  terms: readonly string[],
  sqlScope: SqlScope,
): Promise<GraphMemorySource[]> {
  const meaningful = terms.map((term) => term.trim()).filter((term) => term !== "");
  if (meaningful.length === 0) return [];
  const scope: MemoryScopeKey =
    sqlScope.spaceId !== null ? { kind: "channel", spaceId: sqlScope.spaceId } : { kind: "org" };
  const sources: GraphMemorySource[] = [];
  const seen = new Set<string>();
  for (const entry of await recall.recall(meaningful, scope, RECALL_LIMIT_MAX)) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    const spaceId =
      entry.provenance.spaceId ?? (entry.key.kind === "channel" ? entry.key.spaceId : null);
    const principal = entry.key.kind === "person" ? entry.key.principal : entry.provenance.principal;
    sources.push({
      node: {
        kind: "memory",
        id: entry.id,
        label: nodeLabel(entry.content),
        createdAt: entry.createdAt,
        provenance: { source: entry.provenance.source, spaceId, principal },
      },
      spaceId,
      principal,
      content: entry.content,
    });
  }
  return sources;
}

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

/** Options for {@link projectGraph}. */
export interface ProjectGraphOpts {
  /** Narrow to one space (id like "slack:C1"). Absent → the whole org. */
  spaceId?: string;
  /** Only nodes created at/after this epoch-ms timestamp. */
  since?: number;
  /**
   * Term-driven entity recall: narrows memory/decision nodes to bodies
   * matching ANY term. With {@link memoryRecall} this drives the remote
   * backend's search; without it, the shared SQLite read filters on it.
   */
  terms?: readonly string[];
  /** Remote memory seam (mnesis/mem0). Absent → shared-table reads only. */
  memoryRecall?: GraphMemoryRecall;
  /** Hard node ceiling. Default {@link DEFAULT_MAX_NODES}. */
  maxNodes?: number;
}

/**
 * Projects the org graph over existing tables — plain indexed reads; no
 * recursion needed for the whole-graph shape ({@link neighbors} owns the
 * recursive CTE for multi-hop walks).
 *
 * Bounds: more than `maxNodes` (default {@link DEFAULT_MAX_NODES}) throws
 * {@link GraphBoundError} — fail closed, never a silent truncation.
 */
export async function projectGraph(store: Store, opts: ProjectGraphOpts = {}): Promise<GraphProjection> {
  const maxNodes = opts.maxNodes ?? DEFAULT_MAX_NODES;
  const sqlScope: SqlScope = { spaceId: opts.spaceId ?? null, since: opts.since ?? null };
  const db = store.getDb();

  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  // Fails closed at the ceiling instead of growing without bound.
  const addNode = (node: GraphNode): void => {
    const key = refKey(node);
    if (!nodes.has(key)) {
      nodes.set(key, node);
      if (nodes.size > maxNodes) {
        throw new GraphBoundError(`graph projection exceeded ${maxNodes} nodes (fail-closed bound)`);
      }
    }
  };

  // Spaces: the anchor nodes of every scope.
  // SAFETY: spaces.id/name are NOT NULL per schema; rows match SpaceRow exactly.
  const spaces = db.prepare("SELECT id, name FROM spaces WHERE (?1 IS NULL OR id = ?1)").all(sqlScope.spaceId) as SpaceRow[];
  for (const space of spaces) {
    addNode({ kind: "space", id: space.id, label: space.name ?? space.id, createdAt: null });
  }

  // Work items and their principal/repo/pr/approval edges.
  // SAFETY: work_items columns are schema-pinned (approvals/evidence JSON
  // strings); the selected columns map 1:1 onto WorkItemRow.
  const items = db
    .prepare(
      `SELECT id, space_id, requester, assignee, description, repo, pr_url, result, approvals, evidence, created_at
       FROM work_items
       WHERE (?1 IS NULL OR space_id = ?1)
         AND (?2 IS NULL OR created_at >= ?2)`,
    )
    .all(sqlScope.spaceId, sqlScope.since) as WorkItemRow[];
  for (const item of items) {
    addNode({ kind: "work-item", id: item.id, label: nodeLabel(item.description), createdAt: item.created_at });
    const wi: NodeRef = { kind: "work-item", id: item.id };
    addNode({ kind: "person", id: item.requester, label: item.requester, createdAt: null });
    edges.push({ from: wi, to: { kind: "person", id: item.requester }, rel: "created" });
    if (item.assignee !== null && item.assignee !== "") {
      addNode({ kind: "person", id: item.assignee, label: item.assignee, createdAt: null });
      edges.push({ from: wi, to: { kind: "person", id: item.assignee }, rel: "assigned" });
    }
    if (item.repo !== null && item.repo !== "") {
      addNode({ kind: "repo", id: item.repo, label: item.repo, createdAt: null });
      edges.push({ from: wi, to: { kind: "repo", id: item.repo }, rel: "targets" });
    }
    // Approvals are decoded at this I/O boundary — malformed legacy rows
    // contribute no approved-by edges rather than throwing.
    const parsedApprovals = APPROVALS_SCHEMA.safeParse(JSON.parse(item.approvals ?? "null"));
    if (parsedApprovals.success) {
      for (const approval of parsedApprovals.data) {
        addNode({ kind: "person", id: approval.approver, label: approval.approver, createdAt: null });
        edges.push({ from: wi, to: { kind: "person", id: approval.approver }, rel: "approved-by" });
      }
    }
    for (const url of workItemPrUrls(item)) {
      addNode({ kind: "pr", id: url, label: url, createdAt: null });
      edges.push({ from: wi, to: { kind: "pr", id: url }, rel: "delivered" });
    }
  }

  // Scheduler jobs and their owner/space edges.
  // SAFETY: scheduler_jobs columns are schema-pinned; rows match SchedulerJobRow exactly.
  const jobs = db
    .prepare(
      `SELECT id, action, space_id, created_by, created_at
       FROM scheduler_jobs
       WHERE (?1 IS NULL OR space_id = ?1)
         AND (?2 IS NULL OR created_at >= ?2)`,
    )
    .all(sqlScope.spaceId, sqlScope.since) as SchedulerJobRow[];
  for (const job of jobs) {
    addNode({ kind: "job", id: job.id, label: job.action, createdAt: job.created_at });
    const jobRef: NodeRef = { kind: "job", id: job.id };
    addNode({ kind: "person", id: job.created_by, label: job.created_by, createdAt: null });
    edges.push({ from: jobRef, to: { kind: "person", id: job.created_by }, rel: "created" });
    if (job.space_id !== null && job.space_id !== "") {
      edges.push({ from: jobRef, to: { kind: "space", id: job.space_id }, rel: "scheduled-in" });
    }
  }

  // Memories/decisions: shared SQLite table first, remote recall stitched in.
  let memories: GraphMemorySource[];
  if (opts.memoryRecall !== undefined) {
    memories = await recallRemoteMemories(opts.memoryRecall, opts.terms ?? [], sqlScope);
  } else {
    memories = readSharedMemories(db, sqlScope, opts.terms ?? []);
  }
  for (const memory of memories) {
    addNode(memory.node);
    const memoryRef: NodeRef = { kind: "memory", id: memory.node.id };
    if (memory.spaceId !== null) {
      edges.push({ from: memoryRef, to: { kind: "space", id: memory.spaceId }, rel: "decided-in" });
    }
    if (memory.principal !== null && memory.principal !== "") {
      addNode({ kind: "person", id: memory.principal, label: memory.principal, createdAt: null });
      edges.push({ from: memoryRef, to: { kind: "person", id: memory.principal }, rel: "created" });
    }
    // mentions: the memory body references an in-scope work item id.
    for (const item of items) {
      if (memory.content.includes(item.id)) {
        edges.push({ from: memoryRef, to: { kind: "work-item", id: item.id }, rel: "mentions" });
      }
    }
  }

  const nodeList = [...nodes.values()].sort((a, b) =>
    a.kind === b.kind ? compareIds(a.id, b.id) : compareIds(a.kind, b.kind),
  );
  const edgeList = edges.sort(
    (a, b) =>
      compareIds(a.rel, b.rel) || compareIds(refKey(a.from), refKey(b.from)) || compareIds(refKey(a.to), refKey(b.to)),
  );
  return { nodes: nodeList, edges: edgeList };
}

/** Options for {@link neighbors}. */
export interface NeighborsOpts {
  /** Restrict traversal to one relationship kind. */
  rel?: EdgeRel;
  /** Maximum hops from the start node. Default {@link DEFAULT_MAX_DEPTH}. */
  maxDepth?: number;
  /** Hard node ceiling including the start node. Default {@link DEFAULT_MAX_NODES}. */
  maxNodes?: number;
  /** Scope filters mirroring {@link ProjectGraphOpts}. */
  spaceId?: string;
  since?: number;
}

/**
 * Multi-hop walk from one node as a SQLite RECURSIVE CTE over the union
 * edge table: traversal stays inside the engine, UNION dedupe terminates
 * cycles, and depth is capped IN THE QUERY (`WHERE w.depth < ?5`). The
 * walked ids then filter a full {@link projectGraph} pass so returned
 * nodes/edges carry complete labels + provenance.
 *
 * Bounds: `maxDepth` validated 1..8; more than `maxNodes` walked nodes
 * throws {@link GraphBoundError}.
 */
export async function neighbors(store: Store, start: NodeRef, opts: NeighborsOpts = {}): Promise<GraphProjection> {
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  if (!Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > MAX_DEPTH_LIMIT) {
    throw new GraphBoundError(`maxDepth must be an integer in 1..${MAX_DEPTH_LIMIT} (got ${maxDepth})`);
  }
  const maxNodes = opts.maxNodes ?? DEFAULT_MAX_NODES;
  const spaceId = opts.spaceId ?? null;
  const since = opts.since ?? null;
  const db = store.getDb();

  // Positional binding: ?1=spaceId ?2=since ?3=start.kind ?4=start.id
  // ?5=maxDepth ?6=relFilter. Numbered params allow reuse across branches.
  const walkedSql = `WITH RECURSIVE
       edge(fk, fi, tk, ti, rel) AS (
         SELECT 'work-item', id, 'person', requester, 'created'
           FROM work_items
          WHERE (?1 IS NULL OR space_id = ?1) AND (?2 IS NULL OR created_at >= ?2)
         UNION ALL
         SELECT 'work-item', id, 'person', assignee, 'assigned'
           FROM work_items
          WHERE assignee IS NOT NULL AND assignee != ''
            AND (?1 IS NULL OR space_id = ?1) AND (?2 IS NULL OR created_at >= ?2)
         ${hasTable(db, "memories") ? MEMORY_EDGE_SQL : ""}
         UNION ALL
         SELECT 'work-item', w.id, 'person', json_extract(a.value, '$.approver'), 'approved-by'
           FROM work_items w, json_each(w.approvals) a
          WHERE (?1 IS NULL OR w.space_id = ?1) AND (?2 IS NULL OR w.created_at >= ?2)
         UNION ALL
         SELECT 'work-item', id, 'repo', repo, 'targets'
           FROM work_items
          WHERE repo IS NOT NULL AND repo != ''
            AND (?1 IS NULL OR space_id = ?1) AND (?2 IS NULL OR created_at >= ?2)
         UNION ALL
         SELECT 'job', id, 'person', created_by, 'created'
           FROM scheduler_jobs
          WHERE (?1 IS NULL OR space_id = ?1) AND (?2 IS NULL OR created_at >= ?2)
         UNION ALL
         SELECT 'job', id, 'space', space_id, 'scheduled-in'
           FROM scheduler_jobs
          WHERE space_id IS NOT NULL AND space_id != ''
            AND (?1 IS NULL OR space_id = ?1) AND (?2 IS NULL OR created_at >= ?2)
         UNION ALL
         SELECT 'work-item', id, 'pr', pr_url, 'delivered'
           FROM work_items
          WHERE pr_url IS NOT NULL AND pr_url != ''
            AND (?1 IS NULL OR space_id = ?1) AND (?2 IS NULL OR created_at >= ?2)
         UNION ALL
         SELECT 'work-item', id, 'pr', json_extract(result, '$.pr_url'), 'delivered'
           FROM work_items
          WHERE result IS NOT NULL AND json_valid(result)
            AND json_type(result, '$.pr_url') = 'text'
            AND (?1 IS NULL OR space_id = ?1) AND (?2 IS NULL OR created_at >= ?2)
       ),
       walk(kind, id, depth) AS (
         SELECT ?3, ?4, 0
         UNION
         SELECT CASE WHEN e.fk = w.kind AND e.fi = w.id THEN e.tk ELSE e.fk END,
                CASE WHEN e.fk = w.kind AND e.fi = w.id THEN e.ti ELSE e.fi END,
                w.depth + 1
           FROM walk w
           JOIN edge e
             ON ((e.fk = w.kind AND e.fi = w.id) OR (e.tk = w.kind AND e.ti = w.id))
            AND (?6 IS NULL OR e.rel = ?6)
          WHERE w.depth < ?5
       )
       SELECT kind, id, MIN(depth) AS depth FROM walk GROUP BY kind, id ORDER BY depth, kind, id`;

  interface WalkedRow {
    kind: string;
    id: string;
    depth: number;
  }
  // SAFETY: the walk SELECT projects exactly (kind, id, depth) text/number columns.
  const walked = db
    .prepare(walkedSql)
    .all(spaceId, since, start.kind, start.id, maxDepth, opts.rel ?? null) as WalkedRow[];

  if (walked.length > maxNodes) {
    throw new GraphBoundError(
      `traversal from ${start.kind}:${start.id} exceeded ${maxNodes} nodes (fail-closed bound)`,
    );
  }

  // Materialize full node details + the induced edge set for the walked ids.
  const full = await projectGraph(store, { spaceId: spaceId ?? undefined, since: since ?? undefined });
  const wanted = new Set(walked.map((row) => `${row.kind}:${row.id}`));
  const nodes = full.nodes.filter((node) => wanted.has(refKey(node)));
  const edges = full.edges.filter((edge) => wanted.has(refKey(edge.from)) && wanted.has(refKey(edge.to)));
  return { nodes, edges };
}
