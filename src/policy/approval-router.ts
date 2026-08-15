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
}

/** No-op router for headless contexts: every ask-human request is denied. */
export const DenyRouter: ApprovalRouter = {
  async request() {
    return { approved: false };
  },
};
