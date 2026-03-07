#!/usr/bin/env node
"use strict";

/**
 * Integration test: Phase 5A UI Review Gate.
 *
 * Covers:
 *   1. [gate] uiReview + uiReviewEnabled + ui_review passes → ui_review_pass
 *   2. [gate] uiReview + uiReviewEnabled + ui_review fails → ui_review_fail (blocks completion)
 *   3. [gate] uiReview + uiReviewEnabled + orchestratedLoop + review pass + ui pass → ui_review_pass
 *   4. [gate] uiReview + uiReviewEnabled + orchestratedLoop + review pass + ui fail → ui_review_fail
 *   5. [compat] uiReview not set → completed (no gate)
 *   6. [telemetry] ui_review_pass event emitted on success
 *   7. [telemetry] ui_review_fail event emitted on failure with artifacts
 *
 * Port: dynamic (server.listen(0))
 * Usage: node test-ui-review-gate.js
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn, execSync } = require("child_process");

const mockClaudeDir = fs.mkdtempSync(path.join(os.tmpdir(), "mock-claude-uirg-"));
const mockClaudePath = path.join(mockClaudeDir, "claude");
const mockRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-repo-uirg-"));
const mockUiReviewDir = fs.mkdtempSync(path.join(os.tmpdir(), "mock-uireview-"));

execSync("git init", { cwd: mockRepoDir, stdio: "ignore" });
execSync('git config user.email "test@test.com"', { cwd: mockRepoDir, stdio: "ignore" });
execSync('git config user.name "Test"', { cwd: mockRepoDir, stdio: "ignore" });
execSync("git commit --allow-empty -m init", { cwd: mockRepoDir, stdio: "ignore" });

const mockClaudeScript = `#!/usr/bin/env node
"use strict";
const prompt = process.argv[process.argv.indexOf("-p") + 1] || "";
function out(result) {
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", result, is_error: false }));
  process.exit(0);
}
if (prompt.includes("UI-PASS-IMPL")) out("Implementation complete for UI-PASS-IMPL.");
if (prompt.includes("UI-FAIL-IMPL")) out("Implementation complete for UI-FAIL-IMPL.");
if (prompt.includes("UI-ORCH-PASS")) {
  if (prompt.includes("mode: review") || prompt.includes("[review]")) out("All good.\\n\\n[REVIEW_PASS]\\nCode looks clean.");
  out("Implementation complete for UI-ORCH-PASS.");
}
if (prompt.includes("UI-ORCH-FAIL")) {
  if (prompt.includes("mode: review") || prompt.includes("[review]")) out("All good.\\n\\n[REVIEW_PASS]\\nCode looks clean.");
  out("Implementation complete for UI-ORCH-FAIL.");
}
if (prompt.includes("NO-UI-FLAG")) out("Implementation complete for NO-UI-FLAG.");
out("Task completed successfully.");
`;
fs.writeFileSync(mockClaudePath, mockClaudeScript, { mode: 0o755 });

// Dispatcher: reads task ID from marker file and decides pass/fail
const markerFile = path.join(mockUiReviewDir, "current-task.txt");
const mockDispatcherPath = path.join(mockUiReviewDir, "ui-review-dispatch.sh");
fs.writeFileSync(mockDispatcherPath, `#!/usr/bin/env bash
TASK_ID=$(cat "${markerFile}" 2>/dev/null || echo "unknown")
case "$TASK_ID" in
  uirg-pass-001|uirg-orch-pass-001)
    echo "==> Running UI smoke tests..."
    echo "artifact: /tmp/screenshot-desktop.png"
    echo "artifact: /tmp/screenshot-mobile.png"
    echo "PASS: All UI smoke tests passed (6 tests, 3s)"
    exit 0
    ;;
  uirg-fail-001|uirg-orch-fail-001)
    echo "==> Running UI smoke tests..."
    echo "artifact: /tmp/screenshot-desktop-fail.png"
    echo "FAIL: UI smoke tests failed (2 of 6 failed, 4s)"
    exit 1
    ;;
  *)
    echo "PASS: default pass"
    exit 0
    ;;
esac
`, { mode: 0o755 });

const SCOPE = { repoPath: mockRepoDir, branch: "agent/ui-review-gate-test" };

const PULL_SEQUENCE = [
  { taskId: "uirg-pass-001", mode: "implement", uiReview: true, scope: SCOPE, instructions: "UI-PASS-IMPL: implement a feature." },
  { taskId: "uirg-fail-001", mode: "implement", uiReview: true, scope: SCOPE, instructions: "UI-FAIL-IMPL: implement a feature." },
  { taskId: "uirg-orch-pass-001", mode: "implement", orchestratedLoop: true, uiReview: true, maxReviewIterations: 3, scope: SCOPE, instructions: "UI-ORCH-PASS: implement and review." },
  { taskId: "uirg-orch-fail-001", mode: "implement", orchestratedLoop: true, uiReview: true, maxReviewIterations: 3, scope: SCOPE, instructions: "UI-ORCH-FAIL: implement and review." },
  { taskId: "uirg-no-flag-001", mode: "implement", scope: SCOPE, instructions: "NO-UI-FLAG: implement without ui review." },
];

let pullCount = 0;
let receivedResults = [];
let receivedEvents = [];
let worker = null;

function color(code, text) { return `\x1b[${code}m${text}\x1b[0m`; }

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (req.headers.authorization !== "Bearer test-token") {
      res.writeHead(401); res.end(JSON.stringify({ error: "unauthorized" })); return;
    }
    if (req.url === "/api/worker/pull") {
      pullCount++;
      if (pullCount <= PULL_SEQUENCE.length) {
        const task = PULL_SEQUENCE[pullCount - 1];
        fs.writeFileSync(markerFile, task.taskId);
        console.log(color(36, `\n[orch] → pull ${pullCount}: ${task.taskId} (uiReview=${!!task.uiReview})`));
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
      const sc = { ui_review_pass: 32, ui_review_fail: 31, claimed: 36, started: 36, progress: 33, review_pass: 32, review_fail: 31, completed: 32, failed: 31, context_reset: 34 }[ev.status] || 37;
      console.log(color(sc, `[orch] ← event: ${ev.status}/${ev.phase} [${ev.taskId}] — ${(ev.message || "").slice(0, 120)}`));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.url === "/api/worker/result") {
      const result = JSON.parse(body);
      receivedResults.push(result);
      const sc = result.status === "ui_review_pass" ? 32 : result.status === "ui_review_fail" ? 31 : result.status === "completed" ? 32 : 37;
      console.log(color(sc, `\n[orch] ← result: taskId=${result.taskId} status=${result.status} uiReviewPassed=${result.meta?.uiReviewPassed}`));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      if (receivedResults.length >= PULL_SEQUENCE.length) {
        process.nextTick(() => finish());
      }
      return;
    }
    res.writeHead(404); res.end("not found");
  });
});

let _finished = false;
function finish() {
  if (_finished) return;
  _finished = true;
  console.log(color(36, "\n" + "=".repeat(60)));
  console.log(color(36, "TEST RESULTS — UI Review Gate (Phase 5A)"));
  console.log(color(36, "=".repeat(60)));

  const byTask = {};
  for (const r of receivedResults) byTask[r.taskId] = r;

  const eventsByTask = {};
  for (const e of receivedEvents) {
    if (!eventsByTask[e.taskId]) eventsByTask[e.taskId] = [];
    eventsByTask[e.taskId].push(e);
  }

  const checks = [];

  // 1. implement + uiReview + ui passes → ui_review_pass
  const r1 = byTask["uirg-pass-001"];
  checks.push({ name: "[gate] implement + uiReview + UI passes → ui_review_pass", pass: r1 && r1.status === "ui_review_pass", detail: r1 ? `status=${r1.status}` : "no result" });
  checks.push({ name: "[gate] ui_review_pass has uiReviewPassed=true", pass: r1 && r1.meta?.uiReviewPassed === true, detail: r1 ? `uiReviewPassed=${r1.meta?.uiReviewPassed}` : "no result" });

  // 2. implement + uiReview + ui fails → ui_review_fail
  const r2 = byTask["uirg-fail-001"];
  checks.push({ name: "[gate] implement + uiReview + UI fails → ui_review_fail", pass: r2 && r2.status === "ui_review_fail", detail: r2 ? `status=${r2.status}` : "no result" });
  checks.push({ name: "[gate] ui_review_fail has uiReviewPassed=false", pass: r2 && r2.meta?.uiReviewPassed === false, detail: r2 ? `uiReviewPassed=${r2.meta?.uiReviewPassed}` : "no result" });

  // 3. orchestratedLoop + uiReview + ui passes → ui_review_pass
  const r3 = byTask["uirg-orch-pass-001"];
  checks.push({ name: "[gate] orch + uiReview + UI passes → ui_review_pass", pass: r3 && r3.status === "ui_review_pass", detail: r3 ? `status=${r3.status}` : "no result" });
  checks.push({ name: "[gate] orch + ui_review_pass has reviewVerdict=pass", pass: r3 && r3.meta?.reviewVerdict === "pass", detail: r3 ? `reviewVerdict=${r3.meta?.reviewVerdict}` : "no result" });

  // 4. orchestratedLoop + uiReview + ui fails → ui_review_fail
  const r4 = byTask["uirg-orch-fail-001"];
  checks.push({ name: "[gate] orch + uiReview + UI fails → ui_review_fail", pass: r4 && r4.status === "ui_review_fail", detail: r4 ? `status=${r4.status}` : "no result" });
  checks.push({ name: "[gate] orch + ui_review_fail blocks completion", pass: r4 && r4.status !== "completed" && r4.status !== "review_pass", detail: r4 ? `status=${r4.status}` : "no result" });

  // 5. no uiReview flag → completed
  const r5 = byTask["uirg-no-flag-001"];
  checks.push({ name: "[compat] no uiReview flag → completed", pass: r5 && r5.status === "completed", detail: r5 ? `status=${r5.status}` : "no result" });
  checks.push({ name: "[compat] no uiReview → uiReviewPassed not set", pass: r5 && r5.meta?.uiReviewPassed === undefined, detail: r5 ? `uiReviewPassed=${r5.meta?.uiReviewPassed}` : "no result" });

  // 6. ui_review_pass event emitted
  const passEvents = (eventsByTask["uirg-pass-001"] || []).filter(e => e.phase === "ui_review" && e.status === "ui_review_pass");
  checks.push({ name: "[telemetry] ui_review_pass event emitted", pass: passEvents.length > 0, detail: `events=${passEvents.length}` });

  // 7. ui_review_fail event with artifacts
  const failEvents = (eventsByTask["uirg-fail-001"] || []).filter(e => e.phase === "ui_review" && e.status === "ui_review_fail");
  checks.push({ name: "[telemetry] ui_review_fail event emitted", pass: failEvents.length > 0, detail: `events=${failEvents.length}` });
  checks.push({ name: "[telemetry] ui_review_fail has artifacts", pass: failEvents.length > 0 && failEvents[0].meta?.uiReviewArtifacts?.length > 0, detail: failEvents.length > 0 ? `artifacts=${failEvents[0].meta?.uiReviewArtifacts?.length}` : "no event" });

  let passed = 0, failed = 0;
  for (const c of checks) {
    const mark = c.pass ? color(32, "PASS") : color(31, "FAIL");
    console.log(`  ${mark}  ${c.name}`);
    if (!c.pass) console.log(color(31, `         → ${c.detail}`));
    c.pass ? passed++ : failed++;
  }

  console.log(color(36, "\n" + "-".repeat(60)));
  console.log(color(36, `Total: ${checks.length}  Passed: ${passed}  Failed: ${failed}`));
  console.log(color(36, "-".repeat(60)));

  if (worker) worker.kill("SIGTERM");
  server.close();
  try { fs.rmSync(mockClaudeDir, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(mockRepoDir, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(mockUiReviewDir, { recursive: true, force: true }); } catch {}
  process.exit(failed > 0 ? 1 : 0);
}

server.listen(0, () => {
  const PORT = server.address().port;
  console.log(color(36, `[orch] mock orchestrator on :${PORT}`));

  worker = spawn("node", [path.join(__dirname, "worker.js")], {
    env: {
      ...process.env,
      REPORT_SCHEMA_STRICT: "false",
      REPORT_CONTRACT_ENABLED: "false",
      ORCH_BASE_URL: `http://127.0.0.1:${PORT}`,
      WORKER_TOKEN: "test-token",
      WORKER_ID: "test-uirg-worker",
      POLL_INTERVAL_MS: "200",
      MAX_PARALLEL_WORKTREES: "1",
      CLAUDE_CMD: mockClaudePath,
      ALLOWED_REPOS: mockRepoDir,
      CLAUDE_TIMEOUT_MS: "30000",
      CLAUDE_BYPASS_PERMISSIONS: "true",
      REVIEW_MAX_ITERATIONS: "3",
      ORCHESTRATED_LOOP_ENABLED: "true",
      UI_REVIEW_ENABLED: "true",
      UI_REVIEW_CMD: mockDispatcherPath,
      UI_REVIEW_TIMEOUT_MS: "15000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  worker.stdout.on("data", (c) => {
    const lines = c.toString().split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const j = JSON.parse(line);
        if (j.level === "error" || j.level === "warn") console.log(color(33, `[worker] ${j.level}: ${j.msg}`));
      } catch {}
    }
  });
  worker.stderr.on("data", (c) => console.log(color(31, `[worker:err] ${c.toString().trim()}`)));
});

setTimeout(() => {
  console.log(color(31, "\n[TIMEOUT] test timed out after 60s"));
  if (worker) worker.kill("SIGTERM");
  server.close();
  process.exit(1);
}, 60000);
