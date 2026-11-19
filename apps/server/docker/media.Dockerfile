# Video tooling in a box: yt-dlp to fetch metadata, subtitles and audio; faster-whisper (CPU, int8) to
# transcribe when a video has no subtitles. Agent Hub runs one short-lived container per step, with
# only the task's video directory and a model cache mounted.
FROM python:3.12-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# av is pinned: faster-whisper 1.2.1 passes av.open(metadata_errors=...), which PyAV 16+ removed.
RUN pip install --no-cache-dir "yt-dlp==2026.8.19" "faster-whisper==1.2.1" "av==15.1.0"

COPY media/transcribe.py /usr/local/bin/transcribe.py
