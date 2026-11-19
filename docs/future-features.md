# Future features

What Agent Hub is meant to grow into, kept apart from what is being shipped now (design.md). Each entry
says what it is for, the decisions already made, and the open questions. Order is the planned order.

Guiding rule (from workstream, the project this one learns from): **a new concept earns its place by
naming its reader**, who reads it and when. Build each feature concretely; extract shared layers only once
two or three features actually repeat something. In particular, no up-front "artifact system" or
"workspace" abstraction: an agent's outputs are events (`events` table), and a new kind of output is a new
event type with a renderer.

## Known risk: drift between a plan and its implementation

The plan workflow discusses a change with the user, then starts an implement + review task with a spec.
The two tasks share no session: the implementing agents see only the spec. Whatever was discussed but not
written down is lost, and an ambiguous line can be read differently. This is deliberate (workstream's
director also hands a worker a brief, not its conversation: cheaper turns, rejected ideas do not leak
in, the reviewer is not the author), so the risk is managed rather than designed away.

Today: the spec must be self-contained (docs/guide/planning.md), the user reads the prefilled spec before
starting, the reviewer gets the spec, and the user compares the diff with it.

Next, in this order, once the plan workflow has been used on a few real changes:
1. **Acceptance criteria.** Every spec ends with numbered, checkable criteria and an out-of-scope list.
   The reviewer answers each one (met / not met / unclear) and flags changes outside the scope; an unmet
   criterion is a finding.
2. **Report back to the planner** (workstream's `reportsTo` + `report`). When the started task is
   approved, the plan task gets a message with the criteria results and a diff summary; the planner, which
   still has the conversation, tells the user what deviates from what was agreed before a PR is opened.
   Costs one planner turn per task.

## 1. Deploy (CD)

The Hub Deploy button has shipped: it confirms the displayed `origin/main` SHA and runs the deploy
script in a separately installed systemd user unit. See [the runbook](runbook/deploy.md).
A watchdog and automatic rollback remain future work.

Decided, following workstream's deploy (its `docs/runbook/deploy.md`):
- **Deploy is its own action, not a side effect of merging.** A "Deploy" button (or an agent request the
  user approves). Our turns die with the server, so the user picks a moment when nothing is running; the
  button refuses while a task runs.
- Deploy = back up the database (`VACUUM INTO`), fetch, check out the commit, install, build the web app,
  restart. **Refuse a dirty checkout.**
- **Separate checkouts:** the development checkout (`~/agent-hub`, where code is edited) is not the one that
  serves. Production runs from its own checkout, moved only by deploys; `data/` moves out of both to a
  fixed location.
- **systemd user service** (restart on failure) and a **watchdog** that remembers the commit that last
  served and rolls back to it after repeated failures. The unit files and watchdog live **outside the
  checkout** and are installed by hand: a deploy must not be able to break the way back.
- Unlike workstream we keep **GitHub Actions CI**: the user reviews and merges from a phone, so CI on the
  PR is the only test run before a merge.

## 2. Code understanding (review assistant)

While reviewing an agent's code (Diff tab, or a PR), select code and ask about it in a side panel:
**Explain**, **Why** (design choice, alternatives), **Source** (official docs, linked), **Diagram**
(Mermaid first: call flow, module structure), **Quiz** (check you understood).

- Answers separate what the agent **verified** (read in the code, quoted from a fetched document, with the
  link) from what it **explains** without checking.
- Needs web search and fetch as agent tools (Codex and Claude both have them built in; the Hub must allow
  them for this mode).
- Read workstream's `docs/guide/reading-assist.md` and `docs/guide/pr-assist.md` before designing: it has
  built both, a reading assistant and a PR briefing / Q&A.

## 3. Gemini as a third agent

The user has a Gemini student plan. A `GeminiAdapter` behind the same `AgentAdapter` interface, Gemini CLI
in headless mode, in a container like Codex, with its own login. Same tools (MCP), same workflows.

The login path is now the generic Antigravity CLI panel in the sidebar (see the [login runbook](runbook/antigravity-login.md)). It does not verify credentials or register a provider; model-backed verification belongs to the later Diff explanation adapter.

## 4. Usage-aware agent choice

Default agents per workflow as now; when an agent's plan usage passes a threshold (75%), the next task (or
the next round) uses the other agent for writing and moves this one to reviewing.

- Needs a usage reading per agent. Claude's SDK reports rate-limit events; Codex's catalog and stream
  carry some limits; Gemini unknown. Investigate before designing.
- workstream tracks per-account usage and pauses a backend at its limit (`src/agent/claude-pool.ts`,
  `account-usage.ts`); read those first.
- A switch is recorded on the task as an event (what was chosen and why), never as a hidden rule.

## 5. Document workspace (CV, SOP, Google Docs / Sheets)

Discuss a document with an agent in the Hub, see proposed changes as a diff, comment on passages, and only
on the user's confirmation write the change back to the original in Google Drive.

- **Writing to the cloud original always needs the user's confirmation** (the one approve-level action).
  Reading and drafting are free.
- **Version check before writing:** if the document changed in Drive since the agent read it, stop and show
  the conflict instead of overwriting newer edits.
- Google Docs first; Sheets/Excel later (formulas, formats, ranges need their own handling).
- Reuse the existing server-side Google connection and capability registry, extending consent incrementally
  for Docs and Sheets. Tokens stay under `data/google/`; agents access Google only through Hub MCP tools.
- Gmail read/search is planned; sending mail always requires explicit user confirmation.
- Google Picker is planned for Phase 2: prefer `drive.file` for selected files, with an HTTPS origin.
  The current arbitrary pasted Drive links continue to require `drive.readonly`.
- A course-video assignment-requirements extraction mode is planned separately; the current Video
  workflow retains its existing summary format.
- workstream's `docs/guide/writing-assist.md` is related prior art.

## 6. Learning workspace

A workflow that teaches: explain, show a diagram, ask, judge understanding from the answer, reinforce what
was missed, repeat. Quizzes are interactive cards in the transcript (an event type), answers are recorded,
and what was got wrong comes back later.

- Material can be a topic, a video transcript (the video workflow), a PDF, or code.
- Pictures: diagrams (Mermaid/SVG) first; generated images later.

## Quota-aware agent switching (future)

Usage-limit failures are recognised and labelled with reset times when available. Auxiliary PR metadata,
change briefings and diff explanations now fall back to the other configured agent when quota is
exhausted up front, or retry once after a usage-limit failure. Switching implement/review authors
and reviewers remains future work.

The sidebar now displays live subscription quota for the configured Claude and Codex logins. These
in-memory readings expire and can be unknown, unavailable or stale; restart discards the cache.
Normal-turn agent switching and quota-based scheduling remain future work and must account for independent
buckets, provider failures and reset boundaries before using these readings to make decisions.

## Project findings and document writing (#12)

The first phase of #14 now associates a local `documentsDir` with a project for read-only planning:
live README bootstrap, bounded discovery/literal search/line reads, and self-contained worker briefs.
It does not record findings in the document repository, write documents or commit them. A later #12
workflow must define readers, durable finding records, write approval and conflict handling before
adding any document mutation. No wiki, curator, pinning, embeddings, Jira/Notion access or document
editor is part of the current phase; `jira-ticket/` remains excluded.

## Finding governance boundaries

Out-of-scope discovery recording, fixed governed Tech Debt / Draft note export and advisory diff
estimates are implemented through existing task options/events. Future work may support other explicit
document governance profiles. Arbitrary README/template interpretation, semantic deduplication,
knowledge curation, document editing/promotion/resolution, automatic tickets and documentation Git
synchronization remain outside this implementation.

### Shipped whole-change reference card (#13)

Explicit implementation PR preparation/opening now generates or reuses a versioned Traditional Chinese
briefing in Hub and a collapsible PR appendix, preserving the main template's configured language and
team confirmation/editing. Captured cumulative source, saved evidence and safely read explanation-style
guides bind validity; stale/failed results require explicit prepare/retry/rewrite and never retry a model
on startup or viewing. Each new generation uses one isolated tools-disabled call with finite coverage,
output and runtime limits ([configuration](configuration.md#whole-change-pr-briefing)). Source Diff and hunk explanations remain available. The Mermaid
renderer is local, bounded, strict and has readable source fallback. Interactive Q&A, quizzes/read
marks, slides, imported PRs and general artifact/learning systems remain future work.

## Pinned shortcut follow-ups

Global server-persisted task/conversation shortcuts now appear above project groups and retain the
original trees and counts. Devices on one server share stable earliest-pin order, with independent
parent/child pins and re-pins appended. Drag/manual ordering, numbered slots, keyboard shortcuts,
pin limits and per-user pin ownership remain deferred; no worker folding or hiding is planned here.

## Explicit agent handoff (#8)

Phase 1 now supports explicit Codex/Claude handoff within an existing quiescent chat or planning task,
with one isolated outgoing summary call, persisted peer context, bounded recent original dialogue and
actual eligible images with explicit omissions. Every destination is a fresh session, including switching
back; task/proposal/worker identity remains. Switching starts no target work and grants no planning
approval. Failures retain the source; startup never retries. [Configuration](configuration.md#change-agent-within-chat-or-planning-8-phase-1) documents costs, finite limits and
manual browser/real-model verification limits.

Implementation/reviewer/video/custom role switching, same-provider/model-only resets, retired-thread
resumption, automatic quota switching/retries, bulk historical-image replay/OCR, cross-task history
search and project handoff files remain outside this phase.

## Shipped issue requirement summaries (#7) and exclusions

Issue-bound proposals can now prepare a bounded Traditional Chinese summary in their existing turn;
users edit/preview/save and separately confirm a versioned public issue comment. The English full
worker spec remains authoritative for dispatch, and the public source reference identifies its saved
proposal. Publication adds no model call and never gates start_task. Durable intents and exact bounded
reconciliation retain uncertainty instead of blindly retrying ambiguous GitHub writes.

Issue creation/body edits, labels/assignees/states, editing/deleting published comments, automatic
publication/retries, general model-facing comment write tools, tracker synchronization and translation
services remain excluded. A public requirements record is not implementation verification; findings
remain low-trust and cannot automatically create comments or tickets.
