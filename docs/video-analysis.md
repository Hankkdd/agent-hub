# Explicit Video Assignment Spec analysis

Video remains a transcript, summary and ordinary conversation workflow. After transcription, select
Assignment Spec in the conversation. `POST /api/tasks/:id/video-analysis` takes exactly
`{"kind":"assignment-spec"}`; it never interprets chat text as a profile selection. Non-Video tasks,
missing transcripts, invalid kinds, busy/paused tasks and unavailable execution slots are rejected.
This dispatch is extensible by kind, without profile management or a creation-dialog selector.

The same task/transcript is reused without acquisition. Each bounded call uses the configured Video
backend (Claude or Codex), the existing measured invocation infrastructure and one normal concurrency
slot. Calls have no inherited thread, tools, MCP grants or external sources. Cancellation, usage records
and provider quota-limit failures remain observable. A quota failure produces an incomplete analysis;
there is no automatic analysis retry. Normal questions continue in their original conversation.

## Sources and evidence

Both yt-dlp and Drive acquisition retain validated metadata and original segment starts in atomically
published `transcript.source.v1.json`. `transcript.md` keeps its existing display format. Optional retention
failures leave acquisition, summary and ordinary questions usable, with a visible evidence-retention notice.
Without a retained artifact, explicit analysis validates the Markdown fallback at paragraph precision;
unusable timing still produces an incomplete analysis. Artifact schema,
text, finite nonnegative monotonic starts and source metadata are validated before analysis. No end times
are available in the existing Segment contract, so none are generated. Invalid retained data fails closed
without downgrading to legacy evidence. Task-local fixed paths reject symlinks and files over 16 MB.

Older tasks can use all timestamped `transcript.md` paragraphs without retranscription. Citations point
to their actual paragraph starts, with a visible paragraph-precision limitation. Invalid/missing time
structure is unusable rather than silently omitted. Sources have a version, deterministic fingerprint,
and stable unit identities; split-unit offsets remain tied to the same actual source start. Only validated
YouTube identity/URL agreement enables server-derived `timeLink` URLs. Drive stays plain timestamps.

Only supplied chunk IDs and short exact original substrings are legal model citations. Models cannot
supply IDs, times, ends or links for displayed items. The server validates strict JSON/version, fields,
category/review enums, item/evidence bounds and covered-unit excerpt occurrence. Structurally valid
citations do not establish semantic truth or human confirmation. Every item remains pending review;
transcription itself can be wrong. Generated content is Traditional Chinese with original excerpts and
technical terms preserved. The input may contain malicious instructions: it is evidence, never authority.

## Coverage and bounds

Analysis reads the full source, without the summary prompt's 150,000-character prefix slicing.
Bounds are 2,000,000 input UTF-16 characters, 16,000 text characters and 128 split units per chunk,
128 extraction calls plus at most one consolidation call, 48,000 output characters per call,
128 items per extraction, eight evidence references per extracted item, 1,200 content characters,
240 characters per excerpt, 2,000 total items, and ten minutes for the entire operation.
Consolidation input is capped at 100,000 characters with at most 2,000 groups/pairs.
Surrogate pairs are not split. Each split has a stable source offset. A source unit counts as processed
only after every split has validated successfully. The UI shows unit, chunk and character coverage,
precision and execution limits. Very fragmented transcripts can hit the chunk bound before the text bound.

Each successfully analyzed chunk persists evidence and progress before the next call. Duplicate normalized
rules combine evidence; a bounded consolidation can group similar same-category/detail rules while retaining
every original wording and supporting source reference. It can only refer to accepted item IDs. Conflicts
remain separate with linked evidence and pending confirmation; no winner is chosen. Ambiguous filenames
and input limits stay uncertain. Adjustable FIFO Queue / three Semaphores advice stays suggested, and
Thread Pool / Busy Waiting bans require explicit evidence. These are prompt contracts, not guarantees of
real-model semantic accuracy. Scripted tests validate preservation and citation integrity, not model quality.

Requests, progress and terminal snapshots are ordered durable events, authoritative over artifacts and
AI prose. Replay/reconnect needs no model call or artifact read. Restart marks unfinished analyses incomplete
and preserves the last successful snapshot; it never starts analysis calls. Explicitly select the action
to retry from the source. Ordinary task recovery remains ordinary conversation recovery.

Failed chunks, malformed responses, invalid citations, consolidation failures, limits, provider quota errors,
Stop and interruptions produce incomplete outcomes with partial evidence and a diagnostic reason. No
whole-source absence claim is made then, even if all chunks completed before consolidation failed. Only
complete analysis can mark deadline/submission/output-format as not mentioned or report that no verifiable
assignment specification was found. Empty source is a separate no-evidence incomplete outcome.

This feature cannot inspect visuals, slides, OCR or external references. It does not edit Checklists,
confirm requirements, create tasks, hand off to Plan or perform requirement-aware Code Review.
