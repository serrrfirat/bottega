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
 *     getEffectiveSpaceSettings, getOrgSettings, getSpace.
 *   - extension worker toolset/surfaces: listExtensionCredentials,
 *     getExtensionConnection, listRuntimeExtensions.
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
  RuntimeExtensionRow,
  AuditEntry,
  AuditPage,
  AuditQueryOpts,
  ListAuditOpts,
  AuditRow,
} from "../store/db";
import type { OrgSettings } from "../store/org-settings";
import type { WorkerJob } from "../worker/envelope";
import { createJobScopedStore, type JobScope } from "./scoped-store";
import { postOutboxRow, type OutboxWrite } from "../store/outbox";
import { maintainMemory, type ConsolidationModelCall, type ConsolidationResult } from "../memory/consolidation";
import type { MemoryEntry, MemoryProvider, MemorySaveInput, MemorySearchQuery } from "../memory/types";
import type { ResolvedMemoryProvider } from "../server/memory-provider";

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
  value?: unknown;
  error?: string;
}

/**
 * The ONLY store operations the job container may invoke. Everything the
 * git/extension/kb/ingest_poll/scheduled job bodies need for their own
 * lifecycle (scoped claim/transitions/job rows, the durable ingest
 * watermark, the self-bookkeeping outbox row), plus the read-only shared
 * infra they legitimately consult (org settings, space settings, extension
 * connection/registry reads). Anything else — policy writes, credentials,
 * scheduler rows, enqueues, upload tokens — is denied, even though the
 * scoped-store facade itself forwards those to the real store (the
 * facade's job-row firewall is not a global-write firewall). `getDb` and
 * `close` are hard-denied (the raw handle never crosses).
 */
const ALLOWED_STORE_METHODS: Record<string, true> = {
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
  getOrgSettings: true,
  getSpace: true,
  getSpaceSettings: true,
  getEffectiveSpaceSettings: true,
  listExtensionCredentials: true,
  getExtensionConnection: true,
  listRuntimeExtensions: true,
  getIngestWatermark: true,
  setIngestWatermark: true,
  // `postOutboxRow` is handled specially: it is a module function that needs
  // the raw DB (transactional INSERT OR IGNORE), so the supervisor invokes the
  // real outbox writer, never the child.
  postOutboxRow: true,
};

/** The child outbox write envelope (validated supervisor-side). */
const outboxWriteSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(["git", "extension", "kb", "scheduled", "work_item", "ingest_poll"]),
    payload: z.unknown(),
    space: z.string().nullable().optional(),
  })
  .strict();

function replyFrame(id: number, ok: boolean, value?: unknown, error?: string): Buffer {
  return Buffer.from(`${JSON.stringify({ id, ok, ...(ok ? { value } : { error }) })}\n`);
}

/**
 * Supervisor-side RPC host for one job's scoped store + memory. Creates the
 * socket dir + unix socket, serves bounded frames, enforces job scope via
 * {@link createJobScopedStore} AND the store allowlist, and forwards memory
 * to the supervisor's real (SQLite/mem0) provider. Unknown/
 * global/oversized/malformed/timed-out frames fail closed. Call {@link
 * close} after the job container exits.
 */
export class JobStoreRpcServer {
  readonly socketPath: string;
  private readonly server: Server;
  private connection: Socket | null = null;
  private buffer: Buffer[] = [];
  private readonly scopedStore: Store;
  private readonly memory: MemoryProvider;
  private readonly storeDb: Database;
  private readonly modelCallRequesters = new Map<number, { resolve: (v: string | undefined) => void; reject: (e: Error) => void }>();

  private constructor(
    baseStore: Store,
    scope: JobScope,
    socketPath: string,
    memory: MemoryProvider,
    storeDb: Database,
  ) {
    this.socketPath = socketPath;
    this.scopedStore = createJobScopedStore(baseStore, scope);
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
   * memories). Without a provider (probe lane, which never saves), a
   * write-denying provider is used. The supervisor's own `db` handle is
   * used only for `maintainMemory`/`postOutboxRow` — it never crosses the
   * socket.
   */
  static create(
    baseStore: Store,
    scope: JobScope,
    dir: string,
    opts: { name?: string; memoryProvider?: ResolvedMemoryProvider } = {},
  ): JobStoreRpcServer {
    mkdirSync(dir, { recursive: true });
    return new JobStoreRpcServer(
      baseStore,
      scope,
      join(dir, opts.name ?? "store.sock"),
      opts.memoryProvider ?? memoryDenyProvider,
      baseStore.getDb(),
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
      // A frame without a method is a reply: either to a supervisor model-call
      // (in-flight in this.modelCallRequesters) or an unexpected reply → ignore.
      if (parsed !== null && typeof parsed === "object" && "id" in parsed) {
        this.onModelCallReply(parsed as RpcReply);
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

  private async invokeStore(method: string, args: unknown[]): Promise<unknown> {
    if (method === "getDb" || method === "close") {
      throw new Error(`job sandbox attempted ${method}; the raw store handle is never exposed to the container`);
    }
    if (ALLOWED_STORE_METHODS[method] !== true) {
      throw new Error(`job sandbox attempted store method ${method}; not on the allowlist — denied`);
    }
    if (method === "postOutboxRow") {
      const input = outboxWriteSchema.safeParse(args[0]);
      if (!input.success) throw new Error(`job sandbox posted a malformed outbox row: ${input.error.message}`);
      postOutboxRow(this.scopedStore, input.data);
      return undefined;
    }
    const member = (this.scopedStore as unknown as Record<string, unknown>)[method];
    if (typeof member !== "function") {
      throw new Error(`job sandbox attempted unknown store method ${method}; denied`);
    }
    return await member.apply(this.scopedStore, args);
  }

  private async invokeMemory(socket: Socket, method: string, args: unknown[]): Promise<unknown> {
    switch (method) {
      case "capabilities":
        return this.memory.capabilities;
      case "backend":
        return "backend" in this.memory ? this.memory.backend : "sqlite";
      case "save":
        return await this.memory.save(args[0] as MemorySaveInput);
      case "search":
        return await this.memory.search(args[0] as MemorySearchQuery);
      case "pruneDigests":
        return await this.memory.pruneDigests(args[0] as string, args[1] as number);
      case "maintainMemory": {
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

  private requestModelCall(
    socket: Socket,
    systemPrompt: string,
    input: string,
  ): Promise<string | undefined> {
    const id = (Date.now() % 2_147_483_647) + 1;
    const { promise, resolve, reject } = Promise.withResolvers<string | undefined>();
    if (this.modelCallRequesters.has(id)) {
      reject(new Error("sandbox model-call id collision"));
      return promise;
    }
    this.modelCallRequesters.set(id, { resolve, reject });
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
  onModelCallReply(reply: RpcReply): void {
    if (reply.ok) {
      this.resolveModelCall(reply.id, reply.value as string | undefined);
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
    if (this.connection !== null) this.connection.destroy();
    this.server.close();
  }
}

/** A memory provider that rejects writes — used only by the probe lane. */
export const memoryDenyProvider: ResolvedMemoryProvider = {
  backend: "sqlite",
  capabilities: { consolidation: "unsupported", digestPruning: "unsupported" },
  save: () => {
    throw new Error("job sandbox probe memory provider may only search (no shared-store writes)");
  },
  search: async () => [],
  pruneDigests: async () => {
    throw new Error("job sandbox probe memory provider cannot prune digests");
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
    getExtensionConnection: (id) => call("store", "getExtensionConnection", [id]),
    listRuntimeExtensions: () => call("store", "listRuntimeExtensions", []),
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
    capabilities: { consolidation: "explicit", digestPruning: "explicit" },
    save: (input) => call<MemoryEntry>("memory", "save", [input]),
    search: (query) => call<MemoryEntry[]>("memory", "search", [query]),
    pruneDigests: (spaceId, keep) => call<number>("memory", "pruneDigests", [spaceId, keep]),
  };

  return {
    store,
    memoryProvider,
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
    getExtensionConnection(id: string): Promise<ExtensionCredential | null>;
    listRuntimeExtensions(): Promise<RuntimeExtensionRow[]>;
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
