import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StreamMessage, Task, TaskListSummary } from "@agent-hub/shared";

const task: Task = { id: "plan", title: "Plan", workflow: "plan", status: "idle", activity: null, cwd: null, workspace: null, options: {}, sessions: [], createdAt: "", updatedAt: "" };
const summary: TaskListSummary = { taskId: task.id, project: { id: "/repos/example", name: "example" }, pendingAsk: true, awaitingAcceptance: false };
let list = { tasks: [task], summaries: [summary] };
let source: TestSource;
let requests: string[];
class TestSource {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  constructor() { source = this; }
  close() {}
  send(message: StreamMessage) { this.onmessage?.({ data: JSON.stringify(message) }); }
}
beforeEach(() => {
  vi.resetModules();
  requests = [];
  list = { tasks: [task], summaries: [summary] };
  vi.stubGlobal("location", { href: "http://example.invalid/" });
  vi.stubGlobal("EventSource", TestSource);
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    requests.push(url);
    return { status: 200, ok: true, json: async () => url === "/api/task-list" ? list : [] };
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe("compact task-list client", () => {
  it("loads decisions before opening any transcript, applies patches and removes deleted summaries", async () => {
    const { client } = await import("./client");
    await vi.waitFor(() => expect(client.taskSummaries()).toEqual([summary]));
    expect(requests).toEqual(["/api/task-list"]);
    source.send({ type: "event", event: { id: "ask", taskId: task.id, sessionId: null, seq: 1, createdAt: "", type: "ask", question: "Choose" } });
    source.send({ type: "task_summary", summary: { ...summary, pendingAsk: false } });
    expect(client.taskSummaries()[0]!.pendingAsk).toBe(false);
    expect(requests).toEqual(["/api/task-list"]);
    source.send({ type: "task_deleted", taskId: task.id });
    expect(client.taskSummaries()).toEqual([]);
    expect(client.listTasks()).toEqual([]);
    source.send({ type: "task_summary", summary });
    expect(client.taskSummaries()).toEqual([]);
  });

  it("rebuilds summaries on reconnect and still fetches transcripts only on demand", async () => {
    const { client } = await import("./client");
    await vi.waitFor(() => expect(client.listTasks()).toHaveLength(1));
    source.onopen?.();
    list = { tasks: [task], summaries: [{ ...summary, pendingAsk: false }] };
    source.onerror?.();
    source.onopen?.();
    await vi.waitFor(() => expect(client.taskSummaries()[0]!.pendingAsk).toBe(false));
    expect(requests.every((url) => url === "/api/task-list")).toBe(true);
    client.events(task.id);
    await vi.waitFor(() => expect(requests).toContain(`/api/tasks/${task.id}/events`));
    source.send({ type: "event", event: { id: "text", taskId: task.id, sessionId: null, seq: 2, createdAt: "", type: "agent_text", text: "Live transcript" } });
    expect(client.events(task.id)).toMatchObject([{ type: "agent_text", text: "Live transcript" }]);
  });

  it("replays streamed decisions and deletions after an older reconnect snapshot", async () => {
    const { client } = await import("./client");
    await vi.waitFor(() => expect(client.taskSummaries()).toEqual([summary]));
    let deliver!: (value: unknown) => void;
    const pending = new Promise((resolve) => { deliver = resolve; });
    vi.stubGlobal("fetch", vi.fn(async () => ({ status: 200, ok: true, json: () => pending })));
    source.onopen?.();
    source.send({ type: "task_summary", summary: { ...summary, pendingAsk: false } });
    deliver(list);
    await vi.waitFor(() => expect(client.taskSummaries()[0]!.pendingAsk).toBe(false));
    let deliverDeleted!: (value: unknown) => void;
    const deleting = new Promise((resolve) => { deliverDeleted = resolve; });
    vi.stubGlobal("fetch", vi.fn(async () => ({ status: 200, ok: true, json: () => deleting })));
    source.onopen?.();
    source.send({ type: "task_deleted", taskId: task.id });
    deliverDeleted(list);
    await vi.waitFor(() => expect(client.listTasks()).toEqual([]));
    expect(client.taskSummaries()).toEqual([]);
  });

});

describe("server-owned pins", () => {
  it("loads pins before transcripts and converges two unopened clients from the same stream, including deletion", async () => {
    list = { tasks: [{ ...task, options: { pinnedAt: "2026-01-01" } }], summaries: [summary] };
    const { client: desktop } = await import("./client");
    await vi.waitFor(() => expect(desktop.listTasks()[0]!.options.pinnedAt).toBe("2026-01-01"));
    const desktopSource = source;
    vi.resetModules();
    const { client: phone } = await import("./client");
    await vi.waitFor(() => expect(phone.listTasks()).toEqual(desktop.listTasks()));
    const phoneSource = source;
    for (const target of [desktopSource, phoneSource]) {
      target.send({ type: "event", event: { id: "pin", type: "pin_changed", taskId: task.id, sessionId: null, seq: 1, createdAt: "", pinnedAt: null } });
      target.send({ type: "task", task });
    }
    expect(desktop.listTasks()).toEqual(phone.listTasks());
    expect(phone.listTasks()[0]!.options.pinnedAt).toBeUndefined();
    expect(requests).toEqual(["/api/task-list", "/api/task-list"]);
    for (const target of [desktopSource, phoneSource]) target.send({ type: "task_deleted", taskId: task.id });
    expect(desktop.listTasks()).toEqual([]); expect(phone.listTasks()).toEqual([]);
  });

  it("replays pin changes over an older reconnect snapshot without recency comparisons", async () => {
    const { client } = await import("./client");
    await vi.waitFor(() => expect(client.listTasks()).toHaveLength(1));
    let deliver!: (value: unknown) => void;
    const pending = new Promise((resolve) => { deliver = resolve; });
    vi.stubGlobal("fetch", vi.fn(async () => ({ status: 200, ok: true, json: () => pending })));
    source.onopen?.();
    const pinned = { ...task, options: { pinnedAt: "2026-01-01" } };
    source.send({ type: "task", task: pinned });
    deliver(list);
    await vi.waitFor(() => expect(client.listTasks()[0]).toEqual(pinned));
    expect(client.listTasks()[0]!.updatedAt).toBe(task.updatedAt);
  });

  it("uses an explicit-state command and never overwrites streamed lifecycle, newer pins or deletion with a delayed response", async () => {
    const { client } = await import("./client");
    await vi.waitFor(() => expect(client.listTasks()).toHaveLength(1));
    let deliver!: (value: unknown) => void;
    const response = new Promise((resolve) => { deliver = resolve; });
    const fetch = vi.fn(async () => ({ status: 200, ok: true, json: () => response }));
    vi.stubGlobal("fetch", fetch);
    const pending = client.setPinned(task.id, true);
    expect(fetch).toHaveBeenCalledWith(`/api/tasks/${task.id}/pin`, expect.objectContaining({ method: "POST", body: '{"pinned":true}' }));
    const newer = { ...task, status: "running" as const, options: { pinnedAt: "2026-01-03" } };
    source.send({ type: "task", task: newer });
    deliver({ ...task, options: { pinnedAt: "2026-01-01" } });
    await pending;
    expect(client.listTasks()[0]).toEqual(newer);
    const deleting = client.setPinned(task.id, false);
    source.send({ type: "task_deleted", taskId: task.id });
    await deleting;
    expect(client.listTasks()).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("reports failed commands without inventing persisted state or fetching transcripts", async () => {
    const { client } = await import("./client");
    await vi.waitFor(() => expect(client.listTasks()).toHaveLength(1));
    vi.stubGlobal("fetch", vi.fn(async () => ({ status: 500, ok: false, json: async () => ({ error: "failure" }) })));
    await expect(client.setPinned(task.id, true)).rejects.toThrow("failure");
    expect(client.listTasks()).toEqual([task]);
    expect(requests).toEqual(["/api/task-list"]);
  });
});

it("handoff responses cannot overwrite a newer active session; SSE and reconnect converge over plain HTTP", async () => {
  const first = { ...task, options: { activeMainSessionId: "source", pinnedAt: "2026-01-01" } };
  list = { tasks: [first], summaries: [summary] };
  const { client } = await import("./client");
  await vi.waitFor(() => expect(client.listTasks()).toHaveLength(1));
  let respond!: (task: Task) => void;
  const response = new Promise<Task>((resolve) => { respond = resolve; });
  const fetcher = vi.fn(async (url: string, options?: { body?: string }) => {
    if (url.endsWith("/switch-agent")) { expect(JSON.parse(options!.body!)).toEqual({ target: "claude", expectedSessionId: "source" }); return { ok: true, status: 200, json: () => response }; }
    return { ok: true, status: 200, json: async () => list };
  });
  vi.stubGlobal("fetch", fetcher);
  const switching = client.switchAgent(task.id, { target: "claude", expectedSessionId: "source" });
  const newer = { ...first, options: { ...first.options, activeMainSessionId: "newer" } };
  source.send({ type: "task", task: newer }); respond({ ...first, options: { ...first.options, activeMainSessionId: "intermediate" } });
  await switching; expect(client.listTasks()[0]!.options.activeMainSessionId).toBe("newer");
  list = { tasks: [newer], summaries: [summary] }; source.onerror?.(); source.onopen?.();
  await vi.waitFor(() => expect(client.listTasks()[0]!.options).toEqual(newer.options));
  expect(client.listTasks()).toHaveLength(1); expect(client.listTasks()[0]!.options.pinnedAt).toBe(first.options.pinnedAt);
});

describe("requirements comment commands and event races", () => {
  const draft = { id: "draft-event", taskId: task.id, sessionId: null, seq: 2, createdAt: "", type: "issue_comment_draft" as const,
    draftId: "draft", revision: 1, proposalId: "proposal", sourceIdentity: "source", sourceReference: "plan/proposal", repo: "example/project",
    issue: { number: 7, title: "Issue", url: "https://github.com/example/project/issues/7" }, operationId: "operation", content: "Public summary", body: "Public summary + protected footer", bodyIdentity: "body" };
  it("sends only a saved version to confirm; late command responses cannot overwrite newer streamed revisions or task state", async () => {
    const { client } = await import("./client");
    await vi.waitFor(() => expect(client.listTasks()).toHaveLength(1));
    client.events(task.id); await vi.waitFor(() => expect(requests).toContain(`/api/tasks/${task.id}/events`));
    source.send({ type: "event", event: draft });
    let resolve!: (value: unknown) => void;
    const pending = new Promise((r) => { resolve = r; });
    const fetcher = vi.fn(async (_url: string, _input: RequestInit) => ({ status: 200, ok: true, json: () => pending }));
    vi.stubGlobal("fetch", fetcher);
    const command = client.issueComment(task.id, "confirm", { draftId: draft.draftId, revision: 1 });
    expect(fetcher).toHaveBeenCalledWith(`/api/tasks/${task.id}/issue-comment/confirm`, expect.objectContaining({ method: "POST", body: JSON.stringify({ draftId: "draft", revision: 1 }) }));
    const newer = { ...draft, id: "new-revision", seq: 4, revision: 2, body: "Latest saved version" };
    source.send({ type: "event", event: newer }); source.send({ type: "task", task: { ...task, options: { pinnedAt: "new-pin", activeMainSessionId: "new-agent" } } });
    resolve(draft); await command;
    expect(client.events(task.id).at(-1)).toEqual(newer);
    expect(client.listTasks()[0]!.options).toEqual({ pinnedAt: "new-pin", activeMainSessionId: "new-agent" });
    expect(fetcher).toHaveBeenCalledTimes(1); // No polling or transcript reload from commands.
  });
  it("retains streamed append-only drafts/outcomes during older reconnect snapshots", async () => {
    const { client } = await import("./client");
    await vi.waitFor(() => expect(client.listTasks()).toHaveLength(1));
    client.events(task.id); await vi.waitFor(() => expect(requests).toContain(`/api/tasks/${task.id}/events`));
    source.send({ type: "event", event: draft });
    let deliver!: (value: unknown) => void;
    const pending = new Promise((r) => { deliver = r; });
    vi.stubGlobal("fetch", vi.fn(async (url: string) => ({ status: 200, ok: true, json: () => url === "/api/task-list" ? list : pending })));
    source.onopen?.();
    await vi.waitFor(() => expect(client.connection()).toBe("live"));
    const newer = { ...draft, id: "saved-new", seq: 4, revision: 2 };
    source.send({ type: "event", event: newer });
    deliver([draft]);
    await vi.waitFor(() => expect(client.events(task.id)).toEqual([draft, newer]));
    expect(client.events(task.id).at(-1)!.seq).toBe(4);
  });
});

it("retains invocation identities through duplicate SSE/reload and sends bounded usage reads", async () => {
  const { client } = await import("./client");
  await vi.waitFor(() => expect(client.listTasks()).toHaveLength(1));
  const event = { id: "usage-final", taskId: task.id, sessionId: null, seq: 2, createdAt: "", type: "invocation_finished", callId: "call" } as import("@agent-hub/shared").TaskEvent;
  client.events(task.id);
  await vi.waitFor(() => expect(requests).toContain(`/api/tasks/${task.id}/events`));
  source.send({ type: "event", event }); source.send({ type: "event", event });
  expect(client.events(task.id).filter(e => e.id === event.id)).toHaveLength(1);
  source.onopen?.(); source.onerror?.(); source.onopen?.();
  await vi.waitFor(() => expect(requests.filter(r => r === `/api/tasks/${task.id}/events`).length).toBeGreaterThan(1));
  source.send({ type: "event", event }); source.send({ type: "event", event });
  expect(client.events(task.id).filter(e => e.id === event.id)).toHaveLength(1);
  await client.usageSummary(task.id); await client.usageCalls(task.id, 2);
  expect(requests).toContain(`/api/tasks/${task.id}/usage`);
  expect(requests).toContain(`/api/tasks/${task.id}/usage/calls?after=2&limit=20`);
});
