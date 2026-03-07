#!/usr/bin/env node
"use strict";

/**
 * Test: Worktree Stage W5 (operator UX + control surface).
 *
 * Covers:
 *   1. inspectWorktree returns expected metadata for active and completed tasks
 *   2. forceCleanupWorktree denied for active task without force
 *   3. forceCleanupWorktree works for inactive/stale task
 *   4. forceCleanupWorktree with force=true overrides active guard
 *   5. listWorktrees accurate under parallel load
 *   6. formatTelegramStatus produces compact readable output
 *   7. enrichEventMeta merges all required fields
 *   8. Legacy tasks unaffected (non-worktree paths still work)
 *
 * Port: dynamic (server.listen(0))
 * Usage: node test-worktree-w5.js
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn, execSync } = require("child_process");

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

const mockClaudeDir = fs.mkdtempSync(path.join(os.tmpdir(), "mock-claude-w5-"));
const mockClaudePath = path.join(mockClaudeDir, "claude");
const mockRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-repo-w5-"));

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

// ── Inline reimplementations of W5 functions for unit testing ───────────────
// We reimplement the key functions here so tests don't require worker.js module exports.

const WORKTREE_BASE_DIR = ".worktrees";

function dirSizeSync(dirPath) {
  let total = 0;
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        total += dirSizeSync(fullPath);
      } else {
        try { total += fs.statSync(fullPath).size; } catch (_) {}
      }
    }
  } catch (_) {}
  return total;
}

// Simulated state (mirrors worker.js internals)
const _worktreeRegistry = new Map();
const _activeWorktreeTaskIds = new Set();
const _activeSlots = new Map();

function worktreeRegistryAdd(taskId, info) {
  _worktreeRegistry.set(taskId, {
    worktreePath: info.worktreePath,
    branch: info.branch,
    baseRepoPath: info.baseRepoPath,
    slotId: info.slotId || null,
    createdAt: Date.now(),
  });
}

function worktreeRegistryRemove(taskId) {
  _worktreeRegistry.delete(taskId);
}

function inspectWorktree(taskId, repoPaths) {
  const entry = _worktreeRegistry.get(taskId);
  const isActive = _activeWorktreeTaskIds.has(taskId);

  if (entry) {
    const ageMs = Date.now() - entry.createdAt;
    let diskUsageBytes = 0;
    try {
      if (fs.existsSync(entry.worktreePath)) {
        diskUsageBytes = dirSizeSync(entry.worktreePath);
      }
    } catch (_) {}
    return {
      found: true, taskId,
      worktreePath: entry.worktreePath,
      branch: entry.branch,
      baseRepoPath: entry.baseRepoPath,
      slotId: entry.slotId,
      createdAt: entry.createdAt,
      ageMs,
      status: isActive ? "active" : "idle",
      diskUsageBytes,
    };
  }

  for (const repoPath of (repoPaths || [])) {
    const wtDir = path.join(repoPath, WORKTREE_BASE_DIR, taskId);
    if (fs.existsSync(wtDir)) {
      let stat;
      try { stat = fs.statSync(wtDir); } catch (_) { continue; }
      const ageMs = Date.now() - stat.mtimeMs;
      let diskUsageBytes = 0;
      try { diskUsageBytes = dirSizeSync(wtDir); } catch (_) {}
      let branch = null;
      return {
        found: true, taskId,
        worktreePath: wtDir, branch,
        baseRepoPath: repoPath,
        slotId: null,
        createdAt: stat.birthtimeMs || stat.mtimeMs,
        ageMs,
        status: isActive ? "active" : "stale",
        diskUsageBytes,
      };
    }
  }
  return { found: false, taskId };
}

function listWorktrees(repoPaths) {
  const slots = [];
  for (const [slotId, slotInfo] of _activeSlots.entries()) {
    slots.push({ slotId, taskId: slotInfo.taskId, status: "active" });
  }
  const registered = [];
  for (const [taskId, entry] of _worktreeRegistry.entries()) {
    registered.push({
      taskId,
      worktreePath: entry.worktreePath,
      branch: entry.branch,
      slotId: entry.slotId,
      ageMs: Date.now() - entry.createdAt,
      status: _activeWorktreeTaskIds.has(taskId) ? "active" : "idle",
    });
  }
  const onDisk = [];
  for (const repoPath of (repoPaths || [])) {
    const wtBase = path.join(repoPath, WORKTREE_BASE_DIR);
    if (!fs.existsSync(wtBase)) continue;
    try {
      const entries = fs.readdirSync(wtBase, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const taskId = entry.name;
        if (_worktreeRegistry.has(taskId)) continue;
        let stat;
        try { stat = fs.statSync(path.join(wtBase, taskId)); } catch (_) { continue; }
        onDisk.push({
          taskId,
          worktreePath: path.join(wtBase, taskId),
          repoPath,
          ageMs: Date.now() - stat.mtimeMs,
          status: _activeWorktreeTaskIds.has(taskId) ? "active" : "stale",
        });
      }
    } catch (_) {}
  }

  const diskUsage = { diskUsageBytes: 0, worktreeCount: 0 };
  for (const repoPath of (repoPaths || [])) {
    const wtBase = path.join(repoPath, WORKTREE_BASE_DIR);
    if (!fs.existsSync(wtBase)) continue;
    try {
      const entries = fs.readdirSync(wtBase, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        diskUsage.worktreeCount++;
        diskUsage.diskUsageBytes += dirSizeSync(path.join(wtBase, entry.name));
      }
    } catch (_) {}
  }

  return {
    activeSlots: slots,
    totalSlots: 2,
    registeredWorktrees: registered,
    onDiskOrphans: onDisk,
    diskUsage,
  };
}

function forceCleanupWorktree(taskId, repoPaths, { force = false } = {}) {
  const isActive = _activeWorktreeTaskIds.has(taskId);

  if (isActive && !force) {
    return { success: false, denied: true, reason: "task is currently active; use force=true to override" };
  }

  let warning = null;
  if (isActive && force) {
    warning = "forced cleanup of active task — task may fail or produce partial results";
  }

  let wtPath = null;
  let baseRepoPath = null;
  const entry = _worktreeRegistry.get(taskId);
  if (entry) {
    wtPath = entry.worktreePath;
    baseRepoPath = entry.baseRepoPath;
  } else {
    for (const repoPath of (repoPaths || [])) {
      const candidate = path.join(repoPath, WORKTREE_BASE_DIR, taskId);
      if (fs.existsSync(candidate)) {
        wtPath = candidate;
        baseRepoPath = repoPath;
        break;
      }
    }
  }

  if (!wtPath || !fs.existsSync(wtPath)) {
    return { success: false, denied: false, reason: "worktree not found on disk" };
  }

  try {
    fs.rmSync(wtPath, { recursive: true, force: true });
  } catch (err) {
    return { success: false, denied: false, reason: `cleanup failed: ${err.message}` };
  }

  _worktreeRegistry.delete(taskId);
  _activeWorktreeTaskIds.delete(taskId);

  return { success: true, denied: false, reason: null, warning, cleanedPath: wtPath };
}

function formatTelegramStatus(eventData) {
  const { taskId, status, phase, message, meta } = eventData;
  const shortId = (taskId || "???").slice(-8);
  const slot = meta?.slotId ? ` [${meta.slotId}]` : "";
  const branch = meta?.worktreeBranch || meta?.branch || "";
  const branchTag = branch ? ` \u2192 ${branch}` : "";

  const statusIcons = {
    claimed: "\u2705", started: "\u25B6\uFE0F", progress: "\u23F3",
    completed: "\u2705", review_pass: "\u2705", review_fail: "\u274C",
    needs_input: "\u2753", needs_patch: "\uD83D\uDD27", escalated: "\u26A0\uFE0F",
    failed: "\u274C", timeout: "\u23F0", rejected: "\uD83D\uDEAB",
  };
  const icon = statusIcons[status] || "\u2139\uFE0F";

  let summary = `${icon} ${shortId}${slot}${branchTag}\n`;
  summary += `${status}/${phase}`;

  if (message) {
    const shortMsg = message.length > 120 ? message.slice(0, 117) + "..." : message;
    summary += `: ${shortMsg}`;
  }
  if (meta?.durationMs) {
    const secs = (meta.durationMs / 1000).toFixed(1);
    summary += ` (${secs}s)`;
  }
  if (meta?.activeSlots !== undefined && meta?.totalSlots !== undefined) {
    summary += `\nslots: ${meta.activeSlots}/${meta.totalSlots}`;
  }
  if (meta?.worktreePath) {
    summary += `\nwt: ${path.basename(meta.worktreePath)}`;
  }
  if (meta?.disk_usage_bytes !== undefined) {
    const mb = (meta.disk_usage_bytes / (1024 * 1024)).toFixed(1);
    summary += `\ndisk: ${mb}MB`;
  }
  return summary;
}

function enrichEventMeta(task, slotCtx, worktreeInfo, baseMeta) {
  const enriched = { ...baseMeta };
  enriched.taskId = task.taskId;
  enriched.slotId = slotCtx?.slotId || null;
  if (worktreeInfo) {
    enriched.worktreePath = worktreeInfo.worktreePath;
    enriched.worktreeBranch = worktreeInfo.branch;
    enriched.baseCommit = worktreeInfo.baseCommit;
  }
  return enriched;
}

// ── Part 1: Unit tests ──────────────────────────────────────────────────────

function runUnitTests() {
  console.log("\n=== Part 1: W5 Unit Tests ===\n");

  const wtBase = path.join(mockRepoDir, WORKTREE_BASE_DIR);
  if (!fs.existsSync(wtBase)) fs.mkdirSync(wtBase, { recursive: true });

  // Reset state
  _worktreeRegistry.clear();
  _activeWorktreeTaskIds.clear();
  _activeSlots.clear();

  // ── Test 1: inspectWorktree for active task (in registry) ──
  {
    const taskId = "task-inspect-active";
    const wtDir = path.join(wtBase, taskId);
    fs.mkdirSync(wtDir, { recursive: true });
    fs.writeFileSync(path.join(wtDir, "file.txt"), "hello");

    _activeWorktreeTaskIds.add(taskId);
    worktreeRegistryAdd(taskId, {
      worktreePath: wtDir,
      branch: "feature/test",
      baseRepoPath: mockRepoDir,
      slotId: "slot-1",
    });

    const info = inspectWorktree(taskId, [mockRepoDir]);
    assert(info.found === true, "inspect active: found=true");
    assert(info.status === "active", "inspect active: status=active");
    assert(info.branch === "feature/test", "inspect active: branch correct");
    assert(info.slotId === "slot-1", "inspect active: slotId correct");
    assert(info.worktreePath === wtDir, "inspect active: worktreePath correct");
    assert(info.diskUsageBytes > 0, "inspect active: diskUsageBytes > 0");
    assert(typeof info.ageMs === "number" && info.ageMs >= 0, "inspect active: ageMs is number >= 0");

    // Cleanup
    _activeWorktreeTaskIds.delete(taskId);
    worktreeRegistryRemove(taskId);
  }

  // ── Test 2: inspectWorktree for completed task (on-disk only, not in registry) ──
  {
    const taskId = "task-inspect-stale";
    const wtDir = path.join(wtBase, taskId);
    fs.mkdirSync(wtDir, { recursive: true });
    fs.writeFileSync(path.join(wtDir, "data.txt"), "stale data");

    const info = inspectWorktree(taskId, [mockRepoDir]);
    assert(info.found === true, "inspect stale: found=true");
    assert(info.status === "stale", "inspect stale: status=stale");
    assert(info.slotId === null, "inspect stale: slotId null (not in registry)");
    assert(info.diskUsageBytes > 0, "inspect stale: diskUsageBytes > 0");
  }

  // ── Test 3: inspectWorktree for non-existent task ──
  {
    const info = inspectWorktree("task-nonexistent", [mockRepoDir]);
    assert(info.found === false, "inspect nonexistent: found=false");
  }

  // ── Test 4: forceCleanupWorktree denied for active task ──
  {
    const taskId = "task-cleanup-active";
    const wtDir = path.join(wtBase, taskId);
    fs.mkdirSync(wtDir, { recursive: true });
    fs.writeFileSync(path.join(wtDir, "active.txt"), "active");

    _activeWorktreeTaskIds.add(taskId);
    worktreeRegistryAdd(taskId, {
      worktreePath: wtDir,
      branch: "feature/active",
      baseRepoPath: mockRepoDir,
      slotId: "slot-2",
    });

    const result = forceCleanupWorktree(taskId, [mockRepoDir]);
    assert(result.success === false, "cleanup active: success=false");
    assert(result.denied === true, "cleanup active: denied=true");
    assert(result.reason.includes("active"), "cleanup active: reason mentions active");
    assert(fs.existsSync(wtDir), "cleanup active: worktree still exists on disk");

    // Cleanup
    _activeWorktreeTaskIds.delete(taskId);
    worktreeRegistryRemove(taskId);
    fs.rmSync(wtDir, { recursive: true, force: true });
  }

  // ── Test 5: forceCleanupWorktree works for inactive/stale task ──
  {
    const taskId = "task-cleanup-stale";
    const wtDir = path.join(wtBase, taskId);
    fs.mkdirSync(wtDir, { recursive: true });
    fs.writeFileSync(path.join(wtDir, "stale.txt"), "stale");

    // Not in _activeWorktreeTaskIds, not in registry — on disk only
    const result = forceCleanupWorktree(taskId, [mockRepoDir]);
    assert(result.success === true, "cleanup stale: success=true");
    assert(result.denied === false, "cleanup stale: denied=false");
    assert(!fs.existsSync(wtDir), "cleanup stale: worktree removed from disk");
    assert(result.cleanedPath === wtDir, "cleanup stale: cleanedPath correct");
  }

  // ── Test 6: forceCleanupWorktree with force=true overrides active guard ──
  {
    const taskId = "task-cleanup-force";
    const wtDir = path.join(wtBase, taskId);
    fs.mkdirSync(wtDir, { recursive: true });
    fs.writeFileSync(path.join(wtDir, "forced.txt"), "forced");

    _activeWorktreeTaskIds.add(taskId);
    worktreeRegistryAdd(taskId, {
      worktreePath: wtDir,
      branch: "feature/force",
      baseRepoPath: mockRepoDir,
      slotId: "slot-3",
    });

    const result = forceCleanupWorktree(taskId, [mockRepoDir], { force: true });
    assert(result.success === true, "cleanup force: success=true");
    assert(result.denied === false, "cleanup force: denied=false");
    assert(result.warning !== null, "cleanup force: warning present");
    assert(!fs.existsSync(wtDir), "cleanup force: worktree removed from disk");
    assert(!_activeWorktreeTaskIds.has(taskId), "cleanup force: taskId removed from active set");
    assert(!_worktreeRegistry.has(taskId), "cleanup force: taskId removed from registry");
  }

  // ── Test 7: forceCleanupWorktree for non-existent task ──
  {
    const result = forceCleanupWorktree("task-ghost", [mockRepoDir]);
    assert(result.success === false, "cleanup ghost: success=false");
    assert(result.reason.includes("not found"), "cleanup ghost: reason mentions not found");
  }

  // ── Test 8: listWorktrees accurate under parallel load ──
  {
    // Reset state
    _worktreeRegistry.clear();
    _activeWorktreeTaskIds.clear();
    _activeSlots.clear();

    // Create 3 worktrees: 2 registered (1 active, 1 idle), 1 on-disk orphan
    const tasks = ["task-list-a", "task-list-b", "task-list-c"];
    for (const t of tasks) {
      const d = path.join(wtBase, t);
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, "f.txt"), t);
    }

    _activeWorktreeTaskIds.add("task-list-a");
    worktreeRegistryAdd("task-list-a", {
      worktreePath: path.join(wtBase, "task-list-a"),
      branch: "feature/a",
      baseRepoPath: mockRepoDir,
      slotId: "slot-a",
    });
    worktreeRegistryAdd("task-list-b", {
      worktreePath: path.join(wtBase, "task-list-b"),
      branch: "feature/b",
      baseRepoPath: mockRepoDir,
      slotId: "slot-b",
    });
    // task-list-c is on-disk orphan only

    _activeSlots.set("slot-a", { taskId: "task-list-a", promise: Promise.resolve() });
    _activeSlots.set("slot-b", { taskId: "task-list-b", promise: Promise.resolve() });

    const listing = listWorktrees([mockRepoDir]);
    assert(listing.activeSlots.length === 2, "list: 2 active slots");
    assert(listing.registeredWorktrees.length === 2, "list: 2 registered worktrees");
    assert(listing.registeredWorktrees[0].status === "active", "list: first registered is active");
    assert(listing.registeredWorktrees[1].status === "idle", "list: second registered is idle");
    assert(listing.onDiskOrphans.length >= 1, "list: at least 1 on-disk orphan");
    const orphanIds = listing.onDiskOrphans.map(o => o.taskId);
    // task-list-c + stale tasks from earlier tests
    assert(orphanIds.includes("task-list-c"), "list: orphan includes task-list-c");
    assert(listing.diskUsage.worktreeCount >= 3, "list: diskUsage worktreeCount >= 3");
    assert(listing.diskUsage.diskUsageBytes > 0, "list: diskUsage bytes > 0");

    // Cleanup
    for (const t of tasks) {
      fs.rmSync(path.join(wtBase, t), { recursive: true, force: true });
    }
    _worktreeRegistry.clear();
    _activeWorktreeTaskIds.clear();
    _activeSlots.clear();
  }

  // ── Test 9: formatTelegramStatus produces compact readable output ──
  {
    const event = {
      taskId: "task-20260306T140619Z-test",
      status: "completed",
      phase: "report",
      message: "task completed",
      meta: {
        slotId: "slot-1",
        worktreeBranch: "feature/test",
        worktreePath: "/tmp/repos/.worktrees/task-test",
        durationMs: 12345,
        activeSlots: 1,
        totalSlots: 2,
      },
    };

    const output = formatTelegramStatus(event);
    assert(output.includes("19Z-test"), "telegram: contains short taskId (last 8 chars)");
    assert(output.includes("slot-1"), "telegram: contains slotId");
    assert(output.includes("feature/test"), "telegram: contains branch");
    assert(output.includes("completed/report"), "telegram: contains status/phase");
    assert(output.includes("12.3s"), "telegram: contains duration");
    assert(output.includes("slots: 1/2"), "telegram: contains slot utilization");
    assert(output.includes("wt:"), "telegram: contains worktree shortname");
    // Verify it's compact (under 500 chars)
    assert(output.length < 500, "telegram: output is compact (< 500 chars)");
  }

  // ── Test 10: formatTelegramStatus with disk event ──
  {
    const event = {
      taskId: "task-disk-check",
      status: "failed",
      phase: "worktree",
      message: "disk threshold exceeded",
      meta: { disk_usage_bytes: 1024 * 1024 * 50 },
    };

    const output = formatTelegramStatus(event);
    assert(output.includes("disk: 50.0MB"), "telegram disk: contains disk usage in MB");
    assert(output.includes("\u274C"), "telegram disk: contains fail icon");
  }

  // ── Test 11: enrichEventMeta merges all fields ──
  {
    const task = { taskId: "task-enrich" };
    const slotCtx = { slotId: "slot-5" };
    const worktreeInfo = {
      worktreePath: "/tmp/.worktrees/task-enrich",
      branch: "feature/enrich",
      baseCommit: "abc123",
    };
    const baseMeta = { durationMs: 5000 };

    const enriched = enrichEventMeta(task, slotCtx, worktreeInfo, baseMeta);
    assert(enriched.taskId === "task-enrich", "enrich: taskId present");
    assert(enriched.slotId === "slot-5", "enrich: slotId present");
    assert(enriched.worktreePath === "/tmp/.worktrees/task-enrich", "enrich: worktreePath present");
    assert(enriched.worktreeBranch === "feature/enrich", "enrich: worktreeBranch present");
    assert(enriched.baseCommit === "abc123", "enrich: baseCommit present");
    assert(enriched.durationMs === 5000, "enrich: base meta preserved");
  }

  // ── Test 12: enrichEventMeta without worktree (legacy compat) ──
  {
    const task = { taskId: "task-legacy" };
    const slotCtx = { slotId: "slot-0" };
    const baseMeta = { durationMs: 1000 };

    const enriched = enrichEventMeta(task, slotCtx, null, baseMeta);
    assert(enriched.taskId === "task-legacy", "enrich legacy: taskId present");
    assert(enriched.slotId === "slot-0", "enrich legacy: slotId present");
    assert(enriched.worktreePath === undefined, "enrich legacy: no worktreePath");
    assert(enriched.durationMs === 1000, "enrich legacy: base meta preserved");
  }

  // Clean up remaining stale dirs
  try {
    const entries = fs.readdirSync(wtBase, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory()) {
        fs.rmSync(path.join(wtBase, e.name), { recursive: true, force: true });
      }
    }
  } catch (_) {}
}

// ── Part 2: Integration test with worker process ────────────────────────────

function runIntegrationTests() {
  return new Promise((resolve) => {
    console.log("\n=== Part 2: W5 Integration Tests ===\n");

    const events = [];
    let taskCount = 0;
    let resultCount = 0;
    let resolveAllResults;
    const allResultsDone = new Promise((r) => (resolveAllResults = r));
    const MAX_TASKS = 2;

    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const url = req.url;
        let payload;
        try { payload = JSON.parse(body); } catch (_) { payload = {}; }

        if (url === "/api/worker/pull") {
          if (taskCount < MAX_TASKS) {
            taskCount++;
            const isWorktree = taskCount === 1;
            res.end(JSON.stringify({
              ok: true,
              task: {
                taskId: `task-w5-integ-${taskCount}`,
                mode: "implement",
                instructions: "test task",
                useWorktree: isWorktree,
                scope: { repoPath: mockRepoDir, branch: `feature/test-w5-${taskCount}` },
              },
            }));
          } else {
            res.end(JSON.stringify({ ok: true, task: null }));
          }
        } else if (url === "/api/worker/event") {
          events.push(payload);
          res.end(JSON.stringify({ ok: true }));
        } else if (url === "/api/worker/result") {
          resultCount++;
          if (resultCount >= MAX_TASKS) resolveAllResults();
          res.end(JSON.stringify({ ok: true }));
        } else if (url === "/api/worker/lease-renew") {
          res.end(JSON.stringify({ ok: true, expired: false }));
        } else {
          res.writeHead(404);
          res.end("not found");
        }
      });
    });

    server.listen(0, () => {
      const PORT = server.address().port;
      console.log(`Mock orchestrator on port ${PORT}`);

      const env = {
        ...process.env,
      REPORT_SCHEMA_STRICT: "false",
      REPORT_CONTRACT_ENABLED: "false",
        ORCH_BASE_URL: `http://localhost:${PORT}`,
        WORKER_TOKEN: "test-token",
        WORKER_ID: "test-worker-w5",
        POLL_INTERVAL_MS: "500",
        CLAUDE_CMD: mockClaudePath,
        ALLOWED_REPOS: mockRepoDir,
        CLAUDE_TIMEOUT_MS: "15000",
        MAX_PARALLEL_WORKTREES: "2",
        WORKTREE_TTL_MS: "3600000",
        WORKTREE_CLEANUP_INTERVAL_MS: "999999",
        WORKTREE_RECOVERY_ENABLED: "false",
      };

      const worker = spawn("node", [path.join(__dirname, "worker.js")], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      worker.stdout.on("data", (c) => (stdout += c));
      worker.stderr.on("data", (c) => (stderr += c));

      // Wait for all results, then verify
      const safetyTimer = setTimeout(() => {
        console.error("[WARN] integration test timed out after 30s");
        resolveAllResults();
      }, 30000);

      allResultsDone.then(() => {
        clearTimeout(safetyTimer);
        worker.kill("SIGTERM");

        setTimeout(() => {
          // ── Integration Test 1: worktree task events include enriched metadata ──
          const worktreeEvents = events.filter(
            (e) => e.taskId === "task-w5-integ-1"
          );
          const progressEvents = worktreeEvents.filter(
            (e) => e.phase === "worktree" && e.status === "progress"
          );
          const hasWorktreeMeta = progressEvents.some(
            (e) => e.meta && e.meta.worktreePath && e.meta.branch
          );
          assert(
            hasWorktreeMeta,
            "integration: worktree progress event has worktreePath + branch"
          );

          // ── Integration Test 2: worktree task events include slotId ──
          const claimedEvents = worktreeEvents.filter(
            (e) => e.status === "claimed"
          );
          const hasSlotId = claimedEvents.some(
            (e) => e.meta && e.meta.slotId
          );
          assert(hasSlotId, "integration: claimed event has slotId");

          // ── Integration Test 3: non-worktree task still works (backward compat) ──
          const legacyEvents = events.filter(
            (e) => e.taskId === "task-w5-integ-2"
          );
          const legacyCompleted = legacyEvents.some(
            (e) => e.status === "completed" || (e.status === "progress" && e.phase === "report")
          );
          assert(legacyCompleted, "integration: non-worktree task completed normally");

          // ── Integration Test 4: no worktree meta on non-worktree task ──
          const legacyWorktreePhases = legacyEvents.filter(
            (e) => e.phase === "worktree"
          );
          assert(
            legacyWorktreePhases.length === 0,
            "integration: non-worktree task has no worktree phase events"
          );

          server.close();

          console.log(`\n=== Summary: ${passed} passed, ${failed} failed ===\n`);
          resolve();
        }, 500);
      });
    });
  });
}

// ── Run ──────────────────────────────────────────────────────────────────────

async function main() {
  runUnitTests();
  await runIntegrationTests();

  // Cleanup temp dirs
  try { fs.rmSync(mockClaudeDir, { recursive: true, force: true }); } catch (_) {}
  try { fs.rmSync(mockRepoDir, { recursive: true, force: true }); } catch (_) {}

  process.exit(failed > 0 ? 1 : 0);
}

main();
