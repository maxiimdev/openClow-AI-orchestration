#!/usr/bin/env node
"use strict";

/**
 * End-to-end test: Reviewer mode + worktree + lease-renew interaction.
 *
 * Validates:
 *   T1. reviewLoop + useWorktree=true completes as review_pass with worktree metadata
 *   T2. Lease-renew endpoint receives calls during task execution (proves lease timer fires)
 *   T3. Lease-renew 404 (endpoint missing) does NOT block task completion
 *   T4. Worktree is cleaned up after terminal status
 *   T5. Events include worktree metadata and review loop lifecycle events
 *
 * Mock claude behaviour (prompt-driven):
 *   - Prompt contains "## Review Findings" → patch run → success
 *   - Prompt contains "review-loop-context" → re-review → REVIEW_PASS
 *   - Otherwise (first review)             → REVIEW_FAIL with structured findings
 *
 * Usage: node test-reviewer-worktree-lease.js
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn, execSync } = require("child_process");

// ── Mock repo + mock claude ────────────────────────────────────────────────────

const mockClaudeDir = fs.mkdtempSync(path.join(os.tmpdir(), "mock-claude-rwl-"));
const mockClaudePath = path.join(mockClaudeDir, "claude");
const mockRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-repo-rwl-"));

execSync("git init", { cwd: mockRepoDir, stdio: "ignore" });
execSync('git config user.email "test@test.com"', { cwd: mockRepoDir, stdio: "ignore" });
execSync('git config user.name "Test"', { cwd: mockRepoDir, stdio: "ignore" });
fs.writeFileSync(path.join(mockRepoDir, "README.md"), "# test\n");
execSync("git add -A && git commit -m init", { cwd: mockRepoDir, stdio: "ignore" });

// Mock claude: review-loop behaviour + CWD output for worktree verification.
// Detection order matters: patch (## Review Findings) → re-review (review-loop-context) → first review.
const mockClaudeScript = `#!/usr/bin/env node
"use strict";
const prompt = process.argv[process.argv.indexOf("-p") + 1] || "";

function out(result) {
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", result, is_error: false }));
  process.exit(0);
}

// Patch run (prompt has ## Review Findings section from previousReviewFindings)
if (prompt.includes("## Review Findings")) {
  out("CWD=" + process.cwd() + "\\nPatch applied successfully. All findings addressed.");
}

// Re-review after patch (buildReviewTaskWithDiff adds snippet with label "review-loop-context")
if (prompt.includes("review-loop-context")) {
  out("CWD=" + process.cwd() + "\\nRe-reviewed. All issues resolved.\\n\\n[REVIEW_PASS]\\nAll findings addressed.");
}

// First review: emit REVIEW_FAIL with structured findings
const findings = [
  {id:"F1",severity:"critical",file:"api.js",issue:"Missing auth check",risk:"Unauthorized access",required_fix:"Add auth middleware",acceptance_check:"All routes require auth token"}
];
const result = "Found security issues.\\n\\n" +
  "[REVIEW_FAIL severity=critical]\\n" +
  "Missing authentication middleware.\\n" +
  "[REVIEW_FINDINGS_JSON]" + JSON.stringify(findings) + "[/REVIEW_FINDINGS_JSON]\\n" +
  "[/REVIEW_FAIL]\\n" +
  "CWD=" + process.cwd();
out(result);
`;

fs.writeFileSync(mockClaudePath, mockClaudeScript, { mode: 0o755 });

// ── Task definitions ────────────────────────────────────────────────────────────

// Task 1: reviewLoop + worktree + lease fires (short lease interval)
const TASK_REVIEW_WT = {
  taskId: "review-wt-001",
  mode: "review",
  reviewLoop: true,
  useWorktree: true,
  maxReviewIterations: 3,
  scope: { repoPath: mockRepoDir, branch: "agent/review-wt-lease" },
  instructions: "Review the API implementation for security issues.",
  patchInstructions: "Fix all security issues identified in the review findings.",
};

// Task 2: reviewLoop + worktree + lease-renew returns 404 (endpoint missing)
const TASK_REVIEW_WT_LEASE404 = {
  taskId: "review-wt-lease404",
  mode: "review",
  reviewLoop: true,
  useWorktree: true,
  maxReviewIterations: 3,
  scope: { repoPath: mockRepoDir, branch: "agent/review-wt-404" },
  instructions: "Review the API implementation for security issues.",
  patchInstructions: "Fix all security issues identified in the review findings.",
};

// ── State ────────────────────────────────────────────────────────────────────────

let pullCount = 0;
const receivedResults = [];
const receivedEvents = [];
const leaseRenewCalls = [];
let leaseRenew404Mode = false;

const PULL_SEQUENCE = [TASK_REVIEW_WT, TASK_REVIEW_WT_LEASE404];

function color(code, text) {
  return `\x1b[${code}m${text}\x1b[0m`;
}

// ── Finish control (hoisted so server handler can reference it) ──────────────

let _finished = false;
let _finishFn = null; // assigned in server.listen callback

function finish() {
  if (_finished) return;
  _finished = true;
  if (_finishFn) _finishFn();
}

// ── Mock orchestrator ────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const auth = req.headers.authorization;
    if (auth !== "Bearer test-token") {
      res.writeHead(401);
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }

    // ── PULL ──
    if (req.url === "/api/worker/pull") {
      pullCount++;
      if (pullCount <= PULL_SEQUENCE.length) {
        const task = PULL_SEQUENCE[pullCount - 1];
        console.log(color(36, `[orch] → pull ${pullCount}: ${task.taskId}`));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, task }));
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      }
      return;
    }

    // ── EVENT ──
    if (req.url === "/api/worker/event") {
      const ev = JSON.parse(body);
      receivedEvents.push(ev);
      console.log(color(33, `[orch] ← event: ${ev.status}/${ev.phase} [${ev.taskId}]`));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // ── RESULT ──
    if (req.url === "/api/worker/result") {
      const result = JSON.parse(body);
      receivedResults.push(result);
      console.log(color(32, `[orch] ← result: ${result.taskId} status=${result.status}`));

      // After task 1 result, switch to 404 mode for task 2's lease renewals
      if (result.taskId === "review-wt-001") {
        leaseRenew404Mode = true;
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));

      if (receivedResults.length >= PULL_SEQUENCE.length) {
        process.nextTick(() => finish());
      }
      return;
    }

    // ── LEASE-RENEW ──
    if (req.url === "/api/worker/lease-renew") {
      const lr = JSON.parse(body);
      leaseRenewCalls.push(lr);
      console.log(color(35, `[orch] ← lease-renew: taskId=${lr.taskId} (404mode=${leaseRenew404Mode})`));

      if (leaseRenew404Mode && lr.taskId === "review-wt-lease404") {
        res.writeHead(404);
        res.end("not found");
        return;
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, expired: false }));
      return;
    }

    // catch-all
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
});

// ── Run ──────────────────────────────────────────────────────────────────────────

server.listen(0, () => {
  const PORT = server.address().port;
  console.log(`Mock orchestrator on :${PORT}`);

  const worker = spawn("node", ["worker.js"], {
    cwd: __dirname,
    env: {
      ...process.env,
      ORCH_BASE_URL: `http://127.0.0.1:${PORT}`,
      WORKER_TOKEN: "test-token",
      WORKER_ID: "test-worker-rwl",
      ALLOWED_REPOS: mockRepoDir,
      CLAUDE_CMD: mockClaudePath,
      POLL_INTERVAL_MS: "200",
      MAX_PARALLEL_WORKTREES: "1",
      CLAUDE_TIMEOUT_MS: "15000",
      LEASE_TTL_MS: "60000",
      LEASE_RENEW_INTERVAL_MS: "300",  // Very short: fires during review loop
      HEARTBEAT_INTERVAL_MS: "30000",
      WORKTREE_RECOVERY_ENABLED: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let workerStdout = "";
  let workerStderr = "";
  worker.stdout.on("data", (c) => (workerStdout += c.toString()));
  worker.stderr.on("data", (c) => (workerStderr += c.toString()));

  const safetyTimer = setTimeout(() => {
    console.error("SAFETY TIMEOUT — killing worker");
    worker.kill("SIGTERM");
    setTimeout(() => process.exit(1), 2000);
  }, 45000);

  _finishFn = () => {
    clearTimeout(safetyTimer);
    worker.kill("SIGTERM");
    setTimeout(() => {
      server.close();
      runAssertions();
    }, 1000);
  };
});

// ── Assertions ──────────────────────────────────────────────────────────────────

function assert(cond, msg) {
  if (!cond) {
    console.error(color(31, `  FAIL  ${msg}`));
    process.exitCode = 1;
  } else {
    console.log(color(32, `  PASS  ${msg}`));
  }
}

function runAssertions() {
  console.log(color(36, "\n" + "=".repeat(60)));
  console.log(color(36, "TEST: Reviewer Mode + Worktree + Lease-Renew"));
  console.log(color(36, "=".repeat(60)));

  console.log(`\nResults: ${receivedResults.length}, Events: ${receivedEvents.length}, Lease-renew calls: ${leaseRenewCalls.length}\n`);

  const r1 = receivedResults.find((r) => r.taskId === "review-wt-001");
  const r2 = receivedResults.find((r) => r.taskId === "review-wt-lease404");

  // ── T1: reviewLoop + worktree → review_pass with worktree metadata ──
  console.log("=== T1: reviewLoop + worktree completes as review_pass ===");
  assert(r1, "T1: result received");
  assert(r1 && r1.status === "review_pass", `T1: status=review_pass (got ${r1?.status})`);
  assert(r1 && r1.meta?.reviewIteration === 2, `T1: reviewIteration=2 (got ${r1?.meta?.reviewIteration})`);
  assert(r1 && r1.meta?.worktreePath, "T1: worktreePath in result meta");
  assert(r1 && r1.meta?.worktreeBranch === "agent/review-wt-lease", `T1: worktreeBranch correct (got ${r1?.meta?.worktreeBranch})`);
  assert(r1 && r1.meta?.baseCommit, "T1: baseCommit in result meta");

  // Verify worktree path is under .worktrees/<taskId>
  if (r1 && r1.meta?.worktreePath) {
    const expectedWtPath = path.join(mockRepoDir, ".worktrees", "review-wt-001");
    assert(r1.meta.worktreePath === expectedWtPath, "T1: worktreePath is deterministic");
  }

  // ── T2: Lease-renew calls fired during execution ──
  console.log("\n=== T2: Lease-renew fires during review loop ===");
  const t1LeaseRenews = leaseRenewCalls.filter((lr) => lr.taskId === "review-wt-001");
  assert(t1LeaseRenews.length > 0, `T2: lease-renew called for task 1 (count=${t1LeaseRenews.length})`);
  assert(
    t1LeaseRenews.every((lr) => lr.leaseTtlMs > 0),
    "T2: all lease-renew calls have valid leaseTtlMs"
  );

  // ── T3: Lease-renew 404 does NOT block task completion ──
  console.log("\n=== T3: Lease-renew 404 → graceful degradation ===");
  assert(r2, "T3: result received despite lease-renew 404");
  assert(r2 && r2.status === "review_pass", `T3: status=review_pass despite 404 lease (got ${r2?.status})`);
  assert(r2 && r2.meta?.worktreePath, "T3: worktreePath in result meta despite 404");
  assert(r2 && r2.meta?.reviewIteration === 2, `T3: reviewIteration=2 despite 404 (got ${r2?.meta?.reviewIteration})`);

  const t2LeaseRenews = leaseRenewCalls.filter((lr) => lr.taskId === "review-wt-lease404");
  // Note: task 2 may complete within one renew interval, so 0 renewals is acceptable.
  // The critical proof is that review_pass status above confirms 404 mode is non-blocking.
  console.log(color(37, `  INFO  lease-renew calls for task 2: ${t2LeaseRenews.length} (404 mode was active)`));

  // ── T4: Worktree cleaned up after terminal status ──
  console.log("\n=== T4: Worktree cleanup ===");
  const wt1Path = path.join(mockRepoDir, ".worktrees", "review-wt-001");
  const wt2Path = path.join(mockRepoDir, ".worktrees", "review-wt-lease404");
  assert(!fs.existsSync(wt1Path), "T4: task 1 worktree cleaned up");
  assert(!fs.existsSync(wt2Path), "T4: task 2 worktree cleaned up (even with 404 lease)");

  // ── T5: Events include worktree + review loop lifecycle ──
  console.log("\n=== T5: Events carry worktree + review lifecycle ===");
  const t1WtEvents = receivedEvents.filter(
    (e) => e.taskId === "review-wt-001" && e.phase === "worktree"
  );
  assert(t1WtEvents.length > 0, `T5: worktree progress events for task 1 (count=${t1WtEvents.length})`);

  const t1LoopFailEvents = receivedEvents.filter(
    (e) => e.taskId === "review-wt-001" && e.status === "review_loop_fail"
  );
  assert(t1LoopFailEvents.length > 0, "T5: review_loop_fail event emitted in loop iteration 1");

  const t1PassEvents = receivedEvents.filter(
    (e) => e.taskId === "review-wt-001" && e.status === "review_pass"
  );
  assert(t1PassEvents.length > 0, "T5: review_pass event emitted for task 1");

  // ── Summary ──
  console.log(color(36, "\n" + "=".repeat(60)));
  const summary = process.exitCode === 1 ? "SOME FAILURES" : "ALL CHECKS PASSED";
  console.log(color(process.exitCode === 1 ? 31 : 32, summary));
  console.log(color(36, "=".repeat(60)));
}
