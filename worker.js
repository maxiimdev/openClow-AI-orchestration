#!/usr/bin/env node
"use strict";

const { spawn } = require("child_process");
const crypto = require("crypto");
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
  claudeTimeoutMs: normalizeTimeoutMs(process.env.CLAUDE_TIMEOUT_MS),
  claudeBypassPermissions:
    (process.env.CLAUDE_BYPASS_PERMISSIONS || "true").toLowerCase() === "true",
  claudeModel: process.env.CLAUDE_MODEL || "sonnet",
  needsInputDebug:
    (process.env.NEEDS_INPUT_DEBUG || "false").toLowerCase() === "true",
  heartbeatIntervalMs: int("HEARTBEAT_INTERVAL_MS", 90000),
  reviewMaxIterations: int("REVIEW_MAX_ITERATIONS", 3),
  orchestratedLoopEnabled:
    (process.env.ORCHESTRATED_LOOP_ENABLED || "true").toLowerCase() === "true",
  // Stage 5: anti-hang & reliability
  leaseTtlMs: int("LEASE_TTL_MS", 300000),              // 5 min default lease
  leaseRenewIntervalMs: int("LEASE_RENEW_INTERVAL_MS", 60000), // renew every 60s
  maxRetries: int("MAX_RETRIES", 3),                     // transient error retries
  retryBackoffBaseMs: int("RETRY_BACKOFF_BASE_MS", 1000), // exponential backoff base
  dlqEnabled:
    (process.env.DLQ_ENABLED || "true").toLowerCase() === "true",
  idempotencyEnabled:
    (process.env.IDEMPOTENCY_ENABLED || "true").toLowerCase() === "true",
};

const STDOUT_LIMIT = 200 * 1024;
const STDERR_LIMIT = 200 * 1024;
const INLINE_OUTPUT_LIMIT = 8 * 1024; // 8KB inline cap for v2 result
const BRANCH_RE = /^(agent|hotfix|feature|bugfix)\/[a-zA-Z0-9._-]+$/;
const BLOCKED_BRANCHES = new Set(["main", "master"]);
const ALLOWED_MODELS = new Set(["sonnet", "opus"]);
// [NEEDS_INPUT] must start at the beginning of a line (not inline in prose).
const NEEDS_INPUT_ANCHORED_RE = /^[ \t]*\[NEEDS_INPUT\]([\s\S]*?)\[\/NEEDS_INPUT\]/m;
const REVIEW_PASS_RE = /\[REVIEW_PASS\]/i;
const REVIEW_FAIL_RE = /\[REVIEW_FAIL(?:\s+severity=([^\]]+))?\]([\s\S]*?)\[\/REVIEW_FAIL\]/i;
const REVIEW_FINDINGS_JSON_RE = /\[REVIEW_FINDINGS_JSON\]([\s\S]*?)\[\/REVIEW_FINDINGS_JSON\]/i;

// ── HARD REVIEW GATE ──────────────────────────────────────────────────────────
// State transition table: defines valid terminal statuses per mode.
// Tasks with requireReviewGate flag cannot reach "completed" without review_pass.
const VALID_TERMINAL_STATUSES = {
  dry_run:    new Set(["completed", "failed", "timeout", "rejected"]),
  implement:  new Set(["completed", "failed", "timeout", "rejected", "needs_input", "review_pass", "escalated"]),
  review:     new Set(["review_pass", "review_fail", "failed", "timeout", "rejected", "escalated", "needs_input"]),
  tests:      new Set(["completed", "failed", "timeout", "rejected"]),
};

// Statuses that are never allowed to bypass the review gate.
// If a task has requireReviewGate=true, "completed" is only allowed after review_pass.
const REVIEW_GATED_BLOCK = new Set(["completed"]);

function enforceReviewGate(task, result) {
  // Legacy tasks without requireReviewGate: no enforcement (backward compatible)
  if (!task.requireReviewGate) return result;

  // Review mode: completed is never valid (already handled by existing gate, but double-check)
  if (task.mode === "review" && result.status === "completed") {
    log("error", "review-gate-hard: completed blocked for review mode", { taskId: task.taskId });
    result.status = "review_fail";
    result.meta.reviewGateEnforced = true;
    result.meta.reviewGateReason = "completed status illegal for review mode with requireReviewGate";
    return result;
  }

  // Implement mode with review gate: completed only allowed if review was passed
  if (task.mode === "implement" && REVIEW_GATED_BLOCK.has(result.status)) {
    if (!result.meta.reviewVerdict || result.meta.reviewVerdict !== "pass") {
      log("error", "review-gate-hard: completed blocked — review not passed", {
        taskId: task.taskId,
        reviewVerdict: result.meta.reviewVerdict || "none",
      });
      result.status = "escalated";
      result.meta.reviewGateEnforced = true;
      result.meta.reviewGateReason = "completed blocked: review gate not passed";
      result.meta.escalationReason = result.meta.escalationReason || "review gate: task completed without review_pass";
      return result;
    }
  }

  // Validate against terminal status table
  const allowed = VALID_TERMINAL_STATUSES[task.mode];
  if (allowed && !allowed.has(result.status)) {
    log("error", "review-gate-hard: illegal terminal status", {
      taskId: task.taskId,
      mode: task.mode,
      status: result.status,
    });
    result.status = "failed";
    result.meta.reviewGateEnforced = true;
    result.meta.reviewGateReason = `illegal terminal status "${result.status}" for mode "${task.mode}"`;
    return result;
  }

  return result;
}

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

// Node.js setTimeout silently wraps delay values > 2^31-1 (~24.8 days) and fires
// immediately. normalizeTimeoutMs guards against overflow, invalid strings, and
// unreasonably small values so every setTimeout(fn, CFG.claudeTimeoutMs) call is safe.
function normalizeTimeoutMs(raw) {
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 180000; // default: 3 min
  if (parsed < 1000) return 1000;                             // min: 1 s
  if (parsed > 2147483647) return 2147483647;                 // Node safe max (2^31-1)
  return parsed;
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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── STAGE 5: TRANSIENT ERROR CLASSIFICATION ────────────────────────────────────

function isTransientError(err) {
  if (!err) return false;
  const msg = err.message || "";
  // Network-level errors
  if (/ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EAI_AGAIN|EPIPE|socket hang up/i.test(msg)) return true;
  // HTTP 5xx or 429 (rate limit)
  const httpMatch = msg.match(/HTTP (\d+)/);
  if (httpMatch) {
    const code = parseInt(httpMatch[1], 10);
    return code >= 500 || code === 429;
  }
  // fetch abort/timeout
  if (/aborted|timeout/i.test(msg) && !/CLAUDE_TIMEOUT/i.test(msg)) return true;
  return false;
}

// ── STAGE 5: IDEMPOTENCY ───────────────────────────────────────────────────────

function generateIdempotencyKey(taskId, endpoint, suffix) {
  const raw = `${taskId}:${endpoint}:${suffix || crypto.randomUUID()}`;
  return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 32);
}

// Per-task execution nonce — unique per pull+execute cycle.
// Used to dedup /result and /event calls for the same task execution.
let _currentExecutionNonce = null;

function getExecutionNonce(taskId) {
  if (!_currentExecutionNonce || _currentExecutionNonce.taskId !== taskId) {
    _currentExecutionNonce = { taskId, nonce: crypto.randomUUID() };
  }
  return _currentExecutionNonce.nonce;
}

function resetExecutionNonce() {
  _currentExecutionNonce = null;
}

// ── STAGE 5: DEAD-LETTER QUEUE ─────────────────────────────────────────────────

async function sendToDeadLetter(task, error, retryCount, context) {
  if (!CFG.dlqEnabled) {
    log("warn", "dlq-disabled: would have sent to DLQ", {
      taskId: task?.taskId, error: error?.message,
    });
    return;
  }
  const dlqPayload = {
    workerId: CFG.workerId,
    taskId: task?.taskId || "unknown",
    failureReason: error?.message || "unknown error",
    errorClass: isTransientError(error) ? "transient_exhausted" : "fatal",
    retryCount,
    lastError: {
      message: error?.message || null,
      stack: (error?.stack || "").slice(0, 2000),
    },
    taskSnapshot: task ? {
      mode: task.mode,
      taskId: task.taskId,
      scope: task.scope || null,
    } : null,
    context: context || null,
    dlqAt: new Date().toISOString(),
  };

  log("error", "dlq-transition", {
    taskId: dlqPayload.taskId,
    failureReason: dlqPayload.failureReason,
    errorClass: dlqPayload.errorClass,
    retryCount,
  });

  try {
    await apiPostRaw("/api/worker/dead-letter", dlqPayload);
  } catch (dlqErr) {
    log("error", "dlq-post-failed", {
      taskId: dlqPayload.taskId,
      err: dlqErr.message,
    });
  }
}

// ── STAGE 5: LEASE MANAGEMENT ──────────────────────────────────────────────────

let _leaseTimer = null;
let _leaseTaskId = null;
let _leaseExpired = false;

function startLeaseRenewal(taskId) {
  stopLeaseRenewal();
  _leaseTaskId = taskId;
  _leaseExpired = false;
  const renewMs = CFG.leaseRenewIntervalMs;
  const ttlMs = CFG.leaseTtlMs;

  log("info", "lease-start", { taskId, ttlMs, renewMs });

  _leaseTimer = setInterval(async () => {
    if (_leaseExpired) return;
    try {
      const res = await apiPostRaw("/api/worker/lease-renew", {
        workerId: CFG.workerId,
        taskId,
        leaseTtlMs: ttlMs,
      });
      if (res && res.expired) {
        _leaseExpired = true;
        log("warn", "lease-expired-server", { taskId });
        stopLeaseRenewal();
      } else {
        log("debug", "lease-renewed", { taskId });
      }
    } catch (err) {
      log("warn", "lease-renew-failed", { taskId, err: err.message });
    }
  }, renewMs);
}

function stopLeaseRenewal() {
  if (_leaseTimer) {
    clearInterval(_leaseTimer);
    _leaseTimer = null;
  }
  _leaseTaskId = null;
}

function isLeaseExpired() {
  return _leaseExpired;
}

// ── HTTP (native fetch, Node 18+) ──────────────────────────────────────────────

// Raw API post — no retry, no idempotency. Used by internal infra (lease, DLQ).
async function apiPostRaw(endpoint, body) {
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

async function apiPost(endpoint, body, opts = {}) {
  const maxRetries = opts.retries ?? CFG.maxRetries;
  const taskId = body?.taskId || "unknown";

  // Attach idempotency key for write endpoints
  if (CFG.idempotencyEnabled && !body._idempotencyKey) {
    const writeEndpoints = ["/api/worker/event", "/api/worker/result"];
    if (writeEndpoints.some((e) => endpoint.includes(e))) {
      const nonce = getExecutionNonce(taskId);
      const suffix = `${nonce}:${endpoint}:${body?.status || ""}:${body?.phase || ""}`;
      body._idempotencyKey = generateIdempotencyKey(taskId, endpoint, suffix);
    }
  }

  let lastErr = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const url = `${CFG.orchBaseUrl}${endpoint}`;
      const headers = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${CFG.workerToken}`,
      };
      if (body._idempotencyKey) {
        headers["Idempotency-Key"] = body._idempotencyKey;
      }
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
      }
      return res.json();
    } catch (err) {
      lastErr = err;
      if (attempt < maxRetries && isTransientError(err)) {
        const delayMs = CFG.retryBackoffBaseMs * Math.pow(2, attempt);
        log("warn", "api-retry", {
          endpoint,
          taskId,
          attempt: attempt + 1,
          maxRetries,
          delayMs,
          err: err.message,
        });
        await sleep(delayMs);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
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

  // orchestratedLoop requires implement or review mode (it contains both internally)
  if (task.orchestratedLoop && task.mode && !["implement", "review"].includes(task.mode)) {
    errors.push(`orchestratedLoop requires mode implement or review, got: ${task.mode}`);
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

// ── ARTIFACT PERSISTENCE (v2 result contract) ───────────────────────────────

const ARTIFACTS_DIR = path.join(__dirname, "data", "artifacts");

/**
 * Persist a string blob as an artifact file under data/artifacts/<taskId>/.
 * Returns artifact metadata object.
 */
function saveArtifact(taskId, name, kind, content) {
  const dir = path.join(ARTIFACTS_DIR, taskId);
  fs.mkdirSync(dir, { recursive: true });

  const buf = Buffer.from(content, "utf-8");
  const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, buf);

  const preview = content.slice(0, 512);

  return {
    name,
    kind,
    path: `data/artifacts/${taskId}/${name}`,
    bytes: buf.length,
    sha256,
    preview,
  };
}

/**
 * Build v2 result output: persist large stdout/stderr as artifact files,
 * truncate inline output to INLINE_OUTPUT_LIMIT (8KB).
 * Returns { output, artifacts } where output has inline-capped text and
 * artifacts is the metadata array.
 */
function buildV2Output(taskId, output) {
  const artifacts = [];
  let inlineStdout = output.stdout;
  let inlineStderr = output.stderr;
  let truncated = output.truncated;

  // Persist stdout as artifact if it exceeds inline cap
  if (Buffer.byteLength(output.stdout, "utf-8") > INLINE_OUTPUT_LIMIT) {
    const art = saveArtifact(taskId, "stdout.txt", "stdout", output.stdout);
    artifacts.push(art);
    const trunc = truncate(output.stdout, INLINE_OUTPUT_LIMIT);
    inlineStdout = trunc.text + `\n[full output: ${art.path}]`;
    truncated = true;
  }

  // Persist stderr as artifact if it exceeds inline cap
  if (Buffer.byteLength(output.stderr, "utf-8") > INLINE_OUTPUT_LIMIT) {
    const art = saveArtifact(taskId, "stderr.txt", "stderr", output.stderr);
    artifacts.push(art);
    const trunc = truncate(output.stderr, INLINE_OUTPUT_LIMIT);
    inlineStderr = trunc.text + `\n[full output: ${art.path}]`;
    truncated = true;
  }

  return {
    output: {
      stdout: inlineStdout,
      stderr: inlineStderr,
      truncated,
    },
    artifacts,
  };
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
  // isStructuredAsk requires BOTH a recognised source AND a non-empty question.
  // Without a real question the payload is informational, not an ask.
  const hasQuestion = q.length > 0;
  return {
    question: hasQuestion ? q : null,
    options: normalizeOptions(obj.options),
    context: typeof obj.context === "string"
      ? (obj.context.trim().slice(0, 1000) || null)
      : null,
    sourceType,
    isStructuredAsk: hasQuestion && (sourceType === "strict" || sourceType === "ask_user_question"),
  };
}

// Remove triple-backtick fenced blocks so that [NEEDS_INPUT] examples inside
// code fences are not mistakenly treated as real ask blocks.
function stripCodeFences(text) {
  return text.replace(/```[\s\S]*?```/g, "");
}

// Detect structured needs_input asks. Only two sources are accepted:
//   A. [NEEDS_INPUT]...[/NEEDS_INPUT] block — line-anchored, outside code fences,
//      with a non-empty question: field.
//   B. AskUserQuestion tool in permission_denials JSONL.
// Heuristic detection (fenced JSON, plain JSON scan, token proximity) has been
// removed — it caused false positives on implement/review tasks whose output
// mentioned NEEDS_INPUT or contained JSON with "question" keys in prose/reports.
function parseNeedsInput(stdout) {
  const text = extractClaudeResult(stdout) || stdout;

  // A. Strict marker: [NEEDS_INPUT]...[/NEEDS_INPUT]
  // Requirements to count as a real ask block:
  //   1. [NEEDS_INPUT] must appear at the start of a line (not inline in prose).
  //   2. The marker must not be inside a triple-backtick code fence.
  //   3. The block must contain a non-empty `question:` field.
  const textNoFences = stripCodeFences(text);
  const strictMatch = textNoFences.match(NEEDS_INPUT_ANCHORED_RE);
  if (strictMatch) {
    const block = strictMatch[1];
    const question = (block.match(/^\s*question:\s*(.+)$/m) || [])[1]?.trim() || null;
    if (!question) {
      niDebug("step A: [NEEDS_INPUT] block found but no question field — ignoring (not an ask block)");
    } else {
      niDebug("step A matched: strict marker with non-empty question");
      const optionsRaw = (block.match(/^\s*options:\s*(.+)$/m) || [])[1]?.trim() || null;
      const context = (block.match(/^\s*context:\s*(.+)$/m) || [])[1]?.trim() || null;
      return normalizePayload({ question, options: optionsRaw, context }, "strict");
    }
  }

  // B. AskUserQuestion tool in permission_denials (raw stdout, not result text)
  const auq = extractAskUserQuestion(stdout);
  if (auq) {
    niDebug("step B matched: ask_user_question");
    return auq;
  }

  niDebug("needs_input not detected (strict-only detection)");
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
    const structuredFindings = parseStructuredFindings(stdout);
    return { verdict: "fail", severity, findings, structuredFindings };
  }

  // No explicit verdict marker → conservative fail (review must explicitly pass)
  return {
    verdict: "fail",
    severity: "unknown",
    findings: "No [REVIEW_PASS] or [REVIEW_FAIL] marker found in review output.",
    structuredFindings: null,
  };
}

// ── STRUCTURED FINDINGS PARSER ────────────────────────────────────────────────

// Parses structured JSON findings from the [REVIEW_FINDINGS_JSON] block.
// Schema per finding: { id, severity, file, issue, risk, required_fix, acceptance_check }
function parseStructuredFindings(stdout) {
  const text = extractClaudeResult(stdout) || stdout;
  const m = text.match(REVIEW_FINDINGS_JSON_RE);
  if (!m) return null;
  try {
    const arr = JSON.parse(m[1].trim());
    if (!Array.isArray(arr) || arr.length === 0) return null;
    const VALID_SEVERITIES = new Set(["critical", "major", "minor"]);
    const normalized = arr
      .filter((f) => f && typeof f === "object")
      .map((f) => ({
        id: String(f.id || ""),
        severity: VALID_SEVERITIES.has(f.severity) ? f.severity : "major",
        file: String(f.file || ""),
        issue: String(f.issue || ""),
        risk: String(f.risk || ""),
        required_fix: String(f.required_fix || ""),
        acceptance_check: String(f.acceptance_check || ""),
      }))
      .filter((f) => f.issue);
    return normalized.length ? normalized : null;
  } catch {
    return null;
  }
}

// Serialize findings for injection into the next patch prompt.
// Prefers structured JSON so patch Claude can parse each finding precisely.
function serializeFindings(rv, sf) {
  if (sf && sf.length > 0) {
    return JSON.stringify(sf, null, 2);
  }
  return (rv.findings || "No findings available.").slice(0, 2000);
}

// ── REVIEW LOOP HELPERS ───────────────────────────────────────────────────────

// Build an internal patch task derived from the review task's scope/context.
function buildPatchTask(reviewTask, findingsText, iteration) {
  const patchInstructions = reviewTask.patchInstructions
    || (reviewTask.instructions
      ? `Fix all issues identified in the review findings below. Original task context:\n${reviewTask.instructions}`
      : "Fix all issues identified in the review findings. Address every finding completely.");
  return {
    taskId: `${reviewTask.taskId}-patch-iter${iteration}`,
    mode: "implement",
    scope: reviewTask.scope,
    model: reviewTask.model,
    instructions: patchInstructions,
    constraints: reviewTask.constraints,
    contextSnippets: reviewTask.contextSnippets,
    previousReviewFindings: findingsText,
  };
}

// Get git diff for token-optimized review context.
function getGitDiff(repoPath) {
  return new Promise((resolve) => {
    const child = spawn("git", ["diff", "HEAD"], {
      cwd: repoPath,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10000,
    });
    let out = "";
    child.stdout.on("data", (c) => { if (out.length < 50000) out += c; });
    child.on("close", () => resolve(out.trim() || null));
    child.on("error", () => resolve(null));
  });
}

// Build a re-review task with token-optimized context (diff + iteration marker).
// The iteration marker lets the mock (and real) Claude distinguish re-reviews.
async function buildReviewTaskWithDiff(task, iteration) {
  const repoPath = path.resolve(task.scope.repoPath);
  const diff = await getGitDiff(repoPath).catch(() => null);
  const snippetContent = diff
    ? `Git diff (patch applied):\n${diff.slice(0, 10000)}`
    : `Re-review after patch (iteration ${iteration}). Focus on whether previously identified issues have been resolved.`;
  const diffSnippet = {
    label: `review-loop-context (iter ${iteration})`,
    content: snippetContent,
  };
  return {
    ...task,
    contextSnippets: [...(task.contextSnippets || []), diffSnippet],
  };
}

// ── STAGE 3: CLEAN-CONTEXT REVIEW ISOLATION ──────────────────────────────────

// Get list of changed files with status (A/M/D) via git diff.
function getChangedFiles(repoPath) {
  return new Promise((resolve) => {
    const child = spawn("git", ["diff", "--name-status", "HEAD"], {
      cwd: repoPath,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10000,
    });
    let out = "";
    child.stdout.on("data", (c) => { if (out.length < 50000) out += c; });
    child.on("close", () => {
      const files = out.trim().split("\n").filter(Boolean).map((line) => {
        const [status, ...rest] = line.split("\t");
        return { status: status.trim(), file: rest.join("\t").trim() };
      });
      resolve(files);
    });
    child.on("error", () => resolve([]));
  });
}

// Build an isolated review packet containing only what the reviewer needs.
// No implementer transcript, instructions, or conversational state leaks through.
async function buildReviewPacket(task, repoPath) {
  const [diff, changedFiles] = await Promise.all([
    getGitDiff(repoPath).catch(() => null),
    getChangedFiles(repoPath).catch(() => []),
  ]);

  const packet = {
    taskId: task.taskId,
    mode: "review",
    repoPath,
    branch: task.scope?.branch || "unknown",
    changedFiles,
    diff: (diff || "").slice(0, 30000),
    checklist: task.checklist || task.constraints || [
      "No regressions introduced",
      "Code correctness and logic errors",
      "Security vulnerabilities (OWASP top 10)",
      "Error handling coverage",
      "No dead code or debug artifacts",
    ],
    isolationInstruction: "You are an independent code reviewer. You must NOT assume any prior context, conversation history, or implementation intent. Evaluate the code changes purely on their technical merit. Be objective and unbiased. Do not infer or reconstruct the implementer's reasoning — review only what is present in the diff and repository state.",
    createdAt: new Date().toISOString(),
  };

  // Add iteration context for re-reviews
  if (task._reviewIteration && task._reviewIteration > 1) {
    packet.iterationContext = {
      iteration: task._reviewIteration,
      previousFindings: task.previousReviewFindings || null,
    };
  }

  return packet;
}

// Hash a review packet for telemetry proof of isolation.
function hashReviewPacket(packet) {
  const serialized = JSON.stringify(packet);
  return {
    hash: crypto.createHash("sha256").update(serialized).digest("hex"),
    size: Buffer.byteLength(serialized, "utf-8"),
  };
}

// Build a prompt from an isolated review packet (no task.instructions leak).
function buildIsolatedReviewPrompt(packet) {
  const parts = [];

  parts.push(`# Code Review [${packet.taskId}]`);
  parts.push(`\n${packet.isolationInstruction}`);
  parts.push(`\nRepo: ${packet.repoPath}`);
  parts.push(`Branch: ${packet.branch}`);

  if (packet.changedFiles.length > 0) {
    parts.push(`\n## Changed Files`);
    for (const f of packet.changedFiles) {
      parts.push(`- [${f.status}] ${f.file}`);
    }
  }

  if (packet.diff) {
    parts.push(`\n## Diff\n\`\`\`diff\n${packet.diff}\n\`\`\``);
  }

  if (packet.checklist && packet.checklist.length > 0) {
    parts.push(`\n## Review Checklist`);
    for (const item of packet.checklist) {
      parts.push(`- [ ] ${item}`);
    }
  }

  if (packet.iterationContext) {
    parts.push(`\n## Previous Review Findings (iteration ${packet.iterationContext.iteration})`);
    parts.push(`Verify whether the following issues from the prior review have been resolved:`);
    if (packet.iterationContext.previousFindings) {
      parts.push(packet.iterationContext.previousFindings);
    }
  }

  return parts.join("\n");
}

// Execute a review task in isolated mode: builds review packet, uses isolated prompt,
// adds telemetry proving no context leakage.
async function executeIsolatedReview(task, stepCtx) {
  const repoPath = path.resolve(task.scope.repoPath);
  const packet = await buildReviewPacket(task, repoPath);
  const { hash, size } = hashReviewPacket(packet);

  log("info", "isolated_review: built review packet", {
    taskId: task.taskId,
    reviewPacketHash: hash,
    reviewPacketSize: size,
    changedFilesCount: packet.changedFiles.length,
    hasDiff: !!packet.diff,
  });

  // Create a minimal task that carries ONLY the isolated prompt
  const isolatedTask = {
    taskId: task.taskId,
    mode: "review",
    scope: task.scope,
    model: task.model,
    // The prompt is built from the packet, not from task.instructions
    _isolatedPrompt: buildIsolatedReviewPrompt(packet),
  };

  const result = await executeTask(isolatedTask, stepCtx);

  // Inject telemetry fields proving isolation
  result.meta.isolatedRun = true;
  result.meta.reviewPacketHash = hash;
  result.meta.reviewPacketSize = size;
  result.meta.changedFilesCount = packet.changedFiles.length;

  return result;
}

// ── REVIEW LOOP ───────────────────────────────────────────────────────────────

// Runs the full review-patch-review loop for a task with reviewLoop:true.
// Returns a result object compatible with mainLoop expectations.
async function runReviewLoop(task, stepCtx) {
  const maxIter = Math.max(1, Math.min(task.maxReviewIterations || CFG.reviewMaxIterations, 10));
  const loopStart = Date.now();
  let currentFindings = null;
  let currentSF = null;
  let lastOutput = { stdout: "", stderr: "", truncated: false };
  let lastMeta = { repoPath: path.resolve(task.scope.repoPath), branch: task.scope.branch, model: task.model || CFG.claudeModel };

  log("info", "review_loop started", { taskId: task.taskId, maxIter });

  for (let iter = 1; iter <= maxIter; iter++) {

    // ── PATCH (iterations 2+: patch before re-review) ──
    if (currentFindings !== null) {
      const patchTask = buildPatchTask(task, currentFindings, iter);
      await sendEvent(task, "progress", "review_loop",
        `patch run (iteration ${iter}/${maxIter})`,
        { phase: "patch", iteration: iter, maxIter }
      );
      log("info", "review_loop: patch run", { taskId: task.taskId, iter, patchTaskId: patchTask.taskId });
      const patchResult = await executeTask(patchTask, stepCtx);
      lastOutput = patchResult.output;
      lastMeta = patchResult.meta;

      if (patchResult.status !== "completed") {
        log("warn", "review_loop: patch run did not complete", { taskId: task.taskId, iter, status: patchResult.status });
        return {
          status: "escalated",
          output: patchResult.output,
          meta: {
            ...patchResult.meta,
            reviewIteration: iter,
            reviewMaxIterations: maxIter,
            reviewFindings: currentFindings,
            structuredFindings: currentSF,
            escalationReason: `patch run ${patchResult.status} at iteration ${iter}`,
            reviewLoopDurationMs: Date.now() - loopStart,
          },
        };
      }
    }

    // ── REVIEW (fresh context, with diff on re-reviews) ──
    const reviewTaskBase2 = iter > 1
      ? await buildReviewTaskWithDiff(task, iter)
      : task;
    const reviewTask = { ...reviewTaskBase2 };
    // Stage 3 isolation fields — only set when isolatedReview is enabled
    if (task.isolatedReview) {
      reviewTask._reviewIteration = iter;
      reviewTask.previousReviewFindings = currentFindings;
    }
    await sendEvent(task, "progress", "review_loop",
      `review run (iteration ${iter}/${maxIter})`,
      { phase: "review", iteration: iter, maxIter, isolatedReview: !!task.isolatedReview }
    );
    log("info", "review_loop: review run", { taskId: task.taskId, iter, isolatedReview: !!task.isolatedReview });
    const reviewResult = task.isolatedReview
      ? await executeIsolatedReview(reviewTask, stepCtx)
      : await executeTask(reviewTask, stepCtx);
    lastOutput = reviewResult.output;
    lastMeta = reviewResult.meta;

    const rv = parseReviewVerdict(reviewResult.output.stdout);
    const sf = parseStructuredFindings(reviewResult.output.stdout);

    if (rv.verdict === "pass") {
      log("info", "review_loop: passed", { taskId: task.taskId, iter });
      return {
        status: "review_pass",
        output: reviewResult.output,
        meta: {
          ...reviewResult.meta,
          reviewVerdict: "pass",
          reviewIteration: iter,
          reviewMaxIterations: maxIter,
          reviewLoopDurationMs: Date.now() - loopStart,
        },
      };
    }

    // Review failed this iteration
    currentFindings = serializeFindings(rv, sf);
    currentSF = sf;

    if (iter >= maxIter) {
      // Max iterations exhausted → escalate
      log("warn", "review_loop: max iterations reached", { taskId: task.taskId, iter, maxIter });
      return {
        status: "escalated",
        output: reviewResult.output,
        meta: {
          ...reviewResult.meta,
          reviewVerdict: "fail",
          reviewSeverity: rv.severity,
          reviewFindings: rv.findings,
          structuredFindings: sf,
          reviewIteration: iter,
          reviewMaxIterations: maxIter,
          escalationReason: `max review iterations (${maxIter}) reached without passing`,
          reviewLoopDurationMs: Date.now() - loopStart,
        },
      };
    }

    // Emit intermediate fail event — loop will continue with a patch
    await sendEvent(task, "review_loop_fail", "report",
      `review failed (iter ${iter}/${maxIter}), severity=${rv.severity}`,
      {
        reviewVerdict: "fail",
        reviewSeverity: rv.severity,
        reviewFindings: (rv.findings || "").slice(0, 500),
        structuredFindings: sf,
        iteration: iter,
        maxIter,
      }
    );
    log("info", "review_loop: iteration failed, will patch", { taskId: task.taskId, iter, severity: rv.severity });
  }

  // Safety fallback (should not be reached)
  return {
    status: "escalated",
    output: lastOutput,
    meta: {
      ...lastMeta,
      reviewIteration: maxIter,
      reviewMaxIterations: maxIter,
      escalationReason: "loop exited unexpectedly",
      reviewLoopDurationMs: Date.now() - loopStart,
    },
  };
}

// ── ORCHESTRATED LOOP ─────────────────────────────────────────────────────────

// Emits a context_reset telemetry event to mark the start of a new Claude session.
async function emitContextReset(task, phase, iteration, maxIter) {
  await sendEvent(task, "context_reset", "orchestrate",
    `context reset — starting ${phase} (iter ${iteration}/${maxIter})`,
    { phase, iteration, maxIter, contextReset: true }
  );
}

// Full orchestrated loop: implement (fresh) → review (fresh) →
//   (if fail) patch (fresh) → re-review (fresh) → … until pass or max iterations → escalated.
// Each Claude invocation is a fully independent subprocess with no session carryover.
async function runOrchestratedLoop(task, stepCtx) {
  const maxIter = Math.max(1, Math.min(task.maxReviewIterations || CFG.reviewMaxIterations, 10));
  const loopStart = Date.now();

  log("info", "orchestrated_loop started", { taskId: task.taskId, maxIter });

  // ── Phase 1: IMPLEMENT (fresh context, new Claude session) ──
  await emitContextReset(task, "implement", 0, maxIter);
  await sendEvent(task, "progress", "orchestrate",
    "phase:implement — spawning fresh Claude session",
    { phase: "implement", stepIndex: 1, stepTotal: stepCtx.stepTotal || 4 }
  );

  const implTask = {
    ...task,
    mode: "implement",
    reviewLoop: false,
    orchestratedLoop: false,
  };
  const implResult = await executeTask(implTask, stepCtx);

  log("info", "orchestrated_loop: implement done", {
    taskId: task.taskId,
    status: implResult.status,
  });

  if (implResult.status !== "completed") {
    log("warn", "orchestrated_loop: implement did not complete", {
      taskId: task.taskId,
      status: implResult.status,
    });
    return {
      status: "escalated",
      output: implResult.output,
      meta: {
        ...implResult.meta,
        orchestratePhase: "implement",
        reviewIteration: 0,
        reviewMaxIterations: maxIter,
        escalationReason: `implement phase ${implResult.status}`,
        reviewLoopDurationMs: Date.now() - loopStart,
      },
    };
  }

  let currentFindings = null;
  let currentSF = null;

  for (let iter = 1; iter <= maxIter; iter++) {

    // ── Patch phase (iterations 2+: patch before re-review) ──
    if (currentFindings !== null) {
      const patchTask = buildPatchTask(task, currentFindings, iter);
      await emitContextReset(task, "patch", iter, maxIter);
      await sendEvent(task, "progress", "orchestrate",
        `phase:patch (iter ${iter}/${maxIter}) — spawning fresh Claude session`,
        { phase: "patch", iteration: iter, maxIter, contextReset: true }
      );
      log("info", "orchestrated_loop: patch run", { taskId: task.taskId, iter });
      const patchResult = await executeTask(patchTask, stepCtx);

      if (patchResult.status !== "completed") {
        log("warn", "orchestrated_loop: patch did not complete", {
          taskId: task.taskId,
          iter,
          status: patchResult.status,
        });
        return {
          status: "escalated",
          output: patchResult.output,
          meta: {
            ...patchResult.meta,
            orchestratePhase: "patch",
            reviewIteration: iter,
            reviewMaxIterations: maxIter,
            reviewFindings: currentFindings,
            structuredFindings: currentSF,
            escalationReason: `patch phase ${patchResult.status} at iteration ${iter}`,
            reviewLoopDurationMs: Date.now() - loopStart,
          },
        };
      }
    }

    // ── Review phase (fresh context, with diff on re-reviews) ──
    // Always override mode to "review" — the parent task may be mode:"implement".
    const reviewTaskBase = iter > 1
      ? await buildReviewTaskWithDiff(task, iter)
      : task;
    const reviewTask = {
      ...reviewTaskBase,
      mode: "review",
      reviewLoop: false,
      orchestratedLoop: false,
    };
    // Stage 3 isolation fields — only set when isolatedReview is enabled
    if (task.isolatedReview) {
      reviewTask._reviewIteration = iter;
      reviewTask.previousReviewFindings = currentFindings;
    }

    await emitContextReset(task, "review", iter, maxIter);
    await sendEvent(task, "progress", "orchestrate",
      `phase:review (iter ${iter}/${maxIter}) — spawning fresh Claude session`,
      { phase: "review", iteration: iter, maxIter, contextReset: true, isolatedReview: !!task.isolatedReview }
    );
    log("info", "orchestrated_loop: review run", { taskId: task.taskId, iter, isolatedReview: !!task.isolatedReview });
    const reviewResult = task.isolatedReview
      ? await executeIsolatedReview(reviewTask, stepCtx)
      : await executeTask(reviewTask, stepCtx);

    const rv = parseReviewVerdict(reviewResult.output.stdout);
    const sf = parseStructuredFindings(reviewResult.output.stdout);

    if (rv.verdict === "pass") {
      log("info", "orchestrated_loop: passed", { taskId: task.taskId, iter });
      return {
        status: "review_pass",
        output: reviewResult.output,
        meta: {
          ...reviewResult.meta,
          reviewVerdict: "pass",
          reviewIteration: iter,
          reviewMaxIterations: maxIter,
          orchestratePhase: "review",
          reviewLoopDurationMs: Date.now() - loopStart,
        },
      };
    }

    currentFindings = serializeFindings(rv, sf);
    currentSF = sf;

    if (iter >= maxIter) {
      log("warn", "orchestrated_loop: max iterations reached", {
        taskId: task.taskId,
        iter,
        maxIter,
      });
      return {
        status: "escalated",
        output: reviewResult.output,
        meta: {
          ...reviewResult.meta,
          reviewVerdict: "fail",
          reviewSeverity: rv.severity,
          reviewFindings: rv.findings,
          structuredFindings: sf,
          reviewIteration: iter,
          reviewMaxIterations: maxIter,
          orchestratePhase: "review",
          escalationReason: `max review iterations (${maxIter}) reached without passing`,
          reviewLoopDurationMs: Date.now() - loopStart,
        },
      };
    }

    // Emit intermediate fail event — loop will continue with a patch
    await sendEvent(task, "review_loop_fail", "report",
      `review failed (iter ${iter}/${maxIter}), severity=${rv.severity}`,
      {
        reviewVerdict: "fail",
        reviewSeverity: rv.severity,
        reviewFindings: (rv.findings || "").slice(0, 500),
        structuredFindings: sf,
        iteration: iter,
        maxIter,
      }
    );
    log("info", "orchestrated_loop: iteration failed, will patch", {
      taskId: task.taskId,
      iter,
      severity: rv.severity,
    });
  }

  // Safety fallback (should not be reached)
  return {
    status: "escalated",
    output: { stdout: "", stderr: "", truncated: false },
    meta: {
      reviewIteration: maxIter,
      reviewMaxIterations: maxIter,
      orchestratePhase: "unknown",
      escalationReason: "orchestrated loop exited unexpectedly",
      reviewLoopDurationMs: Date.now() - loopStart,
    },
  };
}

// ── PLAN BUILDER ──────────────────────────────────────────────────────────────

function buildPlan(task) {
  const model = task.model || CFG.claudeModel;
  if (task.mode === "dry_run") {
    return ["validate", "report"];
  }
  const branch = task.scope?.branch || "branch";
  if (task.orchestratedLoop) {
    const maxIter = task.maxReviewIterations || CFG.reviewMaxIterations;
    return [
      "validate",
      `checkout ${branch}`,
      `orchestrated_loop: implement→review[→patch→review]* (max ${maxIter} iters, model: ${model})`,
      "report",
    ];
  }
  if (task.reviewLoop && task.mode === "review") {
    const maxIter = task.maxReviewIterations || CFG.reviewMaxIterations;
    return [
      "validate",
      `checkout ${branch}`,
      `review_loop (max ${maxIter} iterations, model: ${model})`,
      "report",
    ];
  }
  const steps = [
    "validate",
    `checkout ${branch}`,
    `spawn claude (${model})`,
  ];
  if (task.requireReviewGate) steps.push("review_gate");
  steps.push("report");
  return steps;
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

  const prompt = task._isolatedPrompt || buildPrompt(task);
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

// ── WORKTREE ───────────────────────────────────────────────────────────────────

const WORKTREE_BASE_DIR = ".worktrees";

function worktreePath(repoPath, taskId) {
  return path.join(repoPath, WORKTREE_BASE_DIR, taskId);
}

function gitGetBaseCommit(cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["rev-parse", "HEAD"], {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10000,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`git rev-parse HEAD failed (${code}): ${stderr.trim()}`));
    });
    child.on("error", reject);
  });
}

async function createWorktree(repoPath, taskId, branch) {
  const wtPath = worktreePath(repoPath, taskId);
  // Ensure parent dir exists
  const parentDir = path.dirname(wtPath);
  if (!fs.existsSync(parentDir)) {
    fs.mkdirSync(parentDir, { recursive: true });
  }

  return new Promise((resolve, reject) => {
    const child = spawn("git", ["worktree", "add", "-B", branch, wtPath], {
      cwd: repoPath,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30000,
    });
    let stderr = "";
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (code) => {
      if (code === 0) resolve(wtPath);
      else reject(new Error(`git worktree add failed (${code}): ${stderr.trim()}`));
    });
    child.on("error", reject);
  });
}

async function removeWorktree(repoPath, taskId) {
  const wtPath = worktreePath(repoPath, taskId);
  try {
    await new Promise((resolve, reject) => {
      const child = spawn("git", ["worktree", "remove", "--force", wtPath], {
        cwd: repoPath,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 15000,
      });
      let stderr = "";
      child.stderr.on("data", (c) => (stderr += c));
      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`git worktree remove failed (${code}): ${stderr.trim()}`));
      });
      child.on("error", reject);
    });
  } catch (err) {
    // Failure-safe: log warning but do not crash
    log("warn", "worktree cleanup failed", { repoPath, taskId, err: err.message });
    // Fallback: try to remove directory manually
    try {
      if (fs.existsSync(wtPath)) {
        fs.rmSync(wtPath, { recursive: true, force: true });
      }
      // Prune stale worktree entries
      spawn("git", ["worktree", "prune"], {
        cwd: repoPath,
        shell: false,
        stdio: "ignore",
        timeout: 10000,
      });
    } catch (cleanupErr) {
      log("warn", "worktree fallback cleanup also failed", { repoPath, taskId, err: cleanupErr.message });
    }
  }
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

async function mainLoop() {
  log("info", "worker started", {
    allowedRepos: CFG.allowedRepos,
    pollIntervalMs: CFG.pollIntervalMs,
  });

  while (!shuttingDown) {
    let task = null;
    let worktreeInfo = null;
    let originalRepoPath = null;
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

      // Stage 5: reset execution nonce for idempotency and start lease
      resetExecutionNonce();
      getExecutionNonce(task.taskId);
      startLeaseRenewal(task.taskId);

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

      // ── WORKTREE SETUP ──
      originalRepoPath = task.scope?.repoPath;
      if (task.useWorktree && task.scope && task.scope.repoPath) {
        const baseRepo = path.resolve(task.scope.repoPath);
        try {
          const baseCommit = await gitGetBaseCommit(baseRepo);
          const wtPath = await createWorktree(baseRepo, task.taskId, task.scope.branch);
          worktreeInfo = {
            worktreePath: wtPath,
            branch: task.scope.branch,
            baseCommit,
            baseRepoPath: baseRepo,
          };
          // Override repoPath so executeTask runs inside the worktree
          task.scope.repoPath = wtPath;
          log("info", "worktree created", { taskId: task.taskId, wtPath, baseCommit, branch: task.scope.branch });
          await sendEvent(task, "progress", "worktree", `worktree created at ${wtPath}`, {
            worktreePath: wtPath,
            baseCommit,
            branch: task.scope.branch,
          });
        } catch (wtErr) {
          log("error", "worktree creation failed", { taskId: task.taskId, err: wtErr.message });
          await sendEvent(task, "failed", "worktree", `worktree creation failed: ${wtErr.message}`);
          await apiPost("/api/worker/result", {
            workerId: CFG.workerId,
            taskId: task.taskId,
            status: "failed",
            mode: task.mode,
            output: { stdout: "", stderr: `worktree creation failed: ${wtErr.message}`, truncated: false },
            meta: { durationMs: 0, repoPath: baseRepo, branch: task.scope.branch },
          }).catch((e) => log("error", "failed to report worktree failure", { err: e.message }));
          continue;
        }
      }

      // ── EXECUTE ──
      const stepCtxMain = { gitStep, claudeStep, stepTotal };
      let result;
      if (task.orchestratedLoop) {
        result = await runOrchestratedLoop(task, stepCtxMain);
      } else if (task.reviewLoop && task.mode === "review") {
        result = await runReviewLoop(task, stepCtxMain);
      } else if (task.isolatedReview && task.mode === "review") {
        result = await executeIsolatedReview(task, stepCtxMain);
      } else {
        result = await executeTask(task, stepCtxMain);
      }

      // Attach worktree metadata to result
      if (worktreeInfo) {
        result.meta.worktreePath = worktreeInfo.worktreePath;
        result.meta.baseCommit = worktreeInfo.baseCommit;
        result.meta.worktreeBranch = worktreeInfo.branch;
      }

      // ── LEASE CHECK (Stage 5) ──
      // If lease expired during execution, abort reporting — another worker may
      // have reclaimed this task. Log and move on.
      if (isLeaseExpired()) {
        log("warn", "lease-expired-abort", {
          taskId: task.taskId,
          status: result.status,
          msg: "lease expired during execution; skipping result report",
        });
        await sendEvent(task, "failed", "lease", "lease expired during execution — result discarded");
        stopLeaseRenewal();
        resetExecutionNonce();
        continue;
      }

      // ── NEEDS_INPUT CHECK ──
      // Only structured asks (explicit [NEEDS_INPUT] marker with question field,
      // or AskUserQuestion tool) can trigger needs_input. Heuristics removed.
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
            isStructuredAsk: ni?.isStructuredAsk || false,
            questionPreview: ni ? (ni.question || "").slice(0, 80) : null,
          });
        }

        if (ni && ni.isStructuredAsk && ni.question) {
          result.status = "needs_input";
          result.meta.question = ni.question;
          result.meta.options = ni.options;
          result.meta.context = ni.context;
          result.meta.needsInputAt = new Date().toISOString();
          log("info", "needs_input detected", {
            taskId: task.taskId,
            sourceType: ni.sourceType,
            isStructuredAsk: ni.isStructuredAsk,
            hasOptions: !!(ni.options && ni.options.length),
            questionPreview: (ni.question || "").slice(0, 100),
          });
        } else if (ni) {
          log("info", "needs_input candidate rejected: not a structured ask", {
            taskId: task.taskId,
            sourceType: ni.sourceType,
            isStructuredAsk: false,
          });
          ni = null; // clear so downstream gates don't fire
        }
      }

      // ── REVIEW GATE ──
      // For review mode, completed is never valid — must be review_pass or review_fail.
      // reviewLoop and orchestratedLoop tasks have already been handled above.
      if (task.mode === "review" && !task.reviewLoop && !task.orchestratedLoop && result.status === "completed") {
        const rv = parseReviewVerdict(result.output.stdout);
        result.meta.reviewVerdict = rv.verdict;
        if (rv.verdict === "pass") {
          result.status = "review_pass";
        } else {
          result.status = "review_fail";
          result.meta.reviewSeverity = rv.severity;
          result.meta.reviewFindings = rv.findings;
          result.meta.structuredFindings = rv.structuredFindings || null;
        }
        log("info", "review verdict parsed", {
          taskId: task.taskId,
          verdict: rv.verdict,
          severity: rv.severity || null,
        });
      }

      // Hard safety gate: if review mode (non-loop) still shows completed (should never happen),
      // force review_fail. Completion is impossible without an explicit REVIEW_PASS marker.
      if (task.mode === "review" && !task.reviewLoop && !task.orchestratedLoop && result.status === "completed") {
        log("error", "review-gate violation: completed status blocked for review mode", {
          taskId: task.taskId,
        });
        result.status = "review_fail";
        result.meta.reviewVerdict = "fail";
        result.meta.reviewSeverity = "unknown";
        result.meta.reviewFindings = "Review gate enforced: completed status not allowed for review mode tasks.";
      }

      // ── HARD REVIEW GATE (Stage 2) ──
      // Invariant: if task.requireReviewGate, enforce pipeline constraints.
      // Must run after all status transformations (needs_input, review verdict parsing).
      enforceReviewGate(task, result);
      if (result.meta.reviewGateEnforced) {
        await sendEvent(task, result.status, "review_gate",
          `review gate enforced: ${result.meta.reviewGateReason}`,
          { reviewGateEnforced: true, reviewGateReason: result.meta.reviewGateReason }
        );
      }

      log("info", "task done", {
        taskId: task.taskId,
        status: result.status,
        durationMs: result.meta.durationMs,
        reviewGateEnforced: result.meta.reviewGateEnforced || false,
      });

      if (result.status === "needs_input" && ni && ni.isStructuredAsk && ni.question) {
        await sendEvent(
          task, "needs_input", "claude",
          `needs input: ${result.meta.question || "(no question)"}`,
          result.meta
        );
      } else if (result.status === "needs_input") {
        // Defense-in-depth: status was set to needs_input but structured ask
        // validation failed at the event gate. Demote to completed to prevent
        // false notifications reaching Telegram/orchestrator.
        log("error", "needs_input event gate blocked: status was needs_input but ni guard failed", {
          taskId: task.taskId,
          niPresent: !!ni,
          isStructuredAsk: ni?.isStructuredAsk || false,
          question: ni?.question || null,
        });
        result.status = "completed";
        await sendEvent(task, "completed", "report", "task completed", result.meta);
      } else if (result.status === "review_pass") {
        const iterInfo = result.meta.reviewIteration
          ? ` (iter ${result.meta.reviewIteration}/${result.meta.reviewMaxIterations})`
          : "";
        await sendEvent(task, "review_pass", "report", `review passed${iterInfo}`, result.meta);
      } else if (result.status === "review_fail") {
        const sev = result.meta.reviewSeverity || "unknown";
        const summary = (result.meta.reviewFindings || "").slice(0, 200);
        await sendEvent(task, "review_fail", "report", `review failed (${sev}): ${summary}`, result.meta);
      } else if (result.status === "escalated") {
        const iter = result.meta.reviewIteration || "?";
        const maxIter = result.meta.reviewMaxIterations || "?";
        const reason = result.meta.escalationReason || "max iterations reached";
        await sendEvent(task, "escalated", "report",
          `review loop escalated after ${iter}/${maxIter} iterations: ${reason}`,
          result.meta
        );
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
      // Build v2 result: persist artifacts + truncate inline output
      const v2 = buildV2Output(task.taskId, result.output);
      const resultBody = {
        resultVersion: 2,
        workerId: CFG.workerId,
        taskId: task.taskId,
        status: result.status,
        mode: task.mode,
        output: v2.output,
        artifacts: v2.artifacts,
        meta: result.meta,
      };
      // For needs_input: hoist question/options/context to top-level so the
      // orchestrator can store them directly on task.question / task.options
      // without having to dig into meta. meta fields are preserved for compat.
      if (result.status === "needs_input" && ni && ni.isStructuredAsk) {
        resultBody.question = result.meta.question ?? null;
        resultBody.options = result.meta.options ?? null;
        resultBody.context = result.meta.context ?? null;
        resultBody.needsInputAt = result.meta.needsInputAt ?? null;
      }
      // For review_fail and escalated: hoist structuredFindings to top-level so the
      // orchestrator can pass them directly to the next patch task.
      if (result.status === "review_fail" || result.status === "escalated") {
        resultBody.structuredFindings = result.meta?.structuredFindings ?? null;
        resultBody.reviewFindings = result.meta?.reviewFindings ?? null;
      }
      await apiPost("/api/worker/result", resultBody);

      // ── WORKTREE CLEANUP ──
      if (worktreeInfo && !task.keepWorktree) {
        // Restore original repoPath before cleanup
        task.scope.repoPath = originalRepoPath;
        await removeWorktree(worktreeInfo.baseRepoPath, task.taskId);
        log("info", "worktree removed", { taskId: task.taskId, wtPath: worktreeInfo.worktreePath });
      } else if (worktreeInfo && task.keepWorktree) {
        log("info", "worktree kept (keepWorktree=true)", { taskId: task.taskId, wtPath: worktreeInfo.worktreePath });
      }

      // Stage 5: clean up lease + nonce
      stopLeaseRenewal();
      resetExecutionNonce();

      resetBackoff();
    } catch (err) {
      // Worktree cleanup on error
      if (worktreeInfo && !task.keepWorktree) {
        try { task.scope.repoPath = originalRepoPath; } catch (_) {}
        await removeWorktree(worktreeInfo.baseRepoPath, task.taskId).catch((wtErr) =>
          log("warn", "worktree cleanup failed in error handler", { err: wtErr.message })
        );
      }

      // Stage 5: stop lease on error
      stopLeaseRenewal();
      resetExecutionNonce();

      const delay = nextBackoff();
      log("error", "loop error", { err: err.message, nextRetryMs: delay });

      // Stage 5: DLQ for fatal errors (non-transient or exhausted retries)
      if (task && !isTransientError(err)) {
        log("error", "fatal-error-dlq", { taskId: task.taskId, err: err.message });
        await sendToDeadLetter(task, err, 0, "fatal error in main loop");
        await sendEvent(task, "failed", "dlq", `dead-lettered: ${err.message}`);
      } else if (task) {
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
