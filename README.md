# Claude Worker (pull-based)

Local worker that polls a remote orchestrator for tasks and executes them via Claude Code CLI.

## Setup

```bash
# Node 18+ required (uses native fetch)
node --version

# Copy env and configure
cp .env.example .env
# edit .env with your values

# No npm install needed — zero dependencies
```

## .env example

```env
ORCH_BASE_URL=https://orchestrator.example.com
WORKER_TOKEN=your-secret-token
WORKER_ID=macbook-sigma
POLL_INTERVAL_MS=5000
CLAUDE_CMD=claude
ALLOWED_REPOS=/Users/sigma/MovieCenter,/tmp/test-repo
CLAUDE_TIMEOUT_MS=180000
CLAUDE_BYPASS_PERMISSIONS=true
```

## Run

```bash
node worker.js
```

## Example logs

```
{"ts":"2026-03-03T12:00:00.000Z","level":"info","worker":"macbook-sigma","msg":"worker started","allowedRepos":["/Users/sigma/MovieCenter","/tmp/test-repo"],"pollIntervalMs":5000}
{"ts":"2026-03-03T12:00:00.100Z","level":"debug","worker":"macbook-sigma","msg":"no tasks"}
{"ts":"2026-03-03T12:00:05.200Z","level":"info","worker":"macbook-sigma","msg":"task received","taskId":"abc-123","mode":"implement"}
{"ts":"2026-03-03T12:00:35.500Z","level":"info","worker":"macbook-sigma","msg":"task done","taskId":"abc-123","status":"completed","durationMs":30300}
```

## Local dry-run test

Runs a mock orchestrator + worker, sends one `dry_run` task, prints the result:

```bash
# create the test repo dir first
mkdir -p /tmp/test-repo && cd /tmp/test-repo && git init

# run the test
node test-dry-run.js
```

## Troubleshooting

### No tasks returned

Worker prints `"no tasks"` and waits `POLL_INTERVAL_MS`. This is normal — the orchestrator has nothing queued. The worker will keep polling.

### Auth error (HTTP 401)

Check `WORKER_TOKEN` in `.env` matches the token configured on the orchestrator.

### Repo not in allowlist

```
task validation failed: repoPath not in allowlist: /some/path
```

Add the repo path to `ALLOWED_REPOS` in `.env` (comma-separated, absolute paths).

### Branch rejected

Only these prefixes are allowed: `agent/`, `hotfix/`, `feature/`, `bugfix/`. Branch names must match `^(agent|hotfix|feature|bugfix)/[a-zA-Z0-9._-]+$`. Branches `main` and `master` are always blocked.

### Claude CLI not found

Make sure `claude` is in your PATH, or set `CLAUDE_CMD` to the full path (e.g. `/usr/local/bin/claude`).

### Claude hangs (permission gate)

In headless mode, Claude CLI may wait for interactive permission approval, causing the worker to hang indefinitely. The worker passes `--dangerously-skip-permissions` by default (`CLAUDE_BYPASS_PERMISSIONS=true`) to prevent this.

**Guardrails that limit risk:**
- `ALLOWED_REPOS` — only whitelisted directories can be accessed
- Branch policy — only `agent/`, `hotfix/`, `feature/`, `bugfix/` prefixes; `main`/`master` always blocked
- `CLAUDE_TIMEOUT_MS` — hard kill after timeout
- `stdin: ignore` + `CI=1` — no interactive escape

Set `CLAUDE_BYPASS_PERMISSIONS=false` if you want Claude to respect permission checks (will require an alternative approval mechanism or may cause hangs).

### Timeout

If tasks exceed `CLAUDE_TIMEOUT_MS`, the child process is killed (SIGTERM, then SIGKILL after 5s) and the task is reported as `timeout`. Increase the timeout or simplify the task.

## Event System

The worker sends lifecycle events to `POST /api/worker/event` at each stage of task execution. Events are fire-and-forget — a failed event request logs a warning but never breaks the main flow.

### Statuses and phases

| Point in code | status | phase | message |
|---|---|---|---|
| Task pulled from queue | `claimed` | `pull` | `"task received"` |
| Before validation | `started` | `validate` | `"validating task"` |
| Validation failed | `rejected` | `validate` | validation errors |
| Before git checkout | `progress` | `git` | `"checking out branch <branch>"` |
| Before spawning Claude CLI | `progress` | `claude` | `"spawning claude CLI"` |
| Claude completed successfully | `completed` | `report` | `"task completed"` |
| Claude exited non-zero | `failed` | `report` | `"task failed"` |
| Claude timed out | `timeout` | `claude` | `"claude process timed out"` |
| Unexpected error in main loop | `failed` | `other` | error message |

### Server-side contract (implement on your server)

```
POST /api/worker/event
Authorization: Bearer <WORKER_TOKEN>
Content-Type: application/json

{
  "workerId": "string",       // required
  "taskId": "string",         // required
  "status": "string",         // required: claimed|started|progress|completed|failed|timeout|rejected
  "phase": "string",          // required: pull|validate|git|claude|push|pr|report|other
  "message": "string",        // optional, max 1000 chars
  "meta": {}                  // optional, task metadata (durationMs, exitCode, etc.)
}

Response: { "ok": true }
```

The server should add its own `serverTs` timestamp on receipt.

### Example curl

```bash
curl -X POST https://orchestrator.example.com/api/worker/event \
  -H "Authorization: Bearer $WORKER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "workerId": "macbook-sigma",
    "taskId": "abc-123",
    "status": "progress",
    "phase": "claude",
    "message": "spawning claude CLI",
    "meta": {}
  }'
```
