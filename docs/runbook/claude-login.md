# Claude login panel

Open **Claude login** in the sidebar, or follow the link in Claude's missing-login quota state
when the active runtime is Docker. The status response includes the active Claude runtime. In host
mode the quota card hides this link and the dialog directs users to `claude auth login` on the host.
This manages the Hub-owned login at `<AGENT_HUB_DATA>/claude-home`, used only by
`AGENT_HUB_CLAUDE_RUNTIME=docker`. The host runtime keeps using the host's `~/.claude`.
Shipping the panel does not change the configured runtime.

## Sign in and renew

1. Confirm Docker is available to the Hub user. The image is the same image used for Claude Docker turns;
   it is prepared on first use, with a five-minute preparation deadline.
2. Open the panel and inspect the status and account. Use **Refresh login status** to re-probe.
3. Choose **Start**. Hub runs the SDK's exact Claude Code binary with `auth login --claudeai`.
4. Follow the official CLI's prompts. Open the HTTPS authorization link in a new tab and complete
   Claude account authorization there. Paste the one-time code into the panel and choose **Send**;
   the Enter toggle controls whether Enter follows the pasted text. Navigation buttons send keys.
5. After exit code zero, Hub re-runs `auth status --json` and forces a Claude quota refresh.
   The terminal's exit alone is not proof of an authenticated account; check the displayed status.

The panel reports **Logged in**, **Logged out** or **Login status unknown**, plus email and
subscription type when supplied by the CLI. Status is cached for 60 seconds. Explicit refresh
bypasses that cache after a ten-second cooldown. Valid JSON with a boolean `loggedIn` determines
status regardless of the CLI exit code (logged-out status normally exits 1). Transport failures,
timeouts or malformed output become unknown;
Hub never infers login from the existence of a credential file. Probes do not run during login.

Choose **Cancel** to stop a session. Closing the panel only stops polling: reopen it to resume or
cancel. **Sign out** requires confirmation, is refused during login, and runs only `auth logout`
in the same isolated container. Logout remains strict: a non-zero exit is a failure. It never deletes a host directory. Status and logout commands
have a 30-second deadline, and their short-lived containers are removed on completion or failure.

## Isolation and recovery

Only the validated private home (mode 0700, no symlinks) and the SDK binary (read-only at the same
path) are mounted. Containers use `/claude-home` with `CLAUDE_CONFIG_DIR=/claude-home` and
`HOME=/tmp`, run as the Hub user's uid/gid, and have a read-only root, no capabilities, no privilege
escalation, 64-process, 1 GiB memory and 2 CPU limits. `/tmp` is private tmpfs; networking is bridge;
Docker logging is disabled. There is no repository, Hub token, MCP, data-directory or Docker-socket mount.
Hub does not read, copy or parse credentials; only the official CLI accesses them.

The shared [terminal login bridge](antigravity-login.md) supplies the session lifecycle, terminal
rendering, HTTPS link extraction, redaction, key input, cancellation, orphan cleanup and Docker
attach. Only one Claude session runs at once, with five starts per rolling hour and a ten-minute
session deadline. These transient limits and screens reset on restart. Startup and shutdown remove
only this provider's containers labelled for this Hub data directory.

Screen and input are never saved to task events or logs. Pasted codes and token-like terminal text
are redacted; CLI authorization links are preserved. Probe output is projected to public account
fields only; unknown fields and token-like metadata are discarded. Runtime errors expose fixed
failure stages, not Docker output. Review the CLI's links before opening them.

If Docker is unavailable, restore its accessibility to the Hub user and retry. If the panel cannot
complete authorization, use `mise exec -- pnpm claude:login` in a real host terminal as a fallback.
This remains a Claude account login, not an API key, Console login or long-lived setup token.

HTTP routes use `/api/terminal-login/claude` for status (`?refresh=1` for explicit refresh),
`/login` for the session, and POST `/login/start`, `/login/input`, `/login/cancel` and `/logout`.
They require the same Hub authentication and no-store responses as Antigravity. Existing
`/api/antigravity` routes remain compatible.
