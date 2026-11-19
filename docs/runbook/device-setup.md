# Setting up a device for Agent Hub

A **device** is a machine agents may reach with `ssh_exec` and `copy_file`. This is the checklist for
letting Agent Hub into one. The Devices page shows the same steps with this installation's public key
already filled in; here it is `<AGENT_HUB_PUBLIC_KEY>`.

## The model

- **Agent Hub has its own SSH key** (`data/ssh/agent_hub_ed25519`, made on first start, gitignored). Only
  its *public* half goes on a device. You never paste your personal private key into Agent Hub, and
  removing one line from a device's `authorized_keys` revokes access to that device alone.
- **Commands run without asking** (design.md §7.3). The real limit on what an agent can do on a device is
  **the account it logs in as**, so give it the least that the work needs.
- **Host keys are pinned on first contact** (`data/ssh/known_hosts`). A device whose host key later changes
  is refused until you remove its line there.
- **Every command and copy is logged** per device (the Devices page).

## Linux (and macOS)

Run on the device, with sudo:

1. A user just for agents. No sudo. Not in the `docker` group: that group is root-equivalent.
   ```bash
   sudo useradd -m -s /bin/bash agent
   ```
2. Its `.ssh` directory and the key.
   ```bash
   sudo install -d -m 700 -o agent -g agent /home/agent/.ssh
   echo '<AGENT_HUB_PUBLIC_KEY>' | sudo tee /home/agent/.ssh/authorized_keys >/dev/null
   sudo chown agent:agent /home/agent/.ssh/authorized_keys && sudo chmod 600 /home/agent/.ssh/authorized_keys
   ```
3. Optional: give it one of your folders, read-only (`rwX` instead of `rX` to let it write). The `d:` part
   applies the same to files created there later.
   ```bash
   sudo setfacl -R -m u:agent:rX,d:u:agent:rX /path/to/folder
   ```
   A folder inside your home directory also needs your home to be passable (not listable):
   ```bash
   sudo setfacl -m u:agent:x /home/<you>
   ```
4. Optional, only if a task genuinely needs it: one privileged command, not sudo in general.
   ```bash
   echo 'agent ALL=(root) NOPASSWD: /usr/bin/systemctl restart <service>' | sudo tee /etc/sudoers.d/agent-<service>
   ```

GPUs: on hosts where `/dev/nvidia*` is world read/write (common), the agent user can use them with no
further setup. Otherwise add it to the group that owns those devices.

On macOS, create the user in System Settings, turn on **Remote Login** (General > Sharing), and follow
steps 2 and 3 with that user's home (`/Users/agent`).

## Windows

Run in PowerShell **as Administrator**:

1. Install and start the SSH server.
   ```powershell
   Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
   Start-Service sshd; Set-Service -Name sshd -StartupType Automatic
   ```
2. Give agents PowerShell rather than cmd.
   ```powershell
   New-ItemProperty -Path "HKLM:\SOFTWARE\OpenSSH" -Name DefaultShell -Value "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" -PropertyType String -Force
   ```
3. The key. **For an account in the Administrators group, Windows ignores `~\.ssh\authorized_keys`**:
   the key goes in a shared file, which must be readable only by Administrators and SYSTEM.
   ```powershell
   Add-Content -Path C:\ProgramData\ssh\administrators_authorized_keys -Value '<AGENT_HUB_PUBLIC_KEY>'
   icacls C:\ProgramData\ssh\administrators_authorized_keys /inheritance:r /grant "Administrators:F" /grant "SYSTEM:F"
   ```
   For a non-administrator account, append the key to `%USERPROFILE%\.ssh\authorized_keys` instead.

Agents on Windows reach your files as you, which is usually the point (moving your data). If that is too
much, create a separate standard (non-administrator) local account and share it only the folders it needs.

On the Devices page choose **Shell: Windows (PowerShell)**. Agent Hub then switches PowerShell's output to
UTF-8 before every command: a localized Windows (Big5 on Traditional Chinese) otherwise returns every
error message and non-ASCII file name as mojibake. Agents are also shown which devices are Windows, so
they write PowerShell rather than sh.

Worth putting in the device's note: where the Desktop and Documents really are (OneDrive often moves them,
e.g. `C:/Users/<you>/OneDrive/桌面`; ask the device with `[Environment]::GetFolderPath("Desktop")`), and how
much disk is free, so an agent does not copy tens of GB onto a nearly full drive or into a synced folder.

### When the built-in install fails

`Add-WindowsCapability` (or `dism /Add-Capability`) downloads from Windows Update and can stall, or reach
100% and then fail with `Error: 2` (file not found). Microsoft's own Win32-OpenSSH package does not go
through Windows Update:

```powershell
winget install --id Microsoft.OpenSSH.Preview -e --source winget --accept-package-agreements --accept-source-agreements
Start-Service sshd; Set-Service -Name sshd -StartupType Automatic
```

That package creates **no firewall rule**, so nothing can connect yet. Allow port 22 from the tailnet only
(or, tighter, from the Agent Hub machine's tailscale address alone):

```powershell
New-NetFirewallRule -Name 'sshd-tailscale' -DisplayName 'OpenSSH Server (Tailscale only)' -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 -RemoteAddress 100.64.0.0/10 -Profile Any
```

## Tailscale: when the Agent Hub machine is shared to you

If the Agent Hub machine belongs to someone else's tailnet and was **shared** to you, it can receive
connections from your devices but cannot open any to them: Tailscale quarantines shared machines. The
symptom is that the device works locally but Agent Hub times out on port 22. The fix is a **mutual
share**: in your own admin console, share the device with the owner of the Agent Hub machine, and have
them accept. Check from the Agent Hub machine with `tailscale status`: the device should be listed.

## Register and check

On the Devices page: **Add device** with its address (a tailscale IP or name is fine), the user from
above, and the key left empty (Agent Hub's own). **Test connection** runs a harmless command through the
same path an agent uses and shows the result. Exit 255 means ssh itself failed: unreachable, wrong user,
or the key is not where the device looks for it.

## Revoking

Remove the `agent-hub` line from the device's `authorized_keys` (or `administrators_authorized_keys`),
or remove the whole account (`sudo userdel -r agent`), then remove the device on the Devices page.
