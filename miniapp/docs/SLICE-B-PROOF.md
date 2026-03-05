# Slice B — Proof Report

## File-Level Changelog

### New Files
| File | Purpose |
|---|---|
| `app/lib/events.ts` | Event dedupe (`dedupeEvents`), chronological sort (`sortEvents`), merge (`mergeEvents`) helpers |
| `test/events.test.ts` | 11 unit tests for dedupe, sort, merge helpers |
| `test/task-detail-page.test.ts` | 11 smoke tests for detail page rendering (meta, loading, error, empty, timeline, stale, result block) |

### Modified Files
| File | Change |
|---|---|
| `app/lib/sse.ts` | Added `backoffWithJitter()` — exponential backoff + 25% random jitter. SSEClient now uses jittered delays on reconnect. |
| `app/composables/useTaskEvents.ts` | Polling conditional on SSE state (disabled when `connected`). Uses `mergeEvents` for dedupe+ordering on each fetch. |
| `app/composables/useTasks.ts` | `useTasksList` and `useTaskDetail` polling conditional on SSE state — disabled when SSE is `connected`, 10s/5s when not. |
| `app/pages/tasks/[id].vue` | Added `StaleIndicator` at top. Added result block showing exit code, duration, stdout, stderr, truncated badge for completed/failed tasks. |
| `server/api/v1/miniapp/stream.get.ts` | Enhanced SSE stream: emits `task_update` events every 10s for running tasks (mock data). Accepts `lastEventId` query param. |
| `test/sse.test.ts` | Added 5 new tests: `backoffWithJitter` (bounds, exponential, cap, integer), `lastEventId` on reconnect. Updated timing in existing backoff/polling tests to account for jitter. |

## Quality Gates

### Typecheck
```
$ npx nuxi prepare && npx vue-tsc --noEmit
Types generated in .nuxt.
(exit 0)
```

### Lint
```
$ npx eslint .
2 warnings (pre-existing from Slice A: vue/require-default-prop in shadcn Badge/Button)
0 errors
```

### Tests
```
$ npx vitest run
✓ test/filters.test.ts (11 tests)
✓ test/mappers.test.ts (16 tests)
✓ test/sse.test.ts (12 tests)
✓ test/events.test.ts (11 tests)
✓ test/task-detail-page.test.ts (11 tests)
✓ test/tasks-page.test.ts (8 tests)

Test Files  6 passed (6)
Tests       69 passed (69)
```

### Test Coverage by Slice B Requirement

| Requirement | Tests |
|---|---|
| SSE backoff + jitter | `backoffWithJitter` bounds/exponential/cap/integer (4 tests) |
| SSE Last-Event-ID on reconnect | `sends lastEventId on reconnect` (1 test) |
| Event dedupe by id | `dedupeEvents` remove duplicates/empty/single (3 tests) |
| Event ordering by timestamp | `sortEvents` chronological/tiebreaker/immutable/empty (4 tests) |
| Event merge (dedupe + order) | `mergeEvents` merge/order/empty-existing/empty-incoming (4 tests) |
| Detail page meta block | task-detail-page: renders meta, id, status, mode, branch (1 test) |
| Detail page loading state | task-detail-page: shows loading (1 test) |
| Detail page error state | task-detail-page: shows error (1 test) |
| Detail page empty events | task-detail-page: shows empty (1 test) |
| Detail page timeline | task-detail-page: renders events (1 test) |
| Detail page stale indicator | task-detail-page: shows/hides stale (2 tests) |
| Detail page result block | task-detail-page: result, truncated, stderr (3 tests) |
| SSE→polling fallback | `falls back to polling after max retries` (existing, timing updated) |

## Commands Run
```bash
cd /Users/sigma/worker/miniapp
npx vitest run          # 69/69 pass
npx eslint .            # 0 errors
npx nuxi prepare && npx vue-tsc --noEmit  # clean
```

## What Remains for Slice C

1. **Needs Input screen** — `/inbox` page with inline ResumeForm (UI exists but not wired to real backend)
2. **Review Center** — `/reviews` page with FindingsPanel (UI exists but mock-only)
3. **Real backend proxy** — Replace mock-data handlers with proxy to orchestrator API
4. **SSE stream replay** — Server-side `lastEventId` replay logic (currently accepted but not used)
5. **Auth flow** — Real Telegram WebApp `initData` validation (currently mock)
6. **End-to-end tests** — Full Nuxt integration tests with `@nuxt/test-utils`
