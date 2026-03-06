#!/usr/bin/env node
"use strict";

/**
 * Integration test: Stage 2 review gate.
 *
 * Proves two properties:
 *   1. (gate)  A task with mode=review and [REVIEW_FAIL] output CANNOT become
 *              completed — it must be review_fail.
 *   2. (happy) A task with mode=review and [REVIEW_PASS] output becomes
 *              review_pass, and a subsequent tests task becomes completed.
 *
 * Task sequence served by the mock orchestrator:
 *   Pull 1 → implement task     → mock claude: success          → result: completed
 *   Pull 2 → review task (fail) → mock claude: [REVIEW_FAIL]   → result: review_fail
 *   Pull 3 → review task (pass) → mock claude: [REVIEW_PASS]   → result: review_pass
 *   Pull 4 → tests task         → mock claude: success          → result: completed
 *   Pull 5+ → empty             → trigger finish
 *
 * Usage: node test-stage2-review-gate.js
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn, execSync } = require("child_process");

// ── Mock repo + mock claude ───────────────────────────────────────────────────

const mockClaudeDir = fs.mkdtempSync(path.join(os.tmpdir(), "mock-claude-rg-"));
const mockClaudePath = path.join(mockClaudeDir, "claude");
const mockRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-repo-rg-"));

execSync("git init", { cwd: mockRepoDir, stdio: "ignore" });
execSync("git commit --allow-empty -m init", { cwd: mockRepoDir, stdio: "ignore" });

// Mock claude: behaviour varies by task ID embedded in the prompt
const mockClaudeScript = `#!/usr/bin/env node
"use strict";
const prompt = process.argv[process.argv.indexOf("-p") + 1] || "";

if (prompt.includes("stage2-review-fail")) {
  // Review task that should fail — outputs REVIEW_FAIL marker
  const result = {
    type: "result", subtype: "success",
    result: "I reviewed the code and found significant problems.\\n\\n[REVIEW_FAIL severity=major]\\nSQL injection in login endpoint.\\nPasswords stored in plain text.\\n[/REVIEW_FAIL]",
    is_error: false,
  };
  process.stdout.write(JSON.stringify(result));
  process.exit(0);
}

if (prompt.includes("stage2-review-pass")) {
  // Review task that should pass — outputs REVIEW_PASS marker
  const result = {
    type: "result", subtype: "success",
    result: "I reviewed the code. Everything looks good.\\n\\n[REVIEW_PASS]\\nNo major or critical findings. Clean implementation.",
    is_error: false,
  };
  process.stdout.write(JSON.stringify(result));
  process.exit(0);
}

// implement or tests task — generic success
const result = {
  type: "result", subtype: "success",
  result: "Task completed successfully.",
  is_error: false,
};
process.stdout.write(JSON.stringify(result));
process.exit(0);
`;

fs.writeFileSync(mockClaudePath, mockClaudeScript, { mode: 0o755 });

// ── Task definitions ──────────────────────────────────────────────────────────

const SCOPE = { repoPath: mockRepoDir, branch: "agent/stage2-test" };

const TASK_IMPLEMENT = {
  taskId: "stage2-implement-001",
  mode: "implement",
  scope: SCOPE,
  instructions: "Implement user authentication.",
};

const TASK_REVIEW_FAIL = {
  taskId: "stage2-review-fail-001",
  mode: "review",
  scope: SCOPE,
  instructions: "Review the implementation for major/critical issues.",
};

const TASK_REVIEW_PASS = {
  taskId: "stage2-review-pass-001",
  mode: "review",
  scope: SCOPE,
  instructions: "Review the patched implementation.",
  previousReviewFindings: "SQL injection in login endpoint.\nPasswords stored in plain text.",
};

const TASK_TESTS = {
  taskId: "stage2-tests-001",
  mode: "tests",
  scope: SCOPE,
  instructions: "Write tests for the implementation.",
};

// ── State ─────────────────────────────────────────────────────────────────────

let pullCount = 0;
let receivedResults = [];
let receivedEvents = [];
let worker = null;

function color(code, text) {
  return `\x1b[${code}m${text}\x1b[0m`;
}

// ── Mock orchestrator ─────────────────────────────────────────────────────────

const PULL_SEQUENCE = [
  TASK_IMPLEMENT,
  TASK_REVIEW_FAIL,
  TASK_REVIEW_PASS,
  TASK_TESTS,
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

    // ── PULL ──
    if (req.url === "/api/worker/pull") {
      pullCount++;

      if (pullCount <= PULL_SEQUENCE.length) {
        const task = PULL_SEQUENCE[pullCount - 1];
        console.log(color(36, `\n[orch] → pull ${pullCount}: sending ${task.taskId} (mode=${task.mode})`));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, task }));
        return;
      }

      // No more tasks
      console.log(color(33, "[orch] → no more tasks"));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));

      // finish triggered by result count, not by timer
      return;
    }

    // ── EVENT ──
    if (req.url === "/api/worker/event") {
      const ev = JSON.parse(body);
      receivedEvents.push(ev);
      const statusColor = {
        claimed: 36, started: 36, progress: 33,
        review_pass: 32, review_fail: 31,
        completed: 32, failed: 31, timeout: 31,
      }[ev.status] || 37;
      console.log(color(statusColor, `[orch] ← event: ${ev.status}/${ev.phase} — ${ev.message}`));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // ── RESULT ──
    if (req.url === "/api/worker/result") {
      const result = JSON.parse(body);
      receivedResults.push(result);
      const statusColor = result.status === "completed" ? 32
        : result.status === "review_pass" ? 32
        : result.status === "review_fail" ? 31 : 37;
      console.log(color(statusColor, `\n[orch] ← result: taskId=${result.taskId} status=${result.status}`));
      if (result.meta?.reviewFindings) {
        console.log(color(31, `[orch]    findings: ${result.meta.reviewFindings.slice(0, 120)}`));
      }
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

// ── Finish + assertions ───────────────────────────────────────────────────────

let _finished = false;
function finish() {
  if (_finished) return;
  _finished = true;
  console.log(color(36, "\n" + "=".repeat(60)));
  console.log(color(36, "TEST RESULTS — Stage 2 Review Gate"));
  console.log(color(36, "=".repeat(60)));

  const byTask = {};
  for (const r of receivedResults) {
    byTask[r.taskId] = r;
  }
  const eventStatuses = receivedEvents.map((e) => `${e.status}/${e.phase}`);

  const checks = [];

  // 1. implement task → completed
  const r_impl = byTask["stage2-implement-001"];
  checks.push({
    name: "implement task → completed",
    pass: r_impl && r_impl.status === "completed",
    detail: r_impl ? `status=${r_impl.status}` : "no result",
  });

  // 2. [GATE] review task with FAIL output → review_fail (never completed)
  const r_rfail = byTask["stage2-review-fail-001"];
  checks.push({
    name: "[gate] review-fail task → review_fail (not completed)",
    pass: r_rfail && r_rfail.status === "review_fail",
    detail: r_rfail ? `status=${r_rfail.status}` : "no result",
  });

  // 3. [GATE] review-fail task MUST NOT have status=completed
  checks.push({
    name: "[gate] review-fail task status is never 'completed'",
    pass: r_rfail && r_rfail.status !== "completed",
    detail: r_rfail ? `status=${r_rfail.status}` : "no result",
  });

  // 4. review-fail result has reviewFindings in meta
  checks.push({
    name: "[gate] review_fail result has meta.reviewFindings",
    pass: r_rfail && typeof r_rfail.meta?.reviewFindings === "string" && r_rfail.meta.reviewFindings.length > 0,
    detail: r_rfail ? `findings="${(r_rfail.meta?.reviewFindings || "").slice(0, 80)}"` : "no result",
  });

  // 5. review-fail result has reviewSeverity=major
  checks.push({
    name: "[gate] review_fail result has meta.reviewSeverity=major",
    pass: r_rfail && r_rfail.meta?.reviewSeverity === "major",
    detail: r_rfail ? `severity=${r_rfail.meta?.reviewSeverity}` : "no result",
  });

  // 6. [HAPPY] review task with PASS output → review_pass
  const r_rpass = byTask["stage2-review-pass-001"];
  checks.push({
    name: "[happy] review-pass task → review_pass",
    pass: r_rpass && r_rpass.status === "review_pass",
    detail: r_rpass ? `status=${r_rpass.status}` : "no result",
  });

  // 7. [HAPPY] tests task → completed
  const r_tests = byTask["stage2-tests-001"];
  checks.push({
    name: "[happy] tests task → completed",
    pass: r_tests && r_tests.status === "completed",
    detail: r_tests ? `status=${r_tests.status}` : "no result",
  });

  // 8. review_fail/report event was sent for the failing review
  const rfailEvent = receivedEvents.find(
    (e) => e.status === "review_fail" && e.taskId === "stage2-review-fail-001"
  );
  checks.push({
    name: "[gate] review_fail event emitted for failing review",
    pass: !!rfailEvent,
    detail: rfailEvent ? `phase=${rfailEvent.phase} msg=${rfailEvent.message.slice(0, 80)}` : "not found",
  });

  // 9. review_pass/report event was sent for the passing review
  const rpassEvent = receivedEvents.find(
    (e) => e.status === "review_pass" && e.taskId === "stage2-review-pass-001"
  );
  checks.push({
    name: "[happy] review_pass event emitted for passing review",
    pass: !!rpassEvent,
    detail: rpassEvent ? `phase=${rpassEvent.phase}` : "not found",
  });

  // 10. No completed event was emitted for the failing review task
  const completedForFailReview = receivedEvents.find(
    (e) => e.status === "completed" && e.taskId === "stage2-review-fail-001"
  );
  checks.push({
    name: "[gate] no completed event for the failing review task",
    pass: !completedForFailReview,
    detail: completedForFailReview ? "FOUND (bad!)" : "not found (correct)",
  });

  // 11. previousReviewFindings was injected into the prompt for the patch review task
  // Verify via the mock claude: if claude saw "Review Findings" in its prompt, it would
  // have processed it. We confirm indirectly by checking the TASK_REVIEW_PASS was sent
  // with previousReviewFindings set and that the review-pass task completed correctly.
  checks.push({
    name: "[happy] review-pass task (with previousReviewFindings) still produces review_pass",
    pass: r_rpass && r_rpass.status === "review_pass",
    detail: r_rpass ? `status=${r_rpass.status}, taskId=${r_rpass.taskId}` : "no result",
  });

  // 12. Event sequence: review_fail before review_pass before completed
  const idxRfail = eventStatuses.indexOf("review_fail/report");
  const idxRpass = eventStatuses.indexOf("review_pass/report");
  const idxCompleted = eventStatuses.lastIndexOf("completed/report");
  checks.push({
    name: "[seq] event order: review_fail → review_pass → completed",
    pass: idxRfail !== -1 && idxRpass !== -1 && idxCompleted !== -1 &&
          idxRfail < idxRpass && idxRpass < idxCompleted,
    detail: `review_fail@${idxRfail}, review_pass@${idxRpass}, completed@${idxCompleted} in [${eventStatuses.join(", ")}]`,
  });

  // ── Print results ──
  let allPass = true;
  for (const c of checks) {
    const icon = c.pass ? color(32, "PASS") : color(31, "FAIL");
    console.log(`  ${icon}  ${c.name}`);
    console.log(`         ${color(37, c.detail)}`);
    if (!c.pass) allPass = false;
  }

  console.log(color(36, "\n" + "=".repeat(60)));
  if (allPass) {
    console.log(color(32, "ALL CHECKS PASSED"));
  } else {
    console.log(color(31, "SOME CHECKS FAILED"));
  }
  console.log(color(36, "=".repeat(60) + "\n"));

  if (worker) worker.kill("SIGTERM");
  server.close();
  try { fs.rmSync(mockClaudeDir, { recursive: true }); } catch {}
  try { fs.rmSync(mockRepoDir, { recursive: true }); } catch {}
  process.exit(allPass ? 0 : 1);
}

// ── Start ─────────────────────────────────────────────────────────────────────

server.listen(0, () => {
  const PORT = server.address().port;
  console.log(color(36, `[orch] mock orchestrator on http://localhost:${PORT}`));
  console.log(color(36, `[orch] mock claude: ${mockClaudePath}`));
  console.log(color(36, `[orch] mock repo:   ${mockRepoDir}`));
  console.log(color(36, "[orch] spawning worker...\n"));

  worker = spawn("node", ["worker.js"], {
    cwd: __dirname,
    env: {
      ...process.env,
      ORCH_BASE_URL: `http://localhost:${PORT}`,
      WORKER_TOKEN: "test-token",
      WORKER_ID: "test-worker-rg",
      POLL_INTERVAL_MS: "1000",
      MAX_PARALLEL_WORKTREES: "1",
      CLAUDE_CMD: mockClaudePath,
      ALLOWED_REPOS: mockRepoDir,
      CLAUDE_TIMEOUT_MS: "30000",
      CLAUDE_BYPASS_PERMISSIONS: "false",
    },
    stdio: "inherit",
  });

  worker.on("close", (code) => {
    console.log(color(37, `\n[orch] worker exited with code ${code}`));
  });

  // Safety timeout
  setTimeout(() => {
    console.log(color(31, "\n[orch] TIMEOUT — test took too long, aborting"));
    if (worker) worker.kill("SIGKILL");
    server.close();
    try { fs.rmSync(mockClaudeDir, { recursive: true }); } catch {}
    try { fs.rmSync(mockRepoDir, { recursive: true }); } catch {}
    process.exit(1);
  }, 60000);
});
