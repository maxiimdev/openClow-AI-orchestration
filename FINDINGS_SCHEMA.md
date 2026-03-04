# Findings Schema (Stage 2.2)

Structured findings are emitted by `review` mode Claude runs. They provide machine-readable, per-issue detail for the patch loop so each finding can be addressed precisely.

---

## Overview

When Claude performs a code review and identifies issues, it should emit two coordinated markers:

1. `[REVIEW_FAIL severity=<sev>]...[/REVIEW_FAIL]` — the existing verdict marker with a plain-text summary
2. `[REVIEW_FINDINGS_JSON]...[/REVIEW_FINDINGS_JSON]` — a JSON array of structured findings (nested inside or alongside the REVIEW_FAIL block)

The worker parses the JSON block and normalizes it into `structuredFindings`. If the JSON block is absent or unparseable, the worker falls back to the plain-text `findings` string.

---

## Finding Object Schema

Each element of the `structuredFindings` array has the following shape:

```json
{
  "id": "F1",
  "severity": "critical",
  "file": "src/auth/login.js",
  "issue": "SQL injection via string concatenation in WHERE clause",
  "risk": "Full database compromise; attacker can exfiltrate or destroy all data",
  "required_fix": "Replace string concatenation with parameterized queries using `?` placeholders",
  "acceptance_check": "No string concatenation in SQL queries; grep for 'query +' returns 0 results"
}
```

| Field | Type | Required | Values | Description |
|---|---|---|---|---|
| `id` | string | yes | e.g. `"F1"`, `"SEC-01"` | Unique finding identifier within this review run |
| `severity` | string | yes | `"critical"`, `"major"`, `"minor"` | Issue severity. Invalid values are normalized to `"major"`. |
| `file` | string | yes | e.g. `"src/auth/login.js"` | Relative file path containing the issue |
| `issue` | string | yes | — | One-sentence description of the problem |
| `risk` | string | yes | — | Impact if the issue is left unresolved |
| `required_fix` | string | yes | — | Specific change required to resolve the finding |
| `acceptance_check` | string | yes | — | Verifiable condition that proves the fix was applied |

Findings without an `issue` field are discarded during parsing.

---

## Severity Levels

| Severity | Meaning | Loop policy |
|---|---|---|
| `critical` | Security vulnerability or data-loss risk | Must be fixed; loop continues |
| `major` | Functional bug, significant risk, or code correctness issue | Must be fixed; loop continues |
| `minor` | Style, naming, or low-risk improvement | Should be fixed; loop continues |

All severities cause a `review_fail` / `review_loop_fail` result. The loop policy is the same for all levels — the distinction is informational for the orchestrator and developer.

---

## Claude Output Format

When writing a review prompt, instruct Claude to produce:

```
[REVIEW_FAIL severity=critical]
<brief plain-text summary of all findings>
[REVIEW_FINDINGS_JSON]
[
  {
    "id": "F1",
    "severity": "critical",
    "file": "<file>",
    "issue": "<one-sentence issue>",
    "risk": "<impact>",
    "required_fix": "<what to change>",
    "acceptance_check": "<how to verify>"
  }
]
[/REVIEW_FINDINGS_JSON]
[/REVIEW_FAIL]
```

Or if all is well:

```
[REVIEW_PASS]
<brief summary of what was checked and confirmed correct>
```

---

## Propagation to Patch Runs

When a review fails in the loop, the worker serializes `structuredFindings` (as JSON) or falls back to plain-text `reviewFindings`, and injects it as `## Review Findings` in the patch prompt:

```
## Review Findings

The previous review identified the following issues that must be addressed:
[
  {
    "id": "F1",
    "severity": "critical",
    "file": "src/auth/login.js",
    ...
  }
]
```

The patch Claude instance receives each finding with full context — file, issue, risk, required fix, and acceptance check — enabling precise, targeted remediation.

---

## Loop Policy

| Condition | Result |
|---|---|
| Review passes on iteration 1 | `review_pass`, `reviewIteration=1` |
| Review fails on iteration 1, passes on iteration 2 (after patch) | `review_pass`, `reviewIteration=2` |
| Review fails on all iterations up to `maxReviewIterations` | `escalated`, `escalationReason="max review iterations (N) reached"` |
| Patch subprocess fails during loop | `escalated`, `escalationReason="patch run <status> at iteration N"` |

Default `maxReviewIterations` is `3` (configurable via `REVIEW_MAX_ITERATIONS` env or `task.maxReviewIterations`).

---

## Where structuredFindings Appears

| Location | When | Notes |
|---|---|---|
| `meta.structuredFindings` | `review_fail` (single-shot) | From last failed single-shot review |
| `meta.structuredFindings` | `escalated` (loop) | From last failed review in the loop |
| `meta.structuredFindings` | `review_loop_fail` event | From each intermediate loop iteration |
| Top-level `structuredFindings` | `review_fail` result body | Hoisted for direct orchestrator access |
| Top-level `structuredFindings` | `escalated` result body | Hoisted for direct orchestrator access |

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `REVIEW_MAX_ITERATIONS` | `3` | Default max review loop iterations when not set on the task |
