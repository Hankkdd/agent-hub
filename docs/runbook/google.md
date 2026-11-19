# Google HTTPS callback setup

The Google connection supports an HTTPS callback (Web application client) or a pasted loopback redirect
(Desktop app client). See [configuration guide](../configuration.md#google-drive-videos) for consent scopes, publishing
status and the two `client.json` examples. No deploy script or binding change is required.

1. In the Tailscale admin console, enable **MagicDNS** and **HTTPS certificates** for the tailnet.
   Certificates are recorded in public certificate-transparency logs: your machine and tailnet names
   become public. Choose names with this in mind before enabling HTTPS. See
   [Tailscale HTTPS](https://tailscale.com/docs/how-to/set-up-https-certificates).
2. With Hub serving on `127.0.0.1:8787`, run:

   ```bash
   tailscale serve --bg 8787
   ```

   [Tailscale Serve](https://tailscale.com/docs/reference/tailscale-cli/serve) proxies
   `https://<machine>.<tailnet>.ts.net` to `http://127.0.0.1:8787` within the tailnet and manages the TLS
   certificate. Open the HTTPS Hub URL and sign in with the usual Hub token.
3. In Google Cloud, enable the Drive API, configure the consent screen, and create an OAuth **Web
   application** client. Set the authorized domain to `<tailnet>.ts.net` and authorized redirect URI to
   `https://<machine>.<tailnet>.ts.net/api/google/callback` (exact match). Google domain validation or
   Workspace policies can impose additional requirements; follow the console's validation messages.
4. Put the client ID, client secret and this redirect URI in `<dataDir>/google/client.json`, outside the
   repository, using the configuration guide example. Protect the directory with 0700 and the file with 0600.
5. In Hub's **Google** dialog, select **Connect Google Drive**, then open the consent link. Grant the
   explicitly named Drive read-only scope. The browser returns to the Hub and the dialog displays the
   connected email and `drive.read` capability. Retry consent if the ten-minute state expires or Hub
   restarts during authorization.

To switch modes, edit `client.json` with the corresponding OAuth client credentials and redirect URI.
Hub rereads configuration on each operation. For paste mode use a Desktop app client and
`http://127.0.0.1:<port>/callback` or `http://localhost:<port>/callback`; do not run a listener on the
user's device. Copy the complete failed-page URL into the dialog. Its origin and path must match the
configuration. Any in-progress consent request must be restarted after changing clients or redirects.

A refresh failure with `invalid_grant` keeps the email but disables capabilities until reauthorization.
Use Disconnect to remove saved credentials. Tokens belong only under `<dataDir>/google/`; never include
that directory in agent mounts, support logs or repository files.
