#!/usr/bin/env python3
import argparse
import json
import os
from faster_whisper import WhisperModel


def main() -> int:
    parser = argparse.ArgumentParser(description="Transcribe voice/audio with faster-whisper")
    parser.add_argument("input", help="Path to audio file (ogg/mp3/m4a/wav/...)" )
    parser.add_argument("--model", default=os.getenv("FW_MODEL", "small"), help="Whisper model size (tiny/base/small/medium/large-v3)")
    parser.add_argument("--device", default=os.getenv("FW_DEVICE", "cpu"), help="cpu or cuda")
    parser.add_argument("--compute-type", default=os.getenv("FW_COMPUTE", "int8"), help="int8/float16/float32")
    parser.add_argument("--language", default=os.getenv("FW_LANG", "ru"), help="Language code (ru/en/...) or auto")
    parser.add_argument("--json", action="store_true", help="Print JSON output")
    args = parser.parse_args()

    language = None if args.language.lower() == "auto" else args.language

    model = WhisperModel(args.model, device=args.device, compute_type=args.compute_type)
    segments, info = model.transcribe(args.input, language=language, vad_filter=True)
    segs = list(segments)
    text = " ".join(s.text.strip() for s in segs).strip()

    if args.json:
        out = {
            "text": text,
            "language": info.language,
            "language_probability": info.language_probability,
            "duration": info.duration,
            "segments": [
                {"start": s.start, "end": s.end, "text": s.text.strip()} for s in segs
            ],
        }
        print(json.dumps(out, ensure_ascii=False))
    else:
        print(text)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
