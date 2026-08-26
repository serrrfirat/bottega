/**
 * Shared Block Kit renderers (issue #279): pure, unit-testable builders for
 * the issue/work-item card and the digest table. Both FAIL CLOSED on
 * malformed input — a validation error, never a malformed Slack block — so
 * renderers can run over worker-shipped payloads without trusting them.
 * The output is plain JSON (`unknown[]`), the same shape `SlackAdapter
 * postMessage`'s `opts.blocks` and the approval router (approval-router.ts
 * buildApprovalBlocks) already use; no adapter dependency is introduced.
 */
export type SlackBlock = {
  type: string;
  text?: { type: "mrkdwn" | "plain_text"; text: string };
  block_id?: string;
  elements?: Array<{
    type: "button";
    text: { type: "plain_text"; text: string };
    action_id: string;
    value: string;
  }>;
};

/**
 * Retry-with-context action id (issue #358): the button on a BLOCKED issue
 * card that forks the failed item at its failure point. Defined beside its
 * renderer so the pure block module stays dependency-free; the retry router
 * imports the SAME constant.
 */
export const RETRY_WITH_CONTEXT_ACTION_ID = "bottega_retry_with_context";

/**
 * The one-click resume control (issue #358): continue from the last failure
 * without optional guidance. The value carries the WORK ITEM id. Copy is the
 * plain-language fast action on a blocked review card (issue #359).
 */
export function retryWithContextButton(workItemId: string): SlackBlock {
  return {
    type: "actions",
    block_id: "bottega_retry",
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: "Continue using work so far" },
        action_id: RETRY_WITH_CONTEXT_ACTION_ID,
        value: workItemId,
      },
    ],
  };
}

/**
 * Open-review action id (issue #359): the button on a BLOCKED issue card that
 * opens the plain-language review page. Defined beside its renderer so the
 * pure block module stays dependency-free; the Slack action router matches
 * the SAME id and the outbox seam renders this button next to the retry
 * control. The value carries the WORK ITEM id.
 */
export const OPEN_WORK_REVIEW_ACTION_ID = "bottega_open_work_review";

/** The one-click review control (issue #359); the value carries the WORK ITEM id. */
export function openWorkReviewButton(workItemId: string): SlackBlock {
  return {
    type: "actions",
    block_id: "bottega_open_work_review",
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: "Open review" },
        action_id: OPEN_WORK_REVIEW_ACTION_ID,
        value: workItemId,
      },
    ],
  };
}

/** How many table rows render before the remainder is elided into a count note. */
export const TABLE_ROW_CAP = 12;

/** Map a work-item/issue state to a Slack emoji for the card's leading icon. */
export function stateIcon(state: string): string {
  switch (state) {
    case "blocked":
      return "🚫";
    case "review":
    case "pending":
      return "🔍";
    case "done":
    case "completed":
      return "✅";
    case "open":
    case "claimed":
    case "working":
      return "🛠️";
    default:
      return "•";
  }
}

/** The work-item / issue notification card: icon + bold title, then owner, link, timestamp. */
export function issueCard(input: {
  title: string;
  state: string;
  owner?: string;
  link?: string;
  timestamp?: string;
}): SlackBlock[] {
  if (input.title.trim().length === 0) throw new Error("issueCard: title is required");
  if (input.state.trim().length === 0) throw new Error("issueCard: state is required");
  const meta: string[] = [];
  if (input.owner && input.owner.trim().length > 0) meta.push(`<@${input.owner.trim()}>`);
  if (input.link && input.link.trim().length > 0) meta.push(input.link.trim());
  if (input.timestamp && input.timestamp.trim().length > 0) meta.push(input.timestamp.trim());
  const metaLine = meta.length > 0 ? `\n${meta.join(" · ")}` : "";
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${stateIcon(input.state)} *${input.title.trim()}*${metaLine}`,
      },
    },
  ];
}

/**
 * Render a table as a single mrkdwn section block (Slack has no native table;
 * a fixed-width code block keeps columns aligned). Capped at
 * {@link TABLE_ROW_CAP} rows; the elided tail becomes a short count note.
 * Fails closed on empty headers or ragged rows.
 */
export function tableBlock(input: { headers: string[]; rows: string[][] }): SlackBlock[] {
  if (input.headers.length === 0) throw new Error("tableBlock: headers must not be empty");
  for (let i = 0; i < input.rows.length; i++) {
    if (input.rows[i]!.length !== input.headers.length) {
      throw new Error(`tableBlock: row ${i} has ${input.rows[i]!.length} columns; expected ${input.headers.length}`);
    }
  }
  // Pipes render literally inside the fenced code block — no escaping needed
  // (a `\|` would surface a visible backslash in Slack).
  const line = (values: string[]): string => `| ${values.join(" | ")} |`;
  const header = line(input.headers);
  const rows = input.rows.slice(0, TABLE_ROW_CAP).map(line);
  const elided = input.rows.length - rows.length;
  const separator = `| ${input.headers.map(() => "---").join(" | ")} |`;
  const body = [header, separator, ...rows];
  if (elided > 0) body.push(`_…and ${elided} more not shown_`);
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: "```\n" + body.join("\n") + "\n```" },
    },
  ];
}