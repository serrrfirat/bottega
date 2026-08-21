import { createHash } from "node:crypto";
import type { ConnectionReadModel } from "../extensions/lifecycle";
import type { AuditModule } from "../policy/audit";
import type { PolicyConfig } from "../policy/config";
import { OPERATOR_HOME_READ_EVENT } from "../store/audit-events";
import { summarizeAuditRow, type AuditSummary } from "../store/audit-read";
import type { CredentialScope, Store } from "../store/db";

const WEEK_MS = 7 * 24 * 60 * 60 * 1_000;
const SAFE_LABEL = /^[A-Za-z0-9][A-Za-z0-9 _.:/-]{0,63}$/;
const RECENT_OUTCOME_EVENTS: Readonly<Record<string, true>> = {
  "policy.decision": true,
  "approval.resolved": true,
  "scheduler.error": true,
  "work_item.failed": true,
  "job.failed": true,
  "outbox.failed": true,
  "governance_digest.failed": true,
};

export interface OperatorViewer {
  id: string;
  isAdmin: boolean;
}

export interface OperatorMemoryStatus {
  provider: string;
  available: boolean;
  personal?: number;
  org?: number;
}

export interface OperatorHomeDeps {
  store: Store;
  audit: AuditModule;
  orgPolicy: PolicyConfig;
  setupChecks: () => Array<{ name: string; ok: boolean }>;
  listConnections: (viewer: string) => Promise<ConnectionReadModel[]>;
  pendingApprovals: () => Array<{ spaceId: string; tool: string }>;
  memoryStatus: (viewer: string) => Promise<OperatorMemoryStatus>;
  now?: () => number;
}

export interface SlackHomeView {
  type: "home";
  blocks: unknown[];
}

export interface SlackHomeRender {
  view: SlackHomeView;
  revision: string;
}

export interface OperatorHomeService {
  render(viewer: OperatorViewer): Promise<SlackHomeRender>;
  recordRead(viewer: OperatorViewer, revision: string): Promise<void>;
}

interface SlackSectionBlock {
  type: "section";
  text: { type: "mrkdwn"; text: string };
}

function section(title: string, lines: string[]): SlackSectionBlock {
  return {
    type: "section",
    text: {
      type: "mrkdwn",
      text: `*${title}*\n${lines.length > 0 ? lines.join("\n") : "_None_"}`,
    },
  };
}

function safeLabel(value: string, fallback = "unknown"): string {
  return SAFE_LABEL.test(value) ? value : fallback;
}

async function boundedSection(
  title: string,
  read: () => Promise<string[]> | string[],
): Promise<SlackSectionBlock> {
  try {
    return section(title, await read());
  } catch {
    return section(title, ["_Unavailable_"]);
  }
}

function compactOutcome(row: AuditSummary): string {
  const facts = [row.decision, row.reason, row.tool, row.approved === undefined ? undefined : row.approved ? "approved" : "denied"]
    .filter((value): value is string => value !== undefined)
    .join(" · ");
  return `• ${row.event} · ${row.space ?? "org"} · ${row.actor}${facts ? ` · ${facts}` : ""}`;
}

function revisionFor(view: SlackHomeView): string {
  return createHash("sha256").update(JSON.stringify(view)).digest("hex").slice(0, 24);
}

/** Deterministic, admin-scoped source for the Slack App Home view. */
export function createOperatorHomeService(deps: OperatorHomeDeps): OperatorHomeService {
  const now = deps.now ?? Date.now;
  return {
    async render(viewer) {
      if (!viewer.isAdmin) {
        const denied: SlackHomeView = {
          type: "home",
          blocks: [
            { type: "header", text: { type: "plain_text", text: "Bottega Operator Home" } },
            section("Operator access required", ["Ask a Slack workspace administrator for operator access."]),
          ],
        };
        return { view: denied, revision: revisionFor(denied) };
      }

      const blocks: unknown[] = [
        { type: "header", text: { type: "plain_text", text: "Bottega Operator Home" } },
        {
          type: "context",
          elements: [{ type: "mrkdwn", text: "Read-only workspace status. Refresh by reopening Home." }],
        },
      ];
      blocks.push(
        await boundedSection("Setup health", () => {
          const checks = deps.setupChecks();
          return checks.length === 0
            ? ["_No setup checks configured_"]
            : checks.slice(0, 10).map((check) => `• ${check.ok ? "Ready" : "Needs attention"} — ${safeLabel(check.name)}`);
        }),
      );
      blocks.push(
        await boundedSection("Running and blocked work", async () => {
          const items = await deps.store.listWorkItems();
          const visible = items.filter((item) =>
            item.state === "claimed" || item.state === "working" || item.state === "review" || item.state === "blocked",
          );
          return visible.slice(0, 10).map((item) => `• ${safeLabel(item.id)} · ${item.state} · ${safeLabel(item.space_id)}`);
        }),
      );
      blocks.push(
        await boundedSection("Pending approvals", () =>
          deps
            .pendingApprovals()
            .slice(0, 10)
            .map((approval) => `• ${safeLabel(approval.tool)} · ${safeLabel(approval.spaceId)}`),
        ),
      );
      blocks.push(
        await boundedSection("Schedules", async () => {
          const jobs = await deps.store.listSchedulerJobs();
          return jobs.slice(0, 10).map(
            (job) =>
              `• ${safeLabel(job.action)} · ${job.spaceId ? safeLabel(job.spaceId) : "org"} · ${job.enabled ? "enabled" : "disabled"} · next ${new Date(job.nextFireAt).toISOString()}`,
          );
        }),
      );
      blocks.push(
        await boundedSection("Connections", async () => {
          const connections = (await deps.listConnections(viewer.id)).filter(
            (connection) => connection.scope === "org" || connection.owner === viewer.id || connection.owner === "you",
          );
          return connections.slice(0, 10).map(
            (connection) =>
              `• ${safeLabel(connection.label)} · ${safeLabel(connection.identity_label)} · ${connection.scope} · ${safeLabel(connection.status)}${connection.reconnect_needed ? " · reconnect needed" : ""}`,
          );
        }),
      );
      blocks.push(
        await boundedSection("Memory", async () => {
          const status = await deps.memoryStatus(viewer.id);
          if (status.personal !== undefined && !Number.isSafeInteger(status.personal)) throw new Error("invalid memory status");
          if (status.org !== undefined && !Number.isSafeInteger(status.org)) throw new Error("invalid memory status");
          const lines = [`• ${status.available ? "Available" : "Unavailable"} · ${safeLabel(status.provider)}`];
          if (status.personal !== undefined) lines.push(`• Personal entries: ${status.personal}`);
          if (status.org !== undefined) lines.push(`• Org entries: ${status.org}`);
          return lines;
        }),
      );
      blocks.push(
        await boundedSection("Recent outcomes", async () => {
          const page = await deps.store.queryAudit({ since: now() - WEEK_MS, until: now(), limit: 50 });
          return page.rows
            .map(summarizeAuditRow)
            .filter((row) => row.event in RECENT_OUTCOME_EVENTS)
            .slice(0, 10)
            .map(compactOutcome);
        }),
      );
      blocks.push(
        section("Policy explanations", [
          `• Org policy: ${deps.orgPolicy.ok ? "ready" : "unavailable (fail closed)"}`,
          "• In chat, use `explain_policy {tool, space?}`. It does not run the tool or create an approval.",
        ]),
      );
      const view: SlackHomeView = { type: "home", blocks };
      return { view, revision: revisionFor(view) };
    },
    async recordRead(viewer, revision) {
      await deps.audit.appendAudit({
        actor: viewer.id,
        event_type: OPERATOR_HOME_READ_EVENT,
        payload: { revision },
      });
    },
  };
}
