# Isolated Gemini chat

Gemini uses the pinned official Antigravity CLI 1.3.6 and the login panel's subscription home.
Complete [Antigravity login](antigravity-login.md), exit the login session, then restart Hub.
Registration checks the host and Docker daemon for ARM64 and looks for nonempty credential files
in the validated `<dataDir>/antigravity/home` without reading their contents. Empty homes and
seeded settings alone do not enable Gemini. File presence is not proof of valid authentication;
the first chat turn may still fail with an authentication error. No startup model request is made.
After login/logout or restoring Docker access, restart Hub to refresh availability.

Choose **Chat**, then **Gemini** in the new-task dialog. Other workflows, repository author/reviewer
defaults, PR metadata, change briefings, handoff summaries and general quota fallback
exclude Gemini. Switching a conversation to or from Gemini is unavailable in this first step.
Gemini has no model/effort selection or image support. Images are rejected before saving the turn.
The sidebar shows Gemini's quota as unknown only while the adapter is registered. Usage-limit
errors use the existing persisted quota pause; with no reset or measured quota, use **Continue now**
when the subscription is available again.

Each turn creates a fresh container from the existing Antigravity image, with a read-only root,
all capabilities dropped, no privilege escalation, and the login container's resource limits.
There are exactly two host mounts: the dedicated writable login home (for token refresh) and an
empty temporary directory at `/work`. No repository, task worktree, parent data directory, host
home, Docker socket or Hub MCP credentials are mounted or supplied. Networking remains Docker
bridge networking for the official service. The dedicated `hub-chat` definition has `tools: []`.
Its definition is refreshed within the login home before each turn; the login panel and headless
checker are unchanged.

CLI tool restrictions are not the isolation boundary: init may advertise tools. Any tool,
subagent or permission activity, including nested metadata, or an unknown step type stops the run
and removes the container. Only `user_input`, `agent_response` and `checkpoint` steps are allowed.
Text deltas stream when supplied; otherwise the terminal response is shown once. Non-success
results, malformed/incomplete streams and transport failures fail the turn. Stop aborts the CLI
transport and force-removes the container; the five-minute turn deadline does the same, including
image preparation. Containers and scratch directories are removed on success and failure.
Startup removes orphaned chat containers using this Hub's dedicated owner label.

Gemini turns share a serialized queue because they write the same credential home. A second task
waits until the first container has been removed. Queue waiting does not consume its five-minute
execution deadline, and a queued task can be stopped without waiting for the active chat.
Do not run a login session or sign out while Gemini chat is active.

Conversation IDs are recorded in the session for diagnostics only. Every CLI process starts fresh
without a resume flag and receives the current message plus recent attributed dialogue rebuilt
from persisted Hub events: at most six prior user turns and replies, with at most 24,000 text
characters, using the same shape and selection policy as handoff `recent`. Older or oversized
entries can be omitted. No memory depends on adapter process state.

Verification uses scripted container transports, fake timers and fake Hub agents only. It starts
no Docker containers and contacts neither Google nor any model. Run the full command in AGENTS.md
before merging. A real subscription smoke test is an operator action outside the automated suite.

Diff explanations default to Gemini when registered, otherwise Codex. Set
`AGENT_HUB_EXPLAIN_AGENT` to `gemini`, `codex` or `claude` to override. Gemini receives only the
self-contained explanation prompt, without chat history, in the same isolated container and
serialized queue as chat. `AGENT_HUB_EXPLAIN_EFFORT` is ignored by Gemini. Waiting explanations
never gate task completion or opening a PR. On a usage-limit failure, Gemini permits one fallback
to Codex, or Claude if Codex is missing or known to be exhausted. A failed fallback is final;
bad JSON, timeouts and tool attempts never trigger fallback. The explainer session records the writer.
