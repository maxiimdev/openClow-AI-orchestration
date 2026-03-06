# Worker Flow — Exact Specification

This document describes all execution flows, flags, stage transitions, and
Definition of Done (DoD) criteria for the worker.

## Single-Shot Flow (default)

All tasks without `reviewLoop`/`orchestratedLoop` flags follow this path:

```
pull → validate → checkout branch → spawn Claude (fresh session)
     → parse output → [needs_input?] → needs_input  (task paused, user input required)
                    → [review mode?] → review_pass / review_fail
                    → completed / failed / timeout
```

**DoD:** Result posted with a terminal status. For `review` mode, status is
always `review_pass` or `review_fail` (never `completed`).

## needs_input Detection

Triggers a `needs_input` result when Claude's output contains an explicit ask:

| Step | Trigger | Modes |
|---|---|---|
| A | `[NEEDS_INPUT]…[/NEEDS_INPUT]` block | all |
| B | Fenced JSON block with `question` key | implement/tests only |
| C | Inline JSON object with `question` key | implement/tests only |
| D | Heuristic: `NEEDS_INPUT` token + `question` word nearby | implement/tests only |
| E | `AskUserQuestion` tool in `permission_denials` | all |

Steps B/C/D are **suppressed in review mode** (`mode: "review"` or
`orchestratedLoop: true`) to prevent review commentary from being misclassified
as user-input requests.

## Review Gate

Applies to `mode: "review"` single-shot tasks:

- `[REVIEW_PASS]` in output → `review_pass`
- `[REVIEW_FAIL severity=…]…[/REVIEW_FAIL]` → `review_fail` with
  `meta.reviewSeverity` and `meta.reviewFindings`
- Neither marker → `review_fail` (conservative default)
- `completed` status is **blocked** for review mode (hard safety gate)

Structured findings are parsed from `[REVIEW_FINDINGS_JSON]…[/REVIEW_FINDINGS_JSON]`
and hoisted to `meta.structuredFindings` + top-level `structuredFindings`.

## Review Loop (`reviewLoop: true`, `mode: "review"`)

```
iter 1:  review  (fresh Claude session)
           ├─ PASS → review_pass (terminal)
           └─ FAIL → emit review_loop_fail event
                   → patch (fresh Claude session, with findings in prompt)
iter 2:  re-review  (fresh Claude session, + git diff snippet)
           ├─ PASS → review_pass (terminal)
           └─ FAIL → if iter < maxReviewIterations: patch → re-review
                   → if iter == maxReviewIterations: escalated (terminal)
```

**Context isolation:** Each step spawns a new `claude` process. No session
state is carried between steps.

**Events:**
- `progress/orchestrate` — phase announcement before each step
- `review_loop_fail/report` — after each failed review iteration (not the last)
- `review_pass/report` or `escalated/report` — terminal

**Terminal statuses:** `review_pass`, `escalated`

## Orchestrated Loop (`orchestratedLoop: true`)

```
step 0:  context_reset event (phase=implement)
         implement  (fresh Claude session)
           └─ non-completed → escalated (terminal, orchestratePhase=implement)

iter 1:  context_reset event (phase=review)
         review  (fresh Claude session, mode forced to "review")
           ├─ PASS → review_pass (terminal)
           └─ FAIL → emit review_loop_fail event
                   → if iter < maxReviewIterations:
                       context_reset event (phase=patch)
                       patch  (fresh Claude session, findings in prompt)
                   → re-review at iter+1

iter N (== maxReviewIterations):
         review → FAIL → escalated (terminal)
```

**Context isolation:** Every Claude invocation is a fresh subprocess. The
`context_reset` event (status `context_reset`, phase `orchestrate`) is emitted
before each new session with:

```jsonc
{
  "phase":        "implement" | "review" | "patch",
  "iteration":    0..N,
  "maxIter":      N,
  "contextReset": true
}
```

**Events:**
- `context_reset/orchestrate` — before each new Claude session
- `progress/orchestrate` — phase announcement after context_reset
- `review_loop_fail/report` — after each non-final failed review (with `structuredFindings`)
- `review_pass/report` or `escalated/report` — terminal

**Terminal statuses:** `review_pass`, `escalated`

## Task Flags Reference

| Flag | Required | Description |
|---|---|---|
| `mode` | yes | `dry_run` / `implement` / `review` / `tests` |
| `scope.repoPath` | yes (non-dry_run) | Absolute path, must be in `ALLOWED_REPOS` |
| `scope.branch` | yes (non-dry_run) | Must match `(agent\|hotfix\|feature\|bugfix)/…`; not `main`/`master` |
| `model` | no | `sonnet` (default) or `opus` |
| `reviewLoop` | no | Enable review-patch loop (mode `review` only) |
| `orchestratedLoop` | no | Enable full impl→review loop (mode `implement` or `review`) |
| `maxReviewIterations` | no | Override max loop iterations (default: `REVIEW_MAX_ITERATIONS` env, default 3) |
| `patchInstructions` | no | Custom instructions for patch Claude sessions |
| `pendingAnswer` | no | User's answer to a previous `needs_input`; triggers resume path |
| `previousReviewFindings` | no | Injected into prompt as `## Review Findings` section |

## DoD Checklist

- [ ] Review tasks never result in `needs_input` unless an explicit
      `[NEEDS_INPUT]` marker or `AskUserQuestion` is present.
- [ ] Review tasks never result in `completed`; gate enforced with hard fallback.
- [ ] All loop tasks terminate with `review_pass` or `escalated`.
- [ ] Each Claude session is a fresh subprocess; no context carryover between steps.
- [ ] `context_reset` events emitted for every new Claude session in loops.
- [ ] `review_loop_fail` events carry `structuredFindings` when present.
- [ ] Backward compatibility: existing single-shot and `reviewLoop` tasks unaffected.
