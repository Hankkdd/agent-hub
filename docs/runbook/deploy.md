# Deployment

Development lives in `~/agent-hub`. Production runs from a separate clone, `~/agent-hub-prod`, and is
changed only by deploys: by hand, from the Hub's Deploy button, or by the optional auto-deploy timer
once `main` passes CI ([Automatic deploys](#automatic-deploys)). Without the timer, merging a PR does not deploy it. Keep the database, token, credentials,
and other data outside both checkouts. Installed systemd units live in `~/.config/systemd/user`, so
checking out a broken revision cannot replace the service configuration. There is no watchdog yet.

## First-time setup

Use the same host account that already runs Agent Hub. Install the tools in
[host requirements](host-requirements.md), including mise at `~/.local/bin/mise`, and put it on `PATH`.
Run these commands in a host terminal, not in an agent turn that will die when its server stops.

1. Clone production independently (do not use a linked Git worktree). Substitute the repository URL:

   ```bash
   git clone --branch main <repository-url> "$HOME/agent-hub-prod"
   cd "$HOME/agent-hub-prod"
   mise trust
   mise install
   mise exec -- pnpm install --frozen-lockfile
   mise exec -- pnpm --filter @agent-hub/web build
   ```

2. Finish running tasks and handle any task worktrees before moving data: their stored paths are
   absolute. Stop development, choose an absolute directory outside **every** Git checkout, and move
   the existing data there. This example assumes the previous default `~/agent-hub/data`; use the
   actual old data path if configured differently. Do not move a live SQLite database.

   ```bash
   systemctl --user stop agent-hub.service
   export AGENT_HUB_DATA="$HOME/.local/share/agent-hub"
   mkdir -p "$(dirname "$AGENT_HUB_DATA")"
   test ! -e "$AGENT_HUB_DATA"
   mv "$HOME/agent-hub/data" "$AGENT_HUB_DATA"
   chmod 700 "$AGENT_HUB_DATA"
   ```

3. Write the shared service environment file with the **expanded absolute path** (systemd does not
   expand `$HOME` or `~` inside it). For an existing env file, merge these assignments into it and
   preserve model/runtime settings; the commands below create a new file. This file is also sourced
   by the deploy examples, so use shell-compatible assignments with quoted paths:

   ```bash
   mkdir -p "$HOME/.config/agent-hub"
   printf 'AGENT_HUB_DATA="%s"\nAGENT_HUB_PORT=8787\nAGENT_HUB_HOST=127.0.0.1\n' \
     "$AGENT_HUB_DATA" > "$HOME/.config/agent-hub/env"
   chmod 600 "$HOME/.config/agent-hub/env"
   ```

   Production serves the built UI on the API port (default 8787), rather than Vite's port 5173.
   Deployment checks connect to `AGENT_HUB_HOST` (loopback when it is unset or a wildcard such as
   `0.0.0.0`), so binding only a tailnet address works. To serve other devices, either bind the tailnet
   address or use `AGENT_HUB_HOST=0.0.0.0` with host firewall rules restricting access to the tailnet. Development started
   manually must also load this env file to use the moved data directory. Never run both services
   against the same database at once, even on different ports.

4. Install the units from the development checkout and switch to production:

   ```bash
   bash "$HOME/agent-hub/deploy/install.sh"
   systemctl --user disable --now agent-hub.service
   cd "$HOME/agent-hub-prod"
   printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(git rev-parse HEAD)" \
     >> "$AGENT_HUB_DATA/deploy-history"
   systemctl --user enable --now agent-hub-prod.service
   systemctl --user status agent-hub-prod.service
   ```

   The installer retains its existing behavior of enabling the development unit; it never starts
   either service and never enables production. The explicit switch above disables development.
   If the installer reports that lingering is off, follow its printed command to keep the user
   service running after logout. The production service starts the server directly and never builds.
   For a nondefault production directory, set `AGENT_HUB_PROD_DIR` for deployments and use
   `systemctl --user edit agent-hub-prod` to override `WorkingDirectory` with the same absolute path.

## Deploy

Run on the host, after choosing a quiet moment. Load the same settings the service uses:

```bash
set -a
source "$HOME/.config/agent-hub/env"
set +a
bash "$HOME/agent-hub/scripts/deploy.sh"                # origin/main, fetched before resolving
bash "$HOME/agent-hub/scripts/deploy.sh" <ref-or-sha>   # explicit revision
```

`AGENT_HUB_PROD_DIR` defaults to `~/agent-hub-prod`; `AGENT_HUB_DATA` is required and must already exist.
The production checkout must be clean, including untracked files. The script authenticates
`GET /api/tasks` using the data directory's token and refuses while any task is `running` or
`waiting_user`. An unreachable server, bad token, or invalid response also stops deployment. Use
`--force` explicitly to bypass this task check, for example when recovering a stopped service; it can
interrupt active turns. It does not bypass checkout cleanliness, data validation, or backup failures.
Avoid starting new tasks until deployment finishes; the script does not lock out new requests.

Before fetching, the script uses the production checkout's installed `better-sqlite3` to run
`VACUUM INTO` on the existing `agent-hub.db`, including committed WAL contents. Backups are named
`backups/agent-hub-<UTC timestamp>-<old short sha>.db`; the newest ten are retained. It then fetches
`origin`, resolves the requested commit, checks it out detached, installs the frozen lockfile, and
builds the web app. Only after a successful build does it append the timestamp and target SHA to
`deploy-history` and restart `agent-hub-prod`.

It waits up to 60 seconds for an authenticated task-list response and prints the last 50 service log
lines on restart/readiness failure, then rolls back: it checks out the revision that was running,
installs, builds, restarts and waits for readiness again, and still exits non-zero. If the failed
revision changed `apps/server/drizzle`, it first stops the service, moves the database and its WAL/SHM
sidecars to `failed-db-<timestamp>/` in the data directory and restores the backup taken at the start
of this deploy; anything written in between is only in that saved copy. History records built
deployment attempts, including the failed one and the rollback. A failed install/build leaves the
checkout at the requested revision without restarting or adding history, and the running server is
untouched. A rollback that itself fails prints "manual recovery required"; follow
[Roll back code](#roll-back-code).

## Deploy from the Hub

The sidebar **Deploy** button deploys only the displayed `origin/main` SHA. Install the template
and updated production unit once, by hand from a checkout containing this feature:

```bash
bash "$HOME/agent-hub/deploy/install.sh"
systemctl --user daemon-reload
systemctl --user disable agent-hub.service
systemctl --user restart agent-hub-prod
```

The installer also enables the development service; disable it again as shown above when using
production. Do not reinstall units as part of routine deploys. For a nondefault production path,
manual overrides must align the template's `WorkingDirectory` and `ExecStart`, the production unit's
`WorkingDirectory`, and `AGENT_HUB_PROD_DIR` in the shared environment file.

Only the production unit sets `AGENT_HUB_DEPLOY_ENABLED=1`. The button checks that deployment is
enabled, the checkout is Git, the installed template exists, the checkout is clean (including untracked
files), and no task is running or waiting for user input. It shows current/target commits, up to 30
pending commits newest first, the latest request outcome, and the last built attempt from history.
Confirm is disabled when no commits are pending. Git fetch is shared and attempted at most once per
60 seconds; on failure the dialog shows an error and the last known refs. Confirmation sends the
exact displayed full SHA; a target mismatch requires reviewing again. The unit never passes `--force`.
Git fetch inside the unit needs the user's non-interactive Git credentials (for example an available
SSH agent or credential helper); interactive password prompts cannot be answered by the button.

The server saves `deploy-request.json` in the data directory, then starts the independent
`agent-hub-deploy@<sha>.service` user unit with `systemctl --user start --no-block`. The deploy script
survives the production server restart because it belongs to a different systemd cgroup. The installed
unit runs the script from the production checkout and has a 30-minute timeout. Once accepted, the
current server rejects task creation, messages, answers, recovery, agent switching, briefing and
explanation generation, and PR preparation/publication with HTTP 409 until it exits. Read routes
remain available. **Planner MCP tool calls are not locked**; avoid using them during deployment.
The script rechecks tasks, backs up, installs/builds, and waits for readiness as in manual deployment.

The dialog polls every three seconds through connection failures during restart and reads systemd's
result afterward. Success means the unit finished successfully; failures show the last 50 journal
lines. A failure before server restart leaves the current process locked; inspect the logs and recover
manually, then restart the production service to clear that lock. A restart that never becomes healthy
requires host access only if the automatic rollback also fails; the dialog cannot report a result while
the API remains unreachable. There is no watchdog. Inspect deployment logs on the host with:

```bash
journalctl --user -u 'agent-hub-deploy@*' -n 50 --no-pager
journalctl --user -u 'agent-hub-deploy@<sha>.service' -n 50 --no-pager -o cat
```

## Automatic deploys

`agent-hub-auto-deploy.timer` runs `apps/server/scripts/auto-deploy.ts` from the production checkout
about every five minutes. Each pass asks the Hub for its deploy status (`GET /api/deploy`, which fetches
`origin`) and starts a deploy of `origin/main` through the same `POST /api/deploy` as the Deploy button
when all of these hold:

- the commit is not already deployed and no deploy is running;
- every GitHub check run on the commit has completed with success, skipped or neutral, and the `check`
  job from CI is among them (set `AGENT_HUB_AUTO_DEPLOY_CHECKS`, comma-separated, in the env file to
  require other names);
- no task is running or waiting for you; otherwise the Hub refuses and the next pass tries again;
- the last deploy of this same commit did not fail. A failed commit, which the deploy script has
  already rolled back, is not retried; the next commit on `main`, or the Deploy button, moves on.

Each pass also records the outcome of the latest finished deploy, including button and auto deploys,
as a GitHub deployment in the `production` environment, so the repository's Deployments page shows
what production runs. It remembers what it reported in `auto-deploy.json` in the data directory.
Reporting failures are logged and retried; they never block a deploy. The script reads the Hub token
from the data directory and calls GitHub through `gh`, so the host account needs a non-interactive
`gh auth login` with access to the repository.

Enable it once, after the Deploy button works (installing the units from a checkout that has them):

```bash
bash "$HOME/agent-hub/deploy/install.sh"
systemctl --user disable agent-hub.service    # the installer re-enables development
systemctl --user enable --now agent-hub-auto-deploy.timer
systemctl --user list-timers agent-hub-auto-deploy.timer
journalctl --user -u agent-hub-auto-deploy -n 20 --no-pager
```

To pause automatic deploys, `systemctl --user disable --now agent-hub-auto-deploy.timer`. Requiring
CI before merging is a GitHub setting: protect `main` with the `check` status as required, so a red
commit cannot reach `main` in the first place.

## Roll back code

Choose a previously working SHA from `deploy-history`. Stop the service before changing files, restore
the dependencies and built UI for that revision, and restart. These are operator commands for the
production checkout; agents must continue to leave their task worktrees uncommitted.

```bash
set -a
source "$HOME/.config/agent-hub/env"
set +a
cat "$AGENT_HUB_DATA/deploy-history"
cd "${AGENT_HUB_PROD_DIR:-$HOME/agent-hub-prod}"
git status --short                         # must be clean; investigate any edits
systemctl --user stop agent-hub-prod.service
git checkout --detach <earlier-sha>
mise exec -- pnpm install --frozen-lockfile
mise exec -- pnpm --filter @agent-hub/web build
# Restore a compatible database here if the newer code migrated its schema (below).
systemctl --user restart agent-hub-prod.service
systemctl --user status agent-hub-prod.service
journalctl --user -u agent-hub-prod -n 50 --no-pager
```

An older commit may require an older database schema. Code rollback alone does not undo migrations.

## Restore a database backup

Stop every service/manual process using this data directory. Choose the backup made before the failed
deployment, whose filename identifies the code it backed up. Restoration loses changes made since
that backup. Save the current database **and its WAL/SHM sidecars** together before replacing it, so
stale WAL pages cannot be replayed onto the restored database:

```bash
systemctl --user stop agent-hub-prod.service agent-hub.service
saved="$AGENT_HUB_DATA/failed-db-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir "$saved"
for file in agent-hub.db agent-hub.db-wal agent-hub.db-shm; do
  if [[ -f "$AGENT_HUB_DATA/$file" ]]; then
    mv "$AGENT_HUB_DATA/$file" "$saved/$file"
  fi
done
cp "$AGENT_HUB_DATA/backups/<backup-filename>.db" "$AGENT_HUB_DATA/agent-hub.db"
chmod 600 "$AGENT_HUB_DATA/agent-hub.db"
# Check out, install, and build the matching code revision before restarting, as above.
systemctl --user restart agent-hub-prod.service
```

Do not reinstall the units during routine deployment or rollback. Update installed units by running
the installer by hand only when you intend to change how services start.

Planners can inspect deployment status through the read-only `host_status` tool and read production
or latest button-deploy logs through `read_service_log` (`prod` or `deploy`). Logs redact known secret
patterns and the Hub token, support fixed-string filters, and have bounded output. Planners must use
these tools instead of asking users to run host commands; when blocked, they explain the missing
information and offer actions available in the Hub through `ask`.
