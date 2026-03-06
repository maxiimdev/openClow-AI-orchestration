# tg-notifier

Minimal Telegram notifier for worker task events. Receives event payloads via HTTP and forwards them as formatted messages to a Telegram chat.

Only user-relevant lifecycle events reach Telegram — technical/intermediate events are suppressed server-side.

## Setup

```bash
cd notifier
cp .env.example .env
# edit .env with your values

npm install
npm start
```

## Getting TELEGRAM_BOT_TOKEN

1. Open Telegram, find **@BotFather**
2. Send `/newbot`, follow the prompts
3. Copy the token (e.g. `123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11`)

## Getting TELEGRAM_CHAT_ID

**For a private chat (DM with bot):**
1. Send any message to your bot
2. Run:
```bash
curl -s "https://api.telegram.org/bot<TOKEN>/getUpdates" | jq '.result[0].message.chat.id'
```

**For a group:**
1. Add the bot to the group
2. Send any message in the group
3. Run the same `getUpdates` curl — the chat ID will be negative (e.g. `-1001234567890`)

## API

### GET /health

```bash
curl http://localhost:18999/health
```

Response:
```json
{"ok":true,"service":"tg-notifier","version":"0.2.0"}
```

### POST /notify/event

```bash
curl -X POST http://localhost:18999/notify/event \
  -H "Authorization: Bearer $NOTIFIER_SECRET" \
  -H "Content-Type: application/json" \
  -d '{
    "taskId": "abc-123",
    "workerId": "macbook-sigma",
    "status": "completed",
    "phase": "report",
    "message": "task completed",
    "meta": { "durationMs": 30300, "exitCode": 0 }
  }'
```

Success response:
```json
{"ok":true}
```

Suppressed event (technical/intermediate):
```json
{"ok":true,"suppressed":true}
```

Dedupe response (same event within TTL):
```json
{"ok":true,"dedupe":true}
```

Error response (Telegram API failure):
```json
{"ok":false,"error":"Telegram API error: chat not found"}
```

---

## Event filtering

### Events forwarded to Telegram (user-facing)

| Status | Label (Telegram) | Shown content |
|---|---|---|
| `claimed` | 📥 Задача получена | workerId |
| `needs_input` | ❓ Нужен ответ | question + options |
| `review_pass` | ✅ Review pass | iter N/M, duration |
| `review_fail` | ⛔ Review не прошёл | severity, findings snippet, finding count |
| `review_loop_fail` | 🔁 Нужен patch | iter N/M, severity, findings snippet, finding count |
| `escalated` | ⚠️ Эскалация | reason, unresolved finding count, duration |
| `completed` | ✅ Выполнено | duration, exitCode |
| `failed` | ❌ Ошибка | duration, exitCode, error message |
| `timeout` | ⏰ Таймаут | timeout value |
| `rejected` | 🚫 Отклонено | validation errors |
| `resumed` | ↩️ Возобновлено | answeredBy |

### Events suppressed (never sent to Telegram)

| Status | Phase(s) | Reason |
|---|---|---|
| `started` | any | Internal kickoff — not useful to end-user |
| `keepalive` | any | Heartbeat noise |
| `risk` | any | Near-timeout / exit-failure diagnostic |
| `progress` | `plan` | Step plan details (internal) |
| `progress` | `validate` | "validation passed" (noise) |
| `progress` | `git` | Git checkout detail (internal) |
| `progress` | `claude` | "spawning claude" (internal) |
| `progress` | `report` | "reporting result" (internal) |
| `progress` | `review_loop` | Intermediate loop steps — user sees `review_loop_fail`/`review_pass` instead |

---

## Telegram message examples

**Task claimed:**
```
📥 Задача получена
abc-123
Worker: macbook-sigma
```

**Needs input:**
```
❓ Нужен ответ
abc-123
Which database should I use?
  1. PostgreSQL
  2. SQLite
```

**Review passed (after loop):**
```
✅ Review pass
abc-123
iter 2/3
45.2s
```

**Review loop fail (patch queued):**
```
🔁 Нужен patch
abc-123
Iter 1/3 · severity: major
SQL injection in auth.js — no prepared statements used
2 finding(s) — patch будет применён
```

**Review not passed (single-shot):**
```
⛔ Review не прошёл
abc-123
Severity: major
SQL injection in auth.js
2 finding(s)
```

**Escalated:**
```
⚠️ Эскалация
abc-123
max review iterations (3) reached without passing
1 unresolved finding(s)
120.0s
```

**Task completed:**
```
✅ Выполнено
abc-123
30.3s | exit:0
```

**Task failed:**
```
❌ Ошибка
abc-123
12.1s | exit:1
TypeError: Cannot read properties of undefined
```

**Timeout:**
```
⏰ Таймаут
abc-123
after 180s
```

**Rejected:**
```
🚫 Отклонено
abc-123
repoPath not in allowlist: /tmp/evil
```

---

## Integration with orch-api

On your orchestrator server, when handling `POST /api/worker/event`, forward the payload to the notifier:

```js
// inside your /api/worker/event handler
await fetch("http://localhost:18999/notify/event", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${process.env.NOTIFIER_SECRET}`,
  },
  body: JSON.stringify(eventPayload),
});
```

Or run the notifier on a separate host and point to it via URL.

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `PORT` | no | `18999` | HTTP listen port |
| `NOTIFIER_SECRET` | yes | — | Shared secret for Bearer auth |
| `TELEGRAM_BOT_TOKEN` | yes | — | Telegram Bot API token |
| `TELEGRAM_CHAT_ID` | yes | — | Target chat/group ID |
| `DEDUPE_TTL_MS` | no | `15000` | Deduplication window in ms |
