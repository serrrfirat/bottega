
/** Complete, policy-gated lifecycle for the selected space's skill tier. */
import type { ExtensionContext, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { z } from "@oh-my-pi/pi-coding-agent";
import { sessionIdFromFilePath } from "../server/drivers/agent-driver";
import { channelFromSpaceId } from "../server/adapters/slack";
import {
  createSpaceSkill,
  deleteSpaceSkill,
  getSpaceSkill,
  listSpaceSkills,
  MAX_COMPANION_FILES,
  MAX_COMPANION_FILE_BYTES,
  MAX_COMPANION_PATH_BYTES,
  MAX_SKILL_DOCUMENT_BYTES,
  updateSpaceSkill,
  MAX_SKILL_TOTAL_BYTES,
  validateCompanionPath,
  type SkillsResolveOpts,
} from "../server/skills";
import {
  SPACE_SKILL_CREATED_EVENT,
  SPACE_SKILL_DELETED_EVENT,
  SPACE_SKILL_LISTED_EVENT,
  SPACE_SKILL_READ_EVENT,
  SPACE_SKILL_UPDATED_EVENT,
} from "../store/audit-events";
import type { AuditModule } from "../policy/audit";
import { errorMessage, toolError } from "./helpers";
import type { Store } from "../store/db";

const skillNameSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/);
const revisionSchema = z.string().regex(/^[a-f0-9]{64}$/);
const companionPathSchema = z
  .string()
  .max(MAX_COMPANION_PATH_BYTES)
  .refine((path) => {
    try {
      validateCompanionPath(path);
      return true;
    } catch {
      return false;
    }
  }, "must be a strict relative companion path without traversal, hidden segments, or reserved names");
const companionValueSchema = z.union([
  z.object({ encoding: z.literal("text"), content: z.string().max(MAX_COMPANION_FILE_BYTES) }),
  z.object({
    encoding: z.literal("base64"),
    content: z
      .string()
      .max(Math.ceil(MAX_COMPANION_FILE_BYTES / 3) * 4)
      .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  }),
]);
const companionFilesSchema = z
  .record(companionPathSchema, companionValueSchema)
  .refine((files) => Object.keys(files).length <= MAX_COMPANION_FILES, `at most ${MAX_COMPANION_FILES} companion files are allowed`);

function isWithinTotalSize(value: {
  document: string;
  companion_files?: Record<string, { encoding: "text" | "base64"; content: string }>;
}): boolean {
  let total = Buffer.byteLength(value.document, "utf8");
  for (const file of Object.values(value.companion_files ?? {})) {
    total += file.encoding === "base64" ? Buffer.from(file.content, "base64").byteLength : Buffer.byteLength(file.content, "utf8");
    if (total > MAX_SKILL_TOTAL_BYTES) return false;
  }
  return true;
}

export const listSpaceSkillsArgsSchema = z.object({});
export const getSpaceSkillArgsSchema = z.object({ name: skillNameSchema });
export const createSpaceSkillArgsSchema = z
  .object({
    name: skillNameSchema,
    document: z.string().max(MAX_SKILL_DOCUMENT_BYTES),
    companion_files: companionFilesSchema.optional(),
  })
  .refine(isWithinTotalSize, `skill content must not exceed ${MAX_SKILL_TOTAL_BYTES} total bytes`);
export const updateSpaceSkillArgsSchema = z
  .object({
    name: skillNameSchema,
    expected_revision: revisionSchema,
    document: z.string().max(MAX_SKILL_DOCUMENT_BYTES),
    companion_files: companionFilesSchema,
  })
  .refine(isWithinTotalSize, `skill content must not exceed ${MAX_SKILL_TOTAL_BYTES} total bytes`);
export const deleteSpaceSkillArgsSchema = z.object({ name: skillNameSchema, expected_revision: revisionSchema });

export interface SpaceSkillsToolOpts {
  audit: AuditModule;
  actor?: string;
  skillsRoot?: string;
  builtinSkillsDir?: string;
  /** Hermetic storage-failure seam for caller-level rollback tests. */
  mutationHook?: SkillsResolveOpts["mutationHook"];
}

function spaceIdFromContext(ctx: ExtensionContext): string | undefined {
  return sessionIdFromFilePath(ctx.sessionManager.getSessionFile());
}

async function ensureAuditSpace(store: Store, spaceId: string): Promise<void> {
  await store.getOrCreateSpace({ platform: "slack", channel_id: channelFromSpaceId(spaceId) });
}

export function spaceSkillToolDefinitions(store: Store, opts: SpaceSkillsToolOpts): ToolDefinition[] {
  const actor = opts.actor ?? "agent";
  const resolveOpts: SkillsResolveOpts = {
    root: opts.skillsRoot,
    builtinDir: opts.builtinSkillsDir,
    mutationHook: opts.mutationHook,
  };

  const list: ToolDefinition<typeof listSpaceSkillsArgsSchema> = {
    name: "list_space_skills",
    label: "List space skills",
    description:
      "Lists the effective skills for this space with source tier, revision, companion-file names, and lower-tier shadowing. " +
      "This is read-only and returns no file bodies.",
    parameters: listSpaceSkillsArgsSchema,
    approval: "read",
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const spaceId = spaceIdFromContext(ctx);
      if (!spaceId) return toolError("space skills require a space session");
      try {
        await ensureAuditSpace(store, spaceId);
        const skills = await listSpaceSkills(spaceId, resolveOpts);
        await opts.audit.appendAudit({
          space_id: spaceId,
          actor,
          event_type: SPACE_SKILL_LISTED_EVENT,
          payload: { skills: skills.map(({ name, source_tier, revision }) => ({ name, source_tier, revision })) },
        });
        return { content: [{ type: "text", text: JSON.stringify(skills) }] };
      } catch (error) {
        return toolError(errorMessage(error));
      }
    },
  };

  const get: ToolDefinition<typeof getSpaceSkillArgsSchema> = {
    name: "get_space_skill",
    label: "Get space skill",
    description:
      "Reads the effective skill document and its bounded companion files. The result identifies its source tier, revision, " +
      "and any lower-tier skill shadowed by the space version.",
    parameters: getSpaceSkillArgsSchema,
    approval: "read",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const spaceId = spaceIdFromContext(ctx);
      if (!spaceId) return toolError("space skills require a space session");
      try {
        await ensureAuditSpace(store, spaceId);
        const result = await getSpaceSkill(spaceId, params.name, resolveOpts);
        await opts.audit.appendAudit({
          space_id: spaceId,
          actor,
          event_type: SPACE_SKILL_READ_EVENT,
          payload: {
            name: result.skill.name,
            source_tier: result.skill.source_tier,
            revision: result.skill.revision,
            companion_files: Object.keys(result.skill.companion_files),
          },
        });
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (error) {
        return toolError(errorMessage(error));
      }
    },
  };

  const create: ToolDefinition<typeof createSpaceSkillArgsSchema> = {
    name: "create_space_skill",
    label: "Create space skill",
    description:
      "Creates one new space-tier skill from a bounded SKILL.md document and bounded map of strict relative companion files. " +
      "It refuses replacement, traversal, symlinks, and content outside the configured space root. The next cold session sees it.",
    parameters: createSpaceSkillArgsSchema,
    approval: "exec",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const spaceId = spaceIdFromContext(ctx);
      if (!spaceId) return toolError("space skills require a space session");
      try {
        await ensureAuditSpace(store, spaceId);
        const skill = await createSpaceSkill(
          spaceId,
          { name: params.name, document: params.document, companionFiles: params.companion_files },
          resolveOpts,
        );
        await opts.audit.appendAudit({
          space_id: spaceId,
          actor,
          event_type: SPACE_SKILL_CREATED_EVENT,
          payload: { name: skill.name, revision: skill.revision, companion_files: skill.companion_files },
        });
        return {
          content: [{ type: "text", text: JSON.stringify({ ...skill, note: "claimable starting with the space's next session" }) }],
        };
      } catch (error) {
        return toolError(errorMessage(error));
      }
    },
  };

  const update: ToolDefinition<typeof updateSpaceSkillArgsSchema> = {
    name: "update_space_skill",
    label: "Update space skill",
    description:
      "Atomically replaces one space-tier SKILL.md and its complete declared companion-file set. expected_revision is required; " +
      "a stale revision or any validation/filesystem failure leaves the prior skill unchanged. The next cold session sees it.",
    parameters: updateSpaceSkillArgsSchema,
    approval: "exec",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const spaceId = spaceIdFromContext(ctx);
      if (!spaceId) return toolError("space skills require a space session");
      try {
        await ensureAuditSpace(store, spaceId);
        const updated = await updateSpaceSkill(
          spaceId,
          {
            name: params.name,
            expectedRevision: params.expected_revision,
            document: params.document,
            companionFiles: params.companion_files,
          },
          resolveOpts,
        );
        await opts.audit.appendAudit({
          space_id: spaceId,
          actor,
          event_type: SPACE_SKILL_UPDATED_EVENT,
          payload: {
            name: updated.skill.name,
            previous_revision: updated.previous_revision,
            revision: updated.skill.revision,
            companion_files: updated.skill.companion_files,
          },
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ...updated.skill,
                previous_revision: updated.previous_revision,
                note: "claimable starting with the space's next session",
              }),
            },
          ],
        };
      } catch (error) {
        return toolError(errorMessage(error));
      }
    },
  };

  const remove: ToolDefinition<typeof deleteSpaceSkillArgsSchema> = {
    name: "delete_space_skill",
    label: "Delete space skill",
    description:
      "Deletes only the selected space-tier skill at expected_revision. Built-in skills remain read-only; deleting a shadow " +
      "reveals the lower-tier version to the next cold session.",
    parameters: deleteSpaceSkillArgsSchema,
    approval: "exec",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const spaceId = spaceIdFromContext(ctx);
      if (!spaceId) return toolError("space skills require a space session");
      try {
        await ensureAuditSpace(store, spaceId);
        const result = await deleteSpaceSkill(spaceId, params.name, params.expected_revision, resolveOpts);
        await opts.audit.appendAudit({
          space_id: spaceId,
          actor,
          event_type: SPACE_SKILL_DELETED_EVENT,
          payload: {
            name: result.deleted.name,
            revision: result.deleted.revision,
            ...(result.revealed
              ? { revealed: { source_tier: result.revealed.source_tier, revision: result.revealed.revision } }
              : undefined),
          },
        });
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (error) {
        return toolError(errorMessage(error));
      }
    },
  };

  return [list, get, create, update, remove];
}
