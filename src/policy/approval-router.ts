/**
 * Human-approval seam for the policy gate (issue #6).
 *
 * The server provides a Slack-backed router (buttons via the adapter) in a
 * later issue; headless contexts (the executor) use DenyRouter so exec-tier
 * tool calls never run without a human. The policy gate treats any
 * non-approved resolution — including router failure — as a deny.
 */

export interface ApprovalRequest {
  tool: string;
  /** Tool arguments as issued by the agent (used to render the approval prompt). */
  args: unknown;
  reason: string;
  spaceId: string;
  actor: string;
}

export interface ApprovalResolution {
  approved: boolean;
  /** Slack user id (or user group) that approved; present when approved. */
  approver?: string;
}

export interface ApprovalRouter {
  request(d: ApprovalRequest): Promise<ApprovalResolution>;
  /**
   * Outstanding (unresolved) prompts (issue #228): the read side of the
   * router, used by `list_todos` to report pending approvals. Optional —
   * headless routers (DenyRouter) deny immediately and never hold a
   * pending prompt, so they omit it and callers see an empty list.
   */
  pendingPrompts?(): ReadonlyArray<{ spaceId: string; tool: string }>;
}

/** No-op router for headless contexts: every ask-human request is denied. */
export const DenyRouter: ApprovalRouter = {
  async request() {
    return { approved: false };
  },
};

/**
 * Resolves on the first of: router resolution, router failure (deny),
 * timeout (deny). Shared by every policy surface (in-process extension and
 * the ACP permission handler, issue #26) so ask-human can never hang a
 * tool call.
 */
export function requestWithTimeout(
  router: ApprovalRouter,
  request: ApprovalRequest,
  timeoutMs: number,
): Promise<ApprovalResolution> {
  const { promise, resolve } = Promise.withResolvers<ApprovalResolution>();
  const timer = setTimeout(() => resolve({ approved: false }), timeoutMs);
  timer.unref?.();
  void router.request(request).then(resolve, () => resolve({ approved: false }));
  return promise;
}
