# Orchestrator Queue API (MVP)

Simple HTTPS-ready API for remote worker pull model.

## Endpoints

- `GET /health`
- `POST /api/enqueue` (create task)
- `POST /api/worker/pull` (worker polls next task)
- `POST /api/worker/result` (worker reports result)
- `GET /api/task/:taskId` (check task state)

## Auth

Bearer token required for all `/api/*` endpoints:

`Authorization: Bearer <ORCH_API_TOKEN>`

## Run

```bash
cd orch-api
cp .env.example .env
npm i
npm start
```

## Notes

- Queue stored in JSON file (`DATA_FILE`)
- One-task-at-a-time claim per poll
- Task states: queued -> claimed -> completed/failed/timeout/rejected
