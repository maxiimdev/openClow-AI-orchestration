# Architecture

## System Overview

```
Telegram ──► VPS orch-api ◄── POST /api/worker/pull ── Worker (local)
                │                                          │
                │  POST /api/worker/event                  │  spawns
                │  POST /api/worker/result                 ▼
                │◄──────────────────────────────────── Claude CLI
                │
                ▼
          tg-notifier ──► Telegram Bot API ──► User
```

The system is a pull-based orchestration loop. A local worker polls a remote VPS orchestrator for tasks, executes them via Claude Code CLI, and reports results and lifecycle events back to the orchestrator. The orchestrator forwards events to Telegram via a notifier sidecar.

## Components

### 1. VPS Orchestrator (`orch-api`)

**Not in this repo.** Runs on the VPS. Responsibilities:

- Receives task requests (from Telegram bot or direct API)
- Maintains task queue and task state (`queued`, `needs_input`, `completed`, `failed`, etc.)
- Serves `POST /api/worker/pull` — returns next queued task to the worker
- Receives `POST /api/worker/event` — appends to `task.events[]`, forwards to notifier
- Receives `POST /api/worker/result` — stores final output, updates task status
- Handles `POST /api/task/resume` — accepts user answers for `needs_input` tasks, re-queues them

### 2. Worker (`worker.js`)

**This repo.** Runs locally. Responsibilities:

- Polls `POST /api/worker/pull` every `POLL_INTERVAL_MS` (default 5s)
- Validates tasks: checks `taskId`, `mode`, `repoPath` against allowlist, branch policy
- Checks out the target branch via `git checkout -B <branch> --`
- Spawns `claude` CLI with the task prompt (`--output-format json`, headless env vars)
- Captures stdout/stderr (capped at 200KB each)
- Parses output for `needs_input` signals (5-step parser pipeline)
- Builds continuation prompts for resumed tasks (appends previous question + user answer)
- Sends lifecycle events and final results to the orchestrator
- Handles timeouts (SIGTERM then SIGKILL after 5s) and exponential backoff on errors

The worker is **stateless** — all task state lives in the orchestrator.

### 3. Telegram Notifier (`notifier/notifier.js`)

Runs on the VPS as a sidecar. Responsibilities:

- Receives events from orch-api via `POST /notify/event`
- Formats events with status emojis and sends to Telegram via Bot API
- Deduplicates identical events within a configurable TTL window (default 15s)

### 4. Claude CLI

Invoked by the worker as a child process:

```bash
claude -p "<prompt>" --output-format json [--dangerously-skip-permissions]
```

Environment: `CI=1`, `CLAUDE_CODE_HEADLESS=1`, `stdin: ignore` (no interactive input).

Output: JSONL or JSON with a `result` string field. Exit 0 = success, non-zero = failure.

## Task Lifecycle

```
1. User sends message via Telegram (or API)
2. orch-api enqueues task (status: queued)
3. Worker polls, receives task
4. Worker sends event: claimed/pull
5. Worker validates task
   ├─ fail → rejected/validate → result(rejected) → done
   └─ pass → continue
6. Worker checks out branch (progress/git)
7. Worker spawns Claude CLI (progress/claude)
8. Claude runs...
   ├─ exit 0 + no needs_input (mode != review) → completed/report → result(completed)
   ├─ exit 0 + needs_input detected → needs_input/claude → result(needs_input)
   │     └─ User answers → POST /api/task/resume → re-queued → step 3
   ├─ exit 0 + mode=review + [REVIEW_PASS] → review_pass/report → result(review_pass)
   ├─ exit 0 + mode=review + [REVIEW_FAIL] or no marker → review_fail/report → result(review_fail)
   ├─ exit non-zero → failed/report → result(failed)
   └─ timeout → timeout/claude → result(timeout)
```

## Stage 2: Review Gate

The review gate is enforced in the worker. For tasks with `mode=review`:

1. Claude output is parsed for `[REVIEW_PASS]` or `[REVIEW_FAIL severity=major|critical]...[/REVIEW_FAIL]` markers.
2. `[REVIEW_PASS]` → status becomes `review_pass`; orchestrator may proceed to `tests`.
3. `[REVIEW_FAIL]` or no marker → status becomes `review_fail`; orchestrator re-queues an `implement` (patch) task with `previousReviewFindings`.
4. **The `completed` status is physically impossible for `mode=review` tasks** — the gate is enforced in code with a double-check (normal path + hard safety gate).

### Stage 2 Flow

```
implement → review (fresh run)
               ├─ review_pass → tests → completed
               └─ review_fail → implement (patch, previousReviewFindings injected) → review → ...
```

### Patch Loop Prompt Injection

When a task has `task.previousReviewFindings` set, the worker injects a `## Review Findings` section into the prompt so Claude can address the issues directly.

## Task State Storage

All state lives in the orchestrator. The task object includes:

| Field | Description |
|---|---|
| `taskId` | Unique identifier |
| `status` | `queued`, `needs_input`, `completed`, `review_pass`, `review_fail`, `failed`, `timeout`, `rejected` |
| `mode` | `dry_run`, `implement`, `review`, `tests` |
| `scope` | `{ repoPath, branch }` |
| `instructions` | Task prompt text |
| `constraints` | Array of constraint strings |
| `contextSnippets` | Array of `{ path, content, label? }` |
| `events[]` | Append-only event log |
| `question` | Claude's question (when `needs_input`) |
| `options` | Answer choices (when `needs_input`) |
| `pendingAnswer` | User's answer (cleared after delivery to worker) |
| `needsInputAt` | ISO-8601 timestamp of `needs_input` |

## Failure Points and Diagnostics

### Failure Points

| Failure | Status/Phase | What happens |
|---|---|---|
| Validation fails (bad mode, repo, branch) | `rejected/validate` | Result posted with `status: "rejected"` |
| Git checkout fails | `failed/report` | Error in stderr |
| Claude exits non-zero | `failed/report` | stderr captured, exitCode in meta |
| Claude hangs past timeout | `timeout/claude` | SIGTERM, then SIGKILL after 5s |
| Claude binary not found | `failed/report` | `stderr: "spawn error: ..."` |
| Output exceeds 200KB | Truncated | `output.truncated = true`, `[TRUNCATED]` appended |
| JS exception in main loop | `failed/other` | Exponential backoff (5s → 10s → 20s → 40s → 60s) |
| Event POST fails | Warning logged | Fire-and-forget; never breaks main flow |

### Diagnostics

- **Structured logs**: All output is JSON with `{ ts, level, worker, msg, ...meta }`
- **Log levels**: `info`, `debug`, `warn`, `error`, `fatal`
- **`NEEDS_INPUT_DEBUG=true`**: Enables verbose `[ni]` prefixed logs showing parser step matches, `hasPermissionDenials`, `hasAskUserQuestion`, etc.
- **Safety gating**: If `parseNeedsInput` finds a question but status path is `completed`, the worker forces `needs_input` and logs a `"gating violation"` at error level

### Exponential Backoff

On unexpected errors in the main loop, the worker backs off before retrying:

```
5s → 10s → 20s → 40s → 60s (max)
```

Resets to 0 on any successful pull response.

## Environment Variables

### Worker (`.env`)

| Variable | Required | Default | Description |
|---|---|---|---|
| `ORCH_BASE_URL` | yes | — | Orchestrator base URL |
| `WORKER_TOKEN` | yes | — | Bearer token for orch API calls |
| `WORKER_ID` | no | `worker-default` | Worker identifier |
| `POLL_INTERVAL_MS` | no | `5000` | Polling interval (ms) |
| `CLAUDE_CMD` | no | `claude` | Path to Claude CLI |
| `ALLOWED_REPOS` | no | `""` | Comma-separated absolute paths |
| `CLAUDE_TIMEOUT_MS` | no | `180000` | Hard kill timeout (ms) |
| `CLAUDE_BYPASS_PERMISSIONS` | no | `true` | Adds `--dangerously-skip-permissions` |
| `NEEDS_INPUT_DEBUG` | no | `false` | Verbose parser debug logs |

### Notifier (`notifier/.env`)

| Variable | Required | Default | Description |
|---|---|---|---|
| `PORT` | no | `18999` | HTTP listen port |
| `NOTIFIER_SECRET` | yes | — | Bearer token for `/notify/event` |
| `TELEGRAM_BOT_TOKEN` | yes | — | Telegram Bot API token |
| `TELEGRAM_CHAT_ID` | yes | — | Target chat/group ID |
| `DEDUPE_TTL_MS` | no | `15000` | Dedup window (ms) |

## Assumptions

- The orchestrator (`orch-api`) is a separate service running on a VPS; its code is not in this repo
- The worker machine has `claude` CLI installed and accessible in PATH (or via `CLAUDE_CMD`)
- The worker machine has local clones of repos listed in `ALLOWED_REPOS`
- Network between worker and VPS is reliable enough for polling; transient failures are handled via backoff
- Claude CLI outputs JSONL or JSON with a `result` field when using `--output-format json`
