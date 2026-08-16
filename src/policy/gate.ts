/**
 * The shared policy gate execution (issue #26): one implementation of
 * "decide → audit → route ask-human" used by every policy surface so the
 * ACP permission handler makes exactly the decisions the in-process OMP
 * extension makes — the same table, the same audit payload shapes, the
 * same fail-closed rules.
 *
 * Sequence per call:
 *   1. load the space's effective policy (org floor + space overlay);
 *   2. decide (tier × action, unknown tools deny, invalid policy denies;
 *      `approvals.always_approve` auto-approves listed exec tools, audited
 *      below as resolved-by-policy — issue #45);
 *   3. audit every decision as `policy.decision` {tool, tier, decision,
 *      reason, args} (args redacted + capped by appendAudit); auto-approvals
 *      additionally write `approval.resolved` {tool, approved: true,
 *      approver: "policy"};
 *   4. ask-human routes through the configured ApprovalRouter, auditing
 *      `approval.requested` / `approval.resolved`; router failure and
 *      timeout deny.
 *
 * The caller owns the error boundary: an internal gate error (e.g. the
 * policy resolver failing) must deny the call, never let it run.
 */
import { APPROVAL_REQUESTED_EVENT, APPROVAL_RESOLVED_EVENT, POLICY_DECISION_EVENT } from "../store/audit-events";
import type { AuditModule } from "./audit";
import { requestWithTimeout, type ApprovalRequest, type ApprovalRouter } from "./approval-router";
import { decidePolicyCall, resolveTier, unknownExtensionId, type Decision, type PolicyConfig, type Tier } from "./config";

export interface PolicyGateDeps {
  /** Resolves the effective policy for a space (org floor + overlay). */
  loadPolicy: (spaceId: string | undefined) => Promise<PolicyConfig>;
  audit: AuditModule;
  router: ApprovalRouter;
  /** Ask-human timeout in ms; defaults to the policy's `approvals.timeout_minutes`. */
  timeoutMs?: number;
  /** Executor-session scope (issue #11); see decidePolicyCall. */
  preApproved?: boolean;
  /**
   * Registered extension ids (issue #56). When provided, ids referenced by
   * `extensions.allow`/`extensions.deny` are validated against it — an
   * unknown id is a structural error that fails the whole policy closed.
   */
  knownExtensionIds?: readonly string[];
  /**
   * Resolves the manifest tier of an extension tool (issue #53). Consulted
   * ONLY for calls that carry an extensionId: an allowed extension then
   * crosses the tier stage as a KNOWN tool with its declared tier (the
   * allowlist is not a bypass — tier logic still applies). Absent or
   * unresolved → the call falls through to the static table and denies as
   * an unknown tool (fail closed). Built-in tools can never be re-tiered:
   * the seam never runs without an extensionId.
   */
  toolTier?: (toolName: string) => Tier | undefined;
}

export interface PolicyGateCall {
  tool: string;
  args: unknown;
  spaceId?: string;
  /** Actor recorded on audit rows. */
  actor: string;
  /**
   * Extension id when the call is an extension tool (issue #56): the
   * allowlist check runs before tier/approval — a denied extension never
   * reaches approval or credential resolution.
   */
  extensionId?: string;
}

export interface PolicyGateOutcome {
  decision: Decision;
  reason: string;
  /** True when the call may run (allow, or ask-human approved). */
  allowed: boolean;
  /** Block message for the caller when !allowed. */
  blockReason: string;
}

/** Cap for the args summary embedded in policy.decision rows (appendAudit redacts + caps too). */
const ARGS_SUMMARY_MAX = 1000;

export function summarizeArgs(input: unknown): string {
  const text = JSON.stringify(input) ?? "";
  return text.length > ARGS_SUMMARY_MAX ? `${text.slice(0, ARGS_SUMMARY_MAX)}...[truncated]` : text;
}

export async function evaluatePolicyGate(deps: PolicyGateDeps, call: PolicyGateCall): Promise<PolicyGateOutcome> {
  let policy = await deps.loadPolicy(call.spaceId);
  // Unknown extension ids in allow/deny are a structural error (issue #56):
  // the whole policy fails closed — every decision in the space denies.
  if (deps.knownExtensionIds !== undefined) {
    const unknown = unknownExtensionId(policy, deps.knownExtensionIds);
    if (unknown !== undefined) {
      policy = { ...policy, ok: false, errors: [...policy.errors, `extensions: unknown extension id '${unknown}'`] };
    }
  }
  // Extension calls cross the tier stage with their manifest tier (issue
  // #53); built-ins never reach this seam.
  const extensionTier = call.extensionId !== undefined ? deps.toolTier?.(call.tool) : undefined;
  const { decision, reason, autoApproved } = decidePolicyCall(
    policy,
    call.tool,
    deps.preApproved ?? false,
    call.extensionId,
    extensionTier,
  );

  await deps.audit.appendAudit({
    space_id: call.spaceId ?? null,
    actor: call.actor,
    event_type: POLICY_DECISION_EVENT,
    payload: {
      tool: call.tool,
      // Audit the tier the decision actually used: the manifest tier for
      // extension calls, the static table otherwise.
      tier: extensionTier ?? resolveTier(call.tool),
      decision,
      reason,
      // Args are redacted and capped by appendAudit before the row is written.
      args: summarizeArgs(call.args),
    },
  });

  // Always-approve (issue #45): no prompt was posted, but the resolved row
  // with approver "policy" keeps the trail complete and distinguishable
  // from a human approval.
  if (autoApproved) {
    await deps.audit.appendAudit({
      space_id: call.spaceId ?? null,
      actor: call.actor,
      event_type: APPROVAL_RESOLVED_EVENT,
      payload: { tool: call.tool, approved: true, approver: "policy" },
    });
  }

  if (decision === "allow") return { decision, reason, allowed: true, blockReason: "" };
  if (decision === "deny") return { decision, reason, allowed: false, blockReason: `policy: ${reason}` };

  const request: ApprovalRequest = {
    tool: call.tool,
    args: call.args,
    reason,
    spaceId: call.spaceId ?? "",
    actor: call.actor,
  };
  await deps.audit.appendAudit({
    space_id: call.spaceId ?? null,
    actor: call.actor,
    event_type: APPROVAL_REQUESTED_EVENT,
    payload: { tool: request.tool, reason },
  });

  const timeoutMs = deps.timeoutMs ?? policy.timeoutMinutes * 60_000;
  const resolution = await requestWithTimeout(deps.router, request, timeoutMs);

  await deps.audit.appendAudit({
    space_id: call.spaceId ?? null,
    actor: call.actor,
    event_type: APPROVAL_RESOLVED_EVENT,
    payload: { tool: request.tool, approved: resolution.approved, approver: resolution.approver ?? null },
  });

  if (resolution.approved) return { decision, reason, allowed: true, blockReason: "" };
  return { decision, reason, allowed: false, blockReason: "policy: approval denied" };
}
