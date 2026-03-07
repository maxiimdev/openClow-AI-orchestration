#!/usr/bin/env node
"use strict";

/**
 * Integration test: merge-run report schema (proof schema)
 *
 * Root cause reproduced here:
 *   With REPORT_SCHEMA_STRICT=true, tasks that are not explicitly mergeRun fall into the
 *   "standard" schema (requires changelog + tests). Merge-run tasks produce no code-change
 *   delta and run no test suite — their reports naturally lack those sections and were
 *   incorrectly marked failed.
 *
 * Fix verified here:
 *   task.mergeRun=true routes to "proof" schema (requires evidence + commit only).
 *   A concise merge report with gh-merge output and a commit hash → completed.
 *   A stub report with no proof fields → failed (schema_violation).
 *
 * Tests:
 *   1. merge-run + concise proof report (evidence + commit) → completed
 *   2. merge-run + stub report (no evidence, no commit) → failed, reportSchemaViolation
 *   3. non-merge-run + standard report (changelog + tests) → completed (regression)
 *   4. non-merge-run + stub report (no changelog, no tests) → failed (regression)
 *
 * Usage: node test-merge-run-report.js
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn, execSync } = require("child_process");

// ── Mock repo + mock claude ───────────────────────────────────────────────────

const mockClaudeDir = fs.mkdtempSync(path.join(os.tmpdir(), "mock-claude-mr-"));
const mockClaudePath = path.join(mockClaudeDir, "claude");
const mockRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-repo-mr-"));

execSync("git init", { cwd: mockRepoDir, stdio: "ignore" });
execSync('git config user.email "test@test.com"', { cwd: mockRepoDir, stdio: "ignore" });
execSync('git config user.name "Test"', { cwd: mockRepoDir, stdio: "ignore" });
execSync("git commit --allow-empty -m init", { cwd: mockRepoDir, stdio: "ignore" });

const mockClaudeScript = `#!/usr/bin/env node
"use strict";
const prompt = process.argv[process.argv.indexOf("-p") + 1] || "";

// ── 1. merge-run proof pass: evidence + commit present ──────────────────────
if (prompt.includes("mr-proof-pass")) {
  process.stdout.write(JSON.stringify({
    type: "result", subtype: "success",
    result: [
      "## Merge Result",
      "PR #42 merged successfully into main.",
      "",
      "## Evidence",
      "Commands run:",
      "  gh pr merge 42 --merge --admin",
      "  Output: Merged pull request #42 (feature/my-feature)",
      "",
      "## Commit",
      "Merge commit: abc1234def5678",
    ].join("\\n"),
    is_error: false,
  }));
  process.exit(0);
}

// ── 2. merge-run stub fail: no evidence, no commit ──────────────────────────
if (prompt.includes("mr-stub-fail")) {
  process.stdout.write(JSON.stringify({
    type: "result", subtype: "success",
    // Intentionally omits evidence (commands run) and commit hash — triggers proof schema violation.
    // Length > 50 to pass the basic contract length check and reach schema validation.
    result: "The pull request has been merged successfully into the main branch. No further action required.",
    is_error: false,
  }));
  process.exit(0);
}

// ── 3. non-merge-run standard pass: changelog + tests ───────────────────────
if (prompt.includes("mr-standard-pass")) {
  process.stdout.write(JSON.stringify({
    type: "result", subtype: "success",
    result: [
      "## Changes",
      "- src/index.js: updated utility functions",
      "",
      "## Test Results",
      "All tests pass. 8 passing, 0 failing.",
    ].join("\\n"),
    is_error: false,
  }));
  process.exit(0);
}

// ── 4. non-merge-run stub fail: no changelog, no tests ──────────────────────
if (prompt.includes("mr-standard-fail")) {
  process.stdout.write(JSON.stringify({
    type: "result", subtype: "success",
    result: "Updated the utility module and verified everything works correctly.",
    is_error: false,
  }));
  process.exit(0);
}

// Default
process.stdout.write(JSON.stringify({
  type: "result", subtype: "success",
  result: "Default response from mock claude.",
  is_error: false,
}));
process.exit(0);
`;

fs.writeFileSync(mockClaudePath, mockClaudeScript, { mode: 0o755 });

// ── Task definitions ──────────────────────────────────────────────────────────

const SCOPE = { repoPath: mockRepoDir, branch: "agent/merge-run-test" };

// 1. merge-run with full proof report → completed
const TASK_MERGE_PROOF_PASS = {
  taskId: "mr-proof-pass-001",
  mode: "implement",
  scope: SCOPE,
  instructions: "taskId: mr-proof-pass-001. Merge PR #42 into main.",
  mergeRun: true,
  reportRetryOnViolation: false,
  reportSchemaRetryOnViolation: false,
};

// 2. merge-run with stub report (no proof) → failed
const TASK_MERGE_STUB_FAIL = {
  taskId: "mr-stub-fail-001",
  mode: "implement",
  scope: SCOPE,
  instructions: "taskId: mr-stub-fail-001. Merge PR #99 into main.",
  mergeRun: true,
  reportRetryOnViolation: false,
  reportSchemaRetryOnViolation: false,
};

// 3. non-merge-run with changelog+tests → completed (regression: standard schema works)
const TASK_STANDARD_PASS = {
  taskId: "mr-standard-pass-001",
  mode: "implement",
  scope: SCOPE,
  instructions: "taskId: mr-standard-pass-001. Update utility functions.",
  reportRetryOnViolation: false,
  reportSchemaRetryOnViolation: false,
};

// 4. non-merge-run with stub → failed (regression: standard schema still enforces)
const TASK_STANDARD_FAIL = {
  taskId: "mr-standard-fail-001",
  mode: "implement",
  scope: SCOPE,
  instructions: "taskId: mr-standard-fail-001. Update the module.",
  reportRetryOnViolation: false,
  reportSchemaRetryOnViolation: false,
};

// ── State ─────────────────────────────────────────────────────────────────────

let pullCount = 0;
let receivedResults = [];
let receivedEvents = [];
let worker = null;

function color(code, text) {
  return `\x1b[${code}m${text}\x1b[0m`;
}

const PULL_SEQUENCE = [
  TASK_MERGE_PROOF_PASS,   // 1: merge-run proof → completed
  TASK_MERGE_STUB_FAIL,    // 2: merge-run stub → failed
  TASK_STANDARD_PASS,      // 3: non-merge standard → completed
  TASK_STANDARD_FAIL,      // 4: non-merge stub → failed
];

const EXPECTED_RESULTS = PULL_SEQUENCE.length;

// ── Mock orchestrator ─────────────────────────────────────────────────────────

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
        console.log(color(36, `\n[orch] → pull ${pullCount}: sending ${task.taskId}`));
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
      const statusColor = {
        report_schema_invalid: 31,
        completed: 32, failed: 31,
      }[ev.status] || 37;
      console.log(color(statusColor, `[orch] ← event: ${ev.status}/${ev.phase} — ${(ev.message || "").slice(0, 120)}`));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.url === "/api/worker/result") {
      const result = JSON.parse(body);
      receivedResults.push(result);
      const statusColor = result.status === "completed" ? 32 : result.status === "failed" ? 31 : 37;
      console.log(color(statusColor, `\n[orch] ← result: taskId=${result.taskId} status=${result.status}`));
      if (result.meta?.failureReason) {
        console.log(color(31, `[orch]    failureReason: ${result.meta.failureReason}`));
      }
      if (result.meta?.reportSchemaViolation) {
        const sv = result.meta.reportSchemaViolation;
        console.log(color(31, `[orch]    schema=${sv.schema} missing=[${sv.missing.map(m => m.key).join(", ")}]`));
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      if (receivedResults.length >= EXPECTED_RESULTS) {
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
  console.log(color(36, "TEST RESULTS — merge-run report (proof schema)"));
  console.log(color(36, "=".repeat(60)));

  const byTask = {};
  for (const r of receivedResults) {
    byTask[r.taskId] = r;
  }

  const checks = [];

  // ── 1. merge-run + full proof report → completed ────────────────────────────
  const r1 = byTask["mr-proof-pass-001"];
  checks.push({
    name: "merge-run + evidence+commit → completed",
    pass: r1?.status === "completed",
    detail: r1 ? `status=${r1.status}` : "no result",
  });
  checks.push({
    name: "merge-run + evidence+commit → no schema violation",
    pass: r1 && !r1.meta?.reportSchemaViolation,
    detail: r1 ? `violation=${JSON.stringify(r1.meta?.reportSchemaViolation ?? null)}` : "no result",
  });

  // ── 2. merge-run + stub (no proof) → failed with proof schema violation ──────
  const r2 = byTask["mr-stub-fail-001"];
  checks.push({
    name: "merge-run + stub (no proof) → failed",
    pass: r2?.status === "failed",
    detail: r2 ? `status=${r2.status}` : "no result",
  });
  checks.push({
    name: "merge-run + stub (no proof) → failureReason = report_contract_violation",
    pass: r2?.meta?.failureReason === "report_contract_violation",
    detail: r2 ? `failureReason=${r2.meta?.failureReason}` : "no result",
  });
  checks.push({
    name: "merge-run + stub (no proof) → schema=proof in violation",
    pass: r2?.meta?.reportSchemaViolation?.schema === "proof",
    detail: r2 ? `schema=${r2.meta?.reportSchemaViolation?.schema}` : "no result",
  });
  checks.push({
    name: "merge-run + stub (no proof) → missing evidence and commit",
    pass: r2?.meta?.reportSchemaViolation?.missing?.length === 2 &&
      r2.meta.reportSchemaViolation.missing.some(m => m.key === "evidence") &&
      r2.meta.reportSchemaViolation.missing.some(m => m.key === "commit"),
    detail: r2 ? `missing=${JSON.stringify(r2.meta?.reportSchemaViolation?.missing?.map(m => m.key))}` : "no result",
  });

  // ── 3. non-merge-run + changelog+tests → completed (regression) ──────────────
  const r3 = byTask["mr-standard-pass-001"];
  checks.push({
    name: "non-merge-run + changelog+tests → completed (standard schema regression)",
    pass: r3?.status === "completed",
    detail: r3 ? `status=${r3.status}` : "no result",
  });

  // ── 4. non-merge-run + stub → failed (standard schema regression) ─────────────
  const r4 = byTask["mr-standard-fail-001"];
  checks.push({
    name: "non-merge-run + stub → failed (standard schema regression)",
    pass: r4?.status === "failed",
    detail: r4 ? `status=${r4.status}` : "no result",
  });
  checks.push({
    name: "non-merge-run + stub → schema=standard in violation",
    pass: r4?.meta?.reportSchemaViolation?.schema === "standard",
    detail: r4 ? `schema=${r4.meta?.reportSchemaViolation?.schema}` : "no result",
  });

  // Print
  let allPass = true;
  for (const c of checks) {
    const icon = c.pass ? color(32, "PASS") : color(31, "FAIL");
    console.log(`  ${icon}  ${c.name}  (${c.detail})`);
    if (!c.pass) allPass = false;
  }

  console.log(color(36, "=".repeat(60)));
  console.log(allPass ? color(32, "ALL TESTS PASSED") : color(31, "SOME TESTS FAILED"));
  console.log(color(36, "=".repeat(60)));

  if (worker) worker.kill("SIGTERM");
  server.close();
  try { fs.rmSync(mockClaudeDir, { recursive: true }); } catch {}
  try { fs.rmSync(mockRepoDir, { recursive: true }); } catch {}

  process.exit(allPass ? 0 : 1);
}

// ── Start ─────────────────────────────────────────────────────────────────────

server.listen(0, () => {
  const port = server.address().port;
  console.log(color(36, `[test] mock orchestrator on port ${port}`));

  const env = {
    ...process.env,
    ORCH_BASE_URL: `http://127.0.0.1:${port}`,
    WORKER_TOKEN: "test-token",
    WORKER_ID: "test-merge-run",
    CLAUDE_CMD: mockClaudePath,
    ALLOWED_REPOS: mockRepoDir,
    POLL_INTERVAL_MS: "300",
    CLAUDE_TIMEOUT_MS: "15000",
    REPORT_CONTRACT_ENABLED: "true",
    REPORT_RETRY_ENABLED: "false",
    REPORT_MIN_LENGTH: "50",
    REPORT_SCHEMA_STRICT: "true",
    REPORT_SCHEMA_RETRY_ENABLED: "false",
    LEASE_TTL_MS: "120000",
    LEASE_RENEW_INTERVAL_MS: "60000",
    MAX_PARALLEL_WORKTREES: "1",
  };

  worker = spawn(process.execPath, [path.join(__dirname, "worker.js")], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  worker.stdout.on("data", (d) => {
    for (const line of d.toString().split("\n").filter(Boolean)) {
      try {
        const obj = JSON.parse(line);
        if (obj.msg && (
          obj.msg.includes("report_schema") ||
          obj.msg.includes("report_contract") ||
          obj.level === "error"
        )) {
          console.log(color(33, `[worker] ${obj.msg} ${JSON.stringify(obj).slice(0, 200)}`));
        }
      } catch { /* non-JSON */ }
    }
  });

  worker.stderr.on("data", (d) => {
    process.stderr.write(color(31, `[worker-err] ${d}`));
  });

  setTimeout(() => {
    console.log(color(31, "\n[test] TIMEOUT — finishing with whatever results we have"));
    finish();
  }, 90000);
});
