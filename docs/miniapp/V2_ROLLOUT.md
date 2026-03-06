# V2 Result Contract — Rollout Plan

## Overview

The v2 result contract adds artifact persistence, FTS5 search, and compressed
summary outputs. This document covers the rollout toggles, API changes, and
verification steps.

## Feature Flags (env vars)

| Variable | Default | Description |
|---|---|---|
| `RESULT_V2_ENABLED` | `true` | Use v2 summary for display output / notifications |
| `ARTIFACT_INDEXING_ENABLED` | `true` | Index artifacts into FTS5 on task fetch |
| `SEARCH_ENDPOINT_ENABLED` | `true` | Enable `POST /tasks/:id/search` endpoint |
| `LEGACY_STDOUT_CAP_BYTES` | `65536` | Max inline stdout bytes when v2 is disabled |

### Safe rollback

Set `RESULT_V2_ENABLED=false` to revert all consumer reads to v1 stdout.
Artifact data is still stored but not surfaced. No data loss.

## API Changes

### GET /api/v1/miniapp/tasks/:id/summary

Returns a `resultSource` field indicating which result version was used:

```json
{
  "summary": {
    "id": "task-abc",
    "mode": "implement",
    "status": "completed",
    "resultVersion": 2
  },
  "proof": { "exitCode": 0, "durationMs": 5000, "truncated": false },
  "artifacts": [
    { "name": "stdout.txt", "kind": "stdout", "path": "...", "bytes": 16384, "preview": "..." }
  ],
  "indexed": true,
  "resultSource": "v2_summary"
}
```

`resultSource` values: `v2_summary` | `v1_stdout` | `none`

### POST /api/v1/miniapp/tasks/:id/search

Returns 404 when `SEARCH_ENDPOINT_ENABLED=false`. Otherwise unchanged.

```bash
curl -X POST /api/v1/miniapp/tasks/task-abc/search \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"query": "test failure", "limit": 5}'
```

### GET /api/v1/miniapp/tasks/:id

Unchanged. Returns full task object. v2 tasks include `resultVersion: 2`
and `artifacts[]`. v1 tasks omit these fields — no breaking change.

## Observability

Server-side structured JSON logs (stdout) include:

| Field | Where | Description |
|---|---|---|
| `raw_output_bytes` | summary endpoint | Total bytes of raw stdout+stderr |
| `summary_bytes` | summary endpoint | Bytes of display output served |
| `compression_ratio` | summary endpoint | summary_bytes / raw_output_bytes |
| `indexed_chunks_count` | task fetch, summary | FTS chunks indexed for this task |
| `artifact_count` | task fetch | Number of artifacts indexed |
| `search_calls_count` | search endpoint | Always 1 per request |
| `result_count` | search endpoint | Number of search results returned |

Log format: `{"ts":"...","level":"info","component":"miniapp-server","msg":"...","taskId":"...",...}`

## Rollout Steps

1. **Deploy with defaults** — all flags true. v2 is active, v1 tasks unaffected.
2. **Monitor logs** — verify `resultSource: "v2_summary"` appears for new tasks.
3. **Manual check** — fetch a known v1 task and a v2 task via `/summary`:
   ```bash
   # v1 task — should show resultSource: "v1_stdout"
   curl /api/v1/miniapp/tasks/OLD_TASK_ID/summary

   # v2 task — should show resultSource: "v2_summary", indexed: true
   curl /api/v1/miniapp/tasks/NEW_TASK_ID/summary
   ```
4. **If issues** — set `RESULT_V2_ENABLED=false`, restart. All reads revert to v1.
5. **Search validation** — post a search query against a v2 task with indexed artifacts.

## Backward Compatibility

- v1 tasks (no `resultVersion`) continue to work exactly as before
- `getTask()` returns the same shape — `resultVersion` and `artifacts` are optional
- The `/tasks` list endpoint is unaffected
- Resume, events, and SSE endpoints are unaffected
- All 230 existing tests pass with no changes
