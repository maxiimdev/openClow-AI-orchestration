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

// ── TELEGRAM ────────────────────────────────────────────────────────────────

const STATUS_EMOJI = {
  claimed: "\u{1F4E5}",   // 📥
  started: "\u{1F680}",   // 🚀
  progress: "\u{2699}",   // ⚙
  completed: "\u{2705}",  // ✅
  failed: "\u{274C}",     // ❌
  timeout: "\u{23F0}",    // ⏰
  rejected: "\u{1F6AB}",  // 🚫
};

function formatMessage(ev) {
  const emoji = STATUS_EMOJI[ev.status] || "\u{2753}"; // ❓
  const header = `${emoji} [${ev.status}/${ev.phase || "—"}] <b>${escapeHtml(ev.taskId)}</b>`;

  const lines = [header];

  if (ev.message) {
    lines.push(escapeHtml(ev.message));
  }

  const extras = [];
  if (ev.meta?.durationMs != null) {
    extras.push(`duration: ${(ev.meta.durationMs / 1000).toFixed(1)}s`);
  }
  if (ev.meta?.exitCode != null) {
    extras.push(`exit: ${ev.meta.exitCode}`);
  }
  if (extras.length) {
    lines.push(`<i>${escapeHtml(extras.join(" | "))}</i>`);
  }

  if (ev.workerId) {
    lines.push(`<code>${escapeHtml(ev.workerId)}</code>`);
  }

  return lines.join("\n");
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

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
  res.json({ ok: true, service: "tg-notifier", version: "0.1.0" });
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
