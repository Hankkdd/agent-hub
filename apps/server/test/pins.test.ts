import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { StreamMessage, Task } from "@agent-hub/shared";
import { FakeAdapter } from "../src/agents/fake";
import { Hub } from "../src/core/hub";
import { briefingContextIdentity } from "../src/core/briefing";
import { TaskListProjection } from "../src/core/task-list";
import { createApp } from "../src/app";
import { openDb, schema, type Db } from "../src/db/index";
import { briefingFixture } from "./briefing-fixture";

let root: string;
let db: Db;
let hub: Hub;
let fake: FakeAdapter;
let hubs: Hub[];
const headers = { Authorization: "Bearer pin-test", "Content-Type": "application/json" };
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "hub-pins-"));
  db = openDb(path.join(root, "hub.db"));
  fake = new FakeAdapter();
  hub = new Hub({ db, dataDir: root, agents: { claude: fake, codex: fake }, maxConcurrent: 4 });
  hubs = [hub];
});
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(hubs.map((h) => h.shutdown(100)));
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});
function seed(id = "task", options: Task["options"] = {}, status: Task["status"] = "idle") {
  db.insert(schema.tasks).values({ id, title: id, workflow: options.reportsTo ? "review" : "plan", status, options,
    createdAt: "2020-01-01T00:00:00.000Z", updatedAt: "2020-01-01T00:00:00.000Z" }).run();
  return hub.getTask(id);
}
const pins = (id: string) => hub.events(id).filter((e) => e.type === "pin_changed");
const request = (id: string, body: string, auth = true) => createApp(hub, "pin-test").request(`/api/tasks/${id}/pin`, { method: "POST", headers: auth ? headers : {}, body });

it("requires authentication and exactly one explicit boolean, rejects missing/deleted tasks", async () => {
  seed();
  expect((await request("task", '{"pinned":true}', false)).status).toBe(401);
  for (const body of ["{", "null", "[]", "true", "{}", '{"pinned":1}', '{"pinned":"true"}', '{"pinned":null}', '{"pinned":true,"pinnedAt":"caller"}', '{"pinned":false,"project":"other"}']) {
    expect((await request("task", body)).status).toBe(400);
  }
  expect(pins("task")).toEqual([]);
  expect((await request("missing", '{"pinned":true}')).status).toBe(404);
  expect((await request("task", '{"pinned":true}')).status).toBe(200);
  await hub.deleteTask("task");
  expect((await request("task", '{"pinned":false}')).status).toBe(404);
  expect(hub.listTasks()).toEqual([]);
});

it("preserves all other fields and old tasks, publishes only committed projections and retries exactly", () => {
  const original = seed("task", { reportsTo: "parent", repoSettings: { base: "origin/main" }, testCommand: "exit 0", scopeEstimate: { maxFiles: 5 }, findingProject: "/example/common", findingExport: { owner: "Owner", documentsDir: "/example/docs" } });
  expect(original.options.pinnedAt).toBeUndefined();
  const messages: StreamMessage[] = [];
  hub.subscribe((message) => {
    messages.push(message);
    expect(hub.getTask("task").options.pinnedAt).toBe(pins("task").at(-1)?.pinnedAt ?? undefined);
  });
  const first = hub.setPinned("task", true);
  expect(first).toEqual({ ...original, options: { ...original.options, pinnedAt: expect.any(String) } });
  expect(hub.setPinned("task", true)).toEqual(first);
  expect(pins("task")).toHaveLength(1);
  expect(messages.map((m) => m.type)).toEqual(["event", "task"]);
  expect(hub.setPinned("task", false)).toEqual(original);
  hub.setPinned("task", false);
  expect(pins("task")).toHaveLength(2);
  expect(fake.runs).toEqual([]);
  expect(db.select().from(schema.queuedMessages).all()).toEqual([]);
  expect(hub.events("task").map((e) => e.type)).toEqual(["pin_changed", "pin_changed"]);
});

it("serializes duplicate/opposite requests, allocates append positions even at equal or rolled-back clock time", async () => {
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-01-01T00:00:00.000Z"));
  seed("a"); seed("b");
  await Promise.all([request("a", '{"pinned":true}'), request("a", '{"pinned":true}'), request("b", '{"pinned":true}')]);
  const a = hub.getTask("a").options.pinnedAt!;
  const b = hub.getTask("b").options.pinnedAt!;
  expect(a < b).toBe(true);
  expect(pins("a")).toHaveLength(1);
  await Promise.all([request("a", '{"pinned":false}'), request("a", '{"pinned":true}'), request("a", '{"pinned":true}')]);
  expect(pins("a")).toHaveLength(3);
  expect(hub.getTask("a").options.pinnedAt! > b).toBe(true);
  hub.setPinned("b", false);
  vi.mocked(Date.now).mockReturnValue(1);
  expect(hub.setPinned("b", true).options.pinnedAt! > hub.getTask("a").options.pinnedAt!).toBe(true);
});

it("rolls back both event and projection on failure and publishes nothing", () => {
  const original = seed();
  const listener = vi.fn(); hub.subscribe(listener);
  db.run(sql`CREATE TRIGGER reject_pin BEFORE UPDATE OF options ON tasks BEGIN SELECT RAISE(ABORT, 'injected failure'); END`);
  expect(() => hub.setPinned("task", true)).toThrow("injected failure");
  expect(pins("task")).toEqual([]);
  expect(hub.getTask("task")).toEqual(original);
  expect(listener).not.toHaveBeenCalled();
  db.run(sql`DROP TRIGGER reject_pin`);
  hub.setPinned("task", true);
  expect(pins("task")).toHaveLength(1);
});

it("reopens durable pins with a fresh database/Hub and exposes compact reads without transcript discovery", async () => {
  seed("parent"); seed("child", { reportsTo: "parent" }); seed("old");
  hub.setPinned("child", true); hub.setPinned("parent", true); hub.setPinned("parent", false);
  const fresh = new Hub({ db: openDb(path.join(root, "hub.db")), dataDir: root, maxConcurrent: 4, agents: { claude: fake } }); hubs.push(fresh);
  fresh.recoverInterrupted();
  expect(fresh.listTasks()).toEqual(hub.listTasks());
  for (const task of fresh.listTasks()) expect(task.options.pinnedAt).toBe(pins(task.id).at(-1)?.pinnedAt ?? undefined);
  const response = await createApp(fresh, "pin-test").request("/api/task-list", { headers });
  const body = await response.json() as { tasks: Task[] };
  expect(body.tasks.find((t) => t.id === "child")!.options.pinnedAt).toBe(hub.getTask("child").options.pinnedAt);
  expect(fake.runs).toEqual([]);
});

it.each(["idle", "running", "waiting_user", "failed", "interrupted", "done"] as const)("pins %s tasks with no worktree without changing workflow evidence or readiness", async (status) => {
  const before = seed("task", {}, status);
  const identity = briefingContextIdentity(before, hub.events(before.id));
  const projection = new TaskListProjection(hub, vi.fn());
  await projection.list();
  const readEvents = vi.spyOn(hub, "events");
  const pinned = hub.setPinned("task", true);
  expect(await projection.update({ type: "task", task: pinned })).toBeNull();
  expect(readEvents).not.toHaveBeenCalled();
  expect(briefingContextIdentity(pinned, hub.events(before.id))).toBe(identity);
  expect(hub.setPinned("task", false)).toEqual(before);
  expect(fake.runs).toEqual([]);
});

it("keeps an actual running session and approval intact", async () => {
  const agent = new FakeAdapter(() => [{ type: "thread", threadId: "active" }, { type: "ask", toolName: "Bash", input: "example" }, { type: "done", ok: true }]);
  agent.hold();
  const active = new Hub({ db, dataDir: root, agents: { claude: agent }, maxConcurrent: 4 }); hubs.push(active);
  const task = await active.createTask({ workflow: "chat", agent: "claude", title: "Active", message: "Run" });
  await vi.waitFor(() => expect(agent.runs).toHaveLength(1));
  const running = active.getTask(task.id);
  expect(running.status).toBe("running");
  active.setPinned(task.id, true);
  agent.release();
  await vi.waitFor(() => expect(active.getTask(task.id).status).toBe("waiting_user"));
  const waiting = active.getTask(task.id);
  const ask = active.events(task.id).find((e) => e.type === "waiting_user")!;
  active.setPinned(task.id, false);
  expect(active.getTask(task.id)).toEqual({ ...waiting, options: {} });
  expect(active.events(task.id).find((e) => e.id === ask.id)).toEqual(ask);
  expect(agent.decisions).toEqual([]);
  active.answer(task.id, ask.id, "Allow");
  await active.settled(task.id);
  expect(agent.runs).toHaveLength(1);
  expect(db.select().from(schema.queuedMessages).all()).toEqual([]);
});

it("keeps a surviving orphan's pin after parent deletion and never inherits pins", async () => {
  seed("parent"); hub.setPinned("parent", true);
  expect(seed("child", { reportsTo: "parent" }).options.pinnedAt).toBeUndefined();
  const child = hub.setPinned("child", true);
  hub.setPinned("parent", false);
  expect(hub.getTask("child")).toEqual(child);
  hub.setPinned("parent", true);
  await hub.deleteTask("parent");
  expect(hub.getTask("child")).toEqual(child);
  await hub.deleteTask("child");
  expect(hub.listTasks()).toEqual([]);
  expect(() => hub.setPinned("child", true)).toThrow(/no task/);
});

it("preserves a current #47 briefing and exact PR confirmation without model, Git or forge work on pin", async () => {
  const repo = path.join(root, "repo"); fs.mkdirSync(repo);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.invalid");
  fs.writeFileSync(path.join(repo, "README.md"), "Fixture\n"); git("add", "."); git("commit", "-qm", "base");
  fs.writeFileSync(path.join(root, "repos.json"), JSON.stringify({ [repo]: { prLanguage: "en" } }));
  const agent = new FakeAdapter((input) => briefingFixture(input) ?? (input.toolsDisabled
    ? [{ type: "text_delta", text: input.systemPrompt?.includes("metadata") ? JSON.stringify({ type: "feat", summary: "Add answer", slug: "add-answer", body: "Add answer." }) : '{"hunks":[]}' }, { type: "done", ok: true }]
    : [{ type: "write", path: "answer.ts", content: "export const answer = 42;\n" }, { type: "done", ok: true }]));
  const forge = { repoOf: vi.fn(async () => "example/project"), push: vi.fn(async () => {}), openPullRequest: vi.fn(async () => ({ number: 1, url: "https://example.invalid/pr/1", state: "open" as const })), state: vi.fn(async () => "open" as const), close: vi.fn(async () => {}), listIssues: vi.fn(async () => []), readIssue: vi.fn(async () => { throw new Error("unused"); }) };
  const workerHub = new Hub({ db, dataDir: root, agents: { codex: agent }, maxConcurrent: 4, forge }); hubs.push(workerHub);
  const parent = seed("planner"); workerHub.setPinned(parent.id, true);
  // Use the normal proposal dispatch path, without invoking an MCP/model tool.
  db.insert(schema.events).values({ id: "proposal", taskId: parent.id, sessionId: null, seq: 2, type: "task_proposal", payload: { title: "Answer", spec: "Add answer" }, createdAt: new Date().toISOString() }).run();
  const task = await workerHub.createTask({ workflow: "implement", agent: "codex", title: "Answer", message: "Add answer", repoPath: repo, fromProposal: { taskId: parent.id, eventId: "proposal" } });
  await workerHub.settled(task.id);
  expect(task.options.reportsTo).toBe(parent.id);
  expect(task.options.pinnedAt).toBeUndefined();
  const draft = await workerHub.preparePrDraft(task.id);
  const before = workerHub.getTask(task.id);
  const briefing = await workerHub.briefing(task.id);
  expect(briefing.state).toBe("current");
  const runs = agent.runs.length;
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: task.cwd!, encoding: "utf8" });
  workerHub.setPinned(task.id, true); workerHub.setPinned(task.id, false);
  expect(workerHub.getTask(task.id)).toEqual(before);
  expect(await workerHub.briefing(task.id)).toEqual(briefing);
  expect(agent.runs).toHaveLength(runs);
  expect(forge.push).not.toHaveBeenCalled(); expect(forge.openPullRequest).not.toHaveBeenCalled();
  expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: task.cwd!, encoding: "utf8" })).toBe(head);
  expect(workerHub.events(task.id).filter((e) => e.type.startsWith("finding_"))).toEqual([]);
  const confirmation = { draftId: draft.id, branch: draft.branch, commitMessage: draft.commitMessage, title: draft.title, body: draft.body };
  await expect(workerHub.openPr(task.id, { ...confirmation, draftId: "wrong" })).rejects.toThrow(/out of date/i);
  // Existing confirmation remains accepted; only this explicit command can publish.
  await workerHub.openPr(task.id, confirmation);
  expect(forge.openPullRequest).toHaveBeenCalledTimes(1);
});

it("broadcasts durable pin updates and deletion on two authenticated SSE streams without opening transcripts", async () => {
  seed();
  const app = createApp(hub, "pin-test");
  const connect = async () => {
    const response = await app.request("/api/stream", { headers });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    return { reader, next: async (): Promise<StreamMessage> => {
      while (!buffer.includes("\n\n")) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error("stream ended");
        buffer += decoder.decode(chunk.value);
      }
      const end = buffer.indexOf("\n\n");
      const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
      return JSON.parse(frame.replace(/^data: /, "")) as StreamMessage;
    } };
  };
  const devices = await Promise.all([connect(), connect()]);
  try {
    for (const device of devices) expect(await device.next()).toEqual({ type: "hello" });
    const pinned = hub.setPinned("task", true);
    for (const device of devices) {
      expect(await device.next()).toMatchObject({ type: "event", event: { type: "pin_changed", pinnedAt: pinned.options.pinnedAt } });
      expect(await device.next()).toEqual({ type: "task", task: pinned });
    }
    hub.setPinned("task", false);
    for (const device of devices) {
      expect(await device.next()).toMatchObject({ type: "event", event: { type: "pin_changed", pinnedAt: null } });
      expect(await device.next()).toMatchObject({ type: "task", task: { options: {} } });
    }
    await hub.deleteTask("task");
    for (const device of devices) expect(await device.next()).toEqual({ type: "task_deleted", taskId: "task" });
    expect(fake.runs).toEqual([]);
  } finally {
    await Promise.all(devices.map((d) => d.reader.cancel()));
  }
});
