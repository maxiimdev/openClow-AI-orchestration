# Worker

Pull-based worker that polls an orchestrator for tasks, runs them via the Claude CLI,
and posts results back.

## Quick start

```bash
cp .env.example .env   # fill in ORCH_BASE_URL, WORKER_TOKEN, ALLOWED_REPOS
node worker.js
```

## Configuration (env vars)

| Variable | Default | Description |
|---|---|---|
| `ORCH_BASE_URL` | *(required)* | Orchestrator base URL |
| `WORKER_TOKEN` | *(required)* | Bearer token |
| `WORKER_ID` | `worker-default` | Worker identifier in events |
| `ALLOWED_REPOS` | `""` | Comma-separated absolute repo paths |
| `POLL_INTERVAL_MS` | `5000` | Idle poll interval |
| `CLAUDE_CMD` | `claude` | Claude CLI executable |
| `CLAUDE_MODEL` | `sonnet` | Default model (`sonnet` or `opus`) |
| `CLAUDE_TIMEOUT_MS` | `180000` | Hard timeout for Claude subprocess |
| `CLAUDE_BYPASS_PERMISSIONS` | `true` | Pass `--dangerously-skip-permissions` |
| `HEARTBEAT_INTERVAL_MS` | `90000` | Keepalive period when Claude is silent |
| `NEEDS_INPUT_DEBUG` | `false` | Verbose needs_input parsing logs |

## Event schema

All events are POSTed to `POST /api/worker/event`:

```jsonc
{
  "workerId":  "worker-default",
  "taskId":    "task-123",
  "status":    "<status>",    // see below
  "phase":     "<phase>",
  "message":   "human-readable string (≤1000 chars)",
  "meta":      { /* varies by status */ }
}
```

### Status values

| Status | Phase | Description |
|---|---|---|
| `claimed` | `pull` | Task dequeued from orchestrator |
| `started` | `validate` | Validation about to run |
| `rejected` | `validate` | Task failed validation |
| `progress` | `plan` | Plan computed; `meta.steps` contains the step names |
| `progress` | `validate` | Validation passed |
| `progress` | `git` | Git checkout in progress |
| `progress` | `claude` | Claude subprocess spawned |
| `progress` | `report` | About to POST result |
| `keepalive` | `claude` | Heartbeat while Claude is silent |
| `risk` | `claude` | Risk condition detected |
| `timeout` | `claude` | Claude exceeded `CLAUDE_TIMEOUT_MS` |
| `needs_input` | `claude` | Claude asked a question; task paused |
| `review_pass` | `report` | Review task emitted `[REVIEW_PASS]` |
| `review_fail` | `report` | Review task emitted `[REVIEW_FAIL …]` |
| `completed` | `report` | Task finished successfully |
| `failed` | `report` | Task failed |

### Step-progress meta fields

`progress` events include:

```jsonc
{
  "stepIndex": 1,      // 1-based step number (0 = plan announcement)
  "stepTotal": 4,      // total steps in this plan
  "steps":     [...]   // only present on the plan event (stepIndex=0)
}
```

### Plan steps by mode

| Mode | Steps |
|---|---|
| `dry_run` | `validate → report` |
| `implement / tests / review` | `validate → checkout {branch} → spawn claude ({model}) → report` |

### Keepalive meta

```jsonc
{
  "elapsedMs":  45000,
  "stepIndex":  3,
  "stepTotal":  4
}
```

### Risk meta

```jsonc
{
  "riskType":  "near_timeout",   // or "exit_failure"
  "elapsedMs": 144000,
  "timeoutMs": 180000,
  "stepIndex": 3,
  "stepTotal": 4
}
```

`near_timeout` fires at 80 % of `CLAUDE_TIMEOUT_MS`. `exit_failure` fires when
Claude exits with a non-zero code.

## Task modes

| Mode | What happens |
|---|---|
| `dry_run` | Builds prompt, returns it without running Claude |
| `implement` | Checks out branch, runs Claude, posts result |
| `tests` | Same as implement |
| `review` | Same, but result must include `[REVIEW_PASS]` or `[REVIEW_FAIL …]` marker |

## Stage gates

### Stage 1 — needs_input / resume

If Claude's output contains a `[NEEDS_INPUT]…[/NEEDS_INPUT]` block (or a JSON
question object, fenced block, or `AskUserQuestion` permission denial), the task
is posted back with `status: "needs_input"` and a `meta.question` field.  The
orchestrator re-queues it with `pendingAnswer`, which the worker injects into the
next prompt as a `## Continuation — User Answer` section.

### Stage 2 — review gate

`review` mode tasks can never complete with `status: "completed"`.  The worker
parses `[REVIEW_PASS]` / `[REVIEW_FAIL severity=…]…[/REVIEW_FAIL]` markers from
Claude's output and translates them to `review_pass` / `review_fail`.  If neither
marker is present the task is treated as `review_fail`.

## Tests

```bash
node test-dry-run.js     # sanity check: one dry_run cycle
node test-telemetry.js   # step telemetry, heartbeat, near-timeout risk
```
