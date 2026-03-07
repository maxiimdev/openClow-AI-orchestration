# Report Pipeline Systemic Audit — Root Cause & Remediation

## Executive Summary

Systemic review of the report generation/validation/finalization path identified **7 bypass paths** allowing empty `result` bodies to persist on terminal statuses (`completed`, `review_pass`, `review_fail`). All paths have been sealed with a unified invariant and expanded contract enforcement.

## Root Causes

### RC-1: `REPORT_CONTRACT_ENABLED` defaulted to `false`
- **File**: `worker.js:66`
- **Impact**: The entire `validateReportContract` check was bypassed by default. Empty/placeholder results passed through unchecked.
- **Fix**: Default changed to `true`. Operators can still disable via `REPORT_CONTRACT_ENABLED=false`.

### RC-2: Hard guard only covered `completed`, not `review_pass`/`review_fail`
- **File**: `worker.js:3560` (old line)
- **Impact**: Tasks ending in `review_pass` (review loops, orchestrated loops) or `review_fail` could persist with empty/whitespace result bodies.
- **Fix**: Replaced single-status guard with `enforceNonEmptyResultInvariant()` covering all three terminal statuses.

### RC-3: Report contract guardrail only checked `completed` status
- **File**: `worker.js:3371` (old line)
- **Impact**: `review_pass` and `review_fail` results with placeholder/short/empty bodies were never validated against the contract.
- **Fix**: Changed condition to `TERMINAL_REQUIRES_RESULT.has(result.status) && !RESULT_INVARIANT_EXEMPT_MODES.has(task.mode)`.

### RC-4: Report schema guardrail only checked `completed` status
- **File**: `worker.js:3421` (old line)
- **Impact**: `review_pass` results missing required schema sections passed unchecked.
- **Fix**: Expanded to cover `completed` and `review_pass`.

### RC-5: `allowShortReport` bypass undocumented
- **File**: `worker.js:798 (validateReportContract)`
- **Impact**: Any task with `allowShortReport: true` could bypass all contract checks, including empty result detection.
- **Status**: Preserved for legitimate use cases (e.g. dry_run synthetic output) but now documented.

### RC-6: `dry_run` mode lacked explicit exemption
- **File**: `worker.js:841`
- **Impact**: `dry_run` was exempted inside `validateReportContract` but not in the hard guard, creating inconsistency.
- **Fix**: `RESULT_INVARIANT_EXEMPT_MODES` set provides a single source of truth for exempted modes.

### RC-7: No telemetry on guard activations
- **Impact**: Empty result guard hits were invisible to operators. No counters for contract violations, retry outcomes, or schema repairs.
- **Fix**: Added `_telemetryCounters` with 7 counters, emitted in events and logs.

## State Machine — End-to-End Flow

```
claude subprocess → stdout (JSON with result field)
    ↓
extractClaudeResult(stdout) → result text
    ↓
parseNeedsInput(stdout) → needs_input detection
    ↓
parseReviewVerdict(stdout) → review_pass / review_fail
    ↓
enforceReviewGate(task, result) → review gate enforcement
    ↓
validateReportContract(stdout, task) → contract check (empty, placeholder, min length)
    ↓  [retry if enabled]
validateReportSchema(stdout, task) → schema check (required sections)
    ↓  [auto-repair if eligible, then retry if enabled]
enforceNonEmptyResultInvariant(task, result) → FINAL SAFETY NET
    ↓
apiPost("/api/worker/result", resultBody) → persist to orchestrator
```

## Before/After Behavior Table

| Scenario | Before | After |
|---|---|---|
| `completed` + empty result | `failed` (if `REPORT_CONTRACT_ENABLED=true`) | `failed` (always — contract enabled by default + invariant) |
| `review_pass` + empty result | `review_pass` (persisted with empty body) | `failed` (invariant blocks) |
| `review_fail` + empty result | `review_fail` (persisted with empty body) | `failed` (invariant blocks) |
| `completed` + whitespace-only | `failed` (hard guard) | `failed` (contract + invariant) |
| `completed` + placeholder "Done." | `completed` (if contract disabled) | `failed` (contract enabled by default) |
| `review_pass` + short body | `review_pass` (no contract check) | `failed` (contract now checks review_pass) |
| `dry_run` + empty | `completed` (mode exempted) | `completed` (exempt via `RESULT_INVARIANT_EXEMPT_MODES`) |
| `completed` + valid report | `completed` | `completed` (unchanged) |
| `review_pass` + valid report | `review_pass` | `review_pass` (unchanged) |
| Contract retry succeeds | `completed` (after retry) | `completed` (after retry, counter incremented) |
| Contract retry fails | `failed` | `failed` (counter incremented) |

## Telemetry Counters Added

| Counter | Description |
|---|---|
| `report_contract_fail` | Report contract violations detected |
| `empty_result_guard_hits` | Times the hard invariant blocked a terminal status |
| `retry_attempts` | Contract retry attempts |
| `retry_successes` | Contract retries that succeeded |
| `retry_failures` | Contract retries that failed again |
| `schema_repairs` | Successful schema auto-repairs |
| `schema_repair_failures` | Schema auto-repair attempts that failed |

Counters are emitted in event payloads (`telemetry` field) and structured log entries.

## Files Changed

| File | Change |
|---|---|
| `worker.js:66` | `REPORT_CONTRACT_ENABLED` default: `false` → `true` |
| `worker.js:747-754` | Added `TERMINAL_REQUIRES_RESULT`, `RESULT_INVARIANT_EXEMPT_MODES`, `_telemetryCounters`, `getTelemetryCounters()` |
| `worker.js:778-796` | Added `enforceNonEmptyResultInvariant()` |
| `worker.js:3372` | Report contract guardrail: `completed` → `TERMINAL_REQUIRES_RESULT` check |
| `worker.js:3375-3411` | Telemetry counter increments in contract/retry paths |
| `worker.js:3430` | Report schema guardrail: `completed` → `completed \|\| review_pass` |
| `worker.js:3464-3466` | Schema repair telemetry counters |
| `worker.js:3562` | Hard guard replaced with `enforceNonEmptyResultInvariant()` |
| `test-empty-result-invariant.js` | New: 12-check anti-regression test |
| `docs/report-pipeline-audit.md` | This document |

## Test Commands & Outputs

```bash
# Anti-regression test (all 12 checks)
node test-empty-result-invariant.js

# Existing report contract tests (all 13 checks)
node test-report-contract.js

# Flow hardening tests
node test-flow-hardening.js

# Dry run test
node test-dry-run.js
```

All tests pass with zero failures.

## Whitelisted Modes

| Mode | Exempt From | Reason |
|---|---|---|
| `dry_run` | All invariant checks | Produces synthetic `[DRY RUN]` output, no Claude subprocess |
| `tests` | Report contract min-length | May produce minimal output by design |

Per-task opt-outs:
- `allowShortReport: true` — bypasses contract min-length and placeholder checks
- `allowEmptyResult: true` — bypasses the hard invariant (must be explicitly documented)
