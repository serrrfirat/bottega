import type { ExtensionFactory, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { z } from "@oh-my-pi/pi-coding-agent";
import type { AuditModule } from "../policy/audit";
import type { PolicyConfig } from "../policy/config";
import { sessionIdFromFilePath } from "../server/drivers/agent-driver";
import { channelFromSpaceId, type SlackAdapter } from "../server/adapters/slack";
import { OBJECT_CREATED_EVENT } from "../store/audit-events";
import type { Store } from "../store/db";
import { errorMessage, sha256Hex, toolError } from "./helpers";

export interface ObjectToolsOpts {
  /** Principal recorded on created objects and audits. Default "agent". */
  actor?: string;
  orgPolicy: PolicyConfig;
  audit?: Pick<AuditModule, "appendAudit">;
  adapter?: Pick<SlackAdapter, "uploadFile">;
}

export const objectListArgsSchema = z.object({});
export const objectGetArgsSchema = z.object({ id: z.string() });
export const objectCreateArgsSchema = z.object({
  name: z.string(),
  mime: z.string().optional(),
  content: z.string(),
});

const TEXT_MIME = new Set([
  "text/plain",
  "text/csv",
  "application/json",
  "text/markdown",
]);

const MIME_BY_EXTENSION = new Map<string, string>([
  [".csv", "text/csv"],
  [".json", "application/json"],
  [".md", "text/markdown"],
  [".txt", "text/plain"],
]);

function mimeFromName(name: string): string {
  const dot = name.lastIndexOf(".");
  const extension = dot < 0 ? "" : name.slice(dot).toLowerCase();
  return MIME_BY_EXTENSION.get(extension) ?? "application/octet-stream";
}

export function objectToolDefinitions(store: Store, opts: ObjectToolsOpts): ToolDefinition[] {
  const actor = opts.actor ?? "agent";
  const list: ToolDefinition<typeof objectListArgsSchema> = {
    name: "object.list",
    label: "List space objects",
    description: "Lists durable objects attached to or created in the current space. Read-only.",
    parameters: objectListArgsSchema,
    approval: "read",
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const spaceId = sessionIdFromFilePath(ctx.sessionManager.getSessionFile());
      if (!spaceId) return toolError("objects require a space session");
      try {
        const objects = await store.listObjects(spaceId);
        const output = objects.map(({ id, name, mime, size, sha256, created_at }) => ({
          id,
          name,
          mime,
          size,
          sha256,
          created_at,
        }));
        return { content: [{ type: "text", text: JSON.stringify(output) }] };
      } catch (err) {
        return toolError(errorMessage(err));
      }
    },
  };

  const get: ToolDefinition<typeof objectGetArgsSchema> = {
    name: "object.get",
    label: "Read space object",
    description:
      "Reads metadata and UTF-8 content from a text, CSV, JSON, or Markdown object. Other formats return an explicit unsupported-format error.",
    parameters: objectGetArgsSchema,
    approval: "read",
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      try {
        const object = await store.getObject(params.id);
        if (!object) return toolError(`object not found: ${params.id}`);
        if (!TEXT_MIME.has(object.mime)) {
          return toolError(
            `object ${object.id}: cannot extract text from ${object.mime} (unsupported format)`,
          );
        }
        const bytes = await store.readObjectBytes(object.id);
        if (!bytes) return toolError(`object not found: ${params.id}`);
        const { id, name, mime, size, sha256, created_at } = object;
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                id,
                name,
                mime,
                size,
                sha256,
                created_at,
                content: new TextDecoder().decode(bytes),
              }),
            },
          ],
        };
      } catch (err) {
        return toolError(errorMessage(err));
      }
    },
  };

  const create: ToolDefinition<typeof objectCreateArgsSchema> = {
    name: "object.create",
    label: "Create space object",
    description:
      "Creates a durable text object in the current space. MIME is inferred from .csv, .json, .md, or .txt when omitted. Write-tier.",
    parameters: objectCreateArgsSchema,
    approval: "write",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const spaceId = sessionIdFromFilePath(ctx.sessionManager.getSessionFile());
      if (!spaceId) return toolError("objects require a space session");
      const size = Buffer.byteLength(params.content);
      const limit = opts.orgPolicy.objects.maxSizeBytes;
      if (size > limit) return toolError(`object ${params.name} exceeds ${limit}B limit`);
      const mime = params.mime ?? mimeFromName(params.name);
      const sha256 = sha256Hex(params.content);
      try {
        await store.getOrCreateSpace({
          platform: "slack",
          channel_id: channelFromSpaceId(spaceId),
        });
        const object = await store.createObject({
          space_id: spaceId,
          name: params.name,
          mime,
          size,
          sha256,
          uploaded_by: actor,
          bytes: new TextEncoder().encode(params.content),
        });
        await opts.audit?.appendAudit({
          space_id: spaceId,
          actor,
          event_type: OBJECT_CREATED_EVENT,
          payload: { id: object.id, name: object.name, mime: object.mime, size: object.size, by: actor },
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                id: object.id,
                name: object.name,
                mime: object.mime,
                size: object.size,
                sha256: object.sha256,
              }),
            },
          ],
        };
      } catch (err) {
        return toolError(errorMessage(err));
      }
    },
  };

  return [list, get, create];
}

export function objectToolsExtension(store: Store, opts: ObjectToolsOpts): ExtensionFactory {
  return (pi) => {
    for (const definition of objectToolDefinitions(store, opts)) pi.registerTool(definition);
  };
}
