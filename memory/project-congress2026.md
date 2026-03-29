# project-congress2026 (persistent context)

## What this is
Long-lived memory for the user's current studio project (`Bold-Friday/congress2026`) and orchestration workflow decisions.

## Project profile
- Domain: Financial Congress site (production: https://ifcongress.ru)
- Stack: Nuxt 4 + Vue 3, JS-only app layer, Pinia, Nitro server routes, i18n ru/en, GSAP, Zod
- Package/runtime: pnpm, Node >=22

## Hard constraints
- JS-only in `app/` (no TS there unless explicitly requested)
- Composition API + `<script setup>` only
- No `<style>` blocks in Vue SFCs; styles in `app/assets/css/`
- No hardcoded user-facing strings; use i18n keys and locale files
- Use runtimeConfig in app code (avoid direct process.env)
- Work in feature branches; main protected; user controls final commits

## Workflow decisions (assistant + user)
- Use proof-based orchestration: plan -> implement -> review -> tests -> (ui_verify for UI tasks) -> ready_pr
- Task bundle artifacts expected for non-trivial tasks:
  - spec.md
  - test-plan.md
  - evidence.md
  - verdict.json
- UI verify flag model:
  - `ui_verify_mode=auto` default
  - `ui_verify_mode=strict` for critical UI
  - `ui_verify_mode=off` only with reason + human ack

## Current known reality/risk
- Automated test coverage currently very low/none in practice (despite aspirational targets)
- Mock API is central for dev and can diverge from real backend contracts
- Need extra care around lifecycle gating, payment/integration flows, env/secret hygiene

## Communication/operating preferences (from USER.md + session)
- Relaxed tone, but sharp/critical on important decisions
- Proof-based progress updates for long actions
- Avoid blind agreement; highlight risks explicitly
- Persist context to files to survive session resets

## Continuity protocol for future sessions
1. Read this file first for project orientation.
2. Read latest daily memory note (`memory/YYYY-MM-DD.md`).
3. Ask user only for delta: active branch/task + new constraints.
4. Update this file when significant workflow/project decisions change.
