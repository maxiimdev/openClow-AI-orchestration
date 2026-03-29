# Context Mode Rollout Log

Last updated: 2026-03-06 (UTC)

## Goal
Adapt context-optimization principles into our orchestrator/worker flow:
- keep chat/context compact
- move large raw outputs to artifacts
- preserve backward compatibility
- enable retrieval/search over stored outputs

## What was delivered

### Phase 1 — Result v2 + artifacts + truncation
- Task: `task-20260306T075512Z-context-mode-rollout-phase1-contract-artifacts`
- Commit: `b04ea56`
- Delivered:
  - `resultVersion: 2`
  - `artifacts[]` support in worker output model
  - artifact persistence (`data/artifacts/<taskId>/...`)
  - inline stdout cap (~8KB) + truncation marker
  - type/mapping updates and tests

### Phase 2 — SQLite FTS5 + search/summary API
- Task: `task-20260306T075512Z-context-mode-rollout-phase2-fts-search-api`
- Commits: `9729055`, `bbab432`
- Delivered:
  - SQLite + FTS5 search DB
  - chunker/indexer
  - `POST /api/v1/miniapp/tasks/:id/search`
  - `GET /api/v1/miniapp/tasks/:id/summary`

### Phase 3 — Integration flags + observability + compat
- Task: `task-20260306T075512Z-context-mode-rollout-phase3-integration-guards`
- Commit: `2abf0fc`
- Delivered:
  - feature flags:
    - `RESULT_V2_ENABLED`
    - `ARTIFACT_INDEXING_ENABLED`
    - `SEARCH_ENDPOINT_ENABLED`
    - `LEGACY_STDOUT_CAP_BYTES`
  - structured logging/observability fields
  - v2-preferred display with v1 fallback
  - rollout docs and compatibility tests

## Hotfix timeline

### Timeout regression fixed
- Symptom: immediate `claude process timed out` in ~100-200ms
- Fix: timeout logic corrected (no rollback)
- Verified: sanity and long-output tasks complete normally

### v2 fields dropped by orch-api fixed
- Symptom: `resultVersion/artifacts` were missing in `/api/task/:id`
- Root cause: `/api/worker/result` stored only `workerId/status/output/meta`
- Fix: persist/expose `resultVersion` and `artifacts`
- Verification task: `task-20260306T093904Z-v2-field-roundtrip-after-manual-patch`
- Verified result keys include:
  - `artifacts`
  - `resultVersion`
  - `meta`
  - `output`
  - `status`
  - `workerId`

### needs_input notification path fixed
- Fix commit (workspace): `7404a6f`
- Change: notify on `needs_input` in `/api/worker/result` path too (not only `/api/worker/event`)

## End-to-end proof snapshot

### Before (old behavior)
- Example task: `task-20260306T081929Z-context-mode-smoke-v2`
- `stdout_len`: ~107292
- `truncated`: `false`
- no `resultVersion`
- no `artifacts`

### After (new behavior)
- Example task: `task-20260306T094843Z-contextmode-e2e-check`
- `stdout_len`: ~8287
- `truncated`: `true`
- `resultVersion`: `2`
- `artifacts_count`: `1`

## Operational status
- Context optimization: **working**
- Backward compatibility: **working**
- needs_input flow: **working**
- Ready for monitored rollout: **yes**

## Next planned step
1. Worktree isolation mode (`task -> worktree`) with 2 parallel slots
2. Keep proof fields in each run (`worktreePath`, `branch`, `commit`)
3. Continue 2-3 day stability monitoring
