# Claude Worker (pull-based)

Local worker that polls a remote orchestrator for tasks and executes them via Claude Code CLI.

## Documentation

- **[ARCHITECTURE.md](ARCHITECTURE.md)** — System overview, component responsibilities, task state, failure points
- **[TASK_SCHEMA.md](TASK_SCHEMA.md)** — Task object schema, pull/result API contracts, validation rules, prompt structure
- **[EVENT_CONTRACT.md](EVENT_CONTRACT.md)** — Full `POST /api/worker/event` contract, statuses, phases, payload examples
- **[INTERACTIVE_FLOW.md](INTERACTIVE_FLOW.md)** — `needs_input` / `resume` lifecycle, `POST /api/task/resume` contract

## Quickstart

```bash
# 1. Node 18+ required (uses native fetch, zero npm dependencies)
node --version

# 2. Configure environment
cp .env.example .env
# Edit .env: set ORCH_BASE_URL, WORKER_TOKEN, ALLOWED_REPOS

# 3. Run the worker
node worker.js

# 4. (Optional) Run a local dry-run test
mkdir -p /tmp/test-repo && cd /tmp/test-repo && git init
node test-dry-run.js
```

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
CLAUDE_MODEL=sonnet
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

## Model selection (sonnet / opus)

**Default:** `sonnet` (Claude Sonnet 4.6) — fast, cost-effective, handles most tasks.

### Override globally (env)

```env
CLAUDE_MODEL=opus
```

### Override per task

Add `"model": "opus"` to the task payload when enqueueing:

```json
{
  "taskId": "arch-redesign-001",
  "mode": "implement",
  "model": "opus",
  "scope": { "repoPath": "/path/to/repo", "branch": "agent/redesign" },
  "instructions": "Redesign the auth module..."
}
```

Priority: `task.model` > `CLAUDE_MODEL` env > `"sonnet"`.

Only `"sonnet"` and `"opus"` are allowed. An unknown model in `task.model` will be rejected at validation.

### When to use opus

- Complex architectural changes spanning many files
- High-risk refactors where correctness is critical
- Deep code review requiring nuanced understanding
- Tasks where sonnet produced insufficient results on first attempt

### When to use sonnet (default)

- Routine implementation tasks
- Simple bug fixes and small features
- Tests, docs, config changes
- Any task where speed and cost matter more than depth

The selected model is included in `meta.model` of all events and results for traceability.

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
| Claude needs input | `needs_input` | `claude` | `"needs input: <question>"` |
| Task resumed with answer | `progress` | `report` | `"task resumed with user input"` |
| Claude timed out | `timeout` | `claude` | `"claude process timed out"` |
| Unexpected error in main loop | `failed` | `other` | error message |

See [EVENT_CONTRACT.md](EVENT_CONTRACT.md) for the full contract, payload examples, and proof-based status guidance. See [INTERACTIVE_FLOW.md](INTERACTIVE_FLOW.md) for the `needs_input`/`resume` lifecycle.

### Server-side contract (implement on your server)

```
POST /api/worker/event
Authorization: Bearer <WORKER_TOKEN>
Content-Type: application/json

{
  "workerId": "string",       // required
  "taskId": "string",         // required
  "status": "string",         // required: claimed|started|progress|needs_input|completed|failed|timeout|rejected
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
