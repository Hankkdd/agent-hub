import fs from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskEvent, WorkflowId } from "@agent-hub/shared";
import { GeminiAdapter, availableGemini, geminiRecent, GEMINI_TOOL_ERROR, type GeminiTransport } from "../src/agents/gemini";
import type { AgentEvent, AgentRunInput } from "../src/agents/types";
import { FakeAdapter } from "../src/agents/fake";
import { configuredAgents, withAgentFallback } from "../src/core/agent-fallback";
import { Hub } from "../src/core/hub";
import { openDb, type Db } from "../src/db";
import { createApp } from "../src/app";
import { briefingFixture } from "./briefing-fixture";

const init = { event: "init", conversation_id: "diagnostic-id", init: { agent: "hub-chat", cwd: "/work", tools: Array(60).fill("advertised-only") } };
const result = (response = "reply") => ({ event: "result", result: { status: "SUCCESS", response, conversation_id: "diagnostic-id" } });
const step = (extra: Record<string, unknown> = {}) => ({ event: "step_update", step_update: { step_type: "agent_response", state: "ACTIVE", ...extra } });
const encode = (...events: unknown[]) => events.map(e => JSON.stringify(e)).join("\n") + "\n";
type Output = Parameters<GeminiTransport["run"]>[2];
class ScriptedContainer implements GeminiTransport {
  args: string[][] = [];
  removed: string[] = [];
  signals: AbortSignal[] = [];
  lifecycle: string[] = [];
  available = vi.fn(async () => true);
  cleanup = vi.fn(async (_owner: string) => {});
  prepare = vi.fn(async (_signal: AbortSignal) => {});
  script: (output: Output, signal: AbortSignal) => Promise<void> = async output => { output("stdout", encode(init, result())); };
  async createRun(args: string[], _signal: AbortSignal) { this.args.push(args); this.lifecycle.push("create"); }
  async run(_name: string, signal: AbortSignal, output: Output) {
    this.lifecycle.push("start"); this.signals.push(signal);
    await this.script(output, signal);
  }
  async remove(name: string) { this.lifecycle.push("remove"); this.removed.push(name); }
}
const collect = async (events: AsyncIterable<AgentEvent>) => { const out: AgentEvent[] = []; for await (const e of events) out.push(e); return out; };
const hold = (signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal.aborted) reject(signal.reason);
  else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
});
let root: string, home: string, transport: ScriptedContainer, adapter: GeminiAdapter;
let db: Db;
const hubs: Hub[] = [];
const input = (extra: Partial<AgentRunInput> = {}): AgentRunInput => ({ prompt: "hello", cwd: "/repository-must-not-mount", signal: new AbortController().signal, ...extra });
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-test-"));
  home = path.join(root, "antigravity/home");
  fs.mkdirSync(path.join(home, ".gemini"), { recursive: true });
  fs.writeFileSync(path.join(home, ".gemini/oauth_creds.json"), "fixture-credential");
  transport = new ScriptedContainer();
  adapter = new GeminiAdapter({ dataDir: root, transport });
  db = openDb(":memory:");
});
afterEach(async () => {
  await Promise.all(hubs.splice(0).map(hub => hub.shutdown(50)));
  vi.useRealTimers();
  fs.rmSync(root, { recursive: true, force: true });
});
const makeHub = (gemini = true) => {
  const hub = new Hub({ db, dataDir: root, maxConcurrent: 4, flushMs: 1, agents: { codex: new FakeAdapter(), claude: new FakeAdapter(), ...(gemini ? { gemini: adapter } : {}) } });
  hubs.push(hub); return hub;
};
const promptOf = (args: string[]) => args[args.indexOf("-p") + 1]!;

describe("isolated Gemini chat (scripted transport, no Docker or Google)", () => {
  it("streams deltas before the result and mounts only the login home and an empty scratch directory", async () => {
    let finish!: () => void;
    transport.script = async output => {
      output("stdout", encode(init, step({ text_delta: "first " })));
      await new Promise<void>(resolve => { finish = resolve; });
      output("stdout", encode(step({ text_delta: "second" }), result("first second")));
    };
    const iterator = adapter.run(input())[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toEqual({ type: "thread", threadId: "diagnostic-id" });
    expect((await iterator.next()).value).toEqual({ type: "text_start" });
    expect((await iterator.next()).value).toEqual({ type: "text_delta", text: "first " });
    const args = transport.args[0]!;
    const mounts = args.flatMap((arg, i) => arg === "--mount" ? [args[i + 1]!] : []);
    expect(mounts).toHaveLength(2);
    expect(mounts[0]).toBe(`type=bind,src=${home},dst=/home/prototype`);
    expect(mounts[1]).toMatch(/^type=bind,src=.+,dst=\/work$/);
    const scratch = mounts[1]!.slice("type=bind,src=".length, -",dst=/work".length);
    expect(fs.readdirSync(scratch)).toEqual([]);
    expect(args.join(" ")).not.toContain("/repository-must-not-mount");
    expect(args).toContain("--read-only"); expect(args).toContain("--cap-drop=ALL");
    expect(args).toContain("--security-opt=no-new-privileges");
    expect(args.join(" ")).not.toMatch(/docker\.sock|--privileged|--cap-add|--model|--resume/);
    expect(args[args.indexOf("--agent") + 1]).toBe("hub-chat");
    expect(fs.readFileSync(path.join(home, ".gemini/config/agents/hub-chat.md"), "utf8")).toContain("tools: []");
    finish();
    expect(await collect({ [Symbol.asyncIterator]: () => iterator })).toEqual([{ type: "text_delta", text: "second" }, { type: "done", ok: true }]);
    expect(transport.removed).toHaveLength(1);
    expect(fs.existsSync(scratch)).toBe(false);
  });

  it("queues a transcript-free explanation behind chat using the same isolated container rules", async () => {
    let finish!: () => void;
    transport.script = async output => {
      if (transport.args.length === 1) await new Promise<void>(resolve => { finish = resolve; });
      output("stdout", encode(init, result()));
    };
    const chat = collect(adapter.run(input()));
    await vi.waitFor(() => expect(transport.args).toHaveLength(1));
    const explanation = collect(adapter.run(input({ prompt: "Committed hunks", systemPrompt: "Explain supplied hunks",
      toolsDisabled: true, readOnly: true, effort: "max",
      recent: [{ eventId: "private", seq: 1, sessionId: null, type: "user_message", text: "private chat history" }] })));
    await Promise.resolve();
    expect(transport.args).toHaveLength(1);
    finish();
    await Promise.all([chat, explanation]);
    const args = transport.args[1]!;
    expect(promptOf(args)).toBe("Explain supplied hunks\n\nCommitted hunks");
    expect(args.filter(arg => arg === "--mount")).toHaveLength(2);
    expect(args.join(" ")).not.toContain("/repository-must-not-mount");
    expect(args).toContain("--read-only");
    expect(args).not.toContain("--effort");
    expect(transport.lifecycle).toEqual(["create", "start", "remove", "create", "start", "remove"]);
  });

  it("emits the final response once when no deltas arrive, including a partial last line", async () => {
    transport.script = async output => {
      const data = encode(init, result("final only")).trimEnd();
      output("stderr", "Fetching quota summary\n");
      for (let i = 0; i < data.length; i += 7) output("stdout", data.slice(i, i + 7));
    };
    const events = await collect(adapter.run(input()));
    expect(events.filter(e => e.type === "text_delta")).toEqual([{ type: "text_delta", text: "final only" }]);
    expect(events.at(-1)).toEqual({ type: "done", ok: true });
  });

  it.each([
    step({ step_type: "tool" }), step({ step_type: "subagent" }), step({ step_type: "unknown" }),
    step({ tool_info: null }), step({ nested: { subagent_info: {} } }), step({ permission: false }),
    { event: "tool_call" }, { ...result(), tool_activity: false },
  ])("stops forbidden activity and removes the container: %j", async event => {
    transport.script = async output => { output("stdout", encode(init, event, result("must not appear"))); };
    const events = await collect(adapter.run(input()));
    expect(events.at(-1)).toEqual({ type: "done", ok: false, error: GEMINI_TOOL_ERROR });
    expect(events.some(e => e.type === "text_delta")).toBe(false);
    expect(transport.removed).toHaveLength(1);
  });

  it.each(["stop", "timeout"])("kills and removes the container on %s", async mode => {
    vi.useFakeTimers();
    transport.script = async (_output, signal) => hold(signal);
    const ac = new AbortController();
    const events = collect(adapter.run(input({ signal: ac.signal })));
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.signals).toHaveLength(1);
    if (mode === "stop") ac.abort(); else await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect((await events).at(-1)).toMatchObject({ type: "done", ok: false, error: expect.stringContaining(mode === "stop" ? "interrupted" : "timed out") });
    expect(transport.signals[0]!.aborted).toBe(true);
    expect(transport.removed).toHaveLength(1);
  });

  it("serializes concurrent turns until removal finishes and cancels a queued waiter promptly", async () => {
    let finish!: () => void;
    transport.script = async output => {
      output("stdout", encode(init, result()));
      if (transport.signals.length === 1) await new Promise<void>(resolve => { finish = resolve; });
    };
    const first = collect(adapter.run(input()));
    await vi.waitFor(() => expect(transport.signals).toHaveLength(1));
    const ac = new AbortController();
    const cancelled = collect(adapter.run(input({ signal: ac.signal })));
    const second = collect(adapter.run(input()));
    ac.abort();
    expect((await cancelled).at(-1)).toMatchObject({ type: "done", ok: false, error: expect.stringContaining("interrupted") });
    expect(transport.args).toHaveLength(1);
    finish();
    await Promise.all([first, second]);
    expect(transport.lifecycle).toEqual(["create", "start", "remove", "create", "start", "remove"]);
    expect(new Set(transport.removed).size).toBe(2);
  });

  it("includes image preparation in the five-minute deadline", async () => {
    vi.useFakeTimers();
    transport.prepare.mockImplementation(signal => hold(signal));
    const events = collect(adapter.run(input()));
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect((await events).at(-1)).toMatchObject({ type: "done", ok: false, error: expect.stringContaining("timed out") });
    expect(transport.args).toEqual([]);
  });

  it("blocks subsequent runs if container removal could not be confirmed", async () => {
    vi.spyOn(transport, "remove").mockRejectedValue(new Error("fixture cleanup failure"));
    expect((await collect(adapter.run(input()))).at(-1)).toMatchObject({ type: "done", ok: false, error: "Gemini container cleanup failed" });
    expect((await collect(adapter.run(input()))).at(-1)).toMatchObject({ type: "done", ok: false, error: expect.stringContaining("restart Hub") });
    expect(transport.args).toHaveLength(1);
  });

  it("rejects images without creating a container", async () => {
    expect(await collect(adapter.run(input({ images: [{ path: "/image.png", mime: "image/png" }] })))).toEqual([
      { type: "done", ok: false, error: "Gemini chat does not support images yet" },
    ]);
    expect(transport.args).toEqual([]);
  });

  it.each(["failure", "malformed", "incomplete", "transport"])("fails and cleans up a %s response", async mode => {
    transport.script = async output => {
      if (mode === "transport") throw new Error("fixture transport failure");
      output("stdout", mode === "malformed" ? "not json\n" : encode(init));
      if (mode === "failure") output("stdout", encode({ event: "result", result: { status: "ERROR", error: "fixture CLI failure" } }));
    };
    expect((await collect(adapter.run(input()))).at(-1)).toMatchObject({ type: "done", ok: false });
    expect(transport.removed).toHaveLength(1);
  });
});

describe("Gemini workflow boundaries", () => {
  it("finishes a coding task and opens its PR while explanations queue behind Gemini chat", async () => {
    vi.stubEnv("AGENT_HUB_EXPLAIN_AGENT", undefined);
    let finish!: () => void;
    transport.script = async output => {
      if (transport.args.length === 1) await new Promise<void>(resolve => { finish = resolve; });
      const prompt = promptOf(transport.args.at(-1)!);
      output("stdout", encode(init, result(JSON.stringify({ hunks: [...prompt.matchAll(/^Hunk id: (.+)$/gm)]
        .map(m => ({ id: JSON.parse(m[1]!), explanation: "Explains the change." })) }))));
    };
    const repo = path.join(root, "repo");
    fs.mkdirSync(repo);
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo });
    git("init", "-q", "-b", "main"); git("config", "user.email", "fixture@example.invalid"); git("config", "user.name", "Fixture");
    fs.writeFileSync(path.join(repo, "README.md"), "Fixture\n"); git("add", "."); git("commit", "-qm", "base");
    const claude = new FakeAdapter(i => briefingFixture(i) ?? [
      { type: "write", path: "new.txt", content: "new content\n" }, { type: "text_delta", text: "Done" }, { type: "done", ok: true },
    ]);
    const forge = { repoOf: async () => "example/project", push: vi.fn(async () => {}),
      openPullRequest: vi.fn(async () => ({ number: 1, url: "https://example.invalid/pr/1", state: "open" as const })),
      state: vi.fn(async () => "open" as const), close: vi.fn(async () => {}), listIssues: vi.fn(async () => []), readIssue: vi.fn(async (): Promise<never> => { throw new Error("unused"); }) };
    const hub = new Hub({ db, dataDir: root, maxConcurrent: 4, agents: { claude, gemini: adapter }, forge });
    hubs.push(hub);
    try {
      const chat = await hub.createTask({ title: "Chat", workflow: "chat", agent: "gemini", message: "private chat" });
      await vi.waitFor(() => expect(transport.args).toHaveLength(1));
      const task = await hub.createTask({ title: "Add file", workflow: "implement", agent: "claude", repoPath: repo, message: "Add a file" });
      await vi.waitFor(() => expect(hub.getTask(task.id).sessions).toContainEqual(expect.objectContaining({ role: "explainer", status: "running" })));
      expect(hub.getTask(task.id).status).toBe("idle");
      expect(hub.isBusy(task.id)).toBe(false);
      expect(await hub.explanations(task.id)).toMatchObject({ generating: true, event: null });
      expect(await hub.openPr(task.id)).toMatchObject({ number: 1 });
      expect(transport.args).toHaveLength(1);
      finish();
      await Promise.all([hub.settled(chat.id), hub.settled(task.id)]);
      expect((await hub.explanations(task.id)).event).toMatchObject({ writtenBy: "gemini", items: [{ path: "new.txt" }] });
      expect(promptOf(transport.args[1]!)).not.toContain("private chat");
    } finally { finish?.(); vi.unstubAllEnvs(); }
  });

  it("reconstructs the first turn from persisted events for the second prompt, without CLI resume", async () => {
    const hub = makeHub();
    const task = await hub.createTask({ title: "", workflow: "chat", agent: "gemini", message: "remember this first message" });
    await hub.settled(task.id);
    hub.sendMessage(task.id, "second question");
    await hub.settled(task.id);
    expect(hub.getTask(task.id).status).toBe("idle");
    expect(promptOf(transport.args[1]!)).toContain('"type":"user_message","text":"remember this first message"');
    expect(promptOf(transport.args[1]!)).toContain('"type":"agent_text","text":"reply"');
    expect(promptOf(transport.args[1]!)).toContain("Current user message:\n\nsecond question");
    expect(promptOf(transport.args[1]!)).not.toContain("diagnostic-id");
    expect(transport.args[1]).not.toContain("--resume");
    expect((await hub.quota()).gemini).toMatchObject({ status: "unknown", windows: [] });
  });

  it.each(["before-first-output", "during-stream"])("keeps the completed reply when the next inputs arrive %s", async timing => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    transport.script = async output => {
      output("stdout", encode(init));
      if (transport.signals.length === 1) {
        if (timing === "during-stream") output("stdout", encode(step({ text_delta: "first reply " })));
        await gate;
        output("stdout", encode(step({ text_delta: timing === "during-stream" ? "completed" : "first reply completed" }), result("first reply completed")));
      } else output("stdout", encode(result("second reply")));
    };
    const hub = makeHub();
    const task = await hub.createTask({ title: "", workflow: "chat", agent: "gemini", message: "first request" });
    await vi.waitFor(() => expect(transport.signals).toHaveLength(1));
    hub.sendMessage(task.id, "second request");
    hub.sendMessage(task.id, "third request");
    release();
    await hub.settled(task.id);

    expect(transport.args).toHaveLength(2);
    const [history, current] = promptOf(transport.args[1]!).split("Current user message:\n\n");
    expect(history).toContain('"type":"user_message","text":"first request"');
    expect(history).toContain('"type":"agent_text","text":"first reply completed"');
    expect(history).not.toContain("second request");
    expect(history).not.toContain("third request");
    expect(current).toBe("second request\n\nthird request");
    expect(hub.getTask(task.id).status).toBe("idle");
  });

  it("replays persisted dialogue through a new Hub and adapter after restart", async () => {
    const hub = makeHub();
    const task = await hub.createTask({ title: "", workflow: "chat", agent: "gemini", message: "persist this request" });
    await hub.settled(task.id);
    await hub.shutdown(50);
    adapter = new GeminiAdapter({ dataDir: root, transport });
    const restarted = makeHub();
    restarted.sendMessage(task.id, "after restart");
    await restarted.settled(task.id);
    expect(promptOf(transport.args[1]!)).toContain("persist this request");
    expect(promptOf(transport.args[1]!)).toContain('"text":"reply"');
  });

  it("rejects image uploads with HTTP 400 before creating or queuing a turn", async () => {
    const hub = makeHub();
    const images = [{ mime: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==" }];
    const app = createApp(hub, "token");
    const headers = { Authorization: "Bearer token", "Content-Type": "application/json" };
    const rejected = await app.request("/api/tasks", { method: "POST", headers, body: JSON.stringify({ title: "", workflow: "chat", agent: "gemini", message: "picture", images }) });
    expect(rejected.status).toBe(400);
    expect(await rejected.text()).toContain("does not support images");
    expect(hub.listTasks()).toEqual([]);
    const task = await hub.createTask({ title: "", workflow: "chat", agent: "gemini", message: "text only" });
    await hub.settled(task.id);
    expect(() => hub.sendMessage(task.id, "picture", images)).toThrow(/does not support images/);
    expect(hub.events(task.id).filter(e => e.type === "user_message")).toHaveLength(1);
  });

  it("bounds persisted history to six user turns and 24000 text characters", () => {
    const history = Array.from({ length: 20 }, (_, i) => ({ id: `e${i}`, taskId: "task", seq: i + 1, sessionId: "session", createdAt: "", type: i % 2 ? "agent_text" : "user_message", text: `${i}:` + "x".repeat(2200) }) as TaskEvent);
    const recent = geminiRecent(history);
    expect(recent[0]!.seq).toBeGreaterThanOrEqual(9);
    expect(recent.filter(e => e.type === "user_message").length).toBeLessThanOrEqual(6);
    expect(recent.reduce((n, e) => n + e.text.length, 0)).toBeLessThanOrEqual(24000);
    expect(recent.at(-1)!.seq).toBe(20);
  });

  it.each(["implement", "review", "plan", "video"] as WorkflowId[])("rejects Gemini %s tasks with HTTP 400 before running anything", async workflow => {
    const hub = makeHub();
    const response = await createApp(hub, "token").request("/api/tasks", { method: "POST", headers: { Authorization: "Bearer token", "Content-Type": "application/json" }, body: JSON.stringify({ title: "", workflow, agent: "gemini", message: "work", repoPath: root }) });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("chat only");
    expect(transport.args).toEqual([]);
    await expect(hub.createTask({ title: "", workflow: "review", reviewer: "gemini", message: "review", repoPath: root })).rejects.toMatchObject({ status: 400 });
  });

  it("rejects plan switches to Gemini and chat handoffs without invoking it as a summary writer", async () => {
    const hub = makeHub();
    const repo = path.join(root, "repo");
    fs.mkdirSync(repo);
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo });
    git("init", "-q");
    git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-qm", "fixture");
    const plan = await hub.createTask({ title: "", workflow: "plan", agent: "codex", message: "hello", repoPath: repo });
    await hub.settled(plan.id);
    const response = await createApp(hub, "token").request(`/api/tasks/${plan.id}/switch-agent`, { method: "POST", headers: { Authorization: "Bearer token", "Content-Type": "application/json" }, body: JSON.stringify({ target: "gemini", expectedSessionId: plan.sessions[0]!.id }) });
    expect(response.status).toBe(400);
    const chat = await hub.createTask({ title: "", workflow: "chat", agent: "gemini", message: "hello" });
    await hub.settled(chat.id);
    expect(() => hub.switchAgent(chat.id, { target: "codex", expectedSessionId: chat.sessions[0]!.id })).toThrow(/handoff is unavailable/);
    expect(transport.args).toHaveLength(1);
  });

  it("never selects Gemini for PR text, briefings, handoffs or general quota fallback", async () => {
    const agents = configuredAgents({ gemini: adapter, claude: {}, codex: {} });
    expect(agents).toEqual(["claude", "codex"]);
    const run = vi.fn(async () => "unexpected");
    await expect(withAgentFallback("gemini", ["gemini", ...agents], { quota: async () => undefined }, new AbortController().signal, run)).rejects.toThrow(/chat only/);
    expect(run).not.toHaveBeenCalled();
    expect(transport.args).toEqual([]);
  });

  it.each(["result", "stdout", "stderr"] as const)("pauses the task through the existing usage-limit classifier from %s", async channel => {
    transport.script = async output => output(channel === "result" ? "stdout" : channel,
      channel === "result" ? encode(init, { event: "result", result: { status: "ERROR", error: "Gemini usage limit reached" } }) : "Gemini usage limit reached\n");
    const hub = makeHub();
    const task = await hub.createTask({ title: "", workflow: "chat", agent: "gemini", message: "hello" });
    await hub.settled(task.id);
    expect(hub.getTask(task.id)).toMatchObject({ status: "paused", options: { quotaPause: { agent: "gemini", resetsAt: null } } });
    expect(transport.removed).toHaveLength(1);
  });

  it.each(["missing-home", "empty-home", "seed-only", "no-docker", "daemon-x64", "host-x64", "symlink"])("omits the adapter for %s without starting a container", async mode => {
    if (mode === "missing-home") fs.rmSync(home, { recursive: true });
    if (mode === "empty-home" || mode === "seed-only") fs.rmSync(path.join(home, ".gemini/oauth_creds.json"));
    if (mode === "seed-only") fs.writeFileSync(path.join(home, ".gemini/settings.json"), "{}");
    if (mode === "no-docker" || mode === "daemon-x64") transport.available.mockResolvedValue(false);
    if (mode === "symlink") { fs.rmSync(home, { recursive: true }); fs.symlinkSync(os.tmpdir(), home); }
    expect(await availableGemini({ dataDir: root, transport, arch: mode === "host-x64" ? "x64" : "arm64" })).toBeUndefined();
    expect(transport.args).toEqual([]);
    const hub = makeHub(false);
    expect((await hub.models()).gemini).toBeUndefined();
    expect((await hub.quota()).gemini).toBeUndefined();
    await expect(hub.createTask({ title: "", workflow: "chat", agent: "gemini", message: "hello" })).rejects.toMatchObject({ status: 400 });
  });

  it("registers when credentials and ARM64 Docker are present, with no model call", async () => {
    expect(await availableGemini({ dataDir: root, transport, arch: "arm64" })).toBeInstanceOf(GeminiAdapter);
    expect(transport.cleanup).toHaveBeenCalledOnce();
    expect(transport.args).toEqual([]);
    expect((await makeHub().models()).gemini).toEqual([]);
  });
});
