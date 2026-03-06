#!/usr/bin/env node
"use strict";

/**
 * Regression tests for timeout normalization in worker.js.
 *
 * Three scenarios:
 *   1. normalizeTimeoutMs unit tests — large/invalid/edge values
 *   2. No instant timeout: worker with huge CLAUDE_TIMEOUT_MS completes normally
 *   3. Genuine timeout: short timeout correctly fires and is reported
 *
 * Usage: node test-timeout-normalization.js
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

function ensureRepo(dir) {
  if (!fs.existsSync(dir)) {
    execSync(`git init "${dir}"`, { stdio: "ignore" });
    execSync(`git -C "${dir}" commit --allow-empty -m "init"`, { stdio: "ignore" });
  }
}

function runScenario({ port, task, workerEnv, afterResultMs = 600 }) {
  return new Promise((resolve, reject) => {
    const events = [];
    let pullCount   = 0;
    let resultPayload = null;
    let worker      = null;
    let settled     = false;

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
          ORCH_BASE_URL:             `http://localhost:${port}`,
          WORKER_TOKEN:              "test-token",
          WORKER_ID:                 `test-worker-${port}`,
          POLL_INTERVAL_MS:          "300",
          MAX_PARALLEL_WORKTREES:    "1",
          CLAUDE_BYPASS_PERMISSIONS: "false",
          ...workerEnv,
        },
        stdio: "pipe",
      });

      worker.on("error", (err) => {
        console.error("Worker spawn error:", err.message);
        finish();
      });

      setTimeout(() => {
        console.error("  [WARN] scenario timed out after 15s");
        finish();
      }, 15000);
    });
  });
}

// ── Test 1: normalizeTimeoutMs unit ───────────────────────────────────────────
//
// Inline reimplementation matching worker.js — keeps unit tests self-contained
// and verifiable without spawning a worker process.

function normalizeTimeoutMs(raw) {
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 180000;
  if (parsed < 1000) return 1000;
  if (parsed > 2147483647) return 2147483647;
  return parsed;
}

function testNormalizeUnit() {
  console.log("\n=== Test 1: normalizeTimeoutMs unit ===");

  // Very large values — the regression input — must be clamped to Node safe max
  assert(normalizeTimeoutMs("10000000000") === 2147483647, "10000000000 clamped to 2147483647");
  assert(normalizeTimeoutMs("9999999999")  === 2147483647, "9999999999 clamped to 2147483647");
  assert(normalizeTimeoutMs("2147483648")  === 2147483647, "2147483648 clamped to 2147483647");
  assert(normalizeTimeoutMs("2147483647")  === 2147483647, "2147483647 passed through unchanged");

  // Invalid / missing values → fall back to default (180 000 ms)
  assert(normalizeTimeoutMs(undefined)  === 180000, "undefined  → default 180000");
  assert(normalizeTimeoutMs("")         === 180000, "empty string → default 180000");
  assert(normalizeTimeoutMs("abc")      === 180000, "'abc'      → default 180000");
  assert(normalizeTimeoutMs("0")        === 180000, "'0'        → default 180000");
  assert(normalizeTimeoutMs("-1000")    === 180000, "negative   → default 180000");
  assert(normalizeTimeoutMs("NaN")      === 180000, "'NaN'      → default 180000");

  // Below minimum (1 000 ms) → clamped up
  assert(normalizeTimeoutMs("500")  === 1000, "500 clamped up to 1000");
  assert(normalizeTimeoutMs("1")    === 1000, "1 clamped up to 1000");
  assert(normalizeTimeoutMs("999")  === 1000, "999 clamped up to 1000");

  // Normal valid values → pass through unmodified
  assert(normalizeTimeoutMs("420000") === 420000, "420000 passed through");
  assert(normalizeTimeoutMs("180000") === 180000, "180000 passed through");
  assert(normalizeTimeoutMs("5000")   === 5000,   "5000 passed through");
  assert(normalizeTimeoutMs("1000")   === 1000,   "1000 (exact minimum) passed through");
}

// ── Test 2: no instant timeout with huge CLAUDE_TIMEOUT_MS ────────────────────

async function testNoInstantTimeoutWithHugeInput() {
  console.log("\n=== Test 2: huge CLAUDE_TIMEOUT_MS does NOT trigger instant timeout ===");

  const REPO = "/tmp/test-timeout-norm-repo";
  ensureRepo(REPO);

  const startMs = Date.now();

  const { events, resultPayload } = await runScenario({
    port: 9884,
    task: {
      taskId:       "timeout-norm-001",
      mode:         "implement",
      scope:        { repoPath: REPO, branch: "feature/timeout-norm-test" },
      instructions: "timeout normalization regression test",
      constraints:  [],
    },
    workerEnv: {
      ALLOWED_REPOS:          REPO,
      CLAUDE_CMD:             MOCK_CLAUDE,
      CLAUDE_TIMEOUT_MS:      "10000000000",  // regression value: 10 billion ms
      HEARTBEAT_INTERVAL_MS:  "60000",
      MOCK_CLAUDE_SLEEP_MS:   "300",          // mock exits normally after 300 ms
    },
    afterResultMs: 300,
  });

  const elapsed     = Date.now() - startMs;
  const timeoutEvt  = events.find(e => e.status === "timeout");

  assert(!timeoutEvt,
    "no timeout event fired (huge input clamped, task runs to completion)");
  assert(resultPayload?.status === "completed",
    `result.status === "completed" (got: ${resultPayload?.status})`);
  // Instant-timeout signature is < 200 ms; normal completion must be ≥ that.
  assert(elapsed >= 200,
    `elapsed ${elapsed} ms ≥ 200 ms (not an instant-timeout blowup)`);

  console.log(`  elapsed: ${elapsed} ms`);
}

// ── Test 3: genuine short timeout fires correctly ─────────────────────────────

async function testGenuineTimeoutFires() {
  console.log("\n=== Test 3: genuine short timeout fires correctly ===");

  const REPO = "/tmp/test-timeout-norm-repo";
  ensureRepo(REPO);

  // timeout = 1500 ms; mock-claude sleeps 10 000 ms → must be killed by timer
  const { events, resultPayload } = await runScenario({
    port: 9885,
    task: {
      taskId:       "timeout-norm-002",
      mode:         "implement",
      scope:        { repoPath: REPO, branch: "feature/genuine-timeout" },
      instructions: "genuine timeout test",
      constraints:  [],
    },
    workerEnv: {
      ALLOWED_REPOS:          REPO,
      CLAUDE_CMD:             MOCK_CLAUDE,
      CLAUDE_TIMEOUT_MS:      "1500",
      HEARTBEAT_INTERVAL_MS:  "60000",
      MOCK_CLAUDE_SLEEP_MS:   "10000",   // sleeps 10 s — well past timeout
    },
    afterResultMs: 1000,
  });

  const timeoutEvt = events.find(e => e.status === "timeout");
  assert(timeoutEvt !== undefined,
    "timeout event fired for genuine timeout case");
  assert(resultPayload?.status === "timeout",
    `result.status === "timeout" (got: ${resultPayload?.status})`);

  console.log(`  timeout event phase: ${timeoutEvt?.phase}`);
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  console.log("=== worker.js timeout normalization regression tests ===");

  testNormalizeUnit();

  try {
    await testNoInstantTimeoutWithHugeInput();
    await testGenuineTimeoutFires();
  } catch (err) {
    console.error("\nUnexpected test error:", err.message, err.stack);
    failed++;
  }

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
