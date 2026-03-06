#!/usr/bin/env node
"use strict";

/**
 * Regression test: Report Schema Canonical Aliases
 *
 * Proves:
 *   1. Rich report with alternate headings (synonyms) passes strict schema
 *   2. Truly missing tests/commit sections still fail
 *   3. Previous strict passing reports (exact headings) still pass
 *   4. Diagnostics include recognized aliases and missing canonical keys
 *
 * Usage: node test-report-schema-aliases.js
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn, execSync } = require("child_process");

// ── Mock repo + mock claude ───────────────────────────────────────────────────

const mockClaudeDir = fs.mkdtempSync(path.join(os.tmpdir(), "mock-claude-rsa-"));
const mockClaudePath = path.join(mockClaudeDir, "claude");
const mockRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-repo-rsa-"));

execSync("git init", { cwd: mockRepoDir, stdio: "ignore" });
execSync("git commit --allow-empty -m init", { cwd: mockRepoDir, stdio: "ignore" });

const mockClaudeScript = `#!/usr/bin/env node
"use strict";
const prompt = process.argv[process.argv.indexOf("-p") + 1] || "";

if (prompt.includes("rsa-alt-headings")) {
  // Report using alternate/synonym headings — should PASS with canonical aliases
  const result = {
    type: "result", subtype: "success",
    result: [
      "## What Changed",
      "| File | Modification |",
      "|------|-------------|",
      "| src/auth.js | Refactored token validation |",
      "| src/middleware.js | Updated error handling |",
      "",
      "## Verification Steps",
      "Actions taken:",
      "  npm run lint",
      "  npm run build",
      "  node scripts/validate.js",
      "",
      "## Verification Results",
      "- 14 tests pass, 0 fail",
      "- Integration suite green",
      "",
      "## Pushed Commit",
      "commit: f1a2b3c",
    ].join("\\n"),
    is_error: false,
  };
  process.stdout.write(JSON.stringify(result));
  process.exit(0);
}

if (prompt.includes("rsa-alt-headings-2")) {
  // Another set of alternate headings
  const result = {
    type: "result", subtype: "success",
    result: [
      "## Files Modified",
      "- worker.js: updated canonical parser",
      "- test.js: new test cases",
      "",
      "## Steps Taken",
      "Commands executed:",
      "  node test.js",
      "  git diff --stat",
      "",
      "## Testing Summary",
      "All 8 tests passing, 0 failures",
      "",
      "## Git Commit",
      "sha: abc1234def",
    ].join("\\n"),
    is_error: false,
  };
  process.stdout.write(JSON.stringify(result));
  process.exit(0);
}

if (prompt.includes("rsa-missing-tests-commit")) {
  // Has changelog + evidence but NO tests or commit → should FAIL
  const result = {
    type: "result", subtype: "success",
    result: [
      "## Changelog",
      "- src/api.js: added rate limiting",
      "",
      "## Evidence",
      "Commands run:",
      "  curl -X POST /api/test",
      "  docker compose up",
      "",
      "The implementation is complete and working correctly.",
    ].join("\\n"),
    is_error: false,
  };
  process.stdout.write(JSON.stringify(result));
  process.exit(0);
}

if (prompt.includes("rsa-exact-headings")) {
  // Original exact headings — should still PASS (regression guard)
  const result = {
    type: "result", subtype: "success",
    result: [
      "## Changelog",
      "- worker.js: added schema validation",
      "",
      "## Evidence",
      "Commands run:",
      "  node test.js",
      "",
      "## Test Summary",
      "- 6 tests pass, 0 fail",
      "",
      "## Commit",
      "commit hash: abc1234",
    ].join("\\n"),
    is_error: false,
  };
  process.stdout.write(JSON.stringify(result));
  process.exit(0);
}

if (prompt.includes("rsa-bare-hash")) {
  // Report with bare commit hash (no "commit" heading) — should PASS
  const result = {
    type: "result", subtype: "success",
    result: [
      "## Code Changes",
      "- utils.js: refactored helpers",
      "",
      "## Proof",
      "Ran all verification scripts.",
      "",
      "## Test Results",
      "12 tests pass, 0 fail",
      "",
      "Deployed at f1a2b3c4d5e6f7a",
    ].join("\\n"),
    is_error: false,
  };
  process.stdout.write(JSON.stringify(result));
  process.exit(0);
}

// Default
const result = {
  type: "result", subtype: "success",
  result: "Generic output with no structured sections.",
  is_error: false,
};
process.stdout.write(JSON.stringify(result));
process.exit(0);
`;

fs.writeFileSync(mockClaudePath, mockClaudeScript, { mode: 0o755 });

// ── Task definitions ──────────────────────────────────────────────────────────

const SCOPE = { repoPath: mockRepoDir, branch: "agent/report-schema-alias-test" };

// 1. Alternate headings (synonyms) → should PASS strict
const TASK_ALT_HEADINGS = {
  taskId: "rsa-alt-headings-001",
  mode: "implement",
  scope: SCOPE,
  instructions: "taskId: rsa-alt-headings-001. Perform audit of authentication module.",
  reportRetryOnViolation: false,
  reportSchemaRetryOnViolation: false,
};

// 2. Another set of alternate headings → should PASS strict
const TASK_ALT_HEADINGS_2 = {
  taskId: "rsa-alt-headings-2-001",
  mode: "implement",
  scope: SCOPE,
  instructions: "taskId: rsa-alt-headings-2-001. Perform audit hardening.",
  reportRetryOnViolation: false,
  reportSchemaRetryOnViolation: false,
};

// 3. Missing tests + commit → should FAIL (truly missing semantic content)
const TASK_MISSING = {
  taskId: "rsa-missing-tests-commit-001",
  mode: "implement",
  scope: SCOPE,
  instructions: "taskId: rsa-missing-tests-commit-001. Perform audit of API module.",
  reportRetryOnViolation: false,
  reportSchemaRetryOnViolation: false,
};

// 4. Exact original headings → should still PASS (regression guard)
const TASK_EXACT = {
  taskId: "rsa-exact-headings-001",
  mode: "implement",
  scope: SCOPE,
  instructions: "taskId: rsa-exact-headings-001. Perform audit review.",
  reportRetryOnViolation: false,
  reportSchemaRetryOnViolation: false,
};

// 5. Bare commit hash (no heading) → should PASS with canonical alias
const TASK_BARE_HASH = {
  taskId: "rsa-bare-hash-001",
  mode: "implement",
  scope: SCOPE,
  instructions: "taskId: rsa-bare-hash-001. Perform audit of utils.",
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
  TASK_ALT_HEADINGS,    // 1: synonym headings → pass
  TASK_ALT_HEADINGS_2,  // 2: another synonym set → pass
  TASK_MISSING,         // 3: truly missing tests+commit → fail
  TASK_EXACT,           // 4: exact headings (regression) → pass
  TASK_BARE_HASH,       // 5: bare commit hash → pass
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
        console.log(color(36, `\n[orch] -> pull ${pullCount}: sending ${task.taskId}`));
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
        completed: 32, failed: 31,
      }[ev.status] || 37;
      console.log(color(statusColor, `[orch] <- event: ${ev.status}/${ev.phase} — ${(ev.message || "").slice(0, 140)}`));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.url === "/api/worker/result") {
      const result = JSON.parse(body);
      receivedResults.push(result);
      const statusColor = result.status === "completed" ? 32 : result.status === "failed" ? 31 : 37;
      console.log(color(statusColor, `\n[orch] <- result: taskId=${result.taskId} status=${result.status}`));
      if (result.meta?.failureReason) {
        console.log(color(31, `[orch]    failureReason: ${result.meta.failureReason}`));
      }
      if (result.meta?.reportSchemaViolation) {
        const v = result.meta.reportSchemaViolation;
        console.log(color(31, `[orch]    schema: ${v.schema}, missing: ${v.missing.map(m => m.key).join(", ")}`));
        if (v.recognized?.length) {
          console.log(color(33, `[orch]    recognized: ${v.recognized.map(r => `${r.key}="${r.matchedAlias}"`).join(", ")}`));
        }
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
  console.log(color(36, "TEST RESULTS — Report Schema Canonical Aliases"));
  console.log(color(36, "=".repeat(60)));

  const byTask = {};
  for (const r of receivedResults) {
    byTask[r.taskId] = r;
  }

  const checks = [];

  // 1. Alternate headings → completed (synonym headings recognized)
  const r1 = byTask["rsa-alt-headings-001"];
  checks.push({
    name: "alternate headings (what changed, verification steps/results, pushed commit) → completed",
    pass: r1 && r1.status === "completed",
    detail: r1 ? `status=${r1.status}` : "no result",
  });
  checks.push({
    name: "alternate headings → no schema violation",
    pass: r1 && !r1.meta?.reportSchemaViolation,
    detail: r1 ? `violation=${JSON.stringify(r1.meta?.reportSchemaViolation || null)}` : "no result",
  });

  // 2. Another alternate set → completed
  const r2 = byTask["rsa-alt-headings-2-001"];
  checks.push({
    name: "alternate headings set 2 (files modified, steps taken, testing summary, git commit) → completed",
    pass: r2 && r2.status === "completed",
    detail: r2 ? `status=${r2.status}` : "no result",
  });

  // 3. Truly missing tests+commit → failed
  const r3 = byTask["rsa-missing-tests-commit-001"];
  checks.push({
    name: "missing tests+commit → failed",
    pass: r3 && r3.status === "failed",
    detail: r3 ? `status=${r3.status}` : "no result",
  });
  checks.push({
    name: "missing tests+commit → failureReason = report_contract_violation",
    pass: r3 && r3.meta?.failureReason === "report_contract_violation",
    detail: r3 ? `failureReason=${r3.meta?.failureReason}` : "no result",
  });
  checks.push({
    name: "missing tests+commit → schema violation lists tests and commit as missing",
    pass: r3 && r3.meta?.reportSchemaViolation?.missing?.some(m => m.key === "tests")
        && r3.meta?.reportSchemaViolation?.missing?.some(m => m.key === "commit"),
    detail: r3 ? `missing=${JSON.stringify(r3.meta?.reportSchemaViolation?.missing?.map(m => m.key))}` : "no result",
  });
  checks.push({
    name: "missing tests+commit → diagnostics include recognized changelog+evidence",
    pass: r3 && r3.meta?.reportSchemaViolation?.recognized?.some(r => r.key === "changelog")
        && r3.meta?.reportSchemaViolation?.recognized?.some(r => r.key === "evidence"),
    detail: r3 ? `recognized=${JSON.stringify(r3.meta?.reportSchemaViolation?.recognized?.map(r => r.key))}` : "no result",
  });

  // 4. Exact original headings → still pass (regression guard)
  const r4 = byTask["rsa-exact-headings-001"];
  checks.push({
    name: "exact original headings (regression guard) → completed",
    pass: r4 && r4.status === "completed",
    detail: r4 ? `status=${r4.status}` : "no result",
  });

  // 5. Bare commit hash → pass
  const r5 = byTask["rsa-bare-hash-001"];
  checks.push({
    name: "bare commit hash (no heading) → completed",
    pass: r5 && r5.status === "completed",
    detail: r5 ? `status=${r5.status}` : "no result",
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
    WORKER_ID: "test-report-schema-aliases",
    CLAUDE_CMD: mockClaudePath,
    ALLOWED_REPOS: mockRepoDir,
    POLL_INTERVAL_MS: "500",
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
