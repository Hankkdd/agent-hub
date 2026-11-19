import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { spawn, execFile } from "node:child_process";
import { claudeQuota } from "../src/agents/claude-quota";
import { quotaCommand, readCodexQuota } from "../src/agents/codex-quota";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: vi.fn(), execFile: vi.fn((...args: unknown[]) => (args.at(-1) as Function)(null, "", "")) }));
const usage = vi.fn(), close = vi.fn(), accountInfo = vi.fn();
let signal: AbortSignal;
beforeEach(() => {
  vi.clearAllMocks();
  accountInfo.mockResolvedValue({ tokenSource: "oauth", apiProvider: "firstParty" });
  usage.mockResolvedValue({ rate_limits: { five_hour: { utilization: 0, resets_at: "2026-10-15T00:00:00Z" } } });
  vi.mocked(query).mockImplementation((args: any) => {
    signal = args.options.abortController.signal;
    return { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: usage, close, accountInfo } as any;
  });
});
afterEach(() => vi.useRealTimers());
it("Claude reads only the experimental control method, then aborts and closes", async () => {
  expect((await claudeQuota(new AbortController().signal)).windows[0]?.remainingPercent).toBe(100);
  expect(query).toHaveBeenCalledWith({ prompt: "", options: expect.objectContaining({ tools: [], settingSources: [], permissionMode: "dontAsk" }) });
  expect(usage).toHaveBeenCalledWith({ skipBehaviors: true });
  expect(signal.aborted).toBe(true);
  expect(close).toHaveBeenCalledOnce();
});
it("Claude degrades gracefully and cleans up errors, unsupported methods, and missing login", async () => {
  usage.mockRejectedValueOnce(new Error("sensitive"));
  expect(await claudeQuota(new AbortController().signal)).toEqual({ status: "error", windows: [] });
  accountInfo.mockResolvedValueOnce({});
  expect((await claudeQuota(new AbortController().signal)).status).toBe("missing_login");
  vi.mocked(query).mockReturnValueOnce({ close } as any);
  expect((await claudeQuota(new AbortController().signal)).status).toBe("unavailable");
  expect(close).toHaveBeenCalledTimes(3);
});
it("Claude bounds a hanging control method and cleans up on cancellation", async () => {
  vi.useFakeTimers();
  usage.mockImplementationOnce(() => new Promise(() => {}));
  const result = claudeQuota(new AbortController().signal);
  await vi.advanceTimersByTimeAsync(20_000);
  expect((await result).status).toBe("error");
  expect(signal.aborted).toBe(true);
  expect(close).toHaveBeenCalledOnce();
  const ac = new AbortController();
  usage.mockImplementationOnce(() => new Promise(() => {}));
  const cancelled = claudeQuota(ac.signal);
  ac.abort();
  expect((await cancelled).status).toBe("error");
  expect(close).toHaveBeenCalledTimes(2);
});

function processMock(respond: (message: any, proc: any) => void) {
  const proc = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(), pid: undefined });
  proc.stdin.on("data", chunk => {
    const message = JSON.parse(chunk.toString());
    queueMicrotask(() => respond(message, proc));
  });
  vi.mocked(spawn).mockReturnValue(proc as any);
  return proc;
}
it("Claude bounds subprocess output and kills the quota process on overflow", async () => {
  const proc = processMock(() => {});
  vi.mocked(query).mockImplementationOnce((args: any) => {
    signal = args.options.abortController.signal;
    args.options.spawnClaudeCodeProcess({ command: "mock-claude", args: ["control"], cwd: "/tmp", env: { SAFE_SETTING: "test" } });
    return { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: usage, close,
      accountInfo: () => new Promise(() => {}) } as any;
  });
  const result = claudeQuota(new AbortController().signal);
  proc.stderr.write("x".repeat(512 * 1024 + 1));
  expect((await result).status).toBe("error");
  expect(signal.aborted).toBe(true);
  expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
  expect(proc.stdout.destroyed).toBe(true);
  expect(close).toHaveBeenCalledOnce();
  expect(spawn).toHaveBeenCalledWith("mock-claude", ["control"], expect.objectContaining({ cwd: "/tmp", env: { SAFE_SETTING: "test" } }));
});

const command = { command: "mock-codex", args: ["app-server"] };
const send = (proc: any, id: number, result: unknown) => proc.stdout.write(`${JSON.stringify({ id, result })}\n`);
it("Codex initializes, reads the active account and quota, without threads or turns", async () => {
  const messages: any[] = [];
  const proc = processMock((message, proc) => {
    messages.push(message);
    if (message.method === "initialize") send(proc, message.id, {});
    if (message.method === "account/read") send(proc, message.id, { account: { type: "chatgpt" } });
    if (message.method === "account/rateLimits/read") send(proc, message.id, { rateLimits: { primary: { usedPercent: 25, windowDurationMins: 15, resetsAt: 1791972000 } } });
  });
  expect((await readCodexQuota(command, new AbortController().signal)).windows[0]).toMatchObject({ durationMins: 15, remainingPercent: 75 });
  expect(messages.map(m => m.method)).toEqual(["initialize", "initialized", "account/read", "account/rateLimits/read"]);
  expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
  expect(proc.stdout.destroyed).toBe(true);
});
it("Codex mounts only the configured login and uses the orphan label and pinned host CLI", () => {
  vi.stubEnv("OPENAI_QUOTA_TEST_SETTING", "private-value");
  const docker = quotaCommand("codex:pinned", "/example/login");
  expect(docker.args.filter(arg => arg === "-v")).toHaveLength(1);
  expect(docker.args).toContain("/example/login:/codex-home");
  expect(docker.args).toContain("agent-hub=codex");
  expect(docker.args).toContain("OPENAI_QUOTA_TEST_SETTING");
  expect(docker.args).not.toContain("private-value");
  expect(docker.args).not.toContain("CODEX_HOME");
  vi.unstubAllEnvs();
  expect(docker.container).toMatch(/^agent-hub-quota-/);
  expect(quotaCommand(null).args[0]).toContain("@openai/codex/bin/codex.js");
});
it.each([null, { type: "apiKey" }])("Codex reports missing login or unsupported account without querying quota: %j", async account => {
  const methods: string[] = [];
  processMock((message, proc) => {
    methods.push(message.method);
    if (message.method === "initialize") send(proc, message.id, {});
    if (message.method === "account/read") send(proc, message.id, { account });
  });
  expect((await readCodexQuota(command, new AbortController().signal)).status).toBe(account ? "unavailable" : "missing_login");
  expect(methods).not.toContain("account/rateLimits/read");
});
it.each(["error", "malformed", "overflow", "exit", "unsupported"])("Codex cleans up transport failure and container: %s", async mode => {
  const proc = processMock((message, proc) => {
    if (mode === "error") proc.emit("error", new Error("sensitive"));
    if (mode === "malformed") proc.stdout.write("invalid\n");
    if (mode === "overflow") proc.stderr.write("x".repeat(512 * 1024 + 1));
    if (mode === "exit") proc.emit("exit", 1);
    if (mode === "unsupported") proc.stdout.write(JSON.stringify({ id: message.id, error: { code: -32601, message: "sensitive" } }) + "\n");
  });
  const result = await readCodexQuota({ ...command, container: "test-container" }, new AbortController().signal);
  expect(["error", "unavailable"]).toContain(result.status);
  expect(JSON.stringify(result)).not.toContain("sensitive");
  expect(proc.kill).toHaveBeenCalled();
  expect(execFile).toHaveBeenCalledWith("docker", ["rm", "-f", "test-container"], expect.objectContaining({ timeout: 3000 }), expect.any(Function));
});
it("Codex times out and handles shutdown cancellation with cleanup", async () => {
  vi.useFakeTimers();
  const proc = processMock(() => {});
  const result = readCodexQuota(command, new AbortController().signal);
  await vi.advanceTimersByTimeAsync(20_000);
  expect((await result).status).toBe("error");
  expect(proc.kill).toHaveBeenCalledOnce();
  const ac = new AbortController();
  const cancelled = readCodexQuota(command, ac.signal);
  ac.abort();
  expect((await cancelled).status).toBe("error");
  expect(proc.kill).toHaveBeenCalledTimes(2);
});
