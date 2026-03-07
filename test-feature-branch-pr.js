#!/usr/bin/env node
"use strict";

/**
 * Integration test: feature-branch-per-task and auto-PR workflow.
 *
 * Covers:
 *   1. taskIdToBranch naming convention
 *   2. FEATURE_BRANCH_PER_TASK=true, AUTO_PR_AFTER_TASK=false -> push only, PR skipped
 *   3. FEATURE_BRANCH_PER_TASK=true, AUTO_PR_AFTER_TASK=true  -> push + PR success
 *   4. AUTO_PR_AFTER_TASK=true + PR creation fails -> completed with warning
 *   5. featureBranchPerTask=false per-task opt-out -> no branch workflow
 *   6. Non-completed (failed) task -> no branch workflow
 *
 * Usage: node test-feature-branch-pr.js
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn, execSync } = require("child_process");

// ── Setup ──────────────────────────────────────────────────────────────────────

const mockClaudeDir = fs.mkdtempSync(path.join(os.tmpdir(), "mock-claude-fb-"));
const mockClaudePath = path.join(mockClaudeDir, "claude");
const mockGhDir = fs.mkdtempSync(path.join(os.tmpdir(), "mock-gh-fb-"));
const mockGhPath = path.join(mockGhDir, "gh");
const ghCallLogFile = path.join(mockGhDir, "gh-calls.json");
const ghFailFlagFile = path.join(mockGhDir, "should-fail");

// Bare repo (remote) + working repo
const bareRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), "bare-repo-fb-"));
const mockRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-repo-fb-"));

execSync("git init --bare", { cwd: bareRepoDir, stdio: "ignore" });
execSync(`git clone "${bareRepoDir}" .`, { cwd: mockRepoDir, stdio: "ignore" });
execSync('git config user.email "test@test.com"', { cwd: mockRepoDir, stdio: "ignore" });
execSync('git config user.name "Test"', { cwd: mockRepoDir, stdio: "ignore" });
fs.writeFileSync(path.join(mockRepoDir, "README.md"), "init");
execSync("git add . && git commit -m init && git push", { cwd: mockRepoDir, stdio: "ignore" });

// Mock claude
fs.writeFileSync(mockClaudePath, `#!/usr/bin/env node
"use strict";
const prompt = process.argv[process.argv.indexOf("-p") + 1] || "";
function out(result) {
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", result, is_error: false }));
  process.exit(0);
}
if (prompt.includes("FAIL-TASK")) {
  process.stderr.write("deliberate failure");
  process.exit(1);
}
out("Task completed successfully. Here is a detailed comprehensive report of the work performed including implementation details, analysis, and test results that exceed the minimum threshold.");
`, { mode: 0o755 });

// Mock gh
fs.writeFileSync(mockGhPath, `#!/usr/bin/env node
"use strict";
const fs = require("fs");
const args = process.argv.slice(2);
const logFile = process.env.GH_CALL_LOG;
if (logFile) {
  const existing = fs.existsSync(logFile) ? JSON.parse(fs.readFileSync(logFile, "utf-8")) : [];
  existing.push(args);
  fs.writeFileSync(logFile, JSON.stringify(existing));
}
const flagFile = "${ghFailFlagFile.replace(/\\/g, "\\\\")}";
if (fs.existsSync(flagFile)) {
  process.stderr.write("gh: Not Found (HTTP 404)");
  process.exit(1);
}
process.stdout.write("https://github.com/test/repo/pull/42");
process.exit(0);
`, { mode: 0o755 });

// ── Test phases ────────────────────────────────────────────────────────────────
// Phase 1: AUTO_PR=false, tasks: push-only, opt-out, fail
// Phase 2: AUTO_PR=true,  tasks: pr-success, pr-fail

const phase1Tasks = [
  { taskId: "task-push-only-001", mode: "implement", instructions: "Do work.", scope: { repoPath: mockRepoDir, branch: "feature/test-branch" } },
  { taskId: "task-opt-out-004", mode: "implement", instructions: "Do work.", scope: { repoPath: mockRepoDir, branch: "feature/test-branch" }, featureBranchPerTask: false },
  { taskId: "task-fail-005", mode: "implement", instructions: "FAIL-TASK deliberate failure", scope: { repoPath: mockRepoDir, branch: "feature/test-branch" } },
];

const phase2Tasks = [
  { taskId: "task-pr-success-002", mode: "implement", instructions: "Do work.", scope: { repoPath: mockRepoDir, branch: "feature/test-branch" } },
  { taskId: "task-pr-fail-003", mode: "implement", instructions: "Do work.", scope: { repoPath: mockRepoDir, branch: "feature/test-branch" } },
];

let currentTasks = [];
let pullIndex = 0;
const allResults = [];
const allEvents = [];
let _finished = false;
let targetResultCount = 0;

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const data = body ? JSON.parse(body) : {};
    if (req.url === "/api/worker/pull") {
      if (pullIndex < currentTasks.length) {
        const task = currentTasks[pullIndex++];
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, task }));
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      }
      return;
    }
    if (req.url === "/api/worker/result") {
      allResults.push(data);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.url === "/api/worker/event") {
      allEvents.push(data);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });
});

function waitForResults(count) {
  return new Promise((resolve) => {
    const check = setInterval(() => {
      if (allResults.length >= count) {
        clearInterval(check);
        resolve();
      }
    }, 100);
  });
}

function spawnWorker(port, extraEnv = {}) {
  const env = {
    ...process.env,
      REPORT_SCHEMA_STRICT: "false",
    ORCH_BASE_URL: `http://127.0.0.1:${port}`,
    WORKER_TOKEN: "test-token",
    WORKER_ID: "test-worker-fb",
    CLAUDE_CMD: mockClaudePath,
    ALLOWED_REPOS: mockRepoDir,
    POLL_INTERVAL_MS: "200",
    FEATURE_BRANCH_PER_TASK: "true",
    REPORT_CONTRACT_ENABLED: "false",
    MAX_PARALLEL_WORKTREES: "1",
    PATH: `${mockGhDir}:${process.env.PATH}`,
    GH_CALL_LOG: ghCallLogFile,
    ...extraEnv,
  };
  const w = spawn("node", [path.join(__dirname, "worker.js")], { env, stdio: "pipe" });
  w.stdout.on("data", () => {});
  w.stderr.on("data", () => {});
  return w;
}

async function run() {
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  // ── Phase 1: AUTO_PR_AFTER_TASK=false ──
  currentTasks = phase1Tasks;
  pullIndex = 0;
  const phase1Start = allResults.length;
  const w1 = spawnWorker(port, { AUTO_PR_AFTER_TASK: "false" });
  await waitForResults(phase1Start + phase1Tasks.length);
  w1.kill();

  // ── Phase 2: AUTO_PR_AFTER_TASK=true ──
  // Set gh fail flag after first PR task completes
  currentTasks = phase2Tasks;
  pullIndex = 0;
  const phase2Start = allResults.length;

  // Watch for first phase2 result to enable gh failure for the second
  const failFlagWatcher = setInterval(() => {
    if (allResults.length >= phase2Start + 1 && !fs.existsSync(ghFailFlagFile)) {
      fs.writeFileSync(ghFailFlagFile, "1");
    }
  }, 50);

  // Reset gh call log
  try { fs.unlinkSync(ghCallLogFile); } catch (_) {}

  const w2 = spawnWorker(port, { AUTO_PR_AFTER_TASK: "true" });
  await waitForResults(phase2Start + phase2Tasks.length);
  clearInterval(failFlagWatcher);
  w2.kill();

  // ── Assertions ──
  server.close();

  let passed = 0;
  let failed = 0;

  function assert(label, condition, detail) {
    if (condition) {
      console.log(`  \u2713 ${label}`);
      passed++;
    } else {
      console.log(`  \u2717 ${label}${detail ? ": " + detail : ""}`);
      failed++;
    }
  }

  console.log("\n=== Feature Branch + PR Workflow Tests ===\n");

  // 1. Branch naming
  console.log("1. taskIdToBranch naming:");
  const r1 = allResults.find((r) => r.taskId === "task-push-only-001");
  assert("branch derived from taskId", r1?.meta?.featureBranch === "feature/task-push-only-001");

  // 2. Push only (no PR)
  console.log("\n2. FEATURE_BRANCH_PER_TASK=true, AUTO_PR_AFTER_TASK=false:");
  assert("task completed", r1?.status === "completed");
  assert("push succeeded", r1?.meta?.pushResult === "success");
  assert("PR creation skipped", r1?.meta?.prCreation === "skipped");
  assert("prNextStep has manual hint", r1?.meta?.prNextStep?.includes("manually"));

  // 3. PR success
  console.log("\n3. AUTO_PR_AFTER_TASK=true, PR succeeds:");
  const r2 = allResults.find((r) => r.taskId === "task-pr-success-002");
  assert("task completed", r2?.status === "completed");
  assert("featureBranch set", r2?.meta?.featureBranch === "feature/task-pr-success-002");
  assert("push succeeded", r2?.meta?.pushResult === "success");
  assert("PR created", r2?.meta?.prCreation === "success");
  assert("prUrl present", r2?.meta?.prUrl === "https://github.com/test/repo/pull/42");

  // Verify gh was called correctly
  let ghCalls = [];
  try { ghCalls = JSON.parse(fs.readFileSync(ghCallLogFile, "utf-8")); } catch (_) {}
  const prCreateCalls = ghCalls.filter((c) => c[0] === "pr" && c[1] === "create");
  assert("gh pr create invoked", prCreateCalls.length >= 1);
  if (prCreateCalls.length >= 1) {
    const call = prCreateCalls[0];
    assert("--base main", call.includes("--base") && call[call.indexOf("--base") + 1] === "main");
    assert("no --merge/--auto (never auto-merge)", !call.includes("--merge") && !call.includes("--auto"));
  }

  // 4. PR failure
  console.log("\n4. AUTO_PR_AFTER_TASK=true, PR fails:");
  const r3 = allResults.find((r) => r.taskId === "task-pr-fail-003");
  assert("task still completed (not failed)", r3?.status === "completed");
  assert("push succeeded", r3?.meta?.pushResult === "success");
  assert("PR creation failed", r3?.meta?.prCreation === "failed");
  assert("prError present", !!r3?.meta?.prError);
  assert("prNextStep with manual fallback", r3?.meta?.prNextStep?.includes("manual"));

  // 5. Per-task opt-out
  console.log("\n5. Per-task opt-out (featureBranchPerTask=false):");
  const r4 = allResults.find((r) => r.taskId === "task-opt-out-004");
  assert("task completed", r4?.status === "completed");
  assert("no featureBranch in meta", !r4?.meta?.featureBranch);
  assert("no feature_branch event", !allEvents.find((e) => e.taskId === "task-opt-out-004" && e.phase === "feature_branch"));

  // 6. Failed task
  console.log("\n6. Failed task - no branch workflow:");
  const r5 = allResults.find((r) => r.taskId === "task-fail-005");
  assert("task failed", r5?.status === "failed");
  assert("no featureBranch in meta", !r5?.meta?.featureBranch);
  assert("no feature_branch event", !allEvents.find((e) => e.taskId === "task-fail-005" && e.phase === "feature_branch"));

  // 7. Events emitted
  console.log("\n7. Feature branch events:");
  const fbEvt = allEvents.find((e) => e.taskId === "task-push-only-001" && e.phase === "feature_branch");
  assert("event emitted for push-only task", !!fbEvt);
  assert("event contains branch name", fbEvt?.message?.includes("feature/task-push-only-001"));

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);

  cleanup();
  process.exit(failed > 0 ? 1 : 0);
}

function cleanup() {
  try { fs.rmSync(mockClaudeDir, { recursive: true, force: true }); } catch (_) {}
  try { fs.rmSync(mockGhDir, { recursive: true, force: true }); } catch (_) {}
  try { fs.rmSync(bareRepoDir, { recursive: true, force: true }); } catch (_) {}
  try { fs.rmSync(mockRepoDir, { recursive: true, force: true }); } catch (_) {}
}

// Safety timeout
setTimeout(() => {
  if (!_finished) {
    console.error("TIMEOUT: test did not finish in 60s");
    console.error("Results so far:", allResults.length, allResults.map(r => r.taskId));
    server.close();
    cleanup();
    process.exit(1);
  }
}, 60000);

run().catch((err) => {
  console.error("Test error:", err);
  cleanup();
  process.exit(1);
});
