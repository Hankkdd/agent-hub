import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Agent Hub's own SSH key: made here, never the user's personal key. The user installs its PUBLIC half
 * on each device (the Devices page shows how), so access can be revoked per device by removing one line,
 * and no private key is ever pasted into Agent Hub. Lives in data/ (gitignored).
 */
export function ensureAgentKey(dataDir: string): { keyPath: string; publicKey: string } {
  const dir = path.join(dataDir, "ssh");
  const keyPath = path.join(dir, "agent_hub_ed25519");
  if (!fs.existsSync(keyPath)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", keyPath, "-C", "agent-hub"]);
  }
  return { keyPath, publicKey: fs.readFileSync(`${keyPath}.pub`, "utf8").trim() };
}
