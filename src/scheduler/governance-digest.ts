import type { AuditModule } from "../policy/audit";
import {
  APPROVAL_RESOLVED_EVENT,
  EXTENSION_CREDENTIAL_RESOLVED_EVENT,
  GOVERNANCE_DIGEST_FAILED_EVENT,
  GOVERNANCE_DIGEST_POSTED_EVENT,
  POLICY_DECISION_EVENT,
  SETTINGS_CHANGED_EVENT,
} from "../store/audit-events";
import { summarizeAuditRow, type AuditSummary } from "../store/audit-read";
import type { AuditCursor, Store } from "../store/db";
import { proactiveEnabled } from "./proactive-config";
import type { SchedulerAction } from "./types";

const WEEK_MS = 7 * 24 * 60 * 60 * 1_000;
const PAGE_SIZE = 100;

interface GovernanceCounts {
  humanApprovals: Map<string, number>;
  automaticApprovals: number;
  denials: Map<string, number>;
  timeouts: number;
  orgCredentials: number;
  personalCredentials: number;
  orgSettingsChanges: number;
}

async function readEventWindow(
  store: Store,
  event_type: string,
  since: number,
  until: number,
): Promise<AuditSummary[]> {
  const summaries: AuditSummary[] = [];
  let cursor: AuditCursor | undefined;
  do {
    const page = await store.queryAudit({ event_type, since, until, cursor, limit: PAGE_SIZE });
    summaries.push(...page.rows.map(summarizeAuditRow));
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return summaries;
}

function increment(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function sortedCounts(counts: Map<string, number>): string[] {
  return [...counts.entries()]
    .sort(([labelA, countA], [labelB, countB]) => countB - countA || labelA.localeCompare(labelB))
    .map(([label, count]) => `  • ${label}: ${count}`);
}

function renderGovernanceDigest(counts: GovernanceCounts, since: number, until: number): string {
  const humanCount = [...counts.humanApprovals.values()].reduce((sum, count) => sum + count, 0);
  const denialCount = [...counts.denials.values()].reduce((sum, count) => sum + count, 0);
  const lines = [
    "*Weekly governance digest*",
    `_${new Date(since).toISOString()} to ${new Date(until).toISOString()}_`,
    "",
    `Approvals granted: ${humanCount}`,
    ...sortedCounts(counts.humanApprovals),
    `Automatic approvals: ${counts.automaticApprovals}`,
    `Denials: ${denialCount}`,
    ...sortedCounts(counts.denials),
    `Approval timeouts: ${counts.timeouts}`,
    `Credential use: org ${counts.orgCredentials}, personal ${counts.personalCredentials}`,
    `Org settings changes: ${counts.orgSettingsChanges}`,
  ];
  return lines.join("\n");
}

async function auditFailure(audit: AuditModule, spaceId: string | null, reason: string): Promise<void> {
  try {
    await audit.appendAudit({
      space_id: spaceId,
      actor: "scheduler:governance_digest",
      event_type: GOVERNANCE_DIGEST_FAILED_EVENT,
      payload: { reason },
    });
  } catch {
    // The scheduler runner owns the outer operational log. This action must
    // never turn a failed failure-audit into a second delivery attempt.
  }
}

/** Deterministic weekly governance aggregates. No model and no raw audit payload leaves this action. */
export const governanceDigestAction: SchedulerAction = {
  name: "governance_digest",
  async run(params, ctx) {
    const spaceId = params.space?.trim() ?? "";
    if (!spaceId) {
      await auditFailure(ctx.audit, null, "missing_space");
      return;
    }
    try {
      const space = await ctx.store.getSpace(spaceId);
      if (!space) {
        await auditFailure(ctx.audit, null, "unknown_space");
        return;
      }
      if (!proactiveEnabled(space.policy_json, "governance")) return;
      const policy = await ctx.loadPolicy(spaceId);
      if (!policy.ok || policy.responseMode !== "always") return;

      const until = ctx.now();
      const since = until - WEEK_MS;
      const [approvals, decisions, credentials, settings] = await Promise.all([
        readEventWindow(ctx.store, APPROVAL_RESOLVED_EVENT, since, until),
        readEventWindow(ctx.store, POLICY_DECISION_EVENT, since, until),
        readEventWindow(ctx.store, EXTENSION_CREDENTIAL_RESOLVED_EVENT, since, until),
        readEventWindow(ctx.store, SETTINGS_CHANGED_EVENT, since, until),
      ]);
      const counts: GovernanceCounts = {
        humanApprovals: new Map(),
        automaticApprovals: 0,
        denials: new Map(),
        timeouts: 0,
        orgCredentials: 0,
        personalCredentials: 0,
        orgSettingsChanges: 0,
      };
      for (const approval of approvals) {
        if (approval.approved === true && approval.approver === "policy") {
          counts.automaticApprovals += 1;
        } else if (approval.approved === true && approval.approver !== undefined && approval.approver !== null) {
          increment(counts.humanApprovals, `${approval.approver} — ${approval.tool ?? "unknown"}`);
        } else if (approval.approved === false && approval.approver === null) {
          counts.timeouts += 1;
        }
      }
      for (const decision of decisions) {
        if (decision.decision === "deny") increment(counts.denials, decision.reason ?? "other");
      }
      for (const credential of credentials) {
        if (credential.scope === "org") counts.orgCredentials += 1;
        if (credential.scope === "personal") counts.personalCredentials += 1;
      }
      counts.orgSettingsChanges = settings.filter((row) => row.scope === "org").length;
      const text = renderGovernanceDigest(counts, since, until);
      await ctx.postMessage(spaceId, text);
      await ctx.audit.appendAudit({
        space_id: spaceId,
        actor: "scheduler:governance_digest",
        event_type: GOVERNANCE_DIGEST_POSTED_EVENT,
        payload: {
          approvals: [...counts.humanApprovals.values()].reduce((sum, count) => sum + count, 0),
          automatic_approvals: counts.automaticApprovals,
          denials: [...counts.denials.values()].reduce((sum, count) => sum + count, 0),
          timeouts: counts.timeouts,
          credential_org: counts.orgCredentials,
          credential_personal: counts.personalCredentials,
          org_settings_changes: counts.orgSettingsChanges,
        },
      });
    } catch {
      await auditFailure(ctx.audit, spaceId, "delivery_failed");
    }
  },
};
