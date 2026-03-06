#!/usr/bin/env node
"use strict";

/**
 * Smoke test: Reviewer-mode + worktree + report-contract validation.
 *
 * Exercises:
 *   1. isolatedReview + requireReviewGate path (review_pass)
 *   2. Worktree-path execution (useWorktree: true)
 *   3. Report-contract guardrail (REPORT_CONTRACT_ENABLED=true) — valid report must NOT false-fail
 *   4. resultVersion=2, artifacts array, truncation field present in result body
 *   5. Long output to confirm report validation does not false-fail valid reports
 *
 * Port: dynamic (server.listen(0))
 * Usage: node test-reviewer-mode-smoke.js
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn, execSync } = require("child_process");

// ── Mock repo + mock claude ────────────────────────────────────────────────────

const mockClaudeDir = fs.mkdtempSync(path.join(os.tmpdir(), "mock-claude-rms-"));
const mockClaudePath = path.join(mockClaudeDir, "claude");
const mockRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-repo-rms-"));

execSync("git init", { cwd: mockRepoDir, stdio: "ignore" });
execSync('git config user.email "test@test.com"', { cwd: mockRepoDir, stdio: "ignore" });
execSync('git config user.name "Test"', { cwd: mockRepoDir, stdio: "ignore" });
execSync("git commit --allow-empty -m init", { cwd: mockRepoDir, stdio: "ignore" });

// Create a changed file so git diff has content for isolated review packet
fs.writeFileSync(path.join(mockRepoDir, "app.js"), 'const x = 1;\nconsole.log(x);\n');
execSync("git add -A && git commit -m 'add app.js'", { cwd: mockRepoDir, stdio: "ignore" });
fs.writeFileSync(path.join(mockRepoDir, "app.js"), 'const x = 2;\nconsole.log(x);\nfunction doWork() { return x * 2; }\nmodule.exports = { doWork };\n');

// Mock claude: emits long substantive output to exercise report-contract validation
// Review pass with detailed findings report (well above 50-char minimum)
const mockClaudeScript = `#!/usr/bin/env node
"use strict";
const prompt = process.argv[process.argv.indexOf("-p") + 1] || "";

function out(result) {
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", result, is_error: false }));
  process.exit(0);
}

// Isolated review: prompt contains "independent code reviewer" from buildIsolatedReviewPrompt
if (prompt.includes("independent code reviewer") || prompt.includes("[review]")) {
  // Generate a long, substantive review report (well above 50 chars to pass report-contract)
  const report = [
    "[REVIEW_PASS]",
    "",
    "## Code Review Summary",
    "",
    "### Files Reviewed",
    "- app.js: Variable reassignment from const x=1 to const x=2 with new doWork function",
    "",
    "### Findings",
    "No critical issues found. The code changes are well-structured and follow",
    "established patterns. The doWork function correctly uses the module-level",
    "variable and exports are properly defined.",
    "",
    "### Quality Assessment",
    "- **Correctness**: All changes are logically sound",
    "- **Style**: Consistent with existing codebase conventions",
    "- **Security**: No injection vectors or unsafe operations detected",
    "- **Performance**: No performance regressions introduced",
    "",
    "### Recommendation",
    "APPROVE - Changes are production-ready with no blocking issues.",
    "The module export pattern is clean and the function is well-named.",
    "",
    "Detailed line-by-line analysis completed. All acceptance criteria met.",
  ].join("\\n");
  out(report);
}

// Default fallback: implementation output (also substantive for report-contract)
out("Implementation completed successfully. Modified app.js with new doWork function and module exports. All changes verified and tests passing. No issues found during implementation.");
`;

fs.writeFileSync(mockClaudePath, mockClaudeScript, { mode: 0o755 });

// ── Task definitions ───────────────────────────────────────────────────────────

const SCOPE = { repoPath: mockRepoDir, branch: "agent/reviewer-smoke-test" };

// Task 1: isolatedReview + requireReviewGate + useWorktree → review_pass
const TASK_ISO_GATE_WT = {
  taskId: "rms-iso-gate-wt-001",
  mode: "review",
  isolatedReview: true,
  requireReviewGate: true,
  useWorktree: true,
  scope: SCOPE,
  instructions: "Review the app.js changes for correctness, security, and style. THIS MUST NOT LEAK INTO ISOLATED REVIEW.",
};

// Task 2: plain review + useWorktree + requireReviewGate (non-isolated, for comparison)
const SCOPE2 = { repoPath: mockRepoDir, branch: "agent/reviewer-smoke-plain" };
const TASK_PLAIN_GATE_WT = {
  taskId: "rms-plain-gate-wt-001",
  mode: "review",
  requireReviewGate: true,
  useWorktree: true,
  scope: SCOPE2,
  instructions: "Review the app.js changes. [review] mode check.",
};

// ── State ──────────────────────────────────────────────────────────────────────

let pullCount = 0;
let receivedResults = [];
let receivedEvents = [];
let worker = null;

function color(code, text) { return `\x1b[${code}m${text}\x1b[0m`; }

const PULL_SEQUENCE = [TASK_ISO_GATE_WT, TASK_PLAIN_GATE_WT];

// ── Mock orchestrator ──────────────────────────────────────────────────────────

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
        console.log(color(36, `\n[orch] -> pull ${pullCount}: ${task.taskId} (mode=${task.mode} isolatedReview=${!!task.isolatedReview} requireReviewGate=${!!task.requireReviewGate} useWorktree=${!!task.useWorktree})`));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, task }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.url === "/api/worker/event") {
      const ev = JSON.parse(body);
      receivedEvents.push(ev);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.url === "/api/worker/result") {
      const result = JSON.parse(body);
      receivedResults.push(result);
      const sc = result.status === "review_pass" ? 32
        : result.status === "review_fail" ? 31
        : result.status === "failed" ? 31 : 37;
      console.log(color(sc, `[orch] <- result: ${result.taskId} status=${result.status} resultVersion=${result.resultVersion} artifacts=${JSON.stringify(result.artifacts?.length ?? "n/a")} truncated=${result.output?.truncated}`));
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

// ── Assertions ─────────────────────────────────────────────────────────────────

let _finished = false;
function finish() {
  if (_finished) return;
  _finished = true;
  console.log(color(36, "\n" + "=".repeat(70)));
  console.log(color(36, "TEST RESULTS — Reviewer-Mode Smoke (worktree + report-contract)"));
  console.log(color(36, "=".repeat(70)));

  const byTask = {};
  for (const r of receivedResults) byTask[r.taskId] = r;

  const eventsByTask = {};
  for (const e of receivedEvents) {
    if (!eventsByTask[e.taskId]) eventsByTask[e.taskId] = [];
    eventsByTask[e.taskId].push(e);
  }

  const checks = [];

  // ── TASK 1: isolatedReview + requireReviewGate + worktree ──

  const r1 = byTask["rms-iso-gate-wt-001"];
  checks.push({
    name: "[iso+gate+wt] status = review_pass",
    pass: r1 && r1.status === "review_pass",
    detail: r1 ? `status=${r1.status}` : "no result",
  });
  checks.push({
    name: "[iso+gate+wt] resultVersion = 2",
    pass: r1 && r1.resultVersion === 2,
    detail: r1 ? `resultVersion=${r1.resultVersion}` : "no result",
  });
  checks.push({
    name: "[iso+gate+wt] artifacts is array",
    pass: r1 && Array.isArray(r1.artifacts),
    detail: r1 ? `artifacts=${JSON.stringify(r1.artifacts?.length)}` : "no result",
  });
  checks.push({
    name: "[iso+gate+wt] output.truncated is boolean",
    pass: r1 && typeof r1.output?.truncated === "boolean",
    detail: r1 ? `truncated=${r1.output?.truncated}` : "no result",
  });
  checks.push({
    name: "[iso+gate+wt] isolatedRun = true",
    pass: r1 && r1.meta?.isolatedRun === true,
    detail: r1 ? `isolatedRun=${r1.meta?.isolatedRun}` : "no result",
  });
  checks.push({
    name: "[iso+gate+wt] reviewPacketHash present (64 hex chars)",
    pass: r1 && typeof r1.meta?.reviewPacketHash === "string" && r1.meta.reviewPacketHash.length === 64,
    detail: r1 ? `hash=${(r1.meta?.reviewPacketHash || "").slice(0, 16)}...` : "no result",
  });
  checks.push({
    name: "[iso+gate+wt] worktreePath present in meta",
    pass: r1 && typeof r1.meta?.worktreePath === "string" && r1.meta.worktreePath.length > 0,
    detail: r1 ? `worktreePath=${r1.meta?.worktreePath?.slice(0, 60)}` : "no result",
  });
  checks.push({
    name: "[iso+gate+wt] worktreeBranch = agent/reviewer-smoke-test",
    pass: r1 && r1.meta?.worktreeBranch === "agent/reviewer-smoke-test",
    detail: r1 ? `worktreeBranch=${r1.meta?.worktreeBranch}` : "no result",
  });
  checks.push({
    name: "[iso+gate+wt] baseCommit present in meta",
    pass: r1 && typeof r1.meta?.baseCommit === "string" && r1.meta.baseCommit.length > 0,
    detail: r1 ? `baseCommit=${(r1.meta?.baseCommit || "").slice(0, 12)}` : "no result",
  });
  checks.push({
    name: "[iso+gate+wt] NOT failed (report-contract did not false-fail)",
    pass: r1 && r1.status !== "failed",
    detail: r1 ? `status=${r1.status} failureReason=${r1.meta?.failureReason || "none"}` : "no result",
  });
  checks.push({
    name: "[iso+gate+wt] no reportContractViolation in meta",
    pass: r1 && !r1.meta?.reportContractViolation,
    detail: r1 ? `violation=${JSON.stringify(r1.meta?.reportContractViolation || null)}` : "no result",
  });
  // Verify output contains substantive content (stdout has review text)
  checks.push({
    name: "[iso+gate+wt] output.stdout contains REVIEW_PASS marker",
    pass: r1 && typeof r1.output?.stdout === "string" && r1.output.stdout.includes("REVIEW_PASS"),
    detail: r1 ? `stdout_len=${r1.output?.stdout?.length}` : "no result",
  });

  // ── TASK 2: plain review + requireReviewGate + worktree ──

  const r2 = byTask["rms-plain-gate-wt-001"];
  checks.push({
    name: "[plain+gate+wt] status = review_pass",
    pass: r2 && r2.status === "review_pass",
    detail: r2 ? `status=${r2.status}` : "no result",
  });
  checks.push({
    name: "[plain+gate+wt] resultVersion = 2",
    pass: r2 && r2.resultVersion === 2,
    detail: r2 ? `resultVersion=${r2.resultVersion}` : "no result",
  });
  checks.push({
    name: "[plain+gate+wt] artifacts is array",
    pass: r2 && Array.isArray(r2.artifacts),
    detail: r2 ? `artifacts=${JSON.stringify(r2.artifacts?.length)}` : "no result",
  });
  checks.push({
    name: "[plain+gate+wt] worktreePath present in meta",
    pass: r2 && typeof r2.meta?.worktreePath === "string" && r2.meta.worktreePath.length > 0,
    detail: r2 ? `worktreePath=${r2.meta?.worktreePath?.slice(0, 60)}` : "no result",
  });
  checks.push({
    name: "[plain+gate+wt] NOT failed (report-contract did not false-fail)",
    pass: r2 && r2.status !== "failed",
    detail: r2 ? `status=${r2.status} failureReason=${r2.meta?.failureReason || "none"}` : "no result",
  });
  checks.push({
    name: "[plain+gate+wt] no isolatedRun (non-isolated path)",
    pass: r2 && r2.meta?.isolatedRun === undefined,
    detail: r2 ? `isolatedRun=${r2.meta?.isolatedRun}` : "no result",
  });

  // ── Report-contract specific: no report_contract_invalid events ──
  const rcEvents = receivedEvents.filter(
    (e) => e.status === "report_contract_invalid"
  );
  checks.push({
    name: "[contract] zero report_contract_invalid events",
    pass: rcEvents.length === 0,
    detail: `count=${rcEvents.length}`,
  });

  // ── Print ──
  let passed = 0;
  let failed = 0;
  for (const c of checks) {
    const icon = c.pass ? color(32, "PASS") : color(31, "FAIL");
    console.log(`  ${icon}  ${c.name}  (${c.detail})`);
    if (c.pass) passed++;
    else failed++;
  }

  console.log(color(36, "\n" + "-".repeat(70)));
  console.log(color(failed ? 31 : 32, `${passed}/${checks.length} passed, ${failed} failed`));
  console.log(color(36, "-".repeat(70)));

  // ── Dump key result fields for proof ──
  console.log(color(36, "\n── KEY RESULT FIELDS (proof) ──"));
  for (const r of receivedResults) {
    console.log(color(33, `\n  taskId: ${r.taskId}`));
    console.log(`    status: ${r.status}`);
    console.log(`    resultVersion: ${r.resultVersion}`);
    console.log(`    artifacts: ${JSON.stringify(r.artifacts)}`);
    console.log(`    output.truncated: ${r.output?.truncated}`);
    console.log(`    meta.isolatedRun: ${r.meta?.isolatedRun}`);
    console.log(`    meta.reviewPacketHash: ${(r.meta?.reviewPacketHash || "n/a").slice(0, 16)}...`);
    console.log(`    meta.worktreePath: ${r.meta?.worktreePath || "n/a"}`);
    console.log(`    meta.worktreeBranch: ${r.meta?.worktreeBranch || "n/a"}`);
    console.log(`    meta.baseCommit: ${(r.meta?.baseCommit || "n/a").slice(0, 12)}`);
    console.log(`    meta.failureReason: ${r.meta?.failureReason || "none"}`);
    console.log(`    meta.reportContractViolation: ${JSON.stringify(r.meta?.reportContractViolation || null)}`);
    console.log(`    output.stdout length: ${r.output?.stdout?.length || 0}`);
  }

  // cleanup
  if (worker) worker.kill("SIGTERM");
  server.close();
  setTimeout(() => process.exit(failed > 0 ? 1 : 0), 500);
}

// ── Start ──────────────────────────────────────────────────────────────────────

server.listen(0, () => {
  const port = server.address().port;
  console.log(color(36, `\nMock orchestrator on port ${port}`));
  console.log(color(36, `Mock claude: ${mockClaudePath}`));
  console.log(color(36, `Mock repo: ${mockRepoDir}`));
  console.log(color(36, "Starting worker...\n"));

  worker = spawn("node", [path.join(__dirname, "worker.js")], {
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR || "/tmp",
      ORCH_BASE_URL: `http://localhost:${port}`,
      WORKER_TOKEN: "test-token",
      WORKER_ID: "test-reviewer-smoke",
      CLAUDE_CMD: mockClaudePath,
      POLL_INTERVAL_MS: "500",
      ALLOWED_REPOS: mockRepoDir,
      CLAUDE_MODEL: "sonnet",
      REPORT_CONTRACT_ENABLED: "true",
      REPORT_MIN_LENGTH: "50",
      REPORT_RETRY_ENABLED: "false",
      MAX_PARALLEL_WORKTREES: "2",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  worker.stdout.on("data", (d) => {
    const text = d.toString();
    for (const line of text.split("\n").filter(Boolean)) {
      try {
        const obj = JSON.parse(line);
        if (
          obj.msg?.includes("report_contract") ||
          obj.msg?.includes("isolated") ||
          obj.msg?.includes("worktree") ||
          obj.msg?.includes("task done") ||
          obj.msg?.includes("review") ||
          obj.level === "error"
        ) {
          console.log(color(35, `[worker] ${line.slice(0, 200)}`));
        }
      } catch {
        // not JSON
      }
    }
  });
  worker.stderr.on("data", (d) => {
    console.log(color(31, `[worker stderr] ${d.toString().trim()}`));
  });
  worker.on("exit", (code) => {
    console.log(color(36, `[worker] exited with code ${code}`));
    finish();
  });

  // Safety timeout
  setTimeout(() => {
    console.log(color(31, "\n[TIMEOUT] Test exceeded 30s safety limit"));
    finish();
  }, 30000);
});
