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
| `REVIEW_MAX_ITERATIONS` | `3` | Default max review iterations for loops |
| `REPORT_CONTRACT_ENABLED` | `false` | Enable basic report contract (empty/placeholder/short) checks |
| `REPORT_MIN_LENGTH` | `50` | Minimum report length for contract check |
| `REPORT_RETRY_ENABLED` | `false` | Retry task once on basic contract violation |
| `REPORT_SCHEMA_STRICT` | `false` | Enable structured report schema validation |
| `REPORT_SCHEMA_RETRY_ENABLED` | `false` | Retry task once on schema violation |

### Report schema rules

When `REPORT_SCHEMA_STRICT=true`, reports are validated against structured schemas:

| Schema | Auto-selected when | Required sections |
|---|---|---|
| `strict` | Task instructions match: audit, foundation, hardening, refactor, migration | changelog, evidence/commands, test summary, commit hash |
| `standard` | `REPORT_SCHEMA_STRICT=true` and no strict pattern match | changelog, test summary |
| `compact` | Never auto-selected (explicit `reportSchema=compact` override only) | *(none)* |

Per-task overrides: `task.reportSchema = "compact" | "standard" | "strict"` overrides auto-detection.
Per-task opt-out: `task.reportSchemaRetryOnViolation = false` disables schema retry for that task.

On schema violation: emits `report_schema_invalid` event with missing sections, performs one retry if enabled, fails with `report_contract_violation` if still invalid.

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
| `progress` | `orchestrate` | Stage transition in orchestrated/review loop |
| `progress` | `report` | About to POST result |
| `context_reset` | `orchestrate` | New Claude session starting (orchestrated/review loop) |
| `keepalive` | `claude` | Heartbeat while Claude is silent |
| `risk` | `claude` | Risk condition detected |
| `timeout` | `claude` | Claude exceeded `CLAUDE_TIMEOUT_MS` |
| `needs_input` | `claude` | Claude asked a question; task paused |
| `review_pass` | `report` | Review passed; `[REVIEW_PASS]` emitted by Claude |
| `review_fail` | `report` | Review failed; `[REVIEW_FAIL …]` emitted by Claude |
| `review_loop_fail` | `report` | Intermediate review fail in loop; patch will follow |
| `escalated` | `report` | Loop exhausted max iterations without passing |
| `report_contract_invalid` | `report_contract` | Basic report contract violation (empty/placeholder/short) |
| `report_retry_attempt` | `report_contract` | Retrying task after basic contract violation |
| `report_schema_invalid` | `report_contract` | Structured schema violation; `meta.missing` lists missing sections |
| `report_schema_retry_attempt` | `report_contract` | Retrying task after schema violation |
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

| Mode / flags | Steps |
|---|---|
| `dry_run` | `validate → report` |
| `implement / tests / review` | `validate → checkout {branch} → spawn claude ({model}) → report` |
| `review` + `reviewLoop:true` | `validate → checkout → review_loop (max N iters) → report` |
| any mode + `orchestratedLoop:true` | `validate → checkout → orchestrated_loop: implement→review[→patch→review]* → report` |

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

## Task flags

| Flag | Type | Description |
|---|---|---|
| `reviewLoop` | boolean | Enable review-patch loop (mode `review` only). Runs review → patch → re-review until pass or `maxReviewIterations`. |
| `orchestratedLoop` | boolean | Enable full orchestrated loop (any mode). Runs implement → review → [patch → re-review]* until pass or `maxReviewIterations`. |
| `maxReviewIterations` | number | Override max iterations for `reviewLoop`/`orchestratedLoop` (default: `REVIEW_MAX_ITERATIONS`). |
| `patchInstructions` | string | Custom instructions for patch runs in loops. Defaults to a generated prompt based on `instructions`. |

## Stage gates

### Stage 1 — needs_input / resume

If Claude's output contains a `[NEEDS_INPUT]…[/NEEDS_INPUT]` block or an
`AskUserQuestion` permission denial, the task is posted back with
`status: "needs_input"` and a `meta.question` field.  The orchestrator re-queues
it with `pendingAnswer`, injected as a `## Continuation — User Answer` section.

**Review mode restriction:** In `review` mode (including loops), only explicit
`[NEEDS_INPUT]…[/NEEDS_INPUT]` markers and `AskUserQuestion` tool calls trigger
`needs_input`. Heuristic detection (JSON objects with `question` key, fenced
blocks, NEEDS_INPUT tokens in review commentary) is suppressed to prevent false
positives from review output text.

### Stage 2 — review gate

`review` mode tasks can never complete with `status: "completed"`.  The worker
parses `[REVIEW_PASS]` / `[REVIEW_FAIL severity=…]…[/REVIEW_FAIL]` markers from
Claude's output and translates them to `review_pass` / `review_fail`.  If neither
marker is present the task is treated as `review_fail`.  This gate applies to
single-shot review tasks; loop tasks are handled by their respective loop runners.

### Stage 3 — review loop (`reviewLoop: true`)

When a `review` mode task has `reviewLoop: true`, the worker orchestrates:

```
review (fresh context) → [REVIEW_FAIL] → patch (fresh context)
→ re-review (fresh context, +diff snippet) → ... → [REVIEW_PASS] → review_pass
                                                  → exhausted    → escalated
```

Each Claude invocation is an independent subprocess with no session carryover.
The `review_loop_fail` event is emitted after each failed iteration.

### Stage 4 — orchestrated loop (`orchestratedLoop: true`)

When a task has `orchestratedLoop: true`, the worker orchestrates:

```
implement (fresh context)
→ review (fresh context) → [REVIEW_PASS] → review_pass
                        → [REVIEW_FAIL] → patch (fresh context)
                                       → re-review (fresh context, +diff snippet)
                                       → ... repeat until pass or maxReviewIterations
                                       → escalated
```

A `context_reset` event (status `context_reset`, phase `orchestrate`) is emitted
before each new Claude session with `meta.phase`, `meta.iteration`, and
`meta.contextReset: true`. Terminal statuses: `review_pass`, `escalated`.

## Tests

```bash
node test-dry-run.js           # dry_run cycle
node test-telemetry.js         # step telemetry, heartbeat, near-timeout risk
node test-needs-input.js       # needs_input → resume → completed cycle
node test-stage2-review-gate.js  # single-shot review gate
node test-stage2-review-loop.js  # reviewLoop: fail→pass, always-fail→escalated
node test-flow-hardening.js    # false needs_input regression + orchestrated loop
```
