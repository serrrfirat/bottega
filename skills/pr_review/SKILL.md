---
name: pr_review
description: Review the branch's diff before delivery — verify it is small, correct, and complete, then drive the review loop to a green approval; report a blocker instead of shipping a half-finished change.
triggers:
  - "PR review"
  - "review this diff"
  - "rebase/resolve"
---
# PR review loop (issue #87)

You are delivering a repository change as a pull request. Before the branch is
pushed, review it the way a maintainer would — then respond to any feedback
until the change is green, or report that it is blocked.

## 1. Review your own diff before committing

- Read the diff of the working tree against the base branch
  (`git diff <base_branch>...` where `<base_branch>` is usually `main`).
- Check it for a reviewer's hygiene: the diff is the minimal set of changes
  the work item actually needs; no stray edits, debug output, or unrelated
  reformatting; new/renamed files are intentional; no secrets, absolute local
  paths, or credentials in code or comments.
- Verify the change is complete against the work item: every acceptance
  criterion is implemented, not just the happy path — error handling,
  boundaries, and the documented edge cases too.
- Gate yourself on specifics: for every concern, name the file, the line, and
  the concrete risk. Vague self-reviews ("looks good") are not a review.
- Leave a review comment citing those specifics — in a PR context the comment
  names file + line + reason; in a bottega item session it is a short,
  structured note in your output before the commit.

## 2. Verify before you call it done

- Run the verification the repository requires (tests, type check, lint,
  build — whatever `package.json`/`Makefile`/README declare). A change that
  fails its own suite is NOT ready to deliver.
- If verification fails, iterate the branch (edit → re-run) until it is
  green. Do not paper over a failure, suppress a warning, or special-case a
  test to make it pass.

## 3. Respond to feedback

- When human review feedback arrives, address each point with a change and a
  concrete reply: what changed, where, and why. Never reply "done" without
  the diff that does it.
- Iterate the branch in place; keep the diff as small as the feedback allows;
  re-run verification after every iteration.
- Bounded loop: re-review + verify + re-push per round. If the same
  substantive point survives more than a few rounds without progress, stop
  iterating and report the blocker instead of grinding.

## 4. Terminal states

- GREEN: every review point addressed, verification passes → approve the
  change and deliver it.
- BLOCKED: a review point requires information, permissions, a design
  decision, or a dependency you cannot obtain — or the loop is not converging.
  Stop and report exactly what is blocked, with the file/line evidence and the
  specific thing you need, rather than shipping a half-finished change.
