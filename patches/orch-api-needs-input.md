# PATCH: needs_input / resume protocol in orch-api

Target: remote orch-api on VPS (server.js or equivalent)
Schema: worker ↔ orch-api ↔ user (Telegram / dashboard / curl)

## DATA_MODEL_CHANGES

Add to task object (in-memory store or DB):

```js
// New fields on task:
{
  question:      null,   // string|null — question from Claude/worker
  options:       null,   // string[]|null — suggested answer options
  pendingAnswer: null,   // string|null — answer from user, consumed by worker on next pull
  needsInputAt:  null,   // ISO string|null — when needs_input was set
}
```

## CHANGES TO EXISTING ENDPOINTS

### POST /api/worker/result — accept `needs_input` status

In the result handler, add `needs_input` to allowed statuses:

```js
// BEFORE:
const VALID_STATUSES = ["completed", "failed", "timeout", "rejected"];

// AFTER:
const VALID_STATUSES = ["completed", "failed", "timeout", "rejected", "needs_input"];
```

When status is `needs_input`, save question/options/context from `result.meta`:

```js
if (result.status === "needs_input") {
  task.status = "needs_input";
  task.question = result.meta.question || null;
  task.options = result.meta.options || null;
  task.needsInputAt = result.meta.needsInputAt || new Date().toISOString();
  // Do NOT set task.pendingAnswer here — that comes from /resume
}
```

### POST /api/worker/event — accept `needs_input` status

No logic change needed — events are fire-and-forget storage.
Just ensure the event is saved to `task.events[]` as usual.

If Telegram notify is enabled, the `needs_input/claude` event will be forwarded
to Telegram automatically (shows the question to the user).

### POST /api/worker/pull — include pendingAnswer fields

When returning a task to the worker, include the new fields if present:

```js
// In the pull handler, when selecting a task to return:
// If task.status === "queued" and task.pendingAnswer is set,
// the worker will detect it as a resumed task.

// The task object returned should include:
{
  taskId: task.taskId,
  mode: task.mode,
  scope: task.scope,
  instructions: task.instructions,
  constraints: task.constraints,
  contextSnippets: task.contextSnippets,
  // NEW — pass these if present:
  question: task.question || null,
  pendingAnswer: task.pendingAnswer || null,
}
```

After the task is pulled by a worker, clear `pendingAnswer` to prevent re-delivery:

```js
// After sending task to worker:
task.pendingAnswer = null;
```

## NEW ENDPOINT

### POST /api/task/resume

Auth: `Authorization: Bearer <ORCH_API_TOKEN>`

#### Request body

```json
{
  "taskId": "string",
  "answer": "string",
  "answeredBy": "string (optional)"
}
```

#### Handler logic

```js
app.post("/api/task/resume", authMiddleware, (req, res) => {
  const { taskId, answer, answeredBy } = req.body;

  if (!taskId || !answer) {
    return res.status(400).json({ error: "taskId and answer are required" });
  }

  const task = tasks.get(taskId); // or however tasks are stored
  if (!task) {
    return res.status(404).json({ error: "task not found" });
  }

  if (task.status !== "needs_input") {
    return res.status(409).json({
      error: `task is in status '${task.status}', expected 'needs_input'`,
    });
  }

  // Save answer
  task.pendingAnswer = answer;
  task.status = "queued"; // re-queue for worker pickup

  // Record event
  task.events = task.events || [];
  task.events.push({
    status: "resumed",
    phase: "report",
    message: `resumed by ${answeredBy || "unknown"}: ${answer.slice(0, 200)}`,
    ts: new Date().toISOString(),
    meta: { answeredBy: answeredBy || null },
  });

  // Optional: trigger Telegram notify
  // notifyTelegram({ taskId, status: "resumed", phase: "report", message: ... });

  return res.json({ ok: true, taskId, status: task.status });
});
```

#### Response

Success (200):
```json
{ "ok": true, "taskId": "abc-123", "status": "queued" }
```

Error — missing fields (400):
```json
{ "error": "taskId and answer are required" }
```

Error — not found (404):
```json
{ "error": "task not found" }
```

Error — wrong status (409):
```json
{ "error": "task is in status 'completed', expected 'needs_input'" }
```

## WORKER_FLOW_CHANGES (step-by-step)

### Pause flow (worker → orch)

1. Worker pulls task, validates, spawns Claude
2. Claude runs and includes `[NEEDS_INPUT]...[/NEEDS_INPUT]` block in output
3. Worker detects marker via `parseNeedsInput()`, extracts question/options/context
4. Worker overrides result status to `needs_input`
5. Worker sends event `needs_input/claude` with question in message
6. Worker sends result with `status: "needs_input"` and question/options/context in meta
7. Orch-api saves question/options, sets `task.status = "needs_input"`
8. Worker loop continues polling — task is NOT returned again (status is `needs_input`)

### Resume flow (user → orch → worker)

1. User sends `POST /api/task/resume` with answer
2. Orch-api validates task is in `needs_input`, saves `pendingAnswer`, sets `status = "queued"`
3. Orch-api records `resumed/report` event
4. Worker polls, gets task from queue — task object now includes `pendingAnswer` and `question`
5. Worker detects `task.pendingAnswer`, logs resume, sends `progress/report` event
6. Worker builds prompt with continuation section (original instructions + answer)
7. Claude runs with full context including user's answer
8. Normal completion: `completed` / `failed` / `timeout` (or another `needs_input`)

### Marker format (Claude output)

```
[NEEDS_INPUT]
question: What database engine should I use for the users table?
options: PostgreSQL, MySQL, SQLite
context: The project has no existing database configuration
[/NEEDS_INPUT]
```

- `question` — required (marker ignored without it)
- `options` — optional, comma-separated
- `context` — optional, short description

To make Claude use this marker, include in task instructions/constraints:
```
If you need clarification before proceeding, output exactly:
[NEEDS_INPUT]
question: <your question>
options: <comma-separated options if applicable>
context: <brief context>
[/NEEDS_INPUT]
```

## EVENTS TABLE (updated)

| Status | Phase | When |
|---|---|---|
| `claimed` | `pull` | Task received from pull |
| `started` | `validate` | About to validate |
| `rejected` | `validate` | Validation failed |
| `progress` | `git` | Before git checkout |
| `progress` | `claude` | Before spawning Claude CLI |
| `progress` | `report` | Task resumed with user input |
| `needs_input` | `claude` | Claude needs user input |
| `resumed` | `report` | Task resumed via /resume endpoint |
| `completed` | `report` | Claude exited 0 |
| `failed` | `report` | Claude exited non-zero |
| `timeout` | `claude` | Claude exceeded timeout |
| `failed` | `other` | Unexpected JS exception |

## PATCH_SUMMARY

- Files changed on VPS: **1** (the main server/handler module)
- New endpoint: `POST /api/task/resume`
- Task model: +4 fields (`question`, `options`, `pendingAnswer`, `needsInputAt`)
- `/api/worker/result`: accept `needs_input` status
- `/api/worker/pull`: pass `question`/`pendingAnswer` fields, clear after pickup
- Existing behavior: **unchanged** for all existing statuses
- Dependencies: **0**

## SMOKE_TEST_STEPS

1. **Enqueue task** with instructions that include the `[NEEDS_INPUT]` marker instruction:
   ```bash
   curl -X POST $ORCH/api/task/enqueue \
     -H "Authorization: Bearer $TOKEN" \
     -H "Content-Type: application/json" \
     -d '{
       "taskId": "ni-test-001",
       "mode": "implement",
       "scope": { "repoPath": "/path/to/repo", "branch": "agent/ni-test" },
       "instructions": "Add a config file. If unclear which format, ask.\nIf you need clarification, output:\n[NEEDS_INPUT]\nquestion: <q>\noptions: <opts>\ncontext: <ctx>\n[/NEEDS_INPUT]"
     }'
   ```

2. **Worker picks up task** — check logs for:
   - `task received` with `taskId: ni-test-001`
   - `claimed/pull`, `started/validate`, `progress/git`, `progress/claude`

3. **Claude outputs NEEDS_INPUT** — check logs for:
   - `task needs input` with question
   - `task done` with `status: needs_input`
   - Event `needs_input/claude` sent

4. **Verify task status on orch**:
   ```bash
   curl $ORCH/api/task/ni-test-001 -H "Authorization: Bearer $TOKEN"
   # status: "needs_input", question: "...", pendingAnswer: null
   ```

5. **Resume with answer**:
   ```bash
   curl -X POST $ORCH/api/task/resume \
     -H "Authorization: Bearer $TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"taskId": "ni-test-001", "answer": "Use YAML format", "answeredBy": "sigma"}'
   # { "ok": true, "taskId": "ni-test-001", "status": "queued" }
   ```

6. **Worker picks up resumed task** — check logs for:
   - `task resumed with answer`
   - `progress/report` event: "task resumed with user input"
   - Prompt includes `## Continuation — User Answer` section

7. **Task completes** — check logs for:
   - `task done` with `status: completed` (or `failed`)
   - Event `completed/report` sent
   - Result posted to `/api/worker/result`

8. **Verify event history**:
   ```bash
   curl $ORCH/api/task/ni-test-001 -H "Authorization: Bearer $TOKEN"
   # events: [claimed, started, progress/git, progress/claude,
   #          needs_input/claude, resumed/report,
   #          claimed, started, ..., completed/report]
   ```

## ROLLBACK_STEPS

### Worker side (this repo)
1. `git checkout worker.js` — reverts to previous version
2. Restart worker — no protocol changes needed, old worker works with old orch

### Orch-api side (VPS)
1. Remove `/api/task/resume` route
2. Remove `needs_input` from valid result statuses
3. Remove new fields from task model (or leave them — they're null by default)
4. Restart orch-api
5. Any tasks stuck in `needs_input` status: manually set to `failed` or `queued`
