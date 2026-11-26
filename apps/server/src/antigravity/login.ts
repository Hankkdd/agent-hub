import fs from "node:fs";
import os from "node:os";
import type { AntigravityStatus } from "@agent-hub/shared";
import { DOCKER_DIR } from "../docker/images";
import path from "node:path";
import { DockerRuntime, type ContainerRuntime } from "./docker";
import { TerminalLogin, validateHome } from "../terminal-login/login";
export { AntigravityError, inputBytes, KEYS, validateHome } from "../terminal-login/login";
function seed(dataDir: string, home: string) {
  validateHome(dataDir, home, true);
  fs.chmodSync(home, 0o700);
  // Logout leaves an empty home; seed only an empty directory and never inspect credential contents.
  if (fs.readdirSync(home).length) return;
  const gemini = path.join(home, ".gemini");
  fs.mkdirSync(path.join(gemini, "config/agents"), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(gemini, "antigravity-cli"), { mode: 0o700 });
  for (const destination of ["settings.json", "config/config.json", "antigravity-cli/settings.json"]) {
    fs.copyFileSync(path.join(DOCKER_DIR, "antigravity-prototype/settings.json"), path.join(gemini, destination));
    fs.chmodSync(path.join(gemini, destination), 0o600);
  }
  fs.copyFileSync(path.join(DOCKER_DIR, "antigravity-prototype/agent.md"), path.join(gemini, "config/agents/hub-prototype.md"));
}
export class AntigravityLogin extends TerminalLogin {
  constructor(options: { dataDir: string; runtime?: ContainerRuntime; arch?: string; now?: () => number }) {
    super({ ...options, runtime: options.runtime ?? new DockerRuntime(), provider: {
      id: "agy", home: "antigravity/home",
      availability: async runtime => {
        if ((options.arch ?? os.arch()) !== "arm64") return { available: false, reason: "unsupported-arch" };
        return await runtime.reachable() ? { available: true } : { available: false, reason: "docker-unavailable" };
      },
      seed: home => seed(options.dataDir, home),
      logout: async home => {
        validateHome(options.dataDir, home);
        if (fs.existsSync(home)) for (const name of fs.readdirSync(home)) fs.rmSync(path.join(home, name), { recursive: true, force: true });
      },
    } });
  }
  async status(): Promise<AntigravityStatus> {
    validateHome(this.options.dataDir, this.home);
    const credentials = fs.existsSync(this.home) && fs.readdirSync(this.home).length > 0 ? "present-unverified" : "absent";
    return { ...await this.availability(), credentials, session: await this.session() };
  }
  async logout() { await this.signOut(); return this.status(); }
}
