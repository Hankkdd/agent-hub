# AGENTS.md

Agent Hub: a local-first web workbench that drives Claude and Codex (and later other agents) from one
place. Tasks run several at once; agents work in git worktrees, review each other, reach registered devices
over SSH, and summarise videos. Read [README.md](README.md) for what it does and
[docs/design.md](docs/design.md) for why it is shaped this way.

This file is an index. Keep it short: it is read at the start of every agent session on this repo.

Use the [Knowledge Map](docs/knowledge-map.md) to locate relevant documents and code entrypoints.
It is navigation, not a specification or a replacement for the mandatory rules below.

## Commands

The toolchain is pinned with mise (Node 22, pnpm 10); the system Node is too old. Prefix with `mise exec --`.

```bash
mise exec -- pnpm install
mise exec -- pnpm typecheck     # tsc on all three packages
mise exec -- pnpm lint          # eslint: the Rules below that a machine can check, plus React hook rules
mise exec -- pnpm test          # vitest; scripted agents, real temporary git repos, no model, no quota
mise exec -- pnpm --filter @agent-hub/web build
cd apps/server && mise exec -- npx drizzle-kit generate   # after ANY change to src/db/schema.ts
```

Run `typecheck`, `lint` and `test` before saying a change is done. A lint error names the rule it
enforces and what to do instead: fix the cause, do not disable the rule. `eslint-suppressions.json`
lists existing React hook violations still to fix; never add to it. When you fix one, lint asks you to
run `mise exec -- pnpm lint --prune-suppressions`, which removes it from the file.

Agent Hub task worktrees start without node_modules and are untrusted by mise. Tasks must use this
test command:

```bash
mise trust -q && mise exec -- pnpm install --frozen-lockfile --prefer-offline && mise exec -- pnpm typecheck && mise exec -- pnpm lint && mise exec -- pnpm test && mise exec -- pnpm --filter @agent-hub/web build
```

## Layout

```
apps/server/src/
  core/hub.ts        tasks, events, scheduler, the workflows (chat, plan, implement, review, video)
  core/attachments.ts pictures sent with messages
  agents/            the AgentAdapter interface (types.ts), Claude, Codex, a fake for tests
  workspace/git.ts   worktrees: create, commit, diff, merge, discard
  tools/             devices, ssh_exec, copy_file, E3 tools, and the MCP server both agents use
  media/video.ts     transcripts (yt-dlp, Whisper) in the media container
  docker/images.ts   content-addressed image builds (codex, media)
apps/server/docker/  Dockerfiles; apps/server/bin/codex-docker runs Codex in its container
apps/web/src/        React + Vite + Tailwind + shadcn/ui; lib/client.ts is the only API client
packages/shared/     types shared by server and web (Task, TaskEvent, Host, ...)
docs/                design.md (decisions), future-features.md (what comes next), guide/planning.md (planning), runbook/ (steps)
```

- [Antigravity login](docs/runbook/antigravity-login.md): generic official CLI terminal login panel.
- [Antigravity headless check](docs/runbook/antigravity-headless-check.md): one-use saved-home verification.
- [Google HTTPS setup](docs/runbook/google.md): Google OAuth callback and paste modes.
- [Rule packs](docs/runbook/rule-packs.md): repository rules, parameters and task snapshots.
- [Deployment runbook](docs/runbook/deploy.md): production setup, deploys, and rollback.
- [Verification scripts](docs/runbook/verify-scripts.md): requirements and checks to run before merging image changes.

## Rules

- **Agents never commit, push or switch branches.** Agent Hub commits the worktree after each turn and
  owns every push and pull request. Leave your changes in the working tree.
- **Task state is persisted as events** (`events` table, ordered by `seq`). Document state is persisted
  as immutable `document_revisions`, ordered by `revision_number`. Rebuild projections from these;
  do not add state that only lives in memory unless losing it on restart is fine.
- **Adapters are the only place an SDK appears.** Workflows and the UI talk to `AgentAdapter`
  (`apps/server/src/agents/types.ts`). A capability added for one agent is added for the others in the same
  change, or the gap is stated in code.
- **No secrets in the repo.** Tokens, keys, logins and the database live in `data/` (gitignored). Never
  hard-code a host's address, a user name, a key or a token in code, tests or docs; use placeholders.
- **The UI is served over plain http on a tailnet**, which is not a secure context: no `crypto.randomUUID`,
  no `navigator.clipboard` without a fallback.
- **Agent-supplied paths and commands are untrusted.** Validate paths against the directory they must stay
  in (see `tools/copy.ts`, `core/attachments.ts`); pass arguments to `execFile`, never through a shell string.
- **Tests run against the fake adapter**, never a real model. A behaviour change comes with a test.

## Style

TypeScript, strict. Match the surrounding code: comments explain why, not what. No emoji in code or
output. Everything committed (code, comments, identifiers, commit messages, docs) stays in English,
with three exceptions: README.zh-TW.md, the zh-TW dictionary, and prompt text whose purpose is to set
the language agents reply in. Keep README.md and README.zh-TW.md in sync whenever either is changed.
User-facing UI strings go through t() and must be added to both language dictionaries.
