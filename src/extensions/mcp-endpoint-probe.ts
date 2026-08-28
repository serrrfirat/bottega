/**
 * Hosted MCP endpoint validation probe (issue #286): proves a candidate
 * server URL actually speaks MCP — or is OAuth-gated — BEFORE it can be
 * registered from the catalog or pinned by catalog_browser. Both paths
 * previously persisted a SYNTHESIZED or hand-typed endpoint without ever
 * contacting it (the broken Gmail pin bound
 * https://gmailmcp.googleapis.com/mcp — a 404 — while the official
 * endpoint is /mcp/v1).
 *
 * Wire shape — a raw POST JSON-RPC `initialize` (not a full Client/
 * transport/session, which would add session state and another failure
 * surface):
 *
 *   - Headers: content-type application/json, accept
 *     application/json + text/event-stream, MCP-Protocol-Version set to
 *     the SDK's LATEST_PROTOCOL_VERSION.
 *   - Body: { jsonrpc: "2.0", id: 1, method: "initialize", params } with
 *     empty capabilities and a probe clientInfo.
 *   - Wall-clock bound: MCP_DISCOVERY_TIMEOUT_MS (10s) via
 *     AbortSignal.timeout, overridable for hermetic tests.
 *
 * Security posture (fail closed, issue #286):
 *   - HTTPS only: a non-https URL is refused outright and never probed.
 *   - Redirects are never followed (`redirect: "error"`); a 3xx is a
 *     rejected verdict, so egress can never inherit a redirect target.
 *   - No credentials are ever sent; nothing is minted and no OAuth client
 *     is registered — the probe is pre-authorization by construction.
 *   - The verdict is evidence-carrying so the caller can surface an
 *     actionable refusal.
 *
 * Accepted verdicts:
 *   - `mcp`             — HTTP 200 + JSON body, or a Streamable HTTP SSE
 *     body, whose initialize result parses the SDK's exported
 *     InitializeResultSchema with a supported protocol version (the same
 *     validation Client.connect runs).
 *   - `oauth_challenge` — HTTP 401, or 403 with error="insufficient_scope",
 *     plus a single valid Bearer WWW-Authenticate challenge parsed with
 *     the SDK's extractWWWAuthenticateParams (RFC 6750): the endpoint
 *     exists and is OAuth-gated.
 *   - `rejected`        — everything else: 404/405/other errors, missing/
 *     non-Bearer/malformed/duplicate challenges, HTML/non-JSON bodies,
 *     malformed or conflicting SSE, 202/unsupported streams, timeout,
 *     network error, redirect, non-https.
 *
 * The official MCP SDK stays the sole OAuth owner: this probe performs no
 * RFC 8414 discovery, no token-endpoint resolution, and no credential
 * exchange (issue #284 invariants are untouched).
 */
import { extractWWWAuthenticateParams } from "@modelcontextprotocol/sdk/client/auth.js";
import {
  InitializeResultSchema,
  LATEST_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
} from "@modelcontextprotocol/sdk/types.js";
import { errorMessage } from "../tools/helpers";
import { MCP_DISCOVERY_TIMEOUT_MS } from "./generate-tools";
import { isRecord, type JsonValue } from "./manifest";

/** The probe result: accepted (mcp / oauth_challenge) or rejected with evidence. */
export type ProbeVerdict =
  | { ok: true; kind: "mcp" | "oauth_challenge"; evidence: string }
  | { ok: false; rejected: true; evidence: string };

/** Probe options: the injected-fetch seam (hermetic tests) + the timeout bound. */
export interface ProbeMcpEndpointOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Probes one hosted MCP endpoint with a raw JSON-RPC `initialize`. Returns
 * a verdict; never throws — every failure is a rejected verdict carrying
 * bounded evidence for the caller's actionable message.
 */
export async function probeMcpEndpoint(
  serverUrl: string,
  opts: ProbeMcpEndpointOptions = {},
): Promise<ProbeVerdict> {
  const timeoutMs = opts.timeoutMs ?? MCP_DISCOVERY_TIMEOUT_MS;
  const fetchImpl = opts.fetchImpl ?? fetch;

  // HTTPS only: a plain-http endpoint is refused before any request — the
  // probe never sends a byte to an unencrypted MCP host.
  let url: URL;
  try {
    url = new URL(serverUrl);
  } catch {
    return { ok: false, rejected: true, evidence: `invalid URL ${serverUrl}` };
  }
  if (url.protocol !== "https:") {
    return {
      ok: false,
      rejected: true,
      evidence: `refusing ${serverUrl}: the MCP endpoint must be https (plain http is never probed)`,
    };
  }

  let res: Response;
  try {
    res = await fetchImpl(serverUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": LATEST_PROTOCOL_VERSION,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "bottega-probe", version: "1" },
        },
      }),
      // Redirects are never followed: a 3xx (or the fetch-layer rejection a
      // `redirect: "error"` mode produces) is a rejected verdict — the
      // egress allowlist can never inherit a redirect target's host.
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const message = errorMessage(err);
    if (message.toLowerCase().includes("redirect")) {
      return { ok: false, rejected: true, evidence: `redirect (redirects are never followed): ${message}` };
    }
    if (err instanceof Error && err.name === "TimeoutError") {
      return { ok: false, rejected: true, evidence: `request timed out after ${timeoutMs}ms` };
    }
    return { ok: false, rejected: true, evidence: `network error: ${message}` };
  }

  // Redirects are never followed: an actual 3xx response is rejected
  // outright, whatever its Location target.
  if (res.status >= 300 && res.status < 400) {
    return { ok: false, rejected: true, evidence: `HTTP ${res.status} redirect (redirects are never followed)` };
  }

  // OAuth challenge: 401 (or 403 with error="insufficient_scope") plus a
  // single valid Bearer WWW-Authenticate challenge parsed with the SDK's
  // extractWWWAuthenticateParams (RFC 6750 / RFC 9728 resource metadata).
  if (res.status === 401 || res.status === 403) {
    const challenge = parseBearerChallenge(res);
    if (!challenge.ok) {
      return { ok: false, rejected: true, evidence: `HTTP ${res.status} ${challenge.reason}` };
    }
    if (res.status === 403 && challenge.error !== "insufficient_scope") {
      return {
        ok: false,
        rejected: true,
        evidence: `HTTP 403 with a Bearer challenge but error="${challenge.error ?? "(none)"}" (only insufficient_scope is accepted)`,
      };
    }
    return {
      ok: true,
      kind: "oauth_challenge",
      evidence:
        res.status === 403
          ? "HTTP 403 with error=insufficient_scope and a Bearer WWW-Authenticate challenge"
          : "HTTP 401 with a Bearer WWW-Authenticate challenge",
    };
  }

  // Any other non-200 status is rejected: no initialize response, no
  // usable OAuth challenge (202/other streaming statuses included — fail
  // closed).
  if (res.status !== 200) {
    return {
      ok: false,
      rejected: true,
      evidence: `HTTP ${res.status} (no initialize response, no OAuth Bearer challenge)`,
    };
  }

  // HTTP 200: JSON responses and Streamable HTTP SSE responses both feed the
  // same initialize-result validator. Legacy GET-only SSE is not accepted:
  // this path only sends the POST initialize above.
  const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
  if (contentType.includes("text/html")) {
    return { ok: false, rejected: true, evidence: "HTTP 200 with HTML content (landing page, not an MCP endpoint)" };
  }
  const body = await readBoundedResponseText(res);
  if (!body.ok) return { ok: false, rejected: true, evidence: body.evidence };

  if (contentType.includes("text/event-stream")) {
    return parseSseInitialize(body.text);
  }

  let doc: unknown;
  try {
    doc = JSON.parse(body.text);
  } catch {
    return { ok: false, rejected: true, evidence: "HTTP 200 with non-JSON content (HTML landing page)" };
  }
  return validateInitializeDocument(doc, "HTTP 200", false);
}

const MCP_PROBE_MAX_RESPONSE_BYTES = 256 * 1024;

type BoundedBody =
  | { ok: true; text: string }
  | { ok: false; evidence: string };

async function readBoundedResponseText(res: Response): Promise<BoundedBody> {
  const contentLength = Number(res.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MCP_PROBE_MAX_RESPONSE_BYTES) {
    return {
      ok: false,
      evidence: `HTTP 200 response body exceeds ${MCP_PROBE_MAX_RESPONSE_BYTES}-byte cap`,
    };
  }

  if (res.body === null) return { ok: true, text: "" };
  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MCP_PROBE_MAX_RESPONSE_BYTES) {
        await reader.cancel();
        return {
          ok: false,
          evidence: `HTTP 200 response body exceeds ${MCP_PROBE_MAX_RESPONSE_BYTES}-byte cap`,
        };
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    return { ok: true, text };
  } catch (err) {
    return { ok: false, evidence: `HTTP 200 but the response body could not be read: ${errorMessage(err)}` };
  }
}

interface SseEvent {
  event?: string;
  data: string[];
  hasData: boolean;
}

function parseSseEvents(text: string): SseEvent[] {
  const events: SseEvent[] = [];
  let current: SseEvent = { data: [], hasData: false };
  const flush = () => {
    if (current.event !== undefined || current.hasData) events.push(current);
    current = { data: [], hasData: false };
  };
  for (const line of text.split(/\r\n|\n|\r/)) {
    if (line === "") {
      flush();
      continue;
    }
    if (line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") current.event = value;
    if (field === "data") {
      current.hasData = true;
      current.data.push(value);
    }
  }
  flush();
  return events;
}

function parseSseInitialize(text: string): ProbeVerdict {
  const events = parseSseEvents(text);
  if (events.length === 0) {
    return { ok: false, rejected: true, evidence: "HTTP 200 SSE stream has no message data" };
  }
  let initializeResult: string | undefined;
  for (const event of events) {
    if (event.event !== undefined && event.event !== "message") {
      return { ok: false, rejected: true, evidence: `HTTP 200 SSE stream contains a non-message event "${event.event}"` };
    }
    if (!event.hasData) {
      return { ok: false, rejected: true, evidence: "HTTP 200 SSE message is missing data" };
    }
    let doc: unknown;
    try {
      doc = JSON.parse(event.data.join("\n"));
    } catch {
      return { ok: false, rejected: true, evidence: "HTTP 200 SSE message has malformed JSON data" };
    }
    const verdict = validateInitializeDocument(doc, "HTTP 200 SSE message", true);
    if (!verdict.ok) return verdict;
    const result = JSON.stringify((doc as Record<string, unknown>)["result"]);
    if (initializeResult !== undefined && initializeResult !== result) {
      return { ok: false, rejected: true, evidence: "HTTP 200 SSE stream contains conflicting multiple initialize messages" };
    }
    initializeResult = result;
  }
  return { ok: true, kind: "mcp", evidence: "HTTP 200 SSE with a valid MCP initialize result" };
}

function validateInitializeDocument(doc: unknown, evidencePrefix: string, requireRequestId: boolean): ProbeVerdict {
  // SAFETY: JSON.parse output is JSON-shaped by construction; the guard
  // below is the authority on the record shape (fail closed otherwise).
  const docValue = doc as JsonValue;
  if (!isRecord(docValue)) {
    return { ok: false, rejected: true, evidence: `${evidencePrefix} with a JSON body that is not a JSON-RPC response` };
  }
  if (requireRequestId && (docValue["jsonrpc"] !== "2.0" || docValue["id"] !== 1)) {
    return { ok: false, rejected: true, evidence: `${evidencePrefix} has a JSON-RPC message with the wrong id (expected 1)` };
  }
  if (docValue["error"] !== undefined) {
    return { ok: false, rejected: true, evidence: `${evidencePrefix} with a JSON-RPC error response (no initialize result)` };
  }
  const result = docValue["result"];
  if (result === undefined) {
    return { ok: false, rejected: true, evidence: `${evidencePrefix} with a JSON body that has no initialize result` };
  }
  const parsed = InitializeResultSchema.safeParse(result);
  if (!parsed.success) {
    return { ok: false, rejected: true, evidence: `${evidencePrefix} but the initialize result is invalid (not an MCP server)` };
  }
  if (!SUPPORTED_PROTOCOL_VERSIONS.includes(parsed.data.protocolVersion)) {
    return {
      ok: false,
      rejected: true,
      evidence: `${evidencePrefix} but the server's protocol version ${parsed.data.protocolVersion} is not supported`,
    };
  }
  return { ok: true, kind: "mcp", evidence: `${evidencePrefix} with a valid MCP initialize result` };
}

/** The parsed Bearer challenge, or the rejection reason. */
type ChallengeParse =
  | { ok: true; error?: string }
  | { ok: false; reason: string };

/**
 * Parses the WWW-Authenticate header as a SINGLE valid Bearer challenge
 * (RFC 7235 + RFC 6750), using the SDK's extractWWWAuthenticateParams as
 * the field authority. Fail closed: missing headers, non-Bearer schemes,
 * duplicate challenges, and challenges the SDK cannot parse (no
 * resource_metadata/scope/error) are all rejected — an ambiguous header is
 * never guessed as an OAuth gate.
 */
function parseBearerChallenge(res: Response): ChallengeParse {
  const header = res.headers.get("WWW-Authenticate");
  if (header === null || header.trim() === "") {
    return { ok: false, reason: "without a WWW-Authenticate Bearer challenge" };
  }
  // RFC 7235: a single challenge is `auth-scheme 1*SP #auth-param` (the
  // auth-params are comma-separated WITHIN the challenge), while repeated
  // challenges are also comma-joined (and headers.get joins repeated
  // headers). A new challenge starts only after a comma at a scheme token
  // (letters/digits/dash followed by whitespace — auth-params are
  // `name=value` with no space), so a quoted comma inside an auth-param
  // value never splits a single challenge. Duplicate challenges are
  // rejected.
  const challenges: string[] = [];
  let current = "";
  for (const part of header.split(",")) {
    const trimmed = part.trim();
    if (trimmed.length === 0) continue;
    if (current === "" || /^[A-Za-z][A-Za-z0-9-]*\s/.test(trimmed)) {
      if (current !== "") challenges.push(current);
      current = trimmed;
    } else {
      current += `,${trimmed}`;
    }
  }
  if (current !== "") challenges.push(current);
  if (challenges.length > 1) {
    return { ok: false, reason: "with duplicate WWW-Authenticate challenges" };
  }
  if (!/^bearer\b/i.test(challenges[0]!)) {
    return { ok: false, reason: "with a non-Bearer WWW-Authenticate challenge" };
  }
  // The SDK's extractWWWAuthenticateParams is the challenge authority: it
  // returns {} when the header is absent, non-Bearer, or carries no
  // scheme token. A parse that yields no usable params (no
  // resource_metadata / scope / error) is not a standards-compliant
  // challenge (RFC 6750 requires error on a 401/403 challenge) — rejected.
  const params = extractWWWAuthenticateParams(res);
  if (params.resourceMetadataUrl === undefined && params.scope === undefined && params.error === undefined) {
    return { ok: false, reason: "with a malformed Bearer WWW-Authenticate challenge" };
  }
  return { ok: true, error: params.error };
}
