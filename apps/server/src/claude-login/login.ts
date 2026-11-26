import fs from "node:fs";
import type { ClaudeLoginStatus, ClaudeAccount } from "@agent-hub/shared";
import { AntigravityError, TerminalLogin, validateHome as validate } from "../terminal-login/login";
import type { ContainerRuntime } from "../terminal-login/docker";
import { ClaudeDockerRuntime } from "./docker";

export function validateHome(dataDir: string, home: string, create = false) {
  const result = validate(dataDir, home, create, "claude-home");
  if (fs.existsSync(result)) fs.chmodSync(result, 0o700);
  return result;
}
function safeField(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 254 || /[\x00-\x1f\x7f]|(?:sk-|ya29\.|1\/\/)|[A-Za-z0-9_+/-]{40,}/.test(value)) return undefined;
  return value;
}
export function parseStatus(raw: string): ClaudeAccount {
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || !("loggedIn" in value) || typeof value.loggedIn !== "boolean") return { state: "unknown" };
    const fields = value as Record<string, unknown>;
    const email = safeField(fields.email);
    const subscriptionType = safeField(fields.subscriptionType);
    return { state: value.loggedIn ? "logged-in" : "logged-out", ...(email ? { email } : {}), ...(subscriptionType ? { subscriptionType } : {}) };
  } catch { return { state: "unknown" }; }
}
export interface ClaudeRuntime extends ContainerRuntime { run(home: string, owner: string, command: string[]): Promise<{ stdout: string; exitCode: number }> }
export class ClaudeLogin extends TerminalLogin {
  private account: ClaudeAccount = { state: "unknown" };
  private checkedAt = -Infinity;
  private flight?: Promise<ClaudeAccount>;
  private signingOut = false;
  private readonly claudeRuntime: "host" | "docker";
  constructor(options: { dataDir: string; claudeRuntime?: "host" | "docker"; runtime?: ClaudeRuntime; now?: () => number; onSuccess?: () => Promise<void> }) {
    const runtime = options.runtime ?? new ClaudeDockerRuntime();
    super({ ...options, runtime, provider: {
      id: "claude", home: "claude-home",
      availability: async runtime => await runtime.reachable() ? { available: true } : { available: false, reason: "docker-unavailable" },
      seed: home => { validateHome(options.dataDir, home, true); },
      logout: async home => { validateHome(options.dataDir, home, true); await runtime.run(home, this.owner, ["auth", "logout"]); },
      onSuccess: async () => { this.checkedAt = -Infinity; await this.probe(true); await options.onSuccess?.(); },
    } });
    this.claudeRuntime = options.claudeRuntime ?? "host";
  }
  private probe(refresh = false): Promise<ClaudeAccount> {
    if (this.flight) return this.flight;
    const now = this.options.now?.() ?? Date.now();
    if (!refresh && now - this.checkedAt < 60_000) return Promise.resolve(this.account);
    // Explicit refresh also observes a short cooldown to bound repeated container probes.
    if (now - this.checkedAt < 10_000) return Promise.resolve(this.account);
    this.flight = (async () => {
      try {
        validateHome(this.options.dataDir, this.home, true);
        this.account = parseStatus((await (this.runtime as ClaudeRuntime).run(this.home, this.owner, ["auth", "status", "--json"])).stdout);
      } catch { this.account = { state: "unknown" }; }
      this.checkedAt = this.options.now?.() ?? Date.now();
      return this.account;
    })().finally(() => { this.flight = undefined; });
    return this.flight;
  }
  override async start() {
    if (this.signingOut || this.flight) throw new AntigravityError("session-active");
    return super.start();
  }
  async status(refresh = false): Promise<ClaudeLoginStatus> {
    const account = this.isActive() || this.signingOut ? this.account : await this.probe(refresh);
    return { ...await this.availability(), runtime: this.claudeRuntime, account, session: await this.session() };
  }
  async logout(): Promise<ClaudeLoginStatus> {
    if (this.signingOut || this.flight || this.isActive()) throw new AntigravityError("session-active");
    this.signingOut = true;
    try { await this.signOut(); this.checkedAt = -Infinity; await this.probe(true); }
    finally { this.signingOut = false; }
    return this.status();
  }
}
