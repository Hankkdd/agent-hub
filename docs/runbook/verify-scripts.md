# Verification scripts

Run from the repository root after installing dependencies (`mise exec -- pnpm install --frozen-lockfile`).
These checks run real containers without a model, login, or API quota.

| Script | Needs | Proves |
| --- | --- | --- |
| `pnpm verify:images` (`apps/server/scripts/verify-images.ts`) | Node 22, pnpm 10, installed dependencies, Docker CLI and a running daemon on a Unix host; network access for the first image build | With the current uid/gid and `HOME=/tmp`, Codex matches the SDK's expected version and resolves outside mise shims; Node 22, pnpm 10, and `mise exec -- pnpm` work both without and with the repo's mise.toml. A derived toolchain image resolves Go 1.26.5 and make in an empty directory and a mise project, while Codex still matches the SDK and resolves outside mise shims. The media image runs yt-dlp and imports faster-whisper and PyAV. |

Run `mise exec -- pnpm verify:images` whenever a Dockerfile, the codex-docker wrapper, or an image spec
changes, before merging. Images are built only when their content-addressed tag is missing. Allow
several minutes for a first build; cached images usually take under a minute to verify. Each check
prints PASS or FAIL, failures include command output, and any failure produces a nonzero exit status.

CI runs the image checks only for changes under `apps/server/docker/`,
`apps/server/bin/codex-docker`, `apps/server/src/agents/codex-docker.ts`,
`apps/server/src/docker/`, or `apps/server/src/media/`.

## Opt-in Antigravity prototype

The prototype is separate from production image verification. See
[the prototype runbook](antigravity-prototype.md) for its pinned ARM64 artifact, isolated state,
blocked browser-login boundary, evidence categories, and remaining uncertainties.

- `mise exec -- pnpm antigravity:prototype`: offline protocol fixture only, no Docker/account/model.
- `mise exec -- pnpm --filter @agent-hub/server exec vitest run test/antigravity-prototype.test.ts`:
  fake processes and temporary state only, included in normal tests.
- `mise exec -- pnpm antigravity:prototype image-check`: explicit real Docker build/version/help/containment
  check, temporary isolated state and no container network, account login, or model request.
- `login-prepare`, `live-initial`, and `live-restart` are separate explicit prototype commands. Preparation
  currently reports blocked before OAuth; only the live commands can consume subscription quota, with a
  persistent three-attempt ceiling. They are never invoked by normal tests or `verify:images`.

A fixture pass does not prove vendor tool removal or authentication. An image check does not prove
subscription entitlement, credential persistence/refresh, or model behavior. Report unavailable Docker
or browser interaction as BLOCKED/NOT RUN and return decisions through the planner.
