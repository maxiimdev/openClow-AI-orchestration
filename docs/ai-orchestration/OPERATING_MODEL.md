# OPERATING MODEL v1.1

## 1) Цель системы
- Стабильный путь: `ticket → implementation → review/tests → PR`
- Минимум хаоса, максимум проверяемости
- Human-in-the-loop на ключевых решениях

---

## 2) Source of Truth
- Единственный актуальный live-статус: `PLAN_SYNC.md`
- `TODO.worker-miniapp.md` = roadmap/архив (не оперативный статус)
- Любой milestone update делается в том же PR/commit, что и изменение поведения

---

## 3) Task Contract (обязателен перед стартом)
Каждая задача фиксирует:
- Scope: что входит / что не входит
- Mode: `test-first` или `ui-first`
- DoD: критерии готовности
- Risks: 2–5 high-risk веток
- Proof pack: `taskId`, `commit`, `test output`, `PR URL`
- Rollback plan: как откатить/изолировать фейл

---

## 4) Политика тестирования
- По умолчанию: `test-first` для логики/контрактов/состояний
- Frontend exception: `ui-first` допустим для визуальных задач
- Для `ui-first` обязательно:
  - acceptance criteria до старта
  - smoke/integration/e2e (или эквивалент)
  - регрессионные проверки перед `ready_pr`

---

## 5) Git Discipline
- Рабочие задачи только в ветках `feature/*`
- `main/master` — без прямых task-коммитов
- Операционные файлы (например `data/queue.json`) не смешивать с продуктовым кодом
- В nested repo: коммит только в “своём” репо по явному правилу

---

## 6) Quality Gate перед `ready_pr`
Задача не проходит, пока нет:
- доказательств тестов
- review findings + фиксов
- подтверждения high-risk checks
- списка остаточных рисков (если есть)
- UI verify артефактов для задач, где есть UI-изменения

---

## 7) Review Loop Rules
- Max 2–3 итерации fix/review
- После лимита без сходимости → `escalated`
- Каждый review-цикл обязан содержать:
  - severity
  - file refs
  - required actions
  - re-check criteria

---

## 8) Стандарты статусов в чат
- Для долгих операций: `start / progress / finish`
- Только proof-based апдейты: `taskId`, `commit`, `path`, `log snippet`
- Никаких “сделал” без проверяемого артефакта

---

## 9) Miniapp как командный центр (MVP)
Обязательные экраны:
- Active tasks + blocker reason
- Needs input queue + SLA timer
- Task detail timeline (events/artifacts)
- Review panel (pass/fail/escalated + why)

---

## 10) KPI системы (ежедневный минимум)
- Lead time: `ticket → PR`
- Rework rate: число fix-итераций
- Escape bugs после merge
- Token/task cost
- `% задач с полным proof pack`

---

## Быстрый старт (P0 → P1)
1. Закрепить документ в `docs/ai-orchestration/OPERATING_MODEL.md`
2. Привести `PLAN_SYNC.md` к роли единственного live-status
3. Добавить task-template (contract) в docs
4. Включить quality-gate checklist в PR flow
5. Утвердить git-policy по `feature/*` + nested repo
6. Для UI-изменений подключить browser verify по `UI_VERIFY_PROTOCOL.md`
