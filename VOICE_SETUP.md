# Voice transcription (faster-whisper)

Установлено: `faster-whisper` (user site-packages).

## Быстрый запуск

```bash
python3 scripts/transcribe_voice.py /path/to/voice.ogg
```

Первый запуск скачает модель (по умолчанию `small`).

## Полезные параметры

```bash
# Быстрее и легче
python3 scripts/transcribe_voice.py voice.ogg --model base --language ru

# Автоопределение языка
python3 scripts/transcribe_voice.py voice.ogg --language auto

# JSON-вывод
python3 scripts/transcribe_voice.py voice.ogg --json
```

## Переменные окружения (по желанию)

- `FW_MODEL` (default: `small`)
- `FW_DEVICE` (`cpu`/`cuda`, default: `cpu`)
- `FW_COMPUTE` (`int8`/`float16`/`float32`, default: `int8`)
- `FW_LANG` (`ru`/`en`/`auto`, default: `ru`)

Пример:

```bash
export FW_MODEL=base
export FW_LANG=ru
python3 scripts/transcribe_voice.py voice.ogg
```
