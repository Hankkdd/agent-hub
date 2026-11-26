import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { TerminalLoginSession } from "@agent-hub/shared";
import type { Attachment, ContainerRuntime } from "./docker";
import { LoginScreen } from "./screen";
export interface LoginProvider {
  id: string;
  home: string;
  availability(runtime: ContainerRuntime): Promise<{ available: boolean; reason?: "unsupported-arch" | "docker-unavailable" }>;
  seed(home: string): void;
  logout(home: string): Promise<void>;
  onSuccess?(): Promise<void>;
}
export class TerminalLoginError extends Error {
  constructor(readonly code: string, readonly status: 400 | 409 | 429 | 503 = 409) { super(code); }
}
export { TerminalLoginError as AntigravityError };
export const KEYS = { enter: "\r", up: "\x1b[A", down: "\x1b[B", left: "\x1b[D", right: "\x1b[C",
  tab: "\t", escape: "\x1b", space: " ", backspace: "\x7f" } as const;
export function inputBytes(input: unknown): string {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TerminalLoginError("invalid-input", 400);
  const value = input as Record<string, unknown>;
  if (Object.keys(value).length === 1 && typeof value.key === "string" && Object.hasOwn(KEYS, value.key)) return KEYS[value.key as keyof typeof KEYS];
  if (typeof value.text !== "string" || value.text.length > 512 || /[\x00-\x1f\x7f-\x9f]/.test(value.text) ||
      Object.keys(value).some(key => !["text", "submit"].includes(key)) || (value.submit !== undefined && typeof value.submit !== "boolean")) {
    throw new TerminalLoginError("invalid-input", 400);
  }
  return value.text + (value.submit ? "\r" : "");
}
export function validateHome(dataDir: string, candidate: string, create = false, relativeHome = "antigravity/home"): string {
  const expected = path.resolve(dataDir, relativeHome);
  if (candidate !== expected) throw new TerminalLoginError("unsafe-storage", 400);
  let cursor = path.parse(expected).root;
  for (const part of expected.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    if (!fs.existsSync(cursor)) {
      // lstat also detects dangling symlinks, which existsSync deliberately ignores.
      try { fs.lstatSync(cursor); throw new TerminalLoginError("unsafe-storage", 400); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (create) fs.mkdirSync(cursor, { mode: 0o700 }); else continue;
    }
    if (fs.existsSync(cursor)) {
      const stat = fs.lstatSync(cursor);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new TerminalLoginError("unsafe-storage", 400);
    }
  }
  return expected;
}
const active = (state: TerminalLoginSession["state"]) => ["preparing-image", "running", "stopping"].includes(state);
interface Running {
  name: string; view: TerminalLoginSession; terminal: LoginScreen; abort: AbortController;
  timer?: ReturnType<typeof setTimeout>; attachment?: Attachment; work?: Promise<void>; stop?: Promise<void>;
}
export class TerminalLogin {
  protected runtime: ContainerRuntime;
  readonly home: string;
  readonly owner: string;
  private current?: Running;
  private starts: number[] = [];
  private closed = false;
  // Sessions, rate limits and screens are deliberately transient: restart loses them and removes orphans.
  constructor(protected options: { dataDir: string; runtime: ContainerRuntime; now?: () => number; provider: LoginProvider }) {
    this.home = path.resolve(options.dataDir, options.provider.home);
    this.owner = createHash("sha256").update(path.resolve(options.dataDir)).digest("hex").slice(0, 24);
    this.runtime = options.runtime;
  }
  private now() { return this.options.now?.() ?? Date.now(); }
  protected async availability() { return this.options.provider.availability(this.runtime); }
  protected isActive() { return !!this.current && active(this.current.view.state); }
  async session(): Promise<TerminalLoginSession> {
    const s = this.current;
    if (!s) return { state: "idle", screen: [], links: [], startedAt: null, expiresAt: null };
    return { ...s.view, ...await s.terminal.read() };
  }
  async start() {
    if (this.closed || (this.current && active(this.current.view.state))) throw new TerminalLoginError("session-active");
    // Reserve synchronously before any await so concurrent starts cannot cross the availability check.
    const now = this.now();
    this.starts = this.starts.filter(time => now - time < 60 * 60_000);
    if (this.starts.length >= 5) throw new TerminalLoginError("rate-limited", 429);
    this.starts.push(now);
    const previous = this.current;
    const s: Running = { name: `agent-hub-${this.options.provider.id}-login-${randomUUID()}`, terminal: new LoginScreen(), abort: new AbortController(),
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
    let stage: NonNullable<TerminalLoginSession["failedStage"]> = "availability";
    let failedStage: TerminalLoginSession["failedStage"];
    try {
      const available = await this.availability();
      if (!available.available) throw new TerminalLoginError(available.reason!, 503);
      s.abort.signal.throwIfAborted();
      stage = "cleanup";
      await this.runtime.cleanup(this.owner);
      s.abort.signal.throwIfAborted();
      stage = "prepare";
      this.options.provider.seed(this.home);
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
        if (outcome === "exited" && exitCode === 0) {
          try { await this.options.provider.onSuccess?.(); } catch { /* Status recovery must not expose provider errors. */ }
        }
        if (!s.abort.signal.aborted) {
          s.view.state = outcome;
          if (outcome === "failed") s.view.failedStage = failedStage;
          if (exitCode !== undefined) s.view.exitCode = exitCode;
          clearTimeout(s.timer);
        }
      }
    }
  }
  input(input: unknown) {
    const s = this.current;
    if (!s || s.view.state !== "running" || !s.attachment) throw new TerminalLoginError("no-session");
    const bytes = inputBytes(input);
    if (typeof input === "object" && input && "text" in input) s.terminal.hide((input as { text: string }).text);
    try { s.attachment.write(bytes); } catch { throw new TerminalLoginError("input-failed"); }
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
  protected async signOut() {
    if (this.isActive()) throw new TerminalLoginError("session-active");
    await this.options.provider.logout(this.home);
  }
  async cleanup() { try { await this.runtime.cleanup(this.owner); } catch { /* Docker may be unavailable on this host. */ } }
  async shutdown() { this.closed = true; await this.cancel(); await this.cleanup(); }
}
