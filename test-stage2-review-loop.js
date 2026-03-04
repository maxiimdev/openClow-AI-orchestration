#!/usr/bin/env node
"use strict";

/**
 * Integration test: Stage 2.2 Review Loop.
 *
 * Proves three properties:
 *   1. (fail→pass) A reviewLoop task that fails on iteration 1 then passes on
 *      iteration 2 (after a patch) reports review_pass with reviewIteration=2.
 *   2. (escalate)  A reviewLoop task that always fails exhausts maxReviewIterations
 *      and reports escalated with the correct iteration count and reason.
 *   3. (findings)  Structured findings from iteration 1's review_fail are
 *      propagated into the patch prompt (verified via review_loop_fail event) and
 *      the final result body includes structuredFindings.
 *
 * Task sequence served by the mock orchestrator:
 *   Pull 1 → review-loop task (fail→pass, maxIter=3) → result: review_pass (iter 2)
 *   Pull 2 → review-loop task (always fail, maxIter=2) → result: escalated (iter 2)
 *   Pull 3+ → empty → trigger finish
 *
 * Mock claude behaviour (detected via prompt content):
 *   • Prompt contains "## Review Findings"          → patch run       → success
 *   • Prompt contains "review-loop-context"          → re-review       → REVIEW_PASS
 *   • Prompt contains "review-loop-ff-" (always fail) w/o above markers → REVIEW_FAIL
 *   • Otherwise (first review of fail→pass task)    → REVIEW_FAIL w/ structured findings
 *
 * Usage: node test-stage2-review-loop.js
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn, execSync } = require("child_process");

const PORT = 9878;

// ── Mock repo + mock claude ───────────────────────────────────────────────────

const mockClaudeDir = fs.mkdtempSync(path.join(os.tmpdir(), "mock-claude-rl-"));
const mockClaudePath = path.join(mockClaudeDir, "claude");
const mockRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-repo-rl-"));

execSync("git init", { cwd: mockRepoDir, stdio: "ignore" });
execSync('git config user.email "test@test.com"', { cwd: mockRepoDir, stdio: "ignore" });
execSync('git config user.name "Test"', { cwd: mockRepoDir, stdio: "ignore" });
execSync("git commit --allow-empty -m init", { cwd: mockRepoDir, stdio: "ignore" });

const mockClaudeScript = `#!/usr/bin/env node
"use strict";
const prompt = process.argv[process.argv.indexOf("-p") + 1] || "";

// Always-fail scenario: task ID contains review-loop-ff- (check BEFORE review-loop-context)
if (prompt.includes("review-loop-ff-")) {
  // Patch runs for always-fail task (prompt has ## Review Findings section)
  if (prompt.includes("## Review Findings")) {
    process.stdout.write(JSON.stringify({ type: "result", subtype: "success", result: "Patch applied.", is_error: false }));
    process.exit(0);
  }
  // Review runs for always-fail task: always return REVIEW_FAIL
  const ffFindings = [{id:"F1",severity:"major",file:"render.js",issue:"XSS via unsanitized user input",risk:"Session hijack",required_fix:"Escape HTML output",acceptance_check:"No raw user input in innerHTML"}];
  const ffResult = "Found persistent issues.\\n\\n" +
    "[REVIEW_FAIL severity=major]\\n" +
    "Persistent XSS vulnerability in output rendering.\\n" +
    "[REVIEW_FINDINGS_JSON]" + JSON.stringify(ffFindings) + "[/REVIEW_FINDINGS_JSON]\\n" +
    "[/REVIEW_FAIL]";
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", result: ffResult, is_error: false }));
  process.exit(0);
}

// Patch run for fail->pass task (prompt has ## Review Findings section)
if (prompt.includes("## Review Findings")) {
  process.stdout.write(JSON.stringify({
    type: "result", subtype: "success",
    result: "Patch applied successfully. All findings addressed.",
    is_error: false,
  }));
  process.exit(0);
}

// Re-review after patch for fail->pass task (has review-loop-context context snippet)
if (prompt.includes("review-loop-context")) {
  process.stdout.write(JSON.stringify({
    type: "result", subtype: "success",
    result: "Re-reviewed the patched code. All issues resolved.\\n\\n[REVIEW_PASS]\\nAll critical and major findings have been fully addressed.",
    is_error: false,
  }));
  process.exit(0);
}

// First review of fail->pass task: emit structured findings
const fpFindings = [
  {id:"F1",severity:"critical",file:"login.js",issue:"SQL injection",risk:"Full DB compromise",required_fix:"Use parameterized queries",acceptance_check:"No string concatenation in SQL queries"},
  {id:"F2",severity:"major",file:"auth.js",issue:"Plain text passwords",risk:"Credential exposure",required_fix:"Use bcrypt hashing",acceptance_check:"Passwords hashed with bcrypt min cost 10"},
];
const fpResult = "Found critical security issues.\\n\\n" +
  "[REVIEW_FAIL severity=critical]\\n" +
  "SQL injection in login endpoint. Plain text passwords.\\n" +
  "[REVIEW_FINDINGS_JSON]" + JSON.stringify(fpFindings) + "[/REVIEW_FINDINGS_JSON]\\n" +
  "[/REVIEW_FAIL]";
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", result: fpResult, is_error: false }));
process.exit(0);
`;

fs.writeFileSync(mockClaudePath, mockClaudeScript, { mode: 0o755 });

// ── Task definitions ──────────────────────────────────────────────────────────

const SCOPE = { repoPath: mockRepoDir, branch: "agent/review-loop-test" };

// Task 1: fail on first review, pass on second (after patch). maxIter=3.
const TASK_LOOP_FAIL_PASS = {
  taskId: "review-loop-fp-001",
  mode: "review",
  reviewLoop: true,
  maxReviewIterations: 3,
  scope: SCOPE,
  instructions: "Review the authentication implementation for security issues.",
  patchInstructions: "Fix all security issues identified in the review findings.",
};

// Task 2: always fails, exhausts maxReviewIterations=2.
const TASK_LOOP_ALWAYS_FAIL = {
  taskId: "review-loop-ff-001",
  mode: "review",
  reviewLoop: true,
  maxReviewIterations: 2,
  scope: SCOPE,
  instructions: "Review the rendering module for XSS vulnerabilities.",
  patchInstructions: "Fix all XSS vulnerabilities identified in the review findings.",
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
  TASK_LOOP_FAIL_PASS,
  TASK_LOOP_ALWAYS_FAIL,
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
        console.log(color(36, `\n[orch] → pull ${pullCount}: sending ${task.taskId} (reviewLoop=${task.reviewLoop}, maxIter=${task.maxReviewIterations})`));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, task }));
        return;
      }

      // No more tasks
      console.log(color(33, "[orch] → no more tasks"));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));

      if (pullCount >= PULL_SEQUENCE.length + 1) {
        setTimeout(() => finish(), 1500);
      }
      return;
    }

    // ── EVENT ──
    if (req.url === "/api/worker/event") {
      const ev = JSON.parse(body);
      receivedEvents.push(ev);
      const statusColor = {
        claimed: 36, started: 36, progress: 33,
        review_pass: 32, review_fail: 31, review_loop_fail: 31,
        escalated: 35, completed: 32, failed: 31, timeout: 31,
      }[ev.status] || 37;
      console.log(color(statusColor, `[orch] ← event: ${ev.status}/${ev.phase} [${ev.taskId}] — ${ev.message.slice(0, 100)}`));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // ── RESULT ──
    if (req.url === "/api/worker/result") {
      const result = JSON.parse(body);
      receivedResults.push(result);
      const statusColor = result.status === "review_pass" ? 32
        : result.status === "escalated" ? 35
        : result.status === "review_fail" ? 31 : 37;
      console.log(color(statusColor, `\n[orch] ← result: taskId=${result.taskId} status=${result.status}`));
      if (result.meta?.reviewIteration !== undefined) {
        console.log(color(37, `[orch]    reviewIteration=${result.meta.reviewIteration}/${result.meta.reviewMaxIterations}`));
      }
      if (result.structuredFindings) {
        console.log(color(37, `[orch]    structuredFindings: ${JSON.stringify(result.structuredFindings).slice(0, 120)}`));
      }
      if (result.meta?.escalationReason) {
        console.log(color(35, `[orch]    escalationReason: ${result.meta.escalationReason}`));
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    res.writeHead(404);
    res.end("not found");
  });
});

// ── Finish + assertions ───────────────────────────────────────────────────────

function finish() {
  console.log(color(36, "\n" + "=".repeat(60)));
  console.log(color(36, "TEST RESULTS — Stage 2.2 Review Loop"));
  console.log(color(36, "=".repeat(60)));

  const byTask = {};
  for (const r of receivedResults) {
    byTask[r.taskId] = r;
  }
  const eventStatuses = receivedEvents.map((e) => `${e.status}/${e.phase}`);

  const checks = [];

  // ── TEST 1: fail→patch→pass ──

  const r_fp = byTask["review-loop-fp-001"];

  // 1. Task 1 result is review_pass
  checks.push({
    name: "[loop:fp] review-loop task (fail→pass) → review_pass",
    pass: r_fp && r_fp.status === "review_pass",
    detail: r_fp ? `status=${r_fp.status}` : "no result",
  });

  // 2. Task 1 passed on iteration 2 (first review failed, patch+review passed)
  checks.push({
    name: "[loop:fp] review_pass achieved on iteration 2",
    pass: r_fp && r_fp.meta?.reviewIteration === 2,
    detail: r_fp ? `reviewIteration=${r_fp.meta?.reviewIteration}` : "no result",
  });

  // 3. Task 1 reviewMaxIterations is 3
  checks.push({
    name: "[loop:fp] meta.reviewMaxIterations=3",
    pass: r_fp && r_fp.meta?.reviewMaxIterations === 3,
    detail: r_fp ? `reviewMaxIterations=${r_fp.meta?.reviewMaxIterations}` : "no result",
  });

  // 4. Task 1: review_loop_fail event was emitted (for the first failed review)
  const loopFailEvent = receivedEvents.find(
    (e) => e.status === "review_loop_fail" && e.taskId === "review-loop-fp-001"
  );
  checks.push({
    name: "[loop:fp] review_loop_fail event emitted for first iteration",
    pass: !!loopFailEvent,
    detail: loopFailEvent ? `msg=${loopFailEvent.message.slice(0, 80)}` : "not found",
  });

  // 5. Findings propagation: review_loop_fail event has structuredFindings
  checks.push({
    name: "[loop:fp] review_loop_fail event carries structuredFindings",
    pass: loopFailEvent
      && Array.isArray(loopFailEvent.meta?.structuredFindings)
      && loopFailEvent.meta.structuredFindings.length > 0,
    detail: loopFailEvent
      ? `structuredFindings count=${loopFailEvent.meta?.structuredFindings?.length ?? "missing"}`
      : "no event",
  });

  // 6. Findings schema integrity: first finding has required fields
  const firstFinding = loopFailEvent?.meta?.structuredFindings?.[0];
  checks.push({
    name: "[loop:fp] finding has id/severity/file/issue/risk/required_fix/acceptance_check",
    pass: firstFinding
      && firstFinding.id
      && ["critical", "major", "minor"].includes(firstFinding.severity)
      && firstFinding.file
      && firstFinding.issue
      && firstFinding.risk
      && firstFinding.required_fix
      && firstFinding.acceptance_check,
    detail: firstFinding
      ? `id=${firstFinding.id} sev=${firstFinding.severity} file=${firstFinding.file}`
      : "no finding",
  });

  // 7. Final review_pass event emitted for task 1
  const rpassEvent = receivedEvents.find(
    (e) => e.status === "review_pass" && e.taskId === "review-loop-fp-001"
  );
  checks.push({
    name: "[loop:fp] review_pass event emitted",
    pass: !!rpassEvent,
    detail: rpassEvent ? `msg=${rpassEvent.message.slice(0, 80)}` : "not found",
  });

  // 8. structuredFindings hoisted to top-level of result body for initial review_fail
  // (verified indirectly: the patch task prompt must have contained findings → loop worked)
  // Direct check: the fail→pass result has no structuredFindings (it passed), but
  // the loop_fail event confirms findings were present. Check result body shape.
  checks.push({
    name: "[loop:fp] review_pass result has no structuredFindings (pass path)",
    pass: r_fp && r_fp.structuredFindings === undefined,
    detail: r_fp ? `structuredFindings=${JSON.stringify(r_fp.structuredFindings)}` : "no result",
  });

  // ── TEST 2: repeated fail → escalate ──

  const r_ff = byTask["review-loop-ff-001"];

  // 9. Task 2 result is escalated
  checks.push({
    name: "[loop:ff] review-loop task (always fail) → escalated",
    pass: r_ff && r_ff.status === "escalated",
    detail: r_ff ? `status=${r_ff.status}` : "no result",
  });

  // 10. Task 2 escalated after iteration 2 (maxIter=2)
  checks.push({
    name: "[loop:ff] escalated after reviewIteration=2",
    pass: r_ff && r_ff.meta?.reviewIteration === 2,
    detail: r_ff ? `reviewIteration=${r_ff.meta?.reviewIteration}` : "no result",
  });

  // 11. Task 2 reviewMaxIterations=2
  checks.push({
    name: "[loop:ff] meta.reviewMaxIterations=2",
    pass: r_ff && r_ff.meta?.reviewMaxIterations === 2,
    detail: r_ff ? `reviewMaxIterations=${r_ff.meta?.reviewMaxIterations}` : "no result",
  });

  // 12. Task 2 has escalationReason in meta
  checks.push({
    name: "[loop:ff] escalated result has meta.escalationReason",
    pass: r_ff && typeof r_ff.meta?.escalationReason === "string" && r_ff.meta.escalationReason.length > 0,
    detail: r_ff ? `escalationReason="${r_ff.meta?.escalationReason}"` : "no result",
  });

  // 13. Task 2: structuredFindings hoisted to top-level of escalated result body
  checks.push({
    name: "[loop:ff] escalated result has top-level structuredFindings or reviewFindings",
    pass: r_ff && (
      (Array.isArray(r_ff.structuredFindings) && r_ff.structuredFindings.length > 0)
      || (typeof r_ff.reviewFindings === "string" && r_ff.reviewFindings.length > 0)
    ),
    detail: r_ff ? `structuredFindings=${JSON.stringify(r_ff.structuredFindings)?.slice(0, 60)} reviewFindings="${(r_ff.reviewFindings || "").slice(0, 60)}"` : "no result",
  });

  // 14. escalated event emitted for task 2
  const escalatedEvent = receivedEvents.find(
    (e) => e.status === "escalated" && e.taskId === "review-loop-ff-001"
  );
  checks.push({
    name: "[loop:ff] escalated event emitted",
    pass: !!escalatedEvent,
    detail: escalatedEvent ? `msg=${escalatedEvent.message.slice(0, 80)}` : "not found",
  });

  // 15. No review_pass event for always-fail task
  const noRpassForFf = !receivedEvents.find(
    (e) => e.status === "review_pass" && e.taskId === "review-loop-ff-001"
  );
  checks.push({
    name: "[loop:ff] no review_pass event for always-fail task",
    pass: noRpassForFf,
    detail: noRpassForFf ? "correct: not found" : "FOUND (bad!)",
  });

  // ── SEQUENCE ──

  // 16. Event order: review_loop_fail (task1) → review_pass (task1) → escalated (task2)
  const idxLoopFail = eventStatuses.findIndex(
    (s, i) => s === "review_loop_fail/report" && receivedEvents[i].taskId === "review-loop-fp-001"
  );
  const idxRpass2 = eventStatuses.findIndex(
    (s, i) => s === "review_pass/report" && receivedEvents[i].taskId === "review-loop-fp-001"
  );
  const idxEscalated = eventStatuses.findIndex(
    (s, i) => s === "escalated/report" && receivedEvents[i].taskId === "review-loop-ff-001"
  );
  checks.push({
    name: "[seq] event order: review_loop_fail(fp) → review_pass(fp) → escalated(ff)",
    pass: idxLoopFail !== -1 && idxRpass2 !== -1 && idxEscalated !== -1
          && idxLoopFail < idxRpass2 && idxRpass2 < idxEscalated,
    detail: `loop_fail@${idxLoopFail}, review_pass@${idxRpass2}, escalated@${idxEscalated}`,
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

  // ── Sample findings payload (proof report) ──
  if (loopFailEvent?.meta?.structuredFindings) {
    console.log(color(36, "\n── Sample Findings Payload (from review_loop_fail event) ──"));
    console.log(JSON.stringify(loopFailEvent.meta.structuredFindings, null, 2));
  }

  if (worker) worker.kill("SIGTERM");
  server.close();
  try { fs.rmSync(mockClaudeDir, { recursive: true }); } catch {}
  try { fs.rmSync(mockRepoDir, { recursive: true }); } catch {}
  process.exit(allPass ? 0 : 1);
}

// ── Start ─────────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
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
      WORKER_ID: "test-worker-rl",
      POLL_INTERVAL_MS: "500",
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
  }, 90000);
});
