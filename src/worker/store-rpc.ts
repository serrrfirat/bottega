/**
 * Job-scoped store + memory RPC seam (issue #101, epic #229 P1, #338).
 *
 * The job container must never hold the shared `bottega.db` bytes: a
 * model-controlled shell could otherwise read every job, workspace,
 * credential, and audit row by opening the file directly. Instead the
 * SUPERVISOR retains the real {@link Store} (single-writer on the data
 * volume, per #101) and exposes ONLY job-scoped operations over a bounded
 * unix-socket RPC. The supervisor wraps the real store in {@link
 * createJobScopedStore} (its existing scope-firewall: any access outside
 * the job's own rows throws loudly) AND applies an explicit method
 * ALLOWLIST for the byte dimensions the scoped-store facade intentionally
 * forwards. The child's `Store` and memory provider are thin, EXPLICIT RPC
 * clients (no Proxy fallthrough — an unknown or global method fails closed
 * locally, never forwarded).
 *
 * Protocol: one newline-delimited JSON frame per message over a unix
 * socket (`node:net`). Both directions are bounded (`MAX_RPC_FRAME_BYTES`),
 * every request carries an id and an explicit `ns` (`store` | `memory`),
 * and every pending call has a hard timeout. An oversized, malformed,
 * unknown, or timed-out call is a loud fail-closed close (never a silent
 * partial). The child may never call `getDb`/`close` (it never obtains the
 * supervisor's raw database handle).
 *
 * Coverage (every durable worker kind, issue #101):
 *   - git/extension claim/delivery: claimWorkItemById, getWorkItem,
 *     transitionWorkItem, getJob, completeJob, failJob, requeueJob,
 *     renewJobLease, appendAudit, queryAudit, listAudit,
 *     getEffectiveSpaceSettings, getSpaceSettings, getSpace (own space only).
 *   - read-only org floor: getOrgSettings (shared floor the sandbox tools read).
 *   - extension worker toolset: listExtensionCredentials (extension jobs only).
 *   - ingest_poll durable watermark: getIngestWatermark, setIngestWatermark.
 *   - every kind's self-bookkeeping writes its outbox row through
 *     `postOutboxRow` (supervisor-side; the container holds no SQL handle).
 *   - memory: capabilities, backend, save (kb ingestion), search,
 *     pruneDigests, and `maintainMemory` (scheduled consolidation) whose
 *     LLM leg is a bounded supervisor→child model-call round-trip (the
 *     model call runs in the WORKER, issue #272; the DB stays supervisor-side).
 */
import { connect, createServer, type Server, type Socket } from "node:net";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Database } from "bun:sqlite";
import type {
  Store,
  WorkItem,
  WorkItemState,
  TransitionOpts,
  Space,
  SpaceModelSettings,
  ExtensionCredential,
  AuditEntry,
  AuditPage,
  AuditQueryOpts,
  ListAuditOpts,
  AuditRow,
} from "../store/db";
import type { OrgSettings } from "../store/org-settings";
import {
  ingestPollJobPayloadSchema,
  scheduledJobPayloadSchema,
  type WorkerJob,
} from "../worker/envelope";
import { createJobScopedStore, jobScopeFromEnvelope, ScopedStoreAccessError } from "./scoped-store";
import { postOutboxRow, type OutboxWrite } from "../store/outbox";
import {
  DELIVERY_COMPLETED_EVENT,
  DELIVERY_PENDING_EVENT,
  EXTENSION_CALL_EVENT,
  JOB_COMPLETED_EVENT,
  JOB_FAILED_EVENT,
  MEMORY_WRITE_EVENT,
  POLICY_DECISION_EVENT,
  USAGE_TURN_EVENT,
  WORK_ITEM_FAILED_EVENT,
  WORK_ITEM_PIN_APPLIED_EVENT,
} from "../store/audit-events";
import { maintainMemory, type ConsolidationModelCall, type ConsolidationResult } from "../memory/consolidation";
import { type MemoryEntry, type MemoryProvider, type MemoryProviderCapabilities, type MemorySaveInput, type MemoryScopeKey, type MemorySearchQuery, type MemoryTombstone } from "../memory/types";
import type { ResolvedMemoryProvider } from "../server/memory-provider";
import type { JsonValue } from "../memory/mem0";

/** Hard cap on any single RPC frame (request or response), bytes. */
export const MAX_RPC_FRAME_BYTES = 256 * 1024;
/** The bound above which a connection is torn down (frame header headroom). */
const MAX_RPC_BUFFER_BYTES = MAX_RPC_FRAME_BYTES + 1024;
/** A pending RPC call that is not answered in time is torn down loudly. */
const RPC_CALL_TIMEOUT_MS = 60_000;

const rpcRequestSchema = z
  .object({
    ns: z.enum(["store", "memory"]),
    id: z.number().int().nonnegative(),
    method: z.string().min(1),
    args: z.array(z.unknown()),
  })
  .strict();

type RpcRequest = z.infer<typeof rpcRequestSchema>;

interface RpcReply {
  id: number;
  ok: boolean;
  value?: RpcWireValue;
  error?: string;
}

/** The supervisor → child @model-call reply frame (the child's model text). */
const rpcReplySchema = z.object({
  id: z.number().int().nonnegative(),
  ok: z.boolean(),
  value: z.string().optional(),
  error: z.string().optional(),
});

/** The scoped-store facade seen through the method-allowlist dispatch: every
 * allowlisted method is a function returning a JSON-serializable row value. */
type StoreMethodMap = Record<string, (this: Store, ...args: unknown[]) => JsonValue>;

/**
 * A JSON-serializable result carried over a store/memory RPC reply. The member
 * union names the concrete shapes the allowlisted store/memory methods return
 * (plus `undefined` for void ops); using named types keeps the reply/return
 * domain precise instead of a broad `object` escape hatch.
 */
type RpcWireValue =
  | JsonValue
  | MemoryEntry
  | MemoryEntry[]
  | MemoryProviderCapabilities
  | MemoryTombstone
  | ConsolidationResult[]
  | undefined;

/**
 * The ONLY store operations the job container may invoke. Everything the
 * git/extension/kb/ingest_poll/scheduled job bodies need for their own
 * lifecycle, plus the read-only shared infra they legitimately consult.
 * The allowlist gates WHICH method may cross; {@link JobStoreRpcServer} then
 * adds a per-method authorization check on every argument that names a
 * target (its own job's envelope id/kind/space and the kind payload keys),
 * so a raw socket can never reach another job's/space's/provider's/memory
 * scope. A method entry alone is NOT a grant: the invoke handler validates
 * every argument against the immutable job context before forwarding.
 * Anything else, `getDb`, and `close` are denied — the facade's job-row
 * firewall is not a global-write firewall.
 */
const ALLOWED_STORE_METHODS = {
  claimWorkItemById: true,
  getWorkItem: true,
  transitionWorkItem: true,
  getJob: true,
  completeJob: true,
  failJob: true,
  requeueJob: true,
  renewJobLease: true,
  appendAudit: true,
  queryAudit: true,
  listAudit: true,
  // Read-only ORG-level settings (the shared floor, not another job's/space's
  // private rows). Required by the sandbox admin/settings/model tools; the
  // org floor is the same low-sensitivity shared resource the memory `org`
  // scope allows. Not per-job, so it is a permitted global read (never a write).
  getOrgSettings: true,
  getSpace: true,
  getSpaceSettings: true,
  getEffectiveSpaceSettings: true,
  listExtensionCredentials: true,
  getIngestWatermark: true,
  setIngestWatermark: true,
  // `postOutboxRow` is handled specially: it is a module function that needs
  // the raw DB (transactional INSERT OR IGNORE), so the supervisor invokes the
  // real outbox writer, never the child. Its id/kind/space must match the job.
  postOutboxRow: true,
} satisfies Record<string, true>;

/** The child outbox write envelope (validated supervisor-side). */
const outboxWriteSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(["git", "extension", "kb", "scheduled", "work_item", "ingest_poll"]),
    payload: z.unknown(),
    space: z.string().nullable().optional(),
  })
  .strict();

/** The append-only audit entry the job body may write (validated supervisor-side). */
const auditEntrySchema = z
  .object({
    ts: z.number().optional(),
    space_id: z.string().nullable().optional(),
    actor: z.string().min(1),
    event_type: z.string().min(1),
    payload: z.string(),
  })
  .strict();

/**
 * One audit row a job KIND may legitimately write: the exact event type,
 * the legitimate actor(s), and how its `space_id` is bound. Space "own"
 * allows only the job's OWN space (or null when the job itself has no
 * space); space "null" pins the row to org-level (always null) regardless
 * of the job's space — used only by the kb `memory.write` org-scope rows.
 * A child cannot forge another actor, an arbitrary event type, or a
 * null-space/org-level row unless this table says the kind writes it.
 */
interface AuditPolicyRule {
  eventType: string;
  actors: readonly string[];
  space: "own" | "null";
}

/**
 * The real child-side audit events, enumerated from the executor's
 * run bodies (completeSelf/failSelf/failJobSelf, processItem →
 * extensionWorkerPath/deliver/applyWorkItemModelPin, and kb ingest). Every
 * durable kind writes its own job.completed/job.failed lifecycle; the
 * git/extension delivery markers and the kb org-scope memory write are
 * bound to their owning kind. Anything else — another actor, another event,
 * a fabricated org-level or cross-space row — is denied.
 */
const JOB_LIFECYCLE_RULES: readonly AuditPolicyRule[] = [
  { eventType: JOB_COMPLETED_EVENT, actors: ["executor"], space: "own" },
  { eventType: JOB_FAILED_EVENT, actors: ["executor"], space: "own" },
];

const AUDIT_POLICY = {
  git: [
    ...JOB_LIFECYCLE_RULES,
    { eventType: WORK_ITEM_FAILED_EVENT, actors: ["executor"], space: "own" },
    { eventType: DELIVERY_PENDING_EVENT, actors: ["executor"], space: "own" },
    { eventType: WORK_ITEM_PIN_APPLIED_EVENT, actors: ["executor"], space: "own" },
    { eventType: POLICY_DECISION_EVENT, actors: ["agent"], space: "own" },
    { eventType: USAGE_TURN_EVENT, actors: ["agent"], space: "own" },
  ],
  extension: [
    ...JOB_LIFECYCLE_RULES,
    { eventType: WORK_ITEM_FAILED_EVENT, actors: ["executor"], space: "own" },
    { eventType: DELIVERY_COMPLETED_EVENT, actors: ["executor"], space: "own" },
    { eventType: WORK_ITEM_PIN_APPLIED_EVENT, actors: ["executor"], space: "own" },
    { eventType: EXTENSION_CALL_EVENT, actors: ["executor"], space: "own" },
    { eventType: POLICY_DECISION_EVENT, actors: ["agent"], space: "own" },
    { eventType: USAGE_TURN_EVENT, actors: ["agent"], space: "own" },
  ],
  kb: [
    ...JOB_LIFECYCLE_RULES,
    // kb ingest writes org-scope memory rows (payload {scope:"org"...}) —
    // always null-space regardless of the job's own (possibly null) space.
    { eventType: MEMORY_WRITE_EVENT, actors: ["kb_ingest"], space: "null" },
  ],
  ingest_poll: [...JOB_LIFECYCLE_RULES],
  scheduled: [...JOB_LIFECYCLE_RULES, { eventType: USAGE_TURN_EVENT, actors: ["agent"], space: "own" }],
} satisfies Record<WorkerJob["kind"], readonly AuditPolicyRule[]>;

/** The audit policy rule matching an event/actor, or null when not legitimately writable by this kind. */
function auditPolicyRule(kind: WorkerJob["kind"], eventType: string, actor: string): AuditPolicyRule | null {
  for (const rule of AUDIT_POLICY[kind]) {
    if (rule.eventType === eventType) {
      return rule.actors.includes(actor) ? rule : null;
    }
  }
  return null;
}

/** The audit-read filter the job body may pass to queryAudit (scoped to its own space). */
const auditQuerySchema = z
  .object({
    space_id: z.string().optional(),
    actor: z.string().optional(),
    event_type: z.string().optional(),
    since: z.number().optional(),
    until: z.number().optional(),
    tool: z.string().optional(),
    extension: z.string().optional(),
    cursor: z
      .object({ ts: z.number(), id: z.number() })
      .strict()
      .optional(),
    limit: z.number().int().optional(),
  })
  .strict();

/** The audit-list filter the job body may pass to listAudit (scoped to its own space). */
const auditListSchema = z
  .object({
    space: z.string().optional(),
    since: z.number().optional(),
    event_type: z.string().optional(),
    limit: z.number().optional(),
  })
  .strict();

/** The validated memory-save input (no casts from caller-supplied unknown). */
const memorySaveSchema = z
  .object({
    scope: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("org") }).strict(),
      z.object({ kind: z.literal("person"), principal: z.string().min(1) }).strict(),
      z.object({ kind: z.literal("channel"), spaceId: z.string().min(1) }).strict(),
      z.object({ kind: z.literal("team"), teamId: z.string().min(1) }).strict(),
    ]),
    content: z.string(),
    metadata: z.record(z.string(), z.string()).optional(),
  })
  .strict();

/** The validated memory-search query (no casts from caller-supplied unknown). */
const memorySearchSchema = z
  .object({
    query: z.string(),
    scope: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("org") }).strict(),
      z.object({ kind: z.literal("person"), principal: z.string().min(1) }).strict(),
      z.object({ kind: z.literal("channel"), spaceId: z.string().min(1) }).strict(),
      z.object({ kind: z.literal("team"), teamId: z.string().min(1) }).strict(),
    ]),
    limit: z.number().int().optional(),
    metadata: z.record(z.string(), z.string()).optional(),
  })
  .strict();

/** The validated memory-forget input (no casts from caller-supplied unknown). */
const memoryForgetSchema = z
  .object({
    scope: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("org") }).strict(),
      z.object({ kind: z.literal("person"), principal: z.string().min(1) }).strict(),
      z.object({ kind: z.literal("channel"), spaceId: z.string().min(1) }).strict(),
      z.object({ kind: z.literal("team"), teamId: z.string().min(1) }).strict(),
    ]),
    id: z.string().min(1),
  })
  .strict();

/** The ingest watermark cursor write the job body may pass (validated supervisor-side). */
const ingestWatermarkWriteSchema = z.tuple([z.string().min(1), z.string()]);

/** The memory digest-prune args the job body may pass (validated supervisor-side). */
const pruneDigestsArgsSchema = z.tuple([z.string(), z.number()]);

function replyFrame(id: number, ok: boolean, value?: RpcWireValue, error?: string): Buffer {
  return Buffer.from(`${JSON.stringify({ id, ok, ...(ok ? { value } : { error }) })}\n`);
}

/**
 * Job-scoped store + memory RPC host. Creates the socket dir + unix socket,
 * serves bounded frames, and enforces job scope via {@link
 * createJobScopedStore} AND a per-method authorization context derived from
 * the validated {@link WorkerJob} envelope (its immutable id/kind/space and
 * kind-specific payload). A raw socket cannot cross into another job, space,
 * provider, or memory scope: every argument that names a target is validated
 * against the job's own envelope, never trusted from the caller. Memory is
 * forwarded to the supervisor's real (SQLite/mem0) provider with the same
 * scope firewall. Unknown/global/oversized/malformed/timed-out frames fail
 * closed. Call {@link close} after the job container exits.
 */
export class JobStoreRpcServer {
  readonly socketPath: string;
  private readonly server: Server;
  private connection: Socket | null = null;
  private buffer: Buffer[] = [];
  private readonly scopedStore: Store;
  private readonly memory: MemoryProvider;
  private readonly storeDb: Database;
  /** The immutable job envelope this server authorizes against (never caller-supplied). */
  private readonly job: WorkerJob;
  /** The job's derived work-item scope (git/extension only; null for kinds without a store item). */
  private readonly workItemId: string | null;
  /** The validated ingest-poll provider (ingest_poll jobs only). */
  private readonly pollProvider: string | null;
  /** The validated scheduled action (scheduled jobs only). */
  private readonly scheduledAction: string | null;
  /**
   * The extension manifest/provider ids registered in the supervisor's
   * extension registry (issue #101): the ONLY providers a job container may
   * enumerate credentials for. Derived from the immutable runtime registry —
   * never from a caller-supplied string — so a hostile child cannot read
   * credential metadata for an arbitrary provider it was never authorized
   * to call.
   */
  private readonly extensionProviderIds: ReadonlySet<string>;
  private readonly modelCallRequesters = new Map<number, { resolve: (v: string | undefined) => void; reject: (e: Error) => void }>();
  /** Monotonic supervisor→child model-call request id (unique across the server lifetime). */
  private modelCallNextId = 0;

  private constructor(
    baseStore: Store,
    job: WorkerJob,
    socketPath: string,
    memory: MemoryProvider,
    storeDb: Database,
    extensionProviderIds: ReadonlySet<string>,
  ) {
    this.socketPath = socketPath;
    this.job = job;
    this.workItemId = jobScopeFromEnvelope(job).workItemId;
    this.extensionProviderIds = extensionProviderIds;
    // Only the job kind's OWN validated payload keys unlock the scoped read/
    // write capability. A malformed payload fails closed (null capability),
    // so a raw socket can never name a provider/action it does not own.
    let pollProvider: string | null = null;
    if (job.kind === "ingest_poll") {
      const poll = ingestPollJobPayloadSchema.safeParse(job.payload);
      pollProvider = poll.success ? poll.data.provider : null;
    }
    this.pollProvider = pollProvider;
    let scheduledAction: string | null = null;
    if (job.kind === "scheduled") {
      const scheduled = scheduledJobPayloadSchema.safeParse(job.payload);
      scheduledAction = scheduled.success ? scheduled.data.action : null;
    }
    this.scheduledAction = scheduledAction;
    this.scopedStore = createJobScopedStore(baseStore, { jobId: job.id, workItemId: this.workItemId });
    this.memory = memory;
    this.storeDb = storeDb;
    this.server = createServer((socket) => {
      this.connection = socket;
      this.buffer = [];
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => this.onData(socket, chunk));
      socket.on("error", () => {
        /* the child closed/crashed; the run/exit path is the teardown proof */
      });
      socket.on("close", () => {
        if (this.connection === socket) this.connection = null;
        this.rejectAllModelCalls(new Error("sandbox child socket closed mid-consolidation"));
      });
    });
  }

  /**
   * Creates the server over the supervisor's real store (wrapped in the
   * job's scope) + its real memory provider (so kb ingest can save org
   * memories). The validated {@link WorkerJob} envelope is the immutable
   * authorization context every RPC method is checked against. Without a
   * provider (probe lane, which never saves), a write-denying provider is
   * used. The supervisor's own `db` handle is used only for
   * `maintainMemory`/`postOutboxRow` — it never crosses the socket.
   */
  static create(
    baseStore: Store,
    job: WorkerJob,
    dir: string,
    opts: {
      name?: string;
      memoryProvider?: ResolvedMemoryProvider;
      /**
       * The supervisor's registered extension manifest/provider ids (issue
       * #101): the only providers this job's container may enumerate
       * credentials for. Derived from the immutable runtime extension
       * registry, never from the caller. Absent → an empty set, so
       * listExtensionCredentials is denied outright (fail closed).
       */
      extensionProviderIds?: Iterable<string>;
    } = {},
  ): JobStoreRpcServer {
    mkdirSync(dir, { recursive: true });
    return new JobStoreRpcServer(
      baseStore,
      job,
      join(dir, opts.name ?? "store.sock"),
      opts.memoryProvider ?? memoryDenyProvider,
      baseStore.getDb(),
      new Set(opts.extensionProviderIds ?? []),
    );
  }

  /** Binds the unix socket and resolves once it is listening (or rejects on error). */
  listen(): Promise<void> {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    this.server.once("error", reject);
    this.server.listen(this.socketPath, () => {
      this.server.removeListener("error", reject);
      resolve();
    });
    return promise;
  }

  private onData(socket: Socket, chunk: string): void {
    this.buffer.push(Buffer.from(chunk));
    const total = this.buffer.reduce((sum, b) => sum + b.length, 0);
    if (total > MAX_RPC_BUFFER_BYTES) {
      socket.destroy(); // oversized frame: fail closed
      return;
    }
    for (let line = this.takeLine(); line !== null; line = this.takeLine()) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        socket.write(replyFrame(-1, false, undefined, "malformed RPC frame"));
        socket.destroy();
        return;
      }
      const req = rpcRequestSchema.safeParse(parsed);
      if (req.success) {
        // A frame with a method is the child calling us (request). The child's
        // replies to its own calls never traverse back to us (we generate them).
        void this.handleFrame(socket, req.data);
        continue;
      }
      // A frame without a method is a reply: to a supervisor model-call
      // (in-flight in this.modelCallRequesters). Anything else is ignored.
      const reply = rpcReplySchema.safeParse(parsed);
      if (reply.success) {
        this.onModelCallReply(reply.data);
      }
      continue;
    }
  }

  /** Extracts the next complete line from the buffered stream, or null. */
  private takeLine(): string | null {
    const joined = Buffer.concat(this.buffer);
    const nl = joined.indexOf(10);
    if (nl === -1) return null;
    const line = joined.subarray(0, nl).toString("utf8");
    this.buffer = [joined.subarray(nl + 1)];
    return line;
  }

  private async handleFrame(socket: Socket, req: RpcRequest): Promise<void> {
    try {
      const value =
        req.ns === "store"
          ? await this.invokeStore(req.method, req.args)
          : await this.invokeMemory(socket, req.method, req.args);
      socket.write(replyFrame(req.id, true, value));
    } catch (error) {
      socket.write(replyFrame(req.id, false, undefined, error instanceof Error ? error.message : String(error)));
    }
  }

  private async invokeStore(method: string, args: unknown[]): Promise<RpcWireValue> {
    if (method === "getDb" || method === "close") {
      throw new Error(`job sandbox attempted ${method}; the raw store handle is never exposed to the container`);
    }
    if (!(method in ALLOWED_STORE_METHODS)) {
      throw new Error(`job sandbox attempted store method ${method}; not on the allowlist — denied`);
    }
    // Every allowlisted method is validated against the immutable job
    // envelope BEFORE it reaches the scoped-store facade, so a raw socket
    // can never name another job, work item, space, provider, or extension.
    const authorized = await this.authorizeStoreMethod(method, args);
    if (method === "postOutboxRow") {
      const input = outboxWriteSchema.safeParse(args[0]);
      if (!input.success) throw new Error(`job sandbox posted a malformed outbox row: ${input.error.message}`);
      // The outbox envelope must name THIS job's id/kind/space — never a
      // forged completion signal for another job.
      this.authorizePostOutboxRow(input.data);
      postOutboxRow(this.scopedStore, input.data);
      return undefined;
    }
    // (Method is on the allowlist → a real function on the scoped-store
    // facade; a malformed facade surfaces as a thrown call error below,
    // which the frame handler turns into an error reply — fail closed.)
    const scopedStoreAny: unknown = this.scopedStore;
    // SAFETY: every allowlisted method exists as a function on the scoped
    // store (the facade implements the full Store interface); widening the
    // facade to a method map is the documented dispatch seam and any
    // unexpected member fails closed when its invocation throws.
    const member = (scopedStoreAny as StoreMethodMap)[method];
    return member.apply(this.scopedStore, authorized);
  }

  /**
   * Per-method argument authorization against the immutable job context.
   * Returns the (possibly transformed) arguments the store facade receives.
   * Throws loudly on any argument that names a target outside the job's own
   * envelope: another job id, work item, space, provider, or extension.
   */
  private async authorizeStoreMethod(method: string, args: unknown[]): Promise<unknown[]> {
    const deny = (what: string): never => {
      throw new ScopedStoreAccessError(this.job.id, what);
    };
    const ownItem = (id: string): string =>
      this.workItemId !== null && id === this.workItemId ? id : deny(`work-item access to ${id}`);
    const ownSpace = (id: string): string => {
      if (this.job.spaceId === undefined || this.job.spaceId === null) {
        // A job without a space (scheduled memory_consolidation) never reads
        // a space; a job WITH a space may only read its own.
        deny(`space read ${id} — this job has no space scope`);
      }
      return id === this.job.spaceId ? id : deny(`space access to ${id}`);
    };

    switch (method) {
      case "getJob":
      case "completeJob":
      case "failJob":
      case "requeueJob":
      case "renewJobLease": {
        // The job-row method must name this job's own envelope id. The wire id
        // is decoded as a string at this boundary (a non-string can never
        // equal the job's string id, so it is denied identically to before).
        const id = z.string().safeParse(args[0]);
        if (!id.success || id.data !== this.job.id) {
          deny(`job-row access to ${String(args[0])}`);
        }
        return [id.data!, ...args.slice(1)];
      }
      case "getSpace":
      case "getSpaceSettings":
      case "getEffectiveSpaceSettings": {
        // Space reads are restricted to this job's own space.
        const id = z.string().safeParse(args[0]);
        if (!id.success) {
          deny(`space access to ${String(args[0])}`);
        }
        return [ownSpace(id.data!), ...args.slice(1)];
      }
      case "claimWorkItemById":
      case "getWorkItem":
      case "transitionWorkItem": {
        const id = z.string().safeParse(args[0]);
        if (!id.success) {
          deny(`work-item access to ${String(args[0])}`);
        }
        return [ownItem(id.data!), ...args.slice(1)];
      }
      case "appendAudit": {
        const parsedEntry = auditEntrySchema.safeParse(args[0]);
        if (!parsedEntry.success) {
          deny(`malformed audit entry: ${parsedEntry.error.message}`);
        }
        // deny() never returns, so the entry is settled here; the row fields
        // are read off a non-null handle (the repo's deny guard does not
        // narrow the discriminated union).
        const row = parsedEntry.data!;
        // A child may only write the events its OWN kind legitimately emits,
        // with the legitimate actor and the space binding that event owns
        // (own space, or the pinned org-level null for kb memory.write). An
        // event/actor pair not in this kind's policy, or a row pinning any
        // other space / a fabricated org-level row, is a forged evidence
        // write and is refused.
        const rule = auditPolicyRule(this.job.kind, row.event_type, row.actor);
        if (rule === null) {
          deny(
            `audit row (${row.event_type} by ${row.actor}) — not an event this ${this.job.kind} job legitimately writes`,
          );
        }
        const boundRule = rule!;
        const auditSpace = row.space_id ?? null;
        const desiredSpace = boundRule.space === "null" ? null : (this.job.spaceId ?? null);
        if (auditSpace !== desiredSpace) {
          deny(
            `audit row for space ${String(auditSpace)} — this ${this.job.kind} ${boundRule.eventType} row must be ${desiredSpace === null ? "org-level (null)" : `in the job's own space (${desiredSpace})`}`,
          );
        }
        return args;
      }
      case "queryAudit":
      case "listAudit": {
        // The audit READ must be scoped to the job's own space — a filterless
        // query would list every space's rows. Null-space jobs never legitimately
        // read audit (memory_consolidation runs maintainMemory, not audit reads).
        const nullSpaceJob = this.job.spaceId === undefined || this.job.spaceId === null;
        if (nullSpaceJob) {
          deny(`${method} — this job has no space scope to audit against`);
        }
        if (method === "queryAudit") {
          const opts = auditQuerySchema.safeParse(args[0] ?? {});
          if (!opts.success) deny(`malformed audit query: ${opts.error.message}`);
          // deny() never returns, so the query is settled here; the repo's deny
          // guard does not narrow the discriminated union, so read off a non-null handle.
          const query = opts.data!;
          if (query.space_id !== this.job.spaceId) {
            deny(`audit query must be scoped to this job's space (${String(this.job.spaceId)})`);
          }
        } else {
          const opts = auditListSchema.safeParse(args[0] ?? {});
          if (!opts.success) deny(`malformed audit list: ${opts.error.message}`);
          const list = opts.data!;
          if (list.space !== this.job.spaceId) {
            deny(`audit list must be scoped to this job's space (${String(this.job.spaceId)})`);
          }
        }
        return args;
      }
      case "listExtensionCredentials":
        return this.authorizeExtensionMethod(args);
      case "getIngestWatermark":
      case "setIngestWatermark": {
        if (this.job.kind !== "ingest_poll" || this.pollProvider === null) {
          deny(`${method} — ingest_poll jobs only, and only their own validated provider`);
        }
        const providerArg = args[0];
        if (providerArg !== this.pollProvider) {
          deny(`${method} for provider ${String(providerArg)} — not this job's provider (${this.pollProvider})`);
        }
        if (method === "setIngestWatermark") {
          const write = ingestWatermarkWriteSchema.safeParse(args);
          if (!write.success) {
            deny(`malformed ingest watermark write: ${write.error.message}`);
          }
          return args;
        }
        return args;
      }
      default:
        // Own-row/work-item methods without a named-target guard rely on the
        // scoped-store facade's own job-row firewall; nothing else is on the
        // allowlist to reach here.
        return args;
    }
  }

  /** Rejects an outbox completion row that does not name THIS job's id/kind/space. */
  private authorizePostOutboxRow(input: z.infer<typeof outboxWriteSchema>): void {
    const mismatches: string[] = [];
    if (input.id !== this.job.id) mismatches.push(`id ${input.id} (job is ${this.job.id})`);
    if (input.kind !== this.job.kind) mismatches.push(`kind ${input.kind} (job is ${this.job.kind})`);
    const space = input.space ?? null;
    if (space !== (this.job.spaceId ?? null)) mismatches.push(`space ${String(space)} (job is ${String(this.job.spaceId)})`);
    if (mismatches.length > 0) {
      throw new ScopedStoreAccessError(
        this.job.id,
        `outbox row ${mismatches.join(", ")} — the completion signal must name this job`,
      );
    }
  }

  /** Extension credentials: extension jobs only, and ONLY THIS job's extension-delivery work item. */
  private async authorizeExtensionMethod(args: unknown[]): Promise<unknown[]> {
    const deny = (what: string): never => {
      throw new ScopedStoreAccessError(this.job.id, what);
    };
    // Only extension-delivery work-item jobs may read the credential ladder;
    // a git/scheduled/kb/ingest_poll job never legitimately enumerates it.
    const workItemId = this.workItemId;
    if (this.job.kind !== "extension") {
      deny("extension credential read — extension work-item jobs only");
    }
    if (workItemId === null) {
      throw new ScopedStoreAccessError(this.job.id, "extension credential read — extension work-item jobs only");
    }
    const item = await this.scopedStore.getWorkItem(workItemId);
    if (item === null || item.delivery !== "extension") {
      deny(`extension credential read — work item ${this.workItemId} is not an extension delivery`);
    }
    const provider = z.string().safeParse(args[0]);
    if (provider.success && provider.data !== "") {
      // listExtensionCredentials(provider) is called by the extension runtime
      // with the extension's OWN manifest.id (server-validated registry id).
      // The child is authorized only for the providers registered in the
      // SUPERVISOR's immutable extension registry (the same registry that
      // built its gated toolset) — never for an arbitrary caller-supplied
      // string. A hostile child cannot enumerate credential metadata for a
      // provider that was never loaded for this job's environment.
      if (!this.extensionProviderIds.has(provider.data)) {
        deny(
          `extension credential read for provider ${provider.data} — not a registered extension for this job's registry`,
        );
      }
    } else {
      deny("extension credential read with a non-string provider");
    }
    // The credential rows carry metadata only (secrets stay in the vault).
    return args;
  }

  private async invokeMemory(socket: Socket, method: string, args: unknown[]): Promise<RpcWireValue> {
    switch (method) {
      case "capabilities":
        return this.memory.capabilities;
      case "backend":
        return "backend" in this.memory ? String(this.memory.backend) : "sqlite";
      case "save": {
        const input = memorySaveSchema.safeParse(args[0]);
        if (!input.success) {
          throw new ScopedStoreAccessError(this.job.id, `malformed memory save: ${input.error.message}`);
        }
        this.authorizeMemoryScope(input.data.scope);
        // SAFETY: memorySaveSchema parses exactly the fields MemorySaveInput
        // carries (scope/content/metadata) with the shape the provider
        // requires; the schema fragment constants mirror the input interface.
        return await this.memory.save(input.data as MemorySaveInput);
      }
      case "search": {
        const query = memorySearchSchema.safeParse(args[0]);
        if (!query.success) {
          throw new ScopedStoreAccessError(this.job.id, `malformed memory search: ${query.error.message}`);
        }
        this.authorizeMemoryScope(query.data.scope);
        // SAFETY: memorySearchSchema parses exactly the fields MemorySearchQuery
        // carries (query/scope/limit/metadata); the schema mirrors the query interface.
        return await this.memory.search(query.data as MemorySearchQuery);
      }
      case "forget": {
        const input = memoryForgetSchema.safeParse(args[0]);
        if (!input.success) {
          throw new ScopedStoreAccessError(this.job.id, `malformed memory forget: ${input.error.message}`);
        }
        this.authorizeMemoryScope(input.data.scope);
        return await this.memory.forget(input.data);
      }
      case "pruneDigests": {
        const parsed = pruneDigestsArgsSchema.safeParse(args);
        if (!parsed.success) {
          throw new ScopedStoreAccessError(this.job.id, "malformed memory pruneDigests");
        }
        const [spaceId, keep] = parsed.data;
        const ownSpace = this.job.spaceId;
        if (ownSpace === undefined || ownSpace === null || spaceId !== ownSpace) {
          throw new ScopedStoreAccessError(
            this.job.id,
            `memory pruneDigests for space ${String(spaceId)} — not this job's space`,
          );
        }
        return await this.memory.pruneDigests(spaceId, keep);
      }
      case "maintainMemory": {
        // Only the scheduled memory_consolidation envelope may run the
        // supervisor's compactor. Every other kind fails closed.
        if (this.job.kind !== "scheduled" || this.scheduledAction !== "memory_consolidation") {
          throw new ScopedStoreAccessError(
            this.job.id,
            `maintainMemory — scheduled memory_consolidation jobs only (job is ${this.job.kind}/${this.scheduledAction})`,
          );
        }
        if (this.connection === null) throw new Error("sandbox memory maintainMemory without a live child socket");
        // The consolidation LLM leg runs in the WORKER (issue #272): the
        // supervisor issues a bounded supervisor→child model-call and awaits
        // the reply over the same socket. All DB work stays supervisor-side.
        const modelCall: ConsolidationModelCall = async (systemPrompt, input) =>
          this.requestModelCall(socket, systemPrompt, input);
        return await maintainMemory(this.storeDb, modelCall);
      }
      default:
        throw new Error(`job sandbox attempted unknown memory method ${method}; denied`);
    }
  }

  /** The one memory scope a job may touch: org (the shared floor) or its OWN channel/team. */
  private authorizeMemoryScope(scope: MemoryScopeKey): void {
    const deny = (what: string): never => {
      throw new ScopedStoreAccessError(this.job.id, what);
    };
    switch (scope.kind) {
      case "org":
        // The org pool is the shared floor every worker job may read/write (#137).
        return;
      case "channel":
        if (scope.spaceId !== this.job.spaceId) {
          deny(`memory channel scope ${scope.spaceId} — not this job's space (${String(this.job.spaceId)})`);
        }
        return;
      case "team":
        if (scope.teamId !== this.job.spaceId) {
          deny(`memory team scope ${scope.teamId} — not this job's space (${String(this.job.spaceId)})`);
        }
        return;
      case "person":
        // Worker jobs are channel/work-item executions, never a person DM;
        // a hostile container cannot pick another user's person pool.
        deny("memory person scope — worker jobs have no person principal");
    }
  }

  private requestModelCall(
    socket: Socket,
    systemPrompt: string,
    input: string,
  ): Promise<string | undefined> {
    const id = ++this.modelCallNextId;
    const { promise, resolve, reject } = Promise.withResolvers<string | undefined>();
    // A bounded supervisor→child call: if the worker never replies, reject
    // loudly and drop the requester so the server never leaks or hangs.
    const timeout = setTimeout(() => {
      this.modelCallRequesters.delete(id);
      reject(new Error(`sandbox model call timed out after ${RPC_CALL_TIMEOUT_MS} ms`));
    }, RPC_CALL_TIMEOUT_MS);
    this.modelCallRequesters.set(id, {
      resolve: (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    });
    socket.write(
      Buffer.from(`${JSON.stringify({ ns: "memory", id, method: "@model-call", args: [systemPrompt, input] })}\n`),
    );
    return promise;
  }

  private rejectAllModelCalls(error: Error): void {
    for (const requester of this.modelCallRequesters.values()) requester.reject(error);
    this.modelCallRequesters.clear();
  }

  /** The child's reply to a supervisor-issued @model-call request. */
  onModelCallReply(reply: z.infer<typeof rpcReplySchema>): void {
    if (reply.ok) {
      this.resolveModelCall(reply.id, reply.value);
    } else {
      this.rejectModelCall(reply.id, new Error(reply.error ?? "sandbox model call failed"));
    }
  }

  private resolveModelCall(id: number, value: string | undefined): void {
    const requester = this.modelCallRequesters.get(id);
    if (requester !== undefined) {
      this.modelCallRequesters.delete(id);
      requester.resolve(value);
    }
  }

  private rejectModelCall(id: number, error: Error): void {
    const requester = this.modelCallRequesters.get(id);
    if (requester !== undefined) {
      this.modelCallRequesters.delete(id);
      requester.reject(error);
    }
  }

  close(): void {
    this.rejectAllModelCalls(new Error("sandbox store RPC server closed mid-consolidation"));
    if (this.connection !== null) this.connection.destroy();
    this.server.close();
  }
}

/** A memory provider that rejects writes — used only by the probe lane. */
export const memoryDenyProvider: ResolvedMemoryProvider = {
  backend: "sqlite",
  capabilities: { consolidation: "unsupported", digestPruning: "unsupported", forget: "unsupported" },
  save: () => {
    throw new Error("job sandbox probe memory provider may only search (no shared-store writes)");
  },
  search: async () => [],
  pruneDigests: async () => {
    throw new Error("job sandbox probe memory provider cannot prune digests");
  },
  forget: () => {
    throw new Error("job sandbox probe memory provider cannot forget (read-only probe axis)");
  },
};
/**
 * Child-side store + memory client over the mounted socket dir. The
 * returned {@link RpcSessionLink.store} is an EXPLICIT facade (no Proxy
 * fallthrough): it exposes exactly the allowlisted methods, so an unknown
 * or global method fails closed locally and is never forwarded over the
 * socket. `getDb`/`close` are denied locally. The supervisor validates
 * scoped-store access on every call. `ready()` probes the supervisor's
 * memory capabilities so job bodies read correct sync values; call
 * {@link RpcSessionLink.close} on teardown.
 */
export function connectStoreRpc(socketPath: string): RpcSessionLink {
  const socket = dial(socketPath);
  let nextId = 1;
  const pending = new Map<number, { resolve: (r: RpcReply) => void; reject: (e: Error) => void }>();
  let buffer: Buffer[] = [];
  let onModelCall: ((systemPrompt: string, input: string) => Promise<string | undefined>) | undefined;
  const ready = Promise.withResolvers<void>();

  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffer.push(Buffer.from(chunk));
    const total = buffer.reduce((sum, b) => sum + b.length, 0);
    if (total > MAX_RPC_BUFFER_BYTES) {
      socket.destroy();
      return;
    }
    for (;;) {
      const joined = Buffer.concat(buffer);
      const nl = joined.indexOf(10);
      if (nl === -1) break;
      const line = joined.subarray(0, nl).toString("utf8");
      buffer = [joined.subarray(nl + 1)];
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        socket.destroy();
        return;
      }
      const asRequest = rpcRequestSchema.safeParse(parsed);
      if (asRequest.success) {
        // A supervisor-initiated request (@model-call): handle and reply.
        void handleIncomingRequest(asRequest.data);
        continue;
      }
      // A frame that failed the request-schema parse is a reply: it carries id/ok
      // (and optional value/error) from the supervisor. The client reads only
      // those fields to resolve a pending call; a malformed reply is dropped
      // by pending.get(id) or fails closed on the socket.
      // SAFETY: the request schema parse above already rejected non-reply
      // frames; the supervisor's replies always carry id/ok, so this cast is
      // safe and anything unexpected is rejected by the pending lookup.
      const reply = parsed as RpcReply;
      const waiter = pending.get(reply.id);
      if (waiter !== undefined) {
        pending.delete(reply.id);
        if (reply.ok) waiter.resolve(reply);
        else waiter.reject(new Error(reply.error ?? "sandbox RPC failed"));
      }
    }
  });
  socket.on("error", () => {
    for (const waiter of pending.values()) waiter.reject(new Error("sandbox store RPC socket error"));
    pending.clear();
    ready.reject(new Error("sandbox store RPC socket error"));
  });
  socket.on("close", () => {
    for (const waiter of pending.values()) waiter.reject(new Error("sandbox store RPC socket closed"));
    pending.clear();
  });

  const call = <T>(ns: "store" | "memory", method: string, args: unknown[], timeoutMs = RPC_CALL_TIMEOUT_MS): Promise<T> => {
    const { promise, resolve, reject } = Promise.withResolvers<T>();
    if (socket.destroyed) {
      reject(new Error("sandbox store RPC socket closed"));
      return promise;
    }
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`sandbox RPC call ${ns}.${method} timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    pending.set(id, {
      resolve: (reply) => {
        clearTimeout(timer);
        // SAFETY: call<T> names the expected return type for each allowlisted
        // method; the supervisor's reply value is the JSON serialization of
        // that method's result, so the cast is exact per-method contract.
        resolve(reply.value as T);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
    socket.write(Buffer.from(`${JSON.stringify({ ns, id, method, args })}\n`));
    return promise;
  };

  function handleIncomingRequest(req: RpcRequest): void {
    if (req.ns !== "memory" || req.method !== "@model-call") {
      socket.write(replyFrame(req.id, false, undefined, "unexpected supervisor request"));
      return;
    }
    const handler = onModelCall;
    if (!handler) {
      socket.write(replyFrame(req.id, false, undefined, "sandbox has no model-call handler registered"));
      return;
    }
    // The supervisor-issued @model-call request always carries exactly
    // [systemPrompt, input] (this client constructs that frame shape, and the
    // request schema already guaranteed args is a present array).
    // SAFETY: the @model-call frame is built by this client with a two-arg
    // array, so the destructure is exact; a mismatched supervisor frame is a
    // supervisor-controlled (trusted) frame, not attacker input.
    const [systemPrompt, input] = req.args as [string, string];
    void Promise.resolve()
      .then(() => handler(systemPrompt, input))
      .then((value) => socket.write(replyFrame(req.id, true, value)))
      .catch((err) =>
        socket.write(replyFrame(req.id, false, undefined, err instanceof Error ? err.message : String(err))),
      );
  }

  // The child's EXPLICIT store facade: only the allowlisted methods exist;
  // anything else is a compile-time error and is never forwarded.
  const store: RpcSessionLink["store"] = {
    claimWorkItemById: (id, assignee) => call("store", "claimWorkItemById", [id, assignee]),
    getWorkItem: (id) => call("store", "getWorkItem", [id]),
    transitionWorkItem: (id, from, to, opts) => call("store", "transitionWorkItem", [id, from, to, opts]),
    getJob: (id) => call("store", "getJob", [id]),
    completeJob: (id) => call("store", "completeJob", [id]),
    failJob: (id) => call("store", "failJob", [id]),
    requeueJob: (id, backoffMs) => call("store", "requeueJob", [id, backoffMs]),
    renewJobLease: (id, leaseUntilMs) => call("store", "renewJobLease", [id, leaseUntilMs]),
    appendAudit: (entry) => call("store", "appendAudit", [entry]),
    queryAudit: (opts) => call("store", "queryAudit", [opts]),
    listAudit: (opts) => call("store", "listAudit", [opts]),
    getOrgSettings: () => call("store", "getOrgSettings", []),
    getSpace: (id) => call("store", "getSpace", [id]),
    getSpaceSettings: (id) => call("store", "getSpaceSettings", [id]),
    getEffectiveSpaceSettings: (id) => call("store", "getEffectiveSpaceSettings", [id]),
    listExtensionCredentials: (provider) => call("store", "listExtensionCredentials", [provider]),
    getIngestWatermark: (provider) => call("store", "getIngestWatermark", [provider]),
    setIngestWatermark: (provider, cursor) => call("store", "setIngestWatermark", [provider, cursor]),
    postOutboxRow: (input) => call("store", "postOutboxRow", [input]),
    getDb: () => {
      throw new Error("job sandbox may not access the raw store handle (getDb)");
    },
    close: () => {
      throw new Error("job sandbox may not access the raw store handle (close)");
    },
  };

  // capabilities/backend are fetched from the supervisor when ready() resolves
  // (always awaited before job bodies read the provider) and the final provider
  // is then built with correct readonly values — never mutated in place.
  let memoryProvider: ResolvedMemoryProvider = {
    backend: "sqlite",
    capabilities: { consolidation: "explicit", digestPruning: "explicit", forget: "unsupported" },
    save: (input) => call<MemoryEntry>("memory", "save", [input]),
    search: (query) => call<MemoryEntry[]>("memory", "search", [query]),
    pruneDigests: (spaceId, keep) => call<number>("memory", "pruneDigests", [spaceId, keep]),
    forget: (input) => call<MemoryTombstone>("memory", "forget", [input]),
  };

  return {
    store,
    // A getter, not a by-value snapshot: ready() rebinds the local
    // `memoryProvider` to the supervisor-resolved readonly capabilities/
    // backend, and callers must observe the resolved provider after ready().
    get memoryProvider(): ResolvedMemoryProvider {
      return memoryProvider;
    },
    ready: async () => {
      try {
        const [capabilities, backend] = await Promise.all([
          call<ResolvedMemoryProvider["capabilities"]>("memory", "capabilities", []),
          call<string>("memory", "backend", []),
        ]);
        memoryProvider = {
          backend: backend === "mem0" ? "mem0" : "sqlite",
          capabilities,
          save: (input) => call<MemoryEntry>("memory", "save", [input]),
          search: (query) => call<MemoryEntry[]>("memory", "search", [query]),
          pruneDigests: (spaceId, keep) => call<number>("memory", "pruneDigests", [spaceId, keep]),
          forget: (input) => call<MemoryTombstone>("memory", "forget", [input]),
        };
        ready.resolve();
      } catch (error) {
        ready.reject(error instanceof Error ? error : new Error(String(error)));
      }
      return ready.promise;
    },
    setConsolidationModelCall: (handler) => {
      onModelCall = handler;
    },
    maintainMemory: () => call<ConsolidationResult[]>("memory", "maintainMemory", []),
    close: () => {
      socket.destroy();
    },
  };
}

/** The child's bounded store + memory RPC session (explicit method surface). */
export interface RpcSessionLink {
  store: {
    claimWorkItemById(id: string, assignee?: string): Promise<WorkItem | null>;
    getWorkItem(id: string): Promise<WorkItem | null>;
    transitionWorkItem(id: string, from: WorkItemState, to: WorkItemState, opts?: TransitionOpts): Promise<WorkItem>;
    getJob(id: string): Promise<WorkerJob | null>;
    completeJob(id: string): Promise<boolean>;
    failJob(id: string): Promise<boolean>;
    requeueJob(id: string, backoffMs: number): Promise<boolean>;
    renewJobLease(id: string, leaseUntilMs: number): Promise<boolean>;
    appendAudit(entry: AuditEntry): Promise<number>;
    queryAudit(opts?: AuditQueryOpts): Promise<AuditPage>;
    listAudit(opts?: ListAuditOpts): Promise<AuditRow[]>;
    getOrgSettings(): Promise<OrgSettings | null>;
    getSpace(id: string): Promise<Space | null>;
    getSpaceSettings(id: string): Promise<SpaceModelSettings>;
    getEffectiveSpaceSettings(id: string): Promise<SpaceModelSettings>;
    listExtensionCredentials(provider: string): Promise<ExtensionCredential[]>;
    getIngestWatermark(provider: string): Promise<string | null>;
    setIngestWatermark(provider: string, cursor: string): Promise<void>;
    postOutboxRow(input: OutboxWrite): Promise<void>;
    getDb(): never;
    close(): never;
  };
  memoryProvider: ResolvedMemoryProvider;
  /** Probes the supervisor's memory capabilities/backend before job bodies read them. */
  ready(): Promise<void>;
  /** Registers the worker's consolidation model-call handler (LLM leg of supervisor-side maintainMemory). */
  setConsolidationModelCall(handler: (systemPrompt: string, input: string) => Promise<string | undefined>): void;
  /** Runs supervisor-side maintainMemory with the registered model-call leg. */
  maintainMemory(): Promise<ConsolidationResult[]>;
  close(): void;
}

function dial(socketPath: string): Socket {
  // node:net connect(): the socket dials lazily on first write; errors are
  // surfaced to pending callers via the socket 'error' handler.
  return connect(socketPath);
}
