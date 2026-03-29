# UI VERIFY PROTOCOL v1

## Цель
Сделать UI-проверку воспроизводимой: агент проверяет поведение в браузере, сравнивает с макетом и оставляет доказательства в задаче.

## Режим включения (через флаг)
В Task Contract и run-prompt указывается `ui_verify_mode`:
- `auto` — default, включать для UI-задач
- `strict` — усиленная проверка (доп. viewport/state)
- `off` — пропуск UI verify только с причиной + human-ack

## Когда обязательно включать
- Новые/существенно измененные экраны
- Критичные пользовательские потоки (авторизация, формы, платежные/submit-флоу)
- Задачи с риском визуальной/UX-регрессии

## Можно не включать
- Микро-правки без изменения поведения
- Изменения, не затрагивающие UI

## Источники для сравнения
- Реальный UI (dev/stage URL)
- Макет (Figma frame/component)

## Обязательные проверки
1. **Rendering:** экран открывается без критичных JS ошибок
2. **Flow:** happy-path проходит
3. **States:** default/hover/focus/disabled/error/loading (где применимо)
4. **Responsive:** минимум 2 viewport (desktop + mobile)
5. **Accessibility baseline:** tab/focus не сломан, кликабельные элементы доступны

## Tolerance policy (по умолчанию)
- spacing: ±2px
- font-size: ±1px
- line-height: ±2px
- color: без заметных визуальных отклонений в ключевых элементах

> Для особо чувствительных экранов tolerance уточняется в Task Contract.

## Артефакты (обязательны)
- Скриншоты desktop/mobile
- Список отклонений (expected vs actual + delta)
- Console errors (если есть)
- Figma reference (link + frame id)

## Verdict rules
- `PASS`: нет критичных/major отклонений
- `FAIL`: есть критичные UI/UX/flow отклонения
- `ESCALATED`: конфликт требований/макета, нужен выбор человека
