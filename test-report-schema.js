#!/usr/bin/env node
"use strict";

/**
 * Integration test: Report Schema Validation
 *
 * Proves:
 *   1. Generic stub rejected for strict-schema task (audit intent)
 *   2. Strict report accepted when all required sections exist
 *   3. Compact smoke report still accepted (reportSchema=compact)
 *   4. Schema retry-then-pass path
 *   5. Schema retry-then-fail path
 *   6. Standard schema (non-audit task with REPORT_SCHEMA_STRICT=true)
 *
 * Usage: node test-report-schema.js
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn, execSync } = require("child_process");

// ── Mock repo + mock claude ───────────────────────────────────────────────────

const mockClaudeDir = fs.mkdtempSync(path.join(os.tmpdir(), "mock-claude-rs-"));
const mockClaudePath = path.join(mockClaudeDir, "claude");
const mockRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-repo-rs-"));

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

if (prompt.includes("rs-strict-fail")) {
  // Generic stub — missing all required strict sections
  const result = {
    type: "result", subtype: "success",
    result: "I have completed the audit task successfully. All files were reviewed and changes applied. Everything looks good and the implementation is solid.",
    is_error: false,
  };
  process.stdout.write(JSON.stringify(result));
  process.exit(0);
}

if (prompt.includes("rs-strict-pass")) {
  // Full strict report with all required sections
  const result = {
    type: "result", subtype: "success",
    result: [
      "## Changelog",
      "- worker.js: added schema validation logic",
      "- test-report-schema.js: new test file",
      "",
      "## Files Changed",
      "| File | Change |",
      "|------|--------|",
      "| worker.js | Added validateReportSchema() |",
      "",
      "## Evidence",
      "Commands run:",
      "  node test-report-schema.js",
      "  git diff --stat",
      "",
      "## Test Summary",
      "- 6 tests pass, 0 fail",
      "- All schema validation paths covered",
      "",
      "## Commit",
      "commit hash: abc1234",
    ].join("\\n"),
    is_error: false,
  };
  process.stdout.write(JSON.stringify(result));
  process.exit(0);
}

if (prompt.includes("rs-compact")) {
  // Short smoke report — compact schema, no sections needed
  const result = {
    type: "result", subtype: "success",
    result: "Smoke test passed. App loads correctly on port 3000. No errors in console.",
    is_error: false,
  };
  process.stdout.write(JSON.stringify(result));
  process.exit(0);
}

if (prompt.includes("rs-retry-pass")) {
  // First call: generic stub; retry: full report
  if (counts[taskId] <= 1) {
    const result = {
      type: "result", subtype: "success",
      result: "Completed the audit hardening task. All systems operational.",
      is_error: false,
    };
    process.stdout.write(JSON.stringify(result));
  } else {
    const result = {
      type: "result", subtype: "success",
      result: [
        "## File-level Changelog",
        "- worker.js: added retry logic",
        "",
        "## Evidence",
        "Commands run: node test.js",
        "",
        "## Test Summary",
        "All tests pass.",
        "",
        "commit hash: def5678",
      ].join("\\n"),
      is_error: false,
    };
    process.stdout.write(JSON.stringify(result));
  }
  process.exit(0);
}

if (prompt.includes("rs-retry-fail")) {
  // Both attempts produce generic stub (no sections)
  const result = {
    type: "result", subtype: "success",
    result: "Completed the audit. Everything is working fine and no issues were found during the review process.",
    is_error: false,
  };
  process.stdout.write(JSON.stringify(result));
  process.exit(0);
}

if (prompt.includes("rs-standard")) {
  // Standard schema — has changelog and tests but no evidence/commit
  const result = {
    type: "result", subtype: "success",
    result: [
      "## Changes",
      "Files changed: src/index.js, src/utils.js",
      "",
      "## Test Results",
      "All tests pass. 12 passing, 0 failing.",
    ].join("\\n"),
    is_error: false,
  };
  process.stdout.write(JSON.stringify(result));
  process.exit(0);
}

// Default: valid long report
const result = {
  type: "result", subtype: "success",
  result: "This is a comprehensive report of the implementation work. All changes have been applied and verified.",
  is_error: false,
};
process.stdout.write(JSON.stringify(result));
process.exit(0);
`;

fs.writeFileSync(mockClaudePath, mockClaudeScript, { mode: 0o755 });

// ── Task definitions ──────────────────────────────────────────────────────────

const SCOPE = { repoPath: mockRepoDir, branch: "agent/report-schema-test" };

// 1. Strict task (audit keyword) with generic stub → should fail
const TASK_STRICT_FAIL = {
  taskId: "rs-strict-fail-001",
  mode: "implement",
  scope: SCOPE,
  instructions: "taskId: rs-strict-fail-001. Perform a security audit of the authentication module.",
  reportRetryOnViolation: false, // disable basic contract retry
  reportSchemaRetryOnViolation: false,
};

// 2. Strict task with full report → should pass
const TASK_STRICT_PASS = {
  taskId: "rs-strict-pass-001",
  mode: "implement",
  scope: SCOPE,
  instructions: "taskId: rs-strict-pass-001. Perform a security audit of the auth module.",
  reportRetryOnViolation: false,
};

// 3. Compact schema override → should pass even with short output
const TASK_COMPACT = {
  taskId: "rs-compact-001",
  mode: "implement",
  scope: SCOPE,
  instructions: "taskId: rs-compact-001. Run smoke test.",
  reportSchema: "compact",
  allowShortReport: true,
  reportRetryOnViolation: false,
};

// 4. Schema retry succeeds
const TASK_RETRY_PASS = {
  taskId: "rs-retry-pass-001",
  mode: "implement",
  scope: SCOPE,
  instructions: "taskId: rs-retry-pass-001. Perform audit hardening task.",
};

// 5. Schema retry fails
const TASK_RETRY_FAIL = {
  taskId: "rs-retry-fail-001",
  mode: "implement",
  scope: SCOPE,
  instructions: "taskId: rs-retry-fail-001. Perform audit review.",
  reportRetryOnViolation: false, // disable basic contract retry
};

// 6. Standard schema (non-audit with strict mode on) → should pass with changelog+tests
const TASK_STANDARD = {
  taskId: "rs-standard-001",
  mode: "implement",
  scope: SCOPE,
  instructions: "taskId: rs-standard-001. Update the utility functions.",
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

// ── Task sequence ─────────────────────────────────────────────────────────────

const PULL_SEQUENCE = [
  TASK_STRICT_FAIL,   // 1: generic stub for audit → schema_violation → fail
  TASK_STRICT_PASS,   // 2: full report for audit → pass
  TASK_COMPACT,       // 3: compact schema → pass
  TASK_RETRY_PASS,    // 4: schema retry succeeds
  TASK_RETRY_FAIL,    // 5: schema retry fails
  TASK_STANDARD,      // 6: standard schema with changelog+tests → pass
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
        report_schema_retry_attempt: 33,
        completed: 32, failed: 31,
      }[ev.status] || 37;
      console.log(color(statusColor, `[orch] ← event: ${ev.status}/${ev.phase} — ${(ev.message || "").slice(0, 140)}`));
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
        console.log(color(31, `[orch]    schema: ${result.meta.reportSchemaViolation.schema}, missing: ${result.meta.reportSchemaViolation.missing.map(m => m.key).join(", ")}`));
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
  console.log(color(36, "TEST RESULTS — Report Schema Validation"));
  console.log(color(36, "=".repeat(60)));

  const byTask = {};
  for (const r of receivedResults) {
    byTask[r.taskId] = r;
  }

  const checks = [];

  // 1. Strict task with generic stub → failed with schema_violation
  const r1 = byTask["rs-strict-fail-001"];
  checks.push({
    name: "strict audit + generic stub → failed",
    pass: r1 && r1.status === "failed",
    detail: r1 ? `status=${r1.status}` : "no result",
  });
  checks.push({
    name: "strict audit + generic stub → failureReason = report_contract_violation",
    pass: r1 && r1.meta?.failureReason === "report_contract_violation",
    detail: r1 ? `failureReason=${r1.meta?.failureReason}` : "no result",
  });
  checks.push({
    name: "strict audit + generic stub → schema violation with missing sections",
    pass: r1 && r1.meta?.reportSchemaViolation?.missing?.length > 0,
    detail: r1 ? `missing=${JSON.stringify(r1.meta?.reportSchemaViolation?.missing?.map(m => m.key))}` : "no result",
  });

  // Verify report_schema_invalid event emitted
  const schemaEvent1 = receivedEvents.find(
    (e) => e.status === "report_schema_invalid" && e.taskId === "rs-strict-fail-001"
  );
  checks.push({
    name: "strict audit + generic stub → report_schema_invalid event emitted",
    pass: !!schemaEvent1,
    detail: schemaEvent1 ? `schema=${schemaEvent1.meta?.schema}` : "not found",
  });

  // 2. Strict task with full report → completed
  const r2 = byTask["rs-strict-pass-001"];
  checks.push({
    name: "strict audit + full report → completed",
    pass: r2 && r2.status === "completed",
    detail: r2 ? `status=${r2.status}` : "no result",
  });

  // 3. Compact schema → completed
  const r3 = byTask["rs-compact-001"];
  checks.push({
    name: "compact schema (smoke) → completed",
    pass: r3 && r3.status === "completed",
    detail: r3 ? `status=${r3.status}` : "no result",
  });

  // 4. Schema retry succeeds → completed
  const r4 = byTask["rs-retry-pass-001"];
  checks.push({
    name: "schema retry-then-pass → completed",
    pass: r4 && r4.status === "completed",
    detail: r4 ? `status=${r4.status}` : "no result",
  });

  const retryEvent = receivedEvents.find(
    (e) => e.status === "report_schema_retry_attempt" && e.taskId === "rs-retry-pass-001"
  );
  checks.push({
    name: "schema retry-then-pass → report_schema_retry_attempt event emitted",
    pass: !!retryEvent,
    detail: retryEvent ? `phase=${retryEvent.phase}` : "not found",
  });

  // 5. Schema retry fails → failed
  const r5 = byTask["rs-retry-fail-001"];
  checks.push({
    name: "schema retry-then-fail → failed",
    pass: r5 && r5.status === "failed",
    detail: r5 ? `status=${r5.status}` : "no result",
  });
  checks.push({
    name: "schema retry-then-fail → has reportSchemaViolation",
    pass: r5 && !!r5.meta?.reportSchemaViolation,
    detail: r5 ? `schema=${r5.meta?.reportSchemaViolation?.schema}` : "no result",
  });

  // 6. Standard schema → completed (has changelog + tests)
  const r6 = byTask["rs-standard-001"];
  checks.push({
    name: "standard schema + changelog/tests → completed",
    pass: r6 && r6.status === "completed",
    detail: r6 ? `status=${r6.status}` : "no result",
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
    WORKER_ID: "test-report-schema",
    CLAUDE_CMD: mockClaudePath,
    ALLOWED_REPOS: mockRepoDir,
    POLL_INTERVAL_MS: "500",
    CLAUDE_TIMEOUT_MS: "15000",
    REPORT_CONTRACT_ENABLED: "true",
    REPORT_RETRY_ENABLED: "false",
    REPORT_MIN_LENGTH: "50",
    REPORT_SCHEMA_STRICT: "true",
    REPORT_SCHEMA_RETRY_ENABLED: "true",
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
  }, 90000);
});
