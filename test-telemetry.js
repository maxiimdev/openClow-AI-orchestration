#!/usr/bin/env node
"use strict";

/**
 * Integration tests for step-level progress telemetry, heartbeat, and risk events.
 *
 * Three scenarios:
 *   1. dry_run  – verifies plan/validate/report progress events + stepIndex/stepTotal
 *   2. heartbeat – verifies keepalive fires when mock-claude is silent > heartbeatIntervalMs
 *   3. near-timeout risk – verifies risk/near_timeout fires when near CLAUDE_TIMEOUT_MS
 *
 * Usage: node test-telemetry.js
 */

const http = require("http");
const path = require("path");
const fs   = require("fs");
const { spawn, execSync } = require("child_process");

// ── Helpers ────────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) {
    console.log(`  [PASS] ${msg}`);
    passed++;
  } else {
    console.error(`  [FAIL] ${msg}`);
    failed++;
  }
}

const MOCK_CLAUDE = path.join(__dirname, "test", "mock-claude.js");

/** Ensure a bare git repo exists at the given path (idempotent). */
function ensureRepo(dir) {
  if (!fs.existsSync(dir)) {
    execSync(`git init "${dir}"`, { stdio: "ignore" });
    execSync(`git -C "${dir}" commit --allow-empty -m "init"`, { stdio: "ignore" });
  }
}

/**
 * Spin up a mock orchestrator, spawn the worker, run one task, collect events,
 * then shut down. Returns collected events.
 */
function runScenario({ port, task, workerEnv, afterResultMs = 600 }) {
  return new Promise((resolve, reject) => {
    const events = [];
    let pullCount = 0;
    let resultPayload = null;
    let worker = null;
    let settled = false;

    function finish() {
      if (settled) return;
      settled = true;
      if (worker) { try { worker.kill("SIGTERM"); } catch (_) {} }
      server.close(() => resolve({ events, resultPayload }));
    }

    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        if (req.headers.authorization !== "Bearer test-token") {
          res.writeHead(401); res.end("{}"); return;
        }

        if (req.url === "/api/worker/pull") {
          pullCount++;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, task: pullCount === 1 ? task : null }));
          return;
        }

        if (req.url === "/api/worker/event") {
          try { events.push(JSON.parse(body)); } catch (_) {}
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          return;
        }

        if (req.url === "/api/worker/result") {
          try { resultPayload = JSON.parse(body); } catch (_) {}
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          // Give worker time to finish, then stop.
          setTimeout(finish, afterResultMs);
          return;
        }

        res.writeHead(404); res.end("not found");
      });
    });

    server.on("error", reject);

    server.listen(port, () => {
      worker = spawn("node", ["worker.js"], {
        cwd: path.join(__dirname),
        env: {
          ...process.env,
          ORCH_BASE_URL:   `http://localhost:${port}`,
          WORKER_TOKEN:    "test-token",
          WORKER_ID:       `test-worker-${port}`,
          POLL_INTERVAL_MS: "300",
          CLAUDE_BYPASS_PERMISSIONS: "false",
          ...workerEnv,
        },
        stdio: "pipe",
      });

      worker.on("error", (err) => {
        console.error("Worker spawn error:", err.message);
        finish();
      });

      // Safety: abort after 15 s
      setTimeout(() => {
        console.error("  [WARN] scenario timed out after 15 s");
        finish();
      }, 15000);
    });
  });
}

// ── Test 1: dry_run step progression ──────────────────────────────────────────

async function testDryRunStepProgression() {
  console.log("\n=== Test 1: dry_run step progression ===");

  const { events, resultPayload } = await runScenario({
    port: 9878,
    task: {
      taskId:       "telem-001",
      mode:         "dry_run",
      scope:        { repoPath: "/tmp/test-repo", branch: "feature/hello" },
      instructions: "Test step telemetry",
      constraints:  [],
    },
    workerEnv: {
      ALLOWED_REPOS: "/tmp/test-repo",
    },
  });

  const planEvt     = events.find(e => e.status === "progress" && e.phase === "plan");
  const validateEvt = events.find(e => e.status === "progress" && e.phase === "validate");
  const reportEvt   = events.find(e => e.status === "progress" && e.phase === "report");
  const completedEvt = events.find(e => e.status === "completed");

  assert(planEvt     !== undefined, "plan progress event emitted");
  assert(validateEvt !== undefined, "validate progress event emitted");
  assert(reportEvt   !== undefined, "report progress event emitted");
  assert(completedEvt !== undefined, "completed event emitted");

  // dry_run plan has 2 steps: ["validate", "report"]
  assert(planEvt?.meta?.stepTotal === 2,          "plan event stepTotal=2 (dry_run)");
  assert(Array.isArray(planEvt?.meta?.steps) && planEvt.meta.steps.length === 2,
                                                  "plan event carries steps array");
  assert(planEvt?.meta?.stepIndex === 0,          "plan event stepIndex=0");

  assert(validateEvt?.meta?.stepIndex === 1,      "validate stepIndex=1");
  assert(validateEvt?.meta?.stepTotal === 2,      "validate stepTotal=2");

  assert(reportEvt?.meta?.stepIndex === 2,        "report stepIndex=2");
  assert(reportEvt?.meta?.stepTotal === 2,        "report stepTotal=2");

  assert(resultPayload?.status === "completed",   "result status=completed");
  assert(resultPayload?.taskId === "telem-001",   "result taskId matches");

  console.log(`  events captured: ${events.length}`);
}

// ── Test 2: heartbeat (keepalive event) ────────────────────────────────────────

async function testHeartbeat() {
  console.log("\n=== Test 2: heartbeat (keepalive) ===");

  const REPO = "/tmp/test-telem-repo";
  ensureRepo(REPO);

  // Mock claude sleeps 800 ms; heartbeat fires every 300 ms → expect ≥1 keepalive
  const { events } = await runScenario({
    port: 9879,
    task: {
      taskId:       "telem-002",
      mode:         "implement",
      scope:        { repoPath: REPO, branch: "feature/telem-hb" },
      instructions: "heartbeat test",
      constraints:  [],
    },
    workerEnv: {
      ALLOWED_REPOS:          REPO,
      CLAUDE_CMD:             MOCK_CLAUDE,
      CLAUDE_TIMEOUT_MS:      "5000",
      HEARTBEAT_INTERVAL_MS:  "300",
      MOCK_CLAUDE_SLEEP_MS:   "800",
    },
  });

  const keepalives = events.filter(e => e.status === "keepalive");
  assert(keepalives.length >= 1, `at least one keepalive event fired (got ${keepalives.length})`);

  const kv = keepalives[0];
  assert(kv.phase === "claude",               "keepalive phase=claude");
  assert(typeof kv.meta?.elapsedMs === "number" && kv.meta.elapsedMs > 0,
                                              "keepalive carries elapsedMs");
  assert(typeof kv.meta?.stepIndex === "number", "keepalive carries stepIndex");
  assert(typeof kv.meta?.stepTotal === "number", "keepalive carries stepTotal");

  console.log(`  keepalive events: ${keepalives.length}`);
}

// ── Test 3: near-timeout risk event ───────────────────────────────────────────

async function testNearTimeoutRisk() {
  console.log("\n=== Test 3: near-timeout risk event ===");

  const REPO = "/tmp/test-telem-repo";
  ensureRepo(REPO);

  // CLAUDE_TIMEOUT_MS=2000 → nearTimeoutMs=1600
  // Mock claude sleeps 1800 ms: risk fires at 1600, claude finishes at 1800, no actual timeout.
  const { events } = await runScenario({
    port: 9880,
    task: {
      taskId:       "telem-003",
      mode:         "implement",
      scope:        { repoPath: REPO, branch: "feature/telem-risk" },
      instructions: "risk event test",
      constraints:  [],
    },
    workerEnv: {
      ALLOWED_REPOS:         REPO,
      CLAUDE_CMD:            MOCK_CLAUDE,
      CLAUDE_TIMEOUT_MS:     "2000",
      HEARTBEAT_INTERVAL_MS: "60000",   // disable heartbeat noise
      MOCK_CLAUDE_SLEEP_MS:  "1800",
    },
    afterResultMs: 800,
  });

  const riskEvts = events.filter(e => e.status === "risk");
  assert(riskEvts.length >= 1, `at least one risk event fired (got ${riskEvts.length})`);

  const nearTimeout = riskEvts.find(e => e.meta?.riskType === "near_timeout");
  assert(nearTimeout !== undefined,               "near_timeout risk event fired");
  assert(nearTimeout?.phase === "claude",         "risk event phase=claude");
  assert(typeof nearTimeout?.meta?.elapsedMs === "number",
                                                  "risk event carries elapsedMs");
  assert(nearTimeout?.meta?.timeoutMs === 2000,   "risk event carries timeoutMs");

  console.log(`  risk events: ${riskEvts.length}`);
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  console.log("=== worker.js telemetry tests ===");
  console.log(`mock-claude: ${MOCK_CLAUDE}`);

  try {
    await testDryRunStepProgression();
    await testHeartbeat();
    await testNearTimeoutRisk();
  } catch (err) {
    console.error("\nUnexpected test error:", err.message);
    failed++;
  }

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
