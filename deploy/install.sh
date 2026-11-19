#!/usr/bin/env bash
# Install (or update) the Agent Hub user services. Run by hand; deploys never run it, so a broken
# deploy cannot break the way the service is started.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$HOME/.config/systemd/user" "$HOME/.config/agent-hub"
cp "$here/agent-hub.service" "$HOME/.config/systemd/user/agent-hub.service"
cp "$here/agent-hub-prod.service" "$HOME/.config/systemd/user/agent-hub-prod.service"
cp "$here/agent-hub-deploy@.service" "$HOME/.config/systemd/user/agent-hub-deploy@.service"
cp "$here/agent-hub-auto-deploy.service" "$HOME/.config/systemd/user/agent-hub-auto-deploy.service"
cp "$here/agent-hub-auto-deploy.timer" "$HOME/.config/systemd/user/agent-hub-auto-deploy.timer"
if [[ ! -f "$HOME/.config/agent-hub/env" ]]; then
  # Defaults to loopback; set AGENT_HUB_HOST to this machine's tailscale IP to reach it from other devices.
  printf 'AGENT_HUB_HOST=127.0.0.1\n' > "$HOME/.config/agent-hub/env"
  echo "created ~/.config/agent-hub/env (AGENT_HUB_HOST=127.0.0.1); edit it, then: systemctl --user restart agent-hub"
fi
systemctl --user daemon-reload
systemctl --user enable agent-hub.service
if [[ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" != "yes" ]]; then
  echo "note: without lingering the service stops when you log out. Enable it once with:"
  echo "  sudo loginctl enable-linger $USER"
fi
echo "installed. start or restart with: systemctl --user restart agent-hub"
echo "after production setup (docs/runbook/deploy.md), switch services with:"
echo "  systemctl --user disable --now agent-hub.service"
echo "  systemctl --user enable --now agent-hub-prod.service"
echo "to deploy main automatically once CI passes and the Hub is idle:"
echo "  systemctl --user enable --now agent-hub-auto-deploy.timer"
