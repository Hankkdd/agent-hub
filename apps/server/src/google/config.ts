import fs from "node:fs";
import path from "node:path";
import { isIP } from "node:net";

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  mode: "callback" | "paste";
}

export function readConfig(dataDir: string): { config: GoogleConfig | null; error: string | null } {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(dataDir, "google/client.json"), "utf8"));
    if (
      !value || typeof value.clientId !== "string" || !value.clientId.trim() ||
      typeof value.clientSecret !== "string" || !value.clientSecret.trim() ||
      typeof value.redirectUri !== "string"
    ) {
      throw new Error();
    }
    const u = new URL(value.redirectUri);
    if (u.username || u.password || u.search || u.hash) throw new Error();

    let mode: GoogleConfig["mode"];
    if (u.protocol === "https:" && !isIP(u.hostname.replace(/^\[|\]$/g, ""))) {
      mode = "callback";
    } else if (/^http:\/\/(127\.0\.0\.1|localhost):[0-9]+(?:\/[^?#]*)?$/.test(value.redirectUri)) {
      mode = "paste";
    } else {
      throw new Error();
    }
    return {
      config: {
        clientId: value.clientId,
        clientSecret: value.clientSecret,
        redirectUri: value.redirectUri,
        mode,
      },
      error: null,
    };
  } catch (err) {
    return {
      config: null,
      error: (err as NodeJS.ErrnoException).code === "ENOENT"
        ? "Create google/client.json to configure Google."
        : "Invalid google/client.json: use an HTTPS redirect or an HTTP loopback redirect with an explicit port.",
    };
  }
}
