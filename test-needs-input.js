#!/usr/bin/env node
"use strict";

/**
 * Integration test: full needs_input → resume → completed cycle.
 *
 * Mocks the orchestrator API and uses dry_run mode to avoid spawning Claude.
 * The dry_run output is injected with a [NEEDS_INPUT] marker to simulate
 * Claude requesting user input.
 *
 * Usage: node test-needs-input.js
 */

const http = require("http");
const { spawn } = require("child_process");

let pullCount = 0;
let worker = null;
let receivedResults = [];
let receivedEvents = [];

// Phase 1: task that will trigger needs_input (dry_run with marker in instructions)
// We can't inject the marker in dry_run output directly, so we use a small trick:
// We'll spawn a mock "claude" script that outputs the marker.
const fs = require("fs");
const path = require("path");
const os = require("os");

// Create a mock claude CLI that outputs a NEEDS_INPUT marker
const mockClaudeDir = fs.mkdtempSync(path.join(os.tmpdir(), "mock-claude-"));
const mockClaudePath = path.join(mockClaudeDir, "claude");
const mockRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), "test-repo-ni-"));

// Initialize a git repo so checkout works
const { execSync } = require("child_process");
execSync("git init", { cwd: mockRepoDir, stdio: "ignore" });
execSync("git commit --allow-empty -m init", { cwd: mockRepoDir, stdio: "ignore" });

// Phase tracking: first run outputs NEEDS_INPUT, second run outputs completion
let claudeCallCount = 0;

const mockClaudeScript = `#!/usr/bin/env node
const prompt = process.argv[process.argv.indexOf("-p") + 1] || "";
const isResume = prompt.includes("Continuation");

if (isResume) {
  // Second call: task resumed with answer, complete successfully
  const result = {
    type: "result",
    subtype: "success",
    result: "Done! I used YAML format as requested. Created config.yaml with the app settings.",
    cost_usd: 0.02,
    duration_ms: 3000,
    is_error: false,
    num_turns: 2,
  };
  process.stdout.write(JSON.stringify(result));
  process.exit(0);
} else {
  // First call: need user input
  const result = {
    type: "result",
    subtype: "success",
    result: "I need to create a config file but I\\'m not sure which format you prefer.\\n\\n[NEEDS_INPUT]\\nquestion: Which config format should I use?\\noptions: YAML, JSON, TOML\\ncontext: The project has no existing config files\\n[/NEEDS_INPUT]",
    cost_usd: 0.01,
    duration_ms: 2000,
    is_error: false,
    num_turns: 1,
  };
  process.stdout.write(JSON.stringify(result));
  process.exit(0);
}
`;

fs.writeFileSync(mockClaudePath, mockClaudeScript, { mode: 0o755 });

const TASK_BASE = {
  taskId: "ni-test-001",
  mode: "implement",
  scope: { repoPath: mockRepoDir, branch: "agent/ni-test" },
  instructions: "Add a config file for the application.",
  constraints: ["no breaking changes"],
};

function color(code, text) {
  return `\x1b[${code}m${text}\x1b[0m`;
}

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

    // ── PULL ──
    if (req.url === "/api/worker/pull") {
      pullCount++;

      if (pullCount === 1) {
        // First pull: send original task
        console.log(color(36, "\n[orch] → sending task ni-test-001 (first run)"));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, task: { ...TASK_BASE } }));
        return;
      }

      if (pullCount === 2) {
        // Second pull: simulate user answering immediately (resume)
        console.log(color(35, "\n[orch] ★ simulating POST /api/task/resume with answer: 'Use YAML'"));
        console.log(color(36, "[orch] → sending resumed task with pendingAnswer"));
        const resumed = {
          ...TASK_BASE,
          question: "Which config format should I use?",
          pendingAnswer: "Use YAML",
        };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, task: resumed }));
        return;
      }

      // After that: no more tasks, begin shutdown
      console.log(color(33, "[orch] → no more tasks"));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, task: null }));

      // finish triggered by result count, not by timer
      return;
    }

    // ── EVENT ──
    if (req.url === "/api/worker/event") {
      const ev = JSON.parse(body);
      receivedEvents.push(ev);
      const statusColor = {
        claimed: 36, started: 36, progress: 33,
        needs_input: 35, completed: 32, failed: 31, timeout: 31,
      }[ev.status] || 37;
      console.log(color(statusColor, `[orch] ← event: ${ev.status}/${ev.phase} — ${ev.message}`));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // ── RESULT ──
    if (req.url === "/api/worker/result") {
      const result = JSON.parse(body);
      receivedResults.push(result);
      const statusColor = result.status === "completed" ? 32
        : result.status === "needs_input" ? 35 : 31;
      console.log(color(statusColor, `\n[orch] ← result: status=${result.status}`));
      if (result.meta?.question) {
        console.log(color(35, `[orch]    meta.question: ${result.meta.question}`));
        console.log(color(35, `[orch]    meta.options:  ${(result.meta.options || []).join(", ")}`));
        console.log(color(35, `[orch]    meta.context:  ${result.meta.context || ""}`));
      }
      if (result.question !== undefined) {
        console.log(color(35, `[orch]    top.question: ${result.question}`));
        console.log(color(35, `[orch]    top.options:  ${(result.options || []).join(", ")}`));
      }
      if (result.output?.stdout) {
        console.log(color(37, `[orch]    stdout:   ${result.output.stdout.slice(0, 200)}`));
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      if (receivedResults.length >= 2) {
        process.nextTick(() => finish());
      }
      return;
    }

    res.writeHead(404);
    res.end("not found");
  });
});

let resumedTask = null;

let _finished = false;
function finish() {
  if (_finished) return;
  _finished = true;
  console.log(color(36, "\n" + "=".repeat(60)));
  console.log(color(36, "TEST RESULTS"));
  console.log(color(36, "=".repeat(60)));

  const checks = [];

  // Check 1: first result is needs_input
  const r1 = receivedResults[0];
  checks.push({
    name: "First result status is needs_input",
    pass: r1 && r1.status === "needs_input",
    detail: r1 ? `status=${r1.status}` : "no result",
  });

  // Check 2: question extracted
  checks.push({
    name: "Question extracted from Claude output",
    pass: r1 && r1.meta?.question === "Which config format should I use?",
    detail: r1 ? `question="${r1.meta?.question}"` : "no result",
  });

  // Check 3: options extracted
  checks.push({
    name: "Options parsed correctly",
    pass: r1 && Array.isArray(r1.meta?.options) && r1.meta.options.length === 3,
    detail: r1 ? `options=${JSON.stringify(r1.meta?.options)}` : "no result",
  });

  // Check 4: second result is completed
  const r2 = receivedResults[1];
  checks.push({
    name: "Second result status is completed",
    pass: r2 && r2.status === "completed",
    detail: r2 ? `status=${r2.status}` : "no result",
  });

  // Check 5: needs_input event was sent
  const niEvent = receivedEvents.find((e) => e.status === "needs_input");
  checks.push({
    name: "needs_input event sent",
    pass: !!niEvent,
    detail: niEvent ? `phase=${niEvent.phase}, msg=${niEvent.message}` : "not found",
  });

  // Check 6: resume progress event was sent
  const resumeEvent = receivedEvents.find(
    (e) => e.status === "progress" && e.message?.includes("resumed")
  );
  checks.push({
    name: "Resume progress event sent",
    pass: !!resumeEvent,
    detail: resumeEvent ? `msg=${resumeEvent.message}` : "not found",
  });

  // Check 7: completed event after resume
  const completedEvents = receivedEvents.filter((e) => e.status === "completed");
  checks.push({
    name: "Completed event sent after resume",
    pass: completedEvents.length >= 1,
    detail: `count=${completedEvents.length}`,
  });

  // Check 8: full event sequence
  const statusSeq = receivedEvents.map((e) => `${e.status}/${e.phase}`);
  checks.push({
    name: "Event sequence includes full lifecycle",
    pass:
      statusSeq.includes("needs_input/claude") &&
      statusSeq.indexOf("needs_input/claude") < statusSeq.indexOf("completed/report"),
    detail: `sequence: ${statusSeq.join(" → ")}`,
  });

  // Check 9: top-level question in result body (regression for orchestrator compat)
  checks.push({
    name: "[regression] top-level question field in needs_input result body",
    pass: r1 && r1.question === "Which config format should I use?",
    detail: r1 ? `question="${r1.question}"` : "no result",
  });

  // Check 10: top-level options in result body
  checks.push({
    name: "[regression] top-level options field in needs_input result body",
    pass: r1 && Array.isArray(r1.options) && r1.options.length === 3,
    detail: r1 ? `options=${JSON.stringify(r1.options)}` : "no result",
  });

  // Check 11: needsInputAt present at top level
  checks.push({
    name: "[regression] top-level needsInputAt in needs_input result body",
    pass: r1 && typeof r1.needsInputAt === "string",
    detail: r1 ? `needsInputAt="${r1.needsInputAt}"` : "no result",
  });

  // Check 12: meta.question also preserved (backwards compat for Stage 1)
  checks.push({
    name: "[stage1-compat] meta.question still present",
    pass: r1 && r1.meta?.question === "Which config format should I use?",
    detail: r1 ? `meta.question="${r1.meta?.question}"` : "no result",
  });

  // Check 13: completed result has NO top-level question/options (not injected spuriously)
  checks.push({
    name: "[regression] completed result does not have spurious question field",
    pass: r2 && r2.question === undefined,
    detail: r2 ? `question=${JSON.stringify(r2.question)}` : "no result",
  });

  let allPass = true;
  for (const c of checks) {
    const icon = c.pass ? color(32, "PASS") : color(31, "FAIL");
    console.log(`  ${icon}  ${c.name}`);
    console.log(`         ${color(37, c.detail)}`);
    if (!c.pass) allPass = false;
  }

  console.log(color(36, "\n" + "=".repeat(60)));
  if (allPass) {
    console.log(color(32, "ALL CHECKS PASSED"));
  } else {
    console.log(color(31, "SOME CHECKS FAILED"));
  }
  console.log(color(36, "=".repeat(60) + "\n"));

  if (worker) worker.kill("SIGTERM");
  server.close();
  // Cleanup temp dirs
  try { fs.rmSync(mockClaudeDir, { recursive: true }); } catch {}
  try { fs.rmSync(mockRepoDir, { recursive: true }); } catch {}
  process.exit(allPass ? 0 : 1);
}

server.listen(0, () => {
  const PORT = server.address().port;
  console.log(color(36, `[orch] mock orchestrator on http://localhost:${PORT}`));
  console.log(color(36, `[orch] mock claude: ${mockClaudePath}`));
  console.log(color(36, `[orch] mock repo:   ${mockRepoDir}`));
  console.log(color(36, "[orch] spawning worker...\n"));

  worker = spawn("node", ["worker.js"], {
    cwd: __dirname,
    env: {
      ...process.env,
      ORCH_BASE_URL: `http://localhost:${PORT}`,
      WORKER_TOKEN: "test-token",
      WORKER_ID: "test-worker-ni",
      POLL_INTERVAL_MS: "2000",
      MAX_PARALLEL_WORKTREES: "1",
      CLAUDE_CMD: mockClaudePath,
      ALLOWED_REPOS: mockRepoDir,
      CLAUDE_TIMEOUT_MS: "30000",
      CLAUDE_BYPASS_PERMISSIONS: "false",
    },
    stdio: "inherit",
  });

  worker.on("close", (code) => {
    console.log(color(37, `\n[orch] worker exited with code ${code}`));
  });

  // Safety timeout
  setTimeout(() => {
    console.log(color(31, "\n[orch] TIMEOUT — test took too long, aborting"));
    if (worker) worker.kill("SIGKILL");
    server.close();
    process.exit(1);
  }, 60000);
});
