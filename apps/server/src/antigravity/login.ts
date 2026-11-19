import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import type { AntigravitySession, AntigravityStatus } from "@agent-hub/shared";
import { DOCKER_DIR } from "../docker/images";
import { DockerRuntime, type Attachment, type ContainerRuntime } from "./docker";
import { LoginScreen } from "./screen";

export class AntigravityError extends Error {
  constructor(readonly code: string, readonly status: 400 | 409 | 429 | 503 = 409) { super(code); }
}
export const KEYS = { enter: "\r", up: "\x1b[A", down: "\x1b[B", left: "\x1b[D", right: "\x1b[C",
  tab: "\t", escape: "\x1b", space: " ", backspace: "\x7f" } as const;
export function inputBytes(input: unknown): string {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new AntigravityError("invalid-input", 400);
  const value = input as Record<string, unknown>;
  if (Object.keys(value).length === 1 && typeof value.key === "string" && Object.hasOwn(KEYS, value.key)) return KEYS[value.key as keyof typeof KEYS];
  if (typeof value.text !== "string" || value.text.length > 512 || /[\x00-\x1f\x7f-\x9f]/.test(value.text) ||
      Object.keys(value).some(key => !["text", "submit"].includes(key)) || (value.submit !== undefined && typeof value.submit !== "boolean")) {
    throw new AntigravityError("invalid-input", 400);
  }
  return value.text + (value.submit ? "\r" : "");
}
export function validateHome(dataDir: string, candidate: string, create = false): string {
  const expected = path.resolve(dataDir, "antigravity/home");
  if (candidate !== expected) throw new AntigravityError("unsafe-storage", 400);
  let cursor = path.parse(expected).root;
  for (const part of expected.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    if (!fs.existsSync(cursor)) {
      // lstat also detects dangling symlinks, which existsSync deliberately ignores.
      try { fs.lstatSync(cursor); throw new AntigravityError("unsafe-storage", 400); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (create) fs.mkdirSync(cursor, { mode: 0o700 }); else continue;
    }
    if (fs.existsSync(cursor)) {
      const stat = fs.lstatSync(cursor);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new AntigravityError("unsafe-storage", 400);
    }
  }
  return expected;
}
const active = (state: AntigravitySession["state"]) => ["preparing-image", "running", "stopping"].includes(state);
interface Running {
  name: string; view: AntigravitySession; terminal: LoginScreen; abort: AbortController;
  timer?: ReturnType<typeof setTimeout>; attachment?: Attachment; work?: Promise<void>; stop?: Promise<void>;
}
export class AntigravityLogin {
  private runtime: ContainerRuntime;
  readonly home: string;
  readonly owner: string;
  private current?: Running;
  private starts: number[] = [];
  private closed = false;
  // Sessions, rate limits and screens are deliberately transient: restart loses them and removes orphans.
  constructor(private options: { dataDir: string; runtime?: ContainerRuntime; arch?: string; now?: () => number }) {
    this.home = path.resolve(options.dataDir, "antigravity/home");
    this.owner = createHash("sha256").update(path.resolve(options.dataDir)).digest("hex").slice(0, 24);
    this.runtime = options.runtime ?? new DockerRuntime();
  }
  private now() { return this.options.now?.() ?? Date.now(); }
  private async availability() {
    if ((this.options.arch ?? os.arch()) !== "arm64") return { available: false, reason: "unsupported-arch" as const };
    return await this.runtime.reachable() ? { available: true } : { available: false, reason: "docker-unavailable" as const };
  }
  private credentials(): AntigravityStatus["credentials"] {
    validateHome(this.options.dataDir, this.home);
    return fs.existsSync(this.home) && fs.readdirSync(this.home).length > 0 ? "present-unverified" : "absent";
  }
  async status(): Promise<AntigravityStatus> {
    return { ...await this.availability(), credentials: this.credentials(), session: await this.session() };
  }
  async session(): Promise<AntigravitySession> {
    const s = this.current;
    if (!s) return { state: "idle", screen: [], links: [], startedAt: null, expiresAt: null };
    return { ...s.view, ...await s.terminal.read() };
  }
  private seed() {
    validateHome(this.options.dataDir, this.home, true);
    fs.chmodSync(this.home, 0o700);
    // Logout leaves an empty home; seed only an empty directory and never inspect credential contents.
    if (fs.readdirSync(this.home).length) return;
    const gemini = path.join(this.home, ".gemini");
    fs.mkdirSync(path.join(gemini, "config/agents"), { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(gemini, "antigravity-cli"), { mode: 0o700 });
    for (const destination of ["settings.json", "config/config.json", "antigravity-cli/settings.json"]) {
      fs.copyFileSync(path.join(DOCKER_DIR, "antigravity-prototype/settings.json"), path.join(gemini, destination));
      fs.chmodSync(path.join(gemini, destination), 0o600);
    }
    fs.copyFileSync(path.join(DOCKER_DIR, "antigravity-prototype/agent.md"), path.join(gemini, "config/agents/hub-prototype.md"));
  }
  async start() {
    if (this.closed || (this.current && active(this.current.view.state))) throw new AntigravityError("session-active");
    // Reserve synchronously before any await so concurrent starts cannot cross the availability check.
    const now = this.now();
    this.starts = this.starts.filter(time => now - time < 60 * 60_000);
    if (this.starts.length >= 5) throw new AntigravityError("rate-limited", 429);
    this.starts.push(now);
    const previous = this.current;
    const s: Running = { name: `agent-hub-agy-login-${randomUUID()}`, terminal: new LoginScreen(), abort: new AbortController(),
      view: { state: "preparing-image", screen: [], links: [], startedAt: now, expiresAt: now + 10 * 60_000 } };
    this.current = s;
    if (previous) void previous.terminal.dispose();
    s.timer = setTimeout(() => { void this.stop(s, "expired"); }, 10 * 60_000);
    s.timer.unref?.();
    s.work = this.launch(s);
    return this.session();
  }
  private async launch(s: Running) {
    let outcome: "exited" | "failed" = "failed";
    let exitCode: number | undefined;
    let stage: NonNullable<AntigravitySession["failedStage"]> = "availability";
    let failedStage: AntigravitySession["failedStage"];
    try {
      const available = await this.availability();
      if (!available.available) throw new AntigravityError(available.reason!, 503);
      s.abort.signal.throwIfAborted();
      stage = "cleanup";
      await this.runtime.cleanup(this.owner);
      s.abort.signal.throwIfAborted();
      stage = "prepare";
      this.seed();
      await this.runtime.prepare(s.abort.signal);
      s.abort.signal.throwIfAborted();
      stage = "create";
      await this.runtime.create(s.name, this.owner, this.home, s.abort.signal);
      s.abort.signal.throwIfAborted();
      stage = "attach";
      s.attachment = await this.runtime.attach(s.name, data => s.terminal.write(data), () => {
        // A normal EOF is followed by docker wait; only a stuck wait reaches the hard deadline.
        s.attachment?.close();
      });
      s.abort.signal.throwIfAborted();
      stage = "start";
      await this.runtime.start(s.name, s.abort.signal);
      s.abort.signal.throwIfAborted();
      s.view.state = "running";
      stage = "wait";
      exitCode = await this.runtime.wait(s.name, s.abort.signal);
      outcome = "exited";
    } catch {
      failedStage = stage;
      // Docker errors may contain output or paths: never pass them to the API or logger.
    } finally {
      // Keep start/logout locked until removal completes, even after the CLI has exited or failed.
      s.view.state = "stopping";
      s.attachment?.close();
      try { await this.runtime.remove(s.name); }
      catch { outcome = "failed"; failedStage ??= "remove"; }
      if (!s.abort.signal.aborted) {
        s.view.state = outcome;
        if (outcome === "failed") s.view.failedStage = failedStage;
        if (exitCode !== undefined) s.view.exitCode = exitCode;
        clearTimeout(s.timer);
      }
    }
  }
  input(input: unknown) {
    const s = this.current;
    if (!s || s.view.state !== "running" || !s.attachment) throw new AntigravityError("no-session");
    const bytes = inputBytes(input);
    if (typeof input === "object" && input && "text" in input) s.terminal.hide((input as { text: string }).text);
    try { s.attachment.write(bytes); } catch { throw new AntigravityError("input-failed"); }
  }
  private stop(s: Running, state: "cancelled" | "expired"): Promise<void> {
    if (s.stop) return s.stop;
    s.view.state = "stopping";
    s.abort.abort();
    clearTimeout(s.timer);
    s.attachment?.close();
    s.stop = (async () => {
      await s.work;
      try { await this.runtime.cleanup(this.owner); s.view.state = state; }
      catch { s.view.state = "failed"; s.view.failedStage = "cleanup"; }
    })();
    return s.stop;
  }
  async cancel() {
    if (this.current && active(this.current.view.state)) await this.stop(this.current, "cancelled");
    return this.session();
  }
  async logout() {
    if (this.current && active(this.current.view.state)) throw new AntigravityError("session-active");
    const home = validateHome(this.options.dataDir, this.home);
    if (fs.existsSync(home)) for (const name of fs.readdirSync(home)) fs.rmSync(path.join(home, name), { recursive: true, force: true });
    return this.status();
  }
  async cleanup() { try { await this.runtime.cleanup(this.owner); } catch { /* Docker may be unavailable on this host. */ } }
  async shutdown() { this.closed = true; await this.cancel(); await this.cleanup(); }
}
