# Event Contract

## POST /api/worker/event

Lifecycle events sent by the worker to the orchestrator at each stage of task execution. Events are **fire-and-forget** — a failed POST logs a warning but never breaks the main flow.

### Request

```
POST /api/worker/event
Authorization: Bearer <WORKER_TOKEN>
Content-Type: application/json
```

```json
{
  "workerId": "string",
  "taskId": "string",
  "status": "string",
  "phase": "string",
  "message": "string",
  "meta": {}
}
```

### Fields

| Field | Type | Required | Constraints | Description |
|---|---|---|---|---|
| `workerId` | string | yes | — | Worker identifier (from `WORKER_ID` env) |
| `taskId` | string | yes | — | Task being processed |
| `status` | string | yes | See table below | Current lifecycle status |
| `phase` | string | yes | See table below | Execution phase |
| `message` | string | no | Max 1000 chars | Human-readable description |
| `meta` | object | no | — | Arbitrary metadata (see examples) |

### Response

```json
{ "ok": true }
```

The server should add its own `serverTs` timestamp on receipt.

---

## Statuses

| Status | Meaning |
|---|---|
| `claimed` | Task received from pull queue |
| `started` | About to validate task |
| `progress` | Intermediate step in progress |
| `needs_input` | Claude asked a question; waiting for user answer |
| `resumed` | User answered; task re-queued (written by orch-api, not worker) |
| `completed` | Task finished successfully |
| `failed` | Task failed (non-zero exit, spawn error, or JS exception) |
| `timeout` | Claude CLI exceeded `CLAUDE_TIMEOUT_MS` |
| `rejected` | Task failed validation |

## Phases

| Phase | Meaning |
|---|---|
| `pull` | Task pulled from queue |
| `validate` | Task validation |
| `git` | Git checkout operation |
| `claude` | Claude CLI execution |
| `push` | Git push (reserved, not currently used) |
| `pr` | PR creation (reserved, not currently used) |
| `report` | Final result reporting |
| `other` | Catch-all (unexpected errors) |

---

## Status/Phase Matrix

Every event the worker sends, in order of occurrence:

| Trigger | Status | Phase | Message |
|---|---|---|---|
| Task received from pull | `claimed` | `pull` | `"task received"` |
| Task resumed with answer | `progress` | `report` | `"task resumed with user input"` |
| Before validation | `started` | `validate` | `"validating task"` |
| Validation failed | `rejected` | `validate` | Validation error details |
| Before git checkout | `progress` | `git` | `"checking out branch <branch>"` |
| Before spawning Claude | `progress` | `claude` | `"spawning claude CLI"` |
| Claude needs input | `needs_input` | `claude` | `"needs input: <question>"` |
| Claude completed | `completed` | `report` | `"task completed"` |
| Claude failed | `failed` | `report` | `"task failed"` |
| Claude timed out | `timeout` | `claude` | `"claude process timed out"` |
| JS exception in loop | `failed` | `other` | Error message |
| User answered (orch-api) | `resumed` | `report` | `"resumed by <who>: <answer>"` |

---

## Proof-Based Status Guidance (`meta.proof`)

Use `meta` to provide diagnostic proof for status determination. Recommended patterns:

| Status | Proof fields | Example |
|---|---|---|
| `progress/claude` | `pid` | `{ "pid": 12345 }` |
| `progress/git` | `path`, `branch` | `{ "path": "/repo", "branch": "agent/fix" }` |
| `completed` | `durationMs`, `exitCode` | `{ "durationMs": 30000, "exitCode": 0 }` |
| `failed` | `exitCode`, `command` | `{ "exitCode": 1, "command": "claude" }` |
| `timeout` | `timeoutMs`, `pid` | `{ "timeoutMs": 180000, "pid": 12345 }` |
| `rejected` | `errors` | `{ "errors": ["repoPath not in allowlist"] }` |
| `needs_input` | `question`, `options`, `context`, `needsInputAt` | See below |
| `resumed` | `answeredBy` | `{ "answeredBy": "sigma" }` |

---

## `needs_input` Meta Fields

When `status: "needs_input"`, the `meta` object includes:

```json
{
  "question": "Which authentication method should I use?",
  "options": ["OAuth 2.0", "JWT", "API Key"],
  "context": "The app currently has no auth setup",
  "needsInputAt": "2026-03-03T12:05:00.000Z"
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `question` | string | yes | The question Claude is asking |
| `options` | string[] or null | no | Answer choices (normalized from various formats) |
| `context` | string or null | no | Additional context for the question |
| `needsInputAt` | string | yes | ISO-8601 timestamp when needs_input was detected |

---

## Payload Examples

### claimed/pull

```json
{
  "workerId": "sigma-macbook",
  "taskId": "abc-123",
  "status": "claimed",
  "phase": "pull",
  "message": "task received",
  "meta": {}
}
```

### progress/claude

```json
{
  "workerId": "sigma-macbook",
  "taskId": "abc-123",
  "status": "progress",
  "phase": "claude",
  "message": "spawning claude CLI",
  "meta": {}
}
```

### needs_input/claude

```json
{
  "workerId": "sigma-macbook",
  "taskId": "abc-123",
  "status": "needs_input",
  "phase": "claude",
  "message": "needs input: Which database should I use?",
  "meta": {
    "question": "Which database should I use?",
    "options": ["PostgreSQL", "SQLite", "MongoDB"],
    "context": "The project needs persistent storage for user data",
    "needsInputAt": "2026-03-03T12:05:00.000Z"
  }
}
```

### completed/report

```json
{
  "workerId": "sigma-macbook",
  "taskId": "abc-123",
  "status": "completed",
  "phase": "report",
  "message": "task completed",
  "meta": {
    "durationMs": 30000,
    "exitCode": 0
  }
}
```

### failed/other

```json
{
  "workerId": "sigma-macbook",
  "taskId": "abc-123",
  "status": "failed",
  "phase": "other",
  "message": "TypeError: Cannot read properties of undefined",
  "meta": {}
}
```

### timeout/claude

```json
{
  "workerId": "sigma-macbook",
  "taskId": "abc-123",
  "status": "timeout",
  "phase": "claude",
  "message": "claude process timed out",
  "meta": {
    "timeoutMs": 180000
  }
}
```

---

## Example curl

```bash
curl -X POST https://orchestrator.example.com/api/worker/event \
  -H "Authorization: Bearer $WORKER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "workerId": "sigma-macbook",
    "taskId": "abc-123",
    "status": "progress",
    "phase": "claude",
    "message": "spawning claude CLI",
    "meta": {}
  }'
```

## Server-Side Expectations

The orchestrator should:

1. Append the event to `task.events[]`
2. Add a `serverTs` timestamp
3. Forward the event to the notifier for Telegram delivery
4. Return `{ "ok": true }`
