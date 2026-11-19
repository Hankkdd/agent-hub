# Antigravity CLI login

Open **Antigravity login** next to Google in the sidebar. This is a generic terminal bridge to the
pinned, checksum-verified official Antigravity CLI (`agy` 1.3.6, Linux ARM64). The panel does not
recognize screens or navigate menus automatically. The first real login through it is the observation
of the CLI's login flow. No real login was performed as part of implementation.

Antigravity's terms prohibit using third-party software to access the service and threaten account
suspension. The account owner knowingly accepted this risk, including use of their Google AI student
subscription. Only the official unmodified CLI runs. Hub never reads, parses, copies, transplants or
reuses the CLI's OAuth credentials. Logins are user-initiated and rate limited.

## Use the panel

1. Check availability. Docker must be reachable and the host architecture must be ARM64.
2. Select **Start**. A missing image is built with a five-minute timeout; the panel shows
   `preparing-image` while preparing the image and terminal. No CLI arguments or undocumented login
   subcommand are used: the container runs the image's `agy` entrypoint.
3. Read the rendered terminal, use the navigation key buttons, and open extracted HTTPS links in
   a new tab. Complete consent in the browser. Paste the one-time authorization code and select
   **Send**. The Enter toggle controls whether sending also submits the code.
4. Inspect the CLI's screen and exit code. Hub does not infer login success from either.
   Select **Cancel session** to stop. To retry after exit/cancellation/expiry, select **Start** again.
5. To remove stored state, select **Sign out** and confirm. Sign out is refused during an active
   session; cancel first. It deletes only the dedicated home directory's contents.

## Storage and isolation

The sole host mount is `<AGENT_HUB_DATA>/antigravity/home`, mode 0700, mounted read-write at
`/home/prototype`. It is separate from the prototype experiment's data directory and all other
host accounts. An empty home is seeded from the repository's tool-disabling settings and agent
file. The CLI keeps its own state under `.gemini/`. Hub only lists directory entries to report
`absent` or `present-unverified`; **present-unverified is not proof of login**. Seeded configuration
also counts as presence. Model-backed verification belongs to the later Diff explanation adapter.
No model verification, credential refresh test, AgentAdapter, MCP or provider routing is added here.

Containers have a read-only root, no Linux capabilities, no privilege escalation, 64-process,
1 GiB memory and 2 CPU limits, bridge networking, no Docker logging, and private `/tmp` and `/work`
tmpfs mounts. They run as the host uid/gid. No repository, Hub token, MCP or other host mount is
provided. Docker Engine attach provides writable TTY I/O over the Unix socket without a host TTY;
the terminal size is 300 columns by 30 rows, shared by the container hints, resize API and emulator.
The screen scrolls horizontally in the dialog.

## Limits and troubleshooting

Only one session runs at a time, for at most ten minutes including image preparation. At most five
starts are reserved in a rolling hour. The rate limit and session state live only in memory and reset
on Hub restart. Closing the dialog stops polling, not the container; reopen it to resume viewing or
cancel. Exit, cancel and expiry remove the container. Startup and shutdown clean up containers with
this Hub data directory's dedicated owner label; unrelated containers are not selected.

Rendered screen and input are transient and never written to task events, the database, service logs
or disk by Hub. The CLI itself persists its state in its dedicated home. Screen projection redacts
long token-like runs and OAuth token prefixes while preserving authorization URLs. Both terminal soft
wraps and TUI-inserted hard line breaks are joined before link extraction and redaction, including
continuation lines whose trimmed content is a single run of URL characters with no internal
whitespace. Prompt and sentence lines containing spaces stay separate. URLs and screen
content still belong to the CLI; review links before opening them. The screen is an emulator's current
viewport, not a saved transcript. Hub cannot declare the credentials verified.

A failed session shows only a fixed `failedStage`: `availability`, `cleanup`, `prepare`, `create`,
`attach`, `start`, `wait` or `remove`. The dialog translates that stage; Docker error text, output and
paths are never included. If both an operation and its removal fail, the original failure stage is kept.

If unavailable, restore Docker access or use an ARM64 host. If a request or session fails, reopen the
dialog to refresh status, cancel an active session if needed, then retry within the start limit. Use
confirmed sign out to clear the dedicated CLI state before starting over. No login screen recognition
or automatic key presses are involved. A Hub restart loses the previous screen and removes orphans.
