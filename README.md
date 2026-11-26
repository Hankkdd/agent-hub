English | [繁體中文](README.zh-TW.md)

# Agent Hub

Agent Hub is a self-hosted, single-user web workbench for driving Claude and Codex
from one place. It uses the Claude Agent SDK with your own Claude Code login and
the Codex SDK with your own ChatGPT login. Run several tasks at once, give agents
their own git worktrees, and have an author and reviewer work through changes
while you keep the final say on what gets merged.

## Features

- **Chat:** talk to one agent, optionally in a working directory, with live streamed replies.
- **Plan:** discuss a change in a read-only checkout, agree on a specification, and hand it
  to an implementation task; results return to the planning conversation.
- **Implement:** an agent edits its own git worktree; Hub commits each turn so you can
  inspect the diff and choose to merge or discard it.
- **Review:** an author and a read-only reviewer iterate until approval or the round limit;
  an optional test command runs after approval. Nothing is merged without you.
- **Rooms:** discuss a document with Claude and GPT and review their suggested edits;
  the server API is available, with the room UI implemented separately.
- **Document workspace:** write plain-text documents with immutable revision history,
  explicit saves and restores, and manual passage suggestions you review before accepting.
- **Devices:** register machines for `list_hosts`, `ssh_exec` and `copy_file` over SSH,
  with per-device command and copy logs.
- **Video summaries:** fetch subtitles or transcribe audio, then read a summary with
  linked chapters and ask follow-up questions.
- **Rule packs:** load repository rules with parameters and save a snapshot for each task.
- **Discord notifications:** receive notices for questions, decisions and task outcomes
  through an optional webhook.
- **Optional integrations:** isolated Gemini text chat through Antigravity, Google Drive
  video access, and course, assignment and material lookup in an E3 learning management
  system through the external `e3sync` CLI; optional video “Assignment Spec” analysis extracts a structured
  requirements checklist from a lecture video transcript.

## Status

This is a personal project in active development, built for one user on a private
network using Tailscale. It is not hardened for exposure to the public internet.
APIs and data formats may change.

Tasks and their events persist in SQLite, and conversations can continue after a
restart. See the [operating guide](docs/configuration.md) for workflow limits and recovery details.

## Requirements

- A **Linux host** with Git and OpenSSH client tools.
- **Docker** accessible to the user running Hub; Codex turns run in containers by default,
  and video processing uses a separate media container.
- **[mise](https://mise.jdx.dev)** to install the pinned Node 22 and pnpm 10 toolchain.
- A **Claude Code login and/or a ChatGPT login for Codex**, for whichever agents you use.

See [host requirements](docs/runbook/host-requirements.md) for login commands,
container setup and network limitations.

## Quick start

From a local checkout:

```bash
mise install
mise exec -- pnpm install
mise exec -- pnpm dev
```

The API starts on `http://127.0.0.1:8787` and the web app on
`http://127.0.0.1:5173`, which proxies API requests to the server.

On first start, the server creates `data/token` (or `$AGENT_HUB_DATA/token`
if configured). The startup log names the file without printing the token.
Read the file locally and open:

```text
http://127.0.0.1:5173/?token=<token>
```

Replace `<token>` with the file's contents. Hub exchanges it for an HttpOnly cookie
and removes it from the address bar. Keep this token private.

Before your first agent task, log in to Claude Code as the user running Hub. For the Claude
Docker runtime, use [Claude login in the sidebar](docs/runbook/claude-login.md)
(`mise exec -- pnpm claude:login` is the terminal fallback). For Codex, run
`mise exec -- pnpm codex:login` for the separate Codex container login. Container
images are built on first use; `mise exec -- pnpm images` builds them ahead of time.

To reach Hub from another device, follow the
[tailnet binding instructions](docs/configuration.md#run).
For a built web app served by the API process, use `mise exec -- pnpm start`.

## Security model

- **Authentication:** the main token grants full access; the browser uses an HttpOnly
  cookie after the initial token exchange. Treat the token like a password.
- **Limited remote token:** opt in with `AGENT_HUB_REMOTE_API=1` for a separate,
  bearer-only relay token. It has a restricted API and starts only containerized
  Codex tasks without device tools or custom test commands.
- **Agent runtimes:** Codex runs in Docker by default. Claude can run on the host
  under its permission mode, or in a container with its own login.
- **Device access:** device tools execute without confirmation. Only register machines
  you trust the agents with; the SSH account's permissions are the real boundary.
- **Secrets:** Hub's server token, device SSH keys, Google credentials and E3 session
  cookies stay on the host and never enter agent containers. Agent containers have
  their own provider login state in private data directories.

Read the [configuration and operations guide](docs/configuration.md),
[device setup](docs/runbook/device-setup.md) and
[host network limitations](docs/runbook/host-requirements.md#known-gap-container-network-fence)
before granting access to repositories or machines.

## Documentation

- [Configuration and operations](docs/configuration.md): environment variables,
  repository conventions, runtimes, integrations and workflow details.
- [Design](docs/design.md): architecture and decisions.
- [Knowledge Map](docs/knowledge-map.md): documents and code entrypoints by topic.
- [planning guide](docs/guide/planning.md): agree on requirements, hand work to agents
  and review their reports.
- [Runbooks](docs/runbook/): step-by-step operator procedures, including
  [deployment and rollback](docs/runbook/deploy.md),
  [image verification](docs/runbook/verify-scripts.md),
  [rule packs](docs/runbook/rule-packs.md),
  [Google setup](docs/runbook/google.md) and
  [Gemini chat setup](docs/runbook/gemini-chat.md).

## License

[MIT](LICENSE). Copyright (c) 2026 Hankkdd.
