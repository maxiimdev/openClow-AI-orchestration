# TODO — Worker hardening + Mini App (2026-03-05)

Owner: maxxim + bratok
Status: active

## North Star (на ближайшие сутки)

1. Довести worker/review-flow до надежного состояния через независимый Opus code-review loop.
2. Полностью закрыть этапы 1–4 по worker (implementation + independent review + fixes + re-review).
3. Только после этого — этап 5 (reliability guardrails).
4. Параллельно спроектировать и начать пилить Mini App для интерактивного мониторинга задач.

---

## Track A — Worker hardening (priority P0)

### A1. Починить баги review-flow (блокеры из Sonnet/Opus)
- [ ] False `needs_input` после успешного review-отчета
- [ ] Терминальные review-статусы должны закрывать task корректно (`review_pass/review_fail/review_loop_fail/escalated`)
- [ ] Убрать/нормализовать дубли и мусорные internal ошибки в уведомлениях
- [ ] Проверить timeout/event dedupe

### A2. Пройти этапы 1–4 заново в строгом цикле
- [ ] Реализация изменений
- [ ] Independent review (Opus, fresh context)
- [ ] Fix pass по findings
- [ ] Re-review (fresh context)
- [ ] Повторять до clean pass

### A3. DoD для Track A
- [ ] Нет ложных `needs_input` на завершенных review-задачах
- [ ] Уведомления user-facing только по нужным статусам
- [ ] Все review-loop тесты зеленые
- [ ] Есть proof-based лог/отчет по финальному прогону

---

## Track B — Этап 5 (после Track A)

- [ ] lease timeout для claimed
- [ ] retry policy на сетевые ошибки
- [ ] dead-letter для фатальных задач
- [ ] idempotency keys
- [ ] тесты и proof-report

DoD:
- [ ] recover после падений/таймаутов без ручного шаманства
- [ ] нет duplicate execution при повторных enqueue/retry

---

## Track C — Mini App (параллельно, non-blocking)

### C1. Product idea / value
- [ ] Сформулировать MVP: зачем mini app лучше простых Telegram сообщений
- [ ] Определить ключевые сценарии: "что сейчас выполняется", "почему залипло", "что требует моего решения"

### C2. MVP экраны
- [ ] Active tasks (live status + прогресс)
- [ ] Task details (таймлайн событий, branch/model/worker, duration)
- [ ] Needs input queue (быстрый ответ)
- [ ] Review panel (pass/fail, findings summary)

### C3. UX фичи
- [ ] Прогресс-бар по этапам (validate → git → claude → report)
- [ ] Цветовые статусы + severity badges
- [ ] Быстрые действия: retry / resume / cancel / open logs
- [ ] История и фильтры (по worker, branch, model, status)

### C4. Техническая база
- [ ] API контракт для mini app
- [ ] polling/websocket стратегия
- [ ] auth/session для Telegram mini app
- [ ] базовая админка/отчетность

---

## Execution mode на ближайшие 24 часа

- Worker hardening (P0) — 70%
- Mini App MVP discovery + skeleton — 30%

Правило: никакого расширения scope, пока не закрыты P0 блокеры по worker.

---

## Next immediate actions

1) Дождаться результата текущей `feature/review-flow-hardening` задачи.
2) Запустить Opus review на изменения.
3) Зафиксировать findings → patch → re-review loop до clean pass.
4) После clean pass — старт этапа 5.
5) Параллельно открыть отдельную ветку под Mini App MVP skeleton.
