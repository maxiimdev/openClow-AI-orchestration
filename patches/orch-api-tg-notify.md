# PATCH: Telegram notify in orch-api /api/worker/event

Target: remote orch-api on VPS (server.js or equivalent handler for POST /api/worker/event)
Schema: worker -> orch-api -> Telegram Bot API (direct, no intermediate services)

## ENV_REQUIRED

Add to VPS environment (e.g. `.env`, systemd unit, docker-compose):

```env
TG_NOTIFY_ENABLED=true
TG_BOT_TOKEN=<bot token from @BotFather>
TG_CHAT_ID=<chat or group id>
TG_DEDUPE_TTL_MS=15000
```

## PATCH — code to ADD to the event handler module

Insert this block at module level (above or below existing helpers):

```js
// ── TG NOTIFY ───────────────────────────────────────────────────────────────

const _tgSeen = new Map();

function _tgIsDupe(key) {
  const ttl = parseInt(process.env.TG_DEDUPE_TTL_MS || "15000", 10);
  const now = Date.now();
  const prev = _tgSeen.get(key);
  if (prev && now - prev < ttl) return true;
  _tgSeen.set(key, now);
  return false;
}

setInterval(() => {
  const ttl = parseInt(process.env.TG_DEDUPE_TTL_MS || "15000", 10) * 2;
  const now = Date.now();
  for (const [k, t] of _tgSeen) {
    if (now - t > ttl) _tgSeen.delete(k);
  }
}, 60000).unref();

function _tgEscape(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function _tgFormat(ev) {
  const emoji = {
    claimed: "\u{1F4E5}", started: "\u{1F680}", progress: "\u{2699}",
    completed: "\u{2705}", failed: "\u{274C}", timeout: "\u{23F0}", rejected: "\u{1F6AB}",
  }[ev.status] || "\u{2753}";

  const lines = [
    `${emoji} [${ev.status}/${ev.phase || "\u2014"}] <b>${_tgEscape(ev.taskId)}</b>`,
  ];
  if (ev.message) lines.push(_tgEscape(ev.message));

  const extras = [];
  if (ev.meta?.durationMs != null) extras.push(`duration: ${(ev.meta.durationMs / 1000).toFixed(1)}s`);
  if (ev.meta?.exitCode != null) extras.push(`exit: ${ev.meta.exitCode}`);
  if (extras.length) lines.push(`<i>${_tgEscape(extras.join(" | "))}</i>`);

  if (ev.workerId) lines.push(`<code>${_tgEscape(ev.workerId)}</code>`);
  return lines.join("\n");
}

function notifyTelegram(ev) {
  if ((process.env.TG_NOTIFY_ENABLED || "").toLowerCase() !== "true") return;
  const token = process.env.TG_BOT_TOKEN;
  const chatId = process.env.TG_CHAT_ID;
  if (!token || !chatId) return;

  const key = `${ev.taskId}:${ev.status}:${ev.phase || ""}:${ev.message || ""}`;
  if (_tgIsDupe(key)) return;

  const text = _tgFormat(ev);
  fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true,
    }),
    signal: AbortSignal.timeout(5000),
  })
    .then((r) => r.json())
    .then((b) => {
      if (!b.ok) console.warn(`[tg] send failed: ${b.description}`);
    })
    .catch((e) => {
      console.warn(`[tg] error: ${e.message}`);
    });
}
```

## PATCH — call site

In the handler for `POST /api/worker/event`, add ONE line after
the event is saved to `task.events[]` and BEFORE `res.json({ ok: true })`:

```js
  // BEFORE (existing):
  // ... save event to task.events[] ...

  // ADD THIS LINE:
  notifyTelegram(req.body);

  // AFTER (existing):
  return res.json({ ok: true });
```

That's it. One function call. The rest is self-contained.

## PATCH_SUMMARY

- Files changed on VPS: **1** (the event handler module)
- Lines added: ~55 (self-contained block + 1 call site)
- Dependencies added: **0** (uses native fetch, Node 18+)
- Existing behavior changed: **none** (endpoint still returns `{ok:true}` after saving event)
- Risk: **zero** — Telegram is fire-and-forget, errors caught, never affects response

## SMOKE_TEST_STEPS

1. SSH to VPS, add env vars, restart orch-api
2. Verify health:
   ```bash
   curl https://your-orch-api/api/health
   ```
3. Send test event:
   ```bash
   curl -X POST https://your-orch-api/api/worker/event \
     -H "Authorization: Bearer $WORKER_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"taskId":"smoke-001","workerId":"test","status":"completed","phase":"report","message":"smoke test","meta":{"durationMs":1234,"exitCode":0}}'
   ```
   Expected: `{"ok":true}` + Telegram message:
   ```
   ✅ [completed/report] smoke-001
   smoke test
   duration: 1.2s | exit: 0
   test
   ```
4. Repeat same curl within 15s — no duplicate in Telegram (dedupe works)
5. Run real worker task, verify all phases arrive in Telegram:
   claimed -> started -> progress/git -> progress/claude -> completed (or failed/timeout)

## ROLLBACK_STEPS

1. SSH to VPS
2. Set `TG_NOTIFY_ENABLED=false` in env — instant disable, no code change needed
3. Restart orch-api — Telegram calls stop immediately
4. (Optional) Remove the `notifyTelegram` block and call site, redeploy

## MESSAGE_EXAMPLES

```
📥 [claimed/pull] abc-123
task received
macbook-sigma

🚀 [started/validate] abc-123
validating task
macbook-sigma

⚙ [progress/git] abc-123
checking out branch agent/fix-login
macbook-sigma

⚙ [progress/claude] abc-123
spawning claude CLI
macbook-sigma

✅ [completed/report] abc-123
task completed
duration: 30.3s | exit: 0
macbook-sigma

❌ [failed/report] abc-123
task failed
duration: 12.1s | exit: 1
macbook-sigma

⏰ [timeout/claude] abc-123
claude process timed out
duration: 180.0s
macbook-sigma
```
