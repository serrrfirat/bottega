/**
 * OpenAPI tool generator (issue #345): turns a vendor's OpenAPI 3.x spec
 * into a pinned tool surface for API-first vendors that never ship MCP.
 *
 * This module is PURE (no I/O except fetchOpenApiSpec): fetch + validate the
 * spec (≤2MB, OpenAPI 3.x, HTTPS-only servers), then generate an
 * {@link ExtensionTool} surface with deterministic names, conservative
 * read/write tiers, and JSON-Schema-derived params. Every cap fails CLOSED:
 * a spec that exceeds a bound is rejected outright, never partially
 * registered.
 *
 * The generated surface is what a pin freezes into the snapshot (Layer 2);
 * the runtime executor (Layer 3) rebuilds requests from the same
 * parameters+requestBody the generator read, so nothing is re-fetched at
 * runtime and the reviewed surface is authoritative.
 */
import { z } from "zod";
import {
  RESERVED_TOOL_NAMES,
  isRecord,
  type ExtensionTool,
  type ExtensionToolParam,
  type ExtensionToolTier,
  type JsonObject,
  type JsonValue,
} from "./manifest";

/** Cap on the raw spec document size (issue #345). */
export const OPENAPI_MAX_SPEC_BYTES = 2 * 1024 * 1024;

/** Cap on the number of operations generated per spec (issue #345). */
export const OPENAPI_MAX_OPERATIONS = 200;

/** Cap on a single response body the executor will surface (issue #345). */
export const OPENAPI_RESPONSE_BOUND_BYTES = 256 * 1024;

/** The request-body param name when a spec declares a JSON body. */
export const OPENAPI_BODY_PARAM = "body";

/** The `servers[]` field name we validate (exact HTTPS only). */
const SERVERS_FIELD = "servers";

/** Fail-closed error for any OpenAPI validation/generation problem. */
export class OpenApiSpecError extends Error {
  constructor(message: string) {
    super(`openapi spec invalid: ${message}`);
    this.name = "OpenApiSpecError";
  }
}

function fail(message: string): never {
  throw new OpenApiSpecError(message);
}

/** Identifier charset shared with the manifest tool surface (issue #345). */
const IDENTIFIER_RE = /^[a-z0-9][a-z0-9._-]*$/;

/** One generated operation, as surfaced to the review step. */
export interface OpenApiOperation {
  /** The generated model-facing tool name (`<extension>_<operationId>`). */
  name: string;
  /** The wire operation's id (or the method+path slug fallback). */
  operationId: string;
  tier: ExtensionToolTier;
  method: string;
  path: string;
}

/** Result of {@link generateOpenApiTools}. */
export interface OpenApiToolGeneration {
  tools: ExtensionTool[];
  /** The review-step rendering (operations + tiers). */
  operations: OpenApiOperation[];
  /** Validated HTTPS-only origin hosts for the egress allowlist. */
  hosts: string[];
}

/**
 * Options controlling generation. `reservedNames` lets the caller inject
 * the already-registered tool surface so a collision with a live extension
 * fails closed here rather than at the later registry step; it defaults to
 * just the runtime's reserved names.
 */
export interface OpenApiGenerateOptions {
  /** Extra tool names that must not be shadowed (registered extensions). */
  reservedNames?: ReadonlySet<string>;
}

/**
 * Fetches an OpenAPI spec document with the issue's caps. Fails closed:
 * the URL MUST be HTTPS, the response MUST be ≤2MB, and the JSON MUST
 * declare OpenAPI 3.x.
 */
export async function fetchOpenApiSpec(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<JsonObject> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    fail(`spec URL "${url}" is not a valid URL`);
  }
  if (parsed.protocol !== "https:") {
    fail(`spec URL must be HTTPS, got "${parsed.protocol}"`);
  }
  let body: string;
  try {
    const response = await fetchImpl(url);
    if (!response.ok) {
      throw new OpenApiSpecError(`GET ${url} -> HTTP ${response.status}`);
    }
    const contentLength = response.headers.get("content-length");
    if (contentLength !== null) {
      const explicitBytes = Number(contentLength);
      if (Number.isFinite(explicitBytes) && explicitBytes > OPENAPI_MAX_SPEC_BYTES) {
        throw new OpenApiSpecError(
          `spec document exceeds the ${OPENAPI_MAX_SPEC_BYTES}-byte cap (content-length ${explicitBytes})`,
        );
      }
    }
    body = await response.text();
  } catch (err) {
    if (err instanceof OpenApiSpecError) throw err;
    throw new OpenApiSpecError(`GET ${url} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const bytes = new TextEncoder().encode(body).byteLength;
  if (bytes > OPENAPI_MAX_SPEC_BYTES) {
    fail(`spec document exceeds the ${OPENAPI_MAX_SPEC_BYTES}-byte cap (${bytes} bytes)`);
  }
  let docJson: JsonValue;
  try {
    // SAFETY: JSON.parse returns any runtime value; the JSON document's
    // root must be a record (object) or the spec is malformed — validate
    // via the canonical isRecord guard immediately below, never trust the
    // raw parse result as a record.
    docJson = JSON.parse(body) as JsonValue;
  } catch (err) {
    fail(`spec document is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isRecord(docJson)) {
    fail("spec document must be a JSON object");
  }
  // SAFETY: isRecord(docJson) narrows docJson to JsonObject above; the
  // reassignment lets the rest of the loader read fields from a record.
  const parsedDoc: JsonObject = docJson;
  const openapiVersion = z.string().safeParse(parsedDoc["openapi"]);
  if (!openapiVersion.success || !openapiVersion.data.startsWith("3.")) {
    fail(
      `spec must be OpenAPI 3.x, got "${
        parsedDoc["openapi"] === undefined ? "<missing>" : String(parsedDoc["openapi"])
      }"`,
    );
  }
  return parsedDoc;
}

/** The `host` origin (no scheme) of an HTTPS server URL, or null when invalid. */
function httpsHost(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  // Exact HTTPS only (issue #345: no redirect expansion, no relative
  // servers) — reject any server that isn't a clean https://host[:port].
  if (parsed.username !== "" || parsed.password !== "") return null;
  return parsed.host;
}

/**
 * Validates the spec's `servers[]` and returns every origin host. Fail
 * closed: an HTTPS server list is REQUIRED (a spec with no servers, or any
 * non-HTTPS/relative server, is rejected) and every host is exact-HTTP
 * validated with no redirect expansion.
 */
export function openApiHosts(spec: JsonObject): string[] {
  const servers = spec[SERVERS_FIELD];
  if (servers === undefined) {
    fail("spec must declare a `servers` array of HTTPS origins");
  }
  if (!Array.isArray(servers)) {
    fail("`servers` must be an array");
  }
  if (servers.length === 0) {
    fail("`servers` must declare at least one HTTPS origin");
  }
  const hosts: string[] = [];
  const seen = new Set<string>();
  for (const server of servers) {
    if (!isRecord(server)) {
      fail("each `servers` entry must be an object with a `url`");
    }
    const rawUrl = z.string().min(1).safeParse(server["url"]);
    if (!rawUrl.success || rawUrl.data.trim() === "") {
      fail("each `servers` entry must declare a non-empty `url`");
    }
    const url = rawUrl.data;
    const host = httpsHost(url);
    if (host === null) {
      fail(`server origin "${url}" must be an exact HTTPS URL (no redirects/relative) — rejected`);
    }
    if (!seen.has(host)) {
      seen.add(host);
      hosts.push(host);
    }
  }
  return hosts;
}

/**
 * Slug fallback for a missing operationId: `<method>_<path>` with path
 * segments joined by underscore and `{param}` placeholders reduced to the
 * bare name. Always yields a lowercase identifier; callers still run it
 * through the identifier registry so collisions fail closed.
 */
function slugFromMethodPath(method: string, path: string): string {
  const segments = path
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => segment.replaceAll("{", "").replaceAll("}", ""));
  const raw = [method.toLowerCase(), ...segments].join("_");
  // Collapse runs of disallowed chars to a single underscore; keep a
  // leading [a-z0-9] guarantee for the first char.
  const cleaned = raw.replace(/[^a-z0-9._-]+/g, "_").replace(/^[^a-z0-9]+/, "");
  return cleaned === "" ? "operation" : cleaned;
}

/**
 * Normalizes a raw operationId into a valid identifier. Vendor operationIds
 * may contain spaces, colons, dots, or non-ASCII — collapse anything that
 * the manifest identifier charset rejects. Returns null when nothing
 * meaningful survives (caller falls back to the method+path slug).
 */
function normalizeOperationId(operationId: string): string | null {
  const cleaned = operationId
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/^[^a-zA-Z0-9]+/, "")
    .toLowerCase();
  return cleaned === "" ? null : cleaned;
}

/**
 * Maps one OpenAPI parameter's JSON Schema to a manifest param. Path and
 * query params are scalars (string/number/boolean); a structured schema
 * (array/object) travels as a JSON-serialized string with `jsonType`,
 * mirroring the MCP bridge (issue #248).
 */
function paramFromOpenApiSchema(raw: JsonValue, name: string, required: boolean): ExtensionToolParam {
  const schema = isRecord(raw) ? raw : {};
  const schemaType = schema["type"];
  const type: ExtensionToolParam["type"] =
    schemaType === "string"
      ? "string"
      : schemaType === "number" || schemaType === "integer"
        ? "number"
        : schemaType === "boolean"
          ? "boolean"
          : "string";
  const jsonType: ExtensionToolParam["jsonType"] =
    schemaType === "array" ? "array" : schemaType === "object" ? "object" : undefined;
  const param: ExtensionToolParam = { name, type };
  if (jsonType !== undefined) param.jsonType = jsonType;
  const description = schema["description"];
  const parsedDescription = z.string().min(1).safeParse(description);
  if (parsedDescription.success && parsedDescription.data.trim() !== "") {
    param.description = parsedDescription.data.trim();
  }
  if (!required) param.required = false;
  return param;
}

/**
 * Derives the params for ONE operation from its `parameters[]` (path +
 * query) and optional `requestBody`. Path params are required; query params
 * honor the parameter's `required` flag. A JSON request body becomes a
 * single `body` param (jsonType array/object as declared, else scalar) — the
 * agent supplies a JSON literal string and the executor re-parses it (the
 * issue #248 surface contract).
 *
 * Unnamed/`{param}`-unresolvable parameters are skipped; a body that is
 * present but not a JSON media type is skipped (non-JSON bodies are out of
 * V1 scope — they are not representable as a structured param).
 */
export function paramsFromOpenApiOperation(operation: JsonObject): ExtensionToolParam[] {
  const params: ExtensionToolParam[] = [];
  const seen = new Set<string>();
  const rawParameters = operation["parameters"];
  if (Array.isArray(rawParameters)) {
    for (const raw of rawParameters) {
      if (!isRecord(raw)) continue;
      const name = z.string().min(1).safeParse(raw["name"]);
      if (!name.success || name.data.trim() === "") continue;
      const location = raw["in"];
      if (location !== "path" && location !== "query") continue;
      if (seen.has(name.data)) continue;
      seen.add(name.data);
      params.push(paramFromOpenApiSchema(raw["schema"], name.data.trim(), raw["required"] === true));
    }
  }
  const requestBody = operation["requestBody"];
  if (isRecord(requestBody)) {
    const content = requestBody["content"];
    if (isRecord(content)) {
      const jsonEntry = content["application/json"] ?? content["application/*+json"];
      if (isRecord(jsonEntry) && !seen.has(OPENAPI_BODY_PARAM)) {
        seen.add(OPENAPI_BODY_PARAM);
        const bodySchema = jsonEntry["schema"];
        const required = requestBody["required"] === true;
        if (isRecord(bodySchema)) {
          params.push(paramFromOpenApiSchema(bodySchema, OPENAPI_BODY_PARAM, required));
        } else {
          // A JSON body with no usable structure → an opaque object.
          const opaque: ExtensionToolParam = {
            name: OPENAPI_BODY_PARAM,
            type: "string",
            jsonType: "object",
          };
          if (!required) opaque.required = false;
          params.push(opaque);
        }
      }
    }
  }
  return params;
}

/**
 * Generates the tool surface from a validated OpenAPI spec. Fail closed on
 * every cap: a spec must declare OpenAPI 3.x, HTTPS servers, ≤200
 * non-deprecated operations, and every generated name must be unique and
 * not collide with a reserved or already-registered tool name.
 */
export function generateOpenApiTools(
  spec: JsonObject,
  extensionId: string,
  opts: OpenApiGenerateOptions = {},
): OpenApiToolGeneration {
  if (!extensionId) fail("extension id is required");
  if (!IDENTIFIER_RE.test(extensionId)) {
    fail(`extension id "${extensionId}" must match ${IDENTIFIER_RE.source}`);
  }
  const hosts = openApiHosts(spec);

  // Reserved = the runtime's reserved names PLUS any caller-provided
  // already-registered surface (issue #345: collision → pin fails closed).
  const reserved = new Set<string>([...RESERVED_TOOL_NAMES, ...(opts.reservedNames ?? [])]);
  const seenNames = new Set<string>();

  const paths = spec["paths"];
  if (!isRecord(paths)) {
    fail("spec must declare a `paths` object of operations");
  }

  const tools: ExtensionTool[] = [];
  const operations: OpenApiOperation[] = [];

  for (const [path, pathItem] of Object.entries(paths)) {
    if (!isRecord(pathItem)) continue;
    for (const method of ["get", "put", "post", "delete", "patch", "options", "head", "trace"] as const) {
      const operation = pathItem[method];
      if (!isRecord(operation)) continue;
      if (operation["deprecated"] === true) continue; // deprecated skipped (issue #345)
      if (operations.length >= OPENAPI_MAX_OPERATIONS) {
        fail(`spec exceeds the ${OPENAPI_MAX_OPERATIONS}-operation cap`);
      }
      const rawOperationId = z.string().safeParse(operation["operationId"]);
      const normalizedId = rawOperationId.success
        ? normalizeOperationId(rawOperationId.data) ?? slugFromMethodPath(method, path)
        : slugFromMethodPath(method, path);
      const toolName = `${extensionId}_${normalizedId}`;
      if (seenNames.has(toolName)) {
        fail(`generated tool name "${toolName}" collides within the spec`);
      }
      if (reserved.has(toolName)) {
        fail(`generated tool name "${toolName}" collides with a reserved/runtime tool name`);
      }
      seenNames.add(toolName);
      const tier: ExtensionToolTier = method === "get" ? "read" : "write";
      const summary = z.string().safeParse(operation["summary"]);
      const description =
        summary.success && summary.data.trim() !== ""
          ? summary.data.trim()
          : `${method.toUpperCase()} ${path}`;
      const params = paramsFromOpenApiOperation(operation);
      tools.push({
        name: toolName,
        tier,
        description,
        params,
      });
      operations.push({ name: toolName, operationId: normalizedId, tier, method, path });
    }
  }

  return { tools, operations, hosts };
}