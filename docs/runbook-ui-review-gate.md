# UI Review Gate — Phase 5A

## Overview

The UI review gate adds a mandatory Playwright-based smoke test stage to the worker
workflow for frontend tasks. When enabled, tasks with `uiReview: true` must pass
UI smoke tests (Dashboard, Tasks list, Task detail, Inbox, Reviews on desktop + mobile)
before completion.

## Workflow

```
implement → [review] → ui_review → done
```

**With orchestrated loop:**
```
implement → review [→ patch → re-review]* → ui_review → done
```

If UI review fails, the task is blocked with status `ui_review_fail`.

## Configuration

| Env Var | Default | Description |
|---------|---------|-------------|
| `UI_REVIEW_ENABLED` | `false` | Feature flag — must be `true` to activate gate |
| `UI_REVIEW_CMD` | `./miniapp/scripts/ui-review-gate.sh` | Path to the smoke runner script |
| `UI_REVIEW_TIMEOUT_MS` | `120000` | Timeout for Playwright run (ms) |

## Task Flags

| Flag | Type | Description |
|------|------|-------------|
| `uiReview` | `boolean` | Per-task flag — when `true` and `UI_REVIEW_ENABLED=true`, the gate runs |

## Terminal Statuses

| Status | Meaning |
|--------|---------|
| `ui_review_pass` | All Playwright smoke tests passed |
| `ui_review_fail` | One or more smoke tests failed — blocks completion |

## Smoke Runner

`miniapp/scripts/ui-review-gate.sh`:

- Builds the Nuxt app if stale
- Runs `e2e/smoke.spec.ts` via Playwright (chromium + chromium-desktop projects)
- Captures screenshots to `e2e/results/screenshots/`
- Writes structured report to `e2e/results/report.json`
- Outputs `artifact: <path>` lines for the worker to parse
- Exit 0 = pass, Exit 1 = fail, Exit 2 = build failure

## Artifacts

On each run, the gate produces:

- **Screenshots**: `miniapp/e2e/results/screenshots/*.png` — desktop + mobile captures
- **Report**: `miniapp/e2e/results/report.json` — structured JSON with verdict, timing, counts
- **Playwright output**: `miniapp/e2e/results/playwright-output.json` — raw Playwright JSON

## Telemetry Events

| Event Status | Phase | When |
|--------------|-------|------|
| `progress` | `ui_review` | Before running smoke tests |
| `ui_review_pass` | `ui_review` | All smoke tests passed |
| `ui_review_fail` | `ui_review` | Smoke tests failed — includes `uiReviewArtifacts` in meta |

## Backward Compatibility

- Tasks without `uiReview: true` are unaffected
- When `UI_REVIEW_ENABLED=false` (default), the gate is completely inactive
- Existing `review_pass`/`review_fail` statuses still work for non-UI tasks

## Testing

```bash
node test-ui-review-gate.js
```

Covers: pass/fail for single-shot + orchestrated loop, backward compat, telemetry events.
