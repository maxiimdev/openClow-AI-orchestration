#!/usr/bin/env node
"use strict";

/**
 * Integration test: Report Schema Auto-Repair
 *
 * Proves:
 *   1. Missing tests+commit → auto-repaired from stdout metadata → completed
 *   2. Missing changelog (non-repairable) → still fails as schema_violation
 *   3. Missing evidence (non-repairable) → still fails as schema_violation
 *   4. report_schema_repaired event emitted with correct repairedKeys
 *   5. Partial repair (only commit found, tests missing) → not repaired → fails
 *
 * Usage: node test-report-schema-repair.js
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn, execSync } = require("child_process");

// ── Mock repo + mock claude ───────────────────────────────────────────────────

const mockClaudeDir = fs.mkdtempSync(path.join(os.tmpdir(), "mock-claude-rsr-"));
const mockClaudePath = path.join(mockClaudeDir, "claude");
const mockRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-repo-rsr-"));

execSync("git init", { cwd: mockRepoDir, stdio: "ignore" });
execSync("git commit --allow-empty -m init", { cwd: mockRepoDir, stdio: "ignore" });

// The mock claude script emits stdout that contains test output and git commit
// hashes in the tool-call portion (before the result JSON), simulating real
// claude CLI output where the result text may lack section headers but the
// raw stdout contains the evidence needed for auto-repair.
const mockClaudeScript = `#!/usr/bin/env node
"use strict";
const prompt = process.argv[process.argv.indexOf("-p") + 1] || "";

if (prompt.includes("rsr-repair-both")) {
  // Has changelog+evidence in result, but missing tests+commit section headers.
  // However, stdout contains test output lines and a git commit hash.
  process.stdout.write("Running tests...\\n");
  process.stdout.write("  6 tests pass, 0 failures\\n");
  process.stdout.write("npm test exited with code 0\\n");
  process.stdout.write("commit abc1234def567890 pushed to origin/feature\\n");
  const result = {
    type: "result", subtype: "success",
    result: [
      "## Changelog",
      "- worker.js: added auto-repair logic",
      "- test-report-schema-repair.js: new test",
      "",
      "## Evidence",
      "Commands run:",
      "  node test-report-schema-repair.js",
      "  git push origin feature",
    ].join("\\n"),
    is_error: false,
  };
  process.stdout.write(JSON.stringify(result));
  process.exit(0);
}

if (prompt.includes("rsr-missing-changelog")) {
  // Missing changelog — NOT auto-repairable
  process.stdout.write("commit fff9999 pushed\\n");
  process.stdout.write("3 tests pass\\n");
  const result = {
    type: "result", subtype: "success",
    result: [
      "## Evidence",
      "Commands run: node test.js",
      "",
      "## Test Summary",
      "3 tests pass",
      "",
      "## Commit",
      "commit: fff9999",
    ].join("\\n"),
    is_error: false,
  };
  process.stdout.write(JSON.stringify(result));
  process.exit(0);
}

if (prompt.includes("rsr-missing-evidence")) {
  // Missing evidence — NOT auto-repairable
  process.stdout.write("commit eee8888 pushed\\n");
  const result = {
    type: "result", subtype: "success",
    result: [
      "## Changelog",
      "- worker.js: updated logic",
      "",
      "## Test Summary",
      "All tests pass",
      "",
      "## Commit",
      "commit: eee8888",
    ].join("\\n"),
    is_error: false,
  };
  process.stdout.write(JSON.stringify(result));
  process.exit(0);
}

if (prompt.includes("rsr-partial-repair")) {
  // Missing tests+commit, but stdout only has commit hash (no test output)
  // → partial repair → should NOT succeed → falls through to fail
  process.stdout.write("commit ddd7777 pushed to remote\\n");
  const result = {
    type: "result", subtype: "success",
    result: [
      "## Changelog",
      "- worker.js: partial changes",
      "",
      "## Evidence",
      "Commands run: git push",
    ].join("\\n"),
    is_error: false,
  };
  process.stdout.write(JSON.stringify(result));
  process.exit(0);
}

// Default fallback
const result = {
  type: "result", subtype: "success",
  result: "Default output.",
  is_error: false,
};
process.stdout.write(JSON.stringify(result));
process.exit(0);
`;

fs.writeFileSync(mockClaudePath, mockClaudeScript, { mode: 0o755 });

// ── Task definitions ──────────────────────────────────────────────────────────

const SCOPE = { repoPath: mockRepoDir, branch: "agent/report-schema-repair-test" };

// 1. Missing tests+commit → auto-repaired → completed
const TASK_REPAIR_BOTH = {
  taskId: "rsr-repair-both-001",
  mode: "implement",
  scope: SCOPE,
  instructions: "taskId: rsr-repair-both-001. Perform audit foundation hardening.",
  reportRetryOnViolation: false,
  reportSchemaRetryOnViolation: false, // disable retry so only auto-repair path is tested
};

// 2. Missing changelog → NOT repairable → failed
const TASK_MISSING_CHANGELOG = {
  taskId: "rsr-missing-changelog-001",
  mode: "implement",
  scope: SCOPE,
  instructions: "taskId: rsr-missing-changelog-001. Perform audit of auth module.",
  reportRetryOnViolation: false,
  reportSchemaRetryOnViolation: false,
};

// 3. Missing evidence → NOT repairable → failed
const TASK_MISSING_EVIDENCE = {
  taskId: "rsr-missing-evidence-001",
  mode: "implement",
  scope: SCOPE,
  instructions: "taskId: rsr-missing-evidence-001. Perform audit of payments module.",
  reportRetryOnViolation: false,
  reportSchemaRetryOnViolation: false,
};

// 4. Partial repair (commit found, no tests) → NOT repaired → failed
const TASK_PARTIAL_REPAIR = {
  taskId: "rsr-partial-repair-001",
  mode: "implement",
  scope: SCOPE,
  instructions: "taskId: rsr-partial-repair-001. Perform audit hardening of utils.",
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
  TASK_REPAIR_BOTH,        // 1: missing tests+commit → auto-repaired → completed
  TASK_MISSING_CHANGELOG,  // 2: missing changelog → fails (not repairable)
  TASK_MISSING_EVIDENCE,   // 3: missing evidence → fails (not repairable)
  TASK_PARTIAL_REPAIR,     // 4: partial repair → fails (incomplete)
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
        report_schema_repaired: 32,
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
      if (result.meta?.reportSchemaRepaired) {
        console.log(color(32, `[orch]    repaired: ${result.meta.reportSchemaRepaired.join(", ")}`));
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
  console.log(color(36, "TEST RESULTS — Report Schema Auto-Repair"));
  console.log(color(36, "=".repeat(60)));

  const byTask = {};
  for (const r of receivedResults) {
    byTask[r.taskId] = r;
  }

  const checks = [];

  // 1. Missing tests+commit → auto-repaired → completed
  const r1 = byTask["rsr-repair-both-001"];
  checks.push({
    name: "missing tests+commit → auto-repaired → completed",
    pass: r1 && r1.status === "completed",
    detail: r1 ? `status=${r1.status}` : "no result",
  });
  checks.push({
    name: "repaired result has reportSchemaRepaired meta",
    pass: r1 && Array.isArray(r1.meta?.reportSchemaRepaired),
    detail: r1 ? `repaired=${JSON.stringify(r1.meta?.reportSchemaRepaired)}` : "no result",
  });
  checks.push({
    name: "reportSchemaRepaired contains tests and commit",
    pass: r1 && r1.meta?.reportSchemaRepaired?.includes("tests") && r1.meta?.reportSchemaRepaired?.includes("commit"),
    detail: r1 ? `keys=${JSON.stringify(r1.meta?.reportSchemaRepaired)}` : "no result",
  });

  // Verify report_schema_repaired event emitted
  const repairEvent = receivedEvents.find(
    (e) => e.status === "report_schema_repaired" && e.taskId === "rsr-repair-both-001"
  );
  checks.push({
    name: "report_schema_repaired event emitted",
    pass: !!repairEvent,
    detail: repairEvent ? `keys=${JSON.stringify(repairEvent.meta?.repairedKeys)}` : "not found",
  });
  checks.push({
    name: "report_schema_repaired event has correct repairedKeys",
    pass: repairEvent && repairEvent.meta?.repairedKeys?.includes("tests") && repairEvent.meta?.repairedKeys?.includes("commit"),
    detail: repairEvent ? `keys=${JSON.stringify(repairEvent.meta?.repairedKeys)}` : "not found",
  });

  // 2. Missing changelog → NOT repairable → failed
  const r2 = byTask["rsr-missing-changelog-001"];
  checks.push({
    name: "missing changelog → still fails (not repairable)",
    pass: r2 && r2.status === "failed",
    detail: r2 ? `status=${r2.status}` : "no result",
  });
  checks.push({
    name: "missing changelog → failureReason = report_contract_violation",
    pass: r2 && r2.meta?.failureReason === "report_contract_violation",
    detail: r2 ? `failureReason=${r2.meta?.failureReason}` : "no result",
  });

  // 3. Missing evidence → NOT repairable → failed
  const r3 = byTask["rsr-missing-evidence-001"];
  checks.push({
    name: "missing evidence → still fails (not repairable)",
    pass: r3 && r3.status === "failed",
    detail: r3 ? `status=${r3.status}` : "no result",
  });

  // No repair event for non-repairable tasks
  const noRepairEvent2 = receivedEvents.find(
    (e) => e.status === "report_schema_repaired" && e.taskId === "rsr-missing-changelog-001"
  );
  const noRepairEvent3 = receivedEvents.find(
    (e) => e.status === "report_schema_repaired" && e.taskId === "rsr-missing-evidence-001"
  );
  checks.push({
    name: "no repair event for non-repairable tasks",
    pass: !noRepairEvent2 && !noRepairEvent3,
    detail: `changelog=${!!noRepairEvent2}, evidence=${!!noRepairEvent3}`,
  });

  // 4. Partial repair (commit found, no test output) → NOT repaired → failed
  const r4 = byTask["rsr-partial-repair-001"];
  checks.push({
    name: "partial repair (commit only, no tests) → still fails",
    pass: r4 && r4.status === "failed",
    detail: r4 ? `status=${r4.status}` : "no result",
  });
  checks.push({
    name: "partial repair → no reportSchemaRepaired meta",
    pass: r4 && !r4.meta?.reportSchemaRepaired,
    detail: r4 ? `repaired=${JSON.stringify(r4.meta?.reportSchemaRepaired)}` : "no result",
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
    WORKER_ID: "test-report-schema-repair",
    CLAUDE_CMD: mockClaudePath,
    ALLOWED_REPOS: mockRepoDir,
    POLL_INTERVAL_MS: "500",
    CLAUDE_TIMEOUT_MS: "15000",
    REPORT_CONTRACT_ENABLED: "true",
    REPORT_RETRY_ENABLED: "false",
    REPORT_MIN_LENGTH: "50",
    REPORT_SCHEMA_STRICT: "true",
    REPORT_SCHEMA_RETRY_ENABLED: "false", // disable retry to isolate auto-repair
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
