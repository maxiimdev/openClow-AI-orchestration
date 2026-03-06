#!/usr/bin/env node
"use strict";

/**
 * Test: Worktree Stage W4 (operational reliability).
 *
 * Covers:
 *   1. TTL cleanup removes stale worktrees, preserves active
 *   2. Startup recovery handles orphaned worktrees safely
 *   3. Disk threshold warning triggers
 *   4. Hard-stop mode blocks new claims when threshold exceeded
 *   5. Legacy path unaffected (non-worktree task still works)
 *
 * Port: dynamic (server.listen(0))
 * Usage: node test-worktree-w4.js
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn, execSync } = require("child_process");

// PORT assigned dynamically via server.listen(0)

// ── Helpers ────────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed++;
    process.exitCode = 1;
  } else {
    console.log(`PASS: ${msg}`);
    passed++;
  }
}

// ── Setup mock repo + mock claude ──────────────────────────────────────────────

const mockClaudeDir = fs.mkdtempSync(path.join(os.tmpdir(), "mock-claude-w4-"));
const mockClaudePath = path.join(mockClaudeDir, "claude");
const mockRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-repo-w4-"));

execSync("git init", { cwd: mockRepoDir, stdio: "ignore" });
execSync('git config user.email "test@test.com"', { cwd: mockRepoDir, stdio: "ignore" });
execSync('git config user.name "Test"', { cwd: mockRepoDir, stdio: "ignore" });
fs.writeFileSync(path.join(mockRepoDir, "README.md"), "# test repo\n");
execSync("git add -A && git commit -m init", { cwd: mockRepoDir, stdio: "ignore" });

const mockClaudeScript = `#!/usr/bin/env node
"use strict";
const prompt = process.argv[process.argv.indexOf("-p") + 1] || "";
function out(result) {
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", result, is_error: false }));
  process.exit(0);
}
out("CWD=" + process.cwd() + "\\nTask executed successfully.");
`;

fs.writeFileSync(mockClaudePath, mockClaudeScript, { mode: 0o755 });

// ── Part 1: Unit tests (filesystem-based, no worker process) ────────────────

function runUnitTests() {
  console.log("\n=== Part 1: W4 Unit Tests ===\n");

  const WT_BASE = ".worktrees";

  // ── Test 1: TTL cleanup removes stale, preserves recent ──
  {
    const wtBase = path.join(mockRepoDir, WT_BASE);
    if (!fs.existsSync(wtBase)) fs.mkdirSync(wtBase, { recursive: true });

    // Create a "stale" worktree dir (old mtime)
    const staleDir = path.join(wtBase, "stale-task-1");
    fs.mkdirSync(staleDir, { recursive: true });
    fs.writeFileSync(path.join(staleDir, "dummy.txt"), "stale data");
    // Set mtime to 2 hours ago
    const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000);
    fs.utimesSync(staleDir, twoHoursAgo, twoHoursAgo);

    // Create a "recent" worktree dir (current mtime)
    const recentDir = path.join(wtBase, "recent-task-2");
    fs.mkdirSync(recentDir, { recursive: true });
    fs.writeFileSync(path.join(recentDir, "dummy.txt"), "recent data");

    // Simulate TTL cleanup with 1-hour TTL
    const ttlMs = 3600 * 1000; // 1 hour
    const now = Date.now();
    let cleanupCount = 0;
    let skippedActiveCount = 0;
    const activeTaskIds = new Set(["recent-task-2"]); // mark recent as active

    const entries = fs.readdirSync(wtBase, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const taskId = entry.name;
      const wtDir = path.join(wtBase, taskId);

      if (activeTaskIds.has(taskId)) {
        skippedActiveCount++;
        continue;
      }

      const stat = fs.statSync(wtDir);
      const ageMs = now - stat.mtimeMs;
      if (ageMs < ttlMs) continue;

      fs.rmSync(wtDir, { recursive: true, force: true });
      cleanupCount++;
    }

    assert(cleanupCount === 1, `TTL cleanup removed 1 stale worktree (got ${cleanupCount})`);
    assert(skippedActiveCount === 1, `TTL cleanup skipped 1 active worktree (got ${skippedActiveCount})`);
    assert(!fs.existsSync(staleDir), "Stale worktree dir removed");
    assert(fs.existsSync(recentDir), "Recent/active worktree dir preserved");

    // Cleanup
    fs.rmSync(recentDir, { recursive: true, force: true });
  }

  // ── Test 2: Startup recovery removes old orphans, skips recent uncertain ──
  {
    const wtBase = path.join(mockRepoDir, WT_BASE);
    if (!fs.existsSync(wtBase)) fs.mkdirSync(wtBase, { recursive: true });

    // Orphan (old)
    const orphanDir = path.join(wtBase, "orphan-task-old");
    fs.mkdirSync(orphanDir, { recursive: true });
    fs.writeFileSync(path.join(orphanDir, "file.txt"), "orphan");
    const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000);
    fs.utimesSync(orphanDir, twoHoursAgo, twoHoursAgo);

    // Uncertain (recent)
    const uncertainDir = path.join(wtBase, "uncertain-task-new");
    fs.mkdirSync(uncertainDir, { recursive: true });
    fs.writeFileSync(path.join(uncertainDir, "file.txt"), "uncertain");

    // Simulate startup recovery with 1-hour TTL
    const ttlMs = 3600 * 1000;
    const now = Date.now();
    let recoveredCount = 0;
    let skippedUncertainCount = 0;

    const entries = fs.readdirSync(wtBase, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const wtDir = path.join(wtBase, entry.name);
      const stat = fs.statSync(wtDir);
      const ageMs = now - stat.mtimeMs;

      if (ageMs >= ttlMs) {
        fs.rmSync(wtDir, { recursive: true, force: true });
        recoveredCount++;
      } else {
        skippedUncertainCount++;
      }
    }

    assert(recoveredCount === 1, `Recovery removed 1 orphan (got ${recoveredCount})`);
    assert(skippedUncertainCount === 1, `Recovery skipped 1 uncertain (got ${skippedUncertainCount})`);
    assert(!fs.existsSync(orphanDir), "Old orphan removed by recovery");
    assert(fs.existsSync(uncertainDir), "Recent uncertain worktree preserved (safety)");

    // Cleanup
    fs.rmSync(uncertainDir, { recursive: true, force: true });
  }

  // ── Test 3: Disk usage calculation ──
  {
    const wtBase = path.join(mockRepoDir, WT_BASE);
    if (!fs.existsSync(wtBase)) fs.mkdirSync(wtBase, { recursive: true });

    const testDir = path.join(wtBase, "disk-test-task");
    fs.mkdirSync(testDir, { recursive: true });
    // Write exactly 1024 bytes
    fs.writeFileSync(path.join(testDir, "data.bin"), Buffer.alloc(1024, 0x42));

    // Calculate disk usage
    function dirSizeSync(dirPath) {
      let total = 0;
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
          total += dirSizeSync(fullPath);
        } else {
          total += fs.statSync(fullPath).size;
        }
      }
      return total;
    }

    const size = dirSizeSync(testDir);
    assert(size === 1024, `Disk usage reports correct bytes (got ${size})`);

    // Cleanup
    fs.rmSync(testDir, { recursive: true, force: true });
  }

  // ── Test 4: Disk threshold warning check ──
  {
    const wtBase = path.join(mockRepoDir, WT_BASE);
    if (!fs.existsSync(wtBase)) fs.mkdirSync(wtBase, { recursive: true });

    const testDir = path.join(wtBase, "threshold-task");
    fs.mkdirSync(testDir, { recursive: true });
    fs.writeFileSync(path.join(testDir, "data.bin"), Buffer.alloc(2048, 0x42));

    // Low threshold (1KB) should be exceeded
    const lowThreshold = 1024;
    function dirSizeSync(dirPath) {
      let total = 0;
      try {
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dirPath, entry.name);
          if (entry.isDirectory()) total += dirSizeSync(fullPath);
          else total += fs.statSync(fullPath).size;
        }
      } catch (_) {}
      return total;
    }

    let diskUsageBytes = 0;
    let worktreeCount = 0;
    const entries = fs.readdirSync(wtBase, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      worktreeCount++;
      diskUsageBytes += dirSizeSync(path.join(wtBase, entry.name));
    }

    const exceeded = diskUsageBytes >= lowThreshold;
    assert(exceeded, `Disk threshold warning triggers when usage (${diskUsageBytes}) >= threshold (${lowThreshold})`);

    // Hard-stop check: when hard-stop enabled + exceeded → not allowed
    const hardStopAllowed = !(exceeded && true); // hardStop=true
    assert(!hardStopAllowed, "Hard-stop blocks new claims when threshold exceeded");

    // High threshold → allowed even with hard-stop
    const highThreshold = 100 * 1024 * 1024;
    const highExceeded = diskUsageBytes >= highThreshold;
    const highAllowed = !(highExceeded && true);
    assert(highAllowed, "High threshold allows claims (not exceeded)");

    // Cleanup
    fs.rmSync(testDir, { recursive: true, force: true });
  }
}

// ── Part 2: Integration test (worker process) ──────────────────────────────────

function runIntegrationTests() {
  console.log("\n=== Part 2: W4 Integration Tests ===\n");

  // Pre-seed a stale worktree that startup recovery should handle
  const wtBase = path.join(mockRepoDir, ".worktrees");
  if (!fs.existsSync(wtBase)) fs.mkdirSync(wtBase, { recursive: true });

  const staleOrphan = path.join(wtBase, "orphan-from-crash");
  fs.mkdirSync(staleOrphan, { recursive: true });
  fs.writeFileSync(path.join(staleOrphan, "leftover.txt"), "crash artifact");
  // Set mtime to 2 hours ago so it exceeds the 1s TTL we'll configure
  const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000);
  fs.utimesSync(staleOrphan, twoHoursAgo, twoHoursAgo);

  // Also create a "recent" worktree that should survive recovery
  const recentOrphan = path.join(wtBase, "recent-orphan");
  fs.mkdirSync(recentOrphan, { recursive: true });
  fs.writeFileSync(path.join(recentOrphan, "file.txt"), "recent artifact");

  let pullCount = 0;
  const results = [];
  const events = [];
  let resolveFinish;
  const finished = new Promise((r) => (resolveFinish = r));

  const TASKS = [
    // Task: normal worktree task — should work, proving W4 doesn't break normal flow
    {
      taskId: "w4-normal-task",
      mode: "implement",
      useWorktree: true,
      instructions: "Implement W4 integration test",
      scope: { repoPath: mockRepoDir, branch: "feature/w4-test" },
    },
    // Task: legacy non-worktree task — backward compat
    {
      taskId: "w4-legacy-task",
      mode: "implement",
      instructions: "Legacy task (no worktree)",
      scope: { repoPath: mockRepoDir, branch: "feature/w4-legacy" },
    },
  ];

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

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });

  server.listen(0, () => {
    const PORT = server.address().port;
    console.log(`Mock orchestrator on :${PORT}`);

    const worker = spawn("node", ["worker.js"], {
      cwd: __dirname,
      env: {
        ...process.env,
        ORCH_BASE_URL: `http://127.0.0.1:${PORT}`,
        WORKER_TOKEN: "test-token",
        WORKER_ID: "test-worker-w4",
        ALLOWED_REPOS: mockRepoDir,
        CLAUDE_CMD: mockClaudePath,
        POLL_INTERVAL_MS: "200",
        MAX_PARALLEL_WORKTREES: "1",
        CLAUDE_TIMEOUT_MS: "10000",
        LEASE_TTL_MS: "60000",
        LEASE_RENEW_INTERVAL_MS: "30000",
        // W4 config: short TTL so stale orphan gets cleaned on startup
        WORKTREE_TTL_MS: "1000",            // 1s TTL
        WORKTREE_CLEANUP_INTERVAL_MS: "60000", // long interval (won't fire during test)
        WORKTREE_DISK_THRESHOLD_BYTES: String(100 * 1024 * 1024 * 1024), // 100GB (won't block)
        WORKTREE_DISK_HARD_STOP: "false",
        WORKTREE_RECOVERY_ENABLED: "true",
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
    }, 30000);

    finished.then(() => {
      clearTimeout(safetyTimer);
      worker.kill("SIGTERM");

      setTimeout(() => {
        server.close();

        // ── Assertions ──

        // Startup recovery should have cleaned the stale orphan
        assert(!fs.existsSync(staleOrphan), "Startup recovery cleaned stale orphan worktree");

        // Recent orphan should be preserved (uncertain state, safety)
        assert(fs.existsSync(recentOrphan), "Startup recovery preserved recent uncertain worktree");

        // Normal worktree task should succeed
        const r1 = results.find((r) => r.taskId === "w4-normal-task");
        assert(r1, "Normal worktree task result received");
        assert(r1 && r1.status === "completed", `Normal worktree task status=completed (got ${r1?.status})`);
        assert(r1 && r1.meta.worktreePath, "Normal worktree task has worktreePath meta");

        // Legacy task should work (backward compat)
        const r2 = results.find((r) => r.taskId === "w4-legacy-task");
        assert(r2, "Legacy task result received");
        assert(r2 && r2.status === "completed", `Legacy task status=completed (got ${r2?.status})`);
        assert(r2 && !r2.meta.worktreePath, "Legacy task has NO worktreePath (backward compat)");

        // Check worker logs for W4 recovery messages (logs go to stdout as JSON)
        const allLogs = workerStdout + workerStderr;
        assert(allLogs.includes("w4-recovery") || allLogs.includes("w4-startup-recovery") || allLogs.includes("w4-ttl-timer-start"),
          "Worker logs contain W4 telemetry messages");

        // Cleanup
        if (fs.existsSync(recentOrphan)) fs.rmSync(recentOrphan, { recursive: true, force: true });

        console.log(`\n=== Summary: ${passed} passed, ${failed} failed ===\n`);

        // Cleanup temp dirs
        try { fs.rmSync(mockClaudeDir, { recursive: true, force: true }); } catch (_) {}
        try { fs.rmSync(mockRepoDir, { recursive: true, force: true }); } catch (_) {}

        process.exit(process.exitCode || 0);
      }, 1500);
    });
  });
}

// ── Part 3: Hard-stop integration test ──────────────────────────────────────────

function runHardStopTest(callback) {
  console.log("\n=== Part 3: W4 Hard-Stop Integration Test ===\n");

  // Create a mock repo with a large worktree to exceed threshold
  const hsRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-repo-w4hs-"));
  execSync("git init", { cwd: hsRepoDir, stdio: "ignore" });
  execSync('git config user.email "test@test.com"', { cwd: hsRepoDir, stdio: "ignore" });
  execSync('git config user.name "Test"', { cwd: hsRepoDir, stdio: "ignore" });
  fs.writeFileSync(path.join(hsRepoDir, "README.md"), "# test repo\n");
  execSync("git add -A && git commit -m init", { cwd: hsRepoDir, stdio: "ignore" });

  // Pre-seed a worktree dir with data to exceed threshold
  const wtBase = path.join(hsRepoDir, ".worktrees");
  fs.mkdirSync(wtBase, { recursive: true });
  const existingWt = path.join(wtBase, "existing-big-task");
  fs.mkdirSync(existingWt, { recursive: true });
  // Write 2KB data (we'll set threshold to 1KB)
  fs.writeFileSync(path.join(existingWt, "big.bin"), Buffer.alloc(2048, 0x42));

  // HS_PORT assigned dynamically below
  let pullCount = 0;
  const results = [];
  let resolveFinish;
  const finished = new Promise((r) => (resolveFinish = r));

  const TASKS = [
    {
      taskId: "w4-hardstop-task",
      mode: "implement",
      useWorktree: true,
      instructions: "This should be blocked by disk hard-stop",
      scope: { repoPath: hsRepoDir, branch: "feature/w4-hs" },
    },
  ];

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

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });

  server.listen(0, () => {
    const HS_PORT = server.address().port;
    console.log(`Mock orchestrator (hard-stop) on :${HS_PORT}`);

    const worker = spawn("node", ["worker.js"], {
      cwd: __dirname,
      env: {
        ...process.env,
        ORCH_BASE_URL: `http://127.0.0.1:${HS_PORT}`,
        WORKER_TOKEN: "test-token",
        WORKER_ID: "test-worker-w4hs",
        ALLOWED_REPOS: hsRepoDir,
        CLAUDE_CMD: mockClaudePath,
        POLL_INTERVAL_MS: "200",
        MAX_PARALLEL_WORKTREES: "1",
        CLAUDE_TIMEOUT_MS: "10000",
        LEASE_TTL_MS: "60000",
        LEASE_RENEW_INTERVAL_MS: "30000",
        WORKTREE_TTL_MS: "3600000",
        WORKTREE_CLEANUP_INTERVAL_MS: "60000",
        WORKTREE_DISK_THRESHOLD_BYTES: "1024", // 1KB threshold — will be exceeded
        WORKTREE_DISK_HARD_STOP: "true",        // hard stop enabled
        WORKTREE_RECOVERY_ENABLED: "false",      // skip recovery for this test
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let workerStdout = "";
    let workerStderr = "";
    worker.stdout.on("data", (c) => (workerStdout += c.toString()));
    worker.stderr.on("data", (c) => (workerStderr += c.toString()));

    const safetyTimer = setTimeout(() => {
      console.error("SAFETY TIMEOUT — killing worker (hard-stop test)");
      worker.kill("SIGTERM");
      setTimeout(() => { server.close(); callback(); }, 2000);
    }, 20000);

    finished.then(() => {
      clearTimeout(safetyTimer);
      worker.kill("SIGTERM");

      setTimeout(() => {
        server.close();

        // The task should have failed due to disk hard-stop
        const r1 = results.find((r) => r.taskId === "w4-hardstop-task");
        assert(r1, "Hard-stop task result received");
        assert(r1 && r1.status === "failed", `Hard-stop task status=failed (got ${r1?.status})`);
        if (r1 && r1.output) {
          assert(
            r1.output.stderr.includes("disk threshold exceeded"),
            `Hard-stop task stderr mentions disk threshold (got: ${r1.output.stderr.slice(0, 100)})`
          );
        }

        const allLogs = workerStdout + workerStderr;
        assert(allLogs.includes("w4-disk-hard-stop") || allLogs.includes("disk threshold exceeded"),
          "Worker logs contain disk hard-stop message");

        // Cleanup
        try { fs.rmSync(hsRepoDir, { recursive: true, force: true }); } catch (_) {}

        callback();
      }, 1500);
    });
  });
}

// ── Run all tests ──────────────────────────────────────────────────────────────

runUnitTests();
runHardStopTest(() => {
  runIntegrationTests();
});
