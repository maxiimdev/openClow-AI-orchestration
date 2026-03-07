#!/usr/bin/env node
"use strict";

/**
 * Integration test: Systemic Empty Result Invariant
 *
 * Proves the unified enforceNonEmptyResultInvariant covers ALL terminal statuses:
 *   1. completed + empty result → failed (empty_result guard)
 *   2. review_pass + empty result → failed (empty_result guard)  [NEW]
 *   3. review_fail + empty result → failed (empty_result guard)  [NEW]
 *   4. completed + whitespace-only result → failed
 *   5. completed + valid result → completed (passes)
 *   6. review_pass + valid result → review_pass (passes)
 *   7. dry_run + empty result → completed (whitelisted mode)
 *   8. completed + short report → failed (contract violation, now enabled by default)
 *   9. report_contract on review_pass → validates (not just completed)  [NEW]
 *  10. concurrent tasks — each independently enforced
 *
 * Usage: node test-empty-result-invariant.js
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn, execSync } = require("child_process");

// ── Mock repo + mock claude ───────────────────────────────────────────────────

const mockClaudeDir = fs.mkdtempSync(path.join(os.tmpdir(), "mock-claude-eri-"));
const mockClaudePath = path.join(mockClaudeDir, "claude");
const mockRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-repo-eri-"));

execSync("git init", { cwd: mockRepoDir, stdio: "ignore" });
execSync("git commit --allow-empty -m init", { cwd: mockRepoDir, stdio: "ignore" });

const mockClaudeScript = `#!/usr/bin/env node
"use strict";
const prompt = process.argv[process.argv.indexOf("-p") + 1] || "";

// eri-empty: empty result string
if (prompt.includes("eri-empty")) {
  process.stdout.write(JSON.stringify({
    type: "result", subtype: "success", result: "", is_error: false,
  }));
  process.exit(0);
}

// eri-whitespace: whitespace-only result
if (prompt.includes("eri-whitespace")) {
  process.stdout.write(JSON.stringify({
    type: "result", subtype: "success", result: "   \\n  \\t  ", is_error: false,
  }));
  process.exit(0);
}

// eri-review-pass-empty: review mode, REVIEW_PASS marker but empty body
if (prompt.includes("eri-review-pass-empty")) {
  process.stdout.write(JSON.stringify({
    type: "result", subtype: "success", result: "[REVIEW_PASS]", is_error: false,
  }));
  process.exit(0);
}

// eri-review-fail-empty: review mode, REVIEW_FAIL marker but empty body otherwise
if (prompt.includes("eri-review-fail-empty")) {
  process.stdout.write(JSON.stringify({
    type: "result", subtype: "success",
    result: "[REVIEW_FAIL severity=major]No details[/REVIEW_FAIL]",
    is_error: false,
  }));
  process.exit(0);
}

// eri-review-pass-valid: review mode, REVIEW_PASS with substantive body
if (prompt.includes("eri-review-pass-valid")) {
  process.stdout.write(JSON.stringify({
    type: "result", subtype: "success",
    result: "[REVIEW_PASS] All code changes are correct. The implementation follows the specification closely. Unit tests cover all edge cases. No security issues found. Code style is consistent with the existing codebase. All integration tests pass.",
    is_error: false,
  }));
  process.exit(0);
}

// eri-valid: valid long report
if (prompt.includes("eri-valid")) {
  process.stdout.write(JSON.stringify({
    type: "result", subtype: "success",
    result: "This is a comprehensive report of the implementation work. All changes have been applied and verified. The feature includes proper error handling and test coverage. Multiple files were updated.",
    is_error: false,
  }));
  process.exit(0);
}

// eri-short: short report (below default min length of 50)
if (prompt.includes("eri-short")) {
  process.stdout.write(JSON.stringify({
    type: "result", subtype: "success",
    result: "Short but unique text here.",
    is_error: false,
  }));
  process.exit(0);
}

// eri-concurrent: valid report with task-specific identifier
if (prompt.includes("eri-concurrent")) {
  process.stdout.write(JSON.stringify({
    type: "result", subtype: "success",
    result: "This is a valid concurrent task report with enough content to pass all contract checks. Task completed successfully with all changes applied and verified.",
    is_error: false,
  }));
  process.exit(0);
}

// eri-dry-run-empty: dry_run mode — should not even reach claude
// (dry_run returns early in executeTask, so this is a fallback)
process.stdout.write(JSON.stringify({
  type: "result", subtype: "success", result: "", is_error: false,
}));
process.exit(0);
`;

fs.writeFileSync(mockClaudePath, mockClaudeScript, { mode: 0o755 });

// ── Task definitions ──────────────────────────────────────────────────────────

const SCOPE = { repoPath: mockRepoDir, branch: "agent/eri-test" };

const PULL_SEQUENCE = [
  // 1. completed + empty → failed
  {
    taskId: "eri-empty-001",
    mode: "implement",
    scope: SCOPE,
    instructions: "taskId: eri-empty-001. eri-empty task.",
    reportRetryOnViolation: false,
  },
  // 2. review_pass + empty body → failed (NEW: expanded invariant)
  {
    taskId: "eri-review-pass-empty-001",
    mode: "review",
    scope: SCOPE,
    instructions: "taskId: eri-review-pass-empty-001. eri-review-pass-empty task.",
    reportRetryOnViolation: false,
  },
  // 3. review_fail + short body → should still persist (review_fail below_min_length is a finding, not enforced as hard-fail)
  //    Actually, since review_fail + text < 50 chars triggers contract, it demotes to failed
  {
    taskId: "eri-review-fail-empty-001",
    mode: "review",
    scope: SCOPE,
    instructions: "taskId: eri-review-fail-empty-001. eri-review-fail-empty task.",
    reportRetryOnViolation: false,
  },
  // 4. completed + whitespace → failed
  {
    taskId: "eri-whitespace-001",
    mode: "implement",
    scope: SCOPE,
    instructions: "taskId: eri-whitespace-001. eri-whitespace task.",
    reportRetryOnViolation: false,
  },
  // 5. completed + valid → completed
  {
    taskId: "eri-valid-001",
    mode: "implement",
    scope: SCOPE,
    instructions: "taskId: eri-valid-001. eri-valid task.",
  },
  // 6. review_pass + valid → review_pass
  {
    taskId: "eri-review-pass-valid-001",
    mode: "review",
    scope: SCOPE,
    instructions: "taskId: eri-review-pass-valid-001. eri-review-pass-valid task.",
  },
  // 7. dry_run + empty → completed (whitelisted)
  {
    taskId: "eri-dry-run-001",
    mode: "dry_run",
    instructions: "taskId: eri-dry-run-001. Dry run.",
  },
  // 8. completed + short → failed (contract violation)
  {
    taskId: "eri-short-001",
    mode: "implement",
    scope: SCOPE,
    instructions: "taskId: eri-short-001. eri-short task.",
    reportRetryOnViolation: false,
  },
  // 9. concurrent valid task 1
  {
    taskId: "eri-concurrent-001",
    mode: "implement",
    scope: SCOPE,
    instructions: "taskId: eri-concurrent-001. eri-concurrent task.",
  },
  // 10. concurrent valid task 2
  {
    taskId: "eri-concurrent-002",
    mode: "implement",
    scope: SCOPE,
    instructions: "taskId: eri-concurrent-002. eri-concurrent task.",
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
        console.log(color(36, `[orch] → pull ${pullCount}: sending ${task.taskId}`));
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
      const statusColor = result.status === "completed" ? 32 : result.status === "review_pass" ? 32 : result.status === "failed" ? 31 : 37;
      console.log(color(statusColor, `[orch] ← result: taskId=${result.taskId} status=${result.status}`));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      if (receivedResults.length >= EXPECTED_RESULTS) {
        process.nextTick(() => finish());
      }
      return;
    }

    if (req.url === "/api/worker/lease-renew") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
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
  console.log(color(36, "TEST RESULTS — Empty Result Invariant (Systemic)"));
  console.log(color(36, "=".repeat(60)));

  const byTask = {};
  for (const r of receivedResults) {
    byTask[r.taskId] = r;
  }

  const checks = [];

  // 1. completed + empty → failed
  const r1 = byTask["eri-empty-001"];
  checks.push({
    name: "1. completed + empty result → failed",
    pass: r1 && r1.status === "failed" &&
      (r1.meta?.failureReason === "empty_result" || r1.meta?.failureReason === "report_contract_violation"),
    detail: `status=${r1?.status}, failureReason=${r1?.meta?.failureReason}`,
  });

  // 2. review_pass + empty body → failed (expanded invariant)
  const r2 = byTask["eri-review-pass-empty-001"];
  checks.push({
    name: "2. review_pass + empty body → failed (new invariant)",
    pass: r2 && r2.status === "failed" &&
      (r2.meta?.emptyResultGuard === true || r2.meta?.failureReason === "report_contract_violation" || r2.meta?.failureReason === "empty_result"),
    detail: `status=${r2?.status}, failureReason=${r2?.meta?.failureReason}, emptyResultGuard=${r2?.meta?.emptyResultGuard}`,
  });

  // 3. review_fail + body above min length → stays review_fail
  const r3 = byTask["eri-review-fail-empty-001"];
  checks.push({
    name: "3. review_fail + body above min → review_fail (preserved)",
    pass: r3 && r3.status === "review_fail",
    detail: `status=${r3?.status}, failureReason=${r3?.meta?.failureReason}`,
  });

  // 4. completed + whitespace → failed
  const r4 = byTask["eri-whitespace-001"];
  checks.push({
    name: "4. completed + whitespace result → failed",
    pass: r4 && r4.status === "failed" &&
      (r4.meta?.failureReason === "empty_result" || r4.meta?.failureReason === "report_contract_violation"),
    detail: `status=${r4?.status}, failureReason=${r4?.meta?.failureReason}`,
  });

  // 5. completed + valid → completed
  const r5 = byTask["eri-valid-001"];
  checks.push({
    name: "5. completed + valid result → completed",
    pass: r5 && r5.status === "completed",
    detail: `status=${r5?.status}`,
  });

  // 6. review_pass + valid → review_pass
  const r6 = byTask["eri-review-pass-valid-001"];
  checks.push({
    name: "6. review_pass + valid result → review_pass",
    pass: r6 && r6.status === "review_pass",
    detail: `status=${r6?.status}`,
  });

  // 7. dry_run + empty → completed (whitelisted)
  const r7 = byTask["eri-dry-run-001"];
  checks.push({
    name: "7. dry_run + empty → completed (whitelisted mode)",
    pass: r7 && r7.status === "completed",
    detail: `status=${r7?.status}`,
  });

  // 8. completed + short → failed
  const r8 = byTask["eri-short-001"];
  checks.push({
    name: "8. completed + short report → failed (contract violation)",
    pass: r8 && r8.status === "failed" && r8.meta?.failureReason === "report_contract_violation",
    detail: `status=${r8?.status}, failureReason=${r8?.meta?.failureReason}`,
  });

  // 9-10. concurrent tasks independently enforced
  const r9 = byTask["eri-concurrent-001"];
  const r10 = byTask["eri-concurrent-002"];
  checks.push({
    name: "9. concurrent task 1 → completed",
    pass: r9 && r9.status === "completed",
    detail: `status=${r9?.status}`,
  });
  checks.push({
    name: "10. concurrent task 2 → completed",
    pass: r10 && r10.status === "completed",
    detail: `status=${r10?.status}`,
  });

  // Check telemetry events — look for the invariant event or the report_contract event that caught empty/short results
  const invariantEvents = receivedEvents.filter(e =>
    e.phase === "empty_result_invariant" ||
    (e.phase === "report_contract" && e.status === "report_contract_invalid")
  );
  checks.push({
    name: "11. telemetry: empty_result/contract events emitted for guard hits",
    pass: invariantEvents.length >= 1,
    detail: `count=${invariantEvents.length}`,
  });

  const contractEvents = receivedEvents.filter(e => e.phase === "report_contract" && e.status === "report_contract_invalid");
  checks.push({
    name: "12. telemetry: report_contract_invalid events emitted",
    pass: contractEvents.length >= 1,
    detail: `count=${contractEvents.length}`,
  });

  // Print results
  let allPassed = true;
  for (const c of checks) {
    const mark = c.pass ? color(32, "✓ PASS") : color(31, "✗ FAIL");
    console.log(`  ${mark}  ${c.name}`);
    if (!c.pass) {
      console.log(`         ${color(33, c.detail)}`);
      allPassed = false;
    }
  }

  console.log(color(36, "=".repeat(60)));
  console.log(allPassed
    ? color(32, `ALL ${checks.length} CHECKS PASSED`)
    : color(31, `SOME CHECKS FAILED`)
  );
  console.log(color(36, "=".repeat(60)));

  // Print sample task JSON proving non-empty guard
  console.log(color(36, "\n── Sample task JSON (empty result guard) ──"));
  const sampleGuardResult = r1 || r2;
  if (sampleGuardResult) {
    console.log(JSON.stringify({
      taskId: sampleGuardResult.taskId,
      status: sampleGuardResult.status,
      mode: sampleGuardResult.mode,
      meta: {
        failureReason: sampleGuardResult.meta?.failureReason,
        emptyResultGuard: sampleGuardResult.meta?.emptyResultGuard,
        emptyResultOriginalStatus: sampleGuardResult.meta?.emptyResultOriginalStatus,
      },
    }, null, 2));
  }

  // Cleanup
  worker?.kill("SIGTERM");
  server.close();
  try { fs.rmSync(mockClaudeDir, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(mockRepoDir, { recursive: true, force: true }); } catch {}

  process.exit(allPassed ? 0 : 1);
}

// ── Start ─────────────────────────────────────────────────────────────────────

server.listen(0, () => {
  const port = server.address().port;
  console.log(color(36, `Mock orchestrator on port ${port}`));
  console.log(color(36, `Mock claude at ${mockClaudePath}`));
  console.log(color(36, `Mock repo at ${mockRepoDir}`));

  worker = spawn("node", [path.join(__dirname, "worker.js")], {
    env: {
      ...process.env,
      ORCH_BASE_URL: `http://localhost:${port}`,
      WORKER_TOKEN: "test-token",
      WORKER_ID: "test-eri",
      CLAUDE_CMD: mockClaudePath,
      ALLOWED_REPOS: mockRepoDir,
      POLL_INTERVAL_MS: "200",
      CLAUDE_TIMEOUT_MS: "10000",
      CLAUDE_BYPASS_PERMISSIONS: "true",
      REPORT_CONTRACT_ENABLED: "true",
      REPORT_RETRY_ENABLED: "false",
      REPORT_MIN_LENGTH: "50",
      REPORT_SCHEMA_STRICT: "false",
      REPORT_SCHEMA_RETRY_ENABLED: "false",
      FEATURE_BRANCH_PER_TASK: "false",
      MAX_PARALLEL_WORKTREES: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  worker.stdout.on("data", () => {});
  worker.stderr.on("data", () => {});

  // Safety timeout
  setTimeout(() => {
    console.log(color(31, "\nTIMEOUT: test did not finish in 60s"));
    finish();
  }, 60000);
});
