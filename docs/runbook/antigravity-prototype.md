# Antigravity CLI feasibility prototype

This is an opt-in prerequisite experiment for a possible future Diff explanation provider.
It does not register an adapter, change routing, or implement the Diff feature. Only synthetic code
is sent. Normal tests, `verify:images`, and the prototype's default command never log in or call a model.

## Pinned artifact and assumptions

- CLI: **1.3.6**, release execution **5068262057312256**, Linux ARM64 only.
- Artifact: `https://storage.googleapis.com/antigravity-public/antigravity-cli/1.3.6-5068262057312256/linux-arm/cli_linux_arm64.tar.gz`.
- SHA-512: `dbe9585460ba8ea30959c6a2599d3bef1e7710331ef8c9e418863a300d19351906e16be63204f7d77434c773796b5ae222ae135ac033db5abf1542b076d02b0e`.
- These values were captured from the [official ARM64 manifest](https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/linux_arm64.json).
  The build uses the literal release URL and checksum, never the moving manifest or a remote installer.
- The Debian base index is pinned by digest. Apt packages remain distribution-resolved; byte-identical
  whole-image rebuilds are not claimed. CLI bytes are checksum pinned.
- `imageTag()` from the existing image module hashes the dedicated Dockerfile and configuration assets.
  The prototype performs its own bounded build instead of the production builder's unbounded execution.
- `AGY_CLI_DISABLE_AUTO_UPDATE=true`, a read-only root filesystem, and a root-owned non-writable binary
  prevent replacement of the pinned executable. Exact `--version` output is checked before any request.
- `GEMINI_FORCE_FILE_STORAGE=true` is an upstream-reported setting, not a guarantee of working credential
  persistence in this release. Actual credential layout, refresh, configuration acceptance, and subscription
  entitlement require real experiments. No refresh test is implemented without a safe documented mechanism.

## Worker commands

Run from the repository root with installed dependencies. These commands are for the worker/operator;
never ask a user to execute shell commands. User decisions and browser consent go through the planner.

```bash
# Offline fixture transport/protocol check; default, no Docker or account needed.
mise exec -- pnpm antigravity:prototype

# Unit tests: scripted child processes and temporary files only.
mise exec -- pnpm --filter @agent-hub/server exec vitest run test/antigravity-prototype.test.ts

# Build/select the pinned image and run version/help/non-root/empty-workdir checks.
# Uses a temporary isolated data root and network-disabled containers; no login or model.
mise exec -- pnpm antigravity:prototype image-check

# Existing production image checks remain separate and account/model-free.
mise exec -- pnpm verify:images
```

Persistent commands require `AGENT_HUB_DATA` or an explicitly chosen isolated temporary data root via
`AGENT_HUB_ANTIGRAVITY_PROTOTYPE_DATA`. Both select a parent directory; the runner always appends
`antigravity-prototype`. Do not point at an existing account directory. Do not mount or copy host accounts.

```bash
# Prepare private directories/configuration only. Currently reports BLOCKED (runner exit 2; pnpm returns nonzero).
# Does not start OAuth or a model.
mise exec -- pnpm antigravity:prototype login-prepare

# Explicit live opt-in only after one legitimate vendor browser login in this isolated profile.
# First command: at most two one-shot CLI processes within one dedicated container.
mise exec -- pnpm antigravity:prototype live-initial

# A separate runner invocation: one request in a newly created container with the same auth mount.
mise exec -- pnpm antigravity:prototype live-restart

# Explicit orphan cleanup, restricted by BOTH prototype and state-root owner labels.
mise exec -- pnpm antigravity:prototype cleanup
```

### Login boundary

The documented remote OAuth flow prints a URL and asks for an authorization code. The available Hub
worker SSH interface is non-interactive and provides no secure vendor-code input channel. Therefore
`login-prepare` deliberately stops before OAuth. It is not a working login bridge. Do not pipe raw provider
logs into Hub, request codes/passwords/tokens in chat, expose a terminal, use Remote Control as an auth
workaround, or transplant credentials. The planner must obtain a user decision on an authorized interaction
path before actual login can proceed. No host packages, services, keyrings, or browser UI are installed.
The live commands implement the later experiment sequence but are not evidence that login is available.
Absent cached authentication must fail, not trigger API billing or infer success from credential files.

Do not run either live command until the legitimate browser login has completed in this exact isolated
profile. `login-prepare` only prepares directories and reports BLOCKED; it does not satisfy this prerequisite.
The runner has no verified model-free authentication probe. A credential file is not proof of login.
An unauthenticated `live-initial` still charges an attempt before starting the CLI, then permanently blocks
both stages for that experimental profile. No automatic retry or ledger reset is supported. While the
browser interaction remains blocked, leave both live commands unrun and return the decision to the planner.

## Containment and evidence

Containers run as the caller's non-root uid/gid with dropped capabilities, no new privileges, bounded
CPU/memory/PIDs, a read-only image, disabled Docker logs, and empty ephemeral HOME/work/tmp directories.
The only bind mounts are the dedicated profile's `.gemini` state and read-only runner-owned configuration
submounts. The model working directory is `/work`, never the credential directory. No repository, host HOME,
keyring/D-Bus socket, Docker socket, production data directory, reference repo, API key, ADC configuration,
or inherited provider environment is passed into the container. Files are created with private permissions;
live CLI execution uses `umask 077`. Existing auth files with public permissions, symlinks, hardlinks,
or another owner are rejected without reading their contents. Authentication state must remain outside Git and is never in an image.
The prototype-specific `.gemini` tree is an experimental persistence boundary; its sufficiency for vendor
credential refresh and all vendor configuration discovery locations has not been established.

The custom main agent specifies empty tools, MCP servers, skills, and plugins, disables subagent selection,
and uses a fixed system prompt. Settings disable credit overflow (`useG1Credits: false`), MCP/hooks/plugins/
skills, and explicitly deny all documented action namespaces. These are defense in depth, not proof of tool
removal. The parser requires an explicit empty advertised tools list and the requested custom agent/cwd.
It rejects unknown event types, native/MCP/web/subagent activity, denied-action diagnostics, missing or
non-success results, conversation mismatch, malformed hunk JSON, and oversized output. Any stderr output
fails the strict check. Response deltas are not concatenated into the final answer: only the terminal
response is validated. A CJK check is only a coarse language check; Taiwan wording still needs human review.

Even with an empty advertised tools list and no observed calls, `strictIsolation` remains **UNVERIFIED**:
empty-list semantics and complete removal from the model cannot be certified from a synthetic request
that never needs a tool. No result from this prototype authorizes production `toolsDisabled` support.

Each live CLI call is one-shot, with a 60-second deadline and a combined 64 KiB output cap. Docker build
has a ten-minute deadline and a separate 4 MiB cap. Cancellation kills the local child and force-removes
its owned container with a separate ten-second cleanup deadline. Cleanup failures fail the command.
If execution and cleanup both fail, the error retains both causes internally and the summary reports
only their redacted diagnostic codes; raw exception messages and provider output are never printed.
SIGKILL/power loss cannot run finalizers; the next explicit invocation removes only matching owned
containers. Image checks use a stable per-uid directory under the system temporary directory, so their
orphan label remains addressable by the next image check; that directory contains no login or model state. A private runner lock serializes one profile; explicit `cleanup` (or a subsequent image check for its temporary profile) can recover a lock whose
recorded local PID no longer exists. Ambiguous locks remain blocked. Run from the same host/PID namespace.
Never manually clear a lock while a runner may be active.

A private ledger charges each attempted model request before dispatch, including failures. It allows
at most three requests per isolated experimental profile: two initially and one after a separate runner
startup. Failed or interrupted stages are not retried automatically. Do not delete/reset the ledger or
change data roots to evade this budget. Reports contain fixed status/count fields only, never account
identity, conversation IDs, provider logs, response text, or credentials. Provider-generated private files
may contain sensitive information; do not upload them or include them in reports.

## Evidence recorded during implementation

| Category | Outcome | Limit |
| --- | --- | --- |
| Official documentation | Personal OAuth, cached headless mode, remote browser OAuth, subscription credits, custom agents, stream-json documented | Student entitlement and this account not verified |
| Upstream reports | File-storage reuse reported in an ordinary process; older container reuse failures also reported | Reports are not guarantees for 1.3.6 |
| Offline fixtures | Protocol, tool rejection, bounds, subprocess failure/cancel/timeout, cleanup, isolated state and three-request sequencing exercised | No vendor binary, account, or model involved |
| Original worker execution container | `uname -m`: aarch64; Docker CLI and socket absent; agy absent | Historical worker access limitation, not a general Docker availability claim |
| Registered Hub host over SSH (rechecked in revision round 1) | aarch64; Docker CLI exists; daemon access denied to the registered worker account | Host Docker exists; this worker still cannot run containers |
| Real prototype container in review round 1 (reviewer-reported experiment) | Image built and container ran on aarch64; `image-check` FAILED with `UNSUPPORTED_CLI_FLAGS` | CLI 1.3.6 writes successful help to stderr; the original check incorrectly rejected it |
| Revised help handling (offline scripted processes) | Successful stdout-only, stderr-only and split-stream help accepted; missing flags rejected; model stderr remains rejected | Regression evidence only; not a real vendor/container run |
| Revised `pnpm antigravity:prototype image-check` (worker revision round 1) | Attempted; BLOCKED with `PROCESS_UNAVAILABLE`: worker Docker CLI absent; registered-host daemon permission denied | Historical worker access limitation; subsequent reviewer evidence is recorded separately below |
| Revised `pnpm antigravity:prototype image-check` (review round 2, reviewer-reported real-container experiment) | On aarch64 with Docker available, returned `transport: PASS` and CLI version `1.3.6` | Reviewer environment evidence only; no login or live model request; does not establish subscription entitlement, authentication persistence/refresh, or complete tool removal |
| `pnpm verify:images` (worker revision round 1) | Attempted; BLOCKED with `spawn docker ENOENT` for Codex, toolchain, and media images | No real production image checks completed in this worker environment |
| Browser login / subscription entitlement | BLOCKED / NOT RUN | No secure Hub authorization-code interaction; no login initiated |
| Fresh CLI process with cached auth | NOT RUN | Login and Docker blockers |
| Recreated container with same auth state | NOT RUN | Login and Docker blockers |
| Separate runner restart | NOT RUN live; fixture bookkeeping tested | Not proof of host-process authentication persistence |
| Credential refresh | NOT VERIFIED | No safe documented refresh mechanism identified; no token manipulation or expiry wait |
| Complete tool removal | UNVERIFIED | Requires additional vendor evidence and actual capability observations |

Recommendation: **blocked** for a subscription feasibility conclusion. The first-round reviewer experiment
exposed a help-stream bug that worker fixtures did not detect. After the fix, the second-round reviewer
reported a real-container transport PASS on aarch64 with Docker available and CLI version 1.3.6. This
establishes the offline transport check in that reviewer environment, while the original worker's Docker
access limitation remains historical evidence. It does not establish browser login, student entitlement,
fresh-process or recreated-container authentication, credential refresh, or complete tool removal; all
remain unverified. Return the secure browser interaction decision and any worker Docker access needs to
the planner before independently authorizing the bounded live experiment. Production Diff integration
needs a separate agreement after these uncertainties are resolved. No live model requests were made.

## Sources and confidence

- [Transition announcement](https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/): subscription migration context.
- [Authentication](https://antigravity.google/docs/install?tab=cli) and [plans](https://antigravity.google/docs/plans/): documented account/subscription support, not actual student entitlement.
- [Headless protocol](https://antigravity.google/docs/cli/headless/) and [changelog](https://antigravity.google/docs/changelog?tab=cli): protocol and version-dependent timeout behavior; the runner owns deadlines.
- [Custom agents](https://antigravity.google/docs/subagents/), [permissions](https://antigravity.google/docs/permissions?tab=cli), and [credits](https://antigravity.google/docs/cli/credits/): configuration intent; empirical acceptance remains unverified.
- [Upstream report 479](https://github.com/google-antigravity/antigravity-cli/issues/479) and [report 854](https://github.com/google-antigravity/antigravity-cli/issues/854): low-trust user reports about credential reuse, not specifications.
