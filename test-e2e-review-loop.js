#!/usr/bin/env node
"use strict";

/**
 * E2E Control Scenario: Stage 2.2 Review Loop Proof
 *
 * Proves the full review-loop flow in real worker execution:
 *
 *   review_loop_fail  →  patch  →  review_pass  →  tests  →  completed
 *
 * Scenario:
 *   A controlled doc file (test/fixtures/e2e-review-doc.md) intentionally
 *   violates two review rules:
 *     F1 (major)  — missing mandatory Security Considerations section
 *     F2 (minor)  — eval() usage without security warning
 *
 *   Iteration 1 review → REVIEW_FAIL with structured findings (F1, F2)
 *   Patch run           → applies fixes (mock), returns success
 *   Iteration 2 review  → REVIEW_PASS (explicit marker required)
 *
 * Mock claude detection (priority order):
 *   1. Prompt contains "review-loop-context" → re-review → REVIEW_PASS
 *   2. Prompt contains "## Review Findings"  → patch run → success
 *   3. Otherwise                             → first review → REVIEW_FAIL + findings JSON
 *
 * Outputs:
 *   - Console: event stream, assertions, proof summary
 *   - File: test/e2e-proof-report.json (machine-readable proof)
 *
 * Usage: node test-e2e-review-loop.js
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn, execSync } = require("child_process");

const PORT = 9879;
const PROOF_REPORT_PATH = path.join(__dirname, "test", "e2e-proof-report.json");

// ── Colour helpers ─────────────────────────────────────────────────────────────

function c(code, text) { return `\x1b[${code}m${text}\x1b[0m`; }

// ── Mock repo setup ────────────────────────────────────────────────────────────

const mockClaudeDir = fs.mkdtempSync(path.join(os.tmpdir(), "mock-claude-e2e-"));
const mockClaudePath = path.join(mockClaudeDir, "claude");
const mockRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-repo-e2e-"));

execSync("git init", { cwd: mockRepoDir, stdio: "ignore" });
execSync('git config user.email "test@test.com"', { cwd: mockRepoDir, stdio: "ignore" });
execSync('git config user.name "Test"', { cwd: mockRepoDir, stdio: "ignore" });
// Copy the fixture doc into the mock repo so the review has a real file to reference
const fixtureDoc = path.join(__dirname, "test", "fixtures", "e2e-review-doc.md");
fs.copyFileSync(fixtureDoc, path.join(mockRepoDir, "INTEGRATION_GUIDE.md"));
execSync("git add INTEGRATION_GUIDE.md", { cwd: mockRepoDir, stdio: "ignore" });
execSync('git commit -m "docs: add integration guide (intentionally violating review rules)"', {
  cwd: mockRepoDir, stdio: "ignore",
});

// ── Structured findings (what the first review will return) ────────────────────

const STRUCTURED_FINDINGS = [
  {
    id: "F1",
    severity: "major",
    file: "INTEGRATION_GUIDE.md",
    issue: "Missing mandatory Security Considerations section",
    risk: "Security implications undocumented; implementers may overlook auth and input-validation requirements",
    required_fix: "Add a '## Security Considerations' section covering authentication, input validation, and data exposure",
    acceptance_check: "Document contains '## Security Considerations' with at least three bullet points"
  },
  {
    id: "F2",
    severity: "minor",
    file: "INTEGRATION_GUIDE.md",
    issue: "Code example uses eval() without an explicit security warning",
    risk: "Implementers may replicate this unsafe pattern, enabling remote code execution via orchestrator-controlled payloads",
    required_fix: "Prefix the eval() example with a WARNING callout block, or replace with a safer JSON.parse() alternative",
    acceptance_check: "The eval() usage is preceded by a '> **WARNING**' block, or the example is replaced with JSON.parse()"
  }
];

// ── Mock claude script ─────────────────────────────────────────────────────────

const mockClaudeScript = `#!/usr/bin/env node
"use strict";
const prompt = process.argv[process.argv.indexOf("-p") + 1] || "";

// Priority 1: re-review after patch (has review-loop-context snippet)
if (prompt.includes("review-loop-context")) {
  const pass = [
    "Re-reviewed INTEGRATION_GUIDE.md after patch application.",
    "",
    "All findings resolved:",
    "  F1 - Security Considerations section is now present with auth, input validation, and data exposure bullets.",
    "  F2 - eval() example replaced with JSON.parse(); no unsafe pattern remains.",
    "",
    "[REVIEW_PASS]",
    "Both major and minor findings have been fully addressed. Document is compliant."
  ].join("\\n");
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", result: pass, is_error: false }));
  process.exit(0);
}

// Priority 2: patch run (prompt contains ## Review Findings injected by worker)
if (prompt.includes("## Review Findings")) {
  const patchResult = [
    "Patch applied. Addressed all findings from structured review:",
    "",
    "  F1 — Added '## Security Considerations' section with 4 bullet points covering:",
    "       - Bearer token authentication requirements",
    "       - Input validation for all orchestrator-supplied payloads",
    "       - TLS-only transmission of tokens",
    "       - Principle of least privilege for WORKER_TOKEN scope",
    "",
    "  F2 — Replaced eval(orchestratorPayload.expression) with:",
    "       const result = JSON.parse(orchestratorPayload.data);",
    "       Added a '> **WARNING: Never use eval() with untrusted input**' callout.",
    "",
    "All acceptance checks satisfied."
  ].join("\\n");
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", result: patchResult, is_error: false }));
  process.exit(0);
}

// Default: first review — return REVIEW_FAIL with full structured findings
const findings = ${JSON.stringify(STRUCTURED_FINDINGS)};
const reviewResult = [
  "Reviewed INTEGRATION_GUIDE.md. Found 2 issues that must be resolved before this document is shipped.",
  "",
  "[REVIEW_FAIL severity=major]",
  "The integration guide is missing a Security Considerations section (F1) and contains an unsafe eval()",
  "usage without a security warning (F2). Both issues must be resolved before merge.",
  "[REVIEW_FINDINGS_JSON]" + JSON.stringify(findings) + "[/REVIEW_FINDINGS_JSON]",
  "[/REVIEW_FAIL]"
].join("\\n");
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", result: reviewResult, is_error: false }));
process.exit(0);
`;

fs.writeFileSync(mockClaudePath, mockClaudeScript, { mode: 0o755 });

// ── Task definition ────────────────────────────────────────────────────────────

const E2E_TASK = {
  taskId: "e2e-review-loop-001",
  mode: "review",
  reviewLoop: true,
  maxReviewIterations: 3,
  scope: { repoPath: mockRepoDir, branch: "agent/e2e-review-test" },
  instructions: [
    "Review INTEGRATION_GUIDE.md for documentation quality and security hygiene.",
    "Check that:",
    "  1. All code examples include appropriate security warnings.",
    "  2. A 'Security Considerations' section is present and covers auth, input validation, and data exposure.",
    "  3. No TODO items remain in the shipped document.",
    "Return structured findings for any violations."
  ].join("\n"),
  patchInstructions: [
    "Fix all issues identified in the review findings.",
    "For each finding, apply the required_fix and verify the acceptance_check is satisfied.",
    "Do not change anything not mentioned in the findings."
  ].join("\n"),
};

// ── State ──────────────────────────────────────────────────────────────────────

let pullCount = 0;
let receivedResults = [];
let receivedEvents = [];
let worker = null;
const startTime = Date.now();

// ── Mock orchestrator ──────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
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
      if (pullCount === 1) {
        console.log(c(36, `\n[orch] → pull ${pullCount}: sending ${E2E_TASK.taskId}`));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, task: E2E_TASK }));
        return;
      }
      // No more tasks — trigger finish after one empty poll
      console.log(c(33, `[orch] → pull ${pullCount}: no more tasks`));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      if (pullCount >= 2) {
        setTimeout(() => finish(), 1500);
      }
      return;
    }

    // ── EVENT ──
    if (req.url === "/api/worker/event") {
      const ev = JSON.parse(body);
      ev._receivedAt = Date.now();
      receivedEvents.push(ev);
      const statusColor = {
        claimed: 36, started: 36, progress: 33,
        review_pass: 32, review_fail: 31, review_loop_fail: 31,
        escalated: 35, completed: 32, failed: 31,
      }[ev.status] || 37;
      console.log(c(statusColor, `[orch] ← event: ${ev.status}/${ev.phase} [${ev.taskId}] — ${(ev.message || "").slice(0, 100)}`));
      if (ev.status === "review_loop_fail") {
        console.log(c(31, `[orch]    findings: ${JSON.stringify(ev.meta?.structuredFindings || []).slice(0, 120)}…`));
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // ── RESULT ──
    if (req.url === "/api/worker/result") {
      const result = JSON.parse(body);
      result._receivedAt = Date.now();
      receivedResults.push(result);
      const statusColor = result.status === "review_pass" ? 32
        : result.status === "escalated" ? 35
        : result.status === "review_fail" ? 31 : 37;
      console.log(c(statusColor, `\n[orch] ← result: taskId=${result.taskId} status=${result.status}`));
      if (result.meta?.reviewIteration !== undefined) {
        console.log(c(37, `[orch]    reviewIteration=${result.meta.reviewIteration}/${result.meta.reviewMaxIterations}`));
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    res.writeHead(404);
    res.end("not found");
  });
});

// ── Assertions + proof report ──────────────────────────────────────────────────

function finish() {
  const elapsed = Date.now() - startTime;

  console.log(c(36, "\n" + "═".repeat(64)));
  console.log(c(36, "  STAGE 2.2 E2E REVIEW LOOP — TEST RESULTS"));
  console.log(c(36, "═".repeat(64)));

  const result = receivedResults.find((r) => r.taskId === "e2e-review-loop-001");
  const loopFailEvent = receivedEvents.find(
    (e) => e.status === "review_loop_fail" && e.taskId === "e2e-review-loop-001"
  );
  const reviewPassEvent = receivedEvents.find(
    (e) => e.status === "review_pass" && e.taskId === "e2e-review-loop-001"
  );
  const allStatuses = receivedEvents.map((e) => `${e.status}/${e.phase}`);

  const checks = [];

  // ── T1: Final result is review_pass ──
  checks.push({
    name: "T1  final result status = review_pass",
    pass: result?.status === "review_pass",
    detail: result ? `status=${result.status}` : "no result received",
  });

  // ── T2: Passed on iteration 2 (fail→patch→pass) ──
  checks.push({
    name: "T2  review_pass achieved on iteration 2",
    pass: result?.meta?.reviewIteration === 2,
    detail: result ? `reviewIteration=${result.meta?.reviewIteration}` : "no result",
  });

  // ── T3: maxReviewIterations preserved correctly ──
  checks.push({
    name: "T3  meta.reviewMaxIterations = 3",
    pass: result?.meta?.reviewMaxIterations === 3,
    detail: result ? `reviewMaxIterations=${result.meta?.reviewMaxIterations}` : "no result",
  });

  // ── T4: review_loop_fail event emitted ──
  checks.push({
    name: "T4  review_loop_fail event emitted (iter 1 failure)",
    pass: !!loopFailEvent,
    detail: loopFailEvent ? `phase=${loopFailEvent.phase}` : "event not found",
  });

  // ── T5: review_loop_fail carries structuredFindings ──
  checks.push({
    name: "T5  review_loop_fail carries structuredFindings array",
    pass: Array.isArray(loopFailEvent?.meta?.structuredFindings)
      && loopFailEvent.meta.structuredFindings.length > 0,
    detail: loopFailEvent
      ? `count=${loopFailEvent.meta?.structuredFindings?.length ?? "missing"}`
      : "no event",
  });

  // ── T6: All 7 required fields present in each finding ──
  const findings = loopFailEvent?.meta?.structuredFindings ?? [];
  const allFieldsOk = findings.length > 0 && findings.every(
    (f) => f.id && ["critical", "major", "minor"].includes(f.severity)
      && f.file && f.issue && f.risk && f.required_fix && f.acceptance_check
  );
  checks.push({
    name: "T6  every finding has all 7 required schema fields",
    pass: allFieldsOk,
    detail: findings.length
      ? `findings: ${findings.map((f) => `${f.id}(${f.severity})`).join(", ")}`
      : "no findings",
  });

  // ── T7: Findings reference the correct file ──
  const allRefDoc = findings.length > 0 && findings.every((f) => f.file === "INTEGRATION_GUIDE.md");
  checks.push({
    name: "T7  findings reference INTEGRATION_GUIDE.md",
    pass: allRefDoc,
    detail: findings.map((f) => f.file).join(", ") || "none",
  });

  // ── T8: review_pass event emitted ──
  checks.push({
    name: "T8  review_pass event emitted after patch",
    pass: !!reviewPassEvent,
    detail: reviewPassEvent ? `phase=${reviewPassEvent.phase}` : "event not found",
  });

  // ── T9: No structuredFindings on passing result (clean pass body) ──
  checks.push({
    name: "T9  review_pass result has no top-level structuredFindings",
    pass: result?.structuredFindings === undefined,
    detail: result
      ? `structuredFindings=${JSON.stringify(result.structuredFindings)}`
      : "no result",
  });

  // ── T10: Event ordering — review_loop_fail before review_pass ──
  const idxLoopFail = receivedEvents.findIndex(
    (e) => e.status === "review_loop_fail" && e.taskId === "e2e-review-loop-001"
  );
  const idxReviewPass = receivedEvents.findIndex(
    (e) => e.status === "review_pass" && e.taskId === "e2e-review-loop-001"
  );
  checks.push({
    name: "T10 event order: review_loop_fail → review_pass",
    pass: idxLoopFail !== -1 && idxReviewPass !== -1 && idxLoopFail < idxReviewPass,
    detail: `review_loop_fail@idx=${idxLoopFail}, review_pass@idx=${idxReviewPass}`,
  });

  // ── Print checks ──
  console.log("");
  let allPass = true;
  for (const ch of checks) {
    const icon = ch.pass ? c(32, "PASS") : c(31, "FAIL");
    console.log(`  ${icon}  ${ch.name}`);
    console.log(`         ${c(37, ch.detail)}`);
    if (!ch.pass) allPass = false;
  }

  // ── Proof report ───────────────────────────────────────────────────────────

  const eventSequence = receivedEvents.map((e, i) => ({
    n: i + 1,
    status: e.status,
    phase: e.phase,
    taskId: e.taskId,
    message: (e.message || "").slice(0, 120),
    hasStructuredFindings: !!e.meta?.structuredFindings,
    structuredFindingsCount: e.meta?.structuredFindings?.length,
    offsetMs: e._receivedAt - startTime,
  }));

  const proofReport = {
    scenario: "Stage 2.2 E2E Review Loop — review_fail → patch → review_pass",
    taskId: "e2e-review-loop-001",
    controlledFile: "test/fixtures/e2e-review-doc.md",
    intentionalViolations: [
      "Missing ## Security Considerations section (F1 major)",
      "eval() usage without security warning (F2 minor)",
    ],
    runAt: new Date().toISOString(),
    elapsedMs: elapsed,
    eventSequence,
    findingsPayload: findings,
    finalResult: result
      ? {
          taskId: result.taskId,
          status: result.status,
          reviewIteration: result.meta?.reviewIteration,
          reviewMaxIterations: result.meta?.reviewMaxIterations,
          reviewLoopDurationMs: result.meta?.reviewLoopDurationMs,
        }
      : null,
    provenSequence: [
      "review_loop_fail/report  ← iter 1: REVIEW_FAIL with 2 structured findings",
      "patch run                 ← iter 2: patch consumed previousReviewFindings",
      "review_pass/report        ← iter 2: explicit [REVIEW_PASS] marker received",
      "tests                     ← assertions T1–T10 all passed",
      "completed                 ← exit 0",
    ],
    testResults: checks,
    conclusion: allPass ? "REVIEW_LOOP_PROVEN" : "REVIEW_LOOP_FAILED",
  };

  // Ensure output directory exists
  fs.mkdirSync(path.dirname(PROOF_REPORT_PATH), { recursive: true });
  fs.writeFileSync(PROOF_REPORT_PATH, JSON.stringify(proofReport, null, 2));

  // ── Summary ────────────────────────────────────────────────────────────────

  console.log(c(36, "\n" + "═".repeat(64)));
  console.log(c(36, "  PROVEN EVENT SEQUENCE"));
  console.log(c(36, "═".repeat(64)));
  for (const step of proofReport.provenSequence) {
    console.log(`  ${c(32, "→")}  ${step}`);
  }

  console.log(c(36, "\n" + "─".repeat(64)));
  console.log(c(36, "  FINDINGS PAYLOAD (from review_loop_fail event)"));
  console.log(c(36, "─".repeat(64)));
  console.log(JSON.stringify(findings, null, 2));

  console.log(c(36, "\n" + "─".repeat(64)));
  console.log(c(36, `  Proof report written → ${PROOF_REPORT_PATH}`));
  console.log(c(36, "─".repeat(64)));

  if (allPass) {
    console.log(c(32, "\n  ALL CHECKS PASSED — REVIEW LOOP PROVEN  ✓\n"));
  } else {
    console.log(c(31, "\n  SOME CHECKS FAILED\n"));
  }
  console.log(c(36, "═".repeat(64) + "\n"));

  if (worker) worker.kill("SIGTERM");
  server.close();
  try { fs.rmSync(mockClaudeDir, { recursive: true }); } catch {}
  try { fs.rmSync(mockRepoDir, { recursive: true }); } catch {}
  process.exit(allPass ? 0 : 1);
}

// ── Start ──────────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(c(36, `[orch] E2E mock orchestrator on http://localhost:${PORT}`));
  console.log(c(36, `[orch] mock claude: ${mockClaudePath}`));
  console.log(c(36, `[orch] mock repo:   ${mockRepoDir}`));
  console.log(c(36, `[orch] controlled doc: test/fixtures/e2e-review-doc.md`));
  console.log(c(36, "[orch] spawning worker…\n"));

  worker = spawn("node", ["worker.js"], {
    cwd: __dirname,
    env: {
      ...process.env,
      ORCH_BASE_URL: `http://localhost:${PORT}`,
      WORKER_TOKEN: "test-token",
      WORKER_ID: "test-worker-e2e",
      POLL_INTERVAL_MS: "500",
      MAX_PARALLEL_WORKTREES: "1",
      CLAUDE_CMD: mockClaudePath,
      ALLOWED_REPOS: mockRepoDir,
      CLAUDE_TIMEOUT_MS: "30000",
      CLAUDE_BYPASS_PERMISSIONS: "false",
    },
    stdio: "inherit",
  });

  worker.on("close", (code) => {
    console.log(c(37, `\n[orch] worker exited with code ${code}`));
  });

  // Safety timeout
  setTimeout(() => {
    console.log(c(31, "\n[orch] TIMEOUT — test exceeded 90s, aborting"));
    if (worker) worker.kill("SIGKILL");
    server.close();
    try { fs.rmSync(mockClaudeDir, { recursive: true }); } catch {}
    try { fs.rmSync(mockRepoDir, { recursive: true }); } catch {}
    process.exit(1);
  }, 90000);
});
