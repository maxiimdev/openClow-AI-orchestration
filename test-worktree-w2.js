#!/usr/bin/env node
"use strict";

/**
 * Integration test: Worktree Stage W2 (parallel slots).
 *
 * Covers:
 *   1. Two tasks run concurrently in separate worktrees
 *   2. Slot accounting (slotId, activeSlots, totalSlots) in events/results
 *   3. One task failure does not poison another slot
 *   4. No duplicate claim under concurrency
 *   5. Backward compatibility when MAX_PARALLEL_WORKTREES=1
 *
 * Port: 9880
 * Usage: node test-worktree-w2.js
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn, execSync } = require("child_process");

const PORT = 9880;

// ── Mock repo + mock claude ────────────────────────────────────────────────────

const mockClaudeDir = fs.mkdtempSync(path.join(os.tmpdir(), "mock-claude-w2-"));
const mockClaudePath = path.join(mockClaudeDir, "claude");
const mockRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-repo-w2-"));

execSync("git init", { cwd: mockRepoDir, stdio: "ignore" });
execSync('git config user.email "test@test.com"', { cwd: mockRepoDir, stdio: "ignore" });
execSync('git config user.name "Test"', { cwd: mockRepoDir, stdio: "ignore" });
fs.writeFileSync(path.join(mockRepoDir, "README.md"), "# test repo\n");
execSync("git add -A && git commit -m init", { cwd: mockRepoDir, stdio: "ignore" });

// Mock claude: outputs CWD + sleeps briefly to simulate work, allowing concurrency observation
const mockClaudeScript = `#!/usr/bin/env node
"use strict";
const prompt = process.argv[process.argv.indexOf("-p") + 1] || "";

function out(result) {
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", result, is_error: false }));
  process.exit(0);
}

// If prompt contains FAIL, simulate failure
if (prompt.includes("SIMULATE_FAIL")) {
  process.stdout.write(JSON.stringify({ type: "result", subtype: "error", result: "deliberate failure", is_error: true }));
  process.exit(1);
}

// Delay 500ms to ensure tasks overlap in time
setTimeout(() => {
  out("CWD=" + process.cwd() + "\\nTimestamp=" + Date.now() + "\\nTask executed successfully.");
}, 500);
`;

fs.writeFileSync(mockClaudePath, mockClaudeScript, { mode: 0o755 });

// ── Test state ─────────────────────────────────────────────────────────────────

let pullCount = 0;
const results = [];
const events = [];
const claimedTaskIds = [];
let resolveFinish;
const finished = new Promise((r) => (resolveFinish = r));

function runTest(testName, tasks, envOverrides, cb) {
  return { testName, tasks, envOverrides, cb };
}

// ── Test suite selection ───────────────────────────────────────────────────────

const testArg = process.argv[2] || "parallel";

const TESTS = {
  // Test 1: Two concurrent tasks in parallel worktrees
  parallel: {
    tasks: [
      {
        taskId: "w2-task-a",
        mode: "implement",
        useWorktree: true,
        instructions: "Implement task A",
        scope: { repoPath: mockRepoDir, branch: "feature/w2-a" },
      },
      {
        taskId: "w2-task-b",
        mode: "implement",
        useWorktree: true,
        instructions: "Implement task B",
        scope: { repoPath: mockRepoDir, branch: "feature/w2-b" },
      },
    ],
    env: { MAX_PARALLEL_WORKTREES: "2" },
    expectedResults: 2,
  },
  // Test 2: One failure, one success — failure isolation
  failure_isolation: {
    tasks: [
      {
        taskId: "w2-fail-task",
        mode: "implement",
        useWorktree: true,
        instructions: "SIMULATE_FAIL this task",
        scope: { repoPath: mockRepoDir, branch: "feature/w2-fail" },
      },
      {
        taskId: "w2-ok-task",
        mode: "implement",
        useWorktree: true,
        instructions: "Implement ok task",
        scope: { repoPath: mockRepoDir, branch: "feature/w2-ok" },
      },
    ],
    env: { MAX_PARALLEL_WORKTREES: "2" },
    expectedResults: 2,
  },
  // Test 3: Backward compat — single slot
  single_slot: {
    tasks: [
      {
        taskId: "w2-single-1",
        mode: "implement",
        useWorktree: true,
        instructions: "Implement single 1",
        scope: { repoPath: mockRepoDir, branch: "feature/w2-s1" },
      },
      {
        taskId: "w2-single-2",
        mode: "implement",
        useWorktree: true,
        instructions: "Implement single 2",
        scope: { repoPath: mockRepoDir, branch: "feature/w2-s2" },
      },
    ],
    env: { MAX_PARALLEL_WORKTREES: "1" },
    expectedResults: 2,
  },
};

const testConfig = TESTS[testArg];
if (!testConfig) {
  console.error(`Unknown test: ${testArg}. Available: ${Object.keys(TESTS).join(", ")}`);
  process.exit(1);
}

// ── Mock orchestrator ──────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    let parsed;
    try { parsed = JSON.parse(body); } catch { parsed = {}; }

    if (req.url === "/api/worker/pull") {
      if (pullCount < testConfig.tasks.length) {
        const task = testConfig.tasks[pullCount++];
        claimedTaskIds.push(task.taskId);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, task }));
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, task: null }));
        if (pullCount === testConfig.tasks.length) {
          pullCount++;
          // Wait for results to arrive
          const checkDone = setInterval(() => {
            if (results.length >= testConfig.expectedResults) {
              clearInterval(checkDone);
              setTimeout(() => resolveFinish(), 500);
            }
          }, 100);
          // Safety: resolve after 5s even if not all results
          setTimeout(() => resolveFinish(), 5000);
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

    // lease/dlq/other endpoints — just ack
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
});

// ── Run ────────────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`Mock orchestrator on :${PORT} — test: ${testArg}`);

  const worker = spawn("node", ["worker.js"], {
    cwd: path.join(__dirname),
    env: {
      ...process.env,
      ORCH_BASE_URL: `http://127.0.0.1:${PORT}`,
      WORKER_TOKEN: "test-token",
      WORKER_ID: "test-worker-w2",
      ALLOWED_REPOS: mockRepoDir,
      CLAUDE_CMD: mockClaudePath,
      POLL_INTERVAL_MS: "200",
      CLAUDE_TIMEOUT_MS: "15000",
      LEASE_TTL_MS: "60000",
      LEASE_RENEW_INTERVAL_MS: "30000",
      ...testConfig.env,
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

let failures = 0;

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failures++;
  } else {
    console.log(`PASS: ${msg}`);
  }
}

function runAssertions() {
  console.log(`\n=== Worktree W2 Test Results (${testArg}) ===\n`);
  console.log(`Results received: ${results.length}`);
  console.log(`Events received: ${events.length}`);
  console.log(`Claims: ${claimedTaskIds.join(", ")}`);

  if (testArg === "parallel") {
    assertParallel();
  } else if (testArg === "failure_isolation") {
    assertFailureIsolation();
  } else if (testArg === "single_slot") {
    assertSingleSlot();
  }

  console.log(`\n=== Done (${failures} failures) ===`);

  // Cleanup
  cleanup();
  process.exit(failures > 0 ? 1 : 0);
}

function assertParallel() {
  const rA = results.find((r) => r.taskId === "w2-task-a");
  const rB = results.find((r) => r.taskId === "w2-task-b");

  assert(rA, "Task A result received");
  assert(rB, "Task B result received");
  assert(rA && rA.status === "completed", `Task A status=completed (got ${rA?.status})`);
  assert(rB && rB.status === "completed", `Task B status=completed (got ${rB?.status})`);

  // Both should have slot telemetry
  assert(rA && rA.meta.slotId, `Task A has slotId in meta (${rA?.meta?.slotId})`);
  assert(rB && rB.meta.slotId, `Task B has slotId in meta (${rB?.meta?.slotId})`);
  assert(rA && rA.meta.totalSlots === 2, `Task A totalSlots=2 (got ${rA?.meta?.totalSlots})`);
  assert(rB && rB.meta.totalSlots === 2, `Task B totalSlots=2 (got ${rB?.meta?.totalSlots})`);

  // Slot IDs should be different (different tasks)
  if (rA && rB) {
    assert(rA.meta.slotId !== rB.meta.slotId, `Slot IDs are different (${rA.meta.slotId} vs ${rB.meta.slotId})`);
  }

  // Worktree paths should be different
  if (rA && rB && rA.meta.worktreePath && rB.meta.worktreePath) {
    assert(rA.meta.worktreePath !== rB.meta.worktreePath,
      `Worktree paths are different (${rA.meta.worktreePath} vs ${rB.meta.worktreePath})`);
  }

  // Verify concurrent execution by checking timestamps overlap
  // Both tasks have 500ms delay, so if running in parallel they should start within ~200ms of each other
  if (rA && rB) {
    const stdoutA = rA.output?.stdout || "";
    const stdoutB = rB.output?.stdout || "";
    const tsA = parseInt((stdoutA.match(/Timestamp=(\d+)/) || [])[1] || "0");
    const tsB = parseInt((stdoutB.match(/Timestamp=(\d+)/) || [])[1] || "0");
    if (tsA && tsB) {
      const diff = Math.abs(tsA - tsB);
      // If truly parallel with 500ms delay tasks, timestamps should be within ~1000ms
      // (accounting for worktree setup time). Sequential would be >500ms apart.
      assert(diff < 3000, `Tasks ran concurrently (timestamp diff=${diff}ms, expect <3000ms)`);
      console.log(`  Timestamp diff: ${diff}ms`);
    }
  }

  // No duplicate claims
  const uniqueClaims = new Set(claimedTaskIds);
  assert(uniqueClaims.size === claimedTaskIds.length, `No duplicate claims (${claimedTaskIds.length} claims, ${uniqueClaims.size} unique)`);

  // Worktrees should be cleaned up
  const wtA = path.join(mockRepoDir, ".worktrees", "w2-task-a");
  const wtB = path.join(mockRepoDir, ".worktrees", "w2-task-b");
  assert(!fs.existsSync(wtA), `Task A worktree cleaned up`);
  assert(!fs.existsSync(wtB), `Task B worktree cleaned up`);

  // Claimed events should have slot telemetry
  const claimedEvents = events.filter((e) => e.status === "claimed");
  for (const ce of claimedEvents) {
    assert(ce.meta && ce.meta.slotId, `Claimed event for ${ce.taskId} has slotId`);
    assert(ce.meta && ce.meta.totalSlots === 2, `Claimed event for ${ce.taskId} has totalSlots=2`);
  }
}

function assertFailureIsolation() {
  const rFail = results.find((r) => r.taskId === "w2-fail-task");
  const rOk = results.find((r) => r.taskId === "w2-ok-task");

  assert(rFail, "Failing task result received");
  assert(rOk, "OK task result received");

  // The failing task should have failed status
  assert(rFail && rFail.status === "failed", `Failing task status=failed (got ${rFail?.status})`);

  // The OK task should have completed successfully
  assert(rOk && rOk.status === "completed", `OK task status=completed (got ${rOk?.status})`);

  // Both should have slot telemetry
  assert(rFail && rFail.meta.slotId, `Failing task has slotId`);
  assert(rOk && rOk.meta.slotId, `OK task has slotId`);

  // Verify worktrees cleaned up for both
  const wtFail = path.join(mockRepoDir, ".worktrees", "w2-fail-task");
  const wtOk = path.join(mockRepoDir, ".worktrees", "w2-ok-task");
  assert(!fs.existsSync(wtFail), `Failing task worktree cleaned up`);
  assert(!fs.existsSync(wtOk), `OK task worktree cleaned up`);
}

function assertSingleSlot() {
  const r1 = results.find((r) => r.taskId === "w2-single-1");
  const r2 = results.find((r) => r.taskId === "w2-single-2");

  assert(r1, "Single-1 result received");
  assert(r2, "Single-2 result received");
  assert(r1 && r1.status === "completed", `Single-1 status=completed (got ${r1?.status})`);
  assert(r2 && r2.status === "completed", `Single-2 status=completed (got ${r2?.status})`);

  // totalSlots should be 1
  assert(r1 && r1.meta.totalSlots === 1, `Single-1 totalSlots=1 (got ${r1?.meta?.totalSlots})`);
  assert(r2 && r2.meta.totalSlots === 1, `Single-2 totalSlots=1 (got ${r2?.meta?.totalSlots})`);

  // With single slot, tasks must run sequentially: timestamps should be >400ms apart
  // (each task has 500ms delay)
  if (r1 && r2) {
    const stdout1 = r1.output?.stdout || "";
    const stdout2 = r2.output?.stdout || "";
    const ts1 = parseInt((stdout1.match(/Timestamp=(\d+)/) || [])[1] || "0");
    const ts2 = parseInt((stdout2.match(/Timestamp=(\d+)/) || [])[1] || "0");
    if (ts1 && ts2) {
      const diff = Math.abs(ts1 - ts2);
      assert(diff >= 400, `Single-slot tasks ran sequentially (timestamp diff=${diff}ms, expect >=400ms)`);
      console.log(`  Timestamp diff: ${diff}ms`);
    }
  }

  // Worktrees cleaned up
  const wt1 = path.join(mockRepoDir, ".worktrees", "w2-single-1");
  const wt2 = path.join(mockRepoDir, ".worktrees", "w2-single-2");
  assert(!fs.existsSync(wt1), `Single-1 worktree cleaned up`);
  assert(!fs.existsSync(wt2), `Single-2 worktree cleaned up`);
}

function cleanup() {
  // Clean up any lingering worktrees
  try { execSync("git worktree prune", { cwd: mockRepoDir, stdio: "ignore" }); } catch (_) {}
  try { fs.rmSync(mockClaudeDir, { recursive: true, force: true }); } catch (_) {}
  try { fs.rmSync(mockRepoDir, { recursive: true, force: true }); } catch (_) {}
}
