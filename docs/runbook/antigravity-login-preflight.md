# Antigravity login startup preflight

This prerequisite pins the unmodified official Linux ARM64 CLI 1.3.6, release
5068262057312256, through the existing content-addressed prototype image. It does not resume
the separate dialog task, establish a login contract, resolve issue 21 or authorize integration.

## Current boundary: one newly authorized TTY diagnostic attempt

After report finalSeq 131, the user authorized exactly one fresh Docker-TTY startup to collect
the existing safe diagnostic metadata. There is no new non-TTY observation, input, retry,
authentication, consent or model request. The ordinary no-argument CLI entry now dispatches
this fixed authorization through Hub's existing post-review command, which stays unchanged:

```bash
mise trust -q && mise exec -- pnpm install --frozen-lockfile --prefer-offline && mise exec -- pnpm typecheck && mise exec -- pnpm test && mise exec -- pnpm --filter @agent-hub/web build && mise exec -- pnpm --filter @agent-hub/server exec tsx scripts/antigravity-login-preflight.ts
```

Authors/reviewers run normal checks without the final script and never manually execute the
real preflight, Docker or the vendor CLI. Only Hub's approved host check performs the attempt.
There are no reset/force/retry flags or caller-selected experiment, attempt or command inputs.

The historical `preflight(root)` function remains read-only for
`d8a2a301-login-startup-online`. It still returns `reuseOnly: true`, historical evidence marked
`reused-online-experiment`, and unavailable historical diagnostics without rewriting old files.
The CLI instead calls the fixed `diagnosticPreflight` boundary with
`entryMode: ONE_USE_TTY_DIAGNOSTIC` and identity
`d8a2a301-login-startup-tty-diagnostics-1`.

Both identities use the same root precedence: absolute `AGENT_HUB_ANTIGRAVITY_PREFLIGHT_DATA`,
absolute `AGENT_HUB_DATA`, then the checkout's ignored `data/`. Roots inside this checkout must
be inside its ignored `data/` tree. Each appends `antigravity-login-preflight/<fixed-identity>/`.
Keep the original root stable: relocation, identity changes and copying/resetting checkpoints
are not ways to obtain attempts. The real-auth profile and three-request MODEL ledger are not
read or changed. The startup profile is a new empty tmpfs, never an authentication transplant.

Before any mutation or Docker command, the new boundary validates the existing completed old
checkpoint, its pin/architecture/help, both mode records and successful cleanup. Missing,
inaccessible, invalid, incomplete or blocked old evidence yields a fixed OLD_CHECKPOINT blocker
without creating new experiment state. Old checkpoint bytes, reservations and lock are retained.
The earlier two-mode observation harness is used only by synthetic tests, never real dispatch.

The new experiment directory is an exclusive one-use claim. Its creation is never repaired or
reclaimed. Before any process (including image prerequisites), a private checkpoint reserves
one Docker-TTY attempt; the file, directory and parent directory are fsynced. Concurrent callers
cannot both reserve. A crash, failed prerequisite/container creation, cancellation, failed
observation or result write consumes this authorization. Even an empty claimed directory blocks
later dispatch. Completion uses a private exclusive temporary file, fsync and atomic replacement;
a leftover temporary result is never used to repair a reservation.

Reads require owned private directories (0700), owned private regular files (0600), no
symlinks/hardlinks, at most 8 KiB and strict safe schemas. Only the experiment identity,
reservation and sanitized result are retained. No raw output, credentials or container identity
is stored. No old checkpoint migration or budget reset occurs.

Fresh output uses `execution: fresh` (a newly reserved attempt, possibly blocked at prerequisites).
Only a populated `observations` list establishes a startup observation. New reservations are
`non-tty: 0, docker-tty: 1`. Normal completed later invocations return `execution: reused` and
`evidence: reused-tty-diagnostic-experiment`, with no Docker or vendor commands. They describe
the original attempt, not a fresh environment check; cached BLOCKED outcomes remain blocked.
INCONCLUSIVE uses `TTY_DIAGNOSTIC_STARTUP_UNVERIFIED`; PASS still means only a recognized
link/input boundary, never account authentication. Both exit 0; BLOCKED exits 1.

New incomplete state reports `DIAGNOSTIC_INCOMPLETE_NO_RETRY`; invalid/unavailable state reports
`DIAGNOSTIC_STATE_INVALID_OR_UNAVAILABLE_NO_RETRY`; access denial reports
`DIAGNOSTIC_CHECKPOINT_INACCESSIBLE_NO_RETRY`; result-write failure reports
`DIAGNOSTIC_RESULT_WRITE_FAILED_NO_RETRY`. None permits automatic retry. Owned-container cleanup
still has an independent ten-second deadline, unaffected by cancellation. Its failure remains
visible in the sanitized result and prohibits another startup.

## Safe diagnostic metadata and historical limits

The new real path selects only one TTY mode. Compared with the previous online TTY startup,
only diagnostic collection changes: same pin/content-addressed image, bridge network, ignored
client stdin, unattached container stdin, create --tty/--interactive and start --attach, with no
terminal-size changes or vendor arguments. Non-root uid/gid, read-only image, CPU/memory/PID and
capability limits, no bind mounts, empty HOME/work/tmp and their noexec settings stay identical.
The startup stops at a recognized Google selection/link/code-input boundary, unsafe output,
output cap, cancellation or the 30-second deadline. Captured output is bounded to 64 KiB.
No link is followed or input submitted. Existing model-free image checks are prerequisites only.

The new observation and synthetic fixtures attach `diagnostics` with finite vocabulary and bounded numbers only:

- `output`: EMPTY, CONTROL_ONLY (including whitespace-only), UNRECOGNIZED_VISIBLE,
  RECOGNIZED_BOUNDARY, UNSAFE or CAPTURE_LIMIT.
- `capturedBytes`: retained stdout/stderr UTF-8 bytes, combined and bounded to 64 KiB.
  `visibleCharacters`: retained code points after ANSI stripping and removal of control,
  formatting and whitespace characters. These are not rendered-screen measurements.
- `exitCode`: actual nullable Docker-client process exit code; it is not inferred from EXIT,
  TIMEOUT or a vendor success marker. The existing observation `code` preserves the stop reason.
- `streamLayout`: SEPARATE, or TTY_MERGED_WITH_CLIENT_STDERR. TTY vendor stdout/stderr are
  merged; Docker-client stderr can still carry local errors. No vendor stream provenance is inferred.
- `errorCategory`: fixed matches for daemon, permission, execution, read-only filesystem,
  no-space, TTY or unavailable-process diagnostics; otherwise NONE_RECOGNIZED. Pattern matches
  are not verified causes, and absence of a match does not mean absence of an error.

Old checkpoints lack these fields. Reuse renders `availability: UNAVAILABLE_HISTORICAL`,
`output`, `streamLayout` and `errorCategory` as UNAVAILABLE, and counts/exitCode as null.
It neither infers silent output/exit 0 nor rewrites the historical checkpoint. Strict parsing
accepts old records with absent diagnostics and validates new records without accepting extra
trace fields, arbitrary strings or URLs. Tests cover historical compatibility and secret exclusion.

Raw terminal output, identities, tokens, OAuth query/state and exception text remain transient.
Only exact HTTPS accounts.google.com paths `/o/oauth2/auth` and `/o/oauth2/v2/auth` can be reported,
without credentials, non-default port, query or fragment. No OAuth parameters are reconstructed.

## Static assessment: facts versus hypotheses

Source: [preflight execute/observation functions](../../apps/server/scripts/antigravity-login-preflight.ts)
and [prototype containerArgs](../../apps/server/scripts/antigravity-prototype.ts).

- `execute()` gives the Docker client ignored stdin. TTY creation requests both `--tty` and
  `--interactive`, but start uses only `--attach`, without `--interactive`. Creation keeps container
  stdin open and allocates a pseudo-TTY; starting with attach alone attaches output/signals,
  not stdin. There is no input channel, keystroke, menu selection or terminal relay. How CLI
  1.3.6 reacts to these descriptors, and whether it waits for input or a different transition,
  remain UNVERIFIED. See [Docker create](https://docs.docker.com/reference/cli/docker/container/create/)
  and [Docker start](https://docs.docker.com/reference/cli/docker/container/start/).
- Preflight HOME tmpfs includes `rw,noexec,nosuid`; prototype HOME includes `rw,nosuid` without
  explicit noexec. Preflight also retains noexec on tmp/work. Noexec blocks direct binary
  execution from that mount while rw permits data writes. It does not establish complete tool
  removal. Whether this release extracts/executes a helper under HOME is UNVERIFIED; no such
  error was captured in the supplied summaries. The image executable is outside HOME. See
  [mount noexec semantics](https://man7.org/linux/man-pages/man8/mount.8.html).
- Screen recognition strips ANSI and recognizes only bounded Google-selection phrases, exact
  authorization endpoints and specific authorization-code prompts. It is not a full terminal
  emulator or universal login-screen parser. Unrecognized output could include a menu, welcome,
  error, redraw-only stream or nothing. Historical summaries cannot distinguish these cases.
  [Docker's TTY stream note](https://docs.docker.com/reference/cli/docker/#multi) explains why
  container stderr cannot be separately identified in TTY capture.

None of these facts identifies the cause of the observed EXIT/TIMEOUT. No mount/input setting,
pinned binary, image, vendor flag or screen transition is changed to test a hypothesis here.

## User-supplied existing offline Hub-host evidence

Provenance: the user supplied this existing sanitized host JSON through the planner. It is not
an independent worker read, a fixture, a new observation or proof of online failure.

```json
{
  "evidence": "real-container-observation",
  "authentication": "NOT_RUN",
  "status": "INCONCLUSIVE",
  "code": "OFFLINE_STARTUP_CONTRACT_UNVERIFIED",
  "dockerAccess": "PASS",
  "architecture": "arm64",
  "version": "1.3.6",
  "help": "PASS",
  "ttyRequired": "UNVERIFIED",
  "network": "none",
  "inputSubmitted": false,
  "modelRequests": 0,
  "observations": [
    { "mode": "non-tty", "code": "EXIT", "googleSelection": false, "linkBoundary": false, "inputBoundary": false },
    { "mode": "docker-tty", "code": "TIMEOUT", "googleSelection": false, "linkBoundary": false, "inputBoundary": false }
  ],
  "cleanup": "PASS"
}
```

## User-supplied existing online Hub-host evidence

Provenance: the user supplied the latest actual Hub-host JSON through the planner. It records
the previous two-mode online run, not the newly authorized single diagnostic attempt:

```json
{
  "evidence": "real-container-observation",
  "authentication": "NOT_RUN",
  "status": "INCONCLUSIVE",
  "code": "ONLINE_STARTUP_CONTRACT_UNVERIFIED",
  "dockerAccess": "PASS",
  "architecture": "arm64",
  "version": "1.3.6",
  "help": "PASS",
  "ttyRequired": "UNVERIFIED",
  "network": "bridge",
  "execution": "fresh",
  "reservedAttempts": { "non-tty": 1, "docker-tty": 1 },
  "inputSubmitted": false,
  "modelRequests": 0,
  "observations": [
    { "mode": "non-tty", "code": "EXIT", "googleSelection": false, "linkBoundary": false, "inputBoundary": false },
    { "mode": "docker-tty", "code": "TIMEOUT", "googleSelection": false, "linkBoundary": false, "inputBoundary": false }
  ],
  "cleanup": "PASS"
}
```

Neither supplied run reported a recognized Google selection or link/input boundary. Online
INCONCLUSIVE does not identify a root cause or prove the product cannot log in. The missing
byte counts, visible-output classification and actual exit codes remain unknown. Both modes'
old reservations are spent; the new authorization never resets or reuses those reservations.

Synthetic tests and the earlier author-side DOCKER_CLI_MISSING result are separate sources.
No fresh worker Docker/vendor observation is performed during implementation. After approval,
Hub can perform the one new reserved diagnostic attempt, reuse its completed result, or report
its exact blocker. No new actual diagnostic JSON is available to the author yet; the new host
outcome remains pending. The worker has not independently read the actual host checkpoint or
result in this session and must not rerun an observation to obtain report evidence.

## Unresolved questions and diagnostic interpretation

Credential persistence, post-consent completion, code reprompt, student entitlement, refresh,
complete tool removal and a model-free completion/status command remain unestablished. The
known consumer-plan wrapping restriction remains unresolved context
([FAQ](https://antigravity.google/docs/faq/)); the user's subscription decision is not reopened
and official approval is not asserted. ModelRequests 0 describes permitted runner actions, not
network packet inspection. A working dialog/production adapter is not established.

The newly authorized attempt changes only diagnostic capture. It can distinguish EMPTY,
CONTROL_ONLY, UNRECOGNIZED_VISIBLE/recognized boundary, nullable client exit code and fixed
error category. Those are bounded pattern/count facts, not a root cause, vendor exit code,
rendered screen or successful login contract. Fresh actual output, cached diagnostic evidence,
user-supplied prior evidence and synthetic fixtures must be reported separately. If the host
result is unavailable to the author, state that limitation and leave its outcome pending.
Return evidence and any further decision through the planner. No second startup, dialog work,
issue mutation, PR, deployment or integration is authorized.
