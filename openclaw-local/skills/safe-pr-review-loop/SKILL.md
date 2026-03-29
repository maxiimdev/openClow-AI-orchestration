---
name: safe-pr-review-loop
description: Run a controlled PR review/fix loop without auto-merge. Use when Claude Code has produced a branch/PR and you need iterative review + fixes with mandatory human approval before merge.
---

# Safe PR Review Loop

This skill enforces a **human-gated** review loop.

## Goal

Improve PR quality through iterative review/fix cycles while preventing risky autonomous merges.

## Workflow

1. Collect review feedback (AI + human comments).
2. Classify findings:
   - critical
   - major
   - minor
3. Apply fixes in small batches.
4. Re-run checks/tests.
5. Produce status report.
6. Request explicit human approval.

## Hard Safety Rules

- Never auto-merge.
- Never force-merge.
- Never push directly to protected branches.
- If architecture/API changes are detected, escalate for manual decision.

## Exit Conditions

- `ready_for_human_review`: all critical/major items addressed.
- `needs_decision`: ambiguous trade-off requires user choice.
- `blocked`: missing info/environment prevents safe completion.

## Script

Use `scripts/review_gate.py` to summarize review state and gate progression.
