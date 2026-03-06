#!/usr/bin/env node
"use strict";

/**
 * Integration test: Stage 2 Hard Review Gate.
 *
 * Covers:
 *   1. [gate] implement + requireReviewGate + no review → cannot reach completed (escalated)
 *   2. [gate] review + requireReviewGate + review_fail → stays review_fail (blocked)
 *   3. [gate] review + requireReviewGate + review_pass → review_pass allowed
 *   4. [gate] orchestratedLoop + requireReviewGate + always-fail → escalated (not completed)
 *   5. [gate] orchestratedLoop + requireReviewGate + pass-first → review_pass allowed
 *   6. [compat] legacy task (no requireReviewGate) + implement → completed (no gate)
 *   7. [gate] implement + requireReviewGate → reviewGateEnforced telemetry event emitted
 *   8. [gate] review mode completed → review_fail (existing gate still works with flag)
 *
 * Port: dynamic (server.listen(0))
 *
 * Usage: node test-hard-review-gate.js
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn, execSync } = require("child_process");

// ── Mock repo + mock claude ────────────────────────────────────────────────────

const mockClaudeDir = fs.mkdtempSync(path.join(os.tmpdir(), "mock-claude-hrg-"));
const mockClaudePath = path.join(mockClaudeDir, "claude");
const mockRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-repo-hrg-"));

execSync("git init", { cwd: mockRepoDir, stdio: "ignore" });
execSync('git config user.email "test@test.com"', { cwd: mockRepoDir, stdio: "ignore" });
execSync('git config user.name "Test"', { cwd: mockRepoDir, stdio: "ignore" });
execSync("git commit --allow-empty -m init", { cwd: mockRepoDir, stdio: "ignore" });

const mockClaudeScript = `#!/usr/bin/env node
"use strict";
const prompt = process.argv[process.argv.indexOf("-p") + 1] || "";

function out(result) {
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", result, is_error: false }));
  process.exit(0);
}

// GATE-IMPL-NO-REVIEW: implement task, plain success, no review markers
if (prompt.includes("GATE-IMPL-NO-REVIEW")) {
  out("Implementation complete. All code written successfully.");
}

// GATE-REVIEW-FAIL: review task that fails
if (prompt.includes("GATE-REVIEW-FAIL")) {
  out("Found critical issues.\\n\\n[REVIEW_FAIL severity=critical]\\nSQL injection in query builder.\\n[/REVIEW_FAIL]");
}

// GATE-REVIEW-PASS: review task that passes
if (prompt.includes("GATE-REVIEW-PASS")) {
  out("All checks pass.\\n\\n[REVIEW_PASS]\\nCode quality excellent.");
}

// GATE-ORCH-ALWAYS-FAIL: orchestrated loop scenarios
if (prompt.includes("GATE-ORCH-ALWAYS-FAIL")) {
  if (prompt.includes("## Review Findings")) {
    out("Patch attempted for GATE-ORCH-ALWAYS-FAIL.");
  }
  if (prompt.includes("mode: review") || prompt.includes("[review]")) {
    out("Still failing.\\n\\n[REVIEW_FAIL severity=major]\\nXSS not fixed.\\n[/REVIEW_FAIL]");
  }
  out("Implementation complete for GATE-ORCH-ALWAYS-FAIL.");
}

// GATE-ORCH-PASS-FIRST: orchestrated loop that passes first review
if (prompt.includes("GATE-ORCH-PASS-FIRST")) {
  if (prompt.includes("mode: review") || prompt.includes("[review]")) {
    out("All good.\\n\\n[REVIEW_PASS]\\nImplementation correct.");
  }
  out("Implementation complete for GATE-ORCH-PASS-FIRST.");
}

// LEGACY-IMPL: legacy task without requireReviewGate
if (prompt.includes("LEGACY-IMPL")) {
  out("Legacy implementation complete. No gate required.");
}

// GATE-REVIEW-COMPLETED: review mode but output has no review markers (forces completed→review_fail)
if (prompt.includes("GATE-REVIEW-COMPLETED")) {
  out("Review done, looks fine overall.");
}

// Default
out("Task completed successfully.");
`;

fs.writeFileSync(mockClaudePath, mockClaudeScript, { mode: 0o755 });

// ── Task definitions ───────────────────────────────────────────────────────────

const SCOPE = { repoPath: mockRepoDir, branch: "agent/hard-review-gate-test" };

// Task 1: implement + requireReviewGate + no review → must NOT be completed
const TASK_IMPL_GATED = {
  taskId: "hrg-impl-gated-001",
  mode: "implement",
  requireReviewGate: true,
  scope: SCOPE,
  instructions: "GATE-IMPL-NO-REVIEW: implement a feature.",
};

// Task 2: review + requireReviewGate + fails → review_fail
const TASK_REVIEW_FAIL_GATED = {
  taskId: "hrg-review-fail-gated-001",
  mode: "review",
  requireReviewGate: true,
  scope: SCOPE,
  instructions: "GATE-REVIEW-FAIL: review code quality.",
};

// Task 3: review + requireReviewGate + passes → review_pass
const TASK_REVIEW_PASS_GATED = {
  taskId: "hrg-review-pass-gated-001",
  mode: "review",
  requireReviewGate: true,
  scope: SCOPE,
  instructions: "GATE-REVIEW-PASS: review code quality.",
};

// Task 4: orchestratedLoop + requireReviewGate + always-fail → escalated
const TASK_ORCH_FAIL_GATED = {
  taskId: "hrg-orch-fail-gated-001",
  mode: "implement",
  orchestratedLoop: true,
  requireReviewGate: true,
  maxReviewIterations: 2,
  scope: SCOPE,
  instructions: "GATE-ORCH-ALWAYS-FAIL: implement and review.",
  patchInstructions: "Fix issues from review.",
};

// Task 5: orchestratedLoop + requireReviewGate + pass-first → review_pass
const TASK_ORCH_PASS_GATED = {
  taskId: "hrg-orch-pass-gated-001",
  mode: "implement",
  orchestratedLoop: true,
  requireReviewGate: true,
  maxReviewIterations: 3,
  scope: SCOPE,
  instructions: "GATE-ORCH-PASS-FIRST: implement and review.",
};

// Task 6: legacy task — NO requireReviewGate → completed (backward compat)
const TASK_LEGACY = {
  taskId: "hrg-legacy-impl-001",
  mode: "implement",
  scope: SCOPE,
  instructions: "LEGACY-IMPL: implement without gate.",
};

// Task 7: review mode with requireReviewGate, output has no review markers → review_fail
const TASK_REVIEW_COMPLETED_GATED = {
  taskId: "hrg-review-completed-gated-001",
  mode: "review",
  requireReviewGate: true,
  scope: SCOPE,
  instructions: "GATE-REVIEW-COMPLETED: review with ambiguous output.",
};

// ── State ──────────────────────────────────────────────────────────────────────

let pullCount = 0;
let receivedResults = [];
let receivedEvents = [];
let worker = null;

function color(code, text) { return `\x1b[${code}m${text}\x1b[0m`; }

// ── Mock orchestrator ──────────────────────────────────────────────────────────

const PULL_SEQUENCE = [
  TASK_IMPL_GATED,
  TASK_REVIEW_FAIL_GATED,
  TASK_REVIEW_PASS_GATED,
  TASK_ORCH_FAIL_GATED,
  TASK_ORCH_PASS_GATED,
  TASK_LEGACY,
  TASK_REVIEW_COMPLETED_GATED,
];

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

    if (req.url === "/api/worker/pull") {
      pullCount++;
      if (pullCount <= PULL_SEQUENCE.length) {
        const task = PULL_SEQUENCE[pullCount - 1];
        console.log(color(36, `\n[orch] → pull ${pullCount}: ${task.taskId} (mode=${task.mode} requireReviewGate=${!!task.requireReviewGate})`));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, task }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      // finish triggered by result count, not by timer
      return;
    }

    if (req.url === "/api/worker/event") {
      const ev = JSON.parse(body);
      receivedEvents.push(ev);
      const statusColor = {
        claimed: 36, started: 36, progress: 33,
        needs_input: 31, review_pass: 32, review_fail: 31,
        escalated: 35, completed: 32, failed: 31,
        timeout: 31, context_reset: 34,
      }[ev.status] || 37;
      console.log(color(statusColor, `[orch] ← event: ${ev.status}/${ev.phase} [${ev.taskId}] — ${(ev.message || "").slice(0, 120)}`));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.url === "/api/worker/result") {
      const result = JSON.parse(body);
      receivedResults.push(result);
      const statusColor = result.status === "review_pass" ? 32
        : result.status === "review_fail" ? 31
        : result.status === "escalated" ? 35
        : result.status === "completed" ? 32 : 37;
      console.log(color(statusColor, `\n[orch] ← result: taskId=${result.taskId} status=${result.status} reviewGateEnforced=${result.meta?.reviewGateEnforced || false}`));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      if (receivedResults.length >= PULL_SEQUENCE.length) {
        process.nextTick(() => finish());
      }
      return;
    }

    res.writeHead(404);
    res.end("not found");
  });
});

// ── Finish + assertions ────────────────────────────────────────────────────────

let _finished = false;
function finish() {
  if (_finished) return;
  _finished = true;
  console.log(color(36, "\n" + "=".repeat(60)));
  console.log(color(36, "TEST RESULTS — Hard Review Gate (Stage 2)"));
  console.log(color(36, "=".repeat(60)));

  const byTask = {};
  for (const r of receivedResults) { byTask[r.taskId] = r; }

  const eventsByTask = {};
  for (const e of receivedEvents) {
    if (!eventsByTask[e.taskId]) eventsByTask[e.taskId] = [];
    eventsByTask[e.taskId].push(e);
  }

  const checks = [];

  // ── 1. implement + requireReviewGate + no review → cannot complete (escalated) ──
  const r1 = byTask["hrg-impl-gated-001"];
  checks.push({
    name: "[gate] implement + requireReviewGate → cannot complete without review",
    pass: r1 && r1.status === "escalated",
    detail: r1 ? `status=${r1.status}` : "no result",
  });
  checks.push({
    name: "[gate] implement + requireReviewGate → reviewGateEnforced=true",
    pass: r1 && r1.meta?.reviewGateEnforced === true,
    detail: r1 ? `reviewGateEnforced=${r1.meta?.reviewGateEnforced}` : "no result",
  });

  // ── 2. review + requireReviewGate + fail → review_fail (blocked) ──
  const r2 = byTask["hrg-review-fail-gated-001"];
  checks.push({
    name: "[gate] review + requireReviewGate + fail → review_fail",
    pass: r2 && r2.status === "review_fail",
    detail: r2 ? `status=${r2.status}` : "no result",
  });

  // ── 3. review + requireReviewGate + pass → review_pass (allowed) ──
  const r3 = byTask["hrg-review-pass-gated-001"];
  checks.push({
    name: "[gate] review + requireReviewGate + pass → review_pass",
    pass: r3 && r3.status === "review_pass",
    detail: r3 ? `status=${r3.status}` : "no result",
  });

  // ── 4. orchestratedLoop + requireReviewGate + always-fail → escalated ──
  const r4 = byTask["hrg-orch-fail-gated-001"];
  checks.push({
    name: "[gate] orchestratedLoop + requireReviewGate + always-fail → escalated",
    pass: r4 && r4.status === "escalated",
    detail: r4 ? `status=${r4.status}` : "no result",
  });
  checks.push({
    name: "[gate] orchestratedLoop + always-fail → NOT completed",
    pass: r4 && r4.status !== "completed",
    detail: r4 ? `status=${r4.status}` : "no result",
  });

  // ── 5. orchestratedLoop + requireReviewGate + pass-first → review_pass ──
  const r5 = byTask["hrg-orch-pass-gated-001"];
  checks.push({
    name: "[gate] orchestratedLoop + requireReviewGate + pass → review_pass",
    pass: r5 && r5.status === "review_pass",
    detail: r5 ? `status=${r5.status}` : "no result",
  });

  // ── 6. legacy task (no requireReviewGate) → completed (backward compat) ──
  const r6 = byTask["hrg-legacy-impl-001"];
  checks.push({
    name: "[compat] legacy task without requireReviewGate → completed",
    pass: r6 && r6.status === "completed",
    detail: r6 ? `status=${r6.status}` : "no result",
  });
  checks.push({
    name: "[compat] legacy task → reviewGateEnforced NOT set",
    pass: r6 && !r6.meta?.reviewGateEnforced,
    detail: r6 ? `reviewGateEnforced=${r6.meta?.reviewGateEnforced}` : "no result",
  });

  // ── 7. review_gate telemetry event emitted for gated task ──
  const gateEvents = (eventsByTask["hrg-impl-gated-001"] || []).filter(
    e => e.phase === "review_gate"
  );
  checks.push({
    name: "[telemetry] review_gate event emitted for gated implement task",
    pass: gateEvents.length > 0,
    detail: `review_gate events=${gateEvents.length}`,
  });

  // ── 8. review mode completed → review_fail (existing gate + requireReviewGate) ──
  const r7 = byTask["hrg-review-completed-gated-001"];
  checks.push({
    name: "[gate] review mode completed output → review_fail (existing + hard gate)",
    pass: r7 && r7.status === "review_fail",
    detail: r7 ? `status=${r7.status}` : "no result",
  });

  // ── Print ──
  let passed = 0;
  let failed = 0;
  for (const c of checks) {
    const mark = c.pass ? color(32, "PASS") : color(31, "FAIL");
    console.log(`  ${mark}  ${c.name}`);
    if (!c.pass) console.log(color(31, `         → ${c.detail}`));
    if (c.pass) passed++;
    else failed++;
  }

  console.log(color(36, "\n" + "-".repeat(60)));
  console.log(color(36, `Total: ${checks.length}  Passed: ${passed}  Failed: ${failed}`));
  console.log(color(36, "-".repeat(60)));

  // ── Cleanup ──
  if (worker) worker.kill("SIGTERM");
  server.close();
  try { fs.rmSync(mockClaudeDir, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(mockRepoDir, { recursive: true, force: true }); } catch {}

  process.exit(failed > 0 ? 1 : 0);
}

// ── Boot ────────────────────────────────────────────────────────────────────────

server.listen(0, () => {
  const PORT = server.address().port;
  console.log(color(36, `[orch] mock orchestrator on :${PORT}`));

  worker = spawn("node", [path.join(__dirname, "worker.js")], {
    env: {
      ...process.env,
      ORCH_BASE_URL: `http://127.0.0.1:${PORT}`,
      WORKER_TOKEN: "test-token",
      WORKER_ID: "test-hrg-worker",
      POLL_INTERVAL_MS: "200",
      MAX_PARALLEL_WORKTREES: "1",
      CLAUDE_CMD: mockClaudePath,
      ALLOWED_REPOS: mockRepoDir,
      CLAUDE_TIMEOUT_MS: "30000",
      CLAUDE_BYPASS_PERMISSIONS: "true",
      REVIEW_MAX_ITERATIONS: "3",
      ORCHESTRATED_LOOP_ENABLED: "true",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  worker.stdout.on("data", (c) => {
    const lines = c.toString().split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const j = JSON.parse(line);
        if (j.level === "error" || j.level === "warn") {
          console.log(color(33, `[worker] ${j.level}: ${j.msg}`));
        }
      } catch { /* skip non-JSON */ }
    }
  });
  worker.stderr.on("data", (c) => {
    console.log(color(31, `[worker:err] ${c.toString().trim()}`));
  });
});

// Safety timeout
setTimeout(() => {
  console.log(color(31, "\n[TIMEOUT] test timed out after 60s"));
  if (worker) worker.kill("SIGTERM");
  server.close();
  process.exit(1);
}, 60000);
