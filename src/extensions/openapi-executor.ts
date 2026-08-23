/**
 * OpenAPI executor (issue #345): the server-process runtime for a pinned
 * openapi-kind extension. It rebuilds the wire request from the FROZEN tool
 * surface (method + path template + param locations), routes it to the
 * egress layer, and returns a bounded response.
 *
 * Core property: the executor NEVER touches the credential. It sends no
 * auth header; the egress layer (iron-proxy's static `inject` transform,
 * model-gateway secrets #208) injects the provisioned header for the
 * allowlisted host at egress. `callOpenApiTool` accepts an egress seam so a
 * hermetic test can assert the proxy-transform contract end-to-end (the
 * fake proxy applies the inject rule, the fake upstream sees the header).
 */
import { z } from "zod";
import { OPENAPI_RESPONSE_BOUND_BYTES } from "./openapi-tools";
import type { ExtensionManifest, ExtensionTool, ExtensionToolParam } from "./manifest";
import type { JsonObject } from "./manifest";

/** Re-exported response cap for callers that must honor the bounded contract. */
export { OPENAPI_RESPONSE_BOUND_BYTES };

/** Result shape shared with the runtime's provider-call seam (discriminated like ExtensionRuntimeResult). */
export type OpenApiToolResult =
  | { ok: true; content: Array<{ type: "text"; text: string }> }
  | { ok: false; error: string };

/** The auth the egress layer injects for one host (proxy-side config, not the executor's secret). */
export interface OpenApiEgressInject {
  /** The header name (e.g. `Authorization` or `X-Api-Key`). */
  header: string;
  /** The Go-template formatter iron-proxy applies (`Bearer {{ .Value }}` or `{{ .Value }}`). */
  formatter: string;
}

/** A built wire request (credential-free). */
export interface OpenApiWireRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
}

/** Egress seam: turns a built request into a response, applying the inject. */
export interface OpenApiEgressSeam {
  /**
   * The inject rule for a host, or undefined when the host has no credential
   * provisioned (fail-closed callers must then refuse to send). Provides the
   * host+header contract to the seam WITHOUT exposing the secret to the
   * executor.
   */
  injectForHost(host: string): OpenApiEgressInject | undefined;
  /** Routes a credential-free request to the wire and returns the raw response. */
  fetchWire(request: OpenApiWireRequest): Promise<{ status: number; body: string }>;
}

/** Caller-supplied deps (test hermetic: a fake egress seam + upstream). */
export interface OpenApiExecutorDeps {
  egress: OpenApiEgressSeam;
}

/**
 * Builds a credential-free wire request from a pinned openapi tool and the
 * agent-supplied args. Path params substitute into the template; query
 * params append to the URL; a single `body` param becomes the JSON request
 * body. Any arg that doesn't map to a declared param is refused (fail
 * closed — never forward an unknown/credential-shaped field). The request
 * carries NO auth header: the egress layer injects it.
 */
export function buildOpenApiRequest(
  tool: ExtensionTool,
  args: JsonObject,
  baseUrl: string,
): OpenApiWireRequest {
  const metadata = tool.openapi;
  if (metadata === undefined) {
    throw new Error(`openapi tool "${tool.name}" has no operation metadata — refuse to build a request`);
  }
  const params = tool.params;
  const byName = new Map<string, ExtensionToolParam>(params.map((param) => [param.name, param]));
  for (const key of Object.keys(args)) {
    if (!byName.has(key)) {
      throw new Error(`openapi tool "${tool.name}": unexpected argument "${key}" — forward none`);
    }
  }
  let path = metadata.path;
  const query = new URLSearchParams();
  let body: string | undefined;
  for (const param of params) {
    const raw = args[param.name];
    if (raw === undefined) {
      if (param.required !== false) {
        throw new Error(`openapi tool "${tool.name}" is missing required parameter "${param.name}"`);
      }
      continue;
    }
    const location = param.location;
    if (location === "path") {
      path = path.replace(`{${param.name}}`, encodeURIComponent(String(raw)));
    } else if (location === "query") {
      query.append(param.name, String(raw));
    } else if (location === "body") {
      const parsedRaw = z.string().safeParse(raw);
      if (parsedRaw.success && (param.jsonType === "object" || param.jsonType === "array")) {
        body = parsedRaw.data; // the agent supplies a JSON literal string (issue #248 surface)
      } else if (raw === null) {
        body = "null";
      } else {
        body = JSON.stringify(raw);
      }
    }
  }
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/$/, "")}${path}`.replace(/\/{2,}/g, "/");
  const queryString = query.toString();
  if (queryString !== "") {
    url.search = queryString;
  }
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  return { method: metadata.method.toUpperCase(), url: url.toString(), headers, ...(body !== undefined ? { body } : undefined) };
}

/** Bounds a response body to the 256KB cap (issue #345). */
export function boundResponseText(body: string): string {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(body).byteLength;
  if (bytes <= OPENAPI_RESPONSE_BOUND_BYTES) return body;
  let cutoff = 0;
  let seen = 0;
  while (cutoff < body.length && seen < OPENAPI_RESPONSE_BOUND_BYTES) {
    seen += encoder.encode(body[cutoff]!).byteLength;
    cutoff += 1;
  }
  return `${body.slice(0, cutoff)}\n… [response truncated at ${OPENAPI_RESPONSE_BOUND_BYTES} bytes]`;
}

/**
 * Executes a pinned openapi tool: builds the request, routes it through the
 * egress seam (which injects the credential-free auth for the host), parses
 * the bounded response (JSON → text snippet; non-JSON → raw snippet), and
 * maps upstream 4xx/5xx to a tool error naming the status. The response is
 * bounded to {@link OPENAPI_RESPONSE_BOUND_BYTES} and non-JSON bodies come
 * back as a text snippet (never a wall of bytes).
 */
export async function callOpenApiTool(
  manifest: ExtensionManifest,
  tool: ExtensionTool,
  args: JsonObject,
  deps: OpenApiExecutorDeps,
): Promise<OpenApiToolResult> {
  if (manifest.kind !== "openapi") {
    return { ok: false, error: `extension "${manifest.id}" is not an openapi extension` };
  }
  // The pinned spec's origin host. The manifest's egress domains are the
  // allowlist; the inject rule keys on the FIRST origin (V1: single-origin
  // specs are the norm; multi-origin specs still execute against the spec's
  // servers — the executor uses the manifest's first domain host).
  const host = manifest.domains[0];
  if (host === undefined) {
    return { ok: false, error: `openapi extension "${manifest.id}" pins no egress host — refuse to send` };
  }
  const inject = deps.egress.injectForHost(host);
  if (inject === undefined) {
    // No credential provisioned for this host → fail closed (never send
    // unauthenticated to a credential-gated vendor).
    return { ok: false, error: `openapi extension "${manifest.id}" has no provisioned credential for "${host}"` };
  }
  const baseUrl = `https://${host}`;
  let request: OpenApiWireRequest;
  try {
    request = buildOpenApiRequest(tool, args, baseUrl);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  let response: { status: number; body: string };
  try {
    response = await deps.egress.fetchWire(request);
  } catch (err) {
    return { ok: false, error: `openapi tool "${tool.name}" egress failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (response.status >= 400) {
    return {
      ok: false,
      error: `openapi tool "${tool.name}" upstream returned HTTP ${response.status}`,
    };
  }
  const text = boundResponseText(response.body);
  return { ok: true, content: [{ type: "text", text }] };
}