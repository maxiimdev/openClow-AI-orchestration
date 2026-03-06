# Slice C — Proof Report

**Branch**: `feature/miniapp-mvp`
**Date**: 2026-03-06

## Scope Delivered

### 1. Needs Input Inbox Screen (`/inbox`)
- Lists tasks with `needs_input` status via `useTasksList({ status: 'needs_input' })`
- Shows question text + option buttons + free-text textarea per task
- Loading state: 3 skeleton placeholders
- Empty state: "No pending questions" message
- Error state: error message + retry button
- Stale indicator: amber banner when SSE is degraded (from Slice B)
- Task ID links to detail page

### 2. Resume Action Flow
- **ResumeForm component**: option selection populates textarea; free-text override allowed
- **Validation**: `validateResumePayload()` enforces non-empty, ≤5000 char, string-typed answer
- **POST /api/v1/miniapp/tasks/{id}/resume**: sends `{ answer }` payload
- **Optimistic UI**: on submit, immediately updates task to `running` status and removes from `needs_input` list
- **Rollback on failure**: restores previous task state and list state if API call fails
- **onSettled**: always invalidates queries for server consistency

### 3. Task Status Updates
- After successful resume, task transitions from `needs_input` → `running` (optimistic)
- Detail page wired with `@resumed` handler to refetch task data
- SSE `task_update` events continue to invalidate relevant queries (from Slice B)
- Polling fallback active when SSE is degraded (from Slice B)

### 4. Basic Validation
- Empty answer: submit button disabled via `canSubmit` computed
- Whitespace-only: disabled at button level (`.trim()` check)
- Oversized answer (>5000 chars): caught by `validateResumePayload()`
- Duplicate submits: button disabled while `isPending` is true, shows "Sending..." text
- Validation errors displayed inline below submit button

## Quality Gates

### Typecheck
```
$ npx vue-tsc --noEmit
(clean — no errors)
```

### Lint
```
$ npx eslint .
2 warnings (pre-existing shadcn-vue props — not from Slice C)
0 errors
```

### Tests
```
$ npx vitest run
8 files | 96 tests | 96 passed

  test/resume.test.ts        — 15 tests (validateResumePayload + buildResumePayload)
  test/inbox-page.test.ts    — 12 tests (inbox rendering + resume success/failure/validation)
  test/filters.test.ts       — 11 tests (pre-existing)
  test/mappers.test.ts       — 16 tests (pre-existing)
  test/sse.test.ts           — 12 tests (pre-existing)
  test/events.test.ts        — 11 tests (pre-existing)
  test/task-detail-page.test — 11 tests (pre-existing)
  test/tasks-page.test.ts    — 8 tests (pre-existing)
```

## File-Level Changelog

| File | Change |
|------|--------|
| `app/lib/resume.ts` | **NEW** — `validateResumePayload()`, `buildResumePayload()` validation helpers |
| `app/composables/useTasks.ts` | **MODIFIED** — `useResumeTask()` now has optimistic update + rollback via `onMutate`/`onError`/`onSettled` |
| `app/components/ResumeForm.vue` | **MODIFIED** — integrated `validateResumePayload()`, `canSubmit` computed, `validationError` display |
| `app/pages/tasks/[id].vue` | **MODIFIED** — added `@resumed="refetchTask()"` on ResumeForm |
| `server/lib/mock-data.ts` | **MODIFIED** — added second `needs_input` mock task (`task-002b-env-config`, no options) |
| `test/resume.test.ts` | **NEW** — 15 unit tests for resume payload validation |
| `test/inbox-page.test.ts` | **NEW** — 12 smoke tests for inbox page rendering + resume flow |

## Commands Run
```
npx vitest run                    # 96 tests passed
npx vue-tsc --noEmit              # clean
npx eslint .                      # 0 errors, 2 pre-existing warnings
```

## What Remains for Slice D

1. **Review Center** (`/reviews`) — wire review findings display, verdict actions
2. **Real backend proxy** — replace mock-data server handlers with proxy to orchestrator API
3. **SSE server-side replay** — `lastEventId` replay logic (param accepted but currently ignored)
4. **Real Telegram auth** — `initData` HMAC validation (currently mock-accepts-anything)
5. **E2E tests** — full Nuxt integration tests with `@nuxt/test-utils`
6. **Dashboard stats** — wire real counts from API (currently hardcoded)
