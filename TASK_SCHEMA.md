# Task Schema

Full task object schema, pull/result API contracts, validation rules, and prompt structure.

---

## POST /api/worker/pull

The worker polls this endpoint to receive the next queued task.

### Request

```
POST /api/worker/pull
Authorization: Bearer <WORKER_TOKEN>
Content-Type: application/json
```

```json
{
  "workerId": "string"
}
```

### Responses

**No task available:**

```json
{ "ok": true }
```

**Task returned:**

```json
{
  "ok": true,
  "task": { ... }
}
```

**Error:**

```json
{ "ok": false, "error": "..." }
```

---

## Task Object

Fields the orchestrator must supply when returning a task from `/api/worker/pull`.

### Required Fields

| Field | Type | Description |
|---|---|---|
| `taskId` | string | Unique task identifier |
| `mode` | string | Execution mode — see [Modes](#modes) |

### Optional Fields

| Field | Type | Description |
|---|---|---|
| `model` | string | Model override: `"sonnet"` or `"opus"`. Defaults to `CLAUDE_MODEL` env (default: `"sonnet"`) |
| `scope` | object | `{ repoPath: string, branch: string }` — required for all modes except `dry_run` |
| `instructions` | string | Task prompt body |
| `constraints` | string[] | Constraint lines injected into the prompt |
| `contextSnippets` | object[] | Code/text snippets — see [Context Snippets](#context-snippets) |
| `previousReviewFindings` | string | Findings from a failed review (patch loop). Injected as `## Review Findings` in the prompt. May be structured JSON (from `[REVIEW_FINDINGS_JSON]` block) or plain text. |

### Review Loop Fields (Stage 2.2)

Set these on a `mode: "review"` task to enable the internal review-patch-review loop.

| Field | Type | Description |
|---|---|---|
| `reviewLoop` | boolean | If `true`, the worker handles the full review loop internally (default: `false` — single-shot review) |
| `maxReviewIterations` | number | Max review runs before escalation (default: `REVIEW_MAX_ITERATIONS` env, default `3`). Clamped to 1–10. |
| `patchInstructions` | string | Instructions for the internal patch run. Defaults to fixing all identified issues using the original `instructions` as context. |

### Resume Fields

These fields are set by the orchestrator after a `needs_input` → `resume` cycle. The worker uses them to build a continuation prompt.

| Field | Type | Description |
|---|---|---|
| `pendingAnswer` | string | User's answer to Claude's question |
| `question` | string | The question Claude asked (for continuation prompt context) |
| `options` | string[] or null | Answer choices (informational; already answered) |
| `needsInputAt` | string | ISO-8601 timestamp when `needs_input` was first set |

---

## Modes

| Mode | Description | `scope` required |
|---|---|---|
| `dry_run` | Echo the prompt without invoking Claude CLI | No |
| `implement` | Full implementation task | Yes |
| `review` | Code review | Yes |
| `tests` | Test writing | Yes |

An unknown mode is rejected at validation.

---

## Context Snippets

Each entry in `contextSnippets` is rendered as a fenced code block in the prompt:

| Field | Type | Required | Description |
|---|---|---|---|
| `content` | string | yes | Snippet body |
| `path` | string | no | File path label (takes priority over `label`) |
| `label` | string | no | Fallback label if `path` is absent |

If both `path` and `label` are absent, the label defaults to `"snippet"`.

---

## Validation Rules

The worker validates every task before execution. Failures produce a `rejected/validate` event and a `result` with `status: "rejected"`.

| Rule | Condition |
|---|---|
| `taskId` present | `task.taskId` must be non-empty |
| `mode` present | `task.mode` must be non-empty |
| `mode` valid | Must be one of: `dry_run`, `implement`, `review`, `tests` |
| `model` valid | If present, must be `"sonnet"` or `"opus"` |
| `scope` present | Required when `mode !== "dry_run"` |
| `repoPath` in allowlist | `task.scope.repoPath` (resolved) must match or be under a path in `ALLOWED_REPOS` |
| Branch pattern | `task.scope.branch` must match `^(agent\|hotfix\|feature\|bugfix)/[a-zA-Z0-9._-]+$` |
| Branch not blocked | `main` and `master` are always rejected |

---

## Generated Prompt Structure

The worker assembles this prompt from task fields before passing it to Claude CLI:

```
# Task <taskId> [<mode>]

Repo: <scope.repoPath>
Branch: <scope.branch>

## Instructions
<instructions>

## Constraints
- <constraints[0]>
- <constraints[1]>

## Context

### <contextSnippets[0].path or .label>
```
<contextSnippets[0].content>
```

## Continuation — User Answer
Previous question: <question>
Answer: <pendingAnswer>

Continue the task using the answer above. Pick up where you left off.
```

Sections that have no data are omitted. The `Continuation` section only appears when `pendingAnswer` is set.

---

## POST /api/worker/result

Sent by the worker after task execution completes (including `needs_input`, `rejected`, and `timeout` outcomes).

### Request

```
POST /api/worker/result
Authorization: Bearer <WORKER_TOKEN>
Content-Type: application/json
```

```json
{
  "workerId": "string",
  "taskId": "string",
  "status": "string",
  "mode": "string",
  "output": {
    "stdout": "string",
    "stderr": "string",
    "truncated": false
  },
  "meta": {
    "durationMs": 0,
    "repoPath": "string or null",
    "branch": "string or null",
    "exitCode": 0,
    "model": "string"
  }
}
```

### Fields

| Field | Type | Description |
|---|---|---|
| `workerId` | string | Worker identifier |
| `taskId` | string | Task being reported |
| `status` | string | Final task status — see table below |
| `mode` | string | Task mode (echoed from task) |
| `output.stdout` | string | Captured stdout (capped at 200KB; `[TRUNCATED]` appended if over) |
| `output.stderr` | string | Captured stderr (same cap) |
| `output.truncated` | bool | `true` if either stream was truncated |
| `meta.durationMs` | number | Wall time from task start to result post |
| `meta.repoPath` | string or null | Resolved repo path |
| `meta.branch` | string or null | Branch checked out |
| `meta.exitCode` | number or null | Claude CLI exit code (null for `dry_run`, timeout, spawn error) |
| `meta.model` | string | Model used (`sonnet` or `opus`) |

### Additional top-level fields for `needs_input`

When `status` is `needs_input`, the worker also adds these fields at the top level of the result body (in addition to the `meta.*` equivalents below) so the orchestrator can store `task.question` and `task.options` directly without digging into `meta`.

| Field | Type | Description |
|---|---|---|
| `question` | string | Claude's question (same as `meta.question`) |
| `options` | string[] or null | Normalized answer choices (same as `meta.options`) |
| `context` | string or null | Additional context (same as `meta.context`) |
| `needsInputAt` | string | ISO-8601 timestamp (same as `meta.needsInputAt`) |

### Additional `meta` fields for `needs_input`

| Field | Type | Description |
|---|---|---|
| `meta.question` | string | Claude's question |
| `meta.options` | string[] or null | Normalized answer choices |
| `meta.context` | string or null | Additional context |
| `meta.needsInputAt` | string | ISO-8601 timestamp |

### Statuses

| Status | Meaning |
|---|---|
| `completed` | Claude exited 0, no `needs_input` detected (not valid for `review` mode) |
| `needs_input` | Claude exited 0, `needs_input` detected in output |
| `review_pass` | `review` mode: Claude output contained `[REVIEW_PASS]` marker |
| `review_fail` | `review` mode (single-shot): Claude output contained `[REVIEW_FAIL]` marker, or no verdict marker found |
| `escalated` | `review` mode with `reviewLoop: true`: max iterations reached without passing |
| `failed` | Claude exited non-zero, or spawn error |
| `timeout` | Claude exceeded `CLAUDE_TIMEOUT_MS` |
| `rejected` | Task failed validation |

**Review gate enforcement**: For `mode=review` (single-shot), the worker never emits `completed`. It always parses the verdict and emits `review_pass` or `review_fail`. A hard safety gate (second check) ensures this.

**Review loop**: For `mode=review` with `reviewLoop: true`, the worker manages the full loop internally. The result is `review_pass` (passed within N iterations), `escalated` (max iterations exhausted), or `failed`/`timeout` if a subprocess failed catastrophically.

### Additional `meta` fields for `review_fail` (single-shot)

| Field | Type | Description |
|---|---|---|
| `meta.reviewVerdict` | string | `"fail"` |
| `meta.reviewSeverity` | string | Severity from `[REVIEW_FAIL severity=...]`, e.g. `"major"`, `"critical"`, `"unknown"` |
| `meta.reviewFindings` | string | Findings body from inside `[REVIEW_FAIL]...[/REVIEW_FAIL]` (max 2000 chars) |
| `meta.structuredFindings` | object[] or null | Parsed structured findings array (see [Findings Schema](#findings-schema-stage-22)) |

### Additional top-level fields for `review_fail` and `escalated`

Hoisted to top-level for direct orchestrator access (also present in `meta`):

| Field | Type | Description |
|---|---|---|
| `structuredFindings` | object[] or null | Parsed findings array (see [Findings Schema](#findings-schema-stage-22)) |
| `reviewFindings` | string or null | Plain-text findings (same as `meta.reviewFindings`) |

### Additional `meta` fields for `review_pass`

| Field | Type | Description |
|---|---|---|
| `meta.reviewVerdict` | string | `"pass"` |
| `meta.reviewIteration` | number | (loop only) Which iteration passed (1 = first try) |
| `meta.reviewMaxIterations` | number | (loop only) Max iterations configured |
| `meta.reviewLoopDurationMs` | number | (loop only) Total wall time for the entire loop |

### Additional `meta` fields for `escalated`

| Field | Type | Description |
|---|---|---|
| `meta.reviewVerdict` | string | `"fail"` |
| `meta.reviewSeverity` | string | Severity of the last failed review |
| `meta.reviewFindings` | string | Plain-text findings from the last failed review |
| `meta.structuredFindings` | object[] or null | Structured findings from the last failed review |
| `meta.reviewIteration` | number | Iteration count at escalation (equals `maxReviewIterations`) |
| `meta.reviewMaxIterations` | number | Max iterations that were configured |
| `meta.escalationReason` | string | Human-readable reason (e.g. `"max review iterations (3) reached without passing"`) |
| `meta.reviewLoopDurationMs` | number | Total wall time for the entire loop |

---

## Findings Schema (Stage 2.2)

When Claude's review output contains a `[REVIEW_FINDINGS_JSON]...[/REVIEW_FINDINGS_JSON]` block, the worker parses it into a structured array. This is set in `meta.structuredFindings` and hoisted to `structuredFindings` on `review_fail` and `escalated` results.

### Finding Object

| Field | Type | Values | Description |
|---|---|---|---|
| `id` | string | e.g. `"F1"`, `"F2"` | Unique finding identifier within this review |
| `severity` | string | `"critical"`, `"major"`, `"minor"` | Issue severity (invalid values normalized to `"major"`) |
| `file` | string | e.g. `"src/auth/login.js"` | File containing the issue |
| `issue` | string | — | Brief description of the issue |
| `risk` | string | — | Impact if left unresolved |
| `required_fix` | string | — | What change is required |
| `acceptance_check` | string | — | How to verify the fix was applied |

### Example

Claude review output:
```
[REVIEW_FAIL severity=critical]
Found critical security issues.
[REVIEW_FINDINGS_JSON]
[
  {
    "id": "F1",
    "severity": "critical",
    "file": "src/auth/login.js",
    "issue": "SQL injection via string concatenation",
    "risk": "Full database compromise",
    "required_fix": "Use parameterized queries for all SQL statements",
    "acceptance_check": "No string concatenation in SQL queries; all queries use placeholders"
  },
  {
    "id": "F2",
    "severity": "major",
    "file": "src/auth/auth.js",
    "issue": "Passwords stored as plain text",
    "risk": "Credential exposure if database is breached",
    "required_fix": "Hash passwords with bcrypt (min cost 10) before storage",
    "acceptance_check": "All stored password fields are bcrypt hashes"
  }
]
[/REVIEW_FINDINGS_JSON]
[/REVIEW_FAIL]
```

Parsed `structuredFindings`:
```json
[
  {
    "id": "F1",
    "severity": "critical",
    "file": "src/auth/login.js",
    "issue": "SQL injection via string concatenation",
    "risk": "Full database compromise",
    "required_fix": "Use parameterized queries for all SQL statements",
    "acceptance_check": "No string concatenation in SQL queries; all queries use placeholders"
  },
  {
    "id": "F2",
    "severity": "major",
    "file": "src/auth/auth.js",
    "issue": "Passwords stored as plain text",
    "risk": "Credential exposure if database is breached",
    "required_fix": "Hash passwords with bcrypt (min cost 10) before storage",
    "acceptance_check": "All stored password fields are bcrypt hashes"
  }
]
```

### Response

```json
{ "ok": true }
```

---

## Example: full task payload (implement with context)

```json
{
  "taskId": "auth-refactor-042",
  "mode": "implement",
  "model": "sonnet",
  "scope": {
    "repoPath": "/Users/sigma/MovieCenter",
    "branch": "agent/auth-refactor"
  },
  "instructions": "Refactor the auth module to use JWT instead of sessions.",
  "constraints": [
    "Do not modify the user model schema",
    "Keep backward compatibility with existing API responses"
  ],
  "contextSnippets": [
    {
      "path": "src/auth/session.js",
      "content": "// current session implementation..."
    }
  ]
}
```

## Example: review loop task payload (Stage 2.2)

```json
{
  "taskId": "auth-review-042",
  "mode": "review",
  "reviewLoop": true,
  "maxReviewIterations": 3,
  "scope": {
    "repoPath": "/Users/sigma/MovieCenter",
    "branch": "agent/auth-refactor"
  },
  "instructions": "Review the authentication implementation for security issues.",
  "patchInstructions": "Fix all security issues identified in the review findings. Original context: JWT-based auth refactor."
}
```

## Example: resumed task payload

```json
{
  "taskId": "auth-refactor-042",
  "mode": "implement",
  "scope": {
    "repoPath": "/Users/sigma/MovieCenter",
    "branch": "agent/auth-refactor"
  },
  "instructions": "Refactor the auth module to use JWT instead of sessions.",
  "question": "Which JWT library should I use?",
  "options": ["jsonwebtoken", "jose", "fast-jwt"],
  "pendingAnswer": "jsonwebtoken",
  "needsInputAt": "2026-03-04T10:30:00.000Z"
}
```
