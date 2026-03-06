# Closeout: Reviewer Mode + Worktree + Lease-Renew Reliability

**Task:** task-20260306T182719Z-reviewer-mode-worktree-check-closeout2-lease-renew-end2end-check
**Branch:** feature/miniapp-mvp
**Date:** 2026-03-06

---

## 1. Observed Reliability Behavior

### Lease Renewal Path (`slotStartLease` / `apiPostRaw`)
- **Mechanism:** `setInterval` fires every `LEASE_RENEW_INTERVAL_MS` (default 60s), POSTing to `/api/worker/lease-renew` via `apiPostRaw` (no retry, 15s timeout).
- **On success:** `{ expired: false }` → `log("debug", "lease-renewed")`, timer continues.
- **On server-side expiry:** `{ expired: true }` → sets `ctx.leaseExpired = true`, stops timer.
- **On HTTP error (including 404/5xx):** catch block logs `"lease-renew-failed"` at `warn` level, timer **continues** to fire. **No backoff, no escalation.**
- **On lease expiry check (post-execution):** `slotIsLeaseExpired(ctx)` at line 2834 — if true, result is discarded, `failed/lease` event emitted, and task is abandoned (no result posted).

### Behavior Under Lease-Renew 404 (Endpoint Missing)
**Proven by test T3:** When `/api/worker/lease-renew` returns 404, the worker:
1. Logs warn-level `lease-renew-failed` on each interval tick
2. Does **NOT** set `leaseExpired = true` (the flag is only set when the server explicitly returns `{ expired: true }`)
3. Task completes normally with correct `review_pass` status and full worktree metadata
4. Worktree is cleaned up on terminal status

**Conclusion:** Missing lease-renew endpoint is non-fatal. The worker degrades gracefully — it just loses server-side lease protection.

### Review Loop + Worktree Interaction
**Proven by test T1:** `reviewLoop=true` + `useWorktree=true` works correctly:
- Worktree created once in `processTask`, reused across all loop iterations (review → patch → re-review)
- The `repoPath` override (line 2780) correctly applies to all `executeTask` calls within `runReviewLoop`
- Worktree metadata (`worktreePath`, `baseCommit`, `worktreeBranch`) correctly attached to final result
- Worktree cleaned up after terminal status (both `review_pass` and `escalated`)
- All lifecycle events emitted: `progress/worktree`, `review_loop_fail/report`, `review_pass/report`

---

## 2. Risks

### Risk 1: Silent Lease Drift (MEDIUM)
**What:** When lease-renew fails (404, network error, 5xx), the worker continues executing indefinitely with no backoff or alerting. The server may have already reassigned the task to another worker, causing a **split-brain** — two workers processing the same task.

**Impact:** Duplicate results posted. The second worker's result will conflict with the first. The idempotency layer (`_idempotencyKey`) mitigates at the result-posting level, but intermediate events will be duplicated.

**Current mitigation:** `apiPostRaw` catch block logs warn. No retry escalation.

### Risk 2: No Client-Side Lease TTL Enforcement (MEDIUM)
**What:** The `leaseExpired` flag is only set when the server responds with `{ expired: true }`. If the server is unreachable (network partition, 404), the client has no local TTL timer to self-expire. The worker will hold the task indefinitely.

**Impact:** Under network partition, the server reassigns the task but the disconnected worker keeps working — wasting compute and potentially posting a stale result when connectivity resumes.

### Risk 3: Lease Timer Leaks in Long Review Loops (LOW)
**What:** The lease timer is started once per `processTask` and stopped at line 3096 (cleanup). During multi-iteration review loops (up to 10 iterations), the timer correctly keeps firing. However, if `executeTask` throws an unhandled error *inside* `runReviewLoop` (not caught by the outer try/catch), the timer could leak.

**Current mitigation:** The outer try/catch in `processTask` (line 2688) calls `slotStopLease` in the catch block (line 3114). This covers the leak path.

---

## 3. Concrete Fix Recommendations

### Fix 1: Add Client-Side Lease TTL Guard
Add a local expiry timer alongside the renewal interval. If `LEASE_TTL_MS` elapses without a successful renewal response, set `leaseExpired = true` locally.

```js
// In slotStartLease, add:
ctx.leaseDeadline = Date.now() + ttlMs;

// In the renewal interval callback, add:
if (Date.now() > ctx.leaseDeadline) {
  ctx.leaseExpired = true;
  log("warn", "lease-expired-local-ttl", { taskId, slotId: ctx.slotId });
  slotStopLease(ctx);
  return;
}
// On successful renewal, extend the deadline:
ctx.leaseDeadline = Date.now() + ttlMs;
```

**Priority:** MEDIUM — prevents split-brain under network partition.

### Fix 2: Lease Renewal Failure Counter with Escalation
Track consecutive lease-renew failures. After N consecutive failures (e.g., 3), either:
- Set `leaseExpired = true` (conservative — abort), or
- Emit a `lease-degraded` event to alert the orchestrator

```js
ctx.leaseRenewFailCount = (ctx.leaseRenewFailCount || 0) + 1;
if (ctx.leaseRenewFailCount >= 3) {
  ctx.leaseExpired = true;
  log("error", "lease-renew-consecutive-failures", { taskId, count: ctx.leaseRenewFailCount });
  slotStopLease(ctx);
}
// Reset on success:
ctx.leaseRenewFailCount = 0;
```

**Priority:** MEDIUM — makes 404/missing endpoint degradation bounded rather than infinite.

### Fix 3: Orchestrator Should Implement `/api/worker/lease-renew`
If the endpoint is genuinely missing in the orchestrator, implement it. The worker already sends well-formed payloads (`{ workerId, taskId, leaseTtlMs }`). The server should:
1. Validate the lease is still assigned to that worker
2. Return `{ expired: false }` to extend, or `{ expired: true }` if reassigned

**Priority:** HIGH — this is the server-side half of the lease contract.

---

## 4. Test Evidence

**New test file:** `test-reviewer-worktree-lease.js` — 19 assertions, all passing.

| Check | Result |
|-------|--------|
| T1: reviewLoop + worktree → review_pass | PASS |
| T1: reviewIteration=2 (fail→patch→pass) | PASS |
| T1: worktreePath/baseCommit/worktreeBranch in meta | PASS |
| T2: lease-renew fires during review loop | PASS (2 calls) |
| T2: leaseTtlMs valid in renewal payload | PASS |
| T3: review_pass despite 404 lease-renew | PASS |
| T3: worktree metadata present despite 404 | PASS |
| T4: worktree cleaned up (task 1) | PASS |
| T4: worktree cleaned up (task 2, 404 mode) | PASS |
| T5: worktree progress events emitted | PASS |
| T5: review_loop_fail event in iteration 1 | PASS |
| T5: review_pass event emitted | PASS |

**Existing suites — no regressions:**
- `test-flow-hardening.js` — ALL CHECKS PASSED
- `test-stage2-review-loop.js` — ALL CHECKS PASSED

---

## 5. Verdict

**Reviewer mode + worktree + lease-renew: RELIABLE under normal conditions.** The worker correctly creates worktrees, runs multi-iteration review loops inside them, propagates worktree metadata through all events and results, and cleans up on terminal status. Lease renewal fires during long-running review loops and 404/missing endpoint is handled gracefully (warn-log, continue).

**Gap:** No client-side lease TTL enforcement means network partitions can cause silent split-brain. Fixes 1-3 above would close this gap.
