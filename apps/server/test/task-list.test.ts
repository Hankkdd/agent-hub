import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StreamMessage, TaskEvent, TaskListSummary, Workspace } from "@agent-hub/shared";
import { createApp } from "../src/app";
import { FakeAdapter } from "../src/agents/fake";
import { Hub } from "../src/core/hub";
import { discoverProject, TaskListProjection } from "../src/core/task-list";
import { openDb, schema, type Db } from "../src/db/index";
import { eq } from "drizzle-orm";

let root: string;
let repo: string;
let db: Db;
let hub: Hub;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "task-list-"));
  repo = path.join(root, "repository");
  fs.mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
  db = openDb(path.join(root, "hub.db"));
  const fake = new FakeAdapter();
  hub = new Hub({ db, maxConcurrent: 4, dataDir: path.join(root, "data"), agents: { codex: fake, claude: fake }, flushMs: 1 });
});
afterEach(async () => { await hub.shutdown(100); fs.rmSync(root, { recursive: true, force: true }); });
const ask = (taskId: string, extra = {}): TaskEvent => ({ id: "ask", taskId, sessionId: null, seq: 100, createdAt: "", type: "ask", question: "Choose next step", ...extra });
function persist(event: TaskEvent) {
  const { id, taskId, sessionId, seq, createdAt, type, ...payload } = event;
  db.insert(schema.events).values({ id, taskId, sessionId, seq, createdAt, type, payload }).run();
}
async function plan() {
  const task = await hub.createTask({ workflow: "plan", title: "Plan", message: "Discuss", repoPath: repo });
  await hub.settled(task.id);
  return hub.getTask(task.id);
}

describe("read-only task-list projection", () => {
  it("normalizes repository subdirectories and tolerates deleted or invalid paths", async () => {
    const subdir = path.join(repo, "subdir");
    fs.mkdirSync(subdir);
    expect(await discoverProject(subdir)).toEqual({ id: repo, name: "repository" });
    for (const input of [null, "relative", "/invalid\0path", path.join(root, "missing"), root]) expect(await discoverProject(input)).toBeNull();
  });

  it("exposes persisted asks through authenticated reads without opening transcripts, including a fresh Hub", async () => {
    const task = await plan();
    persist(ask(task.id));
    const read = async (reader: Hub) => {
      const app = createApp(reader, "test-token");
      expect((await app.request("/api/task-list")).status).toBe(401);
      const response = await app.request("/api/task-list", { headers: { Authorization: "Bearer test-token" } });
      expect(response.status).toBe(200);
      const body = await response.json() as { summaries: TaskListSummary[] };
      expect(body.summaries).toEqual([{ taskId: task.id, project: { id: repo, name: "repository" }, pendingAsk: true, awaitingAcceptance: false }]);
    };
    await read(hub);
    const fake = new FakeAdapter();
    const fresh = new Hub({ db, maxConcurrent: 4, dataDir: path.join(root, "data"), agents: { codex: fake } });
    await read(fresh);
    for (const payload of [{ question: "Choose", answer: "Continue" }, { question: "Choose", superseded: true }]) {
      db.update(schema.events).set({ payload }).where(eq(schema.events.id, "ask")).run();
      expect((await new TaskListProjection(fresh).list()).summaries[0]!.pendingAsk).toBe(false);
    }
    await fresh.shutdown(100);
  });

  it("updates ask patches, lifecycle/status and deletion but skips text/tool deltas and activity-only tasks", async () => {
    const task = await plan();
    const discover = vi.fn(discoverProject);
    const projection = new TaskListProjection(hub, discover);
    await projection.list();
    const events = vi.spyOn(hub, "events");
    for (let i = 0; i < 20; i++) {
      expect(await projection.update({ type: "event", event: { ...ask(task.id), type: "agent_text", purpose: undefined, text: "delta" } })).toBeNull();
      expect(await projection.update({ type: "event", event: { ...ask(task.id), type: "tool_call", name: "read", input: "", output: undefined, sideEffect: "none" } })).toBeNull();
      expect(await projection.update({ type: "task", task: { ...task, activity: "delta", updatedAt: String(i) } })).toBeNull();
    }
    const pinned = hub.setPinned(task.id, true);
    expect(await projection.update({ type: "task", task: pinned })).toBeNull();
    expect(await projection.update({ type: "event", event: { ...ask(task.id), type: "pin_changed", pinnedAt: pinned.options.pinnedAt! } })).toBeNull();
    expect(events).not.toHaveBeenCalled();
    expect(discover).toHaveBeenCalledTimes(1);
    const pending = ask(task.id);
    persist(pending);
    expect(await projection.update({ type: "event", event: pending })).toMatchObject({ pendingAsk: true });
    db.update(schema.events).set({ payload: { question: "Choose", answer: "Continue" } }).where(eq(schema.events.id, "ask")).run();
    expect(await projection.update({ type: "event", event: ask(task.id, { answer: "Continue" }) })).toMatchObject({ pendingAsk: false });
    await projection.update({ type: "task", task: { ...task, status: "running" } });
    expect(discover).toHaveBeenCalledTimes(1);
    expect(await projection.update({ type: "task_deleted", taskId: task.id })).toBeNull();
    expect(await projection.update({ type: "task", task })).toMatchObject({ taskId: task.id });
  });

  it("projects retained worktree acceptance and published/closed/merged PR changes", async () => {
    const task = await plan();
    const projection = new TaskListProjection(hub);
    const workspace: Workspace = { id: "workspace", repoPath: repo, worktreePath: "/unavailable/worktree", branch: "task", baseRef: "main", baseSha: "sha", state: "active", prDraft: { type: "feat", summary: "Draft", slug: "draft", body: "Draft" } };
    const worker = { ...task, workflow: "review" as const, cwd: workspace.worktreePath, workspace };
    expect(await projection.update({ type: "task", task: worker })).toMatchObject({ awaitingAcceptance: true, project: { id: repo } });
    const published = { ...worker, workspace: { ...workspace, pr: { state: "open" as const, number: 1, url: "https://example.invalid/pr/1" } } };
    expect(await projection.update({ type: "task", task: published })).toMatchObject({ awaitingAcceptance: false });
    expect(await projection.update({ type: "task", task: { ...published, workspace: { ...published.workspace, pr: { ...published.workspace.pr, state: "closed" } } } })).toMatchObject({ awaitingAcceptance: true });
    expect(await projection.update({ type: "task", task: { ...published, workspace: { ...published.workspace, pr: { ...published.workspace.pr, state: "merged" } } } })).toMatchObject({ awaitingAcceptance: false });
    fs.rmSync(repo, { recursive: true });
    expect(await projection.update({ type: "task", task: worker })).toMatchObject({ awaitingAcceptance: true, project: { id: repo } });
  });

  it("adds compact summaries to SSE ask updates and preserves original transcript/deletion messages", async () => {
    const task = await plan();
    let listener: ((m: StreamMessage) => void) | undefined;
    const unsubscribe = vi.fn();
    vi.spyOn(hub, "subscribe").mockImplementation((handler) => { listener = handler; return unsubscribe; });
    const app = createApp(hub, "test-token");
    const response = await app.request("/api/stream", { headers: { Authorization: "Bearer test-token" } });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const next = async (): Promise<StreamMessage> => {
      while (!buffer.includes("\n\n")) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error("stream ended");
        buffer += decoder.decode(chunk.value);
      }
      const end = buffer.indexOf("\n\n");
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      return JSON.parse(frame.replace(/^data: /, "")) as StreamMessage;
    };
    try {
      expect(await next()).toEqual({ type: "hello" });
      const pending = ask(task.id);
      persist(pending);
      listener!({ type: "event", event: pending });
      expect(await next()).toEqual({ type: "event", event: pending });
      expect(await next()).toMatchObject({ type: "task_summary", summary: { pendingAsk: true } });
      db.update(schema.events).set({ payload: { question: "Choose", superseded: true } }).where(eq(schema.events.id, "ask")).run();
      listener!({ type: "event", event: ask(task.id, { superseded: true }) });
      expect(await next()).toMatchObject({ type: "event", event: { superseded: true } });
      expect(await next()).toMatchObject({ type: "task_summary", summary: { pendingAsk: false } });
      listener!({ type: "event", event: { ...pending, type: "agent_text", purpose: undefined, text: "Streaming" } });
      listener!({ type: "task_deleted", taskId: task.id });
      expect(await next()).toMatchObject({ type: "event", event: { type: "agent_text", text: "Streaming" } });
      expect(await next()).toEqual({ type: "task_deleted", taskId: task.id });
    } finally {
      await reader.cancel();
    }
    expect(unsubscribe).toHaveBeenCalled();
  });

});
