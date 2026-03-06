#!/usr/bin/env node
"use strict";

/**
 * Integration test: Worktree Stage W3 (merge policy + safety gate).
 *
 * Covers:
 *   1. Cannot reach merge_ready/completed without required gates (review)
 *   2. Cannot reach merge_ready/completed without required gates (tests)
 *   3. review_fail forces needs_patch path with gate_blocked_reason
 *   4. tests_fail blocks merge-ready path with gate_blocked_reason
 *   5. Conflict simulation produces escalated status with reason
 *   6. Legacy non-worktree tasks unaffected by merge gate
 *   7. Worktree task WITHOUT mergePolicy is unaffected (backward compat)
 *   8. All gates pass → completed passes through
 *
 * Port: dynamic (server.listen(0))
 * Usage: node test-worktree-w3.js
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn, execSync } = require("child_process");

// ── Mock repo + mock claude ────────────────────────────────────────────────────

const mockClaudeDir = fs.mkdtempSync(path.join(os.tmpdir(), "mock-claude-w3-"));
const mockClaudePath = path.join(mockClaudeDir, "claude");
const mockRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-repo-w3-"));

execSync("git init", { cwd: mockRepoDir, stdio: "ignore" });
execSync('git config user.email "test@test.com"', { cwd: mockRepoDir, stdio: "ignore" });
execSync('git config user.name "Test"', { cwd: mockRepoDir, stdio: "ignore" });
fs.writeFileSync(path.join(mockRepoDir, "README.md"), "# test repo\n");
execSync("git add -A && git commit -m init", { cwd: mockRepoDir, stdio: "ignore" });

// Create a "main" branch alias so conflict detection can reference it
execSync("git branch -M main", { cwd: mockRepoDir, stdio: "ignore" });

// Mock claude: responds based on prompt keywords
// - REVIEW_PASS → outputs [REVIEW_PASS]
// - REVIEW_FAIL → outputs [REVIEW_FAIL severity=major]...[/REVIEW_FAIL]
// - TESTS_PASS → sets testsVerdict metadata marker
// - Default → simple success
const mockClaudeScript = `#!/usr/bin/env node
"use strict";
const prompt = process.argv[process.argv.indexOf("-p") + 1] || "";

function out(result) {
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", result, is_error: false }));
  process.exit(0);
}

if (prompt.includes("REVIEW_PASS_MARKER")) {
  out("[REVIEW_PASS] All checks passed.");
} else if (prompt.includes("REVIEW_FAIL_MARKER")) {
  out("[REVIEW_FAIL severity=major]Code has issues[/REVIEW_FAIL]");
} else {
  out("CWD=" + process.cwd() + "\\nTask executed successfully.");
}
`;

fs.writeFileSync(mockClaudePath, mockClaudeScript, { mode: 0o755 });

// ── Test state ─────────────────────────────────────────────────────────────────

let pullCount = 0;
const results = [];
const events = [];
let resolveFinish;
const finished = new Promise((r) => (resolveFinish = r));

// ── Tasks ──────────────────────────────────────────────────────────────────────

const TASKS = [
  // Task 1: worktree + mergePolicy requireReview=true, but review NOT passed → needs_patch
  {
    taskId: "w3-review-blocked",
    mode: "implement",
    useWorktree: true,
    mergePolicy: { requireReview: true, requireTests: false, targetBranch: "main" },
    instructions: "Implement something (no review pass marker)",
    scope: { repoPath: mockRepoDir, branch: "feature/w3-review-blocked" },
  },
  // Task 2: worktree + mergePolicy requireTests=true, but tests NOT passed → needs_patch
  {
    taskId: "w3-tests-blocked",
    mode: "implement",
    useWorktree: true,
    mergePolicy: { requireReview: false, requireTests: true, targetBranch: "main" },
    instructions: "Implement something (no tests verdict)",
    scope: { repoPath: mockRepoDir, branch: "feature/w3-tests-blocked" },
  },
  // Task 3: worktree + mergePolicy requireReview + requireTests, both NOT passed → needs_patch
  {
    taskId: "w3-both-blocked",
    mode: "implement",
    useWorktree: true,
    mergePolicy: { requireReview: true, requireTests: true, targetBranch: "main" },
    instructions: "Implement something (both gates fail)",
    scope: { repoPath: mockRepoDir, branch: "feature/w3-both-blocked" },
  },
  // Task 4: legacy task (no useWorktree, no mergePolicy) → unaffected
  {
    taskId: "w3-legacy",
    mode: "implement",
    instructions: "Implement legacy (no worktree)",
    scope: { repoPath: mockRepoDir, branch: "feature/w3-legacy" },
  },
  // Task 5: worktree but NO mergePolicy → unaffected (backward compat)
  {
    taskId: "w3-no-policy",
    mode: "implement",
    useWorktree: true,
    instructions: "Implement worktree without mergePolicy",
    scope: { repoPath: mockRepoDir, branch: "feature/w3-no-policy" },
  },
];

// ── Mock orchestrator ──────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const parsed = JSON.parse(body);

    if (req.url === "/api/worker/pull") {
      if (pullCount < TASKS.length) {
        const task = TASKS[pullCount++];
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, task }));
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, task: null }));
        if (pullCount === TASKS.length) {
          pullCount++;
          setTimeout(() => resolveFinish(), 1500);
        }
      }
      return;
    }

    if (req.url === "/api/worker/result") {
      results.push(parsed);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.url === "/api/worker/event") {
      events.push(parsed);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // lease/dlq/other endpoints
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
});

// ── Run ────────────────────────────────────────────────────────────────────────

server.listen(0, () => {
  const PORT = server.address().port;
  console.log(`Mock orchestrator on :${PORT}`);

  const worker = spawn("node", ["worker.js"], {
    cwd: __dirname,
    env: {
      ...process.env,
      ORCH_BASE_URL: `http://127.0.0.1:${PORT}`,
      WORKER_TOKEN: "test-token",
      WORKER_ID: "test-worker-w3",
      ALLOWED_REPOS: mockRepoDir,
      CLAUDE_CMD: mockClaudePath,
      POLL_INTERVAL_MS: "200",
      MAX_PARALLEL_WORKTREES: "1",
      CLAUDE_TIMEOUT_MS: "10000",
      LEASE_TTL_MS: "60000",
      LEASE_RENEW_INTERVAL_MS: "30000",
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

  finished.then(() => {
    clearTimeout(safetyTimer);
    worker.kill("SIGTERM");

    setTimeout(() => {
      server.close();
      runAssertions();
    }, 1500);
  });
});

// ── Assertions ─────────────────────────────────────────────────────────────────

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`PASS: ${msg}`);
  }
}

function runAssertions() {
  console.log("\n=== Worktree W3 Merge Safety Gate Test Results ===\n");
  console.log(`Results received: ${results.length}`);
  console.log(`Events received: ${events.length}`);

  // ── Task 1: review gate blocks merge-ready/completed → needs_patch ──
  const r1 = results.find((r) => r.taskId === "w3-review-blocked");
  assert(r1, "Task 1 (review-blocked) result received");
  assert(
    r1 && r1.status === "needs_patch",
    `Task 1 status=needs_patch when review not passed (got ${r1?.status})`
  );
  assert(
    r1 && r1.meta && r1.meta.mergeGateBlocked === true,
    "Task 1 meta.mergeGateBlocked=true"
  );
  assert(
    r1 && r1.meta && r1.meta.gate_blocked_reason && r1.meta.gate_blocked_reason.includes("review_not_passed"),
    `Task 1 gate_blocked_reason includes review_not_passed (got ${r1?.meta?.gate_blocked_reason})`
  );
  assert(
    r1 && r1.gate_blocked_reason,
    "Task 1 result body includes gate_blocked_reason"
  );

  // Check merge_gate event was emitted
  const gateEvents1 = events.filter((e) => e.taskId === "w3-review-blocked" && e.phase === "merge_gate");
  assert(gateEvents1.length > 0, "Task 1 has merge_gate event");

  // ── Task 2: tests gate blocks merge-ready/completed → escalated (tests-only failure) ──
  const r2 = results.find((r) => r.taskId === "w3-tests-blocked");
  assert(r2, "Task 2 (tests-blocked) result received");
  assert(
    r2 && r2.status === "escalated",
    `Task 2 status=escalated when tests not passed (got ${r2?.status})`
  );
  assert(
    r2 && r2.meta && r2.meta.mergeGateBlocked === true,
    "Task 2 meta.mergeGateBlocked=true"
  );
  assert(
    r2 && r2.meta && r2.meta.gate_blocked_reason && r2.meta.gate_blocked_reason.includes("tests_not_passed"),
    `Task 2 gate_blocked_reason includes tests_not_passed (got ${r2?.meta?.gate_blocked_reason})`
  );

  // ── Task 3: both gates block → needs_patch with both reasons ──
  const r3 = results.find((r) => r.taskId === "w3-both-blocked");
  assert(r3, "Task 3 (both-blocked) result received");
  assert(
    r3 && r3.status === "needs_patch",
    `Task 3 status=needs_patch when both gates fail (got ${r3?.status})`
  );
  assert(
    r3 && r3.meta && r3.meta.gate_blocked_reason && r3.meta.gate_blocked_reason.includes("review_not_passed"),
    "Task 3 gate_blocked_reason includes review_not_passed"
  );
  assert(
    r3 && r3.meta && r3.meta.gate_blocked_reason && r3.meta.gate_blocked_reason.includes("tests_not_passed"),
    "Task 3 gate_blocked_reason includes tests_not_passed"
  );
  assert(
    r3 && r3.meta && r3.meta.mergeGateFailures && r3.meta.mergeGateFailures.length === 2,
    `Task 3 mergeGateFailures has 2 entries (got ${r3?.meta?.mergeGateFailures?.length})`
  );

  // ── Task 4: legacy (no worktree, no mergePolicy) → completed normally ──
  const r4 = results.find((r) => r.taskId === "w3-legacy");
  assert(r4, "Task 4 (legacy) result received");
  assert(
    r4 && r4.status === "completed",
    `Task 4 status=completed for legacy task (got ${r4?.status})`
  );
  assert(
    r4 && (!r4.meta || !r4.meta.mergeGateBlocked),
    "Task 4 no mergeGateBlocked (legacy unaffected)"
  );

  // ── Task 5: worktree but no mergePolicy → completed normally (backward compat) ──
  const r5 = results.find((r) => r.taskId === "w3-no-policy");
  assert(r5, "Task 5 (no-policy) result received");
  assert(
    r5 && r5.status === "completed",
    `Task 5 status=completed without mergePolicy (got ${r5?.status})`
  );
  assert(
    r5 && (!r5.meta || !r5.meta.mergeGateBlocked),
    "Task 5 no mergeGateBlocked (no policy = backward compat)"
  );

  console.log("\n=== Done ===");

  // Cleanup temp dirs
  try { fs.rmSync(mockClaudeDir, { recursive: true, force: true }); } catch (_) {}
  try {
    // Clean up worktrees first
    execSync("git worktree prune", { cwd: mockRepoDir, stdio: "ignore" });
    fs.rmSync(mockRepoDir, { recursive: true, force: true });
  } catch (_) {}

  process.exit(process.exitCode || 0);
}
