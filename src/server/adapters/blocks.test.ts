import { describe, expect, test } from "bun:test";
import { issueCard, TABLE_ROW_CAP, tableBlock, type SlackBlock } from "./blocks";

/** Asserts a Slack section block carries the given mrkdwn text. */
function sectionText(blocks: SlackBlock[], index: number): string {
  const block = blocks[index] as { text?: { text?: string } };
  const text = block.text?.text;
  if (text === undefined) throw new Error(`no mrkdwn text on block ${index}`);
  return text;
}

function allText(blocks: SlackBlock[]): string {
  return blocks.map((_, i) => sectionText(blocks, i)).join("\n");
}

describe("issueCard", () => {
  test("renders a section card with the state icon, bold title, owner and link", () => {
    const [card] = issueCard({
      title: "do the thing",
      state: "blocked",
      owner: "U_FINISHER",
      link: "https://github.com/acme/sandbox/work/wi_x",
    });
    const text = sectionText([card as SlackBlock], 0);
    expect(text).toContain("🚫");
    expect(text).toContain("*do the thing*");
    expect(text).toContain("U_FINISHER");
    expect(text).toContain("https://github.com/acme/sandbox/work/wi_x");
  });

  test("renders the review state with its own icon and an optional timestamp", () => {
    const [card] = issueCard({ title: "check the PR", state: "review", timestamp: "2026-08-18T10:00:00Z" });
    const text = sectionText([card as SlackBlock], 0);
    expect(text).toContain("🔍");
    expect(text).toContain("*check the PR*");
    expect(text).toContain("2026-08-18T10:00:00Z");
  });

  test("fails closed when the title is missing", () => {
    expect(() => issueCard({ title: "", state: "blocked" })).toThrowError(/issueCard: title is required/);
  });

  test("fails closed when the state is missing", () => {
    expect(() => issueCard({ title: "x", state: "" })).toThrowError(/issueCard: state is required/);
  });
});

describe("tableBlock", () => {
  test("renders a header plus each row in a monospaced table", () => {
    const blocks = tableBlock({
      headers: ["id", "state"],
      rows: [
        ["wi_1", "blocked"],
        ["wi_2", "review"],
      ],
    });
    const text = allText(blocks);
    expect(text).toContain("id");
    expect(text).toContain("state");
    expect(text).toContain("wi_1");
    expect(text).toContain("review");
  });

  test("caps the visible rows at the row cap and notes the elided tail", () => {
    const rows = Array.from({ length: TABLE_ROW_CAP + 5 }, (_, i) => [`wi_${i}`, "open"]);
    const blocks = tableBlock({ headers: ["id", "state"], rows });
    const text = allText(blocks);
    // The first cap rows render; the tail is elided with a count note.
    expect(text).toContain("wi_0");
    expect(text).toContain(`wi_${TABLE_ROW_CAP - 1}`);
    expect(text).not.toContain(`wi_${TABLE_ROW_CAP}`);
    expect(text).toContain("5 more");
  });

  test("fails closed on ragged rows (column count mismatch)", () => {
    expect(() =>
      tableBlock({
        headers: ["id", "state"],
        rows: [["wi_1", "blocked"], ["wi_2"]],
      }),
    ).toThrowError(/tableBlock: row 1 has 1 columns; expected 2/);
  });

  test("fails closed on empty headers", () => {
    expect(() => tableBlock({ headers: [], rows: [] })).toThrowError(/tableBlock: headers must not be empty/);
  });
});