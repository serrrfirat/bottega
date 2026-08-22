/**
 * #171 writer → reader round-trip pin for the store/memory RPC seam.
 *
 * The client encoder (`connectStoreRpc`) serializes a store call frame as
 * `{ns, id, method, args}`; the server parser (`JobStoreRpcServer`) decodes it
 * with `rpcRequestSchema` and dispatches. This suite drives the REAL pair over
 * a temp unix socket (no docker/child process) and asserts that method, args,
 * and id survive encode → decode → dispatch, and that a reply frame carries
 * id/ok/value back to the reader.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { connect, type Socket } from "node:net";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore, type Store } from "../store/db";
import { resolveMemoryProvider } from "../server/memory-provider";
import { connectStoreRpc, JobStoreRpcServer } from "./store-rpc";

const dirs: string[] = [];
const stores: Store[] = [];
const servers: JobStoreRpcServer[] = [];

afterAll(() => {
  for (const s of servers) {
    try {
      s.close();
    } catch {
      // already closed
    }
  }
  for (const s of stores) s.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "bottega-store-rpc-171-"));
  dirs.push(dir);
  return dir;
}

/**
 * Raw socket client that speaks the store-rpc wire protocol directly.
 *
 * NOTE: this is a real unix-socket integration test, so a bounded wall-clock
 * guard on the reply is deliberate (the rules' "Exceptions" clause): there is
 * no deterministic fake-timer path for `node:net` connection/reply timing, and
 * a hung server/socket must fail fast instead of wedging the suite.
 */
function rawRpc(socketPath: string, frame: string, timeoutMs = 2000): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const socket: Socket = connect(socketPath);
  let buffer = "";
  const timer = setTimeout(() => {
    socket.destroy();
    reject(new Error("raw RPC reply timed out"));
  }, timeoutMs);
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    buffer += chunk;
    const nl = buffer.indexOf("\n");
    if (nl === -1) return;
    clearTimeout(timer);
    socket.destroy();
    resolve(buffer.slice(0, nl));
  });
  socket.on("error", (err) => {
    clearTimeout(timer);
    reject(err instanceof Error ? err : new Error(String(err)));
  });
  socket.on("close", () => {
    clearTimeout(timer);
    if (buffer.length === 0) reject(new Error("raw RPC socket closed without a reply"));
  });
  socket.write(frame);
  return promise;
}

function makeRpc() {
  const dir = tempDir();
  const store = createStore(join(dir, "store.db"));
  stores.push(store);
  const rpcDir = join(dir, "rpc");
  mkdirSync(rpcDir, { recursive: true });
  const server = JobStoreRpcServer.create(
    store,
    {
      id: "job_171",
      kind: "git",
      payload: { workItemId: "wi_171" },
      spaceId: "slack:C171",
      attempts: 1,
      status: "running",
    },
    rpcDir,
    { memoryProvider: resolveMemoryProvider(store.getOrgSettings(), store.getDb()) },
  );
  servers.push(server);
  return { store, dir, server };
}

describe("store RPC writer -> reader round-trip (#171)", () => {
  test("a client-encoded store call decodes server-side and method/args/id survive", async () => {
    const { store, server } = makeRpc();
    // The job's own space exists in the store (the reader must return it).
    const space = await store.getOrCreateSpace({ platform: "slack", channel_id: "C171" });
    expect(space.id).toBe("slack:C171");

    await server.listen();
    const session = connectStoreRpc(server.socketPath);
    try {
      await session.ready();

      // Request round-trip with args: the `[spaceId]` arg must survive the
      // client encoder → server parser → authorize → dispatch path, and the
      // returned Space row proves the value round-trips.
      const got = await session.store.getSpace(space.id);
      expect(got).not.toBeNull();
      expect(got!.id).toBe(space.id);

      // A no-arg method also dispatches; on a fresh store the org floor is
      // unset, so a raw `null` round-trips as the JSON-serializable value.
      await expect(session.store.getOrgSettings()).resolves.toBeNull();
    } finally {
      session.close();
      server.close();
    }
  });

  test("a reply frame carries id/ok/value back to the reader byte-faithfully", async () => {
    const { store, server } = makeRpc();
    await store.getOrCreateSpace({ platform: "slack", channel_id: "C171" });
    await server.listen();
    try {
      // Encode a request with a known id through the raw wire (the client's
      // exact frame shape) and parse the server's reply frame.
      const reply = await rawRpc(
        server.socketPath,
        `${JSON.stringify({ ns: "store", id: 171, method: "getOrgSettings", args: [] })}\n`,
      );
      // SAFETY: the server's replyFrame serializer always writes exactly
      // {id, ok, value?} for a success (or {id, ok, error} for a failure), so
      // the parsed JSON satisfies the id/ok/value/error shape.
      const parsed = JSON.parse(reply) as { id: number; ok: boolean; value: unknown; error?: string };
      // The reply frame round-trips the request id and the ok flag with a value.
      expect(parsed.id).toBe(171);
      expect(parsed.ok).toBe(true);
      expect(parsed.error).toBeUndefined();
      expect(parsed).toHaveProperty("value");
    } finally {
      server.close();
    }
  });
});