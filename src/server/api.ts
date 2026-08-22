/**
 * Token-authenticated REST API surface (issue #100): Bun-native route
 * handling mounted onto the server's single inbound HTTP surface (the
 * #198 OAuth callback's Bun.serve, alongside the #57 webhook route and the
 * #196 upload form — see src/extensions/oauth-callback.ts). A deployment
 * exposes ONE public ingress (reverse proxy + TLS) for every inbound path;
 * the REST API joins it with the `/api/v1` prefix and `GET /openapi.json`.
 *
 * Auth: every call requires `Authorization: Bearer <BOTTEGA_API_TOKEN>`.
 * The token is resolved through the EXISTING boot-secret chain (issue
 * #201): the `bottega-api-token` vault row seeds `BOTTEGA_API_TOKEN` in
 * process.env at boot (vault → env → Keychain → unset), and this surface
 * reads it live per request — so rotation via re-seed takes effect without
 * a restart. A missing or non-matching token is a fail-closed 401, and the
 * denial is itself audited (actor `api:default`). Comparison is
 * constant-time (sha256 + timingSafeEqual) so a valid token is never
 * distinguishable from a guess by timing.
 *
 * Every handled call is audited with actor `api:default` — the reads, the
 * write, and the auth denials. Unknown paths are a bare 404 (fail closed,
 * no information leaked, never audited — the same posture as the webhook
 * and callback surfaces).
 *
 * The route-spec table {@link REST_ROUTES} is the SINGLE source of truth
 * that drives both the runtime router (method + path matching) and the
 * generated OpenAPI 3.1 document served at `/openapi.json`.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { z, type ZodError } from "zod";
import type { JsonValue } from "../memory/mem0";
import type { AuditModule } from "../policy/audit";
import type { AuditPage, AuditQueryOpts, Space, Store, WorkItem, WorkItemState } from "../store/db";
import {
  API_AUDIT_READ_EVENT,
  API_AUTH_DENIED_EVENT,
  API_SPACES_LISTED_EVENT,
  API_WORK_ITEM_CREATED_EVENT,
  API_WORK_ITEMS_LISTED_EVENT,
} from "../store/audit-events";

/** The env var (seeded via the boot-secret chain) holding the bearer token. */
export const REST_API_TOKEN_ENV = "BOTTEGA_API_TOKEN";
/** The shared actor recorded on every audited REST API call. */
export const API_ACTOR = "api:default";
/** The OpenAPI document path (also a route, bearer-authenticated like the rest). */
export const OPENAPI_PATH = "/openapi.json";
/** The fixed prefix of the API's business routes. */
export const API_PATH_PREFIX = "/api/v1";
/** Every value `status` accepts on GET /api/v1/work-items (issue #100). */
const WORK_ITEM_STATES: readonly WorkItemState[] = [
  "open",
  "claimed",
  "working",
  "review",
  "done",
  "blocked",
  "aborted",
] as const;

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" } as const;

const WORK_ITEM_STATE_SCHEMA = { type: "string", enum: WORK_ITEM_STATES } as const;
/** Static membership table for the valid `status` values (issue #100). */
const WORK_ITEM_STATE_LOOKUP: Record<string, true> = Object.fromEntries(WORK_ITEM_STATES.map((s) => [s, true]));
/** The create-work-item write input (contract mirrors {@link createWorkItemSchema}). */
interface CreateWorkItemInput {
  space_id: string;
  requester: string;
  description: string;
  repo?: string;
}

/** The POST body contract: `space` + `title` required, `body`/`repo` optional. */
const createWorkItemSchema = z.object({
  space: z.string().trim().min(1, "space must be non-empty"),
  title: z.string().trim().min(1, "title must be non-empty"),
  body: z.string().trim().optional(),
  repo: z.string().trim().min(1, "repo must be non-empty").optional(),
});

/**
 * Maps a zod validation failure for the POST body to the REST surface's
 * documented error message. The failing field decides which message; an
 * unresolved shape (e.g. a non-object body) falls back to the object
 * contract message.
 */
function createWorkItemIssueMessage(error: ZodError): string {
  const field = error.issues[0]?.path[0];
  if (field === "title") return "title must be a non-empty string";
  if (field === "space") return "space must be a non-empty string";
  if (field === "repo") return "repo must be a non-empty string when provided";
  return "request body must be a JSON object";
}

/** Constant-time string comparison; both inputs are hashed to fixed length first. */
function constantTimeEqual(a: string, b: string): boolean {
  const left = createHash("sha256").update(a).digest();
  const right = createHash("sha256").update(b).digest();
  return timingSafeEqual(left, right);
}

/** Extracts a bearer token from the Authorization header, if well-formed. */
function bearerToken(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (header === null) return null;
  const match = /^Bearer\s+([^\s]+)$/i.exec(header);
  return match !== null ? match[1] : null;
}

/** The deps the REST surface needs (the full {@link Store} satisfies `store`). */
export interface RestApiDeps {
  store: Store;
  audit: AuditModule;
  /**
   * Resolves the expected bearer token. Defaults to the boot-secret-seeded
   * env var (read live per request, so rotation via re-seed applies without
   * a restart). Tests inject a resolver for hermeticity.
   */
  resolveToken?: () => string | undefined;
}

export interface RestApiMount {
  /** Handles a request destined for this surface (path under /api/v1 or /openapi.json). */
  fetch(req: Request): Promise<Response>;
}

/** One documented query parameter (drives the OpenAPI spec). */
export interface RestParamSpec {
  name: string;
  description: string;
  schema: { type: "string" | "integer"; enum?: readonly string[] };
  required?: boolean;
}

/** One documented response shape (drives the OpenAPI spec). */
export interface RestResponseSpec {
  description: string;
  schema?: object;
}

/**
 * One route's entry in the shared spec table. The method + path drive the
 * runtime router; every other field drives the OpenAPI generation and the
 * handler runs the call (auditing it) after auth succeeds.
 */
interface RestRouteSpec {
  method: "GET" | "POST";
  path: string;
  summary: string;
  description: string;
  queryParams?: readonly RestParamSpec[];
  /** JSON body schema for POST routes (drives OpenAPI + fail-closed parse). */
  requestBody?: object;
  responses: Record<string, RestResponseSpec>;
  handle(req: Request, url: URL, deps: RestApiDeps): Promise<Response>;
}

/** The shared, compact space shape served by the API. */
interface SpaceView {
  id: string;
  platform: Space["platform"];
  channel_id: string;
  name: string | null;
  created_at: number;
  updated_at: number;
}

/** The shared, compact work-item shape served by the API. */
interface WorkItemView {
  id: string;
  space_id: string;
  requester: string;
  assignee: string | null;
  description: string;
  repo: string | null;
  delivery: WorkItem["delivery"];
  state: WorkItemState;
  created_at: number;
  updated_at: number;
}

/** The shared, compact space shape served by the API. */
function spaceView(space: Space): SpaceView {
  return {
    id: space.id,
    platform: space.platform,
    channel_id: space.channel_id,
    name: space.name,
    created_at: space.created_at,
    updated_at: space.updated_at,
  };
}

/** The shared, compact work-item shape served by the API. */
function workItemView(item: WorkItem): WorkItemView {
  return {
    id: item.id,
    space_id: item.space_id,
    requester: item.requester,
    assignee: item.assignee,
    description: item.description,
    repo: item.repo,
    delivery: item.delivery,
    state: item.state,
    created_at: item.created_at,
    updated_at: item.updated_at,
  };
}

/** Parses a non-negative integer query param; null when absent, throws on malformed. */
function intParam(url: URL, name: string): number | null {
  const raw = url.searchParams.get(name);
  if (raw === null) return null;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a non-negative integer`);
  return Number(raw);
}

/**
 * The SINGLE route-spec table: drives the router (method + path) and the
 * OpenAPI 3.1 document (everything else) via {@link buildOpenApiJson}.
 */
export const REST_ROUTES: readonly RestRouteSpec[] = [
  {
    method: "GET",
    path: "/api/v1/spaces",
    summary: "List spaces",
    description: "Returns every known space row (the full store), creation-ordered.",
    responses: {
      "200": {
        description: "The space rows.",
        schema: {
          type: "object",
          properties: {
            count: { type: "integer" },
            spaces: { type: "array", items: { type: "object" } },
          },
        },
      },
    },
    async handle(_req, _url, deps) {
      const spaces = await deps.store.listSpaces();
      await deps.audit.appendAudit({
        space_id: null,
        actor: API_ACTOR,
        event_type: API_SPACES_LISTED_EVENT,
        payload: { count: spaces.length },
      });
      return Response.json({ count: spaces.length, spaces: spaces.map(spaceView) });
    },
  },
  {
    method: "GET",
    path: "/api/v1/work-items",
    summary: "List work items",
    description:
      "Lists work items, newest first, optionally narrowed by space id (`space`) and/or state (`status`).",
    queryParams: [
      { name: "space", description: 'Space id to narrow to (e.g. "slack:C1").', schema: { type: "string" }, required: false },
      { name: "status", description: "Narrow to one work-item state.", schema: WORK_ITEM_STATE_SCHEMA, required: false },
    ],
    responses: {
      "200": {
        description: "The matching work items.",
        schema: {
          type: "object",
          properties: {
            count: { type: "integer" },
            items: { type: "array", items: { type: "object" } },
          },
        },
      },
      "400": { description: "`status` is not a valid work-item state." },
    },
    async handle(_req, url, deps) {
      const space = url.searchParams.get("space")?.trim() || undefined;
      const status = url.searchParams.get("status")?.trim() || undefined;
      if (status !== undefined && !(status in WORK_ITEM_STATE_LOOKUP)) {
        return Response.json({ error: `status must be one of ${WORK_ITEM_STATES.join(", ")}` }, { status: 400 });
      }
      const items = await deps.store.listWorkItems(space ? { space_id: space } : {});
      const filtered = status !== undefined ? items.filter((item) => item.state === status) : items;
      const listEntries: Array<[string, JsonValue]> = [["count", filtered.length]];
      if (space !== undefined) listEntries.push(["space", space]);
      const listPayload: JsonValue = Object.fromEntries(listEntries);
      await deps.audit.appendAudit({
        space_id: space ?? null,
        actor: API_ACTOR,
        event_type: API_WORK_ITEMS_LISTED_EVENT,
        payload: listPayload,
      });
      return Response.json({ count: filtered.length, items: filtered.map(workItemView) });
    },
  },
  {
    method: "GET",
    path: "/api/v1/audit",
    summary: "Query the audit trail",
    description:
      "Indexed, newest-first audit search (the same read the admin surface uses): optional `event_type`, `space`, `since` (epoch ms), and `limit` (clamped 1..100). Never returns audit results inside the audit itself — the read is recorded with the filters only.",
    queryParams: [
      { name: "event_type", description: "Narrow to one event type.", schema: { type: "string" }, required: false },
      { name: "space", description: "Narrow to one space id.", schema: { type: "string" }, required: false },
      { name: "since", description: "Only rows at or after this epoch-ms timestamp.", schema: { type: "integer" }, required: false },
      { name: "limit", description: "Max rows (clamped 1..100).", schema: { type: "integer" }, required: false },
    ],
    responses: {
      "200": {
        description: "The matching audit rows, newest first.",
        schema: {
          type: "object",
          properties: {
            count: { type: "integer" },
            rows: { type: "array", items: { type: "object" } },
            next_cursor: { type: ["object", "null"] },
          },
        },
      },
      "400": { description: "`since` or `limit` is not a non-negative integer." },
    },
    async handle(_req, url, deps) {
      let since: number | null;
      let limit: number | null;
      try {
        since = intParam(url, "since");
        limit = intParam(url, "limit");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return Response.json({ error: message }, { status: 400 });
      }
      const space = url.searchParams.get("space")?.trim() || undefined;
      const eventType = url.searchParams.get("event_type")?.trim() || undefined;
      const query: AuditQueryOpts = { space_id: space, event_type: eventType };
      if (since !== null) query.since = since;
      if (limit !== null) query.limit = limit;
      const page: AuditPage = await deps.store.queryAudit(query);

      const readEntries: Array<[string, JsonValue]> = [];
      if (eventType !== undefined) readEntries.push(["event_type", eventType]);
      if (space !== undefined) readEntries.push(["space", space]);
      if (since !== null) readEntries.push(["since", since]);
      if (limit !== null) readEntries.push(["limit", limit]);
      const readPayload: JsonValue = Object.fromEntries(readEntries);

      await deps.audit.appendAudit({
        space_id: space ?? null,
        actor: API_ACTOR,
        event_type: API_AUDIT_READ_EVENT,
        payload: readPayload,
      });
      return Response.json({
        count: page.rows.length,
        rows: page.rows.map((row) => ({
          id: row.id,
          ts: row.ts,
          space_id: row.space_id,
          actor: row.actor,
          event_type: row.event_type,
          payload: row.payload,
        })),
        next_cursor: page.nextCursor,
      });
    },
  },
  {
    method: "POST",
    path: "/api/v1/work-items",
    summary: "Create a work item",
    description:
      "Creates an `open` work item in the given space with the SAME fail-closed validation as the `create_work_item` tool: `title` (→ description) and `space` are required and must be non-empty; `repo`, when provided, must be non-empty; the space must exist. On success the created item (and its audit row) are returned.",
    requestBody: {
      type: "object",
      required: ["space", "title"],
      properties: {
        space: { type: "string", description: "The space id the item belongs to." },
        title: { type: "string", description: "The item's title." },
        body: { type: "string", description: "Optional body appended to the description." },
        repo: { type: "string", description: "Optional repository (owner/repo)." },
      },
    },
    responses: {
      "201": {
        description: "The created work item.",
        schema: {
          type: "object",
          properties: { id: { type: "string" }, state: { type: "string" } },
        },
      },
      "400": { description: "Malformed JSON, missing/empty title or space, non-empty-repo violation, or unknown space." },
    },
    async handle(req, _url, deps) {
      let raw: unknown;
      try {
        raw = await req.json();
      } catch {
        return Response.json({ error: "request body must be valid JSON" }, { status: 400 });
      }
      const parsed = createWorkItemSchema.safeParse(raw);
      if (!parsed.success) {
        return Response.json({ error: createWorkItemIssueMessage(parsed.error) }, { status: 400 });
      }
      const { space, title, body, repo } = parsed.data;
      // Fail closed: the space row is the work item's FK parent — the API
      // never creates spaces, so an unknown space is a validation error.
      if ((await deps.store.getSpace(space)) === null) {
        return Response.json({ error: `unknown space: ${space}` }, { status: 400 });
      }
      const description = body ? `${title}\n\n${body}` : title;
      const input: CreateWorkItemInput = {
        space_id: space,
        requester: API_ACTOR,
        description,
      };
      if (repo !== undefined) input.repo = repo;
      const item = await deps.store.createWorkItem(input);
      await deps.audit.appendAudit({
        space_id: space,
        actor: API_ACTOR,
        event_type: API_WORK_ITEM_CREATED_EVENT,
        payload: { id: item.id, requester: API_ACTOR },
      });
      return Response.json({ id: item.id, state: item.state }, { status: 201 });
    },
  },
  {
    method: "GET",
    path: OPENAPI_PATH,
    summary: "OpenAPI document",
    description: "The OpenAPI 3.1 document describing every API route.",
    responses: {
      "200": { description: "The OpenAPI JSON document." },
    },
    async handle() {
      return new Response(buildOpenApiJson(), {
        status: 200,
        headers: { ...JSON_HEADERS, "cache-control": "no-store" },
      });
    },
  },
];

/** Audits a rejected (401) call — never throws (the denial verdict stands). */
async function recordAuthDenial(deps: RestApiDeps, req: Request): Promise<void> {
  try {
    await deps.audit.appendAudit({
      space_id: null,
      actor: API_ACTOR,
      event_type: API_AUTH_DENIED_EVENT,
      payload: { method: req.method, path: new URL(req.url).pathname },
    });
  } catch {
    // Best-effort: the 401 verdict is unchanged if the audit write fails.
  }
}

/**
 * Builds the REST surface: a route handler (a `fetch` mount) that authenticates
 * every known route, audits auth denials, and dispatches to the route's
 * handler. No listener of its own — the boot mounts it onto the OAuth
 * callback's shared inbound surface in src/server/index.ts.
 */
export function mountRestApi(deps: RestApiDeps): RestApiMount {
  const resolveToken = deps.resolveToken ?? (() => process.env[REST_API_TOKEN_ENV]);
  return {
    async fetch(req) {
      const url = new URL(req.url);
      const route = REST_ROUTES.find((r) => r.path === url.pathname && r.method === req.method);
      if (route === undefined) return new Response("not found", { status: 404 });
      const expected = resolveToken();
      const provided = bearerToken(req);
      if (expected === undefined || expected.trim() === "" || provided === null || !constantTimeEqual(expected, provided)) {
        await recordAuthDenial(deps, req);
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      return route.handle(req, url, deps);
    },
  };
}

/** One OpenAPI operation object (a single method on a path). */
interface OpenApiOperation {
  summary: string;
  description: string;
  security: Array<{ bearerAuth: string[] }>;
  responses: Record<string, OpenApiResponse>;
  parameters?: OpenApiParameter[];
  requestBody?: OpenApiRequestBody;
}

/** One OpenAPI response object. */
interface OpenApiResponse {
  description: string;
  content?: { "application/json": { schema: object } };
}

/** One OpenAPI parameter object (query params in this surface). */
interface OpenApiParameter {
  name: string;
  in: "query";
  required: boolean;
  description: string;
  schema: RestParamSpec["schema"];
}

/** One OpenAPI request-body object (the POST body contract). */
interface OpenApiRequestBody {
  required: boolean;
  content: { "application/json": { schema: object } };
}

/** The OpenAPI 3.1 document, generated from the SAME route table the router uses. */
export function buildOpenApiJson(): string {
  const paths: Record<string, Record<string, OpenApiOperation>> = {};
  for (const route of REST_ROUTES) {
    if (!route.path.startsWith(API_PATH_PREFIX)) continue; // /openapi.json is not a listed operation
    const responses: Record<string, OpenApiResponse> = Object.fromEntries(
      Object.entries(route.responses).map(([status, spec]): [string, OpenApiResponse] => {
        const response: OpenApiResponse = { description: spec.description };
        if (spec.schema !== undefined) {
          response.content = { "application/json": { schema: spec.schema } };
        }
        return [status, response];
      }),
    );
    const operation: OpenApiOperation = {
      summary: route.summary,
      description: route.description,
      security: [{ bearerAuth: [] }],
      responses,
    };
    if (route.queryParams !== undefined && route.queryParams.length > 0) {
      operation.parameters = route.queryParams.map(
        (param): OpenApiParameter => ({
          name: param.name,
          in: "query",
          required: param.required ?? false,
          description: param.description,
          schema: param.schema,
        }),
      );
    }
    if (route.method === "POST" && route.requestBody !== undefined) {
      operation.requestBody = {
        required: true,
        content: { "application/json": { schema: route.requestBody } },
      };
    }
    (paths[route.path] ??= {})[route.method.toLowerCase()] = operation;
  }
  return JSON.stringify(
    {
      openapi: "3.1.0",
      info: {
        title: "Bottega REST API",
        version: "1.0.0",
        description: "Token-authenticated operational REST API (issue #100).",
      },
      servers: [{ url: "/" }],
      components: {
        securitySchemes: {
          bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "opaque" },
        },
      },
      security: [{ bearerAuth: [] }],
      paths,
    },
    null,
    2,
  );
}