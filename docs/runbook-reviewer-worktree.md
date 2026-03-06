# Operator Runbook: Reviewer-Mode Worktree Flow

## 1. Task Flags (Exact)

To run a fully-gated reviewer-mode task with worktree isolation:

```json
{
  "mode": "review",
  "requireReviewGate": true,
  "isolatedReview": true,
  "useWorktree": true,
  "mergePolicy": {
    "requireReview": true,
    "requireTests": true,
    "targetBranch": "main"
  },
  "scope": {
    "repoPath": "/absolute/path/to/repo",
    "branch": "feature/your-branch"
  }
}
```

### Flag Reference

| Flag | Effect |
|---|---|
| `requireReviewGate=true` | Blocks `completed` status; forces `review_pass` or `review_fail` |
| `isolatedReview=true` | Builds anti-bias review packet (no prior findings, no iteration count); hashes packet for audit |
| `useWorktree=true` | Executes in a git worktree under `<repo>/.worktrees/<taskId>` instead of the main checkout |
| `mergePolicy.requireReview=true` | Merge gate: blocks merge unless status is `review_pass` |
| `mergePolicy.requireTests=true` | Merge gate: blocks merge unless tests pass |

### Optional Companion Flags

| Flag | Default | Notes |
|---|---|---|
| `reviewLoop` | false | Enable automatic review-patch-re-review cycle |
| `maxReviewIterations` | 3 (env `REVIEW_MAX_ITERATIONS`) | Max loop iterations before `escalated` |
| `orchestratedLoop` | false | Full implement-review loop (mode must be `implement`) |

---

## 2. Environment Variables

| Var | Default | Description |
|---|---|---|
| `MAX_PARALLEL_WORKTREES` | 2 | Max concurrent worktrees per worker |
| `WORKTREE_TTL_MS` | 3600000 (1h) | Stale worktree auto-cleanup threshold |
| `WORKTREE_CLEANUP_INTERVAL_MS` | 300000 (5m) | TTL scan interval |
| `WORKTREE_DISK_THRESHOLD_BYTES` | 5GB | Disk usage hard limit for worktree creation |
| `WORKTREE_DISK_HARD_STOP` | false | If true, block all worktrees when disk threshold exceeded |
| `WORKTREE_RECOVERY_ENABLED` | true | Auto-recover orphaned worktrees on startup |
| `REPORT_CONTRACT_ENABLED` | false | Enable empty-report guardrail |
| `REPORT_MIN_LENGTH` | 50 | Minimum stdout length to pass report contract |
| `REPORT_RETRY_ENABLED` | false | Auto-retry on report contract violation |
| `DLQ_ENABLED` | true | Dead-letter queue for fatal/exhausted tasks |

---

## 3. Troubleshooting

### 3.1 Empty Report Violation

**Symptom:** Task completes but status is `failed` with `meta.failureReason = "report_contract_violation"`.

**Cause:** Claude's stdout was empty or trivially short (< `REPORT_MIN_LENGTH` chars). The report-contract guardrail (`worker.js:2946`) rejects silent empty-success runs.

**Resolution:**
1. Check `report_contract_invalid` events for the task — they contain `reason`, `length`, and `pattern`.
2. If `REPORT_RETRY_ENABLED=true`, the worker auto-retries once with an explicit "provide a report" prompt. Check for `report_retry_attempt` / `report_retry_success` / `report_retry_failed` events.
3. If retries are disabled or also fail, the task transitions to `failed`. Re-submit with clearer instructions.
4. To disable the guardrail: set `REPORT_CONTRACT_ENABLED=false`.

### 3.2 Dead Letter Queue (DLQ)

**Symptom:** Task disappears after repeated failures; `dlq-transition` log entry at `error` level.

**Cause:** Task exhausted all `MAX_RETRIES` (default 3) transient retries, or hit a fatal (non-transient) error.

**Resolution:**
1. Search logs for `dlq-transition` with the task ID. The payload includes `failureReason`, `errorClass`, `exhaustionReason`, and `retryCount`.
2. The DLQ payload is POSTed to `/api/worker/dead-letter`. Check your orchestrator's DLQ handler.
3. `dlq-duplicate-suppressed` means a second DLQ attempt was blocked (idempotency guard).
4. If `dlq-post-failed`, the DLQ endpoint itself is unreachable — check orchestrator health.
5. To disable DLQ (tasks just fail instead): `DLQ_ENABLED=false`.

### 3.3 Stale Worktree Cleanup

**Symptom:** Disk fills up; old `.worktrees/<taskId>` directories accumulate.

**Cause:** Worktrees from crashed or timed-out tasks were not cleaned up.

**How automatic cleanup works:**
- A background timer (`worktreeTtlCleanup`) runs every `WORKTREE_CLEANUP_INTERVAL_MS`.
- It scans `<repo>/.worktrees/` and removes directories older than `WORKTREE_TTL_MS`.
- Active in-flight tasks are **never** cleaned (tracked via `_activeWorktreeTaskIds`).
- After removal, `git worktree prune` is called to sync git's internal registry.
- On startup, `worktreeRecovery` detects orphans from prior crashes.

**Manual cleanup:**
```bash
# List worktrees
ls -la /path/to/repo/.worktrees/

# Check which are registered with git
cd /path/to/repo && git worktree list

# Remove a specific stale worktree
rm -rf /path/to/repo/.worktrees/<taskId>
cd /path/to/repo && git worktree prune
```

### 3.4 Force Cleanup Policy

**Symptom:** Need to remove a worktree for a task that is still marked active.

**Mechanism:** `forceCleanupWorktree(taskId, repoPaths, { force })` (worker.js:2505):
- Without `force=true`: refuses to remove worktrees for active tasks (`w5-force-cleanup-denied`).
- With `force=true`: removes the worktree even if active, with warning `w5-force-cleanup-active-override`. The running task may fail or produce partial results.

**When to force-clean:**
- Worker process is stuck and the task will never complete.
- Lease has expired server-side but the worker hasn't detected it (see lease-renew 404 graceful degradation).
- Disk emergency: set `WORKTREE_DISK_HARD_STOP=true` to block all new worktrees until space is freed.

---

## 4. Expected Event Sequence

For a single-shot isolated review with worktree:

```
claimed → progress/validate → progress/worktree → [review execution] → review_pass (or review_fail)
```

For a reviewLoop with worktree (fail-then-pass):

```
claimed → progress/validate → progress/worktree
  → review (iter 1) → review_loop_fail/report
  → patch (iter 1)
  → review (iter 2) → review_pass/report
```

Key metadata in final result:
- `meta.worktreePath` — absolute path used
- `meta.worktreeBranch` — branch checked out
- `meta.baseCommit` — commit SHA at worktree creation
- `meta.isolatedRun` — true if isolated review path was used
- `meta.reviewPacketHash` — SHA-256 of the review packet (audit trail)

---

## 5. Smoke Verification

Run the existing smoke test to verify the full reviewer-mode worktree flow:

```bash
node test-reviewer-mode-smoke.js
```

**Expected:** All checks PASS, including:
- `[iso+gate+wt] status = review_pass`
- `[iso+gate+wt] worktreePath present in meta`
- `[iso+gate+wt] reviewPacketHash present (64 hex chars)`
- `[plain+gate+wt] status = review_pass`
- `[contract] zero report_contract_invalid events`

See section 6 for proof output from the verification run.

---

## 6. Verification Proof

**Date:** 2026-03-06
**Test:** `node test-reviewer-mode-smoke.js`
**Result:** 19/19 passed, 0 failed

```
PASS  [iso+gate+wt] status = review_pass  (status=review_pass)
PASS  [iso+gate+wt] resultVersion = 2  (resultVersion=2)
PASS  [iso+gate+wt] artifacts is array  (artifacts=0)
PASS  [iso+gate+wt] output.truncated is boolean  (truncated=false)
PASS  [iso+gate+wt] isolatedRun = true  (isolatedRun=true)
PASS  [iso+gate+wt] reviewPacketHash present (64 hex chars)  (hash=bb52f2324df61d56...)
PASS  [iso+gate+wt] worktreePath present in meta
PASS  [iso+gate+wt] worktreeBranch = agent/reviewer-smoke-test
PASS  [iso+gate+wt] baseCommit present in meta  (baseCommit=72c7adbb02d1)
PASS  [iso+gate+wt] NOT failed (report-contract did not false-fail)
PASS  [iso+gate+wt] no reportContractViolation in meta  (violation=null)
PASS  [iso+gate+wt] output.stdout contains REVIEW_PASS marker  (stdout_len=916)
PASS  [plain+gate+wt] status = review_pass  (status=review_pass)
PASS  [plain+gate+wt] resultVersion = 2  (resultVersion=2)
PASS  [plain+gate+wt] artifacts is array  (artifacts=0)
PASS  [plain+gate+wt] worktreePath present in meta
PASS  [plain+gate+wt] NOT failed (report-contract did not false-fail)
PASS  [plain+gate+wt] no isolatedRun (non-isolated path)  (isolatedRun=undefined)
PASS  [contract] zero report_contract_invalid events  (count=0)
```

Key proof fields from results:
- `rms-iso-gate-wt-001`: status=review_pass, isolatedRun=true, reviewPacketHash=bb52f232..., worktreeBranch=agent/reviewer-smoke-test
- `rms-plain-gate-wt-001`: status=review_pass, worktreeBranch=agent/reviewer-smoke-plain, no isolatedRun (correct for non-isolated path)
