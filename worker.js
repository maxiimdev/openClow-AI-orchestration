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
  // Stage W2: parallel worktree slots
  maxParallelWorktrees: Math.max(1, int("MAX_PARALLEL_WORKTREES", 2)),
  // Stage W4: worktree operational reliability
  worktreeTtlMs: int("WORKTREE_TTL_MS", 3600000),                    // 1 hour default
  worktreeCleanupIntervalMs: int("WORKTREE_CLEANUP_INTERVAL_MS", 300000), // 5 min scan
  worktreeDiskThresholdBytes: int("WORKTREE_DISK_THRESHOLD_BYTES", 5 * 1024 * 1024 * 1024), // 5GB
  worktreeDiskHardStop: (process.env.WORKTREE_DISK_HARD_STOP || "false").toLowerCase() === "true",
  worktreeRecoveryEnabled: (process.env.WORKTREE_RECOVERY_ENABLED || "true").toLowerCase() === "true",
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
  implement:  new Set(["completed", "failed", "timeout", "rejected", "needs_input", "review_pass", "escalated", "needs_patch"]),
  review:     new Set(["review_pass", "review_fail", "failed", "timeout", "rejected", "escalated", "needs_input", "needs_patch"]),
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
// W2: nonces are per-slot to support concurrent tasks.
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

// ── STAGE W2: PER-SLOT CONTEXT ──────────────────────────────────────────────────
// Each parallel slot gets its own lease timer, execution nonce, and telemetry.

const _activeSlots = new Map(); // slotId → { taskId, promise }

function createSlotContext(slotId) {
  return {
    slotId,
    taskId: null,
    nonce: null,
    leaseTimer: null,
    leaseExpired: false,
  };
}

function slotGetNonce(ctx, taskId) {
  if (!ctx.nonce || ctx.taskId !== taskId) {
    ctx.taskId = taskId;
    ctx.nonce = crypto.randomUUID();
  }
  return ctx.nonce;
}

function slotResetNonce(ctx) {
  ctx.nonce = null;
  ctx.taskId = null;
}

function slotStartLease(ctx, taskId) {
  slotStopLease(ctx);
  ctx.leaseExpired = false;
  const renewMs = CFG.leaseRenewIntervalMs;
  const ttlMs = CFG.leaseTtlMs;

  log("info", "lease-start", { taskId, slotId: ctx.slotId, ttlMs, renewMs });

  ctx.leaseTimer = setInterval(async () => {
    if (ctx.leaseExpired) return;
    try {
      const res = await apiPostRaw("/api/worker/lease-renew", {
        workerId: CFG.workerId,
        taskId,
        leaseTtlMs: ttlMs,
      });
      if (res && res.expired) {
        ctx.leaseExpired = true;
        log("warn", "lease-expired-server", { taskId, slotId: ctx.slotId });
        slotStopLease(ctx);
      } else {
        log("debug", "lease-renewed", { taskId, slotId: ctx.slotId });
      }
    } catch (err) {
      log("warn", "lease-renew-failed", { taskId, slotId: ctx.slotId, err: err.message });
    }
  }, renewMs);
}

function slotStopLease(ctx) {
  if (ctx.leaseTimer) {
    clearInterval(ctx.leaseTimer);
    ctx.leaseTimer = null;
  }
}

function slotIsLeaseExpired(ctx) {
  return ctx.leaseExpired;
}

function getSlotTelemetry(slotId) {
  return {
    slotId,
    activeSlots: _activeSlots.size,
    totalSlots: CFG.maxParallelWorktrees,
  };
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

// ── STAGE W3: MERGE POLICY + SAFETY GATE ────────────────────────────────────────
// No worktree branch may reach merge_ready/completed unless quality gates pass.
// Gates: review (when requireReviewGate or reviewLoop), tests (when requireTestsGate).
// Conflict detection: checks merge-base divergence before allowing merge_ready.

const MERGE_GATE_STATUSES = new Set(["completed", "merge_ready"]);

function evaluateMergeGate(task, result) {
  // Only apply to worktree tasks with merge gate enabled
  if (!task.useWorktree || !task.mergePolicy) return result;

  const policy = task.mergePolicy; // { requireReview, requireTests, targetBranch }

  // Only gate statuses that would indicate "done/ready to merge"
  if (!MERGE_GATE_STATUSES.has(result.status)) return result;

  const gateFailures = [];

  // Gate 1: Review must have passed
  if (policy.requireReview) {
    const reviewPassed = result.meta.reviewVerdict === "pass" ||
                         result.status === "review_pass" ||
                         result.meta.mergeGateReviewOverride === true;
    if (!reviewPassed) {
      gateFailures.push("review_not_passed");
    }
  }

  // Gate 2: Tests must have passed
  if (policy.requireTests) {
    const testsPassed = result.meta.testsVerdict === "pass" ||
                        result.meta.mergeGateTestsOverride === true;
    if (!testsPassed) {
      gateFailures.push("tests_not_passed");
    }
  }

  if (gateFailures.length === 0) return result;

  // Gates failed: block merge-ready/completed
  const reason = gateFailures.join(", ");
  log("warn", "merge-gate-blocked", {
    taskId: task.taskId,
    originalStatus: result.status,
    gateFailures,
    reason,
  });

  result.meta.mergeGateBlocked = true;
  result.meta.gate_blocked_reason = reason;
  result.meta.mergeGateFailures = gateFailures;

  // Determine transition: needs_patch if review failed, escalated if tests failed
  if (gateFailures.includes("review_not_passed")) {
    result.status = "needs_patch";
  } else {
    result.status = "needs_patch";
  }

  return result;
}

// Conflict-aware merge prep: detect merge conflicts before merge-ready
function detectMergeConflict(repoPath, sourceBranch, targetBranch) {
  return new Promise((resolve) => {
    // Use git merge-tree to do a three-way merge check without touching the working tree
    // First get the merge base
    const child = spawn("git", ["merge-base", targetBranch, sourceBranch], {
      cwd: repoPath,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15000,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (code) => {
      if (code !== 0) {
        // Cannot determine merge base — likely no common ancestor
        resolve({ conflict: true, reason: `merge-base failed: ${stderr.trim() || "no common ancestor"}` });
        return;
      }
      const mergeBase = stdout.trim();
      // Now do a dry merge-tree check
      const mtChild = spawn("git", ["merge-tree", mergeBase, targetBranch, sourceBranch], {
        cwd: repoPath,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 15000,
      });
      let mtOut = "";
      mtChild.stdout.on("data", (c) => (mtOut += c));
      mtChild.on("close", (mtCode) => {
        // merge-tree outputs conflict markers if there are conflicts
        const hasConflict = mtOut.includes("<<<<<<") || mtOut.includes("changed in both");
        if (hasConflict) {
          resolve({ conflict: true, reason: "merge conflict detected in merge-tree output" });
        } else {
          resolve({ conflict: false, reason: null });
        }
      });
      mtChild.on("error", (err) => {
        resolve({ conflict: true, reason: `merge-tree error: ${err.message}` });
      });
    });
    child.on("error", (err) => {
      resolve({ conflict: true, reason: `merge-base error: ${err.message}` });
    });
  });
}

async function applyMergeConflictCheck(task, result, worktreeInfo) {
  // Only check for worktree tasks with merge policy and successful gates so far
  if (!task.useWorktree || !task.mergePolicy) return result;
  if (!worktreeInfo) return result;
  if (!MERGE_GATE_STATUSES.has(result.status) && result.status !== "review_pass") return result;

  const targetBranch = task.mergePolicy.targetBranch || "main";
  const sourceBranch = worktreeInfo.branch;

  try {
    const conflictResult = await detectMergeConflict(
      worktreeInfo.baseRepoPath,
      sourceBranch,
      targetBranch
    );
    result.meta.mergeConflictCheck = conflictResult.conflict ? "conflict" : "clean";

    if (conflictResult.conflict) {
      log("warn", "merge-conflict-detected", {
        taskId: task.taskId,
        sourceBranch,
        targetBranch,
        reason: conflictResult.reason,
      });
      result.meta.mergeGateBlocked = true;
      result.meta.gate_blocked_reason =
        (result.meta.gate_blocked_reason ? result.meta.gate_blocked_reason + ", " : "") +
        "merge_conflict";
      result.meta.mergeConflictReason = conflictResult.reason;
      result.status = "escalated";
      result.meta.escalationReason = `merge conflict: ${conflictResult.reason}`;
    }
  } catch (err) {
    log("warn", "merge-conflict-check-failed", {
      taskId: task.taskId,
      err: err.message,
    });
    // Non-fatal: do not block on conflict check failure
    result.meta.mergeConflictCheck = "error";
    result.meta.mergeConflictCheckError = err.message;
  }

  return result;
}

// ── STAGE W4: WORKTREE OPERATIONAL RELIABILITY ──────────────────────────────────
// TTL cleanup, crash recovery, and disk guardrails for worktrees.

let _worktreeCleanupTimer = null;
let _worktreeDiskBlocked = false;

// Track which taskIds are actively in-flight (set during processTask, cleared on finish)
const _activeWorktreeTaskIds = new Set();

/**
 * Scan .worktrees directory for stale entries older than TTL.
 * Never removes worktrees for active/in-flight tasks.
 * Returns { cleanupCount, skippedActiveCount }.
 */
function worktreeTtlCleanup(repoPaths) {
  const ttlMs = CFG.worktreeTtlMs;
  const now = Date.now();
  let cleanupCount = 0;
  let skippedActiveCount = 0;

  for (const repoPath of repoPaths) {
    const wtBase = path.join(repoPath, WORKTREE_BASE_DIR);
    if (!fs.existsSync(wtBase)) continue;

    let entries;
    try {
      entries = fs.readdirSync(wtBase, { withFileTypes: true });
    } catch (err) {
      log("warn", "w4-ttl-readdir-failed", { repoPath, err: err.message });
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const taskId = entry.name;
      const wtDir = path.join(wtBase, taskId);

      // Never remove active in-flight worktrees
      if (_activeWorktreeTaskIds.has(taskId)) {
        skippedActiveCount++;
        continue;
      }

      // Check age by mtime of the worktree dir
      let stat;
      try {
        stat = fs.statSync(wtDir);
      } catch (_) {
        continue;
      }

      const ageMs = now - stat.mtimeMs;
      if (ageMs < ttlMs) continue;

      // Stale — remove safely
      log("info", "w4-ttl-cleanup", { taskId, repoPath, ageMs, ttlMs });
      try {
        fs.rmSync(wtDir, { recursive: true, force: true });
        cleanupCount++;
      } catch (err) {
        log("warn", "w4-ttl-cleanup-failed", { taskId, repoPath, err: err.message });
      }
    }

    // Prune git worktree registry
    try {
      require("child_process").execSync("git worktree prune", {
        cwd: repoPath,
        stdio: "ignore",
        timeout: 10000,
      });
    } catch (_) {
      // non-fatal
    }
  }

  if (cleanupCount > 0 || skippedActiveCount > 0) {
    log("info", "w4-ttl-cleanup-summary", { cleanup_count: cleanupCount, skipped_active_count: skippedActiveCount });
  }

  return { cleanupCount, skippedActiveCount };
}

/**
 * Start periodic TTL cleanup timer.
 */
function startWorktreeCleanupTimer() {
  if (_worktreeCleanupTimer) return;
  const intervalMs = CFG.worktreeCleanupIntervalMs;
  log("info", "w4-ttl-timer-start", { intervalMs, ttlMs: CFG.worktreeTtlMs });
  _worktreeCleanupTimer = setInterval(() => {
    try {
      worktreeTtlCleanup(CFG.allowedRepos);
    } catch (err) {
      log("warn", "w4-ttl-timer-error", { err: err.message });
    }
  }, intervalMs);
  // Don't prevent process exit
  if (_worktreeCleanupTimer.unref) _worktreeCleanupTimer.unref();
}

function stopWorktreeCleanupTimer() {
  if (_worktreeCleanupTimer) {
    clearInterval(_worktreeCleanupTimer);
    _worktreeCleanupTimer = null;
  }
}

/**
 * Crash recovery: detect orphaned worktrees from interrupted runs on startup.
 * Since we can't query the orchestrator's queue state here, we treat all
 * worktrees older than TTL as orphaned and remove them.
 * Returns { recoveredCount, skippedUncertainCount }.
 */
function worktreeStartupRecovery(repoPaths) {
  if (!CFG.worktreeRecoveryEnabled) {
    log("info", "w4-recovery-disabled");
    return { recoveredCount: 0, skippedUncertainCount: 0 };
  }

  const now = Date.now();
  const ttlMs = CFG.worktreeTtlMs;
  let recoveredCount = 0;
  let skippedUncertainCount = 0;

  for (const repoPath of repoPaths) {
    const wtBase = path.join(repoPath, WORKTREE_BASE_DIR);
    if (!fs.existsSync(wtBase)) continue;

    let entries;
    try {
      entries = fs.readdirSync(wtBase, { withFileTypes: true });
    } catch (err) {
      log("warn", "w4-recovery-readdir-failed", { repoPath, err: err.message });
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const taskId = entry.name;
      const wtDir = path.join(wtBase, taskId);

      let stat;
      try {
        stat = fs.statSync(wtDir);
      } catch (_) {
        continue;
      }

      const ageMs = now - stat.mtimeMs;

      if (ageMs >= ttlMs) {
        // Clearly stale — safe to remove
        log("info", "w4-recovery-cleanup", { taskId, repoPath, ageMs });
        try {
          fs.rmSync(wtDir, { recursive: true, force: true });
          recoveredCount++;
        } catch (err) {
          log("warn", "w4-recovery-cleanup-failed", { taskId, repoPath, err: err.message });
        }
      } else {
        // Recent worktree — uncertain state, skip with warning (prefer safety)
        log("warn", "w4-recovery-skipped-uncertain", { taskId, repoPath, ageMs });
        skippedUncertainCount++;
      }
    }

    // Prune git worktree registry
    try {
      require("child_process").execSync("git worktree prune", {
        cwd: repoPath,
        stdio: "ignore",
        timeout: 10000,
      });
    } catch (_) {
      // non-fatal
    }
  }

  log("info", "w4-recovery-summary", {
    recovered_count: recoveredCount,
    skipped_uncertain_count: skippedUncertainCount,
  });

  return { recoveredCount, skippedUncertainCount };
}

/**
 * Calculate total disk usage of .worktrees directories.
 * Returns { diskUsageBytes, worktreeCount }.
 */
function getWorktreeDiskUsage(repoPaths) {
  let diskUsageBytes = 0;
  let worktreeCount = 0;

  for (const repoPath of repoPaths) {
    const wtBase = path.join(repoPath, WORKTREE_BASE_DIR);
    if (!fs.existsSync(wtBase)) continue;

    try {
      const entries = fs.readdirSync(wtBase, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        worktreeCount++;
        // Use du-like recursive size calculation
        const wtDir = path.join(wtBase, entry.name);
        diskUsageBytes += dirSizeSync(wtDir);
      }
    } catch (err) {
      log("warn", "w4-disk-usage-readdir-failed", { repoPath, err: err.message });
    }
  }

  return { diskUsageBytes, worktreeCount };
}

function dirSizeSync(dirPath) {
  let total = 0;
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        total += dirSizeSync(fullPath);
      } else {
        try {
          total += fs.statSync(fullPath).size;
        } catch (_) {
          // skip unreadable files
        }
      }
    }
  } catch (_) {
    // skip unreadable dirs
  }
  return total;
}

/**
 * Check disk guardrails. Returns { allowed, diskUsageBytes, threshold, worktreeCount }.
 * When hard-stop is enabled and threshold exceeded, `allowed` is false.
 */
function checkWorktreeDiskGuardrails(repoPaths) {
  const threshold = CFG.worktreeDiskThresholdBytes;
  const { diskUsageBytes, worktreeCount } = getWorktreeDiskUsage(repoPaths);
  const exceeded = diskUsageBytes >= threshold;

  if (exceeded) {
    log("warn", "w4-disk-threshold-exceeded", {
      disk_usage_bytes: diskUsageBytes,
      threshold,
      worktreeCount,
      hardStop: CFG.worktreeDiskHardStop,
    });
  }

  const allowed = !(exceeded && CFG.worktreeDiskHardStop);
  _worktreeDiskBlocked = !allowed;

  return { allowed, diskUsageBytes, threshold, worktreeCount };
}

/**
 * Returns true if disk hard-stop is currently blocking new claims.
 */
function isWorktreeDiskBlocked() {
  return _worktreeDiskBlocked;
}

// ── STAGE W5: OPERATOR UX + CONTROL SURFACE ─────────────────────────────────────
// Inspect, list, force-cleanup, and Telegram-friendly formatting for worktrees.

// Registry: tracks worktree metadata per taskId for operator queries.
// Entries are added in processTask when a worktree is created, removed on cleanup.
const _worktreeRegistry = new Map(); // taskId → { worktreePath, branch, baseRepoPath, slotId, createdAt }

function worktreeRegistryAdd(taskId, info) {
  _worktreeRegistry.set(taskId, {
    worktreePath: info.worktreePath,
    branch: info.branch,
    baseRepoPath: info.baseRepoPath,
    slotId: info.slotId || null,
    createdAt: Date.now(),
  });
}

function worktreeRegistryRemove(taskId) {
  _worktreeRegistry.delete(taskId);
}

/**
 * Inspect a worktree by taskId.
 * Returns metadata: path, branch, age, active/idle, disk usage.
 * Works for both active (in-registry) and completed (on-disk) worktrees.
 */
function inspectWorktree(taskId, repoPaths) {
  const entry = _worktreeRegistry.get(taskId);
  const isActive = _activeWorktreeTaskIds.has(taskId);

  // Check registry first (active or recently active)
  if (entry) {
    const ageMs = Date.now() - entry.createdAt;
    let diskUsageBytes = 0;
    try {
      if (fs.existsSync(entry.worktreePath)) {
        diskUsageBytes = dirSizeSync(entry.worktreePath);
      }
    } catch (_) {}

    return {
      found: true,
      taskId,
      worktreePath: entry.worktreePath,
      branch: entry.branch,
      baseRepoPath: entry.baseRepoPath,
      slotId: entry.slotId,
      createdAt: entry.createdAt,
      ageMs,
      status: isActive ? "active" : "idle",
      diskUsageBytes,
    };
  }

  // Fall back to scanning .worktrees directories on disk
  for (const repoPath of (repoPaths || [])) {
    const wtDir = path.join(repoPath, WORKTREE_BASE_DIR, taskId);
    if (fs.existsSync(wtDir)) {
      let stat;
      try { stat = fs.statSync(wtDir); } catch (_) { continue; }
      const ageMs = Date.now() - stat.mtimeMs;
      let diskUsageBytes = 0;
      try { diskUsageBytes = dirSizeSync(wtDir); } catch (_) {}

      // Try to detect branch from HEAD file
      let branch = null;
      try {
        const headFile = path.join(wtDir, ".git");
        if (fs.existsSync(headFile)) {
          const headContent = fs.readFileSync(path.join(wtDir, ".git"), "utf-8").trim();
          // .git file in worktree contains "gitdir: ..." pointing to main repo's worktree dir
          // Try reading HEAD from the worktree
          const gitDirMatch = headContent.match(/^gitdir:\s*(.+)$/);
          if (gitDirMatch) {
            const gitDir = gitDirMatch[1];
            const headPath = path.join(gitDir, "HEAD");
            if (fs.existsSync(headPath)) {
              const ref = fs.readFileSync(headPath, "utf-8").trim();
              const refMatch = ref.match(/^ref:\s*refs\/heads\/(.+)$/);
              branch = refMatch ? refMatch[1] : ref.slice(0, 12);
            }
          }
        }
      } catch (_) {}

      return {
        found: true,
        taskId,
        worktreePath: wtDir,
        branch,
        baseRepoPath: repoPath,
        slotId: null,
        createdAt: stat.birthtimeMs || stat.mtimeMs,
        ageMs,
        status: isActive ? "active" : "stale",
        diskUsageBytes,
      };
    }
  }

  return { found: false, taskId };
}

/**
 * List all active slots and worktrees.
 * Returns slot info + worktree registry + on-disk worktrees.
 */
function listWorktrees(repoPaths) {
  const slots = [];
  for (const [slotId, slotInfo] of _activeSlots.entries()) {
    slots.push({
      slotId,
      taskId: slotInfo.taskId,
      status: "active",
    });
  }

  const registered = [];
  for (const [taskId, entry] of _worktreeRegistry.entries()) {
    registered.push({
      taskId,
      worktreePath: entry.worktreePath,
      branch: entry.branch,
      slotId: entry.slotId,
      ageMs: Date.now() - entry.createdAt,
      status: _activeWorktreeTaskIds.has(taskId) ? "active" : "idle",
    });
  }

  // Also scan disk for orphaned worktrees not in registry
  const onDisk = [];
  for (const repoPath of (repoPaths || [])) {
    const wtBase = path.join(repoPath, WORKTREE_BASE_DIR);
    if (!fs.existsSync(wtBase)) continue;
    try {
      const entries = fs.readdirSync(wtBase, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const taskId = entry.name;
        if (_worktreeRegistry.has(taskId)) continue; // already in registered list
        let stat;
        try { stat = fs.statSync(path.join(wtBase, taskId)); } catch (_) { continue; }
        onDisk.push({
          taskId,
          worktreePath: path.join(wtBase, taskId),
          repoPath,
          ageMs: Date.now() - stat.mtimeMs,
          status: _activeWorktreeTaskIds.has(taskId) ? "active" : "stale",
        });
      }
    } catch (_) {}
  }

  return {
    activeSlots: slots,
    totalSlots: CFG.maxParallelWorktrees,
    registeredWorktrees: registered,
    onDiskOrphans: onDisk,
    diskUsage: getWorktreeDiskUsage(repoPaths || []),
  };
}

/**
 * Force cleanup a worktree by taskId.
 * Default: denies cleanup if task is active. Pass force=true to override.
 * Returns { success, denied, reason, warning }.
 */
function forceCleanupWorktree(taskId, repoPaths, { force = false } = {}) {
  const isActive = _activeWorktreeTaskIds.has(taskId);

  if (isActive && !force) {
    log("warn", "w5-force-cleanup-denied", { taskId, reason: "task_active" });
    return {
      success: false,
      denied: true,
      reason: "task is currently active; use force=true to override",
    };
  }

  let warning = null;
  if (isActive && force) {
    warning = "forced cleanup of active task — task may fail or produce partial results";
    log("warn", "w5-force-cleanup-active-override", { taskId, warning });
  }

  // Find the worktree path
  let wtPath = null;
  let baseRepoPath = null;
  const entry = _worktreeRegistry.get(taskId);
  if (entry) {
    wtPath = entry.worktreePath;
    baseRepoPath = entry.baseRepoPath;
  } else {
    // Scan disk
    for (const repoPath of (repoPaths || [])) {
      const candidate = path.join(repoPath, WORKTREE_BASE_DIR, taskId);
      if (fs.existsSync(candidate)) {
        wtPath = candidate;
        baseRepoPath = repoPath;
        break;
      }
    }
  }

  if (!wtPath || !fs.existsSync(wtPath)) {
    return {
      success: false,
      denied: false,
      reason: "worktree not found on disk",
    };
  }

  // Remove it
  try {
    fs.rmSync(wtPath, { recursive: true, force: true });
    // Prune git worktree registry
    try {
      require("child_process").execSync("git worktree prune", {
        cwd: baseRepoPath,
        stdio: "ignore",
        timeout: 10000,
      });
    } catch (_) {}
  } catch (err) {
    log("warn", "w5-force-cleanup-failed", { taskId, err: err.message });
    return {
      success: false,
      denied: false,
      reason: `cleanup failed: ${err.message}`,
    };
  }

  // Clean up tracking state
  _worktreeRegistry.delete(taskId);
  _activeWorktreeTaskIds.delete(taskId);

  log("info", "w5-force-cleanup-done", { taskId, wtPath, forced: isActive && force, warning });

  return {
    success: true,
    denied: false,
    reason: null,
    warning,
    cleanedPath: wtPath,
  };
}

/**
 * Format a compact Telegram-friendly status summary for a task event.
 * Returns a short string suitable for bot messages.
 */
function formatTelegramStatus(eventData) {
  const { taskId, status, phase, message, meta } = eventData;
  const shortId = (taskId || "???").slice(-8);
  const slot = meta?.slotId ? ` [${meta.slotId}]` : "";
  const branch = meta?.worktreeBranch || meta?.branch || "";
  const branchTag = branch ? ` \u2192 ${branch}` : "";

  const statusIcons = {
    claimed: "\u2705",
    started: "\u25B6\uFE0F",
    progress: "\u23F3",
    completed: "\u2705",
    review_pass: "\u2705",
    review_fail: "\u274C",
    needs_input: "\u2753",
    needs_patch: "\uD83D\uDD27",
    escalated: "\u26A0\uFE0F",
    failed: "\u274C",
    timeout: "\u23F0",
    rejected: "\uD83D\uDEAB",
  };
  const icon = statusIcons[status] || "\u2139\uFE0F";

  // Build compact summary
  let summary = `${icon} ${shortId}${slot}${branchTag}\n`;
  summary += `${status}/${phase}`;

  if (message) {
    const shortMsg = message.length > 120 ? message.slice(0, 117) + "..." : message;
    summary += `: ${shortMsg}`;
  }

  // Add duration if available
  if (meta?.durationMs) {
    const secs = (meta.durationMs / 1000).toFixed(1);
    summary += ` (${secs}s)`;
  }

  // Add slot utilization
  if (meta?.activeSlots !== undefined && meta?.totalSlots !== undefined) {
    summary += `\nslots: ${meta.activeSlots}/${meta.totalSlots}`;
  }

  // Add worktree info if present
  if (meta?.worktreePath) {
    summary += `\nwt: ${path.basename(meta.worktreePath)}`;
  }

  // Add disk usage for disk-related events
  if (meta?.disk_usage_bytes !== undefined) {
    const mb = (meta.disk_usage_bytes / (1024 * 1024)).toFixed(1);
    summary += `\ndisk: ${mb}MB`;
  }

  return summary;
}

/**
 * Build enriched event metadata for worktree-aware task notifications.
 * Merges standard fields (taskId, slotId, worktreePath, branch, status phase)
 * into the event meta object.
 */
function enrichEventMeta(task, slotCtx, worktreeInfo, baseMeta) {
  const enriched = { ...baseMeta };
  enriched.taskId = task.taskId;
  enriched.slotId = slotCtx?.slotId || null;
  if (worktreeInfo) {
    enriched.worktreePath = worktreeInfo.worktreePath;
    enriched.worktreeBranch = worktreeInfo.branch;
    enriched.baseCommit = worktreeInfo.baseCommit;
  }
  return enriched;
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

// ── PROCESS TASK (single slot) ──────────────────────────────────────────────────
// Extracted from mainLoop so it can be run concurrently in parallel slots.
// `slotCtx` provides per-slot lease/nonce; for single-slot mode (maxParallelWorktrees=1)
// it falls back to the global lease/nonce functions for full backward compat.

async function processTask(task, slotCtx) {
  let worktreeInfo = null;
  let originalRepoPath = null;

  try {
    log("info", "task received", { taskId: task.taskId, mode: task.mode, slotId: slotCtx.slotId });

    // Per-slot lease + nonce
    slotResetNonce(slotCtx);
    slotGetNonce(slotCtx, task.taskId);
    slotStartLease(slotCtx, task.taskId);

    await sendEvent(task, "claimed", "pull", "task received", getSlotTelemetry(slotCtx.slotId));

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
        meta: { durationMs: 0, repoPath: task.scope?.repoPath, branch: task.scope?.branch, ...getSlotTelemetry(slotCtx.slotId) },
      }).catch((e) => log("error", "failed to report rejection", { err: e.message }));
      return;
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
      ...getSlotTelemetry(slotCtx.slotId),
    });
    await sendEvent(task, "progress", "validate", "validation passed", {
      stepIndex: 1,
      stepTotal,
    });

    // ── WORKTREE SETUP ──
    originalRepoPath = task.scope?.repoPath;
    if (task.useWorktree && task.scope && task.scope.repoPath) {
      // W4: disk guardrail check before creating worktree
      const diskCheck = checkWorktreeDiskGuardrails(CFG.allowedRepos);
      if (!diskCheck.allowed) {
        log("error", "w4-disk-hard-stop", {
          taskId: task.taskId,
          disk_usage_bytes: diskCheck.diskUsageBytes,
          threshold: diskCheck.threshold,
        });
        await sendEvent(task, "failed", "worktree", "disk threshold exceeded — hard stop enabled", {
          disk_usage_bytes: diskCheck.diskUsageBytes,
          threshold: diskCheck.threshold,
        });
        await apiPost("/api/worker/result", {
          workerId: CFG.workerId,
          taskId: task.taskId,
          status: "failed",
          mode: task.mode,
          output: { stdout: "", stderr: "worktree disk threshold exceeded (hard stop)", truncated: false },
          meta: { durationMs: 0, repoPath: task.scope.repoPath, branch: task.scope.branch, ...getSlotTelemetry(slotCtx.slotId) },
        }).catch((e) => log("error", "failed to report disk hard-stop", { err: e.message }));
        return;
      }

      // W4: track active worktree task
      _activeWorktreeTaskIds.add(task.taskId);

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
        // W5: register worktree for operator inspection
        worktreeRegistryAdd(task.taskId, {
          worktreePath: wtPath,
          branch: task.scope.branch,
          baseRepoPath: baseRepo,
          slotId: slotCtx.slotId,
        });
        log("info", "worktree created", { taskId: task.taskId, wtPath, baseCommit, branch: task.scope.branch, slotId: slotCtx.slotId });
        await sendEvent(task, "progress", "worktree", `worktree created at ${wtPath}`, {
          worktreePath: wtPath,
          baseCommit,
          branch: task.scope.branch,
          ...getSlotTelemetry(slotCtx.slotId),
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
          meta: { durationMs: 0, repoPath: baseRepo, branch: task.scope.branch, ...getSlotTelemetry(slotCtx.slotId) },
        }).catch((e) => log("error", "failed to report worktree failure", { err: e.message }));
        return;
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

    // Attach slot telemetry to result
    Object.assign(result.meta, getSlotTelemetry(slotCtx.slotId));

    // ── LEASE CHECK (Stage 5) ──
    if (slotIsLeaseExpired(slotCtx)) {
      log("warn", "lease-expired-abort", {
        taskId: task.taskId,
        status: result.status,
        slotId: slotCtx.slotId,
        msg: "lease expired during execution; skipping result report",
      });
      await sendEvent(task, "failed", "lease", "lease expired during execution — result discarded");
      slotStopLease(slotCtx);
      slotResetNonce(slotCtx);
      return;
    }

    // ── NEEDS_INPUT CHECK ──
    let ni = null;
    if (result.status === "completed") {
      ni = parseNeedsInput(result.output.stdout);

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
        ni = null;
      }
    }

    // ── REVIEW GATE ──
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

    // Hard safety gate
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
    enforceReviewGate(task, result);
    if (result.meta.reviewGateEnforced) {
      await sendEvent(task, result.status, "review_gate",
        `review gate enforced: ${result.meta.reviewGateReason}`,
        { reviewGateEnforced: true, reviewGateReason: result.meta.reviewGateReason }
      );
    }

    // ── MERGE SAFETY GATE (Stage W3) ──
    evaluateMergeGate(task, result);
    await applyMergeConflictCheck(task, result, worktreeInfo);
    if (result.meta.mergeGateBlocked) {
      await sendEvent(task, result.status, "merge_gate",
        `merge gate blocked: ${result.meta.gate_blocked_reason}`,
        {
          mergeGateBlocked: true,
          gate_blocked_reason: result.meta.gate_blocked_reason,
          mergeGateFailures: result.meta.mergeGateFailures || [],
          mergeConflictCheck: result.meta.mergeConflictCheck || null,
        }
      );
    }

    log("info", "task done", {
      taskId: task.taskId,
      status: result.status,
      durationMs: result.meta.durationMs,
      slotId: slotCtx.slotId,
      reviewGateEnforced: result.meta.reviewGateEnforced || false,
    });

    if (result.status === "needs_input" && ni && ni.isStructuredAsk && ni.question) {
      await sendEvent(
        task, "needs_input", "claude",
        `needs input: ${result.meta.question || "(no question)"}`,
        result.meta
      );
    } else if (result.status === "needs_input") {
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
    } else if (result.status === "needs_patch") {
      const reason = result.meta.gate_blocked_reason || "merge gate blocked";
      await sendEvent(task, "needs_patch", "merge_gate",
        `needs patch: ${reason}`,
        result.meta
      );
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
      ...getSlotTelemetry(slotCtx.slotId),
    });
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
    if (result.status === "needs_input" && ni && ni.isStructuredAsk) {
      resultBody.question = result.meta.question ?? null;
      resultBody.options = result.meta.options ?? null;
      resultBody.context = result.meta.context ?? null;
      resultBody.needsInputAt = result.meta.needsInputAt ?? null;
    }
    if (result.status === "review_fail" || result.status === "escalated") {
      resultBody.structuredFindings = result.meta?.structuredFindings ?? null;
      resultBody.reviewFindings = result.meta?.reviewFindings ?? null;
    }
    if (result.meta.mergeGateBlocked) {
      resultBody.gate_blocked_reason = result.meta.gate_blocked_reason ?? null;
      resultBody.mergeGateFailures = result.meta.mergeGateFailures ?? null;
      resultBody.mergeConflictCheck = result.meta.mergeConflictCheck ?? null;
    }
    await apiPost("/api/worker/result", resultBody);

    // ── WORKTREE CLEANUP ──
    if (worktreeInfo && !task.keepWorktree) {
      task.scope.repoPath = originalRepoPath;
      await removeWorktree(worktreeInfo.baseRepoPath, task.taskId);
      worktreeRegistryRemove(task.taskId); // W5
      log("info", "worktree removed", { taskId: task.taskId, wtPath: worktreeInfo.worktreePath });
    } else if (worktreeInfo && task.keepWorktree) {
      log("info", "worktree kept (keepWorktree=true)", { taskId: task.taskId, wtPath: worktreeInfo.worktreePath });
    }
    // W4: untrack active worktree
    _activeWorktreeTaskIds.delete(task.taskId);

    // Clean up slot lease + nonce
    slotStopLease(slotCtx);
    slotResetNonce(slotCtx);

    resetBackoff();
  } catch (err) {
    // Worktree cleanup on error
    if (worktreeInfo && !task?.keepWorktree) {
      try { if (originalRepoPath) task.scope.repoPath = originalRepoPath; } catch (_) {}
      await removeWorktree(worktreeInfo.baseRepoPath, task.taskId).catch((wtErr) =>
        log("warn", "worktree cleanup failed in error handler", { err: wtErr.message })
      );
      if (task?.taskId) worktreeRegistryRemove(task.taskId); // W5
    }
    // W4: untrack active worktree
    if (task?.taskId) _activeWorktreeTaskIds.delete(task.taskId);

    slotStopLease(slotCtx);
    slotResetNonce(slotCtx);

    const delay = nextBackoff();
    log("error", "slot error", { err: err.message, slotId: slotCtx.slotId, taskId: task?.taskId, nextRetryMs: delay });

    if (task && !isTransientError(err)) {
      log("error", "fatal-error-dlq", { taskId: task.taskId, err: err.message });
      await sendToDeadLetter(task, err, 0, "fatal error in slot");
      await sendEvent(task, "failed", "dlq", `dead-lettered: ${err.message}`);
    } else if (task) {
      await sendEvent(task, "failed", "other", err.message);
    }
  }
}

// ── SCHEDULER (Stage W2) ────────────────────────────────────────────────────────
// Polls for tasks and dispatches them to free slots. Each slot runs processTask()
// concurrently. When maxParallelWorktrees=1, behavior is identical to pre-W2
// sequential mainLoop.

async function mainLoop() {
  const totalSlots = CFG.maxParallelWorktrees;
  log("info", "worker started", {
    allowedRepos: CFG.allowedRepos,
    pollIntervalMs: CFG.pollIntervalMs,
    maxParallelWorktrees: totalSlots,
  });

  // W4: crash recovery on startup
  if (CFG.allowedRepos.length > 0) {
    try {
      const recovery = worktreeStartupRecovery(CFG.allowedRepos);
      if (recovery.recoveredCount > 0 || recovery.skippedUncertainCount > 0) {
        log("info", "w4-startup-recovery-complete", recovery);
      }
    } catch (err) {
      log("warn", "w4-startup-recovery-error", { err: err.message });
    }
  }

  // W4: start periodic TTL cleanup
  startWorktreeCleanupTimer();

  while (!shuttingDown) {
    // If all slots busy, wait for any to finish
    if (_activeSlots.size >= totalSlots) {
      await Promise.race([..._activeSlots.values()].map((s) => s.promise));
      continue; // re-check after a slot frees up
    }

    // ── PULL ──
    let pullRes;
    try {
      pullRes = await apiPost("/api/worker/pull", {
        workerId: CFG.workerId,
        availableSlots: totalSlots - _activeSlots.size,
      });
      resetBackoff();
    } catch (err) {
      const delay = nextBackoff();
      log("error", "pull error", { err: err.message, nextRetryMs: delay });
      await sleep(delay);
      continue;
    }

    if (!pullRes.ok) {
      log("warn", "pull returned ok:false", { body: JSON.stringify(pullRes).slice(0, 300) });
      await sleep(CFG.pollIntervalMs);
      continue;
    }

    if (!pullRes.task) {
      log("debug", "no tasks", { activeSlots: _activeSlots.size, totalSlots });
      // If slots are busy, race on them finishing vs poll interval
      if (_activeSlots.size > 0) {
        await Promise.race([
          sleep(CFG.pollIntervalMs),
          ...[..._activeSlots.values()].map((s) => s.promise),
        ]);
      } else {
        await sleep(CFG.pollIntervalMs);
      }
      continue;
    }

    const task = pullRes.task;
    const slotId = `slot-${task.taskId}`;
    const slotCtx = createSlotContext(slotId);

    // Launch task in a slot
    const slotPromise = processTask(task, slotCtx).finally(() => {
      _activeSlots.delete(slotId);
      log("debug", "slot freed", { slotId, activeSlots: _activeSlots.size, totalSlots });
    });

    _activeSlots.set(slotId, { taskId: task.taskId, promise: slotPromise });
    log("info", "slot assigned", { slotId, taskId: task.taskId, activeSlots: _activeSlots.size, totalSlots });
  }

  // ── GRACEFUL SHUTDOWN: drain in-flight tasks ──
  if (_activeSlots.size > 0) {
    log("info", "graceful-shutdown: waiting for in-flight tasks", {
      activeSlots: _activeSlots.size,
      taskIds: [..._activeSlots.values()].map((s) => s.taskId),
    });
    await Promise.allSettled([..._activeSlots.values()].map((s) => s.promise));
    log("info", "graceful-shutdown: all slots drained");
  }

  log("info", "worker stopped");
}

// ── SHUTDOWN ───────────────────────────────────────────────────────────────────

function shutdown(signal) {
  log("info", `received ${signal}, shutting down`);
  shuttingDown = true;
  stopWorktreeCleanupTimer();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// ── START ──────────────────────────────────────────────────────────────────────

mainLoop().catch((err) => {
  log("fatal", "unexpected crash", { err: err.message });
  process.exit(1);
});
