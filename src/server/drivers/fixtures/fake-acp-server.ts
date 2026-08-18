/**
 * Scripted fake ACP v1 server for driver tests (issue #17).
 *
 * Speaks newline-delimited JSON-RPC 2.0 over stdio — the ACP v1 stdio
 * transport. Driven by a scenario name, so tests can exercise streaming,
 * cancellation, crashes, unknown-message tolerance, and a hung handshake.
 *
 * Usage: bun run fake-acp-server.ts <scenario> [logfile]
 *
 * Every message written to stdout is appended to the logfile (if given),
 * alongside every message read from stdin, so tests can assert on the exact
 * protocol exchange.
 */
import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";

const scenario = process.argv[2] ?? "happy";
const logfile = process.argv[3] ?? "";

// Scenario behaviors:
//  - happy:  initialize + session/new + streamed prompt replies + session/close.
//            A session/cancel notification answers the pending prompt with
//            stopReason "cancelled" (per the ACP v1 cancellation spec).
//  - crash:  responds to initialize + session/new, streams one chunk on the
//            first session/prompt, then exits(1) without replying.
//  - noisy:  on session/new, sends an unknown notification and an unknown
//            inbound request (which a conforming client must answer with
//            JSON-RPC method-not-found), then behaves like "happy".
//  - permission: on session/new, sends a session/request_permission in the
//            real omp acp shape (toolCall + options, issue #26), then
//            behaves like "happy". argv[4], when given, is JSON overriding
//            {toolCall, options} so tests exercise the whole tool mapping.
//  - silent: never responds to anything (exercises client-side timeouts).
//  - empty:  answers session/prompt with NO text chunks — the model's
//            completion is empty, so the turn ends with no output
//            (exercises the issue #226 empty-completion surface).

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

let sessionId = "sess_fake";
/** The session/prompt request currently awaiting a response, if any. */
let pendingPrompt: { id: number } | null = null;

/** A JSON-RPC 2.0 message on the wire: a request/response with `id`, or a notification with `method`. */
interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
}

function send(msg: JsonRpcMessage): void {
  process.stdout.write(JSON.stringify(msg) + "\n");
  log(msg);
}

function log(msg: JsonRpcMessage): void {
  if (logfile) appendFileSync(logfile, JSON.stringify(msg) + "\n");
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg: { id?: number; method?: string; params?: unknown };
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  log(msg);
  void handle(msg);
});

async function handle(msg: { id?: number; method?: string; params?: unknown }): Promise<void> {
  const { id, method } = msg;
  switch (method) {
    case "initialize":
      if (scenario === "silent") return;
      send({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: 1,
          agentCapabilities: { sessionCapabilities: { close: {} } },
          agentInfo: { name: "fake-acp", version: "1.0.0" },
        },
      });
      break;

    case "session/new":
      if (scenario === "silent") return;
      if (scenario === "noisy") {
        // Unknown notification: conforming clients log and ignore.
        send({ jsonrpc: "2.0", method: "custom/notice", params: { note: "hi" } });
        // Unknown inbound request: conforming clients answer method-not-found.
        send({
          jsonrpc: "2.0",
          id: 99,
          method: "session/request_permission",
          params: { permissionRequest: { id: "p1", title: "Run command" } },
        });
      }
      if (scenario === "permission") {
        // Issue #26: the real omp acp request shape (toolCall + options).
        const override = process.argv[4] ? JSON.parse(process.argv[4]) : {};
        const toolCall = override.toolCall ?? {
          toolCallId: "call_01",
          title: "Run command",
          kind: "execute",
          status: "pending",
          rawInput: { command: "echo hi" },
        };
        const options = override.options ?? [
          { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
          { optionId: "allow_always", name: "Always allow", kind: "allow_always" },
          { optionId: "reject_once", name: "Reject", kind: "reject_once" },
          { optionId: "reject_always", name: "Always reject", kind: "reject_always" },
        ];
        send({
          jsonrpc: "2.0",
          id: 99,
          method: "session/request_permission",
          params: { sessionId, toolCall, options },
        });
      }
      send({ jsonrpc: "2.0", id, result: { sessionId } });
      break;

    case "session/prompt": {
      if (scenario === "silent") return;
      if (scenario === "empty") {
        // The model completes with NO text chunks: an empty completion.
        send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
        return;
      }
      if (scenario === "crash") {
        send({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              messageId: "m1",
              content: { type: "text", text: "partial " },
            },
          },
        });
        setTimeout(() => process.exit(1), 20);
        return;
      }
      pendingPrompt = { id: id ?? -1 };
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            messageId: "m1",
            content: { type: "text", text: "Hello, " },
          },
        },
      });
      await sleep(120);
      if (!pendingPrompt) return; // cancelled while we waited
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            messageId: "m1",
            content: { type: "text", text: "world!" },
          },
        },
      });
      await sleep(120);
      if (!pendingPrompt) return; // cancelled while we waited
      pendingPrompt = null;
      send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
      break;
    }

    case "session/cancel":
      if (pendingPrompt) {
        const target = pendingPrompt;
        pendingPrompt = null;
        send({ jsonrpc: "2.0", id: target.id, result: { stopReason: "cancelled" } });
      }
      break;

    case "session/close":
      send({ jsonrpc: "2.0", id, result: {} });
      setTimeout(() => process.exit(0), 10);
      break;

    default:
      // Unknown client method: intentionally unanswered.
      break;
  }
}
