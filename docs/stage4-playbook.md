# Stage 4 Playbook — Telegram UX: Message Formats & Quick-Reply Proposal

Stage 4 defines the **Telegram user experience layer**: the exact message formats for each review-related status, proof-based `meta` fields that make status deterministic, and a proposal for quick-reply inline keyboard buttons.

---

## Goals

1. Deliver clear, actionable Telegram notifications for every review lifecycle status.
2. Ensure every status message carries enough `meta` proof to diagnose it without log access.
3. Propose (but not yet implement) quick-reply inline keyboard buttons for interactive statuses.

---

## 1. Status-to-Message Format Reference

All messages use Telegram HTML parse mode. Placeholders in `<angle brackets>` are filled from the event payload.

### `needs_input` — Нужен ответ

Triggered when Claude pauses to ask the user a question.

```
🙋 [needs_input/claude] <taskId>
<question>
<options block — see below>
<workerId>
```

**Options block** (when `meta.options` is present):
```
Варианты:
  1. <option[0]>
  2. <option[1]>
  ...
```

**Full example:**
```
🙋 [needs_input/claude] task-abc123
Which database engine should I use for persistent storage?
Варианты:
  1. PostgreSQL
  2. SQLite
  3. MongoDB
sigma-macbook
```

**Required `meta` fields:**

| Field | Type | Required | Description |
|---|---|---|---|
| `question` | string | yes | The question Claude is asking |
| `options` | string[] \| null | no | Normalized answer choices |
| `context` | string \| null | no | Additional context for the question |
| `needsInputAt` | string (ISO-8601) | yes | When needs_input was detected |

---

### `review_fail` — Review не прошёл

Triggered when a single-shot `review` mode task emits `[REVIEW_FAIL]`.

```
🔴 [review_fail/report] <taskId>
Review не прошёл (<severity>)
<plain-text summary — first 200 chars>
Findings: <N> issue(s)
duration: <durationMs/1000>s
<workerId>
```

**Full example:**
```
🔴 [review_fail/report] task-abc123
Review не прошёл (critical)
SQL injection via string concatenation in auth/login.js
Findings: 2 issue(s)
duration: 18.4s
sigma-macbook
```

**Required `meta` fields:**

| Field | Type | Required | Description |
|---|---|---|---|
| `severity` | string | yes | Highest severity: `critical`, `major`, or `minor` |
| `findings` | string | yes | Plain-text summary (first 200 chars shown) |
| `findingsCount` | number | yes | Number of structured findings |
| `structuredFindings` | object[] | yes | Full findings array (see `FINDINGS_SCHEMA.md`) |
| `durationMs` | number | yes | Total duration of the review run |
| `exitCode` | number | yes | Claude CLI exit code |

---

### `review_loop_fail` — Нужен patch (intermediate loop failure)

Triggered on each intermediate iteration failure inside a `reviewLoop: true` run.

```
🔁 [review_loop_fail/report] <taskId>
Нужен patch (iter <reviewIteration>/<maxReviewIterations>, <severity>)
<plain-text summary — first 200 chars>
Findings: <N> issue(s)
<workerId>
```

**Full example:**
```
🔁 [review_loop_fail/report] task-abc123
Нужен patch (iter 1/3, major)
Missing null check in user handler causes crash on empty payload
Findings: 1 issue(s)
sigma-macbook
```

**Required `meta` fields:**

| Field | Type | Required | Description |
|---|---|---|---|
| `severity` | string | yes | Highest severity of this iteration's findings |
| `findings` | string | yes | Plain-text summary |
| `findingsCount` | number | yes | Number of findings |
| `structuredFindings` | object[] | yes | Full findings array |
| `reviewIteration` | number | yes | Current iteration number (1-based) |
| `maxReviewIterations` | number | yes | Max configured iterations |

---

### `review_pass` — Review pass

Triggered when a review (single-shot or loop) emits `[REVIEW_PASS]`.

```
✅ [review_pass/report] <taskId>
Review pass
<optional: iter <reviewIteration>/<maxReviewIterations> — only in loop mode>
duration: <durationMs/1000>s
<workerId>
```

**Loop mode example (iter 2/3):**
```
✅ [review_pass/report] task-abc123
Review pass (iter 2/3)
duration: 42.1s
sigma-macbook
```

**Single-shot example:**
```
✅ [review_pass/report] task-abc123
Review pass
duration: 19.8s
sigma-macbook
```

**Required `meta` fields:**

| Field | Type | Required | Description |
|---|---|---|---|
| `durationMs` | number | yes | Duration of the passing review run |
| `exitCode` | number | yes | Claude CLI exit code (should be 0) |
| `reviewIteration` | number | no | Present only for loop-mode tasks |
| `maxReviewIterations` | number | no | Present only for loop-mode tasks |

---

### `escalated` — Loop exhausted without pass

Triggered when `maxReviewIterations` is reached without a `review_pass`.

```
⛔ [escalated/report] <taskId>
Review loop escalated (<N>/<M> iterations)
<escalationReason>
Findings: <N> issue(s)
<workerId>
```

**Full example:**
```
⛔ [escalated/report] task-abc123
Review loop escalated (3/3 iterations)
max review iterations (3) reached
Findings: 2 issue(s)
sigma-macbook
```

**Required `meta` fields:**

| Field | Type | Required | Description |
|---|---|---|---|
| `escalationReason` | string | yes | Human-readable reason for escalation |
| `reviewIteration` | number | yes | Final iteration reached |
| `maxReviewIterations` | number | yes | Configured max |
| `findingsCount` | number | yes | Number of outstanding findings |
| `structuredFindings` | object[] | yes | Full findings array from last failed review |

---

## 2. Full Status-to-Emoji-and-Label Table

| Status | Emoji | Russian label | When |
|---|---|---|---|
| `claimed` | 📥 | — | Task received from queue |
| `started` | 🚀 | — | Validation begins |
| `progress` | ⚙ | — | Intermediate step |
| `needs_input` | 🙋 | Нужен ответ | Claude is waiting for user decision |
| `review_pass` | ✅ | Review pass | Review accepted |
| `review_fail` | 🔴 | Review не прошёл | Single-shot review failed |
| `review_loop_fail` | 🔁 | Нужен patch | Intermediate loop failure; patch will follow |
| `escalated` | ⛔ | Escalated | Loop exhausted; manual intervention needed |
| `completed` | ✅ | — | Task completed successfully |
| `failed` | ❌ | — | Task failed |
| `timeout` | ⏰ | — | Claude CLI timed out |
| `rejected` | 🚫 | — | Task failed validation |

---

## 3. Proof-Based `meta` Fields Policy

Every status event must carry enough `meta` to answer the question "how do I know this status is correct?" without reading logs.

### Proof requirements by status

| Status | Minimum proof fields |
|---|---|
| `needs_input` | `question`, `needsInputAt` |
| `review_fail` | `severity`, `findings`, `findingsCount`, `structuredFindings`, `durationMs`, `exitCode` |
| `review_loop_fail` | `severity`, `findings`, `findingsCount`, `structuredFindings`, `reviewIteration`, `maxReviewIterations` |
| `review_pass` | `durationMs`, `exitCode` |
| `escalated` | `escalationReason`, `reviewIteration`, `maxReviewIterations`, `findingsCount`, `structuredFindings` |
| `completed` | `durationMs`, `exitCode` |
| `failed` | `exitCode`, `command` |
| `timeout` | `timeoutMs`, `pid` |
| `rejected` | `errors` (string[]) |
| `progress/claude` | `pid` |
| `progress/git` | `path`, `branch` |

Missing a required proof field is a notifier formatting defect — the message should still send, but log a warning.

---

## 4. Quick-Reply Inline Keyboard Buttons (Proposal)

> **Status: proposal only.** These buttons are not yet implemented. This section defines the intended UX so orch-api and the Telegram bot can be updated in a future stage.

### `needs_input` — answer buttons

When `meta.options` is present and has ≤ 4 choices, the notifier should attach an inline keyboard:

```
[ Option 1 ]  [ Option 2 ]
[ Option 3 ]  [ Option 4 ]
```

Button callback data format:
```
resume:<taskId>:<urlencoded-option-value>
```

Example for a 3-option question:
```
[ PostgreSQL ]  [ SQLite ]  [ MongoDB ]
```

Callback data examples:
```
resume:task-abc123:PostgreSQL
resume:task-abc123:SQLite
resume:task-abc123:MongoDB
```

When `meta.options` is absent or has > 4 choices, no inline keyboard is attached — the user must reply via text.

---

### `review_fail` / `escalated` — action buttons

For `review_fail` (single-shot) and `escalated`, propose two buttons:

```
[ 🔍 View findings ]  [ 🔄 Retry ]
```

| Button | Callback data | Action |
|---|---|---|
| View findings | `findings:<taskId>` | orch-api replies with a formatted findings summary message |
| Retry | `retry:<taskId>` | orch-api re-queues the task as a fresh `implement` run (resets iteration count) |

---

### `review_loop_fail` — informational only

For intermediate loop failures, no action buttons are needed — the loop automatically queues the patch. A single informational button may be added:

```
[ ⛔ Abort loop ]
```

Callback data: `abort:<taskId>` — orch-api cancels the task and marks it `failed`.

---

## 5. notifier.js Integration Notes

The current `notifier/notifier.js` does not handle `review_pass`, `review_fail`, `review_loop_fail`, or `escalated` — they fall through to the `❓` emoji. The following changes are needed (tracked separately from this doc):

1. Add emoji entries for the four new statuses to the `STATUS_EMOJI` map.
2. Add a `formatReviewEvent(event)` function that:
   - Extracts `meta.severity`, `meta.findings`, `meta.findingsCount` for fail events.
   - Extracts `meta.reviewIteration` / `meta.maxReviewIterations` for loop events.
   - Extracts `meta.escalationReason` for `escalated`.
3. For `needs_input`, format `meta.options` as a numbered list.
4. (Future) Attach inline keyboard markup when options ≤ 4.

---

## 6. Smoke Checklist (1-task verification)

Run this check after updating `notifier.js` with the new status formats:

```
[ ] 1. Trigger a needs_input task.
       Expected Telegram message: 🙋 [needs_input/claude] with question text and numbered options.
       meta.needsInputAt must be present in the event payload.

[ ] 2. Trigger a single-shot review_fail.
       Expected: 🔴 [review_fail/report] with severity label, findings summary, and count.
       meta.structuredFindings must be a non-empty array.

[ ] 3. Trigger a reviewLoop task that fails once then passes.
       Expected messages in order:
         🔁 [review_loop_fail/report] — with iter 1/N
         ✅ [review_pass/report] — with iter 2/N
       Both messages must arrive in the correct sequence without deduplication collision.

[ ] 4. Trigger a reviewLoop task that exhausts maxReviewIterations=2.
       Expected: ⛔ [escalated/report] with escalationReason and findingsCount.

[ ] 5. Check that a review_pass event for a single-shot task (no reviewIteration in meta)
       does NOT show an "iter N/M" line in the Telegram message.
```
