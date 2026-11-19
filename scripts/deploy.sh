#!/usr/bin/env bash
set -euo pipefail

# Keep the whole operation in a function: checkout may replace this script on disk.
main() {
  local ref="origin/main" force=0 ref_given=0 arg
  for arg in "$@"; do
    case "$arg" in
      --force) force=1 ;;
      -*) echo "Usage: $0 [--force] [ref]" >&2; return 1 ;;
      *)
        if [[ "$ref_given" == 1 ]]; then
          echo "Usage: $0 [--force] [ref]" >&2
          return 1
        fi
        ref="$arg"
        ref_given=1
        ;;
    esac
  done

  local script_dir prod data old_sha sha
  script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
  prod=$(realpath -e "${AGENT_HUB_PROD_DIR:-$HOME/agent-hub-prod}")
  : "${AGENT_HUB_DATA:?Set AGENT_HUB_DATA to an absolute directory outside any checkout}"
  if [[ "$AGENT_HUB_DATA" != /* ]]; then
    echo "AGENT_HUB_DATA must be absolute." >&2
    return 1
  fi
  data=$(realpath -e "$AGENT_HUB_DATA")
  if [[ ! -d "$data" ]] || git -C "$data" rev-parse --absolute-git-dir >/dev/null 2>&1; then
    echo "AGENT_HUB_DATA must be a directory outside any Git checkout." >&2
    return 1
  fi
  cd "$prod"
  if [[ "$(git rev-parse --show-toplevel)" != "$prod" ]]; then
    echo "AGENT_HUB_PROD_DIR must be the root of the production checkout." >&2
    return 1
  fi
  if [[ -n "$(git status --porcelain --untracked-files=all)" ]]; then
    echo "Refusing to deploy: production checkout has uncommitted changes." >&2
    return 1
  fi

  # Check the address the server binds (AGENT_HUB_HOST): a server bound only to a tailnet address is not
  # reachable on loopback. A wildcard bind is.
  local check_host="${AGENT_HUB_HOST:-127.0.0.1}"
  case "$check_host" in 0.0.0.0|::|"[::]") check_host=127.0.0.1 ;; esac
  if [[ "$check_host" == *:* && "$check_host" != \[* ]]; then check_host="[$check_host]"; fi

  # Defined before checkout so readiness still works when deploying an older script version.
  server_check() {
    mise exec -- node --input-type=module - "$data" "${AGENT_HUB_PORT:-8787}" "$check_host" "$1" <<'NODE'
import fs from 'node:fs';
import { setTimeout } from 'node:timers/promises';
const [data, port, host, mode] = process.argv.slice(2);
try {
  const token = fs.readFileSync(`${data}/token`, 'utf8').trim();
  if (!token) throw new Error('Token file is empty');
  const deadline = Date.now() + (mode === 'wait' ? 60_000 : 5_000);
  let lastError;
  do {
    try {
      const response = await fetch(`http://${host}:${port}/api/tasks`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(Math.max(1, Math.min(5_000, deadline - Date.now()))),
      });
      if (!response.ok) throw new Error(`GET /api/tasks returned HTTP ${response.status}`);
      const tasks = await response.json();
      if (!Array.isArray(tasks) || tasks.some(task => !task || typeof task.status !== 'string')) {
        throw new Error('GET /api/tasks returned an invalid task list');
      }
      if (mode === 'check' && tasks.some(task => ['running', 'waiting_user'].includes(task.status))) {
        throw new Error('Tasks are running or waiting for the user; wait or use --force');
      }
      process.exit(0);
    } catch (error) {
      lastError = error;
      if (mode !== 'wait') throw error;
    }
    await setTimeout(Math.max(0, Math.min(1_000, deadline - Date.now())));
  } while (Date.now() < deadline);
  throw new Error(`Server did not become ready within 60 seconds: ${lastError.message}`);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
NODE
  }

  if [[ "$force" == 0 ]]; then
    server_check check
  else
    echo "--force: skipping the task safety check; active turns may be interrupted." >&2
  fi
  local old_full backup_output backup
  old_full=$(git rev-parse HEAD)
  old_sha=$(git rev-parse --short HEAD)
  backup_output=$(mise exec -- node "$script_dir/backup-db.cjs" "$prod" "$data" "$old_sha")
  echo "$backup_output"
  backup=$(sed -n 's/^Database backup: //p' <<<"$backup_output")
  git fetch origin
  sha=$(git rev-parse --verify --end-of-options "${ref}^{commit}")
  git checkout --detach "$sha"
  mise exec -- pnpm install --frozen-lockfile
  mise exec -- pnpm --filter @agent-hub/web build
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$sha" >> "$data/deploy-history"
  if start_service; then
    echo "Deployed $sha"
    return 0
  fi
  rollback "$old_full" "$sha" "$backup"
  return 1
}

start_service() {
  if systemctl --user restart agent-hub-prod && server_check wait; then return 0; fi
  journalctl --user -u agent-hub-prod -n 50 --no-pager >&2 || true
  return 1
}

# A revision that built but never became healthy is replaced by the one that was running. The
# database is restored only when the failed revision carried new migrations, because restoring
# loses whatever was written after the backup and an unchanged schema needs no undo.
rollback() {
  local good="$1" bad="$2" backup="$3" file saved
  echo "Rolling back to $good" >&2
  git checkout --detach "$good"
  if ! git diff --quiet "$good" "$bad" -- apps/server/drizzle; then
    if [[ -z "$backup" || ! -f "$backup" ]]; then
      echo "Rollback failed: migrations changed and no database backup was found." >&2
      return 1
    fi
    systemctl --user stop agent-hub-prod || true
    saved="$data/failed-db-$(date -u +%Y%m%dT%H%M%SZ)"
    mkdir "$saved"
    for file in agent-hub.db agent-hub.db-wal agent-hub.db-shm; do
      if [[ -f "$data/$file" ]]; then mv "$data/$file" "$saved/$file"; fi
    done
    cp "$backup" "$data/agent-hub.db"
    chmod 600 "$data/agent-hub.db"
    echo "Restored database from $backup; the failed revision's database is in $saved" >&2
  fi
  if ! mise exec -- pnpm install --frozen-lockfile || ! mise exec -- pnpm --filter @agent-hub/web build; then
    echo "Rollback failed: could not rebuild $good; manual recovery required." >&2
    return 1
  fi
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$good" >> "$data/deploy-history"
  if ! start_service; then
    echo "Rollback failed: $good did not become ready; manual recovery required." >&2
    return 1
  fi
  echo "Deploy of $bad failed; rolled back to $good" >&2
}

main "$@"
