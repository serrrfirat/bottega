/**
 * Posts the scheduled canary's failure report to the QA channel (issue
 * #175). Run by .github/workflows/canary.yml only on canary failure: reads
 * the report file (the canary step tees its per-journey output there) and
 * posts it — report + permalinks + the Actions run URL — to
 * SLACK_QA_CHANNEL (default `bottega-qa`) with the bot token. A missing
 * file or token is an explicit error, never a silent no-op: the workflow
 * already failed, and the notification must not disappear.
 */
import { readFileSync } from "node:fs";
import { SlackApiClient } from "../tests/e2e/slack-live";
import { classifyRerun } from "./canary-rerun";

const reportPath = process.argv[2] ?? "canary-report.txt";
const token = process.env.SLACK_BOT_TOKEN;
const channelName = process.env.SLACK_QA_CHANNEL?.trim() || "bottega-qa";
/** Slack's text limit is 40k; the report is kept tight so the post stays scannable. */
const MAX_REPORT_CHARS = 3500;

function report(): string {
  try {
    const raw = readFileSync(reportPath, "utf8").trim();
    return raw.length > MAX_REPORT_CHARS ? `${raw.slice(0, MAX_REPORT_CHARS)}…` : raw;
  } catch {
    return "(no report file — the canary failed before producing output)";
  }
}

if (!token) {
  console.error("canary-notify: SLACK_BOT_TOKEN is required (GitHub Actions secret)");
  process.exit(1);
}

const client = new SlackApiClient(token);
const runUrl =
  process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
    : undefined;

// Resolve the channel id from the name (the canary creates/locates the
// same channel; the bot token lists conversations). Falls back to the raw
// name when the channel is not listable — Slack accepts channel ids too.
const list = await client.call<{ channels: Array<{ id: string; name: string }> }>("conversations.list", {
  types: "public_channel,private_channel",
  limit: 200,
});
const channel = list.channels.find((c) => c.name === channelName)?.id ?? channelName;

const text = [
  "SCHEDULED LIVE-SLACK CANARY FAILED",
  "```" + report() + "```",
  rerunContext(),
  runUrl !== undefined ? `See the run: ${runUrl}` : "See the GitHub Actions run for the full report.",
  "Evidence: the canary-report.txt / canary-rerun.txt / canary-status.json artifacts (per-journey status, permalinks, redacted blocks) are in the run.",
].join("\n");

await client.call("chat.postMessage", { channel, text });
console.log(`canary-notify: failure report posted to #${channelName}`);

/** One-isolated-rerun context (issue #298): distinct when a flake recovered. */
function rerunContext(): string {
  let original: string;
  try {
    original = readFileSync(reportPath, "utf8");
  } catch {
    return "";
  }
  const rerunPath = process.env.CANARY_RERUN_REPORT;
  if (rerunPath === undefined || !readFileSyncQuiet(rerunPath)) return "";
  const classification = classifyRerun(original, readFileSyncQuiet(rerunPath));
  return classification.recoveredOnRerun
    ? "The isolated RERUN recovered (flake), but the ORIGINAL failure is release-blocking — confirm the root cause before deploy."
    : "";
}

function readFileSyncQuiet(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}
