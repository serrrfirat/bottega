import type { ToolDefinition } from "@oh-my-pi/pi-coding-agent";
import { z } from "@oh-my-pi/pi-coding-agent";
import { resolveCredential } from "../extensions/credentials";
import type { AuditModule } from "../policy/audit";
import {
  decidePolicyCall,
  isKnownTool,
  loadSpacePolicy,
  orgCredentialsAllowed,
  resolveTier,
  toolAction,
  unknownExtensionId,
  type PolicyConfig,
  type Tier,
} from "../policy/config";
import * as auditEventVocabulary from "../store/audit-events";
import { AUDIT_READ_EVENT, POLICY_EXPLAINED_EVENT } from "../store/audit-events";
import { summarizeAuditRow, type AuditReasonCategory } from "../store/audit-read";
import type { AuditCursor, Store } from "../store/db";
import { sessionIdFromFilePath } from "../server/drivers/agent-driver";
import { toolError } from "./helpers";

const DAY_MS = 24 * 60 * 60 * 1_000;
const MAX_LOOKBACK_MS = 365 * DAY_MS;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const KNOWN_AUDIT_EVENTS: Readonly<Record<string, true>> = Object.fromEntries(
  Object.values(auditEventVocabulary).map((event) => [event, true]),
);
const PolicyOverlaySchema = z.object({
  tools: z.record(z.string(), z.unknown()).optional().catch(undefined),
  extensions: z.unknown().optional(),
});

type AuditSearchPayload = {
  space: string;
  limit: number;
  event?: string;
  actor?: string;
  tool?: string;
  extension?: string;
  since?: number;
  until?: number;
}

type PolicyCredentialExplanation =
  | { kind: "available"; provider: string; scope: "org" | "personal" }
  | { kind: "scope_required"; provider: string }
  | { kind: "unavailable"; provider: string; scope: "org" | "me" | "auto" };

type PolicyRuleSource = "org_floor" | "space_overlay" | "tool_tier" | "known_tool_table" | "policy_error";

interface PolicyExplanation {
  tool: string;
  space: string;
  tier: Tier;
  decision: "allow" | "deny" | "ask-human";
  reason: AuditReasonCategory;
  rule_source: PolicyRuleSource;
  approval_required: boolean;
  credential?: PolicyCredentialExplanation;
}

const auditSearchArgsSchema = z
  .object({
    event: z.string().optional(),
    space: z.string().optional(),
    actor: z.string().optional(),
    tool: z.string().optional(),
    extension: z.string().optional(),
    since: z.string().optional(),
    until: z.string().optional(),
    limit: z.number().int().min(1).max(50).optional(),
    cursor: z.string().optional(),
  })
  .strict();

const explainPolicyArgsSchema = z
  .object({
    tool: z.string(),
    space: z.string().optional(),
    extension: z.string().optional(),
    provider: z.string().optional(),
    credential_scope: z.enum(["org", "me", "auto"]).optional(),
  })
  .strict();

export interface OperatorReadToolsOpts {
  audit: AuditModule;
  orgPolicy: PolicyConfig;
  actorForSpace: (spaceId: string) => string | undefined;
  canReadSpace?: (actor: string, targetSpaceId: string) => Promise<boolean>;
  knownExtensionIds?: readonly string[];
  toolTier?: (toolName: string) => Tier | undefined;
  now?: () => number;
}

function parseRelativeOrIso(value: string, now: number, field: "since" | "until"): number | null {
  const relative = /^(\d+)([mhdw])$/.exec(value);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2];
    const multiplier = unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : unit === "d" ? DAY_MS : 7 * DAY_MS;
    const duration = amount * multiplier;
    if (!Number.isSafeInteger(duration) || duration < 1 || duration > MAX_LOOKBACK_MS) return null;
    return now - duration;
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  if (field === "since" && now - parsed > MAX_LOOKBACK_MS) return null;
  return parsed;
}

function encodeCursor(cursor: AuditCursor | null): string | null {
  return cursor === null ? null : `v1:${cursor.ts}:${cursor.id}`;
}

function decodeCursor(value: string | undefined): AuditCursor | undefined | null {
  if (value === undefined) return undefined;
  const match = /^v1:(\d+):([1-9]\d*)$/.exec(value);
  if (!match) return null;
  const ts = Number(match[1]);
  const id = Number(match[2]);
  return Number.isSafeInteger(ts) && Number.isSafeInteger(id) ? { ts, id } : null;
}

async function authorizeTarget(
  currentSpaceId: string,
  requestedSpace: string | undefined,
  actor: string,
  canReadSpace: OperatorReadToolsOpts["canReadSpace"],
): Promise<string | null> {
  const target = requestedSpace?.trim() || currentSpaceId;
  if (!SAFE_NAME.test(target)) return null;
  if (target === currentSpaceId) return target;
  if (canReadSpace === undefined || !(await canReadSpace(actor, target))) return null;
  return target;
}

function overlayDefinesRule(policyJson: string, tool: string, extension: string | undefined): boolean {
  try {
    const parsed = PolicyOverlaySchema.safeParse(JSON.parse(policyJson));
    if (!parsed.success) return false;
    if (parsed.data.tools && Object.prototype.hasOwnProperty.call(parsed.data.tools, tool)) return true;
    return extension !== undefined && "extensions" in parsed.data;
  } catch {
    return false;
  }
}

function ruleSource(input: {
  org: PolicyConfig;
  effective: PolicyConfig;
  overlayDefines: boolean;
  tool: string;
  extension?: string;
  extensionTier?: Tier;
  autoApproved: boolean;
}): PolicyRuleSource {
  if (!input.effective.ok) return "policy_error";
  if (input.overlayDefines || toolAction(input.effective, input.tool) !== toolAction(input.org, input.tool)) {
    return "space_overlay";
  }
  if (input.extension === undefined && !isKnownTool(input.tool)) return "known_tool_table";
  if (input.autoApproved) return "org_floor";
  if (toolAction(input.effective, input.tool) === "allow" && (input.extensionTier ?? resolveTier(input.tool)) === "exec") {
    return "tool_tier";
  }
  return "org_floor";
}

/** Read-tier audit and policy explanations for the real space-agent registry. */
export function operatorReadToolDefinitions(store: Store, opts: OperatorReadToolsOpts): ToolDefinition[] {
  const now = opts.now ?? Date.now;
  const search: ToolDefinition<typeof auditSearchArgsSchema> = {
    name: "audit_search",
    label: "Search audit",
    description:
      "Searches the current space's redacted audit trail by event, actor, tool, extension, and time. Returns compact newest-first rows plus a cursor; never returns raw payloads, prompts, bodies, queries, or secrets.",
    parameters: auditSearchArgsSchema,
    approval: "read",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const currentSpaceId = sessionIdFromFilePath(ctx.sessionManager.getSessionFile());
      if (!currentSpaceId) return toolError("audit_search requires a space session");
      const actor = opts.actorForSpace(currentSpaceId);
      if (!actor) return toolError("audit_search could not resolve the authenticated viewer");
      const target = await authorizeTarget(currentSpaceId, params.space, actor, opts.canReadSpace);
      if (!target) return toolError("audit_search is not authorized for the requested space");
      if (params.event !== undefined && !(params.event in KNOWN_AUDIT_EVENTS)) {
        return toolError(`audit_search: unknown event filter '${params.event}'`);
      }
      for (const [field, value] of [
        ["actor", params.actor],
        ["tool", params.tool],
        ["extension", params.extension],
      ] as const) {
        if (value !== undefined && !SAFE_NAME.test(value)) return toolError(`audit_search: invalid ${field} filter`);
      }
      const currentTime = now();
      const since = params.since === undefined ? undefined : parseRelativeOrIso(params.since, currentTime, "since");
      if (since === null) return toolError("audit_search: since must be a valid timestamp or a duration such as 7d");
      const until = params.until === undefined ? undefined : parseRelativeOrIso(params.until, currentTime, "until");
      if (until === null) return toolError("audit_search: until must be a valid timestamp or a duration such as 24h");
      if (since !== undefined && until !== undefined && since > until) {
        return toolError("audit_search: since must not be later than until");
      }
      const cursor = decodeCursor(params.cursor);
      if (cursor === null) return toolError("audit_search: malformed cursor");
      const limit = params.limit ?? 20;
      const page = await store.queryAudit({
        space_id: target,
        event_type: params.event,
        actor: params.actor,
        tool: params.tool,
        extension: params.extension,
        since,
        until,
        cursor,
        limit,
      });
      const filterAudit: AuditSearchPayload = { space: target, limit };
      if (params.event !== undefined) filterAudit.event = params.event;
      if (params.actor !== undefined) filterAudit.actor = params.actor;
      if (params.tool !== undefined) filterAudit.tool = params.tool;
      if (params.extension !== undefined) filterAudit.extension = params.extension;
      if (since !== undefined) filterAudit.since = since;
      if (until !== undefined) filterAudit.until = until;
      await opts.audit.appendAudit({
        space_id: target,
        actor,
        event_type: AUDIT_READ_EVENT,
        payload: filterAudit,
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ rows: page.rows.map(summarizeAuditRow), next_cursor: encodeCursor(page.nextCursor) }),
          },
        ],
      };
    },
  };

  const explain: ToolDefinition<typeof explainPolicyArgsSchema> = {
    name: "explain_policy",
    label: "Explain policy",
    description:
      "Explains the effective allow, deny, or ask-human result for a tool without attempting it or creating an approval. Optional provider and credential_scope report only which metadata scope would be selected.",
    parameters: explainPolicyArgsSchema,
    approval: "read",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const currentSpaceId = sessionIdFromFilePath(ctx.sessionManager.getSessionFile());
      if (!currentSpaceId) return toolError("explain_policy requires a space session");
      const actor = opts.actorForSpace(currentSpaceId);
      if (!actor) return toolError("explain_policy could not resolve the authenticated viewer");
      if (!SAFE_NAME.test(params.tool)) return toolError("explain_policy: invalid tool");
      if (params.extension !== undefined && !SAFE_NAME.test(params.extension)) {
        return toolError("explain_policy: invalid extension");
      }
      if ((params.provider === undefined) !== (params.credential_scope === undefined)) {
        return toolError("explain_policy: provider and credential_scope must be supplied together");
      }
      if (params.provider !== undefined && !SAFE_NAME.test(params.provider)) {
        return toolError("explain_policy: invalid provider");
      }
      const target = await authorizeTarget(currentSpaceId, params.space, actor, opts.canReadSpace);
      if (!target) return toolError("explain_policy is not authorized for the requested space");
      let effective = await loadSpacePolicy(opts.orgPolicy, store, target);
      if (opts.knownExtensionIds !== undefined) {
        const unknown = unknownExtensionId(effective, opts.knownExtensionIds);
        if (unknown !== undefined) {
          effective = { ...effective, ok: false, errors: [...effective.errors, `extensions: unknown extension id '${unknown}'`] };
        }
      }
      const extensionTier = params.extension !== undefined ? opts.toolTier?.(params.tool) : undefined;
      const effectiveTier = extensionTier ?? resolveTier(params.tool);
      const policyDecision = decidePolicyCall(effective, params.tool, false, params.extension, extensionTier);
      const space = await store.getSpace(target);
      const explanation: PolicyExplanation = {
        tool: params.tool,
        space: target,
        tier: effectiveTier,
        decision: policyDecision.decision,
        reason: summarizeAuditRow({
          id: 0,
          ts: 0,
          space_id: target,
          actor,
          event_type: "policy.decision",
          payload: JSON.stringify({ reason: policyDecision.reason }),
        }).reason ?? "other",
        rule_source: ruleSource({
          org: opts.orgPolicy,
          effective,
          overlayDefines: overlayDefinesRule(space?.policy_json ?? "", params.tool, params.extension),
          tool: params.tool,
          extension: params.extension,
          extensionTier,
          autoApproved: policyDecision.autoApproved,
        }),
        approval_required: policyDecision.decision === "ask-human",
      };
      if (params.provider !== undefined && params.credential_scope !== undefined) {
        const credentials = await store.listExtensionCredentials(params.provider);
        const resolution = resolveCredential({
          callScope: params.credential_scope,
          caller: actor,
          provider: params.provider,
          spacePolicy: { orgUsageAllowed: orgCredentialsAllowed(effective) },
          findCredential: (scope, owner) =>
            credentials.find((credential) => credential.scope === scope && (scope === "org" || credential.owner === owner)) ?? null,
        });
        explanation.credential =
          resolution.kind === "credential"
            ? { kind: "available", provider: params.provider, scope: resolution.credential.scope }
            : resolution.kind === "ask"
              ? { kind: "scope_required", provider: params.provider }
              : { kind: "unavailable", provider: params.provider, scope: params.credential_scope };
      }
      await opts.audit.appendAudit({
        space_id: target,
        actor,
        event_type: POLICY_EXPLAINED_EVENT,
        payload: {
          tool: params.tool,
          space: target,
          tier: effectiveTier,
          decision: policyDecision.decision,
        },
      });
      return { content: [{ type: "text", text: JSON.stringify(explanation) }] };
    },
  };

  return [search, explain];
}
