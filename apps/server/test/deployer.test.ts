import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Deployer, type CommandRunner } from "../src/deploy/deployer";
import { createApp } from "../src/app";
import type { Hub } from "../src/core/hub";

const current = "a".repeat(40), target = "b".repeat(40), older = "c".repeat(40);
const now = Date.parse("2026-01-01T00:00:00Z");
let dataDir: string, deployer: Deployer;
let dirty: boolean, unitMissing: boolean, gitMissing: boolean, fetchFails: boolean, startFails: boolean;
let unit: string, clock: number;
let runner: ReturnType<typeof vi.fn<CommandRunner>>;
const make = (enabled = true) => new Deployer({ enabled, checkout: "/production checkout", dataDir, run: runner, now: () => clock });
const requested = () => fs.writeFile(path.join(dataDir, "deploy-request.json"), JSON.stringify({ sha: target, requestedAt: new Date(now).toISOString() }));
const terminal = (state: string, result: string, code = "0") => `ActiveState=${state}\nResult=${result}\nExecMainStatus=${code}\nExecMainExitTimestamp=Thu 2026-01-01 00:00:10 UTC`;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "hub-deployer-"));
  dirty = unitMissing = gitMissing = fetchFails = startFails = false;
  clock = now;
  unit = terminal("inactive", "success");
  runner = vi.fn(async (file, args) => {
    if (file === "git") {
      const command = args.slice(2).join(" ");
      if (gitMissing) throw new Error("not a git checkout");
      if (command === "rev-parse HEAD") return current;
      if (command === "rev-parse origin/main") return target;
      if (command === "log -1 --format=%s HEAD") return "Current subject";
      if (command === "log -1 --format=%s origin/main") return "Target subject";
      if (command === "status --porcelain --untracked-files=all") return dirty ? "?? untracked" : "";
      if (command === "log -30 --format=%H %s HEAD..origin/main") return `${target} Target subject\n${older} Older subject`;
      if (command === "fetch origin") { if (fetchFails) throw new Error("fetch offline"); return ""; }
    }
    if (file === "systemctl") {
      if (args[1] === "cat") { if (unitMissing) throw new Error("unit missing"); return "[Service]"; }
      if (args[1] === "show") return unit;
      if (args[1] === "start") { if (startFails) throw new Error("start failed"); return ""; }
    }
    if (file === "journalctl") return "failure log\nlast line";
    throw new Error(`Unexpected command: ${file} ${args.join(" ")}`);
  });
  deployer = make();
});
afterEach(async () => { await fs.rm(dataDir, { recursive: true, force: true }); });

it("reads commits, bounded newest-first pending list, dirty state, history and missing request", async () => {
  dirty = true;
  await fs.writeFile(path.join(dataDir, "deploy-history"), `old ${older}\nlatest ${current}\n`);
  expect(await deployer.status()).toMatchObject({ enabled: true, current: { sha: current, subject: "Current subject" },
    target: { sha: target, subject: "Target subject" }, pending: [{ sha: target, subject: "Target subject" }, { sha: older, subject: "Older subject" }],
    dirty: true, last: null, deploying: false, history: `latest ${current}` });
  expect(runner).toHaveBeenCalledWith("git", ["-C", "/production checkout", "log", "-30", "--format=%H %s", "HEAD..origin/main"]);
});

it.each([
  ["corrupt JSON", "{"],
  ["empty JSON", ""],
  ["null", "null"],
  ["invalid SHA", JSON.stringify({ sha: "main", requestedAt: new Date(now).toISOString() })],
  ["missing SHA", JSON.stringify({ requestedAt: new Date(now).toISOString() })],
  ["non-string SHA", JSON.stringify({ sha: 123, requestedAt: new Date(now).toISOString() })],
  ["missing timestamp", JSON.stringify({ sha: target })],
  ["invalid timestamp", JSON.stringify({ sha: target, requestedAt: "invalid" })],
  ["non-string timestamp", JSON.stringify({ sha: target, requestedAt: now })],
])("ignores %s in the request file without breaking status or gated routes", async (_label, raw) => {
  await requested(); unit = terminal("activating", "success");
  await deployer.status();
  expect(deployer.deploying).toBe(true);
  await fs.writeFile(path.join(dataDir, "deploy-request.json"), raw!);
  runner.mockClear();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    expect(await deployer.status()).toMatchObject({ last: null, deploying: false });
    expect(warn).toHaveBeenCalledExactlyOnceWith("Ignoring invalid deploy-request.json");
    expect(await deployer.refreshDeploying()).toBe(false);
    expect(warn).toHaveBeenCalledTimes(2);
    const sendMessage = vi.fn();
    const app = createApp({ sendMessage } as unknown as Hub, "test-token", undefined, undefined, deployer);
    const headers = { authorization: "Bearer test-token", "content-type": "application/json" };
    const status = await app.request("/api/deploy", { headers });
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ last: null });
    const response = await app.request("/api/tasks/task/messages", { method: "POST", headers, body: JSON.stringify({ text: "Hello" }) });
    expect(response.status).toBe(200);
    expect(sendMessage).toHaveBeenCalledWith("task", "Hello", undefined);
    expect(warn).toHaveBeenCalledTimes(4);
    expect(runner.mock.calls.some(([file, args]) => file === "systemctl" && args[1] === "show")).toBe(false);
  } finally { warn.mockRestore(); }
});

it("skips unit checks for requests older than 30 minutes only on the guard path", async () => {
  await requested(); unit = terminal("activating", "success");
  clock += 30 * 60_000;
  expect(await deployer.refreshDeploying()).toBe(true);
  expect(runner).toHaveBeenCalledWith("systemctl", ["--user", "show", `agent-hub-deploy@${target}.service`, "-p", "ActiveState", "-p", "Result", "-p", "ExecMainStatus", "-p", "ExecMainExitTimestamp"]);
  runner.mockClear(); clock += 1;
  expect(await deployer.refreshDeploying()).toBe(false);
  expect(deployer.deploying).toBe(false);
  expect(runner).not.toHaveBeenCalled();
  expect(await deployer.status()).toMatchObject({ last: { outcome: "running" } });
  expect(runner.mock.calls.some(([file, args]) => file === "systemctl" && args[1] === "show")).toBe(true);
  runner.mockClear();
  expect(await deployer.refreshDeploying()).toBe(false);
  expect(runner).not.toHaveBeenCalled();
});

it("retains starting and accepted process locks regardless of request age or corruption", async () => {
  const starting = deployer.start(target, []);
  expect(await deployer.refreshDeploying()).toBe(true);
  await starting;
  clock += 31 * 60_000; runner.mockClear();
  expect(await deployer.refreshDeploying()).toBe(true);
  await fs.writeFile(path.join(dataDir, "deploy-request.json"), "{");
  expect(await deployer.refreshDeploying()).toBe(true);
  expect(runner).not.toHaveBeenCalled();
});

it("disables when not enabled, outside git, or the unit is missing", async () => {
  expect(await make(false).status()).toMatchObject({ enabled: false, disabledReason: "not_enabled" });
  unitMissing = true;
  expect(await deployer.status()).toMatchObject({ enabled: false, disabledReason: "unit_not_installed" });
  gitMissing = true;
  expect(await make().status()).toMatchObject({ enabled: false, disabledReason: "not_git_checkout", current: null });
});

it("coalesces fetches, throttles failures for 60 seconds, and retains known refs", async () => {
  fetchFails = true;
  const statuses = await Promise.all([deployer.status(), deployer.status()]);
  expect(statuses[0]).toMatchObject({ fetchError: "fetch offline", target: { sha: target } });
  const fetches = () => runner.mock.calls.filter(([file, args]) => file === "git" && args[2] === "fetch");
  expect(fetches()).toHaveLength(1);
  clock += 59_999; await deployer.status(); expect(fetches()).toHaveLength(1);
  clock += 1; fetchFails = false;
  expect((await deployer.status()).fetchError).toBeUndefined();
  expect(fetches()).toHaveLength(2);
});

it.each(["activating", "active"])("reports %s as running across server restart", async (state) => {
  await requested(); unit = terminal(state, "success");
  expect(await deployer.status()).toMatchObject({ deploying: true, last: { sha: target, outcome: "running" } });
});
it("reports success and failure, requesting exactly 50 journal lines only on failure", async () => {
  await requested();
  expect((await deployer.status()).last?.outcome).toBe("succeeded");
  expect(runner.mock.calls.some(([file]) => file === "journalctl")).toBe(false);
  for (const [state, result] of [["failed", "exit-code"], ["inactive", "timeout"]]) {
    unit = terminal(state!, result!, "1");
    expect((await deployer.status()).last).toMatchObject({ outcome: "failed", log: "failure log\nlast line", exitStatus: "1" });
  }
  expect(runner).toHaveBeenCalledWith("journalctl", ["--user", "-u", `agent-hub-deploy@${target}.service`, "-n", "50", "--no-pager", "-o", "cat"]);
});

it.each(["running", "waiting_user"] as const)("refuses a %s task", async (status) => {
  await expect(deployer.start(target, [{ status }])).rejects.toMatchObject({ status: 409, message: expect.stringContaining("tasks") });
  expect(deployer.deploying).toBe(false);
});
it("refuses disabled, missing unit, dirty, malformed and moved targets", async () => {
  await expect(make(false).start(target, [])).rejects.toMatchObject({ status: 409 });
  unitMissing = true;
  await expect(make().start(target, [])).rejects.toMatchObject({ status: 409 });
  unitMissing = false; dirty = true;
  await expect(deployer.start(target, [])).rejects.toMatchObject({ status: 409, message: "Production checkout is dirty" });
  dirty = false;
  for (const sha of [undefined, {}, "main", "B".repeat(40), `${target};echo hi`]) {
    await expect(deployer.start(sha, [])).rejects.toMatchObject({ status: 400 });
  }
  await expect(deployer.start(older, [])).rejects.toMatchObject({ status: 409, message: "origin/main moved; review again" });
  expect(runner.mock.calls.some(([, args]) => args[1] === "start")).toBe(false);
});
it("clears the observed unit lock after completion in a restarted process", async () => {
  await requested(); unit = terminal("activating", "success");
  expect(await deployer.refreshDeploying()).toBe(true);
  unit = terminal("inactive", "success");
  expect(await deployer.refreshDeploying()).toBe(false);
});
it("reports a failed accepted unit even when it has no exit timestamp", async () => {
  await deployer.start(target, []);
  unit = "ActiveState=failed\nResult=resources\nExecMainStatus=0\nExecMainExitTimestamp=";
  expect((await deployer.status()).last?.outcome).toBe("failed");
  expect(deployer.deploying).toBe(true);
});
it("refuses an activating unit even in a fresh process", async () => {
  await requested(); unit = terminal("activating", "success");
  await expect(deployer.start(target, [])).rejects.toMatchObject({ status: 409 });
});
it("persists the request, invokes only systemctl start with argument arrays and holds its lock", async () => {
  const pending = deployer.start(target, [{ status: "done" }]);
  await expect(deployer.start(target, [])).rejects.toMatchObject({ status: 409 });
  expect(await pending).toMatchObject({ deploying: true, last: { sha: target, outcome: "running" } });
  expect(JSON.parse(await fs.readFile(path.join(dataDir, "deploy-request.json"), "utf8"))).toEqual({ sha: target, requestedAt: new Date(now).toISOString() });
  expect(runner).toHaveBeenCalledWith("systemctl", ["--user", "start", "--no-block", `agent-hub-deploy@${target}.service`]);
  expect(runner.mock.calls.filter(([, args]) => args[1] === "start")).toHaveLength(1);
  expect((await deployer.status()).last?.outcome).toBe("succeeded");
  expect(deployer.deploying).toBe(true);
  await expect(deployer.start(target, [])).rejects.toMatchObject({ status: 409 });
});
it("does not mistake an earlier same-SHA success for the new request", async () => {
  unit = terminal("inactive", "success").replace("00:00:10", "00:00:00");
  clock += 60_000;
  await deployer.start(target, []);
  expect((await deployer.status()).last?.outcome).toBe("running");
});
it("restores the prior request and releases the lock if systemctl rejects the start", async () => {
  await requested(); const previous = await fs.readFile(path.join(dataDir, "deploy-request.json"), "utf8");
  startFails = true;
  await expect(deployer.start(target, [])).rejects.toMatchObject({ status: 409 });
  expect(deployer.deploying).toBe(false);
  expect(await fs.readFile(path.join(dataDir, "deploy-request.json"), "utf8")).toBe(previous);
});
it("authenticates deploy routes, returns no-store status, starts, gates listed mutations and allows GETs", async () => {
  const hub = { listTasks: () => [], getTask: () => ({ id: "task" }) } as unknown as Hub;
  const app = createApp(hub, "test-token", undefined, undefined, deployer);
  const headers = { authorization: "Bearer test-token", "content-type": "application/json" };
  expect((await app.request("/api/deploy")).status).toBe(401);
  const status = await app.request("/api/deploy", { headers });
  expect(status.headers.get("cache-control")).toBe("no-store");
  expect(await status.json()).toMatchObject({ target: { sha: target } });
  expect((await app.request("/api/deploy", { method: "POST", headers, body: JSON.stringify({ sha: target }) })).status).toBe(200);
  for (const suffix of ["", ...["messages", "answer", "recover", "switch-agent", "briefing", "explanations", "pr/draft", "pr"].map((s) => `/task/${s}`)]) {
    const response = await app.request(`/api/tasks${suffix}`, { method: "POST", headers, body: "{}" });
    expect(response.status, suffix).toBe(409);
    expect(await response.json()).toEqual({ error: "Deploying; the Hub will restart shortly" });
  }
  expect((await app.request("/api/tasks", { headers })).status).toBe(200);
  expect((await app.request("/api/tasks/task", { headers })).status).toBe(200);
  expect((await app.request("/api/deploy", { headers })).status).toBe(200);
});
it("gates after restart before a client has polled deploy status", async () => {
  await requested(); unit = terminal("activating", "success");
  const app = createApp({} as Hub, "test-token", undefined, undefined, make());
  expect((await app.request("/api/tasks", { method: "POST", headers: { authorization: "Bearer test-token" } })).status).toBe(409);
});
it("returns disabled and refuses POST when createApp has no deployer", async () => {
  const app = createApp({} as Hub, "test-token");
  const headers = { authorization: "Bearer test-token" };
  expect(await (await app.request("/api/deploy", { headers })).json()).toMatchObject({ enabled: false });
  expect((await app.request("/api/deploy", { method: "POST", headers })).status).toBe(409);
});
