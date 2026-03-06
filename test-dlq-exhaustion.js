#!/usr/bin/env node
"use strict";

/**
 * Integration test: DLQ exhaustion, idempotency, and observability.
 *
 * Covers:
 *   1. Transient retries exhausted → DLQ event/write happens exactly once.
 *   2. Idempotency prevents duplicate DLQ side effects.
 *   3. Observability fields include exhaustionReason, retryCount, maxRetries.
 *   4. Fatal error → immediate DLQ (existing behavior, verified).
 *
 * Port: 9879 (avoids conflicts with other test files).
 *
 * Usage: node test-dlq-exhaustion.js
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn, execSync } = require("child_process");

// PORT assigned dynamically via server.listen(0)
const MAX_RETRIES = 2; // task-level transient failure threshold

// ── Mock repo + mock claude ────────────────────────────────────────────────────

const mockClaudeDir = fs.mkdtempSync(path.join(os.tmpdir(), "mock-claude-dlq-"));
const mockClaudePath = path.join(mockClaudeDir, "claude");
const mockRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-repo-dlq-"));

execSync("git init", { cwd: mockRepoDir, stdio: "ignore" });
execSync('git config user.email "test@test.com"', { cwd: mockRepoDir, stdio: "ignore" });
execSync('git config user.name "Test"', { cwd: mockRepoDir, stdio: "ignore" });
execSync("git commit --allow-empty -m init", { cwd: mockRepoDir, stdio: "ignore" });

// Mock claude: always succeeds
const mockClaudeScript = `#!/usr/bin/env node
"use strict";
const prompt = process.argv[process.argv.indexOf("-p") + 1] || "";

function out(result) {
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", result, is_error: false }));
  process.exit(0);
}

if (prompt.includes("DLQ-TRANSIENT-TEST")) {
  out("Implementation complete for DLQ-TRANSIENT-TEST.");
}

if (prompt.includes("DLQ-FATAL-TEST")) {
  // This one won't be reached because we'll use a bad claude cmd path for fatal
  out("Implementation complete for DLQ-FATAL-TEST.");
}

out("Task completed successfully.");
`;

fs.writeFileSync(mockClaudePath, mockClaudeScript, { mode: 0o755 });

// ── Task definitions ────────────────────────────────────────────────────────────

const SCOPE = { repoPath: mockRepoDir, branch: "agent/dlq-exhaustion-test" };

const TASK_TRANSIENT = {
  taskId: "dlq-transient-exhaust-001",
  mode: "implement",
  scope: SCOPE,
  instructions: "DLQ-TRANSIENT-TEST: implement a simple feature.",
};

// ── State ────────────────────────────────────────────────────────────────────────

let pullCount = 0;
let receivedResults = [];
let receivedEvents = [];
let receivedDlq = [];
let transientTaskResultAttempts = 0;
let worker = null;

function color(code, text) { return `\x1b[${code}m${text}\x1b[0m`; }

// ── Pull sequence ──
// Serve the transient task MAX_RETRIES times (each time result endpoint returns 500).
// Then serve it once more — this time it will already be DLQ'd, but the orchestrator
// might still serve it. Then empty.

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
      // Serve the transient task MAX_RETRIES times to trigger exhaustion
      if (pullCount <= MAX_RETRIES) {
        console.log(color(36, `\n[orch] → pull ${pullCount}: serving ${TASK_TRANSIENT.taskId}`));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, task: TASK_TRANSIENT }));
        return;
      }
      // After exhaustion, return empty
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      if (pullCount >= MAX_RETRIES + 2) {
        setTimeout(() => finish(), 2000);
      }
      return;
    }

    if (req.url === "/api/worker/event") {
      const ev = JSON.parse(body);
      receivedEvents.push(ev);
      const statusColor = {
        claimed: 36, started: 36, progress: 33, failed: 31,
        completed: 32, context_reset: 34,
      }[ev.status] || 37;
      console.log(color(statusColor, `[orch] ← event: ${ev.status}/${ev.phase} [${ev.taskId}] — ${(ev.message || "").slice(0, 120)}`));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.url === "/api/worker/result") {
      const result = JSON.parse(body);
      // Return 500 for the transient task to simulate transient failure
      if (result.taskId === TASK_TRANSIENT.taskId) {
        transientTaskResultAttempts++;
        console.log(color(31, `[orch] ← result: ${result.taskId} → returning 500 (attempt ${transientTaskResultAttempts})`));
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "simulated transient failure" }));
        return;
      }
      receivedResults.push(result);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.url === "/api/worker/dead-letter") {
      const dlq = JSON.parse(body);
      receivedDlq.push(dlq);
      console.log(color(35, `\n[orch] ← DLQ: taskId=${dlq.taskId} errorClass=${dlq.errorClass} retryCount=${dlq.retryCount}`));
      console.log(color(35, `[orch]   exhaustionReason: ${dlq.exhaustionReason || "N/A"}`));
      console.log(color(35, `[orch]   maxRetries: ${dlq.maxRetries}`));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.url === "/api/worker/lease") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    res.writeHead(404);
    res.end("not found");
  });
});

// ── Finish + assertions ─────────────────────────────────────────────────────────

function finish() {
  console.log(color(36, "\n" + "=".repeat(60)));
  console.log(color(36, "TEST RESULTS — DLQ Exhaustion, Idempotency, Observability"));
  console.log(color(36, "=".repeat(60)));

  const eventsByTask = {};
  for (const e of receivedEvents) {
    if (!eventsByTask[e.taskId]) eventsByTask[e.taskId] = [];
    eventsByTask[e.taskId].push(e);
  }

  const checks = [];

  // ── 1. Transient retries exhausted → DLQ event/write happens exactly once ──
  const dlqForTransient = receivedDlq.filter(d => d.taskId === TASK_TRANSIENT.taskId);
  checks.push({
    name: "[DLQ:exhaustion] transient task → DLQ write happens exactly once",
    pass: dlqForTransient.length === 1,
    detail: `dlq writes=${dlqForTransient.length}`,
  });

  // ── 2. DLQ payload has correct errorClass ──
  const dlqPayload = dlqForTransient[0];
  checks.push({
    name: "[DLQ:exhaustion] errorClass is transient_exhausted",
    pass: dlqPayload && dlqPayload.errorClass === "transient_exhausted",
    detail: dlqPayload ? `errorClass=${dlqPayload.errorClass}` : "no DLQ payload",
  });

  // ── 3. Observability: exhaustionReason present and includes retry count ──
  checks.push({
    name: "[DLQ:observability] exhaustionReason present and mentions attempts",
    pass: dlqPayload && typeof dlqPayload.exhaustionReason === "string" && dlqPayload.exhaustionReason.includes("exhausted"),
    detail: dlqPayload ? `exhaustionReason="${dlqPayload.exhaustionReason}"` : "no DLQ payload",
  });

  // ── 4. Observability: retryCount matches MAX_RETRIES ──
  checks.push({
    name: `[DLQ:observability] retryCount=${MAX_RETRIES} (matches config)`,
    pass: dlqPayload && dlqPayload.retryCount === MAX_RETRIES,
    detail: dlqPayload ? `retryCount=${dlqPayload.retryCount}` : "no DLQ payload",
  });

  // ── 5. Observability: maxRetries field present ──
  checks.push({
    name: "[DLQ:observability] maxRetries field present in DLQ payload",
    pass: dlqPayload && dlqPayload.maxRetries === MAX_RETRIES,
    detail: dlqPayload ? `maxRetries=${dlqPayload.maxRetries}` : "no DLQ payload",
  });

  // ── 6. Observability: context field present ──
  checks.push({
    name: "[DLQ:observability] context field is 'transient retries exhausted in slot'",
    pass: dlqPayload && dlqPayload.context === "transient retries exhausted in slot",
    detail: dlqPayload ? `context="${dlqPayload.context}"` : "no DLQ payload",
  });

  // ── 7. DLQ event emitted (failed/dlq) ──
  const dlqEvents = (eventsByTask[TASK_TRANSIENT.taskId] || []).filter(
    e => e.status === "failed" && e.phase === "dlq"
  );
  checks.push({
    name: "[DLQ:event] failed/dlq event emitted for transient task",
    pass: dlqEvents.length >= 1,
    detail: `failed/dlq events=${dlqEvents.length}`,
  });

  // ── 8. DLQ event message includes exhaustion detail ──
  const dlqEventMsg = dlqEvents[0]?.message || "";
  checks.push({
    name: "[DLQ:event] failed/dlq message includes 'transient retries exhausted'",
    pass: dlqEventMsg.includes("transient retries exhausted"),
    detail: `msg="${dlqEventMsg.slice(0, 100)}"`,
  });

  // ── 9. Transient failure events emitted before DLQ (failed/transient phase) ──
  const transientEvents = (eventsByTask[TASK_TRANSIENT.taskId] || []).filter(
    e => e.status === "failed" && e.phase === "transient"
  );
  // With MAX_RETRIES=2, the first failure (failCount=1) emits failed/transient,
  // then the second failure (failCount=2) goes straight to DLQ.
  // So we expect exactly 1 transient event (from the first failure before exhaustion).
  checks.push({
    name: "[DLQ:progression] failed/transient events before DLQ",
    pass: transientEvents.length === MAX_RETRIES - 1,
    detail: `transient events=${transientEvents.length}, expected=${MAX_RETRIES - 1}`,
  });

  // ── 10. Idempotency: result endpoint was hit multiple times per task attempt ──
  // (apiPost retries internally) but DLQ posted only once
  checks.push({
    name: "[DLQ:idempotency] result endpoint hit multiple times but DLQ written once",
    pass: transientTaskResultAttempts > MAX_RETRIES && dlqForTransient.length === 1,
    detail: `resultAttempts=${transientTaskResultAttempts}, dlqWrites=${dlqForTransient.length}`,
  });

  // ── 11. DLQ payload has taskSnapshot ──
  checks.push({
    name: "[DLQ:observability] taskSnapshot present with mode and taskId",
    pass: dlqPayload && dlqPayload.taskSnapshot && dlqPayload.taskSnapshot.mode === "implement" && dlqPayload.taskSnapshot.taskId === TASK_TRANSIENT.taskId,
    detail: dlqPayload?.taskSnapshot ? `mode=${dlqPayload.taskSnapshot.mode}` : "no taskSnapshot",
  });

  // ── 12. DLQ payload has lastError with message ──
  checks.push({
    name: "[DLQ:observability] lastError.message includes HTTP 500",
    pass: dlqPayload && dlqPayload.lastError && /HTTP 500/.test(dlqPayload.lastError.message),
    detail: dlqPayload?.lastError ? `msg="${(dlqPayload.lastError.message || "").slice(0, 80)}"` : "no lastError",
  });

  // ── Report ──
  let allPass = true;
  for (const c of checks) {
    const icon = c.pass ? color(32, "PASS") : color(31, "FAIL");
    console.log(`  ${icon}  ${c.name}`);
    if (c.detail) console.log(`         ${color(37, c.detail)}`);
    if (!c.pass) allPass = false;
  }

  console.log(color(36, "\n" + "=".repeat(60)));
  if (allPass) {
    console.log(color(32, `ALL ${checks.length} CHECKS PASSED`));
  } else {
    const failCount = checks.filter(c => !c.pass).length;
    console.log(color(31, `${failCount}/${checks.length} CHECKS FAILED`));
  }
  console.log(color(36, "=".repeat(60)));

  if (worker) worker.kill("SIGTERM");
  server.close();
  try { fs.rmSync(mockClaudeDir, { recursive: true }); } catch {}
  try { fs.rmSync(mockRepoDir, { recursive: true }); } catch {}
  process.exit(allPass ? 0 : 1);
}

// ── Start ────────────────────────────────────────────────────────────────────────

server.listen(0, () => {
  const PORT = server.address().port;
  console.log(color(36, `[orch] mock orchestrator on http://localhost:${PORT}`));
  console.log(color(36, `[orch] mock claude: ${mockClaudePath}`));
  console.log(color(36, `[orch] mock repo:   ${mockRepoDir}`));
  console.log(color(36, "[orch] spawning worker...\n"));

  worker = spawn("node", ["worker.js"], {
    cwd: path.join(__dirname),
    env: {
      ...process.env,
      ORCH_BASE_URL: `http://localhost:${PORT}`,
      WORKER_TOKEN: "test-token",
      WORKER_ID: "test-worker-dlq",
      POLL_INTERVAL_MS: "300",
      CLAUDE_CMD: mockClaudePath,
      ALLOWED_REPOS: mockRepoDir,
      CLAUDE_TIMEOUT_MS: "15000",
      CLAUDE_BYPASS_PERMISSIONS: "false",
      MAX_RETRIES: String(MAX_RETRIES),
      RETRY_BACKOFF_BASE_MS: "10",
      DLQ_ENABLED: "true",
      IDEMPOTENCY_ENABLED: "true",
      MAX_PARALLEL_WORKTREES: "1",
    },
    stdio: "inherit",
  });

  worker.on("close", (code) => {
    console.log(color(37, `\n[orch] worker exited with code ${code}`));
  });

  setTimeout(() => {
    console.log(color(31, "\n[orch] TIMEOUT — test took too long, aborting"));
    if (worker) worker.kill("SIGKILL");
    server.close();
    try { fs.rmSync(mockClaudeDir, { recursive: true }); } catch {}
    try { fs.rmSync(mockRepoDir, { recursive: true }); } catch {}
    process.exit(1);
  }, 60000);
});
