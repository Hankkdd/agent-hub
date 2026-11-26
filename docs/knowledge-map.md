# Repository Knowledge Map

Use this map to find sources for the task at hand. It is navigation, not a specification, an instruction
loader, or a grant of access. Requirements and decisions live in the linked documents; implemented
behavior must be checked in code at the current repository revision. If they disagree, report the
conflict and read the original sources rather than treating this map as the answer.

## Instruction entrypoints and rule inventory

[AGENTS.md](../AGENTS.md) remains the root instruction entrypoint; [CLAUDE.md](../CLAUDE.md) imports it
with `@AGENTS.md`. Following a link does not automatically load its contents as mandatory instructions.
This inventory classifies existing sources; no rules have been moved here.

| Existing content | Classification | Retained source |
| --- | --- | --- |
| Pinned toolchain and validation commands | Mandatory; schema generation is conditional on schema edits | [AGENTS: Commands](../AGENTS.md#commands) |
| Git ownership, commits, pushes and branch switching | Mandatory | [AGENTS: Rules](../AGENTS.md#rules) |
| Durable events and SDK/adapter boundaries | Mandatory | [AGENTS: Rules](../AGENTS.md#rules) |
| Secrets, tokens and host-specific values | Mandatory | [AGENTS: Rules](../AGENTS.md#rules) |
| Untrusted paths/commands and HTTP browser constraints | Mandatory | [AGENTS: Rules](../AGENTS.md#rules) |
| Fake-adapter tests and behavior-change coverage | Mandatory | [AGENTS: Rules](../AGENTS.md#rules) |
| Strict TypeScript, comments, language, emoji and UI translations | Mandatory | [AGENTS: Style](../AGENTS.md#style) |
| Planner/reviewer read-only roles and user approval gates | Mandatory when acting in those roles; existing runtime contracts still apply | [Planning guide](guide/planning.md), [runtime prompts](../apps/server/src/core/prompts.ts) |
| Proposal contents, dispatch, reports and publication | Conditional workflow requirements | [Planning: Hand-off](guide/planning.md#hand-off) |
| Module layout and document links | Navigation | [AGENTS: Layout](../AGENTS.md#layout), this map |
| Setup, deployment and diagnostics | Operation-specific procedures; their prerequisites apply when used | [Runbooks](runbook/) |

## Document Editor

- **Read when:** changing the Documents workspace, LF conversion, drafts, save/restore or selection.
- **Documents:** [workspace guide](configuration.md#document-workspace),
  [editor state and safety design](design.md#document-editor-workspace).
- **Code:** [workspace UI](../apps/web/src/components/document-workspace.tsx),
  [editor](../apps/web/src/components/document-editor.tsx), [history](../apps/web/src/components/document-history.tsx),
  [local model](../apps/web/src/lib/document-workspace-model.ts),
  [session](../apps/web/src/lib/document-editor-state.ts), [text contract](../apps/web/src/lib/document-text.ts),
  [API client](../apps/web/src/lib/client.ts), [navigation](../apps/web/src/lib/phone-navigation.ts).
- **Dependencies:** shared Document Core DTOs and CAS API below; native textarea and existing dialogs.
  [state races](../apps/web/src/lib/document-workspace-model.test.ts),
  [create risk UI](../apps/web/src/components/document-workspace.test.tsx),
  [client errors](../apps/web/src/lib/client-documents.test.ts),
  [browser check](../scripts/check-document-ui-browser.mjs) with an
  [isolated server fixture](../apps/server/test/fixtures/documents-ui-server.ts).
  No provider, Task state or browser draft storage.

## Document Core

- **Read when:** changing independent document storage, revisions, CAS saves, restore or document APIs.
- **Documents:** [Document Core design](design.md#document-core-and-immutable-revisions).
- **Code:** [Documents service](../apps/server/src/core/documents.ts), [shared types](../packages/shared/src/documents.ts),
  [schema](../apps/server/src/db/schema.ts), [API](../apps/server/src/app.ts).
- **Dependencies:** document-only SQL guards in [migration](../apps/server/drizzle/0007_bent_darkhawk.sql);
  [service tests](../apps/server/test/documents.test.ts), [API tests](../apps/server/test/documents-api.test.ts),
  [migration tests](../apps/server/test/documents-migration.test.ts). This is separate from Task events
  and from the external read-only ProjectDocuments knowledge source.

## Manual Suggestions UI

- **Read when:** changing selection prompts, manual imports, review diff or unknown-operation recovery.
- **Documents:** [manual workflow](configuration.md#document-workspace),
  [UI contracts](design.md#manual-suggestions-review-ui).
- **Code:** [frozen target and bounds](../apps/web/src/lib/document-suggestions.ts),
  [workspace model](../apps/web/src/lib/document-workspace-model.ts),
  [prompt/import](../apps/web/src/components/document-suggestion-prompt.tsx),
  [review and receipts](../apps/web/src/components/document-suggestions.tsx),
  [diff/fallback](../apps/web/src/components/document-suggestion-diff.tsx),
  [owned Monaco models](../apps/web/src/components/document-suggestion-monaco.tsx),
  [clipboard](../apps/web/src/lib/copy.ts), [typed client](../apps/web/src/lib/client.ts).
- **Tests:** [pure contracts](../apps/web/src/lib/document-suggestions.test.ts),
  [deferred races](../apps/web/src/lib/document-suggestion-model.test.ts),
  [client](../apps/web/src/lib/client-document-suggestions.test.ts),
  [prompt interactions](../apps/web/src/components/document-suggestion-prompt.test.tsx),
  [clipboard](../apps/web/src/lib/copy.test.ts),
  [Monaco disposal](../apps/web/src/components/document-suggestion-diff.test.ts),
  [isolated Chrome](../scripts/check-document-ui-browser.mjs).
- **Boundary:** existing backend protocol below; manual copy/paste only, no provider or Task events.
  Unimported material stays in page memory; imported text, including rejected suggestions, persists.

## Document Suggestions Backend

- **Read when:** changing manual imports, strict selection CAS, atomic acceptance or permanent receipts.
- **Documents:** [suggestion storage and API design](design.md#manual-document-suggestions-and-atomic-acceptance).
- **Code:** [Documents service](../apps/server/src/core/documents.ts),
  [Suggestion DTOs](../packages/shared/src/document-suggestions.ts), [API](../apps/server/src/app.ts),
  [schema](../apps/server/src/db/schema.ts), [migration guards](../apps/server/drizzle/0008_tense_captain_flint.sql).
- **Tests:** [service and real SQLite writers](../apps/server/test/document-suggestions.test.ts),
  [independent-process fixture](../apps/server/test/fixtures/suggestion-writer.ts),
  [API/privacy/auth](../apps/server/test/document-suggestions-api.test.ts),
  [migration and guards](../apps/server/test/document-suggestions-migration.test.ts).
- **Boundary:** shared backend for manual review and room suggestions. Room imports also append Task events.
  Pending/rejected/accepted text and receipts have no deletion or retention expiry in this MVP.

## Rooms

- **Read when:** changing two-member document discussions, delta prompts, quotes or room suggestions.
- **Documents:** [Rooms design](design.md#rooms).
- **Code:** [room workflow](../apps/server/src/core/workflows/room.ts),
  [Hub creation/queue](../apps/server/src/core/hub.ts), [HTTP API](../apps/server/src/app.ts),
  [shared contract](../packages/shared/src/room.ts), [MCP grants](../apps/server/src/tools/mcp.ts).
- **Tests:** [fake-adapter room/API/tool tests](../apps/server/test/room.test.ts),
  [migration preservation](../apps/server/test/document-suggestions-migration.test.ts).
- **Dependencies:** Documents validation and suggestion acceptance; persisted Task events determine
  round order and per-member cursors. Room tools propose changes; users accept them.

## Task and workflow

- **Read when:** changing task lifecycle, scheduling, event replay, restart recovery or workflow behavior.
- **Documents:** [design](design.md), sections 4–8; [repository layout](configuration.md#layout).
- **Code:** [Hub](../apps/server/src/core/hub.ts), [workflows](../apps/server/src/core/workflows/),
  [database schema](../apps/server/src/db/schema.ts), [shared types](../packages/shared/src/index.ts).
- **Dependencies:** API commands and SSE in [app.ts](../apps/server/src/app.ts) feed the
  [web client](../apps/web/src/lib/client.ts). Check event consumers and
  [workflow tests](../apps/server/test/workflows.test.ts) together with persistence changes.

## Video transcription and explicit analysis

- **Read when:** changing video acquisition, retained evidence, opt-in Assignment Spec analysis or its display.
- **Documents:** [Video operations](configuration.md#video), [Video analysis](video-analysis.md).
- **Code:** [Video workflow](../apps/server/src/core/workflows/video.ts),
  [media acquisition](../apps/server/src/media/video.ts), [validated sources](../apps/server/src/media/video-source.ts),
  [analysis](../apps/server/src/core/video-analysis.ts), [analysis prompts](../apps/server/src/core/video-analysis-prompt.ts),
  [shared contract](../packages/shared/src/video-analysis.ts), [result UI](../apps/web/src/components/video-analysis.tsx).
- **Dependencies:** Hub dispatch/API and durable event snapshots; adapter-only measured calls without tools;
  [analysis tests](../apps/server/test/video-analysis.test.ts), [acquisition tests](../apps/server/test/drive.test.ts),
  [UI tests](../apps/web/src/components/video-analysis.test.tsx). Default summary/Q&A remain independent.

## Planner and proposals

- **Read when:** discussing requirements, drafting proposals, dispatching workers or evaluating reports.
- **Documents:** [planning guide](guide/planning.md), especially its opening rules and
  [Hand-off](guide/planning.md#hand-off); [future features](future-features.md) only for roadmap work.
- **Code:** [plan workflow](../apps/server/src/core/workflows/plan.ts),
  [planner dispatch](../apps/server/src/core/planner-dispatch.ts),
  [runtime prompts](../apps/server/src/core/prompts.ts), [planning tools](../apps/server/src/tools/mcp.ts).
- **Dependencies:** read-only adapter runs, self-contained worker specs, fresh user consent and durable
  reports. [Plan tests](../apps/server/test/plan.test.ts) cover those boundaries. This document does not
  change the runtime's existing required reads, tool contracts or approval flow.

## Agent adapters

- **Read when:** changing provider integration, session resume, permissions or container execution.
- **Documents:** [design](design.md), section 5.1;
  [Codex container setup](configuration.md#codex-runs-in-a-container);
  [Gemini chat limits](runbook/gemini-chat.md).
- **Code:** [AgentAdapter](../apps/server/src/agents/types.ts), [Claude](../apps/server/src/agents/claude.ts),
  [Codex](../apps/server/src/agents/codex.ts), [Codex Docker](../apps/server/src/agents/codex-docker.ts),
  [Claude Docker](../apps/server/src/agents/claude-docker.ts),
  [Gemini](../apps/server/src/agents/gemini.ts), [fake adapter](../apps/server/src/agents/fake.ts).
- **Dependencies:** workflows consume the shared interface; container configuration and
  [image builds](../apps/server/src/docker/images.ts) affect Codex. Gemini is isolated chat, not a
  repository/tool-capable peer. Validate with scripted adapters, not live models.

## Usage tracking and quota

- **Read when:** inspecting token evidence, resumed-call baselines, account allowance or quota pauses.
- **Documents:** [invocation measurement](design.md#invocation-usage-measurement),
  [live subscription quota](design.md#live-subscription-quota),
  [task usage records](configuration.md#task-usage-records), [usage-limit pause](configuration.md#usage-limit-pause).
- **Code:** [invocation lifecycle](../apps/server/src/core/invocations.ts),
  [usage normalization](../apps/server/src/core/invocation-usage.ts),
  [Codex aggregates](../apps/server/src/core/codex-usage.ts),
  [quota service](../apps/server/src/core/quota.ts), [quota recovery](../apps/server/src/core/quota-recovery.ts),
  [shared usage types](../packages/shared/src/usage.ts).
- **Dependencies:** adapter observations feed persisted invocation events and the
  [task usage UI](../apps/web/src/components/task-usage.tsx). Account quota is a separate cached reading;
  consult source contracts before interpreting unknowns or comparing totals.

## Git workspace and pull requests

- **Read when:** investigating worktree lifecycle, review publication, repository conventions or PR updates.
- **Documents:** [team repository conventions](configuration.md#team-repository-conventions),
  [existing PR updates](design.md#explicit-updates-of-existing-pr-branches),
  [PR briefings](design.md#whole-change-briefing-at-the-pr-boundary).
- **Code:** [Git workspace](../apps/server/src/workspace/git.ts),
  [forge](../apps/server/src/workspace/forge.ts), [PR publishing](../apps/server/src/core/pull-requests.ts),
  [PR updates](../apps/server/src/core/pr-update.ts), [repository settings](../apps/server/src/core/repo-settings.ts),
  [review workflow](../apps/server/src/core/workflows/review.ts).
- **Dependencies:** Hub-owned Git operations, worker reports, verification results and human publication
  gates; [Git/Hub tests](../apps/server/test/hub.test.ts) and [PR update tests](../apps/server/test/pr-update.test.ts).
  Navigating here does not authorize commit, push, merge or publication.

## Tools, SSH and permissions

- **Read when:** changing tool grants, device access, local/remote copying or attachment containment.
- **Documents:** [device setup](runbook/device-setup.md), [devices and SSH](configuration.md#devices-and-ssh),
  [host requirements and network limitations](runbook/host-requirements.md); [design](design.md), section 7.3.
- **Code:** [MCP server](../apps/server/src/tools/mcp.ts), [host registry](../apps/server/src/tools/hosts.ts),
  [SSH](../apps/server/src/tools/ssh.ts), [copy](../apps/server/src/tools/copy.ts), [E3](../apps/server/src/tools/e3.ts),
  [attachments](../apps/server/src/core/attachments.ts), [authentication](../apps/server/src/auth.ts).
- **Dependencies:** grants are task/turn scoped and revoked at turn end; planner tools exclude remote
  writes/execution. Check adapter permission enforcement and [tool tests](../apps/server/test/tools.test.ts).
  Document links do not extend repository, host or tool access.

## Deployment and operations

- **Read when:** preparing an authorized deployment, rollback, host setup, image verification or login diagnosis.
- **Documents:** [deployment](runbook/deploy.md), [host requirements](runbook/host-requirements.md),
  [image verification](runbook/verify-scripts.md), [Google HTTPS setup](runbook/google.md),
  [Antigravity login](runbook/antigravity-login.md), [login preflight](runbook/antigravity-login-preflight.md),
  [headless check](runbook/antigravity-headless-check.md), [isolated prototype](runbook/antigravity-prototype.md).
- **Code:** [deployment script](../scripts/deploy.sh), [deployer](../apps/server/src/deploy/deployer.ts),
  [auto-deploy](../apps/server/src/deploy/auto-deploy.ts), [CI](../.github/workflows/ci.yml),
  [host status](../apps/server/src/deploy/host-status.ts), [Dockerfiles](../apps/server/docker/),
  [Codex wrapper](../apps/server/bin/codex-docker), [verification script](../apps/server/scripts/verify-images.ts).
- **Dependencies:** production revision, backup/schema compatibility, private data and container toolchains.
  Runbooks have operation-specific approval and live-check limits; a map entry is not approval to execute them.

## Project documents and handoff

- **Read when:** using external project references, passing worker context or switching a conversation's agent.
- **Documents:** [project reference rules](guide/planning.md#project-reference-documents),
  [read-only knowledge design](design.md#read-only-project-knowledge),
  [handoff design](design.md#explicit-chatplan-handoff),
  [conversation handoff guide](guide/planning.md#hand-off-an-existing-planning-conversation).
- **Code:** [ProjectDocuments](../apps/server/src/core/project-documents.ts),
  [plan bootstrap](../apps/server/src/core/workflows/plan.ts), [handoff](../apps/server/src/core/handoff.ts),
  [handoff tests](../apps/server/test/handoff.test.ts), [document tests](../apps/server/test/project-documents.test.ts).
- **Dependencies:** operator-configured external documents are untrusted background, separate from repository
  instructions and native reference mounts. Reads enforce size/path/symlink limits; workers need self-contained
  specs. Historical handoff material cannot supply current consent or tool authority.

## Keeping navigation current

The author changing a domain's documents or entrypoints updates that domain's links and dependencies in
the same change. Read the relevant source sections, then verify behavior in the current checkout; do not
reuse another branch/worktree's source claims without checking its revision. Missing sources are unavailable,
not permission to guess. Keep details in their original documents rather than expanding this map.

Run `mise exec -- node scripts/check-doc-navigation.mjs` from the repository root. CI runs the same
bounded check of local inline Markdown links/headings in AGENTS, README and this map, their map entries,
and the CLAUDE import. It checks target existence, not semantic freshness; review changed domain entries
against the source code. It does not crawl external documents, invoke a model or rewrite files.

## Terminal login panels

- **Read when:** changing Claude or Antigravity web login, CLI status, logout or terminal rendering.
- **Documents:** [Claude login](runbook/claude-login.md), [Antigravity login](runbook/antigravity-login.md),
  [runtime decisions](design.md#72-claude--codex-合作需求-3review-workflow).
- **Code:** [shared lifecycle](../apps/server/src/terminal-login/login.ts),
  [Docker attach](../apps/server/src/terminal-login/docker.ts),
  [screen](../apps/server/src/terminal-login/screen.ts),
  [Claude provider](../apps/server/src/claude-login/login.ts),
  [Antigravity provider](../apps/server/src/antigravity/login.ts),
  [shared dialog](../apps/web/src/components/antigravity-dialog.tsx).
- **Tests:** [Claude fake containers](../apps/server/test/claude-login.test.ts),
  [Antigravity compatibility](../apps/server/test/antigravity.test.ts),
  [dialog](../apps/web/src/components/antigravity-dialog.test.tsx).
- **Boundary:** transient login sessions, no task events, model calls or credential inspection.
  Claude Docker login is separate from the host runtime login; no runtime selection changes.
