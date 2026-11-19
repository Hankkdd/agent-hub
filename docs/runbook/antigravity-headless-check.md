# Antigravity headless credential check

This is step 0 of Gemini integration: test whether the official Antigravity CLI 1.3.6 can
use the login panel's saved home non-interactively. It makes **at most three real model
requests against the user's Google subscription**, with the existing synthetic hunk prompt
and `--agent hub-prototype --output-format stream-json -p ...`.
No `--model` flag is passed: the CLI selects the account default. The login panel displayed
"Gemini 3.8 Flash" for the authorized account, but this script does not query model names or
make extra requests to discover them. The ledger records the choice as `ACCOUNT_DEFAULT`.
It does not add an adapter or change the login panel.

## Run on the Hub host after review approval

The author container has no Docker. Hub's post-review test command must be:

```bash
mise trust -q && mise exec -- pnpm install --frozen-lockfile --prefer-offline && mise exec -- pnpm typecheck && mise exec -- pnpm test && mise exec -- pnpm --filter @agent-hub/web build && mise exec -- pnpm --filter @agent-hub/server exec tsx scripts/antigravity-headless-check.ts
```

The final script accepts no arguments. `AGENT_HUB_DATA` must select the same data directory
as the running Hub; when unset it defaults to the checkout's `data/`. Run as the non-root
Hub user on an ARM64 host with access to an ARM64 Docker daemon. The pinned prototype image
is reused, or built if absent. No test starts Docker, contacts Google, or invokes a model.

The script mounts `<dataDir>/antigravity/home` at `/home/prototype`, writable so the CLI can
refresh its own files. It never copies credentials into another profile. Missing/empty homes,
running login containers (the panel's name prefix or ownership label), inaccessible Docker,
and unavailable ARM64 cause refusal before any container starts. Stop the panel's login
session before scheduling this check and keep it stopped until completion.

The sequence is fixed:

1. Start a new container and run one fresh `agy` process.
2. Run another fresh `agy` process in that same container.
3. Remove the container, create another with the same home, and run one fresh `agy` process.

Each model process has a 60-second timeout. A failure, timeout or cancellation stops the
sequence; remaining requests stay `NOT_RUN`. There are no retries. After a timeout the
container is removed before returning, which also kills any remaining CLI process.
Container startup failures also trigger removal; cleanup uses its own uncancelled timeout.
A cleanup failure is reported and must not be interpreted as successful verification.
As with any process, SIGKILL or host power loss can prevent its finalizer from running.

## Permanent ledger

The current ledger is `<dataDir>/antigravity-headless-check/v2/ledger.json`. Its parent
`v2/` is an exclusive, permanent one-use claim. The prototype's shared ledger implementation
charges and fsyncs each request before sending, with at most three charges in this budget.
Safe results are saved after each request and after cleanup. Each ledger contains:

| Field | Meaning |
| --- | --- |
| `version` | `2` |
| `cliArguments` | `["agy", "--agent", "hub-prototype", "--output-format", "stream-json", "-p"]`; the prompt value after `-p` is deliberately omitted |
| `modelChoice` | `ACCOUNT_DEFAULT`; no model override or model-discovery request |
| `attempts`, `completed` | Charged requests and requests with successful auth plus terminal success |
| `result` | Only the fixed safe summary described below |
| `continuation` | If present, `REQUESTS_2_AND_3_REPLACEMENT_CONTAINER`; the one-time continuation was claimed |

A claimed `v2/` directory, even empty or partially written, normally permits no further
execution. The only exception is the specifically authorized two-request continuation below;
it keeps the same budget and never retries request 1. Interrupted/failed requests are not retried. Later invocations validate and
reprint the stored result without calling Docker or sending requests, even when fewer than
three requests ran. A missing result returns `INCOMPLETE_NO_RETRY`; malformed state returns
`STATE_UNAVAILABLE`. Do not delete, copy, reset or relocate a ledger, or change the data root
to obtain another budget. Prerequisite refusals before the claim do not consume requests.

### One authorized migration from the pre-model failure

The previous `--model flash` selection was rejected locally before a model call. The user
authorized exactly one replacement budget. If no `v2/` claim exists, an old ledger at
`<dataDir>/antigravity-headless-check/ledger.json` is eligible only when its version is absent
or `1`, `attempts` is `1`, `completed` is `0`, the overall code is `REQUEST_FAILED`, cleanup
is `PASS`, request 1 is `FAIL` with no protocol evidence, and requests 2 and 3 are unused.
Request 1 must either have `reasonCode: INVALID_MODEL`, or have no reason code and
`loginRequested: false` (the specifically authorized historical fallback).

After prerequisite checks, the script exclusively claims and fsyncs `v2/`, then moves the old
ledger unchanged to `archive-v1/ledger.json` and fsyncs the archive before any new CLI request.
Concurrent callers cannot both migrate. An interrupted archive or migration consumes the
claim; it is never repaired automatically. Any other old result is reprinted without new
requests. Missing historical reason codes are displayed as `UNKNOWN` for failed requests,
`NONE` for passes, or `NOT_RUN` for unused slots; the old ledger is not rewritten.
A `v2` failure, including `INVALID_MODEL`, never qualifies for another budget.

### One-time continuation of the current v2 budget

The user confirmed that the current request 1 was a real request whose output failed the old
strict diff-answer validator. Continue only a v2 ledger with `attempts: 1`, `completed: 0`,
overall `REQUEST_FAILED`, cleanup `PASS`, and request 1 `FAIL` / `PROTOCOL_ERROR` with
`loginRequested: false` and no stored protocol/auth/completion/answer evidence. Requests 2
and 3 must be entirely unused. Explicit model/argument metadata must match the account-default
command. Other states are reprinted without new requests.

After prerequisite checks, the script exclusively creates `v2/remaining-requests-claim/`
and fsyncs its parent before changing any ledger or dispatching a request. It rechecks the
ledger, copies its exact bytes to `remaining-requests-claim/ledger-before-continuation.json`,
and fsyncs that backup before recording the continuation metadata. The marker is permanent;
any existing marker (even empty) or saved continuation metadata blocks another continuation.
Concurrent callers cannot both claim it. A crash before either remaining request does not
permit restarting the continuation. Prerequisite refusals before claiming leave the ledger
and continuation authorization unchanged.

Request 1 stays consumed and its original stored request object is retained without changes.
The counter increases from 1 to 2 before request 2, then to 3 before request 3; it never
resets. Request 2 uses a fresh process in a replacement container because the original
container was already removed. That replacement is removed, then another container is
created with the same home for request 3. This verifies fresh-container credential reuse;
it cannot retroactively establish that requests 1 and 2 shared a container. Failures and
cancellation stop the continuation; unused slots are never automatically resumed.

When requests 2 and 3 pass, `COMPLETE_WITH_UNVERIFIED_HISTORY` reports that the remaining
checks finished successfully. Request 1 still shows its original failure and unknown new
evidence. This is an explicit partial-history outcome, not a claim that all three requests
were verified. Subsequent runs only reprint the stored result without any Docker operation.

## Repository-seeded config warning

The redacted host log reported a non-fatal protobuf-JSON parser error at line 5 of
`/home/prototype/.gemini/config/config.json` (`unexpected token [`). The login seed and
prototype setup copied this repository's legacy settings JSON there; its `plugins: []`
field is not valid for that protobuf configuration. Prototype setup now writes the minimal
protobuf-JSON object `{}` at `config/config.json`, while keeping the separate tool-disabling
settings and agent file.

Before creating headless containers, the check repairs the panel home's `config/config.json`
only if it still matches the repository seed byte for byte. It validates the path, refuses
links, and never rewrites a CLI-created or account-specific configuration. The initial file
snapshot is refreshed after this repair, so request file-change counts exclude the repair.
The panel itself is unchanged. If the CLI rewrote the config during login, it is left intact;
remaining stderr warnings do not by themselves invalidate the JSON event stream. Explicit
login prompts still count as authentication failures. No raw diagnostic text or config content is included in the result.

## Read the single JSON result

The script prints exactly one JSON object, with only these fields:

| Field | Meaning |
| --- | --- |
| `code` | Fixed overall completion/refusal/failure code |
| `cleanup` | `NOT_NEEDED`, `PASS`, or `FAIL`; `FAIL` may also mean cleanup was not confirmed before interruption |
| `requests` | Three entries in request order, including unused slots |

Each request has exactly these fields:

| Field | Meaning |
| --- | --- |
| `status` | `PASS` when auth passed and a terminal success event arrived; otherwise `FAIL`, `TIMEOUT`, or `NOT_RUN` |
| `auth` | `PASS` when a terminal success or explicit silent-auth success was observed without a login prompt; otherwise `FAIL`; `null` when not observed |
| `completed` | Whether a terminal success event was received; `null` for unused or unverifiable historical entries |
| `protocol` | `PASS` or `FAIL` for stream event parsing/validation, independently of auth/completion; `null` when unknown |
| `answerShape` | `MATCH` or `MISMATCH` against the existing synthetic structured format; `null` when unknown |
| `reasonCode` | Fixed failure classification; `NONE` on a pass, `NOT_RUN` for an unused slot |
| `advertisedTools` | Count from init metadata, or `null` when unavailable; tool names are never returned |
| `observedToolEvents` | Observed tool/subagent event count, or `null` before observation |
| `steps` | Number of parsed step updates, or `null` before observation |
| `terminal` | `SUCCESS` when a terminal success event was received, otherwise `null` |
| `structuredHunks` | `1` for `answerShape: MATCH`, otherwise `null` |
| `strictIsolation` | Always `UNVERIFIED`, matching the prototype verifier |
| `loginRequested` | Boolean detection of login/authentication prompts from bounded CLI output; `null` before observation |
| `homeFilesChanged` | Count of added, removed, or changed files since the preceding snapshot; `null` if unavailable |

Failure reasons are `INVALID_MODEL`, `LOGIN_REQUIRED`, `QUOTA_EXHAUSTED`, `TIMEOUT`,
`CLI_ERROR`, `PROTOCOL_ERROR`, `CANCELLED`, `INTERRUPTED`, or historical `UNKNOWN`.
Known bounded CLI stdout/stderr patterns identify invalid model selection, login prompts and
exhausted quota. Merely fetching a quota summary is not classified as exhausted quota.
Timeout and cancellation take priority. Other process failures become `CLI_ERROR`; a
successful process with rejected stream reports the exact fixed check: `NO_INIT_EVENT`,
`NO_RESULT_EVENT`, `RESULT_NOT_SUCCESS`, `UNEXPECTED_EVENT`, `MALFORMED_JSON`,
`INVALID_INIT_EVENT`, `MALFORMED_RESULT`, `CONVERSATION_MISMATCH`, `AFTER_RESULT`, or
`OUTPUT_LIMIT`. `PROTOCOL_ERROR` remains only for historical records. Classification is a
heuristic, not a claim about how many remote requests a provider accepted. Raw text is never
retained in the ledger. A charged request interrupted before its outcome was saved has
`FAIL` / `INTERRUPTED`. None of these reasons grants a retry in the v2 budget.

File changes compare content hashes and file metadata. Directories are not counted. Symbolic
links and special entries such as CLI sockets are compared by their own metadata; their targets
are never followed and special files are never opened. Names, hashes and contents are never
output or stored in the ledger. Snapshots are bounded (4,096 entries, 16 MiB per regular file,
64 MiB total regular-file content). An unreadable, changing or oversized snapshot makes
`homeFilesChanged` null for that interval; it does not prevent the credential check. Both
before and after snapshots must be available to report a count. A file-change count can reflect refreshes,
caches or other CLI writes; it does not prove token refresh. Login detection is a text heuristic;
`false` does not prove credentials are valid. Authentication and terminal success determine request success; answer shape and tool metadata do not fail it.

`COMPLETE`, three `PASS` entries, and cleanup `PASS` show that the saved home worked for the
three tested process/container boundaries. This does not establish future token expiry or
refresh behavior, subscription quota, strict tool isolation, or adapter readiness. `PASS`
requires successful authentication and a terminal success event. The headless checker uses
an independent stream parser and the prototype's shared synthetic answer-shape helper. The
original strict prototype verifier is unchanged. Answer mismatches and tool metadata never
fail a request. A stream may report `protocol: FAIL` and a fixed check while independently
retaining `auth: PASS` and `completed: true`; such a request still passes the requested auth
check. Benign stderr logs are not treated as malformed stream-json. A missing/non-success
terminal event or failed authentication fails the request. A timeout yields `TIMEOUT`.

No raw output was saved for the current budget's historical request 1, so its `FAIL` /
`PROTOCOL_ERROR` outcome cannot be re-evaluated from the ledger. Its new evidence fields
remain `null`; the redacted host-log report is external evidence and is not synthesized into
stored terminal events. The request remains consumed. Old successful entries with verified
terminal/shape evidence can populate the corresponding new fields without another request.
The prior container was removed (`cleanup: PASS`), so remaining request 2 uses the replacement
container described in the one-time continuation above. Request 3 is recreated afterward.

Overall codes are `COMPLETE`, `COMPLETE_WITH_UNVERIFIED_HISTORY`, `HOME_MISSING_OR_EMPTY`, `LOGIN_SESSION_RUNNING`,
`DOCKER_UNAVAILABLE`, `ARM64_REQUIRED`, `STATE_UNAVAILABLE`, `INCOMPLETE_NO_RETRY`,
`REQUEST_FAILED`, `REQUEST_TIMEOUT`, `CANCELLED`, `CONTAINER_FAILED`, `CLEANUP_FAILED`,
and `NO_ARGUMENTS_ALLOWED`. Exit status is zero for `COMPLETE` and
`COMPLETE_WITH_UNVERIFIED_HISTORY`, including their stored results. The latter confirms only
the two remaining checks while preserving the unverified historical request 1. Every other
code exits nonzero so the host test stage exposes the blocker.

Raw CLI logs, response text, account identity, tokens and conversation IDs are never printed
or persisted by this check. Docker logging is disabled. Credential files remain in the
panel's home and are managed by the CLI itself. Preserve the JSON from the host test stage
as the experiment evidence; do not infer live success from the offline fixtures.
