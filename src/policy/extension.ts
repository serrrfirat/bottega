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
 *
 * The decision + audit + approval sequence itself lives in the shared
 * policy gate (src/policy/gate.ts, issue #26) so the ACP permission handler
 * makes exactly the same decisions this extension makes.
 */
import type {
  ExtensionContext,
  ExtensionFactory,
  ToolCallEvent,
  ToolCallEventResult,
} from "@oh-my-pi/pi-coding-agent";
import { sessionIdFromFilePath } from "../server/drivers/agent-driver";
import type { Store } from "../store/db";
import type { AuditModule } from "./audit";
import type { ApprovalRouter } from "./approval-router";
import { loadSpacePolicy, type PolicyConfig, type Tier } from "./config";
import { evaluatePolicyGate } from "./gate";

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
  /**
   * Executor-session context (issue #11): the work item's pickup approval IS
   * the authorization, so exec-tier tools the policy allows run without a
   * further human prompt. Unknown tools still deny and every decision still
   * audits; an explicit policy `prompt`/`deny` is never bypassed.
   */
  preApproved?: boolean;
  /**
   * Extension registry seam (issue #56): maps a tool name to its extension
   * id so the gate resolves extension calls against the allowlist before
   * tier/approval. Absent → extension tools follow plain tier logic (and
   * deny as unknown tools — fail closed).
   */
  toolExtensionId?: (toolName: string) => string | undefined;
  /**
   * Extension manifest tier seam (issue #53): maps an extension tool name
   * to its declared tier so an allowed extension crosses the tier stage as
   * a KNOWN tool. Absent → extension tools deny as unknown (fail closed) —
   * wire it wherever toolExtensionId is wired.
   */
  toolTier?: (toolName: string) => Tier | undefined;
  /**
   * Registered extension ids (issue #56): unknown ids in
   * `extensions.allow`/`extensions.deny` fail the policy closed. Absent →
   * id validation is skipped (executor sessions have no extension tools).
   */
  knownExtensionIds?: readonly string[];
}

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
    const spaceId = sessionIdFromFilePath(ctx.sessionManager.getSessionFile());
    const outcome = await evaluatePolicyGate(
      {
        loadPolicy: (sid) => loadSpacePolicy(deps.orgPolicy, deps.store, sid),
        audit: deps.audit,
        router: deps.router,
        timeoutMs: deps.timeoutMs,
        preApproved: deps.preApproved,
        knownExtensionIds: deps.knownExtensionIds,
        toolTier: deps.toolTier,
      },
      {
        tool: event.toolName,
        args: event.input,
        spaceId,
        actor,
        extensionId: deps.toolExtensionId?.(event.toolName),
      },
    );
    if (outcome.allowed) return;
    return { block: true, reason: outcome.blockReason };
  } catch (err) {
    // Fail closed: an internal gate error must never let the tool run.
    console.error("[policy] gate error (denying tool call):", err);
    return { block: true, reason: "policy: gate error — denied" };
  }
}
