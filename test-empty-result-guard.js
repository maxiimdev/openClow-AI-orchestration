#!/usr/bin/env node
"use strict";

/**
 * Integration test: Empty Result Hard Guard
 *
 * Proves:
 *   1. Empty result string → failed (contract catches it)
 *   2. Whitespace-only result → failed (contract catches it)
 *   3. Valid non-empty result → completed (passes all checks)
 *   4. Regression: report_contract retry flow still works end-to-end
 *   5. Empty result with allowShortReport (bypasses contract) → hard guard catches it → failed
 *   6. Whitespace result with allowShortReport (bypasses contract) → hard guard catches it → failed
 *
 * Usage: node test-empty-result-guard.js
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn, execSync } = require("child_process");

// ── Mock repo + mock claude ───────────────────────────────────────────────────

const mockClaudeDir = fs.mkdtempSync(path.join(os.tmpdir(), "mock-claude-erg-"));
const mockClaudePath = path.join(mockClaudeDir, "claude");
const mockRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-repo-erg-"));

execSync("git init", { cwd: mockRepoDir, stdio: "ignore" });
execSync("git commit --allow-empty -m init", { cwd: mockRepoDir, stdio: "ignore" });

const mockClaudeScript = `#!/usr/bin/env node
"use strict";
const fs = require("fs");
const prompt = process.argv[process.argv.indexOf("-p") + 1] || "";
const countFile = ${JSON.stringify(path.join(mockClaudeDir, "call-counts.json"))};

let counts = {};
try { counts = JSON.parse(fs.readFileSync(countFile, "utf-8")); } catch {}
const taskMatch = prompt.match(/taskId[=:]\\s*(\\S+)/);
const taskId = taskMatch ? taskMatch[1] : "unknown";
counts[taskId] = (counts[taskId] || 0) + 1;
fs.writeFileSync(countFile, JSON.stringify(counts));

if (prompt.includes("erg-empty")) {
  process.stdout.write(JSON.stringify({
    type: "result", subtype: "success",
    result: "",
    is_error: false,
  }));
  process.exit(0);
}

if (prompt.includes("erg-whitespace")) {
  process.stdout.write(JSON.stringify({
    type: "result", subtype: "success",
    result: "   \\n\\t  \\n  ",
    is_error: false,
  }));
  process.exit(0);
}

if (prompt.includes("erg-valid")) {
  process.stdout.write(JSON.stringify({
    type: "result", subtype: "success",
    result: "This is a comprehensive and detailed report of all the implementation work that was completed successfully with full test coverage.",
    is_error: false,
  }));
  process.exit(0);
}

if (prompt.includes("erg-retry-regression")) {
  if (counts[taskId] <= 1) {
    process.stdout.write(JSON.stringify({
      type: "result", subtype: "success",
      result: "",
      is_error: false,
    }));
  } else {
    process.stdout.write(JSON.stringify({
      type: "result", subtype: "success",
      result: "After retry: this is a detailed report of all changes made. The authentication module was refactored and database migrations were applied. All tests pass.",
      is_error: false,
    }));
  }
  process.exit(0);
}

// Default: valid report
process.stdout.write(JSON.stringify({
  type: "result", subtype: "success",
  result: "Default valid report with sufficient length to pass all contract checks and guard validations.",
  is_error: false,
}));
process.exit(0);
`;

fs.writeFileSync(mockClaudePath, mockClaudeScript, { mode: 0o755 });

// ── Task definitions ──────────────────────────────────────────────────────────

const SCOPE = { repoPath: mockRepoDir, branch: "agent/empty-result-guard-test" };

const PULL_SEQUENCE = [
  // 1-2: contract-enabled, retry disabled — contract catches empty/whitespace
  {
    taskId: "erg-empty-001",
    mode: "implement",
    scope: SCOPE,
    instructions: "taskId: erg-empty-001. Implement the feature.",
    reportRetryOnViolation: false,
  },
  {
    taskId: "erg-whitespace-001",
    mode: "implement",
    scope: SCOPE,
    instructions: "taskId: erg-whitespace-001. Implement the feature.",
    reportRetryOnViolation: false,
  },
  // 3: valid result — passes everything
  {
    taskId: "erg-valid-001",
    mode: "implement",
    scope: SCOPE,
    instructions: "taskId: erg-valid-001. Implement the feature.",
  },
  // 4: retry regression — first empty triggers retry, second valid → completed
  {
    taskId: "erg-retry-regression-001",
    mode: "implement",
    scope: SCOPE,
    instructions: "taskId: erg-retry-regression-001. Implement the feature.",
  },
  // 5-6: allowShortReport bypasses contract → hard guard must catch empty/whitespace
  {
    taskId: "erg-empty-bypass-001",
    mode: "implement",
    scope: SCOPE,
    instructions: "taskId: erg-empty-bypass-001. Implement the feature.",
    allowShortReport: true,
    reportRetryOnViolation: false,
  },
  {
    taskId: "erg-whitespace-bypass-001",
    mode: "implement",
    scope: SCOPE,
    instructions: "taskId: erg-whitespace-bypass-001. Implement the feature.",
    allowShortReport: true,
    reportRetryOnViolation: false,
  },
];

const EXPECTED_RESULTS = PULL_SEQUENCE.length;

// ── State ─────────────────────────────────────────────────────────────────────

let pullCount = 0;
let receivedResults = [];
let receivedEvents = [];
let worker = null;

function color(code, text) {
  return `\x1b[${code}m${text}\x1b[0m`;
}

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
        report_contract_invalid: 31,
        report_retry_attempt: 33,
        completed: 32, failed: 31,
      }[ev.status] || 37;
      console.log(color(statusColor, `[orch] ← event: ${ev.status}/${ev.phase} — ${(ev.message || "").slice(0, 150)}`));
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
      if (result.meta?.emptyResultGuard) {
        console.log(color(33, `[orch]    emptyResultGuard: true`));
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
  console.log(color(36, "TEST RESULTS — Empty Result Hard Guard"));
  console.log(color(36, "=".repeat(60)));

  const byTask = {};
  for (const r of receivedResults) {
    byTask[r.taskId] = r;
  }

  const checks = [];

  // 1. Empty result → failed (contract catches it)
  const r_empty = byTask["erg-empty-001"];
  checks.push({
    name: "empty result → failed",
    pass: r_empty && r_empty.status === "failed",
    detail: r_empty ? `status=${r_empty.status}` : "no result",
  });
  checks.push({
    name: "empty result → failureReason present",
    pass: r_empty && !!r_empty.meta?.failureReason,
    detail: r_empty ? `failureReason=${r_empty.meta?.failureReason}` : "no result",
  });

  // 2. Whitespace-only result → failed (contract catches it)
  const r_ws = byTask["erg-whitespace-001"];
  checks.push({
    name: "whitespace-only result → failed",
    pass: r_ws && r_ws.status === "failed",
    detail: r_ws ? `status=${r_ws.status}` : "no result",
  });
  checks.push({
    name: "whitespace-only result → failureReason present",
    pass: r_ws && !!r_ws.meta?.failureReason,
    detail: r_ws ? `failureReason=${r_ws.meta?.failureReason}` : "no result",
  });

  // 3. Valid non-empty result → completed
  const r_valid = byTask["erg-valid-001"];
  checks.push({
    name: "valid non-empty result → completed",
    pass: r_valid && r_valid.status === "completed",
    detail: r_valid ? `status=${r_valid.status}` : "no result",
  });
  checks.push({
    name: "valid result → no emptyResultGuard flag",
    pass: r_valid && !r_valid.meta?.emptyResultGuard,
    detail: r_valid ? `emptyResultGuard=${r_valid.meta?.emptyResultGuard}` : "no result",
  });

  // 4. Retry regression: first empty → retry → valid → completed
  const r_retry = byTask["erg-retry-regression-001"];
  checks.push({
    name: "retry regression → completed after successful retry",
    pass: r_retry && r_retry.status === "completed",
    detail: r_retry ? `status=${r_retry.status}` : "no result",
  });
  const retryEvent = receivedEvents.find(
    (e) => e.status === "report_retry_attempt" && e.taskId === "erg-retry-regression-001"
  );
  checks.push({
    name: "retry regression → report_retry_attempt event emitted",
    pass: !!retryEvent,
    detail: retryEvent ? `phase=${retryEvent.phase}` : "not found",
  });
  checks.push({
    name: "retry regression → no emptyResultGuard flag on success",
    pass: r_retry && !r_retry.meta?.emptyResultGuard,
    detail: r_retry ? `emptyResultGuard=${r_retry.meta?.emptyResultGuard}` : "no result",
  });

  // 5. Empty with allowShortReport (bypasses contract) → hard guard catches → failed
  const r_bypass_empty = byTask["erg-empty-bypass-001"];
  checks.push({
    name: "empty+allowShortReport → failed (hard guard)",
    pass: r_bypass_empty && r_bypass_empty.status === "failed",
    detail: r_bypass_empty ? `status=${r_bypass_empty.status}` : "no result",
  });
  checks.push({
    name: "empty+allowShortReport → emptyResultGuard flag set",
    pass: r_bypass_empty && r_bypass_empty.meta?.emptyResultGuard === true,
    detail: r_bypass_empty ? `emptyResultGuard=${r_bypass_empty.meta?.emptyResultGuard}` : "no result",
  });
  checks.push({
    name: "empty+allowShortReport → failureReason = empty_result",
    pass: r_bypass_empty && r_bypass_empty.meta?.failureReason === "empty_result",
    detail: r_bypass_empty ? `failureReason=${r_bypass_empty.meta?.failureReason}` : "no result",
  });

  // 6. Whitespace with allowShortReport (bypasses contract) → hard guard catches → failed
  const r_bypass_ws = byTask["erg-whitespace-bypass-001"];
  checks.push({
    name: "whitespace+allowShortReport → failed (hard guard)",
    pass: r_bypass_ws && r_bypass_ws.status === "failed",
    detail: r_bypass_ws ? `status=${r_bypass_ws.status}` : "no result",
  });
  checks.push({
    name: "whitespace+allowShortReport → emptyResultGuard flag set",
    pass: r_bypass_ws && r_bypass_ws.meta?.emptyResultGuard === true,
    detail: r_bypass_ws ? `emptyResultGuard=${r_bypass_ws.meta?.emptyResultGuard}` : "no result",
  });
  checks.push({
    name: "whitespace+allowShortReport → failureReason = empty_result",
    pass: r_bypass_ws && r_bypass_ws.meta?.failureReason === "empty_result",
    detail: r_bypass_ws ? `failureReason=${r_bypass_ws.meta?.failureReason}` : "no result",
  });

  // 7. Verify hard guard events emitted for bypass cases
  const guardEvents = receivedEvents.filter(
    (e) => e.message && e.message.includes("hard guard")
  );
  checks.push({
    name: "hard guard events emitted for contract-bypassed empty results",
    pass: guardEvents.length >= 2,
    detail: `count=${guardEvents.length}`,
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
    REPORT_SCHEMA_STRICT: "false",
    ORCH_BASE_URL: `http://127.0.0.1:${port}`,
    WORKER_TOKEN: "test-token",
    WORKER_ID: "test-empty-result-guard",
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
          obj.msg.includes("empty_result") ||
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
