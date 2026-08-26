import type { TimelineEntry } from "../../work-items/timeline";
import type { PlainWorkReview } from "./project";

export type ReviewRenderOptions = {
  csrfToken?: string;
  message?: string;
  error?: string;
  showForm?: boolean;
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function list(title: string, values: readonly string[]): string {
  const body = values.length === 0 ? "<li>Nothing recorded yet.</li>" : values.map((value) => `<li>${escapeHtml(value)}</li>`).join("");
  return `<section><h2>${escapeHtml(title)}</h2><ul>${body}</ul></section>`;
}

function activityLine(entry: TimelineEntry): string {
  switch (entry.kind) {
    case "created": return `Work started by ${entry.by}`;
    case "claimed": return `Work picked up by ${entry.runner}`;
    case "turn": return entry.summary;
    case "tool-call": return `Source checked: ${entry.tool}`;
    case "delivery-pending": return "Delivery is waiting for approval";
    case "failed": return `Work failed: ${entry.cause}`;
    case "blocked": return `Work needs attention: ${entry.cause}`;
    case "completed": return `Work completed: ${entry.cause}`;
  }
}

function activity(review: PlainWorkReview): string {
  const rows = review.activity.length === 0
    ? "<li>No activity recorded.</li>"
    : review.activity.map((entry) => `<li>${escapeHtml(activityLine(entry))}</li>`).join("");
  return `<details><summary>Full activity and technical details</summary><p>Work reference: ${escapeHtml(review.workItemId)}</p><ol>${rows}</ol></details>`;
}

export function renderWorkReview(review: PlainWorkReview, options: ReviewRenderOptions = {}): string {
  const status = options.message !== undefined ? `<p role="status" aria-live="polite">${escapeHtml(options.message)}</p>` : "";
  const error = options.error !== undefined ? `<p role="alert" aria-live="assertive">${escapeHtml(options.error)}</p>` : "";
  const form = options.showForm === false || options.csrfToken === undefined
    ? ""
    : `<form method="post" action="/work-review/continue"><label for="guidance">Add guidance first <span>(optional)</span></label><textarea id="guidance" name="guidance" maxlength="2000" rows="4"></textarea><input type="hidden" name="csrf" value="${escapeHtml(options.csrfToken)}"><button type="submit">Continue using this work</button></form>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Work review</title><style>body{font-family:system-ui,sans-serif;line-height:1.5;max-width: fiftyrem;margin:2rem auto;padding:0 1rem} :focus{outline:3px solid #155eef;outline-offset:2px} section{margin:1.5rem 0} details{margin-top:2rem} textarea{display:block;width:100%;max-width:40rem;margin:.5rem 0 1rem} button{padding:.6rem 1rem}</style></head><body><main tabindex="-1"><h1>Work review: ${escapeHtml(review.title)}</h1><p>Current state: ${escapeHtml(review.state)}</p>${status}${error}${list("What happened", review.whatHappened)}${list("Work completed", review.workCompleted)}${list("Still needed", review.stillNeeded)}${list("Related people", review.relatedPeople)}${list("Related matters", review.relatedMatters)}${list("Related documents", review.relatedDocuments)}${list("Related decisions", review.relatedDecisions)}${form}${activity(review)}</main></body></html>`;
}

export function renderReviewMessage(title: string, message: string, status = 403): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body><main tabindex="-1"><h1>${escapeHtml(title)}</h1><p role="alert" aria-live="assertive">${escapeHtml(message)}</p></main></body></html>`;
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'" } });
}
