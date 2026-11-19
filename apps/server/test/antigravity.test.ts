import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { AntigravityLogin, inputBytes, KEYS, validateHome } from "../src/antigravity/login";
import { DockerRuntime, OWNER_LABEL, containerArgs, type ContainerRuntime } from "../src/antigravity/docker";
import { LoginScreen } from "../src/antigravity/screen";
import { TERMINAL_SIZE } from "../src/antigravity/terminal";
import { createApp } from "../src/app";
import { Hub } from "../src/core/hub";
import { openDb } from "../src/db";

const dirs: string[] = [];
const logins: AntigravityLogin[] = [];
function directory() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-login-test-")); dirs.push(dir); return dir; }
const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
class FakeContainer implements ContainerRuntime {
  output: (data: Buffer) => void = () => {};
  exit: (code: number) => void = () => {};
  writes: string[] = [];
  reachable = vi.fn(async () => true);
  prepare = vi.fn(async (_signal: AbortSignal) => {});
  create = vi.fn(async (_name: string, _owner: string, _home: string, _signal: AbortSignal) => {});
  attach = vi.fn(async (_name: string, output: (data: Buffer) => void) => {
    this.output = output;
    return { write: (text: string) => {
      this.writes.push(text);
      output(Buffer.from(text));
      if (text === "one-time-code\r") this.exit(0);
    }, close: vi.fn() };
  });
  start = vi.fn(async () => {
    this.output(Buffer.from("\x1b[2J\x1b[2;5HSign in\r\nhttps://accounts.example.invalid/oauth?state=" + "a".repeat(100) + "\r\nEnter code:"));
  });
  wait = vi.fn((_name: string, signal: AbortSignal) => new Promise<number>((resolve, reject) => {
    this.exit = resolve;
    signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  }));
  remove = vi.fn(async (_name: string) => {});
  cleanup = vi.fn(async (_owner: string) => {});
}
function fixture(arch = "arm64") {
  const runtime = new FakeContainer(); const dataDir = directory();
  const login = new AntigravityLogin({ dataDir, runtime, arch }); logins.push(login);
  return { login, runtime, dataDir };
}
afterEach(async () => {
  await Promise.all(logins.splice(0).map(login => login.shutdown()));
  vi.useRealTimers(); vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
it("renders ANSI positioning and soft-wrapped URLs with a headless terminal and redacts secrets", async () => {
  const terminal = new LoginScreen();
  const url = "https://accounts.example.invalid/oauth?state=" + "b".repeat(TERMINAL_SIZE.cols + 60);
  terminal.write(Buffer.from(`\x1b[2J\x1b[3;4HChoose login\r\n${url}\r\n\r\nToken: ya29.${"secret".repeat(15)}\r\n${"a".repeat(80)}\r\n1//oauth-secret\r\nEnter code:`));
  const view = await terminal.read();
  expect(view.screen[2]).toBe("   Choose login");
  expect(view.links).toEqual([url]);
  expect(view.screen.join("\n")).toContain(url);
  expect(view.screen.join("\n")).not.toContain("ya29.");
  expect(view.screen.join("\n")).not.toContain("a".repeat(80));
  expect(view.screen.join("\n")).not.toContain("1//oauth-secret");
  expect(view.screen.join("\n")).toContain("[REDACTED]");
  await terminal.dispose();
});
it("maps only allowed keys and validates authorization text", () => {
  for (const [key, bytes] of Object.entries(KEYS)) expect(inputBytes({ key })).toBe(bytes);
  expect(inputBytes({ text: "x".repeat(512), submit: true })).toBe("x".repeat(512) + "\r");
  expect(inputBytes({ text: "code", submit: false })).toBe("code");
  for (const value of [null, [], {}, { key: "__proto__" }, { key: "delete" }, { key: "enter", text: "x" },
    { text: "a".repeat(513) }, { text: "a\n" }, { text: "\x1b[A" }, { text: "\x7f" }, { text: "\u0085" }, { text: "x", submit: "true" }, { text: "x", extra: true }]) expect(() => inputBytes(value)).toThrow("invalid-input");
});
it("reports availability and presence without credential reads or login claims", async () => {
  const { login, runtime } = fixture();
  expect(await login.status()).toMatchObject({ available: true, credentials: "absent", session: { state: "idle" } });
  runtime.reachable.mockResolvedValue(false);
  expect(await login.status()).toMatchObject({ available: false, reason: "docker-unavailable" });
  runtime.reachable.mockResolvedValue(true);
  await login.start(); await flush();
  expect(await login.status()).toMatchObject({ credentials: "present-unverified" });
  expect(fs.statSync(login.home).mode & 0o777).toBe(0o700);
  const settings = path.join(login.home, ".gemini/antigravity-cli/settings.json");
  expect(JSON.parse(fs.readFileSync(settings, "utf8")).permissions.deny).toContain("command(*)");
  const unsupported = fixture("x64");
  expect(await unsupported.login.status()).toMatchObject({ available: false, reason: "unsupported-arch" });
  expect(unsupported.runtime.reachable).not.toHaveBeenCalled();
});
it("holds one session, handles keys and code, and retains exit code zero", async () => {
  const { login, runtime } = fixture();
  expect(() => login.input({ text: "code" })).toThrow("no-session");
  await login.start();
  await expect(login.start()).rejects.toThrow("session-active");
  await flush();
  expect((await login.session()).state).toBe("running");
  for (const key of Object.keys(KEYS)) login.input({ key });
  expect(runtime.writes).toEqual(Object.values(KEYS));
  login.input({ text: "one-time-code", submit: true });
  await flush();
  expect(await login.session()).toMatchObject({ state: "exited", exitCode: 0 });
  expect(runtime.remove).toHaveBeenCalledOnce();
  expect(() => login.input({ key: "enter" })).toThrow("no-session");
  expect((await login.session()).screen.join("\n")).not.toContain("one-time-code");
});
it("cancels and removes a running session and refuses logout until stopped", async () => {
  const { login, runtime } = fixture();
  await login.start(); await flush();
  await expect(login.logout()).rejects.toThrow("session-active");
  expect(await login.cancel()).toMatchObject({ state: "cancelled" });
  expect(runtime.remove).toHaveBeenCalledOnce();
  expect(await login.logout()).toMatchObject({ credentials: "absent" });
  expect(fs.readdirSync(login.home)).toEqual([]);
});
it("limits starts in a rolling hour and expires at ten minutes using fake timers", async () => {
  vi.useFakeTimers();
  const { login, runtime } = fixture();
  runtime.start.mockImplementation(async () => {});
  for (let i = 0; i < 5; i++) {
    await login.start(); await flush();
    if (i < 4) await login.cancel();
  }
  await vi.advanceTimersByTimeAsync(10 * 60_000 - 1);
  expect((await login.session()).state).toBe("running");
  await vi.advanceTimersByTimeAsync(1); await flush();
  expect((await login.session()).state).toBe("expired");
  expect(runtime.remove).toHaveBeenCalledTimes(5);
  await expect(login.start()).rejects.toThrow("rate-limited");
  await vi.advanceTimersByTimeAsync(50 * 60_000);
  await login.start(); await flush();
  expect((await login.session()).state).toBe("running");
});
it("cancels preparation and cannot start a late container after cancellation", async () => {
  const { login, runtime } = fixture();
  runtime.prepare.mockImplementation(signal => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("abort")))));
  await login.start(); await flush();
  expect((await login.session()).state).toBe("preparing-image");
  await login.cancel();
  expect(runtime.create).not.toHaveBeenCalled();
  expect((await login.session()).state).toBe("cancelled");
});
it("validates the exact logout home and rejects symlinked parents without deleting outside files", async () => {
  const { login, dataDir } = fixture();
  const outside = directory(); fs.writeFileSync(path.join(outside, "keep"), "keep");
  expect(() => validateHome(dataDir, outside)).toThrow("unsafe-storage");
  fs.mkdirSync(path.join(dataDir, "antigravity"));
  fs.symlinkSync(outside, login.home);
  await expect(login.logout()).rejects.toThrow("unsafe-storage");
  expect(fs.readFileSync(path.join(outside, "keep"), "utf8")).toBe("keep");
});
it("logout unlinks nested symlinks and preserves other account directories", async () => {
  const { login, dataDir } = fixture();
  validateHome(dataDir, login.home, true);
  const outside = directory(); fs.writeFileSync(path.join(outside, "keep"), "keep");
  fs.symlinkSync(outside, path.join(login.home, "alias"));
  expect(await login.logout()).toMatchObject({ credentials: "absent" });
  expect(fs.existsSync(path.join(outside, "keep"))).toBe(true);
});
it("builds only the hardened container arguments and selects orphans solely by owner label", async () => {
  const home = path.join(directory(), "antigravity/home");
  expect(() => containerArgs("test-container", "owner", `${home},src=/other`, 1234, 1234)).toThrow("unsafe mount path");
  const args = containerArgs("test-container", "owner", home, 1234, 1234);
  for (const flag of ["--tty", "--interactive", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--pids-limit=64", "--memory=1g", "--cpus=2", "--network=bridge", "--log-driver=none"]) expect(args).toContain(flag);
  expect(args).toContain("COLUMNS=300");
  expect(args).toContain("LINES=30");
  expect(args.filter(arg => arg === "--mount")).toHaveLength(1);
  expect(args).toContain(`type=bind,src=${home},dst=/home/prototype`);
  expect(args.at(-1)).toMatch(/^agent-hub-antigravity-prototype:1\.3\.6-[a-f0-9]+$/);
  class ScriptedDocker extends DockerRuntime {
    calls: string[][] = [];
    protected override async command(args: string[]) { this.calls.push(args); return args[0] === "ps" ? "abcdef012345\n123456abcdef" : ""; }
  }
  const docker = new ScriptedDocker();
  await docker.cleanup("owner");
  expect(docker.calls).toEqual([["ps", "-aq", "--filter", `label=${OWNER_LABEL}=owner`], ["rm", "--force", "abcdef012345"], ["rm", "--force", "123456abcdef"]]);
});
it("cleans the same owner at startup and shutdown and hides runtime errors", async () => {
  const { login, runtime } = fixture();
  await login.cleanup();
  runtime.prepare.mockRejectedValue(new Error("sensitive-docker-output"));
  await login.start(); await flush();
  expect(await login.session()).toMatchObject({ state: "failed" });
  expect(JSON.stringify(await login.status())).not.toContain("sensitive-docker-output");
  await login.shutdown();
  expect(runtime.cleanup.mock.calls.every(([owner]) => owner === login.owner)).toBe(true);
  expect(runtime.cleanup.mock.calls.length).toBeGreaterThanOrEqual(3);
});
it("authenticates every route and never stores or logs screen or submitted input", async () => {
  const { login, runtime, dataDir } = fixture();
  const db = openDb(":memory:");
  const hub = new Hub({ db, dataDir, agents: {}, maxConcurrent: 1 });
  const api = createApp(hub, "hub-token", undefined, undefined, undefined, { antigravity: login });
  const logger = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")];
  const headers = { authorization: "Bearer hub-token", "content-type": "application/json" };
  for (const [route, method] of [["", "GET"], ["/login", "GET"], ["/login/start", "POST"], ["/login/input", "POST"], ["/login/cancel", "POST"], ["/logout", "POST"]]) {
    expect((await api.request(`/api/antigravity${route}`, { method })).status).toBe(401);
  }
  const snapshot = () => (db as unknown as { $client: { serialize(): Buffer } }).$client.serialize();
  const before = snapshot();
  expect((await api.request("/api/antigravity/login/start", { method: "POST", headers })).status).toBe(200);
  await flush();
  runtime.output(Buffer.from("\r\nprivate-screen-marker"));
  const view = await api.request("/api/antigravity/login", { headers });
  expect(view.headers.get("cache-control")).toBe("no-store");
  expect(await view.text()).toContain("private-screen-marker");
  expect((await api.request("/api/antigravity/login/input", { method: "POST", headers, body: JSON.stringify({ text: "private-input-marker" }) })).status).toBe(200);
  expect((await api.request("/api/antigravity/login/input", { method: "POST", headers, body: '{"text":"bad\\n"}' })).status).toBe(400);
  runtime.exit(0); await flush();
  expect(snapshot().equals(before)).toBe(true);
  expect(hub.listTasks()).toEqual([]);
  for (const spy of logger) expect(spy).not.toHaveBeenCalled();
  expect(runtime.writes).toContain("private-input-marker");
});

it("bounds image builds and launches no extra CLI arguments", async () => {
  class ScriptedDocker extends DockerRuntime {
    calls: { args: string[]; signal?: AbortSignal; timeout?: number }[] = [];
    protected override async command(args: string[], signal?: AbortSignal, timeout?: number) {
      this.calls.push({ args, signal, timeout });
      if (args[0] === "image") throw new Error("missing image");
      return "";
    }
  }
  const runtime = new ScriptedDocker(); const abort = new AbortController();
  await runtime.prepare(abort.signal);
  expect(runtime.calls[1]?.args[0]).toBe("build");
  expect(runtime.calls[1]?.timeout).toBe(5 * 60_000);
  expect(runtime.calls[1]?.signal).toBe(abort.signal);
  expect(runtime.calls[1]?.args).toContainEqual(expect.stringContaining("antigravity-prototype.Dockerfile"));
});


it("keeps start and logout locked until exit cleanup has completed", async () => {
  const { login, runtime } = fixture();
  let release: () => void = () => {};
  runtime.remove.mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
  await login.start(); await flush();
  runtime.exit(0); await flush();
  expect((await login.session()).state).toBe("stopping");
  await expect(login.start()).rejects.toThrow("session-active");
  await expect(login.logout()).rejects.toThrow("session-active");
  release(); await flush();
  expect(await login.session()).toMatchObject({ state: "exited", exitCode: 0 });
});


it.each(["Enter code:", "Please enter your authorization code.", "Enter\tcode:"])("keeps the prompt %j separate from a preceding URL", async prompt => {
  const terminal = new LoginScreen();
  const url = "https://accounts.example.invalid/oauth?state=synthetic";
  terminal.write(Buffer.from(`${url}\r\n  ${prompt}  `));
  const view = await terminal.read();
  expect(view.links).toEqual([url]);
  expect(view.screen[0]).toBe(url);
  expect(view.screen[1]?.trim().replace(/\s+/g, " ")).toBe(prompt.replace(/\s+/g, " "));
  await terminal.dispose();
});

it("joins a whole-line URL fragment with a 43-character challenge without redaction", async () => {
  const terminal = new LoginScreen();
  const url = "https://accounts.example.invalid/oauth?client_id=synthetic&";
  const fragment = `code_challenge=${"C".repeat(43)}`;
  terminal.write(Buffer.from(`${url}\r\n  ${fragment}  \r\nEnter code:`));
  const view = await terminal.read();
  expect(view.links).toEqual([url + fragment]);
  expect(view.screen[0]).toBe(url + fragment);
  expect(view.screen[1]).toBe("Enter code:");
  expect(view.screen.join("\n")).not.toContain("[REDACTED]");
  await terminal.dispose();
});

it("joins a three-line hard-wrapped authorization URL before token redaction", async () => {
  const terminal = new LoginScreen();
  const challenge = "C".repeat(43);
  const fragments = ["https://accounts.example.invalid/oauth?client_id=synthetic&", `code_challenge=${challenge}&`, `state=${"S".repeat(90)}&redirect_uri=https%3A%2F%2Fexample.invalid%2Fcallback`];
  terminal.write(Buffer.from(`\x1b[2;4HOpen this link:\r\n${fragments[0]}   \r\n  ${fragments[1]}\r\n    ${fragments[2]}\r\n\r\nya29.standalone-secret\r\n${"f".repeat(70)}`));
  const view = await terminal.read();
  expect(view.links).toEqual([fragments.join("")]);
  const screen = view.screen.join("\n");
  expect(screen).toContain(fragments.join(""));
  expect(screen).toContain(challenge);
  expect(screen).not.toContain("ya29.standalone-secret");
  expect(screen).not.toContain("f".repeat(70));
  expect(screen.match(/\[REDACTED\]/g)).toHaveLength(2);
  await terminal.dispose();
});

it.each(["availability", "cleanup", "prepare", "create", "attach", "start", "wait", "remove"] as const)("reports only the fixed %s failure stage through the API", async stage => {
  const { login, runtime, dataDir } = fixture();
  const message = "private-runtime-error: /private/credential/path and private-runtime-output";
  const logger = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")];
  if (stage === "availability") runtime.reachable.mockRejectedValueOnce(new Error(message));
  else runtime[stage].mockRejectedValueOnce(new Error(message));
  const db = openDb(":memory:");
  const api = createApp(new Hub({ db, dataDir, agents: {}, maxConcurrent: 1 }), "hub-token", undefined, undefined, undefined, { antigravity: login });
  const headers = { authorization: "Bearer hub-token" };
  const start = await api.request("/api/antigravity/login/start", { method: "POST", headers });
  expect(start.status).toBe(200);
  expect(await start.text()).not.toContain(message);
  await flush();
  if (stage === "remove") { runtime.exit(0); await flush(); }
  const response = await api.request("/api/antigravity/login", { headers });
  const text = await response.text();
  expect(JSON.parse(text)).toMatchObject({ state: "failed", failedStage: stage });
  for (const secret of [message, "private-runtime-error", "/private/credential/path", "private-runtime-output"]) expect(text).not.toContain(secret);
  for (const spy of logger) expect(spy).not.toHaveBeenCalled();
});

it("preserves the original failure stage if container removal also fails", async () => {
  const { login, runtime } = fixture();
  runtime.prepare.mockRejectedValueOnce(new Error("private-prepare-error"));
  runtime.remove.mockRejectedValueOnce(new Error("private-remove-error"));
  await login.start(); await flush();
  expect(await login.session()).toMatchObject({ state: "failed", failedStage: "prepare" });
});
