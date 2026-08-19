/**
 * Space skill tools (issues #234/#235, Tier 1 governance): the policy-gated
 * `write_space_skill` surface for the space agent. Fail-closed at every
 * layer — the driver's gate denies the call before this tool runs when the
 * tool is not allowlisted, and this validator rejects malformed writes
 * before anything touches disk. Every successful write appends the
 * `space_skill.written` audit event; the space's cached skills are busted so
 * the NEXT session claims the new skill (there is no live-session reload —
 * documented in architecture.md).
 */
import type { ExtensionContext, ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { z } from "@oh-my-pi/pi-coding-agent";
import { sessionIdFromFilePath } from "../server/drivers/agent-driver";
import { channelFromSpaceId } from "../server/adapters/slack";
import { writeSpaceSkill } from "../server/skills";
import { SPACE_SKILL_WRITTEN_EVENT } from "../store/audit-events";
import type { AuditModule } from "../policy/audit";
import { errorMessage, toolError } from "./helpers";
import type { Store } from "../store/db";

export const writeSpaceSkillArgsSchema = z.object({
  /** Skill name: letters/digits/dot/underscore/hyphen, no separators (mirrors the SDK authoring rules). */
  name: z.string(),
  /** One-line description the space agent uses to claim the skill. Must be non-empty. */
  description: z.string(),
  /** The skill's procedure body (markdown). Optional; referenced files must sit next to SKILL.md. */
  body: z.string().optional(),
  /** Optional trigger phrases surfaced in the frontmatter for prompt assembly. */
  triggers: z.array(z.string()).optional(),
});

export interface SpaceSkillsToolOpts {
  /** Audit seam for the `space_skill.written` event (redacted by the policy audit module). */
  audit: AuditModule;
  /** Actor for the audit event (the principal calling the tool). Default "agent". */
  actor?: string;
  /** Per-space skills root override (tests). Defaults to the env/default root. */
  skillsRoot?: string;
}

/**
 * The space skill tool as an SDK {@link ToolDefinition} (issues #234/#235):
 * rides the same custom-tools bridge as the work-item tools, so the driver's
 * policy gate wraps it identically (exec tier → ask-human by default).
 */
export function writeSpaceSkillToolDefinition(
  store: Store,
  opts: SpaceSkillsToolOpts,
): ToolDefinition<typeof writeSpaceSkillArgsSchema> {
  const actor = opts.actor ?? "agent";
  return {
    name: "write_space_skill",
    label: "Write space skill",
    description:
      "Writes a skill into this space's skill store (a SKILL.md with the skill's name, description, and procedure body). " +
      "The space agent claims the skill's procedure in its future sessions, and work items can pin it via `create_work_item` " +
      "`skills` or it applies wherever the procedure is relevant. Frontmatter is validated (name must be " +
      "[a-zA-Z0-9][a-zA-Z0-9._-]*, description non-empty) — a malformed write is rejected without touching disk. " +
      "The new skill is claimable starting with the space's NEXT session (there is no live-session reload). " +
      "Requires human approval (exec-tier tool).",
    parameters: writeSpaceSkillArgsSchema,
    approval: "exec",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionContext) {
      const spaceId = sessionIdFromFilePath(ctx.sessionManager.getSessionFile());
      if (!spaceId) return toolError("space skills require a space session");
      // The space row is the FK parent of the audit trail; create it lazily
      // like the work-item tools do (the session file is the only durable
      // space record until a row exists).
      await store.getOrCreateSpace({ platform: "slack", channel_id: channelFromSpaceId(spaceId) });
      try {
        const written = await writeSpaceSkill(spaceId, params, { root: opts.skillsRoot });
        await opts.audit.appendAudit({
          space_id: spaceId,
          actor,
          event_type: SPACE_SKILL_WRITTEN_EVENT,
          payload: { name: written.name, path: written.path },
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                name: written.name,
                path: written.path,
                space: spaceId,
                note: "claimable starting with the space's next session",
              }),
            },
          ],
        };
      } catch (err) {
        return toolError(errorMessage(err));
      }
    },
  };
}
