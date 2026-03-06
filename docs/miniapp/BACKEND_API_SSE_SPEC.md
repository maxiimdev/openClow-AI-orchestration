# Mini App — Backend API & SSE Contract

Base path: `/api/v1/miniapp`

All endpoints require `Authorization: Bearer <jwt_token>` except `POST /auth/telegram`.

## Endpoints

### POST /auth/telegram
Authenticate via Telegram Mini App initData.
```
Request:  { "initData": "<telegram_init_data_string>" }
Response: { "token": "<jwt>", "user": { "id": number, "firstName": string, "username": string } }
Error:    { "error": "invalid_init_data" } (401)
```

### GET /tasks
List tasks for authenticated user.
```
Query: ?status=running,needs_input&limit=50&offset=0
Response: {
  "tasks": [
    {
      "id": "task-abc",
      "mode": "implement",
      "status": "running",         // user-facing mapped status
      "internalStatus": "progress", // raw worker status
      "branch": "feature/auth",
      "repoPath": "/path/to/repo",
      "createdAt": "ISO-8601",
      "updatedAt": "ISO-8601",
      "message": "latest event message",
      "meta": {}
    }
  ],
  "total": 42
}
```

### GET /tasks/:id
Single task details.
```
Response: {
  "id": "task-abc",
  "mode": "implement",
  "status": "running",
  "internalStatus": "progress",
  "branch": "feature/auth",
  "repoPath": "/path/to/repo",
  "instructions": "...",
  "createdAt": "ISO-8601",
  "updatedAt": "ISO-8601",
  "message": "...",
  "meta": {},
  "question": null | string,
  "options": null | string[],
  "needsInputAt": null | "ISO-8601",
  "reviewFindings": null | string,
  "structuredFindings": null | Finding[],
  "result": null | { stdout, stderr, truncated, exitCode, durationMs }
}
```

### GET /tasks/:id/events
Event timeline for a task.
```
Query: ?limit=100&before=<event_id>
Response: {
  "events": [
    {
      "id": "evt-001",
      "taskId": "task-abc",
      "status": "progress",
      "phase": "claude",
      "message": "Claude subprocess spawned",
      "meta": { "stepIndex": 2, "stepTotal": 4 },
      "createdAt": "ISO-8601"
    }
  ]
}
```

### POST /tasks/:id/resume
Answer a needs_input question.
```
Request:  { "answer": "PostgreSQL" }
Response: { "ok": true, "task": { ...updated task } }
Error:    { "error": "task_not_awaiting_input" } (409)
```

### POST /tasks/:id/retry (feature-flagged)
Re-queue a failed/escalated task.
```
Request:  {}
Response: { "ok": true, "task": { ...re-queued task } }
```

### POST /tasks/:id/cancel (feature-flagged)
Cancel a running task.
```
Request:  {}
Response: { "ok": true, "task": { ...cancelled task } }
```

### GET /stream
Server-Sent Events stream for realtime updates.

**Headers**: `Authorization: Bearer <jwt>`, `Last-Event-ID: <id>` (optional)

**Event format**:
```
id: evt-123
event: task_update
data: {"taskId":"task-abc","status":"progress","phase":"claude","message":"...","meta":{},"updatedAt":"ISO-8601"}

id: evt-124
event: heartbeat
data: {"ts":"ISO-8601"}

id: evt-125
event: reset_required
data: {"reason":"server_restart"}
```

**Behaviors**:
- Heartbeat every 30s
- `Last-Event-ID` → replay missed events since that ID
- `reset_required` → client must invalidate all caches and refetch
- Connection drops → client reconnects with exponential backoff

## User-Facing Status Mapping

| Worker Status | User Status | Category |
|---|---|---|
| `claimed`, `started`, `progress`, `keepalive` | `running` | active |
| `completed` | `completed` | final |
| `failed`, `timeout`, `rejected` | `failed` | final |
| `needs_input` | `needs_input` | blocked |
| `review_pass` | `review_pass` | final |
| `review_fail` | `review_fail` | final |
| `review_loop_fail` | `running` | active (intermediate) |
| `escalated` | `escalated` | final |
| `context_reset` | `running` | active (internal) |
| `risk` | `at_risk` | active |

## Finding Schema
```typescript
interface Finding {
  id: string        // "F1", "F2", ...
  severity: "critical" | "major" | "minor"
  file: string
  issue: string
  risk: string
  required_fix: string
  acceptance_check: string
}
```
