# Phase 5C: Release Hardening & Observability

## Overview

Adds release checklist automation for critical flows and runtime health telemetry
for stale-data/SSE fallback/cache behavior, with a concise operator status surface.

## Release Checklist

### Usage

```bash
# Dry-run (no live server needed — validates file structure)
npx tsx scripts/release-checklist.ts --dry-run

# Against a running instance
MINIAPP_BASE_URL=http://localhost:3000 npx tsx scripts/release-checklist.ts
```

### Checks (14 total)

| # | Check | What it validates |
|---|-------|-------------------|
| 1 | Dashboard page loads | GET / returns 200 |
| 2 | Tasks list API responds | GET /api/v1/miniapp/tasks returns tasks array |
| 3 | Tasks page loads | GET /tasks renders |
| 4 | Task detail page loads | GET /tasks/:id renders |
| 5 | Reviews page loads | GET /reviews renders |
| 6 | SSE stream endpoint exists | GET /api/v1/miniapp/stream returns non-404 |
| 7 | Health telemetry endpoint | GET /api/v1/miniapp/health returns status |
| 8 | StaleIndicator component | File exists |
| 9 | SSE client module | File exists |
| 10 | Connection store stale detection | isStale computed property present |
| 11 | Task cache module | File exists |
| 12 | Health telemetry module | File exists |
| 13 | Review workflow helpers | File exists |
| 14 | Test files coverage | >= 5 test files in test/ |

Exit code 0 = all pass, exit code 1 = blocked.

## Runtime Health Telemetry

### Endpoint

```
GET /api/v1/miniapp/health
```

No authentication required (operator endpoint).

### Response Schema

```json
{
  "status": "healthy | degraded | unhealthy",
  "uptime_seconds": 3600,
  "data_mode": "mock | orch",
  "feature_flags": { ... },
  "sse": {
    "connections_total": 42,
    "disconnects_total": 3,
    "current_connections": 2,
    "polling_fallbacks_total": 1
  },
  "api": {
    "requests_total": 150,
    "errors_total": 2,
    "error_rate_pct": 1.33,
    "latency_p50_ms": 12,
    "latency_p95_ms": 45,
    "latency_p99_ms": 120
  },
  "cache": {
    "size": 15,
    "hits": 200,
    "misses": 30,
    "hit_rate_pct": 86.96
  },
  "degradations": [
    { "what": "polling_fallback", "why": "Client entered polling fallback after SSE retries exhausted", "when": "2026-03-07T12:00:00Z" }
  ],
  "checked_at": "2026-03-07T12:05:00Z"
}
```

### Status Logic

| Status | Condition |
|--------|-----------|
| healthy | No degradations |
| degraded | 1-2 degradations, or all SSE connections lost |
| unhealthy | >2 degradations and >25% API error rate |

### Tracked Degradations

| Key | Trigger | Auto-clears |
|-----|---------|-------------|
| `sse_down` | All SSE connections lost | On new SSE connect |
| `polling_fallback` | Client exhausted SSE retries | Manual |
| `api_errors_high` | >10% error rate over 50+ requests | On rate decrease |

### Instrumented Paths

- **SSE stream** (`stream.get.ts`): connect/disconnect counters
- **Tasks list** (`tasks/index.get.ts`): API latency + error tracking
- **Task cache** (`task-cache.ts`): getCacheSize() for cache monitoring

## Files Changed

| File | Change |
|------|--------|
| `scripts/release-checklist.ts` | New: 14-check release automation |
| `server/lib/health-telemetry.ts` | New: telemetry counters + health report |
| `server/api/v1/miniapp/health.get.ts` | New: health endpoint |
| `server/api/v1/miniapp/stream.get.ts` | Wire SSE connect/disconnect telemetry |
| `server/api/v1/miniapp/tasks/index.get.ts` | Wire API latency telemetry |
| `test/health-telemetry.test.ts` | New: 9 tests for telemetry module |
| `docs/RELEASE-HARDENING.md` | This file |

## Test Results

```
23 test files passed, 385 tests passed (0 failed)
```
