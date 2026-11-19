# Agent Hub host requirements

The machine Agent Hub itself runs on. The guiding principle (borrowed from workstream's): **the host stays
minimal; agent work runs in containers.** Codex runs in one, video tooling in another; the host only needs
what launches them.

| Tool | Why | Notes |
| --- | --- | --- |
| `mise` | pins Node 22 and pnpm for this repo (`mise.toml`) | the system Node may be older; prefix commands with `mise exec --` |
| `docker` | Codex's container and the media container (yt-dlp, ffmpeg, Whisper) | the user running Agent Hub must be in the `docker` group. That group is root-equivalent, so give it only to that user |
| `git` | worktrees for implement/review tasks | |
| `ssh`, `scp`, `ssh-keygen` | `ssh_exec` and `copy_file` run on the host, so device keys never enter a container; Agent Hub makes its own key on first start | OpenSSH client |
| Claude Code login | host runtime: Claude runs through the Claude Agent SDK, which uses the Claude Code CLI's login. Docker runtime: the container has its own login in `data/claude-home` | host: log in once with `claude` as the user running Agent Hub. Docker: `mise exec -- pnpm claude:login` |
| Codex login | the Codex container has its own login in `data/codex-home` | `mise exec -- pnpm codex:login` (device code) |
| tailscale (optional) | to reach the web UI from other devices without exposing it | bind with `AGENT_HUB_HOST=<tailscale IP>` |

**Not needed on the host:** yt-dlp, ffmpeg, Python, Whisper (all in the media image), the Codex CLI (in its
image; the SDK's bundled copy is used only to look up the version).

Build the images ahead of the first task (optional; they are also built on first use):

```bash
mise exec -- pnpm images
```

## Known gap: container network fence

A container on the docker bridge reaches the tailnet, the LAN and the host's own services **as the host**
(docker masquerades its traffic). Codex's container holds no SSH key, so it cannot log in to a device, but
it can reach any service there that needs no login. workstream closes this with an nftables fence; Agent
Hub does not have one yet.
