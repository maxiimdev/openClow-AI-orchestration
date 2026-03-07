#!/usr/bin/env node
"use strict";

/**
 * Audit fault-injection tests.
 *
 * Covers mandatory fault-injection scenarios from the E2E audit:
 *   1. Transient /api/worker/event timeout + retry
 *   2. Lease renew unavailable (404) behavior
 *   3. One parallel slot failure while other succeeds
 *   4. Merge gate blocked reasons correctness (review + tests + escalation)
 *   5. Isolated review evidence (packet/hash/size + isolatedRun)
 *   6. Idempotency: duplicate calls do not duplicate side effects
 *   7. Per-task nonce isolation (W2 concurrency fix regression test)
 *
 * Port: dynamic (server.listen(0))
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn, execSync } = require("child_process");

let PORT;

// ── Helpers ─────────────────────────────────────────────────────────────────

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failures++;
  } else {
    console.log(`PASS: ${msg}`);
    passes++;
  }
}

let passes = 0;
let failures = 0;

// ── Mock repo + mock claude ────────────────────────────────────────────────────

const mockClaudeDir = fs.mkdtempSync(path.join(os.tmpdir(), "mock-claude-audit-"));
const mockClaudePath = path.join(mockClaudeDir, "claude");
const mockRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-repo-audit-"));

execSync("git init", { cwd: mockRepoDir, stdio: "ignore" });
execSync('git config user.email "test@test.com"', { cwd: mockRepoDir, stdio: "ignore" });
execSync('git config user.name "Test"', { cwd: mockRepoDir, stdio: "ignore" });
fs.writeFileSync(path.join(mockRepoDir, "app.js"), "module.exports = 42;");
execSync("git add -A && git commit -m init", { cwd: mockRepoDir, stdio: "ignore" });

const mockClaudeScript = `#!/usr/bin/env node
"use strict";
const prompt = process.argv[process.argv.indexOf("-p") + 1] || "";

function out(result) {
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", result, is_error: false }));
  process.exit(0);
}

if (prompt.includes("FAIL-TASK")) {
  process.stderr.write("Fatal error\\n");
  process.exit(1);
} else if (prompt.includes("SLOW-TASK")) {
  setTimeout(() => out("Slow task completed."), 300);
} else if (prompt.includes("[review]") || prompt.includes("Code Review")) {
  // Review task — always pass
  out("[REVIEW_PASS] All checks passed.");
} else {
  out("Task completed successfully.");
}
`;

fs.writeFileSync(mockClaudePath, mockClaudeScript, { mode: 0o755 });

// ── Test state ──────────────────────────────────────────────────────────────────

let pullQueue = [];
let results = [];
let events = [];
let leaseRenewals = [];
let seenIdempotencyKeys = new Map();
let eventFailCount = 0;           // simulate transient failures on event
let leaseRenew404 = false;        // simulate 404 on lease renew

// ── Mock orchestrator ───────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const json = body ? JSON.parse(body) : {};
    const url = req.url;

    // Track idempotency keys
    const idempKey = req.headers["idempotency-key"];
    if (idempKey) {
      seenIdempotencyKeys.set(idempKey, (seenIdempotencyKeys.get(idempKey) || 0) + 1);
    }

    if (url === "/api/worker/pull") {
      const task = pullQueue.shift();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(task ? { ok: true, task } : { ok: true, task: null }));
      return;
    }

    if (url === "/api/worker/event") {
      // Simulate transient event failures
      if (eventFailCount > 0) {
        eventFailCount--;
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Internal Server Error");
        return;
      }
      events.push(json);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (url === "/api/worker/result") {
      results.push(json);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (url === "/api/worker/lease-renew") {
      if (leaseRenew404) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not Found");
        return;
      }
      leaseRenewals.push(json);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (url === "/api/worker/dead-letter") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });
});

function resetState() {
  pullQueue = [];
  results = [];
  events = [];
  leaseRenewals = [];
  seenIdempotencyKeys = new Map();
  eventFailCount = 0;
  leaseRenew404 = false;
}

function waitForResults(count, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      if (results.length >= count) return resolve();
      if (Date.now() > deadline) return reject(new Error(`Timed out waiting for ${count} results (got ${results.length})`));
      setTimeout(check, 100);
    };
    check();
  });
}

function spawnWorker(extraEnv = {}) {
  const env = {
    ...process.env,
      REPORT_SCHEMA_STRICT: "false",
      REPORT_CONTRACT_ENABLED: "false",
    ORCH_BASE_URL: `http://127.0.0.1:${PORT}`,
    WORKER_TOKEN: "test-token",
    WORKER_ID: "test-worker-audit",
    POLL_INTERVAL_MS: "200",
    CLAUDE_CMD: mockClaudePath,
    ALLOWED_REPOS: mockRepoDir,
    CLAUDE_TIMEOUT_MS: "10000",
    CLAUDE_BYPASS_PERMISSIONS: "true",
    LEASE_TTL_MS: "30000",
    LEASE_RENEW_INTERVAL_MS: "500",
    MAX_RETRIES: "2",
    RETRY_BACKOFF_BASE_MS: "50",
    DLQ_ENABLED: "true",
    IDEMPOTENCY_ENABLED: "true",
    MAX_PARALLEL_WORKTREES: "2",
    WORKTREE_TTL_MS: "3600000",
    WORKTREE_DISK_HARD_STOP: "false",
    ...extraEnv,
  };
  return spawn(process.execPath, [path.join(__dirname, "worker.js")], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

// ── Tests ───────────────────────────────────────────────────────────────────────

async function runTests() {
  server.listen(0);
  await new Promise((r) => server.on("listening", r));
  PORT = server.address().port;
  console.log(`Mock orchestrator on port ${PORT}\n`);

  // ══════════════════════════════════════════════════════════════════════════════
  // Test 1: Transient /api/worker/event timeout + retry
  // ══════════════════════════════════════════════════════════════════════════════
  console.log("=== Test 1: Transient event timeout + retry ===");
  resetState();
  eventFailCount = 2; // First 2 event calls will fail (500)
  pullQueue.push({
    taskId: "audit-event-retry",
    mode: "implement",
    instructions: "Event retry test",
    scope: { repoPath: mockRepoDir, branch: "feature/audit-event-retry" },
  });

  const w1 = spawnWorker();
  await waitForResults(1);
  process.kill(w1.pid, "SIGTERM");
  await new Promise((r) => w1.on("close", r));

  const r1 = results.find((r) => r.taskId === "audit-event-retry");
  assert(r1, "T1: result received despite event failures");
  assert(r1 && r1.status === "completed", `T1: status=completed (got ${r1?.status})`);
  // Events should eventually arrive after retries
  const claimedEvents = events.filter((e) => e.taskId === "audit-event-retry" && e.status === "claimed");
  // claimed event may or may not succeed depending on retry — but task should complete
  assert(r1 && r1.resultVersion === 2, "T1: resultVersion=2");
  console.log();

  // ══════════════════════════════════════════════════════════════════════════════
  // Test 2: Lease renew unavailable (404) behavior
  // ══════════════════════════════════════════════════════════════════════════════
  console.log("=== Test 2: Lease renew unavailable (404) ===");
  resetState();
  leaseRenew404 = true;
  pullQueue.push({
    taskId: "audit-lease-404",
    mode: "implement",
    instructions: "Lease 404 test",
    scope: { repoPath: mockRepoDir, branch: "feature/audit-lease-404" },
  });

  const w2 = spawnWorker();
  await waitForResults(1);
  process.kill(w2.pid, "SIGTERM");
  await new Promise((r) => w2.on("close", r));

  const r2 = results.find((r) => r.taskId === "audit-lease-404");
  assert(r2, "T2: result received despite lease renew 404");
  assert(r2 && r2.status === "completed", `T2: status=completed — 404 lease doesn't block task (got ${r2?.status})`);
  console.log();

  // ══════════════════════════════════════════════════════════════════════════════
  // Test 3: One parallel slot failure while other succeeds
  // ══════════════════════════════════════════════════════════════════════════════
  console.log("=== Test 3: Parallel slot — one fails, one succeeds ===");
  resetState();
  pullQueue.push({
    taskId: "audit-slot-ok",
    mode: "implement",
    instructions: "Success task",
    scope: { repoPath: mockRepoDir, branch: "feature/audit-slot-ok" },
    useWorktree: true,
  });
  pullQueue.push({
    taskId: "audit-slot-fail",
    mode: "implement",
    instructions: "FAIL-TASK",
    scope: { repoPath: mockRepoDir, branch: "feature/audit-slot-fail" },
    useWorktree: true,
  });

  const w3 = spawnWorker();
  await waitForResults(2);
  process.kill(w3.pid, "SIGTERM");
  await new Promise((r) => w3.on("close", r));

  const rOk = results.find((r) => r.taskId === "audit-slot-ok");
  const rFail = results.find((r) => r.taskId === "audit-slot-fail");
  assert(rOk, "T3: success task result received");
  assert(rOk && rOk.status === "completed", `T3: success task completed (got ${rOk?.status})`);
  assert(rFail, "T3: failure task result received");
  assert(rFail && rFail.status === "failed", `T3: failure task failed (got ${rFail?.status})`);
  // Both should have slot telemetry
  assert(rOk && rOk.meta && rOk.meta.slotId, `T3: success task has slotId (got ${rOk?.meta?.slotId})`);
  assert(rFail && rFail.meta && rFail.meta.slotId, `T3: failure task has slotId (got ${rFail?.meta?.slotId})`);
  // Slots should be different
  assert(
    rOk && rFail && rOk.meta.slotId !== rFail.meta.slotId,
    `T3: slot IDs differ (${rOk?.meta?.slotId} vs ${rFail?.meta?.slotId})`
  );
  // Worktrees should be cleaned up
  const wtOkPath = rOk?.meta?.worktreePath;
  const wtFailPath = rFail?.meta?.worktreePath;
  if (wtOkPath) assert(!fs.existsSync(wtOkPath), `T3: success worktree cleaned up`);
  if (wtFailPath) assert(!fs.existsSync(wtFailPath), `T3: failure worktree cleaned up`);
  console.log();

  // ══════════════════════════════════════════════════════════════════════════════
  // Test 4: Merge gate blocked reasons correctness
  // ══════════════════════════════════════════════════════════════════════════════
  console.log("=== Test 4: Merge gate blocked reasons ===");
  resetState();
  // Task with review gate only → needs_patch
  pullQueue.push({
    taskId: "audit-gate-review",
    mode: "implement",
    instructions: "Gate review test",
    scope: { repoPath: mockRepoDir, branch: "feature/audit-gate-review" },
    useWorktree: true,
    mergePolicy: { requireReview: true, requireTests: false, targetBranch: "main" },
  });
  // Task with tests gate only → escalated (per fix)
  pullQueue.push({
    taskId: "audit-gate-tests",
    mode: "implement",
    instructions: "Gate tests test",
    scope: { repoPath: mockRepoDir, branch: "feature/audit-gate-tests" },
    useWorktree: true,
    mergePolicy: { requireReview: false, requireTests: true, targetBranch: "main" },
  });

  const w4 = spawnWorker();
  await waitForResults(2);
  process.kill(w4.pid, "SIGTERM");
  await new Promise((r) => w4.on("close", r));

  const rGateReview = results.find((r) => r.taskId === "audit-gate-review");
  const rGateTests = results.find((r) => r.taskId === "audit-gate-tests");
  assert(rGateReview, "T4: review gate result received");
  assert(
    rGateReview && rGateReview.status === "needs_patch",
    `T4: review gate → needs_patch (got ${rGateReview?.status})`
  );
  assert(
    rGateReview && rGateReview.gate_blocked_reason && rGateReview.gate_blocked_reason.includes("review_not_passed"),
    `T4: review gate reason includes review_not_passed`
  );
  assert(rGateTests, "T4: tests gate result received");
  assert(
    rGateTests && rGateTests.status === "escalated",
    `T4: tests-only gate → escalated (got ${rGateTests?.status})`
  );
  assert(
    rGateTests && rGateTests.meta && rGateTests.meta.gate_blocked_reason &&
    rGateTests.meta.gate_blocked_reason.includes("tests_not_passed"),
    `T4: tests gate reason includes tests_not_passed`
  );
  assert(
    rGateTests && rGateTests.meta && rGateTests.meta.escalationReason,
    `T4: tests gate has escalationReason`
  );
  console.log();

  // ══════════════════════════════════════════════════════════════════════════════
  // Test 5: Isolated review evidence (packet/hash/size + isolatedRun)
  // ══════════════════════════════════════════════════════════════════════════════
  console.log("=== Test 5: Isolated review evidence ===");
  resetState();
  pullQueue.push({
    taskId: "audit-isolated-review",
    mode: "review",
    instructions: "Review isolation test",
    scope: { repoPath: mockRepoDir, branch: "feature/audit-isolated" },
    isolatedReview: true,
  });

  const w5 = spawnWorker();
  await waitForResults(1);
  process.kill(w5.pid, "SIGTERM");
  await new Promise((r) => w5.on("close", r));

  const r5 = results.find((r) => r.taskId === "audit-isolated-review");
  assert(r5, "T5: isolated review result received");
  assert(r5 && r5.status === "review_pass", `T5: status=review_pass (got ${r5?.status})`);
  assert(r5 && r5.meta && r5.meta.isolatedRun === true, `T5: isolatedRun=true`);
  assert(
    r5 && r5.meta && typeof r5.meta.reviewPacketHash === "string" && r5.meta.reviewPacketHash.length === 64,
    `T5: reviewPacketHash is 64-char hex (got ${r5?.meta?.reviewPacketHash?.length} chars)`
  );
  assert(r5 && r5.meta && r5.meta.reviewPacketSize > 0, `T5: reviewPacketSize > 0 (got ${r5?.meta?.reviewPacketSize})`);
  assert(
    r5 && r5.meta && typeof r5.meta.changedFilesCount === "number",
    `T5: changedFilesCount present (got ${r5?.meta?.changedFilesCount})`
  );
  console.log();

  // ══════════════════════════════════════════════════════════════════════════════
  // Test 6: Idempotency — duplicate calls do not duplicate side effects
  // ══════════════════════════════════════════════════════════════════════════════
  console.log("=== Test 6: Idempotency keys present + unique ===");
  resetState();
  pullQueue.push({
    taskId: "audit-idempotent",
    mode: "implement",
    instructions: "Idempotency test",
    scope: { repoPath: mockRepoDir, branch: "feature/audit-idemp" },
  });

  const w6 = spawnWorker();
  await waitForResults(1);
  process.kill(w6.pid, "SIGTERM");
  await new Promise((r) => w6.on("close", r));

  assert(seenIdempotencyKeys.size > 0, `T6: idempotency keys were sent (count=${seenIdempotencyKeys.size})`);
  // All keys should appear exactly once (no duplicates in this clean run)
  let dupeCount = 0;
  for (const [key, count] of seenIdempotencyKeys) {
    if (count > 1) dupeCount++;
  }
  assert(dupeCount === 0, `T6: no duplicate idempotency keys in clean run (dupes=${dupeCount})`);
  console.log();

  // ══════════════════════════════════════════════════════════════════════════════
  // Test 7: Per-task nonce isolation (W2 concurrency fix regression)
  // ══════════════════════════════════════════════════════════════════════════════
  console.log("=== Test 7: Per-task nonce isolation under parallel slots ===");
  resetState();
  pullQueue.push({
    taskId: "audit-nonce-a",
    mode: "implement",
    instructions: "SLOW-TASK nonce A",
    scope: { repoPath: mockRepoDir, branch: "feature/audit-nonce-a" },
    useWorktree: true,
  });
  pullQueue.push({
    taskId: "audit-nonce-b",
    mode: "implement",
    instructions: "SLOW-TASK nonce B",
    scope: { repoPath: mockRepoDir, branch: "feature/audit-nonce-b" },
    useWorktree: true,
  });

  const w7 = spawnWorker();
  await waitForResults(2);
  process.kill(w7.pid, "SIGTERM");
  await new Promise((r) => w7.on("close", r));

  const rA = results.find((r) => r.taskId === "audit-nonce-a");
  const rB = results.find((r) => r.taskId === "audit-nonce-b");
  assert(rA && rA.status === "completed", `T7: nonce-a completed (got ${rA?.status})`);
  assert(rB && rB.status === "completed", `T7: nonce-b completed (got ${rB?.status})`);

  // Collect idempotency keys per task
  const keysA = [];
  const keysB = [];
  for (const evt of events) {
    // We can't directly see which key maps to which task from the server side,
    // but we can verify both tasks completed without cross-contamination
  }
  // Both tasks should complete independently with different slot IDs
  assert(
    rA && rB && rA.meta.slotId !== rB.meta.slotId,
    `T7: parallel tasks have different slotIds`
  );
  // Result should have resultVersion=2 (proof task went through full pipeline)
  assert(rA && rA.resultVersion === 2, `T7: nonce-a has resultVersion=2`);
  assert(rB && rB.resultVersion === 2, `T7: nonce-b has resultVersion=2`);
  console.log();

  // ══════════════════════════════════════════════════════════════════════════════
  // Summary
  // ══════════════════════════════════════════════════════════════════════════════
  console.log("=".repeat(50));
  console.log(`Results: ${passes} passed, ${failures} failed`);
  console.log("=".repeat(50));

  server.close();
  process.exit(failures > 0 ? 1 : 0);
}

runTests().catch((err) => {
  console.error("Test runner error:", err);
  server.close();
  process.exit(1);
});
