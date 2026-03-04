# Interactive Flow: needs_input / resume

## Overview

When Claude encounters a decision point during task execution, it can pause and ask the user a question. The worker detects this, reports `needs_input` to the orchestrator, and the task waits until the user provides an answer via `POST /api/task/resume`. The task is then re-queued with the answer injected into the prompt.

## Lifecycle

```
Worker spawns Claude CLI
         │
         ▼
Claude runs, outputs question
(via [NEEDS_INPUT] markers, JSON, or AskUserQuestion tool)
         │
         ▼
Worker: parseNeedsInput(stdout)
  → extracts question, options, context
  → sets result.status = "needs_input"
         │
         ▼
Worker sends:
  event:  { status: "needs_input", phase: "claude", meta: { question, options, ... } }
  result: { status: "needs_input", meta: { question, options, ... } }
         │
         ▼
Orch-api saves question/options to task
  → task.status = "needs_input"
  → notifies Telegram with the question
         │
         ▼
 ┌───────────────────────────────────┐
 │  Task is paused. Worker moves on. │
 │  Task NOT returned by future      │
 │  /api/worker/pull calls.          │
 └───────────────────────────────────┘
         │
    User sees question in Telegram
    User replies (or calls API)
         │
         ▼
POST /api/task/resume { taskId, answer, answeredBy }
         │
         ▼
Orch-api:
  → validates task.status === "needs_input"
  → saves task.pendingAnswer = answer
  → sets task.status = "queued"
  → appends event: { status: "resumed", phase: "report" }
         │
         ▼
Worker polls, receives task (with pendingAnswer + question)
         │
         ▼
Worker builds continuation prompt:
  ## Continuation — User Answer
  Previous question: <question>
  Answer: <pendingAnswer>
  Continue the task using the answer above.
         │
         ▼
Worker spawns Claude CLI again with full prompt
  → Normal completion path (completed/failed/timeout/needs_input again)
```

## POST /api/task/resume

### Request

```
POST /api/task/resume
Authorization: Bearer <ORCH_API_TOKEN>
Content-Type: application/json
```

```json
{
  "taskId": "abc-123",
  "answer": "Use PostgreSQL",
  "answeredBy": "sigma"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `taskId` | string | yes | Task to resume |
| `answer` | string | yes | User's answer to Claude's question |
| `answeredBy` | string | no | Who provided the answer |

### Responses

| HTTP | Body | Condition |
|---|---|---|
| 200 | `{ "ok": true, "taskId": "abc-123", "status": "queued" }` | Task re-queued |
| 400 | `{ "error": "taskId and answer are required" }` | Missing fields |
| 404 | `{ "error": "task not found" }` | No task with that ID |
| 409 | `{ "error": "task is in status 'completed', expected 'needs_input'" }` | Wrong status |

### Example curl

```bash
curl -X POST https://orchestrator.example.com/api/task/resume \
  -H "Authorization: Bearer $ORCH_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "taskId": "abc-123",
    "answer": "Use PostgreSQL",
    "answeredBy": "sigma"
  }'
```

## How the Worker Detects needs_input

The `parseNeedsInput(stdout)` function runs a 5-step pipeline on Claude's output, returning on first match:

| Step | Name | Source marker | sourceType |
|---|---|---|---|
| A | Strict marker | `[NEEDS_INPUT]...[/NEEDS_INPUT]` block with `question:`, `options:`, `context:` | `strict` |
| B | Fenced JSON | ` ```json { "question": "..." } ``` ` | `fenced` |
| C | Plain JSON | Bare `{ "question": "..." }` in output (scans up to 50KB) | `json` |
| D | Heuristic | Text containing both `NEEDS_INPUT` and `question` keywords | `heuristic` |
| E | AskUserQuestion | JSONL `permission_denials` with `tool_name === "AskUserQuestion"` | `ask_user_question` |

### Strict Marker Format (Step A)

Claude can output this block to explicitly pause:

```
[NEEDS_INPUT]
question: Which authentication method should I use?
options: OAuth 2.0, JWT, API Key
context: The app currently has no auth
[/NEEDS_INPUT]
```

### Option Normalization

Options are normalized from multiple formats:
- Array of strings → kept as-is
- Object `{ "A": "desc1", "B": "desc2" }` → `["A: desc1", "B: desc2"]`
- Comma-separated string → split into array
- Empty/null → `null`

## Task Object Fields (on orch-api)

These fields are added/updated during the interactive flow:

| Field | Set when | Cleared when |
|---|---|---|
| `task.question` | `needs_input` result received | — |
| `task.options` | `needs_input` result received | — |
| `task.pendingAnswer` | `POST /api/task/resume` | After delivery to worker via pull |
| `task.needsInputAt` | `needs_input` result received | — |

## Continuation Prompt

When the worker receives a task with `pendingAnswer`, it appends this section to the prompt:

```markdown
## Continuation — User Answer
Previous question: Which authentication method should I use?
Answer: Use OAuth 2.0

Continue the task using the answer above. Pick up where you left off.
```

Claude receives the full original task prompt plus this continuation, providing context to resume work.

## Multiple Rounds

A task can go through multiple `needs_input` → `resume` cycles. Each round:
1. Claude asks a new question
2. Worker detects it, reports `needs_input`
3. User answers via `/api/task/resume`
4. Worker receives task again, builds new continuation prompt
5. Claude runs again — may complete, fail, or ask another question

## Debugging

Set `NEEDS_INPUT_DEBUG=true` in `.env` to enable verbose `[ni]` prefixed logs showing:
- Which parser step matched
- Extracted question/options/context
- `hasPermissionDenials` and `hasAskUserQuestion` flags
- Whether the safety gate was triggered
