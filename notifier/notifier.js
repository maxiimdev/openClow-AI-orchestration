#!/usr/bin/env node
"use strict";

const express = require("express");
const path = require("path");
const fs = require("fs");

// ── ENV ─────────────────────────────────────────────────────────────────────

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

function required(key) {
  const v = process.env[key];
  if (!v) {
    console.error(`[FATAL] missing env: ${key}`);
    process.exit(1);
  }
  return v;
}

const CFG = {
  port: parseInt(process.env.PORT || "18999", 10),
  secret: required("NOTIFIER_SECRET"),
  tgToken: required("TELEGRAM_BOT_TOKEN"),
  tgChatId: required("TELEGRAM_CHAT_ID"),
  dedupeTtlMs: parseInt(process.env.DEDUPE_TTL_MS || "15000", 10),
};

// ── LOGGING ─────────────────────────────────────────────────────────────────

function log(level, msg, meta = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    service: "tg-notifier",
    msg,
    ...meta,
  };
  console.log(JSON.stringify(entry));
}

// ── EVENT FILTER ────────────────────────────────────────────────────────────
//
// Only user-relevant lifecycle events reach Telegram.
// Technical/intermediate events are suppressed server-side.
//
// Suppressed statuses (always):
//   started     — internal validation kickoff, not useful to end-user
//   keepalive   — heartbeat noise
//   risk        — near-timeout / non-zero exit (internal diagnostic)
//
// Suppressed progress phases:
//   plan        — step plan details (internal)
//   validate    — "validation passed" (noise)
//   git         — git checkout (internal)
//   claude      — "spawning claude" (internal)
//   report      — "reporting result" (internal)
//   review_loop — intermediate loop steps (user sees _fail/_pass instead)

const SUPPRESSED_STATUSES = new Set(["started", "keepalive", "risk"]);
const SUPPRESSED_PROGRESS_PHASES = new Set([
  "plan", "validate", "git", "claude", "report", "review_loop",
]);

function shouldSuppress(ev) {
  if (SUPPRESSED_STATUSES.has(ev.status)) return true;
  if (ev.status === "progress" && SUPPRESSED_PROGRESS_PHASES.has(ev.phase)) return true;
  return false;
}

// ── DEDUPE ──────────────────────────────────────────────────────────────────

const seen = new Map();

function isDuplicate(taskId, status, phase, message) {
  const key = `${taskId}:${status}:${phase}:${message}`;
  const now = Date.now();
  const prev = seen.get(key);
  if (prev && now - prev < CFG.dedupeTtlMs) return true;
  seen.set(key, now);
  return false;
}

// cleanup stale entries every 60s
setInterval(() => {
  const now = Date.now();
  for (const [key, ts] of seen) {
    if (now - ts > CFG.dedupeTtlMs * 2) seen.delete(key);
  }
}, 60000).unref();

// ── FORMAT ──────────────────────────────────────────────────────────────────
//
// User-facing label mapping (emoji + Russian/English label per status):
//
//   claimed          → 📥 Задача получена
//   needs_input      → ❓ Нужен ответ
//   review_pass      → ✅ Review pass
//   review_fail      → ⛔ Review не прошёл
//   review_loop_fail → 🔁 Нужен patch
//   escalated        → ⚠️ Эскалация
//   completed        → ✅ Выполнено
//   failed           → ❌ Ошибка
//   timeout          → ⏰ Таймаут
//   rejected         → 🚫 Отклонено
//   resumed          → ↩️ Возобновлено

const STATUS_LABELS = {
  claimed:          { emoji: "\u{1F4E5}", label: "Задача получена" },   // 📥
  needs_input:      { emoji: "\u2753",    label: "Нужен ответ" },       // ❓
  review_pass:      { emoji: "\u2705",    label: "Review pass" },       // ✅
  review_fail:      { emoji: "\u26D4",    label: "Review не прошёл" },  // ⛔
  review_loop_fail: { emoji: "\u{1F501}", label: "Нужен patch" },       // 🔁
  escalated:        { emoji: "\u26A0",    label: "Эскалация" },         // ⚠️
  completed:        { emoji: "\u2705",    label: "Выполнено" },         // ✅
  failed:           { emoji: "\u274C",    label: "Ошибка" },            // ❌
  timeout:          { emoji: "\u23F0",    label: "Таймаут" },           // ⏰
  rejected:         { emoji: "\u{1F6AB}", label: "Отклонено" },         // 🚫
  resumed:          { emoji: "\u21A9",    label: "Возобновлено" },      // ↩️
};

function formatMessage(ev) {
  const def = STATUS_LABELS[ev.status];
  const emoji = def ? def.emoji : "\u2753";
  const label = def ? def.label : ev.status;

  const lines = [
    `${emoji} <b>${escapeHtml(label)}</b>`,
    `<code>${escapeHtml(ev.taskId)}</code>`,
  ];

  switch (ev.status) {
    case "claimed": {
      if (ev.workerId) {
        lines.push(`Worker: <code>${escapeHtml(ev.workerId)}</code>`);
      }
      break;
    }

    case "needs_input": {
      const q = ev.meta?.question || ev.message || "";
      if (q) lines.push(escapeHtml(q.slice(0, 300)));
      const opts = ev.meta?.options;
      if (Array.isArray(opts) && opts.length) {
        lines.push(opts.map((o, i) => `  ${i + 1}. ${escapeHtml(String(o))}`).join("\n"));
      }
      break;
    }

    case "review_pass": {
      const iter = ev.meta?.reviewIteration;
      const maxIter = ev.meta?.reviewMaxIterations;
      if (iter && maxIter) {
        lines.push(`<i>iter ${iter}/${maxIter}</i>`);
      }
      const durationMs = ev.meta?.reviewLoopDurationMs ?? ev.meta?.durationMs;
      if (durationMs != null) {
        lines.push(`<i>${(durationMs / 1000).toFixed(1)}s</i>`);
      }
      break;
    }

    case "review_fail": {
      const sev = ev.meta?.reviewSeverity || "unknown";
      lines.push(`Severity: <b>${escapeHtml(sev)}</b>`);
      const findings = (ev.meta?.reviewFindings || "").trim().slice(0, 200);
      if (findings) lines.push(`<i>${escapeHtml(findings)}</i>`);
      const sf = ev.meta?.structuredFindings;
      if (Array.isArray(sf) && sf.length) {
        lines.push(`${sf.length} finding(s)`);
      }
      break;
    }

    case "review_loop_fail": {
      const iter = ev.meta?.iteration;
      const maxIter = ev.meta?.maxIter;
      const sev = ev.meta?.reviewSeverity || "unknown";
      if (iter && maxIter) {
        lines.push(`Iter ${iter}/${maxIter} · severity: <b>${escapeHtml(sev)}</b>`);
      }
      const findings = (ev.meta?.reviewFindings || "").trim().slice(0, 150);
      if (findings) lines.push(`<i>${escapeHtml(findings)}</i>`);
      const sf = ev.meta?.structuredFindings;
      if (Array.isArray(sf) && sf.length) {
        lines.push(`${sf.length} finding(s) — patch будет применён`);
      }
      break;
    }

    case "escalated": {
      const reason = (ev.meta?.escalationReason || "max iterations reached").slice(0, 150);
      lines.push(`<i>${escapeHtml(reason)}</i>`);
      const sf = ev.meta?.structuredFindings;
      if (Array.isArray(sf) && sf.length) {
        lines.push(`${sf.length} unresolved finding(s)`);
      }
      const durationMs = ev.meta?.reviewLoopDurationMs;
      if (durationMs != null) {
        lines.push(`<i>${(durationMs / 1000).toFixed(1)}s</i>`);
      }
      break;
    }

    case "completed": {
      const parts = [];
      if (ev.meta?.durationMs != null) parts.push(`${(ev.meta.durationMs / 1000).toFixed(1)}s`);
      if (ev.meta?.exitCode != null) parts.push(`exit:${ev.meta.exitCode}`);
      if (parts.length) lines.push(`<i>${escapeHtml(parts.join(" | "))}</i>`);
      break;
    }

    case "failed": {
      const parts = [];
      if (ev.meta?.durationMs != null) parts.push(`${(ev.meta.durationMs / 1000).toFixed(1)}s`);
      if (ev.meta?.exitCode != null) parts.push(`exit:${ev.meta.exitCode}`);
      if (parts.length) lines.push(`<i>${escapeHtml(parts.join(" | "))}</i>`);
      // Show message only if it's not the generic "task failed"
      const msg = (ev.message || "").trim();
      if (msg && msg !== "task failed") {
        lines.push(`<i>${escapeHtml(msg.slice(0, 150))}</i>`);
      }
      break;
    }

    case "timeout": {
      const tms = ev.meta?.timeoutMs;
      if (tms != null) lines.push(`<i>after ${Math.round(tms / 1000)}s</i>`);
      break;
    }

    case "rejected": {
      const errs = ev.meta?.errors;
      if (Array.isArray(errs) && errs.length) {
        lines.push(`<i>${escapeHtml(errs.join("; ").slice(0, 200))}</i>`);
      } else {
        const msg = (ev.message || "").trim();
        if (msg) lines.push(`<i>${escapeHtml(msg.slice(0, 200))}</i>`);
      }
      break;
    }

    case "resumed": {
      const who = ev.meta?.answeredBy || "";
      if (who) lines.push(`by <code>${escapeHtml(who)}</code>`);
      break;
    }

    default: {
      // Catch-all: show message if present
      const msg = (ev.message || "").trim();
      if (msg) lines.push(escapeHtml(msg.slice(0, 200)));
      break;
    }
  }

  return lines.join("\n");
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ── TELEGRAM ────────────────────────────────────────────────────────────────

async function sendTelegram(text) {
  const url = `https://api.telegram.org/bot${CFG.tgToken}/sendMessage`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: CFG.tgChatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
    signal: AbortSignal.timeout(10000),
  });
  const body = await res.json();
  if (!body.ok) {
    throw new Error(`Telegram API error: ${body.description || JSON.stringify(body)}`);
  }
  return body;
}

// ── AUTH MIDDLEWARE ──────────────────────────────────────────────────────────

function auth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token || token !== CFG.secret) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  next();
}

// ── APP ─────────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: "64kb" }));

// health
app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "tg-notifier", version: "0.2.0" });
});

// main endpoint
app.post("/notify/event", auth, async (req, res) => {
  const ev = req.body;

  // validate
  const missing = [];
  if (!ev.taskId) missing.push("taskId");
  if (!ev.status) missing.push("status");
  if (missing.length) {
    return res.status(400).json({ ok: false, error: `missing fields: ${missing.join(", ")}` });
  }

  // suppress technical/intermediate events before they reach Telegram
  if (shouldSuppress(ev)) {
    log("debug", "suppressed", { taskId: ev.taskId, status: ev.status, phase: ev.phase });
    return res.json({ ok: true, suppressed: true });
  }

  // dedupe
  if (isDuplicate(ev.taskId, ev.status, ev.phase || "", ev.message || "")) {
    log("info", "dedupe skip", { taskId: ev.taskId, status: ev.status, phase: ev.phase });
    return res.json({ ok: true, dedupe: true });
  }

  // format & send
  const text = formatMessage(ev);
  try {
    await sendTelegram(text);
    log("info", "sent", { taskId: ev.taskId, status: ev.status, phase: ev.phase });
    return res.json({ ok: true });
  } catch (err) {
    log("error", "telegram send failed", { taskId: ev.taskId, err: err.message });
    return res.status(502).json({ ok: false, error: err.message });
  }
});

// ── START ───────────────────────────────────────────────────────────────────

app.listen(CFG.port, () => {
  log("info", "notifier started", { port: CFG.port, chatId: CFG.tgChatId });
});

// ── EXPORTS (for testing) ───────────────────────────────────────────────────

module.exports = { shouldSuppress, formatMessage, escapeHtml, STATUS_LABELS };
