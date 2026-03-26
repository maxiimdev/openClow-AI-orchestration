# ROLLOUT_LOG — workflow v2

## 2026-03-26

### Goal
Внедрить безопасный rollout для workflow v2 без изменения runtime-логики worker.

### Completed
- Added `OPERATING_MODEL.md`
- Added `TASK_CONTRACT_TEMPLATE.md`
- Added `UI_VERIFY_PROTOCOL.md`
- Added `UI_EVIDENCE_TEMPLATE.md`
- Added task-bundle templates in `.agent/tasks/_template/`
- Updated `QA_GUARDRAILS.md` with mandatory UI verify block for UI tasks
- Updated `FLOW.md` with `ui_verify` state for UI tasks
- Updated docs index (`README.md`)

### Notes
- Rollout scope in this change: docs/templates only.
- No backend/worker runtime behavior changed.

### Next steps
1. Wire PR checklist to enforce new gates.
2. Run one pilot task in full mode (`spec -> build -> evidence -> verify -> fix`).
3. Measure lead time/rework overhead and tune templates.
