---
name: Issue (spec)
about: A scoped piece of work. Issues are the spec — epic #1 is architecture + decisions, sub-issues are scoped work. Do not silently change scope: update the issue first.
title: ""
labels: []
assignees: []
---

## Problem

What doesn't work, what's missing, or what decision is needed. Cite the
failure (issue number) or the gap this closes; point at the evidence (file +
line, observed behavior).

## Proposal

What changes. Describe it observably — the behavior a caller would see.

## Acceptance

Observable, caller-level criteria — each bullet must be testable at the
caller surface (inbound message / tool call / scheduler fire in, observable
effect out), in the highest hermetic tier that can express it. When this
issue is closed, each bullet maps to a test name in the PR — or to a named
skip-gated leg (`BOTTEGA_RUN_INTEGRATION=1`) / canary journey, with the PR
saying which. See AGENTS.md, "Definition of done: issue acceptance criteria
land as caller-level tests" (#174).
