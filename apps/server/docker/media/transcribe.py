"""Transcribe an audio file with faster-whisper and print the segments as JSON lines.

Usage: transcribe.py <audio> [model]
Each line: {"start": seconds, "end": seconds, "text": "..."}; a final {"language": ..., "duration": ...}.
The model downloads into $HF_HOME on first use (a mounted cache, so only once).
"""
import json
import sys

from faster_whisper import WhisperModel


def main() -> None:
    audio = sys.argv[1]
    model_name = sys.argv[2] if len(sys.argv) > 2 else "small"
    model = WhisperModel(model_name, device="cpu", compute_type="int8")
    segments, info = model.transcribe(audio, vad_filter=True)
    for s in segments:
        print(json.dumps({"start": round(s.start, 2), "end": round(s.end, 2), "text": s.text.strip()}, ensure_ascii=False), flush=True)
    print(json.dumps({"language": info.language, "duration": round(info.duration, 1)}))


if __name__ == "__main__":
    main()
