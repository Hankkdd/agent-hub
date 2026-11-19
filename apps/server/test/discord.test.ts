import type { TaskEvent, TaskReport, Workspace } from "@agent-hub/shared";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeAdapter } from "../src/agents/fake";
import { Hub } from "../src/core/hub";
import { openDb, type Db } from "../src/db/index";
import * as video from "../src/media/video";
import { notifyDiscord } from "../src/notify/discord";

// Deliberately nonfunctional placeholders, never a real webhook or token.
const webhook = "https://discord.com/api/webhooks/<webhook-id>/<webhook-token>";
const chat = { title: "Example task", workflow: "chat" as const, agent: "claude" as const, message: "hello" };
let root: string;
let db: Db;
let hubs: Hub[];
let send: ReturnType<typeof vi.fn<typeof fetch>>;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-hub-discord-"));
  db = openDb(":memory:");
  hubs = [];
  send = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
});

afterEach(async () => {
  await Promise.all(hubs.map((hub) => hub.shutdown(50)));
  fs.rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function makeHub(agent = new FakeAdapter(), reviewer = new FakeAdapter()): Hub {
  const hub = new Hub({ db, dataDir: root, maxConcurrent: 4, flushMs: 1, agents: { claude: agent, codex: reviewer } });
  hubs.push(hub);
  return hub;
}

function payload(index = 0) {
  return JSON.parse(send.mock.calls[index]![1]!.body as string);
}

function makeRepo(): string {
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Test");
  fs.writeFileSync(path.join(repo, "README.md"), "example\n");
  git("add", ".");
  git("commit", "-qm", "initial fixture");
  return repo;
}

describe("Discord notifications", () => {
  it("sends a loud approval notification with only the configured user allowed to ping", async () => {
    const hub = makeHub(new FakeAdapter(() => [{ type: "ask", toolName: "Bash", input: "test command" }, { type: "done", ok: true }]));
    notifyDiscord(hub, { webhook, mention: "1", publicUrl: "http://tailnet-host.invalid:8080/hub", fetch: send });
    const task = await hub.createTask(chat);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(hub.getTask(task.id).status).toBe("waiting_user");
    expect(payload()).toEqual({
      content: `<@1> 需要你處理\n任務：Example task\n原因：Needs your approval: Bash\n說明：hello\n開啟：http://tailnet-host.invalid:8080/hub?task=${task.id}`,
      allowed_mentions: { parse: [], users: ["1"] },
    });
    const request = hub.events(task.id).find((event) => event.type === "waiting_user")!;
    hub.answer(task.id, request.id, "Allow");
    await hub.settled(task.id);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each(["implement", "review"] as const)("sends one silent %s finish and no ping, even with a mention configured", async (workflow) => {
    const author = new FakeAdapter(() => [{ type: "write", path: "result.txt", content: "done\n" }, { type: "done", ok: true }]);
    const reviewer = new FakeAdapter(() => [{ type: "text_start" }, { type: "text_delta", text: "VERDICT: approve\nFINDINGS: none" }, { type: "done", ok: true }]);
    const hub = makeHub(author, reviewer);
    notifyDiscord(hub, { webhook, mention: "1", fetch: send });
    const task = await hub.createTask({ ...chat, workflow, reviewer: "codex", repoPath: makeRepo() });
    await hub.settled(task.id);
    expect(send).toHaveBeenCalledTimes(1);
    expect(payload()).toEqual({
      content: "完成\n任務：Example task\n說明：hello",
      flags: 4096,
      allowed_mentions: { parse: [] },
    });
    // A subsequent idle -> done is the user's merge/discard, not another work finish.
    await hub.discard(task.id);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("sends nothing for a finished chat turn or for subscribing to an already idle task", async () => {
    const hub = makeHub();
    notifyDiscord(hub, { webhook, fetch: send });
    const task = await hub.createTask(chat);
    await hub.settled(task.id);
    notifyDiscord(hub, { webhook, fetch: send });
    expect(send).not.toHaveBeenCalled();
  });

  it("sends a silent video finish without fetching media or contacting a model", async () => {
    vi.spyOn(video, "fetchVideoTranscript").mockResolvedValue({
      meta: { id: "example", title: "Example video", uploader: null, duration: 10, url: "https://example.invalid/video",
        extractor: "Example", language: "en", subtitles: ["en"], autoCaptions: [] },
      source: "subtitles (en)", segments: [], markdown: "Example transcript",
    });
    const hub = makeHub();
    notifyDiscord(hub, { webhook, fetch: send });
    const task = await hub.createTask({ ...chat, workflow: "video", message: "https://example.invalid/video" });
    await hub.settled(task.id);
    expect(hub.getTask(task.id).status).toBe("idle");
    expect(send).toHaveBeenCalledTimes(1);
    expect(payload()).toEqual({ content: "完成\n任務：Example task\n說明：https://example.invalid/video", flags: 4096, allowed_mentions: { parse: [] } });
  });

  it("sends a loud failure without allowing mentions from task text", async () => {
    const hub = makeHub(new FakeAdapter(() => [{ type: "done", ok: false, error: "example failure" }]));
    notifyDiscord(hub, { webhook, fetch: send });
    const task = await hub.createTask({ ...chat, title: "@everyone <@2>" });
    await hub.settled(task.id);
    expect(send).toHaveBeenCalledTimes(1);
    expect(payload()).toEqual({ content: "任務失敗\n任務：@everyone <@2>\n原因：example failure\n說明：hello", allowed_mentions: { parse: [] } });
  });

  it("sends one loud interruption on restart, with its status_change reason", async () => {
    const agent = new FakeAdapter();
    agent.hold();
    const hub = makeHub(agent);
    const task = await hub.createTask(chat);
    await hub.shutdown(50);
    const restarted = makeHub();
    notifyDiscord(restarted, { webhook, fetch: send });
    expect(restarted.recoverInterrupted()).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(payload()).toEqual({
      content: "任務中斷\n任務：Example task\n原因：the server stopped while this turn was running\n說明：hello",
      allowed_mentions: { parse: [] },
    });
    expect(restarted.getTask(task.id).status).toBe("interrupted");
  });

  it("handles explicit status_change events, truncates title/reason, and ignores the matching task update", async () => {
    const hub = makeHub();
    const subscribe = vi.spyOn(hub, "subscribe");
    notifyDiscord(hub, { webhook, fetch: send });
    const task = await hub.createTask({ ...chat, title: "Long title ".repeat(30) });
    await hub.settled(task.id);
    const listener = subscribe.mock.calls[0]![0];
    listener({ type: "event", event: { id: "example-event", taskId: task.id, sessionId: null, seq: 99, createdAt: task.createdAt,
      type: "status_change", from: "running", to: "failed", reason: "Long reason ".repeat(300) } });
    listener({ type: "task", task: { ...hub.getTask(task.id), status: "failed" } });
    expect(send).toHaveBeenCalledTimes(1);
    expect(payload().content).toContain("Long title");
    expect(payload().content).toContain("Long reason");
    expect(payload().content.split("\n").find((line: string) => line.startsWith("原因：")).length).toBe(303);
    expect(payload().content).toContain("…");
    expect(payload().content.length).toBeLessThan(2000);
  });

  async function planningNotification(publicUrl?: string, title = "Example plan") {
    const hub = makeHub();
    const task = await hub.createTask({ ...chat, workflow: "plan", title, repoPath: makeRepo() });
    await hub.settled(task.id);
    const subscribe = vi.spyOn(hub, "subscribe");
    notifyDiscord(hub, { webhook, publicUrl, fetch: send });
    const listener = subscribe.mock.calls[0]![0];
    const emit = (event: TaskEvent) => listener({ type: "event", event });
    const envelope = { id: "example-event", taskId: task.id, sessionId: null, seq: 99, createdAt: task.createdAt };
    return { hub, task, emit, envelope };
  }

  it("shows the plan title and only the first paragraph of an ask", async () => {
    const { emit, envelope } = await planningNotification();
    emit({ ...envelope, type: "ask", question: "First line\r\n  continued\r\n  \r\nPrivate context", options: [] });
    expect(payload()).toEqual({
      content: "需要你決定\n任務：Example plan\n問題：First line continued",
      allowed_mentions: { parse: [] },
    });
  });

  it("shows a proposal separately from its plan title", async () => {
    const { emit, envelope } = await planningNotification();
    emit({ ...envelope, type: "task_proposal", title: "Proposed\n work", spec: "Example spec" });
    expect(payload().content).toBe("規劃完成，等你確認\n任務：Example plan\n提案：Proposed work");
  });

  it.each(["passed", "failed", "none"] as const)("summarizes a report with %s tests and links to the plan", async (test) => {
    const { hub, task, emit, envelope } = await planningNotification("http://tailnet-host.invalid:8080/hub?view=tasks&task=old#details");
    const report: TaskReport = {
      taskId: "example-worker", title: "Example worker", outcome: "ready", finalSeq: 5,
      rounds: 2, lastVerdict: "approve", test, filesChanged: 3, additions: 12, deletions: 4, branch: "example-branch",
      findings: test === "failed" ? [{ severity: "low", location: "example.ts:1", message: "Example finding" }] : [],
      pr: { number: 9, url: "https://example.invalid/pull/9" },
    };
    vi.spyOn(hub, "listTasks").mockReturnValue([task, { ...task, id: report.taskId, workspace: exampleWorkspace() }]);
    const reportEvent: TaskEvent = { ...envelope, type: "task_report", report };
    vi.spyOn(hub, "events").mockReturnValue([reportEvent]);
    emit(reportEvent);
    expect(send).not.toHaveBeenCalled();
    emit({ ...envelope, id: "turn-end", type: "plan_turn_end", reports: [envelope.id] });
    const result = { passed: "測試通過", failed: "測試失敗", none: "未執行測試" }[test];
    expect(payload().content).toBe(`任務完成，等你確認\n任務：Example worker\n結果：審查 2 輪・${result}・3 個檔案 +12 −4${test === "failed" ? "・1 項審查意見" : ""}\nPR：https://example.invalid/pull/9\n開啟：http://tailnet-host.invalid:8080/hub?view=tasks&task=${task.id}#details`);
  });

  it.each([true, false])("uses the worker workspace PR for reports and tolerates a missing worker (%s)", async (exists) => {
    const { hub, task, emit, envelope } = await planningNotification();
    const worker = { ...task, id: "example-worker", workspace: exampleWorkspace() };
    vi.spyOn(hub, "listTasks").mockReturnValue(exists ? [task, worker] : [task]);
    const report: TaskReport = {
      taskId: worker.id, title: "Example worker", outcome: "ready", finalSeq: 5,
      rounds: 1, lastVerdict: "approve", test: "none", filesChanged: 0, additions: 0, deletions: 0,
      branch: "example-branch", findings: [],
    };
    const reportEvent: TaskEvent = { ...envelope, type: "task_report", report };
    vi.spyOn(hub, "events").mockReturnValue([reportEvent]);
    emit({ ...envelope, type: "plan_turn_end", reports: [envelope.id] });
    expect(payload().content.includes("\nPR：https://example.invalid/pull/10")).toBe(exists);
  });

  function exampleWorkspace(): Workspace {
    return { id: "example-workspace", repoPath: root, worktreePath: root, branch: "example-branch",
      baseRef: "main", baseSha: "example-sha", state: "active",
      pr: { number: 10, url: "https://example.invalid/pull/10", state: "open" } };
  }

  it.each(["invalid-url", "ftp://example.invalid/hub", `https://example.invalid/${"a".repeat(500)}`])("omits an invalid public URL (%s)", async (publicUrl) => {
    const { emit, envelope } = await planningNotification(publicUrl);
    emit({ ...envelope, type: "ask", question: "Example question", options: [] });
    expect(payload().content).toBe("需要你決定\n任務：Example plan\n問題：Example question");
  });

  it("limits long questions and keeps a task link intact when the title exhausts the content budget", async () => {
    const { hub, task, emit, envelope } = await planningNotification("https://example.invalid/hub", "Example plan");
    emit({ ...envelope, type: "ask", question: "\u{1D11E}".repeat(200), options: [] });
    const question = payload().content.split("\n")[2].slice("問題：".length);
    expect(question.length).toBeLessThanOrEqual(300);
    expect(question).toBe(`${"\u{1D11E}".repeat(149)}…`);
    // The same subscription also exercises the overall budget, independent of the question limit.
    const longTitle = "\u{1D11E}".repeat(1500);
    const current = hub.getTask(task.id);
    vi.spyOn(hub, "getTask").mockReturnValue({ ...current, title: longTitle, workspace: exampleWorkspace() });
    emit({ ...envelope, id: "second-ask", type: "ask", question: "Long question ".repeat(300), options: [] });
    const content = payload(1).content;
    expect(content.length).toBeLessThanOrEqual(1999);
    expect(content).toMatch(/…\nPR：https:\/\/example\.invalid\/pull\/10\n開啟：/);
    expect(content.endsWith(`\n開啟：https://example.invalid/hub?task=${task.id}`)).toBe(true);
    expect(content).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
  });

  it("uses the first non-empty line of the first user message, omitting a duplicate title", async () => {
    const hub = makeHub(new FakeAdapter(() => [{ type: "done", ok: false, error: "Example failure" }]));
    notifyDiscord(hub, { webhook, fetch: send });
    const task = await hub.createTask({ ...chat, message: `\n  ${"Description ".repeat(30)}\nOther details` });
    await hub.settled(task.id);
    const description = payload().content.split("\n")[3].slice("說明：".length);
    expect(description.length).toBe(120);
    expect(description.endsWith("…")).toBe(true);
    expect(payload().content).toContain("原因：Example failure");
    const duplicate = await hub.createTask({ ...chat, message: chat.title });
    await hub.settled(duplicate.id);
    expect(payload(1).content).not.toContain("說明：");
  });

  it.each([undefined, "", "   "])("creates no subscription without a webhook (%s)", (value) => {
    const hub = makeHub();
    const subscribe = vi.spyOn(hub, "subscribe");
    expect(notifyDiscord(hub, { webhook: value, fetch: send })).toBeUndefined();
    expect(subscribe).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    "http://discord.com/api/webhooks/<webhook-id>/<webhook-token>",
    "https://discord.com.example.invalid/api/webhooks/<webhook-id>/<webhook-token>",
    "https://discord.com@other.example.invalid/api/webhooks/<webhook-id>/<webhook-token>",
    "https://discord.com/other/<webhook-token>",
    "https://discord.com:444/api/webhooks/<webhook-id>/<webhook-token>",
    "<webhook-url>",
  ])("disables invalid webhooks without logging their value (%s)", (value) => {
    const hub = makeHub();
    const subscribe = vi.spyOn(hub, "subscribe");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(notifyDiscord(hub, { webhook: value, fetch: send })).toBeUndefined();
    expect(subscribe).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledExactlyOnceWith("Discord notifications disabled: invalid webhook URL");
    expect(JSON.stringify(warn.mock.calls)).not.toContain(value);
  });

  it("accepts discordapp.com and can unsubscribe", async () => {
    const hub = makeHub(new FakeAdapter(() => [{ type: "done", ok: false }]));
    const legacy = "https://discordapp.com/api/webhooks/<webhook-id>/<webhook-token>";
    const unsubscribe = notifyDiscord(hub, { webhook: legacy, fetch: send });
    const task = await hub.createTask(chat);
    await hub.settled(task.id);
    expect(send.mock.calls[0]![0]).toBe(legacy);
    unsubscribe!();
    hub.sendMessage(task.id, "again");
    await hub.settled(task.id);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("posts JSON with a 10 second timeout and finishes tasks while delivery is pending", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    let resolve!: (response: Response) => void;
    send.mockImplementation(() => new Promise((r) => { resolve = r; }));
    const hub = makeHub(new FakeAdapter(() => [{ type: "done", ok: false }]));
    notifyDiscord(hub, { webhook, fetch: send });
    const task = await hub.createTask(chat);
    await hub.settled(task.id);
    expect(hub.getTask(task.id).status).toBe("failed");
    expect(timeout).toHaveBeenCalledExactlyOnceWith(10_000);
    expect(send.mock.calls[0]![1]).toMatchObject({ method: "POST", headers: { "Content-Type": "application/json" }, redirect: "manual", signal: expect.any(AbortSignal) });
    resolve(new Response(null, { status: 204 }));
  });

  it.each(["http", "network", "sync", "timeout"])("drops a %s failure with one safe log and no secret", async (failure) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = new Error(`fetch failed for ${webhook}`);
    if (failure === "http") send.mockResolvedValue(new Response(webhook, { status: 429 }));
    else if (failure === "sync") send.mockImplementation(() => { throw error; });
    else send.mockRejectedValue(failure === "timeout" ? new DOMException(webhook, "TimeoutError") : error);
    const hub = makeHub(new FakeAdapter(() => [{ type: "done", ok: false }]));
    notifyDiscord(hub, { webhook, fetch: send });
    const task = await hub.createTask(chat);
    await hub.settled(task.id);
    expect(hub.getTask(task.id).status).toBe("failed");
    expect(send).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledExactlyOnceWith(failure === "http" ? "Discord notification failed: HTTP 429" : "Discord notification failed: no HTTP status");
    expect(JSON.stringify(warn.mock.calls)).not.toContain(webhook);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("<webhook-token>");
  });
});

it.each([null, "today", "tomorrow"])("localizes usage-limit failures with reset %s", async (when) => {
  const reset = new Date();
  reset.setHours(23, 59, 0, 0);
  if (when === "tomorrow") reset.setDate(reset.getDate() + 1);
  const error = "You've hit your usage limit.";
  const agent = new FakeAdapter(() => [{ type: "done", ok: false, error }]);
  if (when) agent.quotaScript = async () => ({ status: "ok", windows: [{ id: "main", bucket: "Main", durationMins: null, remainingPercent: 0, resetsAt: reset.toISOString() }] });
  const hub = makeHub(agent);
  notifyDiscord(hub, { webhook, fetch: send });
  const task = await hub.createTask(chat);
  await hub.settled(task.id);
  expect(send).toHaveBeenCalledTimes(1);
  const date = when === "tomorrow" ? `${reset.getMonth() + 1}/${reset.getDate()} ` : "";
  expect(payload().content).toContain(`原因：Claude 額度已用完，${when ? `約 ${date}23:59 重置` : "重置時間未知"}`);
  expect(payload().content).not.toContain(error);
});

it("keeps a later non-quota failure reason after a usage-limit turn", async () => {
  const hub = makeHub(new FakeAdapter(() => [{ type: "done", ok: false, error: "usage limit" }]));
  const subscribe = vi.spyOn(hub, "subscribe");
  notifyDiscord(hub, { webhook, fetch: send });
  const task = await hub.createTask(chat); await hub.settled(task.id);
  send.mockClear();
  subscribe.mock.calls[0]![0]({ type: "task", task: { ...hub.getTask(task.id), status: "running" } });
  subscribe.mock.calls[0]![0]({ type: "event", event: { id: "later-failure", taskId: task.id, sessionId: null, seq: 99, createdAt: task.createdAt,
    type: "status_change", from: "idle", to: "failed", reason: "Repository check failed" } });
  expect(send).toHaveBeenCalledTimes(1);
  expect(payload().content).toContain("原因：Repository check failed");
  expect(payload().content).not.toContain("額度已用完");
});
