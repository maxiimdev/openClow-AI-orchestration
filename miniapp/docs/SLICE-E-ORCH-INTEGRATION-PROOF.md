# Slice E — Orch-API Integration Proof Report

## Summary

Implemented real integration between miniapp and orch-api (v0.3.0 contract).
The miniapp now supports two data modes via `MINIAPP_DATA_MODE`:

- **`mock`** (default) — in-memory mock data, zero external deps
- **`orch`** — live orch-api via HTTP adapter with schema mapping

## File Changelog

### New files

| File | Purpose |
|---|---|
| `server/lib/orch-client.ts` | HTTP adapter: `orchGetTask()`, `orchResumeTask()` with Bearer auth |
| `server/lib/orch-mapper.ts` | Maps orch task/event schema → miniapp `Task`/`TaskEvent` types |
| `server/lib/task-cache.ts` | In-memory task ID cache for hybrid list policy |
| `server/lib/data-source.ts` | Unified data source: delegates to mock or orch based on env |
| `test/orch-mapper.test.ts` | 17 tests for schema mapping |
| `test/task-cache.test.ts` | 7 tests for cache behavior |
| `test/data-source.test.ts` | 18 tests for unified data source (mock + orch modes) |

### Modified files

| File | Change |
|---|---|
| `server/api/v1/miniapp/tasks/index.get.ts` | Uses `listTasks()` from data-source |
| `server/api/v1/miniapp/tasks/[id].get.ts` | Uses `getTask()` from data-source |
| `server/api/v1/miniapp/tasks/[id]/events.get.ts` | Uses `getTaskEvents()` from data-source |
| `server/api/v1/miniapp/tasks/[id]/resume.post.ts` | Uses `resumeTask()` from data-source |

## Orch-API Endpoints Used

Per v0.3.0 contract:

| Method | Endpoint | Usage |
|---|---|---|
| `GET` | `/api/task/:taskId` | Task detail + inline events |
| `POST` | `/api/task/resume` | Resume needs_input task |

**NOT used** (not available): `GET /api/tasks`, `GET /api/task/:taskId/events`

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `MINIAPP_DATA_MODE` | No | `mock` | `mock` or `orch` |
| `ORCH_API_BASE_URL` | In orch mode | — | Orch-api base URL |
| `ORCH_API_TOKEN` | In orch mode | — | Bearer token for orch-api auth |
| `ORCH_SEED_TASK_IDS` | No | — | Comma-separated task IDs to pre-populate cache |

## Schema Mapping (orch → miniapp)

| Orch field | Miniapp field | Notes |
|---|---|---|
| `taskId` | `id` | Renamed |
| `scope.repoPath` | `repoPath` | Flattened |
| `scope.branch` | `branch` | Flattened |
| `status` (WorkerStatus) | `internalStatus` + `status` (UserStatus) | Mapped via STATUS_MAP |
| `events[]` (inline) | Extracted via `mapOrchEvents()` | No separate endpoint |
| `output.stdout/stderr` | `result.stdout/stderr` | Plus `exitCode`/`durationMs` from `meta` |
| *(absent)* | `userId = 0` | MVP: no per-user ownership |

## Hybrid List Policy

Since orch-api v0.3.0 has no `GET /api/tasks` endpoint:

1. The miniapp maintains an **in-memory task ID cache** (`task-cache.ts`)
2. IDs are added when:
   - A task is viewed via detail page (`GET /tasks/:id`)
   - A task is resumed (`POST /tasks/:id/resume`)
   - Operator seeds IDs via `ORCH_SEED_TASK_IDS` env var
3. List endpoints fetch each cached ID via `GET /api/task/:taskId` and aggregate
4. 404'd IDs are automatically pruned from cache
5. When cache is empty, an explicit `notice` field is returned

## MVP User Visibility Policy

The orch-api has no per-user task ownership. In orch mode:

- **All authenticated miniapp users see all tasks** (userId=0 placeholder)
- The existing userId-based scoping in mock mode is preserved
- When the orch-api adds user ownership (e.g., `createdBy` field), the mapper
  in `orch-mapper.ts` should be updated to read and assign it

## Fallback Behavior

- `MINIAPP_DATA_MODE=mock` (default): identical behavior to pre-integration
- `MINIAPP_DATA_MODE=orch` with unreachable orch-api: HTTP errors propagate as 500s
- Missing `ORCH_API_BASE_URL`/`ORCH_API_TOKEN` in orch mode: throws clear error message

## Limitations

1. **No full task listing** — requires future `GET /api/tasks` endpoint in orch-api
2. **In-memory cache** — task ID cache resets on process restart; no persistent store
3. **No per-user scoping** in orch mode — all users see all tasks
4. **SSE stream** still uses mock data — SSE integration is a separate slice
5. **No retry/cancel** in orch mode — these orch endpoints don't exist yet

## Test Proof

```
$ npx vitest run

 ✓ test/mappers.test.ts (16 tests)
 ✓ test/sse.test.ts (13 tests)
 ✓ test/events.test.ts (11 tests)
 ✓ test/security.test.ts (17 tests)
 ✓ test/tasks-page.test.ts (8 tests)
 ✓ test/task-detail-page.test.ts (11 tests)
 ✓ test/data-source.test.ts (18 tests)
 ✓ test/reviews-page.test.ts (11 tests)
 ✓ test/inbox-page.test.ts (12 tests)
 ✓ test/task-cache.test.ts (7 tests)
 ✓ test/filters.test.ts (11 tests)
 ✓ test/orch-mapper.test.ts (17 tests)
 ✓ test/reviews.test.ts (18 tests)
 ✓ test/resume.test.ts (15 tests)

 Test Files  14 passed (14)
      Tests  185 passed (185)
```

All 185 tests pass. New tests: 42 (mapper: 17, cache: 7, data-source: 18).
