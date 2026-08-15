/**
 * The action gate (issue #6): an OMP ExtensionAPI factory loaded into every
 * agent session. Every tool call crosses one gate:
 *
 *   tier (from the tool declaration) × space policy → allow | deny | ask-human
 *
 * Fail closed: unknown tool → deny, malformed policy → deny, approval timeout
 * → deny, router failure → deny, gate error → deny. Every decision writes a
 * `policy.decision` audit row; ask-human additionally writes
 * `approval.requested` / `approval.resolved` rows.
 */
import { basename } from "node:path";
import type {
  ExtensionContext,
  ExtensionFactory,
  ToolCallEvent,
  ToolCallEventResult,
} from "@oh-my-pi/pi-coding-agent";
import type { Store } from "../store/db";
import type { AuditModule } from "./audit";
import type { ApprovalRequest, ApprovalResolution, ApprovalRouter } from "./approval-router";
import {
  applySpaceOverlay,
  decideToolCall,
  isKnownTool,
  resolveTier,
  toolAction,
  type Decision,
  type PolicyConfig,
  type Tier,
} from "./config";

export interface PolicyExtensionDeps {
  orgPolicy: PolicyConfig;
  audit: AuditModule;
  router: ApprovalRouter;
  /** Store for per-space overlays (`spaces.policy_json`). */
  store: Pick<Store, "getSpace">;
  /** Ask-human timeout in ms; defaults to the policy's `approvals.timeout_minutes`. */
  timeoutMs?: number;
  /** Actor recorded on audit rows; defaults to "agent". */
  actor?: string;
}

/** Cap for the args summary embedded in policy.decision rows (appendAudit redacts + caps too). */
const ARGS_SUMMARY_MAX = 1000;

export default function createPolicyExtension(deps: PolicyExtensionDeps): ExtensionFactory {
  const actor = deps.actor ?? "agent";
  return (pi) => {
    pi.on("tool_call", (event, ctx) => gateToolCall(deps, actor, event, ctx));
  };
}

async function gateToolCall(
  deps: PolicyExtensionDeps,
  actor: string,
  event: ToolCallEvent,
  ctx: ExtensionContext,
): Promise<ToolCallEventResult | void> {
  try {
    const spaceId = spaceIdFromContext(ctx);
    const policy = await policyFor(deps, spaceId);
    const tool = event.toolName;
    const tier = resolveTier(tool);
    const { decision, reason } = decide(policy, tool, tier);

    await deps.audit.appendAudit({
      space_id: spaceId ?? null,
      actor,
      event_type: "policy.decision",
      payload: {
        tool,
        tier,
        decision,
        reason,
        // Args are redacted and capped by appendAudit before the row is written.
        args: summarizeArgs(event.input),
      },
    });

    if (decision === "allow") return;
    if (decision === "deny") return { block: true, reason: `policy: ${reason}` };
    return await requestApproval(deps, actor, event, policy, reason, spaceId);
  } catch (err) {
    // Fail closed: an internal gate error must never let the tool run.
    console.error("[policy] gate error (denying tool call):", err);
    return { block: true, reason: "policy: gate error — denied" };
  }
}

function decide(policy: PolicyConfig, tool: string, tier: Tier): { decision: Decision; reason: string } {
  if (!policy.ok) return { decision: "deny", reason: `policy invalid: ${policy.errors[0] ?? "parse error"}` };
  return decideToolCall({ tier, action: toolAction(policy, tool), toolKnown: isKnownTool(tool) });
}

async function policyFor(deps: PolicyExtensionDeps, spaceId: string | undefined): Promise<PolicyConfig> {
  if (!spaceId) return deps.orgPolicy;
  const space = await deps.store.getSpace(spaceId);
  return applySpaceOverlay(deps.orgPolicy, space?.policy_json ?? "");
}

async function requestApproval(
  deps: PolicyExtensionDeps,
  actor: string,
  event: ToolCallEvent,
  policy: PolicyConfig,
  reason: string,
  spaceId: string | undefined,
): Promise<ToolCallEventResult | void> {
  const request: ApprovalRequest = {
    tool: event.toolName,
    args: event.input,
    reason,
    spaceId: spaceId ?? "",
    actor,
  };
  await deps.audit.appendAudit({
    space_id: spaceId ?? null,
    actor,
    event_type: "approval.requested",
    payload: { tool: request.tool, reason },
  });

  const timeoutMs = deps.timeoutMs ?? policy.timeoutMinutes * 60_000;
  const resolution = await requestWithTimeout(deps.router, request, timeoutMs);

  await deps.audit.appendAudit({
    space_id: spaceId ?? null,
    actor,
    event_type: "approval.resolved",
    payload: { tool: request.tool, approved: resolution.approved, approver: resolution.approver ?? null },
  });

  if (resolution.approved) return;
  return { block: true, reason: "policy: approval denied" };
}

/** Resolves on the first of: router resolution, router failure (deny), timeout (deny). */
function requestWithTimeout(router: ApprovalRouter, request: ApprovalRequest, timeoutMs: number): Promise<ApprovalResolution> {
  const { promise, resolve } = Promise.withResolvers<ApprovalResolution>();
  const timer = setTimeout(() => resolve({ approved: false }), timeoutMs);
  timer.unref?.();
  void router.request(request).then(resolve, () => resolve({ approved: false }));
  return promise;
}

/**
 * Session file path is `<transcriptDir>/<spaceId>.jsonl` (driver contract),
 * so the space id is recoverable from the session manager at gate time.
 */
function spaceIdFromContext(ctx: ExtensionContext): string | undefined {
  const file = ctx.sessionManager.getSessionFile();
  if (!file) return undefined;
  const base = basename(file);
  return base.endsWith(".jsonl") ? base.slice(0, -".jsonl".length) : base;
}

function summarizeArgs(input: unknown): string {
  const text = JSON.stringify(input) ?? "";
  return text.length > ARGS_SUMMARY_MAX ? `${text.slice(0, ARGS_SUMMARY_MAX)}...[truncated]` : text;
}
