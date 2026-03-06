#!/usr/bin/env node
"use strict";

/**
 * Integration test: Flag-Combination Hardening.
 *
 * Covers missing flag-combination coverage:
 *
 *   Combo 1 — reviewLoop + requireReviewGate:
 *     1. [rl+gate] pass → review_pass (gate is no-op, loop handles terminal state)
 *     2. [rl+gate] always-fail → escalated (gate is no-op, loop escalates)
 *     3. [rl+gate] gate does NOT set reviewGateEnforced (loop returns legal status)
 *
 *   Combo 2 — isolatedReview + reviewLoop:
 *     4. [iso+rl] fail→pass → review_pass with isolatedRun=true telemetry
 *     5. [iso+rl] always-fail → escalated with isolatedRun=true
 *     6. [iso+rl] prompt uses isolation (no instruction leak)
 *
 *   Combo 3 — isolatedReview + requireReviewGate + reviewLoop (triple):
 *     7. [triple] pass → review_pass, isolatedRun=true, gate is no-op
 *     8. [triple] always-fail → escalated, isolatedRun=true, gate is no-op
 *
 *   Regression guards:
 *     9.  [legacy] plain review (no flags) → review_pass via inline gate
 *     10. [orch]   orchestratedLoop + pass → review_pass (no regression)
 *
 * Port: dynamic (server.listen(0))
 *
 * Usage: node test-flag-combo-hardening.js
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn, execSync } = require("child_process");

// ── Mock repo + mock claude ────────────────────────────────────────────────────

const mockClaudeDir = fs.mkdtempSync(path.join(os.tmpdir(), "mock-claude-fch-"));
const mockClaudePath = path.join(mockClaudeDir, "claude");
const mockRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-repo-fch-"));

execSync("git init", { cwd: mockRepoDir, stdio: "ignore" });
execSync('git config user.email "test@test.com"', { cwd: mockRepoDir, stdio: "ignore" });
execSync('git config user.name "Test"', { cwd: mockRepoDir, stdio: "ignore" });
execSync("git commit --allow-empty -m init", { cwd: mockRepoDir, stdio: "ignore" });

// Create a changed file so git diff has content for isolated review packets
fs.writeFileSync(path.join(mockRepoDir, "app.js"), 'const x = 1;\nconsole.log(x);\n');
execSync("git add -A && git commit -m 'add app.js'", { cwd: mockRepoDir, stdio: "ignore" });
fs.writeFileSync(path.join(mockRepoDir, "app.js"), 'const x = 2;\nconsole.log(x);\n');

// Mock claude: behavior determined by prompt content
const mockClaudeScript = `#!/usr/bin/env node
"use strict";
const prompt = process.argv[process.argv.indexOf("-p") + 1] || "";

function out(result) {
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", result, is_error: false }));
  process.exit(0);
}

// ── Patch runs (any task with "## Review Findings" in prompt) ──
if (prompt.includes("## Review Findings")) {
  out("Patch applied successfully. All findings addressed.");
}

// ── ALWAYS-FAIL scenarios (identified by "always-fail" in taskId/instructions) ──
if (prompt.includes("always-fail")) {
  const findings = [{id:"F1",severity:"major",file:"app.js",issue:"Persistent bug",risk:"High",required_fix:"Fix it",acceptance_check:"Bug fixed"}];
  out("Still failing.\\n\\n[REVIEW_FAIL severity=major]\\nPersistent issue.\\n[REVIEW_FINDINGS_JSON]" + JSON.stringify(findings) + "[/REVIEW_FINDINGS_JSON]\\n[/REVIEW_FAIL]");
}

// ── FAIL-THEN-PASS: re-review after patch ──
// Non-isolated re-reviews have "review-loop-context" from buildReviewTaskWithDiff
// Isolated re-reviews have "Previous Review Findings" from buildIsolatedReviewPrompt
if (prompt.includes("fail-then-pass") || prompt.includes("fch-iso-rl-pass") || prompt.includes("fch-triple-pass")) {
  if (prompt.includes("review-loop-context") || prompt.includes("Previous Review Findings")) {
    out("Re-reviewed. All issues resolved.\\n\\n[REVIEW_PASS]\\nAll findings addressed.");
  }
  // First review → REVIEW_FAIL with structured findings
  const findings = [{id:"F1",severity:"critical",file:"app.js",issue:"SQL injection",risk:"DB compromise",required_fix:"Parameterize",acceptance_check:"No concat in SQL"}];
  out("Found issues.\\n\\n[REVIEW_FAIL severity=critical]\\nSQL injection found.\\n[REVIEW_FINDINGS_JSON]" + JSON.stringify(findings) + "[/REVIEW_FINDINGS_JSON]\\n[/REVIEW_FAIL]");
}

// ── PASS-FIRST scenarios ──
if (prompt.includes("pass-first")) {
  // Orchestrated loop: implement phase (no review markers)
  if (!prompt.includes("mode: review") && !prompt.includes("[review]") && !prompt.includes("independent code reviewer")) {
    out("Implementation complete for pass-first.");
  }
  // Review phase
  out("All checks pass.\\n\\n[REVIEW_PASS]\\nCode quality excellent.");
}

// ── LEGACY review (plain, no flags) ──
if (prompt.includes("legacy-plain-review")) {
  out("Legacy review done.\\n\\n[REVIEW_PASS]\\nAll good.");
}

// ── Default fallback ──
out("Task completed.");
`;

fs.writeFileSync(mockClaudePath, mockClaudeScript, { mode: 0o755 });

// ── Task definitions ───────────────────────────────────────────────────────────

const SCOPE = { repoPath: mockRepoDir, branch: "agent/flag-combo-test" };

// COMBO 1: reviewLoop + requireReviewGate

// 1a: fail→pass (reviewLoop handles it, gate should be no-op)
const TASK_RL_GATE_PASS = {
  taskId: "fch-rl-gate-pass-001",
  mode: "review",
  reviewLoop: true,
  requireReviewGate: true,
  maxReviewIterations: 3,
  scope: SCOPE,
  instructions: "fail-then-pass: review auth module.",
  patchInstructions: "Fix all issues from review.",
};

// 1b: always-fail → escalated (loop exhausts, gate should be no-op)
const TASK_RL_GATE_FAIL = {
  taskId: "fch-rl-gate-fail-001",
  mode: "review",
  reviewLoop: true,
  requireReviewGate: true,
  maxReviewIterations: 2,
  scope: SCOPE,
  instructions: "always-fail: review rendering module.",
  patchInstructions: "Fix XSS issues.",
};

// COMBO 2: isolatedReview + reviewLoop

// 2a: fail→pass with isolation
const TASK_ISO_RL_PASS = {
  taskId: "fch-iso-rl-pass-001",
  mode: "review",
  reviewLoop: true,
  isolatedReview: true,
  maxReviewIterations: 3,
  scope: SCOPE,
  instructions: "fail-then-pass: THIS SHOULD NOT LEAK INTO ISOLATED REVIEW.",
  patchInstructions: "Fix all issues from review.",
};

// 2b: always-fail with isolation
const TASK_ISO_RL_FAIL = {
  taskId: "fch-iso-rl-fail-001",
  mode: "review",
  reviewLoop: true,
  isolatedReview: true,
  maxReviewIterations: 2,
  scope: SCOPE,
  instructions: "always-fail: THIS SHOULD NOT LEAK INTO ISOLATED REVIEW.",
  patchInstructions: "Fix issues.",
};

// COMBO 3: triple flag — isolatedReview + requireReviewGate + reviewLoop

// 3a: pass
const TASK_TRIPLE_PASS = {
  taskId: "fch-triple-pass-001",
  mode: "review",
  reviewLoop: true,
  isolatedReview: true,
  requireReviewGate: true,
  maxReviewIterations: 3,
  scope: SCOPE,
  instructions: "fail-then-pass: TRIPLE FLAG LEAK TEST.",
  patchInstructions: "Fix all issues.",
};

// 3b: always-fail
const TASK_TRIPLE_FAIL = {
  taskId: "fch-triple-fail-001",
  mode: "review",
  reviewLoop: true,
  isolatedReview: true,
  requireReviewGate: true,
  maxReviewIterations: 2,
  scope: SCOPE,
  instructions: "always-fail: TRIPLE FLAG LEAK TEST.",
  patchInstructions: "Fix issues.",
};

// REGRESSION: legacy plain review (no flags)
const TASK_LEGACY = {
  taskId: "fch-legacy-001",
  mode: "review",
  scope: SCOPE,
  instructions: "legacy-plain-review: review code quality.",
};

// REGRESSION: orchestrated loop + pass
const TASK_ORCH_PASS = {
  taskId: "fch-orch-pass-001",
  mode: "implement",
  orchestratedLoop: true,
  maxReviewIterations: 3,
  scope: SCOPE,
  instructions: "pass-first: implement and review.",
};

// ── State ──────────────────────────────────────────────────────────────────────

let pullCount = 0;
let receivedResults = [];
let receivedEvents = [];
let worker = null;

function color(code, text) { return `\x1b[${code}m${text}\x1b[0m`; }

// ── Pull sequence ──────────────────────────────────────────────────────────────

const PULL_SEQUENCE = [
  TASK_RL_GATE_PASS,
  TASK_RL_GATE_FAIL,
  TASK_ISO_RL_PASS,
  TASK_ISO_RL_FAIL,
  TASK_TRIPLE_PASS,
  TASK_TRIPLE_FAIL,
  TASK_LEGACY,
  TASK_ORCH_PASS,
];

// ── Mock orchestrator ──────────────────────────────────────────────────────────

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
        console.log(color(36, `\n[orch] -> pull ${pullCount}: ${task.taskId}`));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, task }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      // finish triggered by result count, not by timer
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
      const sc = result.status === "review_pass" ? 32
        : result.status === "escalated" ? 35
        : result.status === "review_fail" ? 31 : 37;
      console.log(color(sc, `[orch] <- result: ${result.taskId} status=${result.status} gateEnforced=${result.meta?.reviewGateEnforced || false} isolatedRun=${result.meta?.isolatedRun || false}`));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      if (receivedResults.length >= PULL_SEQUENCE.length) {
        process.nextTick(() => finish());
      }
      return;
    }

    res.writeHead(404);
    res.end("not found");
  });
});

// ── Assertions ─────────────────────────────────────────────────────────────────

let _finished = false;
function finish() {
  if (_finished) return;
  _finished = true;
  console.log(color(36, "\n" + "=".repeat(70)));
  console.log(color(36, "TEST RESULTS — Flag-Combination Hardening"));
  console.log(color(36, "=".repeat(70)));

  const byTask = {};
  for (const r of receivedResults) byTask[r.taskId] = r;

  const eventsByTask = {};
  for (const e of receivedEvents) {
    if (!eventsByTask[e.taskId]) eventsByTask[e.taskId] = [];
    eventsByTask[e.taskId].push(e);
  }

  const checks = [];

  // ── COMBO 1: reviewLoop + requireReviewGate ──

  const r1a = byTask["fch-rl-gate-pass-001"];
  checks.push({
    name: "[rl+gate] fail->pass -> review_pass",
    pass: r1a && r1a.status === "review_pass",
    detail: r1a ? `status=${r1a.status}` : "no result",
  });
  checks.push({
    name: "[rl+gate] pass -> reviewIteration=2",
    pass: r1a && r1a.meta?.reviewIteration === 2,
    detail: r1a ? `iter=${r1a.meta?.reviewIteration}` : "no result",
  });
  checks.push({
    name: "[rl+gate] pass -> reviewGateEnforced NOT set (gate is no-op)",
    pass: r1a && !r1a.meta?.reviewGateEnforced,
    detail: r1a ? `gateEnforced=${r1a.meta?.reviewGateEnforced}` : "no result",
  });

  const r1b = byTask["fch-rl-gate-fail-001"];
  checks.push({
    name: "[rl+gate] always-fail -> escalated",
    pass: r1b && r1b.status === "escalated",
    detail: r1b ? `status=${r1b.status}` : "no result",
  });
  checks.push({
    name: "[rl+gate] always-fail -> reviewIteration=2",
    pass: r1b && r1b.meta?.reviewIteration === 2,
    detail: r1b ? `iter=${r1b.meta?.reviewIteration}` : "no result",
  });
  checks.push({
    name: "[rl+gate] always-fail -> reviewGateEnforced NOT set",
    pass: r1b && !r1b.meta?.reviewGateEnforced,
    detail: r1b ? `gateEnforced=${r1b.meta?.reviewGateEnforced}` : "no result",
  });
  checks.push({
    name: "[rl+gate] always-fail -> escalationReason present",
    pass: r1b && typeof r1b.meta?.escalationReason === "string" && r1b.meta.escalationReason.length > 0,
    detail: r1b ? `reason="${r1b.meta?.escalationReason}"` : "no result",
  });

  // ── COMBO 2: isolatedReview + reviewLoop ──

  const r2a = byTask["fch-iso-rl-pass-001"];
  checks.push({
    name: "[iso+rl] fail->pass -> review_pass",
    pass: r2a && r2a.status === "review_pass",
    detail: r2a ? `status=${r2a.status}` : "no result",
  });
  checks.push({
    name: "[iso+rl] pass -> isolatedRun=true",
    pass: r2a && r2a.meta?.isolatedRun === true,
    detail: r2a ? `isolatedRun=${r2a.meta?.isolatedRun}` : "no result",
  });
  checks.push({
    name: "[iso+rl] pass -> reviewPacketHash present",
    pass: r2a && typeof r2a.meta?.reviewPacketHash === "string" && r2a.meta.reviewPacketHash.length === 64,
    detail: r2a ? `hash=${(r2a.meta?.reviewPacketHash || "").slice(0, 16)}...` : "no result",
  });
  checks.push({
    name: "[iso+rl] pass -> reviewIteration=2",
    pass: r2a && r2a.meta?.reviewIteration === 2,
    detail: r2a ? `iter=${r2a.meta?.reviewIteration}` : "no result",
  });

  const r2b = byTask["fch-iso-rl-fail-001"];
  checks.push({
    name: "[iso+rl] always-fail -> escalated",
    pass: r2b && r2b.status === "escalated",
    detail: r2b ? `status=${r2b.status}` : "no result",
  });
  checks.push({
    name: "[iso+rl] always-fail -> isolatedRun=true",
    pass: r2b && r2b.meta?.isolatedRun === true,
    detail: r2b ? `isolatedRun=${r2b.meta?.isolatedRun}` : "no result",
  });

  // ── COMBO 3: triple flag ──

  const r3a = byTask["fch-triple-pass-001"];
  checks.push({
    name: "[triple] fail->pass -> review_pass",
    pass: r3a && r3a.status === "review_pass",
    detail: r3a ? `status=${r3a.status}` : "no result",
  });
  checks.push({
    name: "[triple] pass -> isolatedRun=true",
    pass: r3a && r3a.meta?.isolatedRun === true,
    detail: r3a ? `isolatedRun=${r3a.meta?.isolatedRun}` : "no result",
  });
  checks.push({
    name: "[triple] pass -> reviewGateEnforced NOT set",
    pass: r3a && !r3a.meta?.reviewGateEnforced,
    detail: r3a ? `gateEnforced=${r3a.meta?.reviewGateEnforced}` : "no result",
  });
  checks.push({
    name: "[triple] pass -> reviewIteration=2",
    pass: r3a && r3a.meta?.reviewIteration === 2,
    detail: r3a ? `iter=${r3a.meta?.reviewIteration}` : "no result",
  });
  checks.push({
    name: "[triple] pass -> reviewPacketHash present",
    pass: r3a && typeof r3a.meta?.reviewPacketHash === "string" && r3a.meta.reviewPacketHash.length === 64,
    detail: r3a ? `hash=${(r3a.meta?.reviewPacketHash || "").slice(0, 16)}...` : "no result",
  });

  const r3b = byTask["fch-triple-fail-001"];
  checks.push({
    name: "[triple] always-fail -> escalated",
    pass: r3b && r3b.status === "escalated",
    detail: r3b ? `status=${r3b.status}` : "no result",
  });
  checks.push({
    name: "[triple] always-fail -> isolatedRun=true",
    pass: r3b && r3b.meta?.isolatedRun === true,
    detail: r3b ? `isolatedRun=${r3b.meta?.isolatedRun}` : "no result",
  });
  checks.push({
    name: "[triple] always-fail -> reviewGateEnforced NOT set",
    pass: r3b && !r3b.meta?.reviewGateEnforced,
    detail: r3b ? `gateEnforced=${r3b.meta?.reviewGateEnforced}` : "no result",
  });
  checks.push({
    name: "[triple] always-fail -> escalationReason present",
    pass: r3b && typeof r3b.meta?.escalationReason === "string" && r3b.meta.escalationReason.length > 0,
    detail: r3b ? `reason="${r3b.meta?.escalationReason}"` : "no result",
  });

  // ── REGRESSION: legacy plain review ──

  const r9 = byTask["fch-legacy-001"];
  checks.push({
    name: "[legacy] plain review -> review_pass",
    pass: r9 && r9.status === "review_pass",
    detail: r9 ? `status=${r9.status}` : "no result",
  });
  checks.push({
    name: "[legacy] plain review -> no isolatedRun",
    pass: r9 && r9.meta?.isolatedRun === undefined,
    detail: r9 ? `isolatedRun=${r9.meta?.isolatedRun}` : "no result",
  });
  checks.push({
    name: "[legacy] plain review -> no reviewGateEnforced",
    pass: r9 && !r9.meta?.reviewGateEnforced,
    detail: r9 ? `gateEnforced=${r9.meta?.reviewGateEnforced}` : "no result",
  });

  // ── REGRESSION: orchestrated loop ──

  const r10 = byTask["fch-orch-pass-001"];
  checks.push({
    name: "[orch] orchestrated loop pass -> review_pass",
    pass: r10 && r10.status === "review_pass",
    detail: r10 ? `status=${r10.status}` : "no result",
  });

  // ── EVENT CHECKS ──

  // Combo 1: review_loop_fail events emitted for fail->pass tasks
  const loopFailEvt1 = (eventsByTask["fch-rl-gate-pass-001"] || []).find(
    e => e.status === "review_loop_fail"
  );
  checks.push({
    name: "[rl+gate] review_loop_fail event emitted for first iteration",
    pass: !!loopFailEvt1,
    detail: loopFailEvt1 ? "found" : "not found",
  });

  // Combo 2: review_loop progress events for isolated review loop (review + patch phases)
  const loopProgressEvts2 = (eventsByTask["fch-iso-rl-pass-001"] || []).filter(
    e => e.status === "progress" && e.phase === "review_loop"
  );
  checks.push({
    name: "[iso+rl] review_loop progress events emitted (review+patch phases)",
    pass: loopProgressEvts2.length >= 2,
    detail: `count=${loopProgressEvts2.length}`,
  });

  // ── Print ──
  let passed = 0;
  let failed = 0;
  for (const c of checks) {
    const mark = c.pass ? color(32, "PASS") : color(31, "FAIL");
    console.log(`  ${mark}  ${c.name}`);
    if (!c.pass) console.log(color(31, `         -> ${c.detail}`));
    if (c.pass) passed++;
    else failed++;
  }

  console.log(color(36, "\n" + "-".repeat(70)));
  console.log(color(36, `Total: ${checks.length}  Passed: ${passed}  Failed: ${failed}`));
  console.log(color(36, "-".repeat(70)));

  cleanup();
  process.exit(failed > 0 ? 1 : 0);
}

// ── Cleanup ────────────────────────────────────────────────────────────────────

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

// ── Boot ────────────────────────────────────────────────────────────────────────

server.listen(0, () => {
  const PORT = server.address().port;
  console.log(color(36, `[orch] mock orchestrator on :${PORT}`));

  worker = spawn("node", [path.join(__dirname, "worker.js")], {
    env: {
      ...process.env,
      ORCH_BASE_URL: `http://127.0.0.1:${PORT}`,
      WORKER_TOKEN: "test-token",
      WORKER_ID: "test-fch-worker",
      POLL_INTERVAL_MS: "200",
      MAX_PARALLEL_WORKTREES: "1",
      CLAUDE_CMD: mockClaudePath,
      ALLOWED_REPOS: mockRepoDir,
      CLAUDE_TIMEOUT_MS: "30000",
      CLAUDE_BYPASS_PERMISSIONS: "true",
      REVIEW_MAX_ITERATIONS: "3",
      ORCHESTRATED_LOOP_ENABLED: "true",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  worker.stdout.on("data", (c) => {
    for (const line of c.toString().split("\n").filter(Boolean)) {
      try {
        const j = JSON.parse(line);
        if (j.level === "error" || j.level === "warn") {
          console.log(color(33, `[worker] ${j.level}: ${j.msg}`));
        }
      } catch {}
    }
  });
  worker.stderr.on("data", (c) => {
    process.stderr.write(color(33, `[worker:err] ${c}`));
  });
});

// Safety timeout
setTimeout(() => {
  console.log(color(31, "\n[TIMEOUT] test timed out after 90s"));
  cleanup();
  process.exit(1);
}, 90000);
