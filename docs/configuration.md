# Configuration and operations

This guide retains the setup, configuration and workflow details from the original README.
For an introduction and first start, see [README.md](../README.md).

## Contents

- [Workflow overview](#workflow-overview)
- [Run and authentication](#run)
- [Install as an app](#install-as-an-app)
- [Configuration](#configuration): repository conventions, Discord, containers, devices and video
- [E3 tools](#e3-tools)
- [Checks](#check) and [repository layout](#layout)
- [Subscription allowance](#subscription-allowance) and [usage-limit pause](#usage-limit-pause)
- [Document workspace](#document-workspace)
- [Project documents](#project-documents-read-only-planning)
- [Observations and diff estimates](#out-of-scope-observations-and-diff-estimates)
- [Whole-change PR briefing](#whole-change-pr-briefing) and [pinned tasks](#pinned-conversations-and-tasks)
- [Agent handoff](#change-agent-within-chat-or-planning-8-phase-1)
- [Planning issue links](#durable-planning-issue-links) and [requirement comments](#user-confirmed-issue-requirement-comments-7)
- [Google Drive videos](#google-drive-videos) and [task usage records](#task-usage-records)
- [Update an existing PR](#update-an-existing-pr-after-its-target-advances)
- [Deployment](#deployment)

## Workflow overview

Tasks stream live, persist in SQLite and remain recoverable after a restart.

- **chat**: talk to one agent, optionally in a directory. Gemini is also available for isolated text
  chat when an Antigravity login and ARM64 Docker are present; it has no repository or tool access.
  See [Gemini chat setup and limits](runbook/gemini-chat.md).
- **room**: discuss one document with Claude and GPT in one chat. Each message runs one round;
  members offer different ideas and propose edits as suggestions for you to accept. Server API is
  available; the room UI is implemented separately. See [Rooms](design.md#rooms).
- **plan**: discuss a change with an agent in a read-only git checkout (Codex, high effort by default).
  Follow [the planning guide](guide/planning.md), agree on a self-contained spec, then agree to start an implement + review task in the conversation (or use **Start implementing**).
  The Hub reports results back to the planner, which can open the PR after you ask. Merging stays with you.
- **implement**: one agent changes a repo in its own git worktree; Agent Hub commits each turn, you read
  the diff (Monaco, side by side) and merge or discard.
- **review**: one agent implements, the other reviews (read-only), back and forth until approved or out
  of rounds; an optional test command runs after approval and a failure goes back to the author. Nothing
  is merged without you.

- **Devices** (sidebar): register machines once; every agent then has `list_hosts`, `ssh_exec` and
  `copy_file`, so it can run commands on them and move files between them (or to and from its own working
  directory) over SSH, without asking. Every command and copy is logged per device.

- **video**: paste a URL; Agent Hub fetches the transcript (the video's subtitles, or Whisper on the audio
  when it has none) and the agent writes a summary with linked chapters and key points, in Traditional
  Chinese unless your instructions are in another language. Then keep asking about it.

## Run

Toolchain is pinned with [mise](https://mise.jdx.dev) (Node 22, pnpm 10) because the system Node is too old.

```bash
mise install
mise exec -- pnpm install
mise exec -- pnpm dev        # server on 127.0.0.1:8787 + web on 127.0.0.1:5173 (proxies /api)
```

The server creates a token in `data/token` (`$AGENT_HUB_DATA/token`) on first start. It is never
printed: the startup log names the file only, because logs such as the systemd journal are kept and
readable. Open the web app once with `?token=<token>`; it is traded for an HttpOnly cookie and removed
from the address bar.

A chat bot that relays your replies while you are away (for example from Discord) should not hold that
token: it can deploy, run commands on devices and approve Claude's host tool calls. Set
`AGENT_HUB_REMOTE_API=1` and the server also creates `data/remote-token`, a bearer-only token limited to:
reading tasks, sending a task a message, stopping it, preparing and opening its PR, and starting chat,
implement or review tasks. Tasks it starts always use Codex (in its container), get no device tools, take
no custom test command, and implement/review only in repositories listed in `repos.json`. Everything
else answers 403, including approvals, merge, discard, deploy and devices. The list lives in
`apps/server/src/remote.ts`. A message it sends reaches the task's agent like one typed in the web app,
so keep the bot that holds it limited to you.

To reach it from another device on the tailnet, bind the web dev server to the tailscale IP. The API
server stays on loopback; only the dev server (which proxies to it) is exposed, and every API call
needs the token:

```bash
AGENT_HUB_HOST=<tailscale-ip> mise exec -- pnpm dev
```

Single-process mode (build the web app, serve it from the server): `mise exec -- pnpm start`.

## Install as an app

- **iPhone:** open Agent Hub in Safari, then **Share > Add to Home Screen**. Launch the
  home screen icon to use the app without Safari's toolbars, including over plain HTTP.
- **Desktop:** in Chrome or Edge, click the address bar's **Install** button when available.
  If it is absent, use Chrome's **Save and share > Install page as app** or Edge's
  **Apps > Install this site as an app** menu (wording varies by browser version).
  The automatic install button may be unavailable on the current plain HTTP tailnet URL.

Browser push notifications and offline support need HTTPS and a service worker; both are deferred
until the later Tailscale HTTPS change. Adding the app now does not enable those features.

The SVG source is `apps/web/public/icon.svg`. Regenerate the checked-in 180, 192 and 512 pixel PNGs
with `mise exec -- bash apps/web/scripts/generate-icons.sh`. This uses the pinned `sharp-cli@5.2.0`
via npx (network access is needed on the first run); normal builds use the existing PNGs.
The manifest and icon background use `#0a0a0a`, matching the dark `--background: oklch(0.145 0 0)`
token in `apps/web/src/index.css`.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `AGENT_HUB_HOST` | `127.0.0.1` | Interface the exposed server binds (web in dev, the server itself in `start`) |
| `AGENT_HUB_PORT` | `8787` | API server port |
| `AGENT_HUB_DATA` | `data` | SQLite db, token, scratch directories |
| `AGENT_HUB_REFERENCE_DIRS` | unset | Colon-separated absolute directories that planning agents can read as reference repositories; mounted read-only for Codex and added as readable directories for Claude. Missing directories are skipped with a log line. Other workflows never receive them |
| `AGENT_HUB_MAX_CONCURRENT` | `4` | Turns running at once across all tasks; more wait for a slot |
| `AGENT_HUB_CLAUDE_MODEL` | Claude Code's default | e.g. `haiku`, `sonnet`, `opus` |
| `AGENT_HUB_CLAUDE_PERMISSION` | `auto` | A classifier allows or denies each tool call and asks you in the web UI (Allow / Deny) only when it cannot decide. `bypassPermissions` runs everything unasked; `default` asks about anything that is not read-only |
| `AGENT_HUB_CLAUDE_SETTINGS` | `user,project,local` | Which Claude Code settings apply (CLAUDE.md, MCP servers, hooks) |
| `AGENT_HUB_EXPLAIN_AGENT` | `gemini` if registered, otherwise `codex` | Adapter for final committed diff explanations; explicit `gemini`, `codex` or `claude` overrides the default |
| `AGENT_HUB_EXPLAIN_EFFORT` | `low` | Reasoning effort for diff explanations (ignored by Gemini); at most one quota fallback, without affecting review/merge |
| `AGENT_HUB_CODEX_MODEL` | Codex's default | Model for Codex |
| `AGENT_HUB_TOOLS_PORT` | `8788` | Agent Hub's MCP tool server (ssh). Bound to the docker bridge gateway so Codex's containers reach it; each agent turn gets its own bearer token, revoked when the turn ends |
| `AGENT_HUB_E3SYNC_BIN` | unset | Absolute path to an [e3sync](#e3-tools) binary; agents get no E3 tools without it |
| `AGENT_HUB_CODEX_RUNTIME` | `docker` | `docker`: every Codex turn runs in a container (below). `host`: Codex on this machine with its own bubblewrap sandbox |
| `AGENT_HUB_CLAUDE_RUNTIME` | `host` | `docker`: every Claude turn runs in a container like Codex (below); needs `pnpm claude:login` first. `host`: Claude Code on this machine, guarded only by its permission mode |
| `AGENT_HUB_REMOTE_API` | unset | `1` creates `data/remote-token`, the limited bearer token for a relay bot (see above) |
| `AGENT_HUB_DISCORD_WEBHOOK` | unset | Secret Discord webhook URL; notifications are disabled without it. Only `https://discord.com/api/webhooks/<webhook-id>/<webhook-token>` or the same path on `discordapp.com` is accepted |
| `AGENT_HUB_DISCORD_MENTION` | unset | Optional Discord user ID to ping for tasks needing attention; only this user can be pinged |
| `AGENT_HUB_PUBLIC_URL` | unset | Optional web app base URL appended to Discord notifications, e.g. `http://<tailnet-host>:<web-port>` |

### Team repository conventions

Create `<dataDir>/repos.json` (the directory selected by `AGENT_HUB_DATA`), outside your
repositories. Keys are absolute repository root paths; `~` and `~/` are expanded when read.
For example, Acme API uses:

```json
{
  "/home/<user>/src/acme-api": {
    "base": "origin/main",
    "ticket": { "required": true, "pattern": "^ACME-[0-9]+$", "url": "https://example.atlassian.net/browse/{ticket}" },
    "branch": "{type}/{ticket}-{slug}",
    "commit": "{type}: {summary} ({ticket})",
    "prTitle": "[{ticket}] {type}: {summary}",
    "prLanguage": "en",
    "prTemplate": ".github/PULL_REQUEST_TEMPLATE.md",
    "testCommand": "make test",
    "agents": { "reviewer": { "agent": "claude", "model": "opus", "effort": "medium" } },
    "toolchain": { "go": "1.26.5" }
  }
}
```

Settings are validated and read at task creation without a restart, then saved with the task.
Repositories without an entry retain the existing local-HEAD base, branch, commit and PR formats.
All fields are optional. `base` must name an `origin/<branch>` ref: Hub fetches origin before
creating the worktree, leaving your checkout, branch, HEAD and uncommitted files untouched.
`ticket` requires a boolean `required` and a regular expression `pattern`; `url` is optional.
Enter a new ticket per task; Hub never remembers tickets in the dialog and never calls Jira.
The task header displays the saved ticket link. Test commands are prefilled and remain editable;
an explicitly empty command disables the default. The review workflow runs the command after approval.
`agents` optionally sets `author` and `reviewer` defaults in the new coding-task dialog.
Each role accepts optional `agent` (`codex` or `claude`), `model` (1-128 letters, digits,
dots, underscores or hyphens, starting with a letter or digit), and `effort`
(`low`, `medium`, `high`, `xhigh`, `max`). Unspecified values use the shared defaults:
Codex medium for the author and Claude sonnet medium for the reviewer. Manually edited
pickers keep their values when repository settings arrive. Explicit task requests take precedence.
`GET /api/repo-settings?path=...` exposes settings to the authenticated web app.

Clicking **Open PR** on a configured task resumes the author read-only with tools disabled to
produce validated JSON metadata. Hub supplies the PR template from inside the worktree, adds the
ticket link to Purpose if needed, squashes the private task history into one commit, and pushes
to the conventional remote branch. The local `agent-hub/...` branch is never published for these
tasks. Later rounds append conventional commits with the summary `address review feedback` and
push to the same remote branch without rewriting published history. The PR includes a short Agent Hub
note with author, reviewer, review rounds and test result. Invalid settings or metadata stop publishing.
If pushing succeeds but PR creation fails, retry **Open PR** to reuse the saved metadata and commit.

Templates support `{type}`, `{ticket}`, `{summary}` and `{slug}`; `{ticket}` needs ticket settings.
Types are `feat`, `fix`, `docs`, `refactor`, `ci`, `test` and `chore`. Without explicit templates,
configured tasks use `{type}/{slug}`, `{type}: {summary}` for commits and PR titles, and English.
`prLanguage` supports `en` and `zh-TW`. `prTemplate` must be a relative file path inside the
worktree, including when symlinks are involved.

`toolchain` maps simple mise tool names to versions (for example, `go` to `1.26.5`). Names
accept lowercase letters, digits, underscores and hyphens, starting with a letter; versions
accept letters, digits, dots, underscores, plus and hyphens, starting with a letter or digit.
Backend names, paths, whitespace and shell syntax are rejected. Every Codex container turn for
that task uses a derived image with those tools and `make`, including planning, review and diff
explanations. The image is built on first use with a visible activity line, then reused across
tasks with the same sorted tool list and base Codex image. Repositories without `toolchain`
use the plain Codex image. Go module and build caches persist in `<dataDir>/cache/go-mod` and
`<dataDir>/cache/go-build` across turns. Docker-runtime Claude uses the same images. Host-runtime
Claude and Codex, and Hub's host-side test command, require the operator to install the toolchain on
the host.

### Discord notifications

In the Discord channel, go to **Channel settings > Integrations > Webhooks > New Webhook > Copy Webhook URL**.
Set `AGENT_HUB_DISCORD_WEBHOOK=<webhook-url>` in the env file the service reads
(`~/.config/agent-hub/env` for the provided systemd user service), then restart the service with
`systemctl --user restart agent-hub`. Keep the webhook URL secret and outside the repo. Optionally set
`AGENT_HUB_DISCORD_MENTION=<discord-user-id>` and `AGENT_HUB_PUBLIC_URL=http://<tailnet-host>:<web-port>`.

Messages use multiple labelled lines: a Traditional Chinese action header, `任務：` for the task
title, then `問題：` (the question's first paragraph), `提案：` (proposal title), or `結果：`
(review rounds, test result, changed files and added/deleted lines, plus any review finding count).
Status notifications include `原因：` for waiting, failure or interruption when available, and `說明：`
from the first non-empty line of the first user message when it differs from the title. Questions,
proposals and reasons are limited to 300 characters; descriptions to 120. Original titles and text
are not translated. Known PR URLs appear on a separate `PR：` line. A valid http(s)
`AGENT_HUB_PUBLIC_URL` of at most 500 characters adds `開啟：` with a `task=<id>` deep link,
preserving the base path and other URL parameters. Ask, proposal and report links open the planning
conversation; reports show the worker's title and prefer its reported PR, falling back to its workspace
PR. Unavailable lines are omitted. Content is limited to 1999 characters while keeping both link lines
intact.

Approvals/questions, failures and interruptions send a normal
notification, with the optional user mention. Finishes for implement, review and video arrive silently;
chat and plan replies send no finish notification. A planning proposal sends a loud notification
asking you to confirm; starting that proposal does not notify again. Worker reports to a planning
conversation replace the worker's own finish, failure or permission notification. They notify loudly
after the planner's report turn ends, unless that turn calls `ask`: then only the decision card sends
a loud "需要你決定" notification. Ask cards stay at the bottom of the conversation until answered.
Sends time out after 10 seconds;
failures are dropped without retries and never hold up a task.

### Codex runs in a container

Each Codex turn runs the Codex CLI in a container (`apps/server/bin/codex-docker`, image from
`apps/server/docker/codex.Dockerfile`) that sees only the task's directory, mounted at the same path,
plus the main repo's `.git` read-only so `git status`/`diff` work but commits cannot happen from inside.
A reviewer gets that directory read-only; an author read-write. The container runs as your uid, so files
it writes are yours, and it is removed when the turn ends or is stopped.

Why: Codex's own sandbox (bubblewrap) needs unprivileged user namespaces, which stock Ubuntu 24.04 blocks
through AppArmor, and then every command Codex runs fails.

One-time setup (images are also built on first use):

```bash
mise exec -- pnpm images        # the Codex and media images
mise exec -- pnpm codex:login   # device code: open the printed URL, enter the code
```

The container has **its own Codex login** in `data/codex-home` (gitignored), separate from your
`~/.codex`: mounting that one would let an agent edit the config your host Codex reads.

With `AGENT_HUB_CLAUDE_RUNTIME=docker`, Claude gets the same boundary. Each turn runs the Claude Code
binary the installed Agent SDK ships, mounted read-only, in a container from the same image (and
toolchain image). The mounts are the same as for Codex: the task directory read-write, or read-only for
reviewers and planners; the main `.git` read-only; reference directories read-only. Only Claude Code's own
`ANTHROPIC_*`/`CLAUDE_CODE_*` variables cross in, never the server's environment. Claude has its own
login and conversation history in `data/claude-home`. Conversations started on the host are copied there
the first time they resume, so switching the runtime does not cut tasks off. In the container Claude no
longer sees the host's `gh`, `docker`, `ssh` or user-level Claude settings. Its MCP access is the Hub's
tools, as for Codex.

```bash
mise exec -- pnpm claude:login  # once, in a terminal; then set AGENT_HUB_CLAUDE_RUNTIME=docker
```

### Devices and SSH

Agent Hub makes its own SSH key on first start; a device gets only its public half. The Devices page
shows the setup steps for Linux, macOS and Windows with that key filled in; the same steps with
placeholders are in [docs/runbook/device-setup.md](runbook/device-setup.md). Use a dedicated,
least-privileged user on the device: that account's permissions are the real limit on what an agent can
do there. Mark production devices; agents are told to stay read-only on them unless the task says otherwise.

What the Agent Hub machine itself needs: [docs/runbook/host-requirements.md](runbook/host-requirements.md).

`copy_file` names a device path as `<host>:<path>` (`win:C:/Users/me/data.csv` on Windows) and anything
else as a path inside the task's own directory; absolute paths and `..` are refused, so it cannot reach the
rest of this machine. Device to device goes through this machine (`scp -3`), so the devices need no access
to each other.

How it runs: Agent Hub serves `list_hosts`, `ssh_exec` and `copy_file` over MCP. Claude connects from the host, Codex
from its container through the docker bridge, and the ssh itself runs on the host, so keys never enter a
container. Host keys are pinned on first contact in `data/ssh/known_hosts`; a changed key is refused.

Registering the Agent Hub machine itself lets agents (Codex included) run commands on it, outside the
container.

### Video

yt-dlp, ffmpeg and faster-whisper live in the media image (`apps/server/docker/media.Dockerfile`); every
step runs in a short-lived container that sees only `data/videos/<task>/`. Subtitles are preferred: a
human-made track, else auto-captions in the video's own language (never a machine translation). Without
either, the audio is transcribed with Whisper `small` on the CPU (int8; a 19s clip takes about 4s) and then
deleted. The model is cached in `data/media-cache/`. The full transcript is the task's **Transcript** button.

An API client that reads the transcript itself can create the task with `"transcriptOnly": true` in
`POST /api/tasks`: the task stops once the transcript is fetched, without a summary turn, and
`GET /api/tasks/:id/transcript` returns it. A later message in the task points the agent at `transcript.md`.

After transcription, explicitly select **Assignment Spec** in the Video conversation to extract assignment
rules on the same task. Ordinary summaries and free-form questions stay available; no analysis is selected
when creating a task or by typing a phrase. Analysis never downloads or transcribes the video again.
Results are read-only, in Traditional Chinese, with required/prohibited/suggested/uncertain categories,
pending/conflict review states, original evidence and coverage restored from durable events.
New sources retain original segment starts. Older `transcript.md` files use actual paragraph starts and
visibly show **paragraph precision**, without invented sentence times or ends. Verified YouTube sources
have timestamp links; Drive timestamps remain plain text. Transcription and interpretation can be wrong.
Only complete coverage can report missing details or no verifiable specification. Failed, stopped,
limited or restart-interrupted analysis retains partial evidence and stays incomplete; retry requires
selecting the action again. This is transcript-only analysis, without visual/OCR evidence, Checklist editing,
Plan handoff or requirement-aware review. See [Video analysis](video-analysis.md) for limits and validation.



## E3 tools

With `AGENT_HUB_E3SYNC_BIN` set, Claude and Codex can look up courses, assignments and
materials in an E3 learning management system, using a separately configured `e3sync` that holds the E3 session. `e3sync` runs on the host
for each call; the cookie never enters a Codex container. Chat tasks can also download a listed file into
the course's material folder, which never overwrites an existing file. Plan, implement and review tasks
can only look things up. Gemini gets no E3 tools, as it gets no tools at all. Deadline reminders stay in
`e3sync` itself and do not use a model.

## Check

CI checks document navigation, typecheck and tests on every push to main and every pull request.

```bash
mise exec -- node scripts/check-doc-navigation.mjs
mise exec -- pnpm typecheck
mise exec -- pnpm test       # the core against a scripted agent: no model, no quota
```

## Layout

```
apps/server/   Hono API + SSE, SQLite (drizzle), the core
  src/core/hub.ts      tasks, events, scheduler, chat workflow, restart recovery
  src/agents/          AgentAdapter interface, Claude and Codex adapters, a fake for tests
  src/workspace/git.ts worktrees: create, commit, diff, merge, discard
  src/tools/           device registry, ssh runner, and the MCP server both agents use
  test/                vitest, against the fake adapter
apps/web/      React + Vite + Tailwind + shadcn/ui
  src/lib/client.ts    HTTP commands + one SSE stream, applied as upserts
packages/shared/  types shared by both: Task, Session, TaskEvent, StreamMessage
docs/design.md    the design
```

### Subscription allowance

The desktop sidebar and phone task list show Claude and Codex's remaining subscription percentages.
Open the summary for independent quota buckets, actual window durations, local reset dates/countdowns,
the last successful update, and manual refresh. Unknown utilization stays unknown; a reached reset is
shown as awaiting update until a new reading arrives. Failed refreshes retain visibly stale readings.

Authenticated clients query at startup and every five minutes while visible, pausing while hidden.
Reset boundaries also trigger a due query. The server shares a per-configured-adapter/login memory
cache across tabs, coalesces concurrent requests, uses a ten-second manual cooldown, and backs off
failed automatic queries from one to five minutes. Restart discards this cache and prompts a fresh query.
No polling entries are written to task events, and no model turn is started to read quota.

Claude uses the installed Agent SDK's experimental usage control API with transcript scanning disabled;
this API can change or be unsupported. Codex uses the pinned CLI's initialized stdio App Server
`account/rateLimits/read`, using the configured Docker login or the host runtime's active login. Docker
quota queries need the existing Codex image; they never build/pull an image or mount a repository.
Queries are limited to twenty seconds and 512 KiB of process output, with process/container cleanup.
API-key accounts and unsupported runtime capabilities report unavailable; query failures are sanitized.

### Usage-limit pause

When a chat, plan, implement or review turn fails with a usage limit, the task is `paused` instead of
`failed` and shows "Waiting for Codex quota, continues around HH:MM". Messages sent meanwhile stay queued.
The Hub checks every minute and at startup. A reset time permits one retry; it does not prove quota is
available. Any pause, including one with a future or unknown reset, can also resume early from a successful,
non-stale quota observation sampled strictly after the saved pause began and no later than now. Every
reported window must have a known finite remaining percentage greater than zero (at most 100); empty,
unknown, incomplete or depleted observations cannot prove recovery, even after a window reset.
Checks use the shared quota cache and ordinary refresh deadline (normally five minutes, with existing reset
scheduling and failure backoff), including manual refresh results. An unseen recovery is discovered at the
next refresh opportunity plus at most one scheduler tick, excluding query runtime. A cached valid recovery
is processed on the next tick. The Hub continues the same conversation once, running queued messages in
order if there are any; queued feedback remains until execution consumes them. A turn that hits the limit
again pauses again. On a paused task you can "Continue now", "Stop waiting" (idle, nothing runs), or switch agent (chat and plan). Discord gets one quiet notification when a task
pauses. The pause survives a server restart. These controls stay in a bounded Chat footer above the
message composer, outside the scrolling conversation.

## Document workspace

Open **Documents** in the sidebar to create and write a plain-text SOP independently of coding tasks.
Edit the title and body, then use **Save** or **Ctrl/Cmd+S**. The list filters loaded documents by title.
Revision history and Discard changes are in the editor's **More actions** menu. History provides read-only previews
and an explicit restore confirmation; restoring creates a new revision. No AI provider is needed.

Bodies containing CR line endings start read-only. **Convert and edit** is an explicit click that
only changes a local draft; Save writes a new revision. Title-only edits preserve the original body.
Conflicts retain your text and require an explicit decision before loading the server version.
Drafts stay only in this page's memory, including while switching Hub views. Save before reloading or
closing; unload warnings are not crash recovery. There is no autosave, deletion or rich text editor. See the [editor design](design.md#document-editor-workspace) for save/selection guarantees
and browser acceptance limits.

For manual passage suggestions, save a valid LF-only document, select at most 16 KiB and choose
**Revise selection**. A three-step dialog asks for the change, lets you copy the bounded prompt (view or
edit it if you want) into the official ChatGPT website yourself, then takes the replacement you paste back.
If the selection cannot start a revision (for example unsaved changes), the editor says why. Hub does not open or call ChatGPT
or any other model. Internal document/revision IDs and offsets are excluded from the external prompt
unless you explicitly enable the advanced option. Copy refusal has a visible select-all fallback.

Import creates a persisted `manual_import` suggestion without changing the document. **More actions >
Suggestions** shows a pending count and lists pending suggestions first. Review the
read-only local Monaco diff (selectable original/candidate text on phones or when unavailable), then
explicitly confirm Accept or Reject. Accept uses the original saved revision and exact UTF-16 range;
stale suggestions cannot apply or relocate themselves. An accepted receipt identifies the original
acceptance revision independently of the latest document snapshot. Unknown writes require inspection
or an explicit retry of the same operation, never an automatic retry or new import key.

Unimported prompts/candidates and unresolved operation handles stay only in memory. Imported original
and replacement text, including rejected suggestions, persists without expiry or deletion in this MVP.
See the [manual suggestions UI design](design.md#manual-suggestions-review-ui) and
[suggestion API and safety contract](design.md#manual-document-suggestions-and-atomic-acceptance).

## Project documents (read-only planning)

Set an optional `documentsDir` in the data directory's existing `repos.json`, keyed by the repository
root (subdirectory task requests resolve to that root):

```json
{
  "/example/project": {
    "documentsDir": "~/project-documents"
  }
}
```

Use an absolute or `~/` directory path. Empty, relative, multiline and NUL-containing values are
rejected. Settings are captured in new task options; existing plans retain their saved directory.
This option alone changes no coding defaults, branch base or PR publication conventions.
Each planning turn rereads root `README.md` as background, with at most 16,000 body characters,
and stores the read/status as a completed read-only `project_docs_bootstrap` tool event.
A missing or unusable README does not stop planning or discovery of other permitted documents.
See [Planning](guide/planning.md) for tools, limits and authority boundaries.

## Out-of-scope observations and diff estimates

Plan, implement and review turns on both agents can use `list_findings` and `record_finding`.
Recording is an event-backed report, never permission to fix the problem or widen the current PR.
Consult the project catalogue and relevant documents first; keys, rather than title similarity,
identify topics; canonical Git common-directory identity also joins worktree aliases. A relative `existingDocument` reference records an equivalent human-owned document
without granting write authority. Observations retain task/session/agent, revision and saved ticket.
Chat, video and diff explainers do not receive these tools.

To enable automatic local documentation commits, extend the repository's settings in the data
folder's `repos.json`:

```json
{
  "/example/project": {
    "documentsDir": "/example/project-documents",
    "findings": { "owner": "<document-owner>" }
  }
}
```

`documentsDir` alone remains read-only. Adding `findings.owner` explicitly opts new eligible tasks
into this fixed governance profile; it is snapshotted separately from coding/PR conventions.
The directory must be the root of an existing, separate Git repository on an attached branch,
with a clean index/working tree and no Git operation in progress. No identity setup, branch switching,
stashing, pushing or issue creation is performed. Existing tasks do not gain write authority from
configuration edits. Unconfigured tasks can still record observations.

Hub writes only `personal-view/agent-findings/<topic-key>.md`, using lowercase ASCII kebab-case.
Notes start with H1, a blank line and metadata: Type `Tech Debt`, Status `Draft`, source of truth
within five lines, Created, configured Owner, applicable Ticket and relative Related references.
The source-of-truth link identifies the note itself as the canonical project observation, still a
low-trust draft. The root README supplies governance; Hub events supply submission/export provenance.
Fixed external-note prose lives in the focused `finding-notes.zh-TW.ts` dictionary.
Later evidence preserves Created and updates the same managed note. External note titles/prose
must be concise Traditional Chinese (Taiwan); Hub formats submitted data without a translation model.
These personal drafts have low trust. Established `decisions/` ADRs outrank them; findings never
modify ADRs, `plan_docs/`, root README, ticket directories or mirrors. Other governance profiles
require future work. No promotion, resolution, deletion or archiving is automated.

At normal workflow-turn completion, pending observations are batched per canonical documentation
repository before the normal worker report. A write-ahead event journal and content hashes protect
managed ownership; human edits, non-Draft status and unmanaged collisions remain untouched.
A private Git index and explicit captured file blobs create one English Hub-owned local commit
per batch, excluding unrelated files. Linux directory descriptors anchor governed writes against
parent replacement. A complete staged write and exclusive replacement preserve the old canonical note
on write failures; retained original inodes protect concurrent human edits. Journal-matching complete
replacement artifacts can be reconciled; unknown temporary content is preserved as a conflict.
Export Git/filesystem operations are asynchronous, with a 30-second timeout per Git operation and
cancellation on Stop/shutdown. Same-root callers wait and recheck pending work; unrelated tasks and
APIs stay responsive. Normal reports and retry responses await the export outcome. Historical evidence
is reused only within its authorized project/document-repository snapshots.
Export failures retain observations and show pending/conflict reasons; they do
not change coding readiness or review verdicts. Fix the repository state and use **Retry document
export** in the finding card, without a model turn. Recognized incomplete batches are reconciled
before writing; unknown modifications require human reconciliation. Stop and startup never start
external document writes. No infinite retry or per-finding approval is used.

Optional `scopeEstimate.maxFiles` and `scopeEstimate.maxChangedLines` are positive safe integers.
Planners may include useful estimates in proposals; users can edit or clear both fields before
starting, or enter them directly for implement/review. Omission inherits a proposal; explicit `null`
clears it. Diff views, persisted snapshots and parent reports compare cumulative changes against
`workspace.baseSha`: additions plus deletions, with binary files counted and their lines explicitly
unmeasurable. Exceeding either maximum gives an advisory warning; equality does not. No estimate
adds no threshold, and a numerical overrun does not establish unrelated work or block progress.

## Whole-change PR briefing

Explicit **Open PR** (ordinary repositories), **Prepare PR**, and the planner's `open_pr` generate
or reuse a versioned Traditional Chinese whole-change briefing for implement and author/reviewer
tasks. Viewing a task/Diff, finishing a coding/review round, reconnecting and restarting never call a
model for this briefing. **Generate / retry** and **Rewrite briefing** are explicit auxiliary actions;
they do not start a coding/review round or export findings. Each new generation costs one isolated
call using the saved author's backend/model/effort with tools disabled. No new provider setting is needed.

The Diff and chat cards retain the same event-backed content appended to the PR in one labeled
`details` section. The main template keeps its configured language, conventions, ticket links,
attribution and the selected issue relationship (`Refs #N` for partial work, `Closes #N` for complete work). Team drafts preview the complete composed body; edit/save changes only
the main body. A changed briefing or draft needs fresh confirmation. Generation does not authorize
publication. Ordinary publishing retains its existing confirmation; team publishing retains its draft
and explicit confirmation. Existing later-round pushes do not generate another briefing; its source
revision remains explicit and the Hub marks old content stale.

Sources are the captured cumulative change against the task's saved base, committed changed-file
sources (deleted files use the base), saved requests/follow-ups, ticket/issue metadata and recorded
author/reviewer/test evidence. Other tasks and finding/export records are excluded. README.md,
AGENTS.md, explicitly referenced guides and the optional default guide described in the
[planning guide](guide/planning.md) are read from that captured revision as presentation data.
An absent default guide uses the standard structure. Missing explicitly referenced custom guides and
unsafe or unreadable guides fail preparation. Guides never grant tool authority or authorize unrelated fixes.

The briefing covers the problem, before/after behavior, a Mermaid flowchart, validated reading tour,
source-based rationale, alternatives/unknown history, risks and teammate questions. Structured references distinguish source facts, inferences and unknowns, and must name supplied
files/evidence for rationale, risks and Q&A. Paths, symbols
and lines are checked against captured sources, and every changed file needs a tour stop (including
tests, docs and generated/lockfile changes, which the prompt asks to explain as a group). Explanations
are model output, not proof of semantic accuracy; review the source Diff alongside the card.
An empty changed file uses an explicit file-level stop without an invented symbol or line number;
deleted empty files still reference the captured base revision.

Generation requires a clean committed worktree. Code/base trees, relevant request/evidence and style
content bind reuse; an unchanged-tree publication squash alone does not invalidate it. Sources are
checked again before accepting output and before push/PR creation. Concurrent requests coalesce.
Failures preserve the last successful content and coding readiness, but cannot publish it as current.
Stop, timeout, shutdown and restart record interruption without automatic model retries. Use an explicit
prepare/retry/rewrite after resolving the reason shown in the card.

Limits are deliberately conservative: 80 changed files, 200,000 bytes per ordinary source file, 512,000 bytes per generated source, 800,000 bytes
cumulatively of relevant changed sources plus full patches, 100,000 bytes of request/evidence, eight guides/60,000 bytes,
48,000 bytes of structured output, and a five-minute generation deadline. Generation uses fixed low effort, configurable with
`AGENT_HUB_BRIEFING_EFFORT`. Captured Git reads have a
10-second/600,000-byte process limit. Known lockfiles and `.generated.` files supply their first 80 lines/16,000 characters and the complete
cumulative patch; the persisted coverage note explicitly identifies omitted unchanged generated data.
Binary/invalid UTF-8, symlink/special files and unsafe paths
fail with the unavailable coverage named; oversized or incomplete coverage never produces a purportedly
complete briefing. Split a change or resolve the reported source limitation before retrying. Mermaid
uses a small flowchart TD/LR subset (square nodes, plain labels, directed edges), at most 6,000
characters, 100 lines and 100 edges. Directives, frontmatter, HTML, styles, interactions and external
resources are rejected; malformed diagrams retain readable source. Rendering is lazy and local, with
strict security, isolated result lifetimes, theme updates and horizontal scrolling on phones.

### Pinned conversations and tasks

Use the always-visible pin button beside any sidebar task, including a dispatched child, to add
an individual shortcut under **Pinned**, above every project group. Shortcuts show current state,
project (with a path hint for same-name projects) and available parent context. They open the exact
task even when its original project is collapsed. Original trees, project counts and navigation stay intact.
Pins are shared by all devices connected to the same Hub server and survive reloads and restarts.
They stay in earliest-pin order despite new messages; unpinning and pinning again appends a shortcut.
Parent and child pins are independent. Pinning is presentation metadata and never starts agent work
or changes workflow/PR readiness. Drag ordering, numbered slots, keybindings and pin limits are deferred.

## Change agent within chat or planning (#8, phase 1)

Open a chat/plan task and choose **Change agent** in its header (on phones, under Details).
The dialog shows the active backend/model/effort and the destination. **Hand off and switch** spends
one extra isolated call on the outgoing backend using its saved model/effort. That call is read-only,
text-only and tools-disabled: no MCP grants, shell, findings, external documents or writes. Both
backends must be configured. Stop a running turn first; queued inputs, permissions and auxiliary
operations block switching. A full concurrency pool rejects the command for explicit retry.

The task keeps its ID, transcript attribution, pins, project/repository/document settings, planning
proposals, pending decisions, children and reports. Each successful switch creates a fresh main
session with destination defaults and no SDK thread, including Codex → Claude → Codex. Retired threads
remain provenance only. Switching starts no greeting, user request or incoming model turn.

The persisted peer summary is structured Traditional Chinese, with goals, decisions, restrictions,
completed/pending work, uncertainty and source event references. It is historical context, never a new
instruction, approval or tool grant. Capture scans at most 10,000 task events and accepts at most
200,000 input characters, 12,000 summary characters and two minutes. Earlier decisions are represented
by the prior completed note plus subsequent relevant events on repeated switches; notes are not
recursively embedded. Tool evidence uses explicitly labeled excerpts of at most 2,000 characters per
input/output, not raw tool replay. When a long conversation exceeds the input limit, capture compacts in
up to four labeled levels (omit report prompts that repeat the agreed spec, then shorten proposal specs,
sent messages and PR draft bodies, then tool excerpts to 500 characters, then tool evidence and the
duplicated record list) and tells the summary model which level was used. Dialogue is never compacted.
Source that is still oversized, or invalid output, fails explicitly, retaining the original active session. Fake tests validate structure, provenance and prompt contracts; they do not
prove a real model's semantic fidelity or perfectly detect Traditional versus Simplified Chinese.

Separately, up to six recent original user turns and their replies are carried verbatim within 24,000
text characters, with event/session attribution and explicit older/oversized/budget exclusions. Only
images from those entries are eligible: at most six distinct historical images, 10 MiB per image and
30 MiB total, preferring newest images. All original image references have delivered/omitted reasons;
older, duplicate, excess, missing, invalid or over-budget images are never described as seen. Existing
same-task host attachments are reused without copying them into the checkout or document repository.
Canonical containment, ordinary files, MIME/signature/size and symlink checks run again at delivery.
New user images keep priority and are never dropped to make room for history. Delivery records can
therefore differ from initial selection; selected is not a claim that a model saw an image.

The first legitimate incoming request, including an independently queued planner worker report,
receives peer context and recent originals/images before its actual input. Current Hub facts and fresh
planning instructions, live README bootstrap and scoped tool grants remain authoritative. Reports,
summaries and switches cannot answer asks, accept proposals, authorize dispatch/follow-up/PR actions or
satisfy fresh-user-message gates. There are no auxiliary findings exports or workflow notifications.

Activation atomically links the completion event, new session and active/handoff task references.
Duplicate requests coalesce or return the completed selection; stale/conflicting requests fail. New
messages/reports or changed decision/proposal/child state invalidate capture, leaving queued input for
the normal scheduler. Pin changes are harmless and merged from the latest row. Stop, timeout, failure,
shutdown and interrupted preparation keep the old session; startup records interruption and never
retries summarization. Use Change agent again to retry explicitly. Successful first delivery is recorded
only after the normal call succeeds (or finishes with a planner ask). Failed/interrupted delivery keeps
the note recoverable for explicit retry/Continue; Restart uses the active session, clears its SDK thread
and supplies its handoff again, preserving retired thread IDs. Prior unconfirmed inputs are historical
context, not automatically replayed work. Current-facts delivery scans at most 20,000 events and has a separate 160,000-character bound;
exceeding it fails the turn without consuming the note.

Automated verification uses fake agents, mocked SDK transports and temporary database/image fixtures.
Manual browser checks remain: desktop and phone dialog layout, keyboard/touch focus, Stop/retry,
expandable summary and omission details, and two devices switching/reconnecting without losing pins
or historical attribution. Real backend summary quality, billing and visual comprehension require
operator testing; automated tests never call real models. Implementation/review/video/custom role
switches, same-provider/model-only resets, automatic retries/quota switching, old-thread resumption,
bulk image replay, OCR and file-based handoff stores remain deferred.

### Durable planning issue links

A plan may also name a `base` in its proposal: a branch on origin the worker starts from and its PR
targets, for a change stacked on unmerged work. The new task dialog has the same field. Without it, a task
uses the repository's configured `base`. A plan reads a read-only worktree at its base, moved to the
latest commit each turn, instead of your checkout, so it does not see your uncommitted work or ignored
files. A repository with no configured base keeps planning in the checkout. Hub does not read ticket dependencies itself, and a stack is not
rebased when its lower layer changes or merges.

A plan may be seeded with a validated repository issue through the existing task creation input
(`issue: number`). Otherwise its first successful `read_issue` saves its default; lists, failed reads
and reads finishing after ask/Stop/turn end do not. Later reads never replace it. The typed event and
task options survive restart and agent handoff; bounded current planning context exposes the default.

For `propose_task`, omitted `issue` inherits that default, a number selects another issue for that
proposal, and `null` detaches only that proposal. A new linked proposal saves `issueCompletion: "partial"`
by default, generating `Refs #N`. Set `"complete"` explicitly for `Closes #N`. Legacy linked records
without a mode retain Closes. Unlinked records have no completion instruction. The editable **Start
implementing** dialog and `start_task` can override or detach the worker link without changing its
source proposal or planning default.

Team PR draft editing exposes issue/partial/complete/none choices. New selections are validated by
host Forge against the task repository. Saved drafts retain their overrides on prepare/rewrite/retry;
`task.options.prIssueLink` projects the saved publication choice while `options.issue` retains the
worker's original briefing provenance. Hub tracks its exact generated issue block separately from
human reference prose. A modified block must be resolved in the draft editor before saving. Changed
drafts invalidate older confirmations. Public requirement comments keep their saved proposal destination
and independent UI confirmation. No issue state is mutated by Hub.

### User-confirmed issue requirement comments (#7)

An issue-bound planning proposal may include a concise Traditional Chinese (Taiwan) `issueSummary`
(problem, behavior, acceptance criteria and out of scope) in the existing planning turn. Hub formats
this supplied value deterministically; no extra model or translation call runs. The full English worker
spec remains in the proposal. Old proposals without a summary have no fabricated draft; propose again
to prepare one. Structural checks bound shape/size, not semantic fidelity, agreement or language:
the human must preview the meaning and language.

The comment card sits beside its proposal on desktop and phone. Check the destination issue/title,
source proposal/version and exact saved body, optionally edit and save, then explicitly choose
**Confirm and publish comment**. Editing the public summary never edits worker instructions or the
issue binding: discuss changed requirements and revise the proposal separately. Starting implementation
and publishing this public record are independent; missing or failed publication cannot block dispatch.
A published comment is a requirements record, not evidence that implementation passed acceptance.

The authenticated task-scoped API accepts only a saved draft identity/revision, never another repository,
issue or unsaved body. Models can prepare summaries, but have no comment confirmation/write tool.
Source references contain opaque Hub task/proposal event IDs, not filesystem or SDK/session data.
The exact confirmation snapshot includes a host-owned source footer and stable hidden operation marker.
Edits create durable revisions; a newer proposal for the same issue supersedes unpublished older drafts.
Published history remains visible; changed requirements use new comments, never edits to old comments
or the issue body. Comments do not supply conversational agreement, answer asks, start/resume work,
authorize PRs, close issues, export findings or trigger completion notifications.

Drafts, intents and outcomes are events restored through snapshots/SSE across reloads, reconnects,
restarts and agent handoffs. Concurrent confirmations share one operation; published repeats return the
same persisted comment ID/URL. Host Forge revalidates origin and the issue before writing with host
credentials, protected JSON input and finite process/output limits. Summary JSON is at most 16,000
characters (problem 4,000; each list 1–30 nonempty entries of at most 2,000). Edited content is 1–24,000
characters; source/operation metadata cannot be edited. Publication uses a 10-second host-account check
and 30-second POST with at most 1 MiB output, then removes its private temporary JSON file.

An explicit rejection may be retried after fixing its cause. Timeout, malformed success, lost response
or interrupted/local-result persistence can mean GitHub accepted the POST: the card remains uncertain.
**Reconcile without posting** checks host authorship and exact marker/body/destination, at most ten
pages of 100 comments within 30 seconds. Multiple/conflicting matches or an incomplete/negative search
leave uncertainty. Inspect the linked issue manually; Hub never blindly reposts an uncertain operation.
GitHub offers no general exactly-once guarantee after ambiguous failures. Boot, viewing, reconnect,
model/report turns, Stop and PR actions never initiate a comment POST or automatic retry. An already
confirmed request may finish independently of workflow Stop; restart makes unfinished intents uncertain.
No issue creation, labels/assignment/state changes, automatic publication or general comment-authoring
tool is included. Findings remain low-trust observations and cannot become comments automatically.

## Google Drive videos

Connect Google from the sidebar, then create a Video task with a `https://drive.google.com/file/d/<file-id>/view`,
`/open?id=<file-id>` or `/uc?id=<file-id>` link. Private files and files in **Shared with me** work when the
connected account can download them. Existing public video URLs continue to use yt-dlp, subtitles first.

Create a Google Cloud project, enable the **Google Drive API**, and configure the OAuth consent screen
(in Google Auth Platform: Branding, Audience and Data Access). Add your account as a test user when using
Testing. Explicitly configure `https://www.googleapis.com/auth/drive.readonly`, a **restricted** scope:
`drive.file` only covers files selected/opened through the app and cannot read arbitrary pasted links.
Hub requests exactly `openid email` plus `drive.readonly`, with incremental consent and offline access.

Choose one OAuth client type and write `<dataDir>/google/client.json` (the directory selected by
`AGENT_HUB_DATA`, outside the repository):

- **Web application**, HTTPS callback through Tailscale Serve:

  ```json
  {
    "clientId": "<client-id>",
    "clientSecret": "<client-secret>",
    "redirectUri": "https://<machine>.<tailnet>.ts.net/api/google/callback"
  }
  ```

- **Desktop app**, loopback redirect with an explicit port (replace `<port>` with a port number):

  ```json
  {
    "clientId": "<client-id>",
    "clientSecret": "<client-secret>",
    "redirectUri": "http://127.0.0.1:<port>/callback"
  }
  ```

  In this mode, after consent the loopback page failing to load on your device is expected. Copy the
  **full address-bar URL** and paste it into the Google dialog. Hub only parses it; it never fetches it.
  Google device authorization does not support this restricted Drive scope.

See [Google HTTPS setup](runbook/google.md) for the callback configuration. Switching modes only
requires editing `client.json`; no restart is needed. Other HTTP redirects and raw IP redirects are refused.

Google's publishing status has a trade-off: **Testing** refresh tokens expire after seven days for these
scopes, so reconnect weekly. **In production** without verification shows an unverified-app warning and
has a 100-user cap, suitable for personal use. Workspace administrators (including schools) may block
unverified apps or restricted scopes. See Google's [OAuth lifecycle documentation](https://developers.google.com/identity/protocols/oauth2/production-readiness/overview)
and [refresh token expiration](https://developers.google.com/identity/protocols/oauth2#expiration).

Hub keeps one Google account, keyed by OpenID `sub`, in `<dataDir>/google/accounts.json`. The directory
is 0700 and files are 0600; writes use temporary files followed by rename. Keep this directory private,
including backups. Refresh tokens and client secrets stay server-side; access tokens live only in memory.
Google credentials never reach agents, containers, task events, prompts, logs or browser responses.
Disconnect revokes authorization best-effort and removes the saved account. Connecting another account
replaces the previous one after a best-effort revocation. Lost/expired consent attempts can be retried.

Downloads are limited to **2 GiB**, checked both before downloading and while streaming, with a
**30-minute** download timeout. Free disk space must exceed the file size plus **512 MiB** (unknown
sizes reserve the full limit). Non-video/audio files and files whose owner disabled downloads are rejected.
Hub downloads through the Drive API on the host, then uses the existing media container for ffmpeg and
Whisper. Source media, audio and partial downloads are removed on success, failure and Stop; only
`transcript.md` remains for the summary and follow-up conversation. Drive timestamps remain plain text.

### Task usage records

Each task has a collapsible **Task usage** panel on desktop and phone. It shows known token
subtotals, unknown/incomplete calls and paginated invocation details. Source and baseline buttons
open the durable Events records. Only activity instrumented after rollout is covered, including
newly measured turns of old sessions; legacy tasks say **Not recorded**, never zero. Live updates
and reconnects reuse event identity. This does not change sidebar statistics or agent behavior.

One record measures one actual `AgentAdapter.run` invocation, including author, reviewer, PR
metadata, change briefing, diff explanation, handoff summary and actual fallback attempts. It is
not a record for each provider-internal request. Start/final events are the sole accounting store;
SQLite prevents duplicate identities and startup closes abandoned calls without running a model.
Failures/cancellation can retain partial observations. Generated-text validation/publication outcomes
remain separate from the model's measured outcome, linked by auxiliary operation identity.

Claude Agent SDK **0.3.296** declares bundled Claude Code **2.1.296**. Its `modelUsage` covers the
query pipeline (including subagents/compaction), excluding helpers such as permission classification
and token probes. Session-cumulative observations require compatible persisted per-model baselines
for resumed-call deltas. Missing, incompatible, reset or ambiguous counters remain unknown; raw
numeric observations are retained. `result.usage` is a separate main-loop observation, never added.
Replayed result identities do not replace newer observations. Empty zeroed errors cannot erase
reported consumption; incomplete model sets retain known subtotals with unknown call totals.
Fresh input, cache reads and cache writes are separate Claude buckets; derived inclusive input adds
them once. Thinking is already inside output and may be partial after resume.

Codex SDK/CLI **0.162.1** observations are retained, but the pinned producer's resumed-thread
aggregation semantics have not been verified: their measurement scope and exact call totals remain
unknown. Mandatory declaration fields absent at runtime remain null. Docker CLI provenance comes
from the existing SDK-pinned image build; host CLI version is unknown. Gemini has no supported usage
signal and reports unavailable. No dependencies or provider capabilities are upgraded here.

Tokens, subscription quota, SDK-reported USD estimates and context occupancy are different
quantities. USD is never inferred from tokens or treated as subscription billing. Quota before/after
values only copy cached shared-account samples (with sample/reset times and staleness); no extra
quota/model probes run. Concurrent tasks and stale samples prevent per-call quota attribution.
No context occupancy or capacity is inferred.

Authenticated `GET /api/tasks/:id/usage` returns the full-task summary, independently of detail
pagination. `GET /api/tasks/:id/usage/calls?after=<event-seq>&limit=20` returns increasing final-event
sequence order (default 20, maximum 100) with source-event IDs and a nullable next cursor. Safe
allowlisted counters/metadata exclude prompts, tool output, credentials and raw provider errors.
Unknown counters are null; known zero is zero. Partial summaries are known subtotals, not complete
provider accounting. See [measurement contracts](design.md#invocation-usage-measurement).

## Update an existing PR after its target advances

Hub polls open PRs for their actual target branch and immutable head/base revisions. Only GitHub's
explicit `CONFLICTING` result produces a conflict observation; pending/unknown/error results do not.
A planning-owned task reports the conflict back to its original conversation. The planner asks whether
to update that same PR and waits for fresh user agreement before calling `update_pr`. Reports alone
never approve an update. Standalone tasks use **Update existing PR** in Diff and confirm the target and
existing PR explicitly. Planning-owned tasks link back to their planning conversation instead.
The MCP tool and confirmed HTTP action persist intent, reserve an execution slot, and return the
operation id and initial stage immediately (HTTP 202). They do not hold the planner tool call through
agent turns or tests. Progress arrives through task events/status; the final planner outcome arrives
only through durable `task_report`. Stop, shutdown and tests can still await the tracked operation.

Each approval covers one update, including publishing its validated result to the existing remote
branch. Hub fetches origin, merges the observed target SHA into the task branch, and preserves the
published ancestry. A clean merge calls no author/reviewer and runs the saved test command. Conflicts
go to the author with the original and cumulative requirements, limited to conflict resolution and
necessary integration edits; a read-only reviewer must approve the exact resulting commit. Implement
tasks also receive a reviewer using the configured/default review role. Configured tests must pass;
when no test command exists, the operation records that no tests ran. Hub delays every update push
until validation finishes, then uses an ordinary non-force push. PR metadata and briefings are not
regenerated, and merging the PR remains the user's decision. Ordinary coding-turn push policy is unchanged.

Stop, failure and restart retain local progress and record the operation stage and evidence. They never
resume or retry an update automatically. An unfinished owned integration blocks ordinary task turns,
so a normal snapshot cannot publish it. Choose an explicit retry, abandon this update, or inspect the
existing PR. Approve a new explicit update retry to inspect local/remote
identities, reuse a safe completed merge and validate again. If an earlier push may have succeeded,
Hub first reconciles the remote SHA; unknown outcomes remain unresolved until the remote can be read.
Dirty/unrelated work, diverged source history, a changed target or a closed/merged PR require user
attention rather than a reset, forced push or replacement PR. If a PR merges externally while an update
is retained, Hub keeps that worktree for inspection.

**Abandon this update** is a separate confirmed action for a failed/interrupted, owned, unpublished
update. Planning-owned tasks require fresh agreement and `abandon_pr_update` in the original plan;
standalone tasks confirm in Diff. It also starts and returns immediately. Hub checks the original PR's
remote head is still the pre-update SHA, then permits only that local HEAD (with an optional owned
pending merge) or the exact merge commit with the expected two parents. It aborts that merge if needed,
resets only the local task branch to the pre-update SHA, and restores the saved previous diff baseline.
Only unchanged untracked merge artifacts captured before the author ran are eligible for cleanup;
unknown user files are preserved, and obstructing files cause refusal. No broad Git clean is used.
The terminal `abandoned` event unlocks ordinary task turns; the existing PR and remote branch are
unchanged. Published/uncertain outcomes or a moved remote head require explicit update reconciliation,
not abandonment. Unexpected local commits, Git state or missing baseline/provenance cause refusal.

## Deployment

For production setup, systemd services, manual and automatic deploys, backups and rollback,
follow the [deployment runbook](runbook/deploy.md). Check the
[host requirements](runbook/host-requirements.md) and
[image verification runbook](runbook/verify-scripts.md) before operating the service.
