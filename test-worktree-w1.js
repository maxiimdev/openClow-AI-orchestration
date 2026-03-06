#!/usr/bin/env node
"use strict";

/**
 * Integration test: Worktree Stage W1 (base isolation).
 *
 * Covers:
 *   1. Worktree task creates isolated worktree, runs claude in it, reports metadata
 *   2. Worktree is cleaned up after terminal status (default)
 *   3. keepWorktree=true preserves the worktree path
 *   4. Legacy non-worktree task still works (backward compat)
 *   5. Claude runs in worktree path (not base repo)
 *
 * Port: 9879
 * Usage: node test-worktree-w1.js
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn, execSync } = require("child_process");

// ── Mock repo + mock claude ────────────────────────────────────────────────────

const mockClaudeDir = fs.mkdtempSync(path.join(os.tmpdir(), "mock-claude-wt-"));
const mockClaudePath = path.join(mockClaudeDir, "claude");
const mockRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-repo-wt-"));

execSync("git init", { cwd: mockRepoDir, stdio: "ignore" });
execSync('git config user.email "test@test.com"', { cwd: mockRepoDir, stdio: "ignore" });
execSync('git config user.name "Test"', { cwd: mockRepoDir, stdio: "ignore" });
fs.writeFileSync(path.join(mockRepoDir, "README.md"), "# test repo\n");
execSync("git add -A && git commit -m init", { cwd: mockRepoDir, stdio: "ignore" });

// Mock claude script: outputs CWD so we can verify worktree isolation
const mockClaudeScript = `#!/usr/bin/env node
"use strict";
const prompt = process.argv[process.argv.indexOf("-p") + 1] || "";

function out(result) {
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", result, is_error: false }));
  process.exit(0);
}

// All tasks: report the working directory so the test can verify isolation
out("CWD=" + process.cwd() + "\\nTask executed successfully.");
`;

fs.writeFileSync(mockClaudePath, mockClaudeScript, { mode: 0o755 });

// ── Test state ─────────────────────────────────────────────────────────────────

let pullCount = 0;
const results = [];
const events = [];
let resolveFinish;
const finished = new Promise((r) => (resolveFinish = r));

const TASKS = [
  // Task 1: useWorktree=true (default cleanup)
  {
    taskId: "wt-task-1",
    mode: "implement",
    useWorktree: true,
    instructions: "Implement worktree test 1",
    scope: { repoPath: mockRepoDir, branch: "feature/wt-test-1" },
  },
  // Task 2: useWorktree=true + keepWorktree=true
  {
    taskId: "wt-task-2",
    mode: "implement",
    useWorktree: true,
    keepWorktree: true,
    instructions: "Implement worktree test 2 (keep)",
    scope: { repoPath: mockRepoDir, branch: "feature/wt-test-2" },
  },
  // Task 3: legacy task (no useWorktree) — backward compat
  {
    taskId: "wt-task-3",
    mode: "implement",
    instructions: "Implement legacy test (no worktree)",
    scope: { repoPath: mockRepoDir, branch: "feature/wt-legacy" },
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
        // No more tasks — signal finish after a short delay
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, task: null }));
        if (pullCount === TASKS.length) {
          pullCount++; // only resolve once
          setTimeout(() => resolveFinish(), 500);
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

server.listen(0, () => {
  const PORT = server.address().port;
  console.log(`Mock orchestrator on :${PORT}`);

  const worker = spawn("node", ["worker.js"], {
    cwd: __dirname,
    env: {
      ...process.env,
      ORCH_BASE_URL: `http://127.0.0.1:${PORT}`,
      WORKER_TOKEN: "test-token",
      WORKER_ID: "test-worker-wt",
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

  // Safety timeout
  const safetyTimer = setTimeout(() => {
    console.error("SAFETY TIMEOUT — killing worker");
    worker.kill("SIGTERM");
    setTimeout(() => process.exit(1), 2000);
  }, 30000);

  finished.then(() => {
    clearTimeout(safetyTimer);
    worker.kill("SIGTERM");

    setTimeout(() => {
      server.close();
      runAssertions();
    }, 1000);
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
  console.log("\n=== Worktree W1 Test Results ===\n");
  console.log(`Results received: ${results.length}`);
  console.log(`Events received: ${events.length}`);

  // ── Task 1: worktree created, claude ran in worktree, cleaned up ──
  const r1 = results.find((r) => r.taskId === "wt-task-1");
  assert(r1, "Task 1 result received");
  assert(r1 && r1.status === "completed", `Task 1 status=completed (got ${r1?.status})`);

  // Worktree metadata in result
  assert(r1 && r1.meta.worktreePath, "Task 1 has worktreePath in meta");
  assert(r1 && r1.meta.baseCommit, "Task 1 has baseCommit in meta");
  assert(r1 && r1.meta.worktreeBranch === "feature/wt-test-1", `Task 1 worktreeBranch=feature/wt-test-1 (got ${r1?.meta?.worktreeBranch})`);

  // Verify worktree path is under .worktrees/<taskId>
  if (r1 && r1.meta.worktreePath) {
    const expectedWtPath = path.join(mockRepoDir, ".worktrees", "wt-task-1");
    assert(r1.meta.worktreePath === expectedWtPath, `Task 1 worktreePath is deterministic (${r1.meta.worktreePath})`);
  }

  // Claude ran in worktree (check CWD in stdout)
  if (r1 && r1.output) {
    const stdout = r1.output.stdout || "";
    const cwdMatch = stdout.match(/CWD=([^\n]+)/);
    if (cwdMatch) {
      const cwdUsed = cwdMatch[1];
      assert(cwdUsed.includes(".worktrees/wt-task-1"), `Task 1 claude ran in worktree dir (CWD=${cwdUsed})`);
      assert(!cwdUsed.endsWith(mockRepoDir), "Task 1 claude did NOT run in base repo");
    } else {
      assert(false, "Task 1: could not extract CWD from stdout");
    }
  }

  // Worktree should be cleaned up (default)
  const wt1Path = path.join(mockRepoDir, ".worktrees", "wt-task-1");
  assert(!fs.existsSync(wt1Path), `Task 1 worktree cleaned up (${wt1Path} should not exist)`);

  // Worktree events
  const wtEvents1 = events.filter((e) => e.taskId === "wt-task-1" && e.phase === "worktree");
  assert(wtEvents1.length > 0, "Task 1 has worktree progress event");

  // ── Task 2: keepWorktree=true preserves worktree ──
  const r2 = results.find((r) => r.taskId === "wt-task-2");
  assert(r2, "Task 2 result received");
  assert(r2 && r2.status === "completed", `Task 2 status=completed (got ${r2?.status})`);
  assert(r2 && r2.meta.worktreePath, "Task 2 has worktreePath in meta");

  const wt2Path = path.join(mockRepoDir, ".worktrees", "wt-task-2");
  assert(fs.existsSync(wt2Path), `Task 2 worktree preserved (keepWorktree=true) at ${wt2Path}`);

  // Clean up the kept worktree for test hygiene
  if (fs.existsSync(wt2Path)) {
    try {
      execSync(`git worktree remove --force "${wt2Path}"`, { cwd: mockRepoDir, stdio: "ignore" });
    } catch (_) {
      fs.rmSync(wt2Path, { recursive: true, force: true });
    }
  }

  // ── Task 3: legacy (no useWorktree) — backward compat ──
  const r3 = results.find((r) => r.taskId === "wt-task-3");
  assert(r3, "Task 3 result received");
  assert(r3 && r3.status === "completed", `Task 3 status=completed (got ${r3?.status})`);
  assert(r3 && !r3.meta.worktreePath, "Task 3 has NO worktreePath (legacy mode)");
  assert(r3 && !r3.meta.baseCommit, "Task 3 has NO baseCommit (legacy mode)");

  // Claude ran in base repo for legacy task
  if (r3 && r3.output) {
    const stdout = r3.output.stdout || "";
    const cwdMatch = stdout.match(/CWD=([^\n]+)/);
    if (cwdMatch) {
      const cwdUsed = cwdMatch[1];
      assert(!cwdUsed.includes(".worktrees"), `Task 3 legacy ran in base repo (CWD=${cwdUsed})`);
    }
  }

  // ── BaseCommit is valid SHA ──
  if (r1 && r1.meta.baseCommit) {
    assert(/^[0-9a-f]{40}$/.test(r1.meta.baseCommit), `Task 1 baseCommit is valid SHA (${r1.meta.baseCommit})`);
  }

  console.log("\n=== Done ===");

  // Cleanup temp dirs
  try { fs.rmSync(mockClaudeDir, { recursive: true, force: true }); } catch (_) {}
  try { fs.rmSync(mockRepoDir, { recursive: true, force: true }); } catch (_) {}

  process.exit(process.exitCode || 0);
}
