import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ClaudeLogin, parseStatus, validateHome, type ClaudeRuntime } from "../src/claude-login/login";
import { containerArgs, OWNER_LABEL, ClaudeDockerRuntime } from "../src/claude-login/docker";
import { QuotaService } from "../src/core/quota";
import { FakeAdapter } from "../src/agents/fake";
import { createApp } from "../src/app";
import { Hub } from "../src/core/hub";
import { openDb } from "../src/db";

const dirs: string[] = [];
const logins: ClaudeLogin[] = [];
function directory() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-login-test-")); dirs.push(dir); return dir; }
const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
class FakeRuntime implements ClaudeRuntime {
  exit: (code: number) => void = () => {};
  reachable = vi.fn(async () => true);
  prepare = vi.fn(async () => {});
  create = vi.fn(async () => {});
  attach = vi.fn(async () => ({ write: vi.fn(), close: vi.fn() }));
  start = vi.fn(async () => {});
  wait = vi.fn((_name: string, signal: AbortSignal) => new Promise<number>((resolve, reject) => {
    this.exit = resolve;
    signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  }));
  remove = vi.fn(async () => {});
  cleanup = vi.fn(async () => {});
  run = vi.fn(async (_home: string, _owner: string, _command: string[]) => ({ stdout: JSON.stringify({ loggedIn: true, email: "person@example.invalid", subscriptionType: "max" }), exitCode: 0 }));
}
function fixture(onSuccess?: () => Promise<void>) {
  const dataDir = directory(); const runtime = new FakeRuntime(); let now = 0;
  const login = new ClaudeLogin({ dataDir, runtime, now: () => now, onSuccess }); logins.push(login);
  return { login, runtime, dataDir, advance: (ms: number) => { now += ms; } };
}
afterEach(async () => {
  await Promise.all(logins.splice(0).map(login => login.shutdown()));
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
it("uses only the hardened home and SDK binary mounts and official login command", () => {
  const args = containerArgs("login", "owner", "/storage/claude-home", 123, 456, undefined, "/sdk/claude", "image");
  for (const flag of ["--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--pids-limit=64", "--memory=1g", "--cpus=2", "--network=bridge", "--log-driver=none"]) expect(args).toContain(flag);
  expect(args).toContain(`${OWNER_LABEL}=owner`);
  expect(args).toContain("123:456");
  expect(args).toContain("type=bind,src=/storage/claude-home,dst=/claude-home");
  expect(args).toContain("type=bind,src=/sdk/claude,dst=/sdk/claude,readonly");
  expect(args.filter(arg => arg.startsWith("type=bind"))).toHaveLength(2);
  expect(args).toContain("CLAUDE_CONFIG_DIR=/claude-home"); expect(args).toContain("HOME=/tmp");
  expect(args.slice(-4)).toEqual(["image", "auth", "login", "--claudeai"]);
  expect(args).not.toContain("/var/run/docker.sock");
  expect(() => containerArgs("a", "b", "/unsafe,home", 1, 1, undefined, "/sdk/claude", "image")).toThrow();
});
it("creates a private home and rejects symlinks, dangling symlinks, parents and files", () => {
  const data = directory(); const home = path.join(data, "claude-home"); const outside = directory();
  expect(validateHome(data, home, true)).toBe(home);
  expect(fs.statSync(home).mode & 0o777).toBe(0o700);
  fs.chmodSync(home, 0o755); validateHome(data, home); expect(fs.statSync(home).mode & 0o777).toBe(0o700);
  fs.rmdirSync(home);
  for (const target of [outside, path.join(outside, "missing")]) {
    fs.symlinkSync(target, home); expect(() => validateHome(data, home, true)).toThrow("unsafe-storage"); fs.unlinkSync(home);
  }
  fs.writeFileSync(home, "file"); expect(() => validateHome(data, home, true)).toThrow("unsafe-storage");
  const parent = path.join(data, "linked"); fs.symlinkSync(outside, parent);
  expect(() => validateHome(parent, path.join(parent, "claude-home"), true)).toThrow("unsafe-storage");
  expect(() => validateHome(data, outside)).toThrow("unsafe-storage");
});
it("projects only public account fields and rejects malformed status or token-like metadata", () => {
  expect(parseStatus('{"loggedIn":true,"email":"person@example.invalid","subscriptionType":"pro","accessToken":"secret"}')).toEqual({ state: "logged-in", email: "person@example.invalid", subscriptionType: "pro" });
  expect(parseStatus('{"loggedIn":false}')).toEqual({ state: "logged-out" });
  for (const raw of ["not json", "null", "[]", "{}", '{"loggedIn":"true"}']) expect(parseStatus(raw)).toEqual({ state: "unknown" });
  expect(parseStatus(JSON.stringify({ loggedIn: true, email: "sk-ant-secret", subscriptionType: "a".repeat(80), token: "secret" }))).toEqual({ state: "logged-in" });
});
it("caches and coalesces probes, bounds refresh, and returns unknown on failure without logging", async () => {
  const { login, runtime, advance } = fixture();
  const logs = [vi.spyOn(console, "error"), vi.spyOn(console, "warn"), vi.spyOn(console, "log")];
  const first = await Promise.all([login.status(), login.status()]);
  expect(first[0].account).toMatchObject({ state: "logged-in" }); expect(runtime.run).toHaveBeenCalledTimes(1);
  expect(runtime.run.mock.calls[0]![2]).toEqual(["auth", "status", "--json"]);
  await login.status(true); expect(runtime.run).toHaveBeenCalledTimes(1);
  advance(10_000); await login.status(); expect(runtime.run).toHaveBeenCalledTimes(1);
  await login.status(true); expect(runtime.run).toHaveBeenCalledTimes(2);
  advance(60_000); runtime.run.mockRejectedValueOnce(new Error("sk-ant-private-token"));
  expect((await login.status()).account).toEqual({ state: "unknown" });
  for (const log of logs) expect(log).not.toHaveBeenCalled();
});
it("refuses logout during login and refreshes status and quota after a successful exit", async () => {
  const adapter = new FakeAdapter();
  adapter.queryQuota = vi.fn(async () => ({ status: "missing_login" as const, windows: [] }));
  const quota = new QuotaService({ claude: adapter }, () => 0);
  await quota.read();
  adapter.queryQuota = vi.fn(async () => ({ status: "ok" as const, windows: [] }));
  const success = vi.fn(async () => { await quota.refreshClaude(); });
  const { login, runtime } = fixture(success);
  await login.status();
  await login.start(); await flush();
  await expect(login.logout()).rejects.toThrow("session-active");
  runtime.exit(0); await flush();
  expect((await login.session()).state).toBe("exited");
  expect(runtime.run).toHaveBeenCalledTimes(2); expect(success).toHaveBeenCalledOnce();
  expect(quota.peek("claude")?.status).toBe("ok");
  runtime.run.mockResolvedValueOnce({ stdout: "", exitCode: 0 }).mockResolvedValueOnce({ stdout: '{"loggedIn":false}', exitCode: 1 });
  expect((await login.logout()).account.state).toBe("logged-out");
  expect(runtime.run.mock.calls[2]![2]).toEqual(["auth", "logout"]);
  await quota.shutdown();
});
it("does not run recovery on a failed login and keeps start locked during logout", async () => {
  const success = vi.fn(async () => {}); const { login, runtime } = fixture(success);
  await login.start(); await flush(); runtime.exit(1); await flush();
  expect(success).not.toHaveBeenCalled();
  let release: (value: { stdout: string; exitCode: number }) => void = () => {};
  runtime.run.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const logout = login.logout();
  await expect(login.start()).rejects.toThrow("session-active");
  release({ stdout: "", exitCode: 0 }); await logout;
});
it("authenticates all Claude routes, sets no-store, and hides container failures", async () => {
  const { login, runtime, dataDir } = fixture(); const db = openDb(":memory:");
  const hub = new Hub({ db, dataDir, agents: {}, maxConcurrent: 1 });
  const app = createApp(hub, "test-token", undefined, undefined, undefined, { claudeLogin: login });
  const headers = { authorization: "Bearer test-token", "content-type": "application/json" };
  const base = "/api/terminal-login/claude";
  for (const [suffix, method] of [["", "GET"], ["/login", "GET"], ["/login/start", "POST"], ["/login/input", "POST"], ["/login/cancel", "POST"], ["/logout", "POST"]]) {
    expect((await app.request(base + suffix, { method })).status).toBe(401);
  }
  const response = await app.request(base, { headers }); expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toMatchObject({ account: { state: "logged-in" } });
  const bad = await app.request(base + "/login/input", { method: "POST", headers, body: "invalid" }); expect(bad.status).toBe(400);
  runtime.run.mockRejectedValueOnce(new Error("private-token"));
  const failure = await app.request(base + "/logout", { method: "POST", headers });
  expect(failure.status).toBe(503); expect(await failure.text()).not.toContain("private-token");
  await hub.shutdown(); (db as unknown as { $client: { close(): void } }).$client.close();
});
it("bounds noninteractive containers, checks exit status, and removes even on timeout", async () => {
  class Runtime extends ClaudeDockerRuntime {
    calls: { args: string[]; timeout?: number }[] = [];
    fail = false;
    override async prepare() {}
    protected override async command(args: string[], _signal?: AbortSignal, timeout?: number) {
      this.calls.push({ args, timeout });
      if (this.fail && args[0] === "start") throw new Error("private timeout output");
      if (args[0] === "wait") return "0";
      return '{"loggedIn":true}';
    }
  }
  const runtime = new Runtime(); await runtime.run("/private/claude-home", "owner", ["auth", "status", "--json"]);
  expect(runtime.calls[0]!.args).not.toContain("--tty"); expect(runtime.calls[0]!.args).not.toContain("--interactive");
  expect(runtime.calls.find(call => call.args[0] === "start")?.timeout).toBe(30_000);
  expect(runtime.calls.at(-1)?.args[0]).toBe("rm");
  runtime.fail = true; await expect(runtime.run("/private/claude-home", "owner", ["auth", "logout"])).rejects.toThrow();
  expect(runtime.calls.at(-1)?.args[0]).toBe("rm");
});

it.each([
  ['{"loggedIn":false}', 1, "logged-out"],
  ['{"loggedIn":true}', 2, "logged-in"],
  ["invalid JSON", 1, "unknown"],
] as const)("uses status JSON %s even with exit %i", async (stdout, exitCode, expected) => {
  const { login, runtime } = fixture();
  runtime.run.mockResolvedValueOnce({ stdout, exitCode });
  expect((await login.status()).account.state).toBe(expected);
});

it.each(["host", "docker"] as const)("exposes the configured %s runtime in panel status", async claudeRuntime => {
  const login = new ClaudeLogin({ dataDir: directory(), runtime: new FakeRuntime(), claudeRuntime });
  logins.push(login);
  expect((await login.status()).runtime).toBe(claudeRuntime);
});

it.each([false, true])("uses valid status JSON despite a non-zero fake container exit (loggedIn=%s)", async loggedIn => {
  const { login, runtime } = fixture();
  runtime.run.mockResolvedValueOnce({ stdout: JSON.stringify({ loggedIn }), exitCode: 1 });
  expect((await login.status()).account.state).toBe(loggedIn ? "logged-in" : "logged-out");
});

it("captures stdout from rejected non-zero status commands while keeping logout strict", async () => {
  class Runtime extends ClaudeDockerRuntime {
    stdout = '{"loggedIn":false}';
    transportFailure = false;
    rejectStart = true;
    override async prepare() {}
    protected override async command(args: string[]) {
      if (args[0] === "start") {
        if (!this.rejectStart) return this.stdout;
        if (this.transportFailure) throw Object.assign(new Error("timeout"), { code: "ETIMEDOUT", stdout: this.stdout });
        throw Object.assign(new Error("non-zero exit"), { code: 1, stdout: this.stdout });
      }
      return args[0] === "wait" ? "1" : "";
    }
  }
  const runtime = new Runtime();
  const result = await runtime.run("/private/claude-home", "owner", ["auth", "status", "--json"]);
  expect(result).toEqual({ stdout: '{"loggedIn":false}', exitCode: 1 });
  expect(parseStatus(result.stdout)).toEqual({ state: "logged-out" });
  runtime.rejectStart = false;
  expect(await runtime.run("/private/claude-home", "owner", ["auth", "status", "--json"])).toEqual(result);
  await expect(runtime.run("/private/claude-home", "owner", ["auth", "logout"])).rejects.toThrow();
  runtime.rejectStart = true;
  runtime.stdout = "invalid JSON";
  expect(parseStatus((await runtime.run("/private/claude-home", "owner", ["auth", "status", "--json"])).stdout)).toEqual({ state: "unknown" });
  await expect(runtime.run("/private/claude-home", "owner", ["auth", "logout"])).rejects.toThrow();
  runtime.transportFailure = true;
  await expect(runtime.run("/private/claude-home", "owner", ["auth", "status", "--json"])).rejects.toThrow("timeout");
});
