# tg-notifier

Minimal Telegram notifier for worker task events. Receives event payloads via HTTP and forwards them as formatted messages to a Telegram chat.

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
{"ok":true,"service":"tg-notifier","version":"0.1.0"}
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

Dedupe response (same event within TTL):
```json
{"ok":true,"dedupe":true}
```

Error response (Telegram API failure):
```json
{"ok":false,"error":"Telegram API error: chat not found"}
```

## Telegram message examples

Task claimed:
```
📥 [claimed/pull] abc-123
task received
macbook-sigma
```

Task completed with meta:
```
✅ [completed/report] abc-123
task completed
duration: 30.3s | exit: 0
macbook-sigma
```

Task failed:
```
❌ [failed/report] abc-123
task failed
duration: 12.1s | exit: 1
macbook-sigma
```

Timeout:
```
⏰ [timeout/claude] abc-123
claude process timed out
duration: 180.0s
macbook-sigma
```

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
