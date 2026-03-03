# CLAUDE_RUN_TEMPLATE (Interruption-safe)

Используй этот шаблон перед запуском задачи в Claude Code.

## Task
{{TASK_SUMMARY}}

## Scope
- Разрешено: {{ALLOWED_SCOPE}}
- Запрещено: {{FORBIDDEN_SCOPE}}

## Acceptance Criteria
{{ACCEPTANCE_CRITERIA}}

## Definition of Done
{{DOD}}

## Interruption Policy
- AUTO: решай сам безопасные технические детали в рамках scope.
- CONFIRM: остановись и задай вопрос, если есть 2+ равнозначных бизнес-варианта или риск затронуть соседний модуль.
- STOP: обязательно остановись при риске данных/доступов, изменении API-контрактов или выходе за scope.

## Fallback rule
Если не уверен — выбирай наиболее безопасный вариант, не расширяй scope, и явно опиши компромисс в отчете.

## Output format
1) Что сделано
2) Что не сделано
3) Риски/компромиссы
4) Что проверить вручную
5) Следующий шаг
