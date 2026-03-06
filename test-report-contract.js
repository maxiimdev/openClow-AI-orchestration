#!/usr/bin/env node
"use strict";

/**
 * Integration test: Report Contract Guardrails
 *
 * Proves:
 *   1. Empty result with exitCode=0 → report_contract_violation → failed
 *   2. Placeholder acknowledgement → report_contract_violation → failed
 *   3. Valid short report with allowShortReport=true → completed (passes)
 *   4. Retry path succeeds → final success (completed)
 *   5. Retry path fails again → terminal failure with reason
 *   6. Below min length (no allowShortReport) → violation
 *
 * Usage: node test-report-contract.js
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn, execSync } = require("child_process");

// ── Mock repo + mock claude ───────────────────────────────────────────────────

const mockClaudeDir = fs.mkdtempSync(path.join(os.tmpdir(), "mock-claude-rc-"));
const mockClaudePath = path.join(mockClaudeDir, "claude");
const mockRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-repo-rc-"));

execSync("git init", { cwd: mockRepoDir, stdio: "ignore" });
execSync("git commit --allow-empty -m init", { cwd: mockRepoDir, stdio: "ignore" });

// Track how many times each taskId has been called (for retry tests)
const callCounts = {};

const mockClaudeScript = `#!/usr/bin/env node
"use strict";
const fs = require("fs");
const prompt = process.argv[process.argv.indexOf("-p") + 1] || "";
const countFile = ${JSON.stringify(path.join(mockClaudeDir, "call-counts.json"))};

// Track call counts per task
let counts = {};
try { counts = JSON.parse(fs.readFileSync(countFile, "utf-8")); } catch {}
const taskMatch = prompt.match(/taskId[=:]\\s*(\\S+)/);
const taskId = taskMatch ? taskMatch[1] : "unknown";
counts[taskId] = (counts[taskId] || 0) + 1;
fs.writeFileSync(countFile, JSON.stringify(counts));

if (prompt.includes("rc-empty")) {
  // Empty result — should trigger violation
  const result = {
    type: "result", subtype: "success",
    result: "",
    is_error: false,
  };
  process.stdout.write(JSON.stringify(result));
  process.exit(0);
}

if (prompt.includes("rc-placeholder")) {
  // Placeholder pattern — should trigger violation
  const result = {
    type: "result", subtype: "success",
    result: "Acknowledged. All done.",
    is_error: false,
  };
  process.stdout.write(JSON.stringify(result));
  process.exit(0);
}

if (prompt.includes("rc-short-allowed")) {
  // Short output but allowShortReport=true — should pass
  const result = {
    type: "result", subtype: "success",
    result: "OK",
    is_error: false,
  };
  process.stdout.write(JSON.stringify(result));
  process.exit(0);
}

if (prompt.includes("rc-retry-succeed")) {
  // First call: placeholder; retry: real report
  if (counts[taskId] <= 1) {
    const result = {
      type: "result", subtype: "success",
      result: "Done.",
      is_error: false,
    };
    process.stdout.write(JSON.stringify(result));
  } else {
    const result = {
      type: "result", subtype: "success",
      result: "This is a detailed report of the work performed. Multiple files were updated including the authentication module and the database migration scripts. All tests pass and the feature is ready for review.",
      is_error: false,
    };
    process.stdout.write(JSON.stringify(result));
  }
  process.exit(0);
}

if (prompt.includes("rc-retry-fail")) {
  // Both attempts produce placeholder
  const result = {
    type: "result", subtype: "success",
    result: "Ok.",
    is_error: false,
  };
  process.stdout.write(JSON.stringify(result));
  process.exit(0);
}

if (prompt.includes("rc-below-min")) {
  // Below min length, not a placeholder
  const result = {
    type: "result", subtype: "success",
    result: "Short but unique text.",
    is_error: false,
  };
  process.stdout.write(JSON.stringify(result));
  process.exit(0);
}

// Default: valid long report
const result = {
  type: "result", subtype: "success",
  result: "This is a comprehensive report of the implementation work. All changes have been applied and verified. The feature includes proper error handling and test coverage.",
  is_error: false,
};
process.stdout.write(JSON.stringify(result));
process.exit(0);
`;

fs.writeFileSync(mockClaudePath, mockClaudeScript, { mode: 0o755 });

// ── Task definitions ──────────────────────────────────────────────────────────

const SCOPE = { repoPath: mockRepoDir, branch: "agent/report-contract-test" };

const TASK_EMPTY = {
  taskId: "rc-empty-001",
  mode: "implement",
  scope: SCOPE,
  instructions: "taskId: rc-empty-001. Implement the feature.",
};

const TASK_PLACEHOLDER = {
  taskId: "rc-placeholder-001",
  mode: "implement",
  scope: SCOPE,
  instructions: "taskId: rc-placeholder-001. Implement the feature.",
};

const TASK_SHORT_ALLOWED = {
  taskId: "rc-short-allowed-001",
  mode: "implement",
  scope: SCOPE,
  instructions: "taskId: rc-short-allowed-001. Implement the feature.",
  allowShortReport: true,
};

const TASK_RETRY_SUCCEED = {
  taskId: "rc-retry-succeed-001",
  mode: "implement",
  scope: SCOPE,
  instructions: "taskId: rc-retry-succeed-001. Implement the feature.",
};

const TASK_RETRY_FAIL = {
  taskId: "rc-retry-fail-001",
  mode: "implement",
  scope: SCOPE,
  instructions: "taskId: rc-retry-fail-001. Implement the feature.",
};

const TASK_BELOW_MIN = {
  taskId: "rc-below-min-001",
  mode: "implement",
  scope: SCOPE,
  instructions: "taskId: rc-below-min-001. Implement the feature.",
};

// ── State ─────────────────────────────────────────────────────────────────────

let pullCount = 0;
let receivedResults = [];
let receivedEvents = [];
let worker = null;

function color(code, text) {
  return `\x1b[${code}m${text}\x1b[0m`;
}

// ── Task sequence ─────────────────────────────────────────────────────────────
// Tests 1-3 run with REPORT_RETRY_ENABLED=false
// Tests 4-5 need REPORT_RETRY_ENABLED=true
// We run them all as one sequence; retry is enabled globally via env,
// but tasks 1-3 set reportRetryOnViolation=false to disable retry.

const PULL_SEQUENCE = [
  { ...TASK_EMPTY, reportRetryOnViolation: false },           // 1: empty → fail
  { ...TASK_PLACEHOLDER, reportRetryOnViolation: false },     // 2: placeholder → fail
  TASK_SHORT_ALLOWED,                                          // 3: short + opt-out → pass
  TASK_RETRY_SUCCEED,                                          // 4: retry succeeds
  TASK_RETRY_FAIL,                                             // 5: retry fails
  { ...TASK_BELOW_MIN, reportRetryOnViolation: false },       // 6: below min → fail
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

    // ── PULL ──
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

    // ── EVENT ──
    if (req.url === "/api/worker/event") {
      const ev = JSON.parse(body);
      receivedEvents.push(ev);
      const statusColor = {
        report_contract_invalid: 31,
        report_retry_attempt: 33,
        completed: 32, failed: 31,
      }[ev.status] || 37;
      console.log(color(statusColor, `[orch] ← event: ${ev.status}/${ev.phase} — ${(ev.message || "").slice(0, 120)}`));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // ── RESULT ──
    if (req.url === "/api/worker/result") {
      const result = JSON.parse(body);
      receivedResults.push(result);
      const statusColor = result.status === "completed" ? 32 : result.status === "failed" ? 31 : 37;
      console.log(color(statusColor, `\n[orch] ← result: taskId=${result.taskId} status=${result.status}`));
      if (result.meta?.failureReason) {
        console.log(color(31, `[orch]    failureReason: ${result.meta.failureReason}`));
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
  console.log(color(36, "TEST RESULTS — Report Contract Guardrails"));
  console.log(color(36, "=".repeat(60)));

  const byTask = {};
  for (const r of receivedResults) {
    byTask[r.taskId] = r;
  }

  const checks = [];

  // 1. Empty result → failed with report_contract_violation
  const r_empty = byTask["rc-empty-001"];
  checks.push({
    name: "empty result → failed",
    pass: r_empty && r_empty.status === "failed",
    detail: r_empty ? `status=${r_empty.status}` : "no result",
  });
  checks.push({
    name: "empty result → failureReason = report_contract_violation",
    pass: r_empty && r_empty.meta?.failureReason === "report_contract_violation",
    detail: r_empty ? `failureReason=${r_empty.meta?.failureReason}` : "no result",
  });
  checks.push({
    name: "empty result → violation reason = empty_result",
    pass: r_empty && r_empty.meta?.reportContractViolation?.reason === "empty_result",
    detail: r_empty ? `violation.reason=${r_empty.meta?.reportContractViolation?.reason}` : "no result",
  });

  // 2. Placeholder → failed with report_contract_violation
  const r_ph = byTask["rc-placeholder-001"];
  checks.push({
    name: "placeholder → failed",
    pass: r_ph && r_ph.status === "failed",
    detail: r_ph ? `status=${r_ph.status}` : "no result",
  });
  checks.push({
    name: "placeholder → violation reason = placeholder_match",
    pass: r_ph && r_ph.meta?.reportContractViolation?.reason === "placeholder_match",
    detail: r_ph ? `violation.reason=${r_ph.meta?.reportContractViolation?.reason}` : "no result",
  });

  // 3. Short with allowShortReport=true → completed
  const r_short = byTask["rc-short-allowed-001"];
  checks.push({
    name: "allowShortReport=true → completed",
    pass: r_short && r_short.status === "completed",
    detail: r_short ? `status=${r_short.status}` : "no result",
  });

  // 4. Retry succeeds → completed
  const r_retry_ok = byTask["rc-retry-succeed-001"];
  checks.push({
    name: "retry-succeed → completed (after retry)",
    pass: r_retry_ok && r_retry_ok.status === "completed",
    detail: r_retry_ok ? `status=${r_retry_ok.status}` : "no result",
  });

  // Verify retry event was emitted
  const retryEvent = receivedEvents.find(
    (e) => e.status === "report_retry_attempt" && e.taskId === "rc-retry-succeed-001"
  );
  checks.push({
    name: "retry-succeed → report_retry_attempt event emitted",
    pass: !!retryEvent,
    detail: retryEvent ? `phase=${retryEvent.phase}` : "not found",
  });

  // 5. Retry fails again → terminal failure
  const r_retry_fail = byTask["rc-retry-fail-001"];
  checks.push({
    name: "retry-fail → failed (after retry)",
    pass: r_retry_fail && r_retry_fail.status === "failed",
    detail: r_retry_fail ? `status=${r_retry_fail.status}` : "no result",
  });
  checks.push({
    name: "retry-fail → failureReason = report_contract_violation",
    pass: r_retry_fail && r_retry_fail.meta?.failureReason === "report_contract_violation",
    detail: r_retry_fail ? `failureReason=${r_retry_fail.meta?.failureReason}` : "no result",
  });

  // 6. Below min length → failed
  const r_below = byTask["rc-below-min-001"];
  checks.push({
    name: "below-min-length → failed",
    pass: r_below && r_below.status === "failed",
    detail: r_below ? `status=${r_below.status}` : "no result",
  });
  checks.push({
    name: "below-min-length → violation reason = below_min_length",
    pass: r_below && r_below.meta?.reportContractViolation?.reason === "below_min_length",
    detail: r_below ? `violation.reason=${r_below.meta?.reportContractViolation?.reason}` : "no result",
  });

  // 7. report_contract_invalid events emitted for violations
  const contractEvents = receivedEvents.filter(
    (e) => e.status === "report_contract_invalid"
  );
  checks.push({
    name: "report_contract_invalid events emitted for violations",
    pass: contractEvents.length >= 4, // empty, placeholder, retry-succeed(1st), retry-fail(1st), below-min
    detail: `count=${contractEvents.length}`,
  });

  // Print results
  let allPass = true;
  for (const c of checks) {
    const icon = c.pass ? color(32, "PASS") : color(31, "FAIL");
    console.log(`  ${icon}  ${c.name}  (${c.detail})`);
    if (!c.pass) allPass = false;
  }

  console.log(color(36, "=".repeat(60)));
  console.log(allPass ? color(32, "ALL TESTS PASSED") : color(31, "SOME TESTS FAILED"));
  console.log(color(36, "=".repeat(60)));

  // Cleanup
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
    WORKER_ID: "test-report-contract",
    CLAUDE_CMD: mockClaudePath,
    ALLOWED_REPOS: mockRepoDir,
    POLL_INTERVAL_MS: "500",
    CLAUDE_TIMEOUT_MS: "15000",
    REPORT_CONTRACT_ENABLED: "true",
    REPORT_RETRY_ENABLED: "true",
    REPORT_MIN_LENGTH: "50",
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
          obj.msg.includes("report_contract") ||
          obj.msg.includes("report_retry") ||
          obj.level === "error"
        )) {
          console.log(color(33, `[worker] ${obj.msg} ${JSON.stringify(obj).slice(0, 200)}`));
        }
      } catch {
        // non-JSON line
      }
    }
  });

  worker.stderr.on("data", (d) => {
    process.stderr.write(color(31, `[worker-err] ${d}`));
  });

  // Safety timeout
  setTimeout(() => {
    console.log(color(31, "\n[test] TIMEOUT — finishing with whatever results we have"));
    finish();
  }, 60000);
});
