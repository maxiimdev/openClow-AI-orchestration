#!/usr/bin/env node
"use strict";

const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

// ── ENV ────────────────────────────────────────────────────────────────────────

function loadEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, "utf-8").split("\n");
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
}
loadEnv();

const CFG = {
  orchBaseUrl: required("ORCH_BASE_URL"),
  workerToken: required("WORKER_TOKEN"),
  workerId: process.env.WORKER_ID || "worker-default",
  pollIntervalMs: int("POLL_INTERVAL_MS", 5000),
  claudeCmd: process.env.CLAUDE_CMD || "claude",
  allowedRepos: (process.env.ALLOWED_REPOS || "")
    .split(",")
    .map((p) => path.resolve(p.trim()))
    .filter(Boolean),
  claudeTimeoutMs: int("CLAUDE_TIMEOUT_MS", 180000),
  claudeBypassPermissions:
    (process.env.CLAUDE_BYPASS_PERMISSIONS || "true").toLowerCase() === "true",
  claudeModel: process.env.CLAUDE_MODEL || "sonnet",
  needsInputDebug:
    (process.env.NEEDS_INPUT_DEBUG || "false").toLowerCase() === "true",
  heartbeatIntervalMs: int("HEARTBEAT_INTERVAL_MS", 90000),
};

const STDOUT_LIMIT = 200 * 1024;
const STDERR_LIMIT = 200 * 1024;
const BRANCH_RE = /^(agent|hotfix|feature|bugfix)\/[a-zA-Z0-9._-]+$/;
const BLOCKED_BRANCHES = new Set(["main", "master"]);
const ALLOWED_MODELS = new Set(["sonnet", "opus"]);
const NEEDS_INPUT_RE = /\[NEEDS_INPUT\]([\s\S]*?)\[\/NEEDS_INPUT\]/;
const REVIEW_PASS_RE = /\[REVIEW_PASS\]/i;
const REVIEW_FAIL_RE = /\[REVIEW_FAIL(?:\s+severity=([^\]]+))?\]([\s\S]*?)\[\/REVIEW_FAIL\]/i;

function required(key) {
  const v = process.env[key];
  if (!v) {
    console.error(`[FATAL] missing env: ${key}`);
    process.exit(1);
  }
  return v;
}

function int(key, fallback) {
  const v = process.env[key];
  return v ? parseInt(v, 10) : fallback;
}

// ── LOGGING ────────────────────────────────────────────────────────────────────

function log(level, msg, meta = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    worker: CFG.workerId,
    msg,
    ...meta,
  };
  console.log(JSON.stringify(entry));
}

function niDebug(msg, meta = {}) {
  if (!CFG.needsInputDebug) return;
  log("debug", `[ni] ${msg}`, meta);
}

// ── HTTP (native fetch, Node 18+) ──────────────────────────────────────────────

async function apiPost(endpoint, body) {
  const url = `${CFG.orchBaseUrl}${endpoint}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${CFG.workerToken}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

// ── EVENTS ──────────────────────────────────────────────────────────────────

async function sendEvent(task, status, phase, message, meta) {
  try {
    await apiPost("/api/worker/event", {
      workerId: CFG.workerId,
      taskId: task.taskId,
      status,
      phase,
      message: (message || "").slice(0, 1000),
      meta: meta || {},
    });
  } catch (err) {
    log("warn", "sendEvent failed", {
      taskId: task.taskId,
      status,
      phase,
      err: err.message,
    });
  }
}

// ── VALIDATION ─────────────────────────────────────────────────────────────────

function validateTask(task) {
  const errors = [];

  if (!task.taskId) errors.push("missing taskId");
  if (!task.mode) errors.push("missing mode");

  const validModes = ["dry_run", "implement", "review", "tests"];
  if (task.mode && !validModes.includes(task.mode)) {
    errors.push(`invalid mode: ${task.mode}`);
  }

  if (task.scope) {
    const resolved = path.resolve(task.scope.repoPath || "");
    const allowed = CFG.allowedRepos.some(
      (r) => resolved === r || resolved.startsWith(r + path.sep)
    );
    if (!allowed) {
      errors.push(`repoPath not in allowlist: ${resolved}`);
    }

    const branch = task.scope.branch || "";
    if (BLOCKED_BRANCHES.has(branch)) {
      errors.push(`blocked branch: ${branch}`);
    }
    if (branch && !BRANCH_RE.test(branch)) {
      errors.push(`branch name rejected: ${branch}`);
    }
  } else if (task.mode !== "dry_run") {
    errors.push("missing scope for non-dry_run task");
  }

  if (task.model && !ALLOWED_MODELS.has(task.model)) {
    errors.push(`invalid model override: ${task.model} (allowed: ${[...ALLOWED_MODELS].join(", ")})`);
  }

  return errors;
}

// ── PROMPT BUILDER ─────────────────────────────────────────────────────────────

function buildPrompt(task) {
  const parts = [];

  parts.push(`# Task ${task.taskId} [${task.mode}]`);

  if (task.scope) {
    parts.push(`\nRepo: ${task.scope.repoPath}`);
    parts.push(`Branch: ${task.scope.branch}`);
  }

  if (task.instructions) {
    parts.push(`\n## Instructions\n${task.instructions}`);
  }

  if (task.constraints && task.constraints.length) {
    parts.push(`\n## Constraints`);
    for (const c of task.constraints) {
      parts.push(`- ${c}`);
    }
  }

  if (task.contextSnippets && task.contextSnippets.length) {
    parts.push(`\n## Context`);
    for (const s of task.contextSnippets) {
      const label = s.path || s.label || "snippet";
      parts.push(`\n### ${label}\n\`\`\`\n${s.content}\n\`\`\``);
    }
  }

  // Continuation after needs_input → resume
  if (task.pendingAnswer) {
    parts.push(`\n## Continuation — User Answer`);
    if (task.question) {
      parts.push(`Previous question: ${task.question}`);
    }
    parts.push(`Answer: ${task.pendingAnswer}`);
    parts.push(
      `\nContinue the task using the answer above. Pick up where you left off.`
    );
  }

  // Patch loop: inject previous review findings so Claude can address them
  if (task.previousReviewFindings) {
    parts.push(`\n## Review Findings`);
    parts.push(`The previous review identified the following issues that must be addressed:`);
    parts.push(task.previousReviewFindings);
  }

  return parts.join("\n");
}

// ── TRUNCATE ───────────────────────────────────────────────────────────────────

function truncate(str, limit) {
  if (Buffer.byteLength(str, "utf-8") <= limit) {
    return { text: str, truncated: false };
  }
  let buf = Buffer.from(str, "utf-8").subarray(0, limit);
  // avoid splitting a multi-byte char
  const text = buf.toString("utf-8");
  return { text: text + "\n[TRUNCATED]", truncated: true };
}

// ── NEEDS_INPUT PARSER ────────────────────────────────────────────────────────

function extractClaudeResult(stdout) {
  // Claude --output-format json may emit JSONL (multiple lines).
  // Scan backwards for the last object containing a "result" string field.
  const lines = stdout.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith("{")) continue;
    try {
      const obj = JSON.parse(line);
      if (typeof obj.result === "string") return obj.result;
    } catch { /* try next line */ }
  }
  // Whole-buffer attempt (single JSON object)
  try {
    const obj = JSON.parse(stdout);
    if (typeof obj.result === "string") return obj.result;
  } catch { /* not JSON */ }
  return null;
}

function normalizeOptions(raw) {
  if (raw == null) return null;
  if (Array.isArray(raw)) {
    const arr = raw.map(String).filter(Boolean);
    return arr.length ? arr : null;
  }
  if (typeof raw === "object") {
    const entries = Object.entries(raw);
    if (!entries.length) return null;
    return entries.map(([k, v]) => `${k}: ${v}`);
  }
  if (typeof raw === "string") {
    const arr = raw.split(",").map((s) => s.trim()).filter(Boolean);
    return arr.length ? arr : null;
  }
  return null;
}

function normalizePayload(obj, sourceType) {
  const q = typeof obj.question === "string" ? obj.question.trim() : "";
  return {
    question: q || "Clarification required",
    options: normalizeOptions(obj.options),
    context: typeof obj.context === "string"
      ? (obj.context.trim().slice(0, 1000) || null)
      : null,
    sourceType,
  };
}

function tryParseJsonAt(text, start) {
  let depth = 0;
  for (let j = start; j < text.length; j++) {
    if (text[j] === "{") depth++;
    else if (text[j] === "}") {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(text.slice(start, j + 1)); }
        catch { return null; }
      }
    }
  }
  return null;
}

function parseNeedsInput(stdout) {
  const text = extractClaudeResult(stdout) || stdout;

  // A. Strict marker: [NEEDS_INPUT]...[/NEEDS_INPUT]
  const strictMatch = text.match(NEEDS_INPUT_RE);
  if (strictMatch) {
    niDebug("step A matched: strict marker");
    const block = strictMatch[1];
    const question = (block.match(/^\s*question:\s*(.+)$/m) || [])[1]?.trim() || null;
    const optionsRaw = (block.match(/^\s*options:\s*(.+)$/m) || [])[1]?.trim() || null;
    const context = (block.match(/^\s*context:\s*(.+)$/m) || [])[1]?.trim() || null;
    return normalizePayload({ question, options: optionsRaw, context }, "strict");
  }

  // B. Fenced JSON block (```json ... ``` or ``` ... ```) with question key
  const fencedRe = /```(?:json)?\s*\n([\s\S]*?)```/g;
  let fm;
  while ((fm = fencedRe.exec(text)) !== null) {
    try {
      const obj = JSON.parse(fm[1]);
      if (obj && obj.question) {
        niDebug("step B matched: fenced json");
        return normalizePayload(obj, "fenced");
      }
    } catch { /* next fence */ }
  }

  // C. Plain JSON object in result text with question key
  const scanLimit = Math.min(text.length, 50000);
  for (let i = 0; i < scanLimit; i++) {
    if (text[i] !== "{") continue;
    const ahead = text.slice(i, i + 3000);
    if (!ahead.includes('"question"')) continue;
    const obj = tryParseJsonAt(text, i);
    if (obj && typeof obj.question === "string") {
      niDebug("step C matched: plain json");
      return normalizePayload(obj, "json");
    }
  }

  // D. Heuristic: NEEDS_INPUT token + question nearby
  if (/NEEDS_INPUT/i.test(text) && /question/i.test(text)) {
    niDebug("step D matched: heuristic");
    const qMatch = text.match(/question[:\s]+["']?([^"'\n]{5,})/i);
    const question = qMatch ? qMatch[1].trim().slice(0, 500) : null;
    return normalizePayload({ question, options: null, context: null }, "heuristic");
  }

  // E. AskUserQuestion tool in permission_denials (raw stdout, not result text)
  const auq = extractAskUserQuestion(stdout);
  if (auq) {
    niDebug("step E matched: ask_user_question");
    return auq;
  }

  niDebug("needs_input not detected in any step");
  return null;
}

function extractAskUserQuestion(stdout) {
  // Scan JSONL/JSON for objects containing permission_denials with AskUserQuestion.
  const lines = stdout.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith("{")) continue;
    try {
      const obj = JSON.parse(line);
      const found = _findAuqInObject(obj);
      if (found) return found;
    } catch { /* next line */ }
  }
  // Whole-buffer attempt
  try {
    const obj = JSON.parse(stdout);
    const found = _findAuqInObject(obj);
    if (found) return found;
  } catch { /* not JSON */ }
  return null;
}

function _findAuqInObject(obj) {
  const denials = obj.permission_denials;
  if (!Array.isArray(denials)) return null;
  for (const d of denials) {
    if (d.tool_name !== "AskUserQuestion") continue;
    niDebug("ask_user_question candidate found", {
      tool_name: d.tool_name,
      hasToolInput: !!d.tool_input,
    });
    const input = d.tool_input;
    if (!input || !Array.isArray(input.questions) || !input.questions.length) {
      niDebug("ask_user_question rejected: missing tool_input.questions");
      continue;
    }
    const q = input.questions[0];
    const question = typeof q.question === "string" ? q.question : null;
    if (!question) {
      niDebug("ask_user_question rejected: question field not a string");
      continue;
    }
    const options = _normalizeAuqOptions(q.options);
    return normalizePayload({ question, options, context: null }, "ask_user_question");
  }
  return null;
}

function _normalizeAuqOptions(options) {
  if (!Array.isArray(options) || !options.length) return null;
  return options.map((o) => {
    if (typeof o === "string") return o;
    if (o && typeof o === "object" && o.label) {
      return o.description ? `${o.label} — ${o.description}` : o.label;
    }
    return String(o);
  }).filter(Boolean);
}

// ── REVIEW VERDICT PARSER ─────────────────────────────────────────────────────

function parseReviewVerdict(stdout) {
  const text = extractClaudeResult(stdout) || stdout;

  if (REVIEW_PASS_RE.test(text)) {
    return { verdict: "pass" };
  }

  const failMatch = text.match(REVIEW_FAIL_RE);
  if (failMatch) {
    const severity = ((failMatch[1] || "major").trim()).toLowerCase();
    const findings = (failMatch[2] || "").trim().slice(0, 2000);
    return { verdict: "fail", severity, findings };
  }

  // No explicit verdict marker → conservative fail (review must explicitly pass)
  return {
    verdict: "fail",
    severity: "unknown",
    findings: "No [REVIEW_PASS] or [REVIEW_FAIL] marker found in review output.",
  };
}

// ── PLAN BUILDER ──────────────────────────────────────────────────────────────

function buildPlan(task) {
  const model = task.model || CFG.claudeModel;
  if (task.mode === "dry_run") {
    return ["validate", "report"];
  }
  const branch = task.scope?.branch || "branch";
  return [
    "validate",
    `checkout ${branch}`,
    `spawn claude (${model})`,
    "report",
  ];
}

// ── EXECUTE ────────────────────────────────────────────────────────────────────

async function executeTask(task, stepCtx) {
  const start = Date.now();
  const { gitStep = 2, claudeStep = 3, stepTotal = 4 } = stepCtx || {};

  const model = task.model || CFG.claudeModel;

  // dry_run: echo without running CLI
  if (task.mode === "dry_run") {
    const prompt = buildPrompt(task);
    return {
      status: "completed",
      output: {
        stdout: `[DRY RUN] would execute:\n\n${prompt}`,
        stderr: "",
        truncated: false,
      },
      meta: {
        durationMs: Date.now() - start,
        repoPath: task.scope?.repoPath || null,
        branch: task.scope?.branch || null,
        model,
      },
    };
  }

  const prompt = buildPrompt(task);
  const repoPath = path.resolve(task.scope.repoPath);

  // checkout branch
  await sendEvent(task, "progress", "git", `checking out branch ${task.scope.branch}`, {
    stepIndex: gitStep,
    stepTotal,
    path: repoPath,
    branch: task.scope.branch,
  });
  await gitCheckout(repoPath, task.scope.branch);

  await sendEvent(task, "progress", "claude", `spawning claude (model: ${model})`, {
    stepIndex: claudeStep,
    stepTotal,
    model,
    command: CFG.claudeCmd,
  });

  return new Promise((resolve) => {
    const args = [
      "-p", prompt,
      "--output-format", "json",
      "--model", model,
    ];

    if (CFG.claudeBypassPermissions) {
      args.push("--dangerously-skip-permissions");
    }

    log("info", "spawning claude", {
      taskId: task.taskId,
      mode: task.mode,
      repoPath,
      branch: task.scope.branch,
      args: args.filter((a) => a !== prompt),
    });

    const child = spawn(CFG.claudeCmd, args, {
      cwd: repoPath,
      shell: false,
      env: { ...process.env, CI: "1", CLAUDE_CODE_HEADLESS: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const pid = child.pid;
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    // Heartbeat: fire keepalive if no stdout/stderr for >heartbeatIntervalMs
    let heartbeatTimer = null;
    const scheduleHeartbeat = () => {
      clearTimeout(heartbeatTimer);
      heartbeatTimer = setTimeout(() => {
        const elapsedMs = Date.now() - start;
        sendEvent(
          task,
          "keepalive",
          "claude",
          `still running (${Math.round(elapsedMs / 1000)}s elapsed, step ${claudeStep}/${stepTotal})`,
          { elapsedMs, stepIndex: claudeStep, stepTotal }
        );
        scheduleHeartbeat(); // reschedule
      }, CFG.heartbeatIntervalMs);
    };
    scheduleHeartbeat();

    // Near-timeout risk event at 80% of the timeout threshold
    const nearTimeoutMs = Math.floor(CFG.claudeTimeoutMs * 0.8);
    const nearTimeoutTimer = setTimeout(() => {
      const elapsedMs = Date.now() - start;
      sendEvent(
        task,
        "risk",
        "claude",
        `near timeout: ${Math.round(elapsedMs / 1000)}s/${Math.round(CFG.claudeTimeoutMs / 1000)}s elapsed`,
        { elapsedMs, timeoutMs: CFG.claudeTimeoutMs, riskType: "near_timeout", stepIndex: claudeStep, stepTotal }
      );
    }, nearTimeoutMs);

    child.stdout.on("data", (chunk) => {
      scheduleHeartbeat(); // reset heartbeat countdown on activity
      if (Buffer.byteLength(stdout, "utf-8") < STDOUT_LIMIT) {
        stdout += chunk.toString();
      }
    });

    child.stderr.on("data", (chunk) => {
      scheduleHeartbeat(); // reset heartbeat countdown on activity
      if (Buffer.byteLength(stderr, "utf-8") < STDERR_LIMIT) {
        stderr += chunk.toString();
      }
    });

    const timer = setTimeout(() => {
      timedOut = true;
      sendEvent(task, "timeout", "claude", "claude process timed out", {
        stepIndex: claudeStep,
        stepTotal,
        timeoutMs: CFG.claudeTimeoutMs,
        elapsedMs: Date.now() - start,
      });
      log("warn", "timeout, sending SIGTERM", { taskId: task.taskId, pid });
      child.kill("SIGTERM");
      setTimeout(() => {
        log("warn", "escalating to SIGKILL", { taskId: task.taskId, pid });
        child.kill("SIGKILL");
      }, 5000);
    }, CFG.claudeTimeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      clearTimeout(heartbeatTimer);
      clearTimeout(nearTimeoutTimer);
      const durationMs = Date.now() - start;
      const outTrunc = truncate(stdout, STDOUT_LIMIT);
      const errTrunc = truncate(stderr, STDERR_LIMIT);

      const status = timedOut ? "timeout" : code === 0 ? "completed" : "failed";

      log("info", "claude exited", {
        taskId: task.taskId,
        exitCode: code,
        status,
        durationMs,
        pid,
      });

      // Risk event for non-zero exit
      if (!timedOut && code !== 0) {
        sendEvent(task, "risk", "claude", `claude exited with code ${code}`, {
          exitCode: code,
          riskType: "exit_failure",
          durationMs,
          stepIndex: claudeStep,
          stepTotal,
        });
      }

      resolve({
        status,
        output: {
          stdout: outTrunc.text,
          stderr: timedOut
            ? `[TIMEOUT after ${CFG.claudeTimeoutMs}ms]\n${errTrunc.text}`
            : errTrunc.text,
          truncated: outTrunc.truncated || errTrunc.truncated,
        },
        meta: {
          durationMs,
          repoPath,
          branch: task.scope.branch,
          exitCode: code,
          model,
        },
      });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      clearTimeout(heartbeatTimer);
      clearTimeout(nearTimeoutTimer);
      log("error", "spawn error", {
        taskId: task.taskId,
        err: err.message,
        pid,
      });
      resolve({
        status: "failed",
        output: {
          stdout: "",
          stderr: `spawn error: ${err.message}`,
          truncated: false,
        },
        meta: {
          durationMs: Date.now() - start,
          repoPath,
          branch: task.scope.branch,
          model,
        },
      });
    });
  });
}

// ── GIT ────────────────────────────────────────────────────────────────────────

function gitCheckout(cwd, branch) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["checkout", "-B", branch, "--"], {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15000,
    });
    let stderr = "";
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`git checkout failed (${code}): ${stderr.trim()}`));
    });
    child.on("error", reject);
  });
}

// ── MAIN LOOP ──────────────────────────────────────────────────────────────────

let shuttingDown = false;
let backoff = 0;
const BACKOFF_STEPS = [5000, 10000, 20000, 40000, 60000];

function nextBackoff() {
  const delay = BACKOFF_STEPS[Math.min(backoff, BACKOFF_STEPS.length - 1)];
  backoff++;
  return delay;
}

function resetBackoff() {
  backoff = 0;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function mainLoop() {
  log("info", "worker started", {
    allowedRepos: CFG.allowedRepos,
    pollIntervalMs: CFG.pollIntervalMs,
  });

  while (!shuttingDown) {
    let task = null;
    try {
      // ── PULL ──
      const pullRes = await apiPost("/api/worker/pull", {
        workerId: CFG.workerId,
      });

      resetBackoff();

      if (!pullRes.ok) {
        log("warn", "pull returned ok:false", { body: JSON.stringify(pullRes).slice(0, 300) });
        await sleep(CFG.pollIntervalMs);
        continue;
      }

      if (!pullRes.task) {
        log("debug", "no tasks");
        await sleep(CFG.pollIntervalMs);
        continue;
      }

      task = pullRes.task;
      log("info", "task received", { taskId: task.taskId, mode: task.mode });
      await sendEvent(task, "claimed", "pull", "task received");

      // ── RESUME CHECK ──
      if (task.pendingAnswer) {
        log("info", "task resumed with answer", {
          taskId: task.taskId,
          answer: task.pendingAnswer.slice(0, 200),
        });
        await sendEvent(task, "progress", "report", "task resumed with user input");
      }

      // ── VALIDATE ──
      await sendEvent(task, "started", "validate", "validating task");
      const errors = validateTask(task);
      if (errors.length) {
        log("error", "task validation failed", { taskId: task.taskId, errors });
        await sendEvent(task, "rejected", "validate", errors.join("; "));
        await apiPost("/api/worker/result", {
          workerId: CFG.workerId,
          taskId: task.taskId,
          status: "rejected",
          mode: task.mode,
          output: { stdout: "", stderr: errors.join("; "), truncated: false },
          meta: { durationMs: 0, repoPath: task.scope?.repoPath, branch: task.scope?.branch },
        }).catch((e) => log("error", "failed to report rejection", { err: e.message }));
        continue;
      }

      // ── PLAN + STEP TELEMETRY ──
      const plan = buildPlan(task);
      const stepTotal = plan.length;
      const gitStep = (plan.findIndex((s) => s.startsWith("checkout")) + 1) || 2;
      const claudeStep = (plan.findIndex((s) => s.startsWith("spawn claude")) + 1) || 3;
      await sendEvent(task, "progress", "plan", `steps: ${plan.join(" → ")}`, {
        stepIndex: 0,
        stepTotal,
        steps: plan,
      });
      await sendEvent(task, "progress", "validate", "validation passed", {
        stepIndex: 1,
        stepTotal,
      });

      // ── EXECUTE ──
      const result = await executeTask(task, { gitStep, claudeStep, stepTotal });

      // ── NEEDS_INPUT CHECK ──
      let ni = null;
      if (result.status === "completed") {
        ni = parseNeedsInput(result.output.stdout);

        // Debug: pre-decision introspection
        if (CFG.needsInputDebug) {
          const _hasPd = result.output.stdout.includes('"permission_denials"');
          const _hasAuq = result.output.stdout.includes('"AskUserQuestion"');
          log("debug", "[ni] pre-decision", {
            taskId: task.taskId,
            exitCode: result.meta.exitCode,
            hasPermissionDenials: _hasPd,
            hasAskUserQuestion: _hasAuq,
            parseNeedsInputFound: ni !== null,
            sourceType: ni?.sourceType || null,
            questionPreview: ni ? (ni.question || "").slice(0, 80) : null,
          });
        }

        if (ni) {
          result.status = "needs_input";
          result.meta.question = ni.question;
          result.meta.options = ni.options;
          result.meta.context = ni.context;
          result.meta.needsInputAt = new Date().toISOString();
          log("info", "needs_input detected", {
            taskId: task.taskId,
            sourceType: ni.sourceType,
            hasOptions: !!(ni.options && ni.options.length),
            questionPreview: (ni.question || "").slice(0, 100),
          });
        }
      }

      // Safety assert: if ni was found but status is still completed, force it
      if (ni && result.status === "completed") {
        log("error", "gating violation: needs_input detected but completed path chosen", {
          taskId: task.taskId,
          sourceType: ni.sourceType,
        });
        result.status = "needs_input";
      }

      // ── REVIEW GATE ──
      // For review mode, completed is never valid — must be review_pass or review_fail.
      if (task.mode === "review" && result.status === "completed") {
        const rv = parseReviewVerdict(result.output.stdout);
        result.meta.reviewVerdict = rv.verdict;
        if (rv.verdict === "pass") {
          result.status = "review_pass";
        } else {
          result.status = "review_fail";
          result.meta.reviewSeverity = rv.severity;
          result.meta.reviewFindings = rv.findings;
        }
        log("info", "review verdict parsed", {
          taskId: task.taskId,
          verdict: rv.verdict,
          severity: rv.severity || null,
        });
      }

      // Hard safety gate: if review mode still shows completed (should never happen),
      // force review_fail. Completion is impossible without an explicit REVIEW_PASS marker.
      if (task.mode === "review" && result.status === "completed") {
        log("error", "review-gate violation: completed status blocked for review mode", {
          taskId: task.taskId,
        });
        result.status = "review_fail";
        result.meta.reviewVerdict = "fail";
        result.meta.reviewSeverity = "unknown";
        result.meta.reviewFindings = "Review gate enforced: completed status not allowed for review mode tasks.";
      }

      log("info", "task done", {
        taskId: task.taskId,
        status: result.status,
        durationMs: result.meta.durationMs,
      });

      if (result.status === "needs_input") {
        await sendEvent(
          task, "needs_input", "claude",
          `needs input: ${result.meta.question || "(no question)"}`,
          result.meta
        );
      } else if (result.status === "review_pass") {
        await sendEvent(task, "review_pass", "report", "review passed", result.meta);
      } else if (result.status === "review_fail") {
        const sev = result.meta.reviewSeverity || "unknown";
        const summary = (result.meta.reviewFindings || "").slice(0, 200);
        await sendEvent(task, "review_fail", "report", `review failed (${sev}): ${summary}`, result.meta);
      } else if (result.status === "completed") {
        await sendEvent(task, "completed", "report", "task completed", result.meta);
      } else if (result.status === "timeout") {
        await sendEvent(task, "timeout", "claude", "claude process timed out", result.meta);
      } else {
        await sendEvent(task, "failed", "report", "task failed", result.meta);
      }

      // ── REPORT ──
      await sendEvent(task, "progress", "report", "reporting result", {
        stepIndex: stepTotal,
        stepTotal,
      });
      const resultBody = {
        workerId: CFG.workerId,
        taskId: task.taskId,
        status: result.status,
        mode: task.mode,
        output: result.output,
        meta: result.meta,
      };
      // For needs_input: hoist question/options/context to top-level so the
      // orchestrator can store them directly on task.question / task.options
      // without having to dig into meta. meta fields are preserved for compat.
      if (result.status === "needs_input") {
        resultBody.question = result.meta.question ?? null;
        resultBody.options = result.meta.options ?? null;
        resultBody.context = result.meta.context ?? null;
        resultBody.needsInputAt = result.meta.needsInputAt ?? null;
      }
      await apiPost("/api/worker/result", resultBody);

      resetBackoff();
    } catch (err) {
      const delay = nextBackoff();
      log("error", "loop error", { err: err.message, nextRetryMs: delay });
      if (task) {
        await sendEvent(task, "failed", "other", err.message);
      }
      await sleep(delay);
    }
  }

  log("info", "worker stopped");
}

// ── SHUTDOWN ───────────────────────────────────────────────────────────────────

function shutdown(signal) {
  log("info", `received ${signal}, shutting down`);
  shuttingDown = true;
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// ── START ──────────────────────────────────────────────────────────────────────

mainLoop().catch((err) => {
  log("fatal", "unexpected crash", { err: err.message });
  process.exit(1);
});
