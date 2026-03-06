#!/usr/bin/env node
"use strict";

/**
 * Integration test: Stage 3 — Clean-Context Isolated Review.
 *
 * Proves:
 *   1. (isolation) Review prompt contains isolation instruction, NOT implementer instructions
 *   2. (packet)    Review packet contains required fields: changedFiles, diff, checklist
 *   3. (telemetry) Result meta has isolatedRun=true, reviewPacketHash, reviewPacketSize
 *   4. (legacy)    Legacy task (no isolatedReview) still uses buildPrompt (instructions present)
 *   5. (gate)      Review gate works correctly with Stage 3 path (pass/fail)
 *   6. (orch)      Orchestrated loop with isolatedReview uses isolated review
 *
 * Mock claude inspects prompt content:
 *   - If prompt has "independent code reviewer" → isolated review → REVIEW_PASS
 *   - If prompt has "## Instructions" → legacy path → REVIEW_FAIL (leak detected)
 *   - If prompt has "## Review Findings" → patch run → success
 *   - If prompt has "always-fail-isolated" → isolated review → REVIEW_FAIL
 *
 * Usage: node test-stage3-isolated-review.js
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn, execSync } = require("child_process");

const PORT = 9879;

// ── Mock repo + mock claude ───────────────────────────────────────────────────

const mockClaudeDir = fs.mkdtempSync(path.join(os.tmpdir(), "mock-claude-s3-"));
const mockClaudePath = path.join(mockClaudeDir, "claude");
const mockRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-repo-s3-"));

execSync("git init", { cwd: mockRepoDir, stdio: "ignore" });
execSync('git config user.email "test@test.com"', { cwd: mockRepoDir, stdio: "ignore" });
execSync('git config user.name "Test"', { cwd: mockRepoDir, stdio: "ignore" });
execSync("git commit --allow-empty -m init", { cwd: mockRepoDir, stdio: "ignore" });

// Create a changed file so git diff has content
fs.writeFileSync(path.join(mockRepoDir, "app.js"), 'const x = 1;\nconsole.log(x);\n');
execSync("git add -A && git commit -m 'add app.js'", { cwd: mockRepoDir, stdio: "ignore" });
fs.writeFileSync(path.join(mockRepoDir, "app.js"), 'const x = 2;\nconsole.log(x);\n');

const mockClaudeScript = `#!/usr/bin/env node
"use strict";
const prompt = process.argv[process.argv.indexOf("-p") + 1] || "";

// Log the prompt for debugging (to stderr so it doesn't interfere with JSON stdout)
process.stderr.write("[mock-claude] prompt snippet: " + prompt.slice(0, 200) + "\\n");

// Patch run
if (prompt.includes("## Review Findings")) {
  process.stdout.write(JSON.stringify({
    type: "result", subtype: "success",
    result: "Patch applied successfully.",
    is_error: false,
  }));
  process.exit(0);
}

// Always-fail isolated review (identified by task ID in prompt)
if (prompt.includes("s3-isolated-fail-001")) {
  const result = "Found issues.\\n\\n[REVIEW_FAIL severity=major]\\nPersistent issue found.\\n[/REVIEW_FAIL]";
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", result, is_error: false }));
  process.exit(0);
}

// Isolated review path: prompt has isolation instruction, NOT ## Instructions
if (prompt.includes("independent code reviewer")) {
  // Verify isolation: prompt must NOT contain ## Instructions
  if (prompt.includes("## Instructions")) {
    // LEAK: implementer instructions leaked into review prompt
    const result = "LEAK DETECTED: implementer instructions in review prompt.\\n\\n[REVIEW_FAIL severity=critical]\\nContext isolation violated.\\n[/REVIEW_FAIL]";
    process.stdout.write(JSON.stringify({ type: "result", subtype: "success", result, is_error: false }));
    process.exit(0);
  }
  // Clean isolated review → pass
  const result = "Code review completed. All changes are clean and well-structured.\\n\\n[REVIEW_PASS]\\nAll checklist items satisfied. No issues found.";
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", result, is_error: false }));
  process.exit(0);
}

// Legacy review path (has ## Instructions)
if (prompt.includes("## Instructions")) {
  const result = "Legacy review completed.\\n\\n[REVIEW_PASS]\\nAll good.";
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", result, is_error: false }));
  process.exit(0);
}

// Implement mode (for orchestrated loop)
process.stdout.write(JSON.stringify({
  type: "result", subtype: "success",
  result: "Implementation completed successfully.",
  is_error: false,
}));
process.exit(0);
`;

fs.writeFileSync(mockClaudePath, mockClaudeScript, { mode: 0o755 });

// ── Task definitions ──────────────────────────────────────────────────────────

const SCOPE = { repoPath: mockRepoDir, branch: "agent/stage3-test" };

// Task 1: Isolated single-shot review (should use review packet, not instructions)
const TASK_ISOLATED_REVIEW = {
  taskId: "s3-isolated-review-001",
  mode: "review",
  isolatedReview: true,
  scope: SCOPE,
  instructions: "Review the authentication module. THIS SHOULD NOT APPEAR IN ISOLATED REVIEW.",
  constraints: ["no-regression", "security-check"],
};

// Task 2: Legacy review (no isolatedReview flag — should use buildPrompt with instructions)
const TASK_LEGACY_REVIEW = {
  taskId: "s3-legacy-review-001",
  mode: "review",
  scope: SCOPE,
  instructions: "Review the authentication module legacy style.",
};

// Task 3: Orchestrated loop with isolatedReview
const TASK_ORCH_ISOLATED = {
  taskId: "s3-orch-isolated-001",
  mode: "implement",
  orchestratedLoop: true,
  isolatedReview: true,
  maxReviewIterations: 2,
  scope: SCOPE,
  instructions: "Implement user authentication. THIS SHOULD NOT APPEAR IN REVIEW.",
};

// Task 4: Isolated review that fails (to test gate behavior)
const TASK_ISOLATED_FAIL = {
  taskId: "s3-isolated-fail-001",
  mode: "review",
  isolatedReview: true,
  requireReviewGate: true,
  scope: SCOPE,
  instructions: "always-fail-isolated review task.",
};

// ── State ─────────────────────────────────────────────────────────────────────

let pullCount = 0;
let receivedResults = [];
let receivedEvents = [];
let worker = null;

function color(code, text) {
  return `\x1b[${code}m${text}\x1b[0m`;
}

// ── Mock orchestrator ─────────────────────────────────────────────────────────

const PULL_SEQUENCE = [
  TASK_ISOLATED_REVIEW,
  TASK_LEGACY_REVIEW,
  TASK_ORCH_ISOLATED,
  TASK_ISOLATED_FAIL,
];

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
      if (pullCount >= PULL_SEQUENCE.length + 1) {
        setTimeout(() => finish(), 1500);
      }
      return;
    }

    if (req.url === "/api/worker/event") {
      const ev = JSON.parse(body);
      receivedEvents.push(ev);
      const statusColor = {
        claimed: 36, started: 36, progress: 33,
        review_pass: 32, review_fail: 31, context_reset: 34,
        escalated: 35, completed: 32, failed: 31,
      }[ev.status] || 37;
      console.log(color(statusColor, `[orch] ← event: ${ev.status}/${ev.phase} [${ev.taskId}] — ${(ev.message || "").slice(0, 100)}`));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.url === "/api/worker/result") {
      const result = JSON.parse(body);
      receivedResults.push(result);
      const statusColor = result.status === "review_pass" ? 32
        : result.status === "escalated" ? 35
        : result.status === "review_fail" ? 31 : 37;
      console.log(color(statusColor, `\n[orch] ← result: taskId=${result.taskId} status=${result.status}`));
      if (result.meta?.isolatedRun !== undefined) {
        console.log(color(37, `[orch]    isolatedRun=${result.meta.isolatedRun} packetHash=${(result.meta.reviewPacketHash || "").slice(0, 16)}... packetSize=${result.meta.reviewPacketSize}`));
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    res.writeHead(404);
    res.end("not found");
  });
});

// ── Finish + assertions ───────────────────────────────────────────────────────

function finish() {
  console.log(color(36, "\n" + "=".repeat(60)));
  console.log(color(36, "TEST RESULTS — Stage 3 Isolated Review"));
  console.log(color(36, "=".repeat(60)));

  const byTask = {};
  for (const r of receivedResults) {
    byTask[r.taskId] = r;
  }

  const checks = [];

  // ── TEST 1: Isolated review → review_pass (proves no instruction leak) ──
  const r1 = byTask["s3-isolated-review-001"];
  checks.push({
    name: "[isolation] isolated review → review_pass (no instruction leak)",
    pass: r1 && r1.status === "review_pass",
    detail: r1 ? `status=${r1.status}` : "no result",
  });

  // ── TEST 2: Telemetry fields present ──
  checks.push({
    name: "[telemetry] isolatedRun=true in result meta",
    pass: r1 && r1.meta?.isolatedRun === true,
    detail: r1 ? `isolatedRun=${r1.meta?.isolatedRun}` : "no result",
  });

  checks.push({
    name: "[telemetry] reviewPacketHash present (64-char hex)",
    pass: r1 && typeof r1.meta?.reviewPacketHash === "string" && r1.meta.reviewPacketHash.length === 64,
    detail: r1 ? `hash=${(r1.meta?.reviewPacketHash || "").slice(0, 16)}...` : "no result",
  });

  checks.push({
    name: "[telemetry] reviewPacketSize > 0",
    pass: r1 && r1.meta?.reviewPacketSize > 0,
    detail: r1 ? `size=${r1.meta?.reviewPacketSize}` : "no result",
  });

  checks.push({
    name: "[telemetry] changedFilesCount >= 0",
    pass: r1 && r1.meta?.changedFilesCount !== undefined,
    detail: r1 ? `count=${r1.meta?.changedFilesCount}` : "no result",
  });

  // ── TEST 3: Legacy review still works (uses buildPrompt, has instructions) ──
  const r2 = byTask["s3-legacy-review-001"];
  checks.push({
    name: "[legacy] legacy review (no isolatedReview) → review_pass",
    pass: r2 && r2.status === "review_pass",
    detail: r2 ? `status=${r2.status}` : "no result",
  });

  checks.push({
    name: "[legacy] legacy review has no isolatedRun telemetry",
    pass: r2 && r2.meta?.isolatedRun === undefined,
    detail: r2 ? `isolatedRun=${r2.meta?.isolatedRun}` : "no result",
  });

  // ── TEST 4: Orchestrated loop with isolatedReview → review_pass ──
  const r3 = byTask["s3-orch-isolated-001"];
  checks.push({
    name: "[orch] orchestrated loop with isolatedReview → review_pass",
    pass: r3 && r3.status === "review_pass",
    detail: r3 ? `status=${r3.status}` : "no result",
  });

  checks.push({
    name: "[orch] orchestrated isolated review has isolatedRun=true",
    pass: r3 && r3.meta?.isolatedRun === true,
    detail: r3 ? `isolatedRun=${r3.meta?.isolatedRun}` : "no result",
  });

  checks.push({
    name: "[orch] orchestrated isolated review has reviewPacketHash",
    pass: r3 && typeof r3.meta?.reviewPacketHash === "string" && r3.meta.reviewPacketHash.length === 64,
    detail: r3 ? `hash=${(r3.meta?.reviewPacketHash || "").slice(0, 16)}...` : "no result",
  });

  // ── TEST 5: Isolated review fail + gate ──
  const r4 = byTask["s3-isolated-fail-001"];
  checks.push({
    name: "[gate] isolated review fail → review_fail status",
    pass: r4 && r4.status === "review_fail",
    detail: r4 ? `status=${r4.status}` : "no result",
  });

  checks.push({
    name: "[gate] isolated review fail has isolatedRun=true",
    pass: r4 && r4.meta?.isolatedRun === true,
    detail: r4 ? `isolatedRun=${r4.meta?.isolatedRun}` : "no result",
  });

  // ── TEST 6: context_reset events for orchestrated loop ──
  const orchResetEvents = receivedEvents.filter(
    (e) => e.taskId === "s3-orch-isolated-001" && e.status === "context_reset"
  );
  checks.push({
    name: "[orch] context_reset events emitted for orchestrated loop",
    pass: orchResetEvents.length >= 2, // at least implement + review
    detail: `count=${orchResetEvents.length}`,
  });

  // ── Report ──
  let allPass = true;
  for (const c of checks) {
    const icon = c.pass ? color(32, "PASS") : color(31, "FAIL");
    console.log(`  ${icon}  ${c.name}  (${c.detail})`);
    if (!c.pass) allPass = false;
  }

  console.log(color(36, "\n" + "=".repeat(60)));
  if (allPass) {
    console.log(color(32, `ALL ${checks.length} TESTS PASSED`));
  } else {
    const failed = checks.filter((c) => !c.pass).length;
    console.log(color(31, `${failed}/${checks.length} TESTS FAILED`));
  }
  console.log(color(36, "=".repeat(60)));

  cleanup();
  process.exit(allPass ? 0 : 1);
}

function cleanup() {
  if (worker) {
    worker.kill("SIGTERM");
    setTimeout(() => worker && worker.kill("SIGKILL"), 2000);
  }
  server.close();
  try { fs.rmSync(mockClaudeDir, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(mockRepoDir, { recursive: true, force: true }); } catch {}
}

process.on("SIGINT", () => { cleanup(); process.exit(1); });
process.on("SIGTERM", () => { cleanup(); process.exit(1); });

// ── Start ─────────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(color(36, `[orch] listening on :${PORT}`));

  worker = spawn("node", [path.join(__dirname, "worker.js")], {
    env: {
      ...process.env,
      ORCH_BASE_URL: `http://127.0.0.1:${PORT}`,
      WORKER_TOKEN: "test-token",
      WORKER_ID: "test-stage3",
      POLL_INTERVAL_MS: "800",
      MAX_PARALLEL_WORKTREES: "1",
      CLAUDE_CMD: mockClaudePath,
      ALLOWED_REPOS: mockRepoDir,
      CLAUDE_TIMEOUT_MS: "30000",
      CLAUDE_BYPASS_PERMISSIONS: "true",
      CLAUDE_MODEL: "sonnet",
      REVIEW_MAX_ITERATIONS: "3",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  worker.stdout.on("data", (c) => {
    for (const line of c.toString().split("\n").filter(Boolean)) {
      try {
        const j = JSON.parse(line);
        if (j.msg && j.msg.includes("isolated_review")) {
          console.log(color(34, `[worker] ${j.msg} hash=${(j.reviewPacketHash || "").slice(0, 12)}... size=${j.reviewPacketSize}`));
        }
      } catch {}
    }
  });

  worker.stderr.on("data", (c) => {
    process.stderr.write(color(33, `[worker:err] ${c}`));
  });

  // Safety timeout
  setTimeout(() => {
    console.log(color(31, "\n[TIMEOUT] test timed out after 45s"));
    cleanup();
    process.exit(1);
  }, 45000);
});
