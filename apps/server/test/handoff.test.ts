import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { activeMainSession, type TaskEvent, type Task, type AgentKind } from "@agent-hub/shared";
import { Hub } from "../src/core/hub";
import { createApp } from "../src/app";
import { openDb, schema, type Db } from "../src/db/index";
import { FakeAdapter } from "../src/agents/fake";
import { captureHandoff, validateHandoff, handoffIdentity, deliverHandoff } from "../src/core/handoff";
import { historicalImage, saveImages, attachmentsDir } from "../src/core/attachments";

let root: string, db: Db, hub: Hub;
let codex: FakeAdapter, claude: FakeAdapter, gemini: FakeAdapter;
const summary = { goals: "目標 #1", decisions: "已同意 #1", constraints: "範圍限制 #1", completed: "完成證據 #1", pending: "待辦 #1", uncertainty: "推論與待驗證 #1", references: [1] };
const script = (i: { toolsDisabled?: boolean; prompt: string }, n: number) => i.toolsDisabled
  ? [{ type: "text_delta" as const, text: JSON.stringify(summary) }, { type: "done" as const, ok: true }]
  : [{ type: "thread" as const, threadId: `sdk-${n}` }, { type: "text_delta" as const, text: `reply ${i.prompt}` }, { type: "done" as const, ok: true }];
const current = (id: string) => activeMainSession(hub.getTask(id))!;
const switchTo = (id: string, target: AgentKind) => hub.switchAgent(id, { target, expectedSessionId: current(id).id });
const tick = () => new Promise((r) => setTimeout(r, 5));
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "hub-handoff-")); db = openDb(path.join(root, "hub.db"));
  codex = new FakeAdapter(script); claude = new FakeAdapter(script);
  gemini = new FakeAdapter(() => { throw new Error("Gemini must never generate handoff summaries"); });
  hub = new Hub({ db, dataDir: root, maxConcurrent: 4, agents: { codex, claude, gemini }, flushMs: 1 });
});
afterEach(async () => { vi.useRealTimers(); await hub.shutdown(100); expect(gemini.runs).toEqual([]); vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });
async function task(workflow: "chat" | "plan" = "chat", agent: AgentKind = "codex") {
  const repo = path.join(root, "repo");
  if (workflow === "plan" && !fs.existsSync(repo)) {
    fs.mkdirSync(repo);
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  }
  const t = await hub.createTask({ title: "Handoff fixture", workflow, agent, message: "Original agreement", repoPath: workflow === "plan" ? repo : undefined });
  await hub.settled(t.id); return hub.getTask(t.id);
}
function event(id: string, seq: number, payload: object) {
  db.insert(schema.events).values({ id: `event-${seq}`, taskId: id, seq, sessionId: null, createdAt: "2026-01-01", type: (payload as { type: string }).type, payload }).run();
}

it.each(["chat", "plan"] as const)("%s switches both ways through fresh sessions without target work or losing history/pins", async (workflow) => {
  const t = await task(workflow); const first = current(t.id); hub.setPinned(t.id, true);
  const pinned = hub.getTask(t.id).options.pinnedAt;
  await switchTo(t.id, "claude"); const second = current(t.id);
  expect(second).toMatchObject({ agent: "claude", sdkThreadId: null }); expect(second.id).not.toBe(first.id); expect(claude.runs).toHaveLength(0);
  expect(codex.runs.at(-1)).toMatchObject({ readOnly: true, toolsDisabled: true, model: undefined });
  for (const key of ["threadId", "images", "mcp", "referenceDirs", "askPermission"] as const) expect(codex.runs.at(-1)![key]).toBeUndefined();
  expect(codex.runs.at(-1)!.systemPrompt).toContain("Traditional Chinese");
  expect(hub.events(t.id).filter((e) => e.type === "turn_result")).toHaveLength(1);
  hub.sendMessage(t.id, "New request"); await hub.settled(t.id);
  const input = claude.runs[0]!; expect(input.threadId).toBeUndefined();
  expect(input.prompt.indexOf("Historical peer context")).toBeLessThan(input.prompt.indexOf("Recent original dialogue"));
  expect(input.prompt.indexOf("Recent original dialogue")).toBeLessThan(input.prompt.lastIndexOf("New request"));
  expect(input.prompt).toContain('"sessionId":"'+first.id+'"');
  if (workflow === "plan") { expect(input.readOnly).toBe(true); expect(input.systemPrompt).toContain("propose_task"); }
  hub.sendMessage(t.id, "Later"); await hub.settled(t.id); expect(claude.runs[1]!.prompt).not.toContain("Historical peer context");
  await switchTo(t.id, "codex"); const third = current(t.id); expect(third.id).not.toBe(first.id);
  hub.sendMessage(t.id, "Return"); await hub.settled(t.id); expect(codex.runs.at(-1)!.threadId).toBeUndefined();
  expect(hub.getTask(t.id).sessions.find((s) => s.id === first.id)!.sdkThreadId).toBe(first.sdkThreadId);
  expect(hub.getTask(t.id).sessions).toHaveLength(3); expect(hub.getTask(t.id).options.pinnedAt).toBe(pinned);
});

it("writes the summary with the destination when the source agent is out of quota", async () => {
  const reset = new Date(Date.now() + 3_600_000).toISOString();
  codex.quotaScript = async () => ({ status: "ok", windows: [{ id: "main", bucket: "Main", durationMins: 300, remainingPercent: 0, resetsAt: reset }] });
  const t = await task();
  const codexSummaries = codex.runs.filter((r) => r.toolsDisabled).length;
  await switchTo(t.id, "claude");
  expect(codex.runs.filter((r) => r.toolsDisabled).length).toBe(codexSummaries);
  expect(claude.runs.filter((r) => r.toolsDisabled)).toHaveLength(1);
  expect(current(t.id).agent).toBe("claude");
  expect(hub.events(t.id).some((e) => e.type === "handoff_completed")).toBe(true);
});

it("starts with Claude and isolates its summary too", async () => {
  const t = await task("chat", "claude"); await switchTo(t.id, "codex");
  expect(claude.runs.at(-1)).toMatchObject({ toolsDisabled: true, readOnly: true });
  expect(claude.runs.at(-1)!.threadId).toBeUndefined();
  expect(codex.runs).toHaveLength(0);
});

it("validates auth, exact inputs, missing tasks, unchanged/unconfigured backends and stale sessions before any model call", async () => {
  const t = await task(); const app = createApp(hub, "test-token");
  const request = (body: string, auth = true, id = t.id) => app.request(`/api/tasks/${id}/switch-agent`, { method: "POST", headers: auth ? { Authorization: "Bearer test-token", "Content-Type": "application/json" } : {}, body });
  expect((await request("{}", false)).status).toBe(401);
  for (const body of ["{", "null", "[]", '"x"', "{}", '{"target":"other","expectedSessionId":"x"}', '{"target":"claude","expectedSessionId":1}', '{"target":"claude","expectedSessionId":"x","path":"/tmp"}']) expect((await request(body)).status).toBe(400);
  const valid = JSON.stringify({ target: "claude", expectedSessionId: current(t.id).id });
  expect((await request(valid, true, "missing")).status).toBe(404);
  expect(() => switchTo(t.id, "codex")).toThrow(/other backend/);
  expect(() => hub.switchAgent(t.id, { target: "claude", expectedSessionId: "stale" })).toThrow(/changed/);
  const unavailable = new Hub({ db, dataDir: root, maxConcurrent: 4, agents: { codex } });
  expect(() => unavailable.switchAgent(t.id, JSON.parse(valid))).toThrow(/unavailable/);
  db.update(schema.tasks).set({ options: { activeMainSessionId: "invalid" } }).where(eq(schema.tasks.id, t.id)).run();
  expect(activeMainSession(hub.getTask(t.id))).toBeUndefined(); expect(() => hub.switchAgent(t.id, JSON.parse(valid))).toThrow(/changed/);
  expect(codex.runs).toHaveLength(1); await unavailable.shutdown(10);
});

it.each(["implement", "review", "video", "custom"])("rejects unsupported %s without a call", async (workflow) => {
  const t = await task(); db.update(schema.tasks).set({ workflow }).where(eq(schema.tasks.id, t.id)).run();
  expect(() => switchTo(t.id, "claude")).toThrow(/Only chat and plan/); expect(codex.runs).toHaveLength(1);
});

it("coalesces duplicate clients, rejects opposite operations and merges pin updates atomically", async () => {
  const t = await task(); const source = current(t.id).id; codex.hold();
  const a = switchTo(t.id, "claude"), b = switchTo(t.id, "claude"); expect(a).toBe(b); await tick();
  expect(() => switchTo(t.id, "codex")).toThrow(/Conflicting/);
  hub.setPinned(t.id, true); const pin = hub.getTask(t.id).options.pinnedAt;
  codex.release(); await a;
  expect(hub.getTask(t.id).options.pinnedAt).toBe(pin);
  await hub.switchAgent(t.id, { target: "claude", expectedSessionId: source });
  expect(hub.getTask(t.id).sessions).toHaveLength(2); expect(codex.runs).toHaveLength(2);
  expect(hub.events(t.id).filter((e) => e.type === "handoff_completed")).toHaveLength(1);
});

it("new messages invalidate capture without consuming input, and other tasks keep running", async () => {
  const t = await task(); codex.hold(); const done = switchTo(t.id, "claude"); await tick();
  hub.sendMessage(t.id, "Changed agreement");
  const other = await task("chat", "claude"); expect(claude.runs).toHaveLength(1);
  expect(other.id).not.toBe(t.id); codex.release(); await expect(done).rejects.toThrow(/source changed/); await hub.settled(t.id);
  expect(current(t.id).agent).toBe("codex"); expect(codex.runs.at(-1)!.prompt).toBe("Changed agreement");
  expect(hub.events(t.id).find((e) => e.type === "user_message" && e.text === "Changed agreement")).not.toHaveProperty("queued");
});

it.each(["stop", "shutdown", "timeout"])("%s interrupts a reserved summary without a target session or false turn results", async (action) => {
  const t = await task(); codex.hold(); const before = hub.events(t.id).filter((e) => e.type === "turn_result").length;
  if (action === "timeout") vi.useFakeTimers();
  const done = switchTo(t.id, "claude"); const rejected = expect(done).rejects.toThrow();
  if (action === "timeout") await vi.advanceTimersByTimeAsync(1); else await tick();
  if (action === "stop") hub.stop(t.id);
  else if (action === "shutdown") await hub.shutdown(100);
  else { await vi.advanceTimersByTimeAsync(120001); vi.useRealTimers(); }
  await rejected; expect(current(t.id).agent).toBe("codex"); expect(hub.getTask(t.id).sessions).toHaveLength(1);
  expect(hub.events(t.id).filter((e) => e.type === "turn_result")).toHaveLength(before);
  expect(hub.events(t.id).at(-1)).toMatchObject({ type: "handoff_failed", interrupted: true });
});

it.each(["not json", JSON.stringify({ ...summary, references: [999] }), JSON.stringify({ ...summary, goals: "English only" }), "x".repeat(12001)])("rejects malformed/bounded summaries", async (text) => {
  const t = await task(); const bad = new FakeAdapter(() => [{ type: "text_delta", text }, { type: "done", ok: true }]);
  const h = new Hub({ db, dataDir: root, maxConcurrent: 4, agents: { codex: bad, claude } });
  await expect(h.switchAgent(t.id, { target: "claude", expectedSessionId: current(t.id).id })).rejects.toThrow();
  expect(current(t.id).agent).toBe("codex"); expect(hub.getTask(t.id).sessions).toHaveLength(1); await h.shutdown(10);
});

it("compacts repeated specs and tool evidence in long conversations, saying what was cut", async () => {
  const t = await task(); const history = hub.events(t.id);
  const base = { taskId: t.id, sessionId: null, createdAt: "2026-01-01" };
  const spec = "agreed spec ".repeat(1500);
  const long: TaskEvent[] = [...history];
  for (let i = 0; i < 12; i++) {
    const seq = 1000 + i * 3;
    long.push({ ...base, id: `p${i}`, seq, type: "task_proposal", title: `Proposal ${i}`, spec } as TaskEvent);
    long.push({ ...base, id: `r${i}`, seq: seq + 1, type: "task_report", prompt: spec, report: { taskId: `w${i}`, title: `Worker ${i}`, outcome: "ready",
      finalSeq: 1, rounds: 1, lastVerdict: "approve", findings: [], test: "passed", filesChanged: 1, additions: 1, deletions: 0, branch: "b" } } as TaskEvent);
    long.push({ ...base, id: `c${i}`, seq: seq + 2, type: "tool_call", callId: `c${i}`, name: "shell", input: "x".repeat(5000), output: "y".repeat(5000),
      sideEffect: "read", pending: false } as unknown as TaskEvent);
  }
  const { input } = captureHandoff(t, long, root);
  expect(input.length).toBeLessThanOrEqual(200000);
  const parsed = JSON.parse(input) as { compaction?: string; events: { type: string; promptOmission?: string; spec?: string }[] };
  expect(parsed.compaction).toMatch(/^Level [1-4]:/);
  expect(parsed.events.find((e) => e.type === "task_report")?.promptOmission).toMatch(/omitted by handoff compaction/);
  expect(parsed.events.find((e) => e.type === "task_proposal")?.spec).toMatch(/characters omitted by handoff compaction/);
  // Dialogue is never compacted: a single oversized user message still refuses the handoff.
  expect(() => captureHandoff(t, [...long, { ...history[0], text: "x".repeat(200001) } as TaskEvent], root)).toThrow(/even after compaction/);
});

it("source input/scan limits fail explicitly and selectors never choose arbitrary historical sessions", async () => {
  const t = await task(); const history = hub.events(t.id);
  expect(() => captureHandoff(t, [...history, { ...history[0], text: "x".repeat(200001) } as TaskEvent], root)).toThrow(/200000/);
  expect(() => captureHandoff(t, Array(10001).fill(history[0]), root)).toThrow(/10000/);
  expect(validateHandoff(JSON.stringify(summary), history)).toEqual(summary);
  expect(activeMainSession({ ...t, sessions: [...t.sessions, { ...t.sessions[0]!, id: "another" }] })).toBeUndefined();
});

it("activation rolls back both destination session and link and emits no uncommitted completed event", async () => {
  const t = await task(); const seen: TaskEvent[] = [];
  const unsubscribe = hub.subscribe((m) => { if (m.type === "event") seen.push(m.event); });
  const original = db.transaction.bind(db);
  vi.spyOn(db, "transaction").mockImplementation(((fn: () => unknown) => original(() => { const result = fn(); if (db.select().from(schema.events).all().some(e => e.type === "handoff_completed")) throw new Error("rollback fixture"); return result; })) as unknown as typeof db.transaction);
  await expect(switchTo(t.id, "claude")).rejects.toThrow(/rollback/);
  expect(hub.getTask(t.id).sessions).toHaveLength(1); expect(current(t.id).agent).toBe("codex");
  expect(seen.some((e) => e.type === "handoff_completed")).toBe(false); unsubscribe();
});

it("restart projects incomplete operations as interrupted, preserves a committed selection and never generates automatically", async () => {
  const t = await task(); const first = current(t.id);
  event(t.id, hub.events(t.id).at(-1)!.seq + 1, { type: "handoff_started", operationId: "incomplete", sourceSessionId: first.id, sourceBackend: first.agent, target: "claude", sourceFrom: 1, sourceTo: 3, sourceIdentity: "identity" });
  hub.recoverInterrupted(); expect(hub.events(t.id).at(-1)).toMatchObject({ type: "handoff_failed", interrupted: true }); expect(codex.runs).toHaveLength(1);
  await switchTo(t.id, "claude"); const selected = current(t.id).id;
  expect(hub.usageCalls(t.id).calls.filter(c => c.purpose === "handoff_summary")).toMatchObject([
    { provider: "codex", sessionId: null, role: "auxiliary" },
  ]);

  const restart = new Hub({ db, dataDir: root, agents: { codex, claude }, maxConcurrent: 4 }); restart.recoverInterrupted();
  expect(activeMainSession(restart.getTask(t.id))!.id).toBe(selected); expect(claude.runs).toHaveLength(0); await restart.shutdown(10);
});

it.each([false, true])("failed first input (thread emitted: %s) preserves handoff for explicit next input, then stops injecting", async (thread) => {
  const t = await task(); const failed = new FakeAdapter((i, n) => n === 1 ? [...(thread ? [{ type: "thread" as const, threadId: "partial" }] : []), { type: "done", ok: false, error: "fixture failure" }] : script(i, n));
  const h = new Hub({ db, dataDir: root, maxConcurrent: 4, agents: { codex, claude: failed } });
  await h.switchAgent(t.id, { target: "claude", expectedSessionId: current(t.id).id });
  for (const text of ["first actual request", "explicit retry", "later"]) { h.sendMessage(t.id, text); await h.settled(t.id); }
  expect(failed.runs[0]!.prompt).toContain("Historical peer context"); expect(failed.runs[1]!.prompt).toContain("Historical peer context"); expect(failed.runs[2]!.prompt).not.toContain("Historical peer context");
  expect(failed.runs[1]!.prompt).toContain("first actual request"); expect(failed.runs[1]!.prompt).toContain("never a new request to replay work"); await h.shutdown(10);
});

const png = { mime: "image/png" as const, data: Buffer.from([137,80,78,71,13,10,26,10,0]).toString("base64") };
it("carries actual same-task images with new input priority, records attribution and revalidates missing files", async () => {
  const t = await task(); hub.sendMessage(t.id, "Image agreement", [png, png, png, png, png, png]); await hub.settled(t.id);
  await switchTo(t.id, "claude");
  const note = hub.events(t.id).find((e) => e.type === "handoff_completed")!;
  if (note.type !== "handoff_completed") throw new Error("missing note");
  const missing = note.material.images[5]!;
  fs.unlinkSync(path.join(attachmentsDir(root, t.id), missing.attachment.file));
  hub.sendMessage(t.id, "Current image", [png, png]); await hub.settled(t.id);
  expect(claude.runs[0]!.images).toHaveLength(6);
  const delivery = hub.events(t.id).filter((e) => e.type === "handoff_delivery").at(-1)!;
  expect(delivery).toMatchObject({ delivered: true });
  if (delivery.type !== "handoff_delivery") throw new Error("missing delivery");
  expect(delivery.images.filter((i) => i.reason === "unavailable")).toHaveLength(1);
  expect(delivery.images.filter((i) => i.reason === "current_input_priority")).toHaveLength(1);
  expect(claude.runs[0]!.prompt).toContain(missing.attachment.file); expect(claude.runs[0]!.prompt).toContain('"reason":"unavailable"');
  expect(fs.readdirSync(t.cwd!)).toEqual([]);
});

it("rejects historical path tricks, cross-task aliases, symlinks, special and corrupted files", async () => {
  const t = await task(); const [a] = saveImages(root, t.id, [png]); const dir = attachmentsDir(root, t.id); const file = path.join(dir, a!.file);
  expect(historicalImage(root, t.id, a!)).toBe(file);
  expect(historicalImage(root, t.id, { ...a!, file: `../${a!.file}` })).toBeNull();
  expect(historicalImage(root, "other-task", a!)).toBeNull();
  const alias = path.join(root, "other-image"); fs.linkSync(file, alias);
  expect(historicalImage(root, t.id, a!)).toBeNull(); fs.unlinkSync(alias);
  fs.unlinkSync(file); fs.symlinkSync(path.join(root, "hub.db"), file); expect(historicalImage(root, t.id, a!)).toBeNull();
  fs.unlinkSync(file); execFileSync("mkfifo", [file]); expect(historicalImage(root, t.id, a!)).toBeNull();
  fs.unlinkSync(file); fs.writeFileSync(file, Buffer.alloc(a!.size)); expect(historicalImage(root, t.id, a!)).toBeNull();
  fs.rmSync(dir, { recursive: true }); const other = attachmentsDir(root, "other-task"); fs.mkdirSync(other); fs.symlinkSync(other, dir); expect(historicalImage(root, t.id, a!)).toBeNull();
});

it("text selection is verbatim and explicit, newest images win and prior summaries do not recursively duplicate", async () => {
  const t = await task();
  for (let i = 0; i < 8; i++) { hub.sendMessage(t.id, `turn ${i}`, [png]); await hub.settled(t.id); }
  await switchTo(t.id, "claude");
  const note = hub.events(t.id).find((e) => e.type === "handoff_completed")!;
  if (note.type !== "handoff_completed") throw new Error("missing note");
  expect(note.material.recent.filter((e) => e.type === "user_message")).toHaveLength(6);
  expect(note.material.images.filter((e) => !e.reason)).toHaveLength(6); expect(note.material.images.filter((e) => e.reason === "older")).toHaveLength(2);
  const input = captureHandoff(hub.getTask(t.id), hub.events(t.id), root).input;
  expect(input).toContain('"previous":'); expect(input).not.toContain('"material":');
  const facts = handoffIdentity(hub.getTask(t.id), hub.events(t.id)); hub.setPinned(t.id, true);
  expect(handoffIdentity(hub.getTask(t.id), hub.events(t.id))).toBe(facts);
  const selected = deliverHandoff(note.material, root, t.id, 6); expect(selected.files).toHaveLength(0);
});

it("busy/queued turns, pending permissions, unavailable source and full concurrency reject without summary calls", async () => {
  const t = await task(); codex.hold(); hub.sendMessage(t.id, "running"); await tick(); hub.sendMessage(t.id, "queued");
  expect(() => switchTo(t.id, "claude")).toThrow(/Stop or finish/); codex.release(); await hub.settled(t.id);
  event(t.id, 20, { type: "waiting_user", prompt: "Permission?", options: ["Allow", "Deny"] });
  expect(() => switchTo(t.id, "claude")).toThrow(/permission/);
  db.delete(schema.events).where(eq(schema.events.id, "event-20")).run();
  const h = new Hub({ db, dataDir: root, maxConcurrent: 4, agents: { claude } });
  expect(() => h.switchAgent(t.id, { target: "claude", expectedSessionId: current(t.id).id })).toThrow(/unavailable/); await h.shutdown(10);
  const limited = new Hub({ db, dataDir: root, maxConcurrent: 0, agents: { codex, claude } });
  expect(() => limited.switchAgent(t.id, { target: "claude", expectedSessionId: current(t.id).id })).toThrow(/slots/); await limited.shutdown(10);
  expect(codex.runs.some((r) => r.toolsDisabled)).toBe(false);
});

it.each(["ask", "report", "child", "delete"])("%s state changed during summary prevents stale activation", async (change) => {
  const t = await task(); codex.hold(); const done = switchTo(t.id, "claude"); const rejected = expect(done).rejects.toThrow(); await tick();
  if (change === "ask") event(t.id, 20, { type: "ask", question: "Updated decision?" });
  else if (change === "report") event(t.id, 20, { type: "task_report", report: { taskId: "child", finalSeq: 1, outcome: "ready" } });
  else if (change === "child") db.insert(schema.tasks).values({ id: "child", title: "Child", workflow: "review", status: "idle", options: { reportsTo: t.id }, createdAt: "", updatedAt: "" }).run();
  else { db.delete(schema.tasks).where(eq(schema.tasks.id, t.id)).run(); }
  codex.release(); await rejected;
  expect(db.select().from(schema.sessions).all().filter((s) => s.taskId === t.id)).toHaveLength(1);
});

it("failed generation without done and explicit backend errors retain source, never writing SDK thread provenance", async () => {
  const t = await task(); const first = current(t.id);
  for (const script of [() => [{ type: "thread" as const, threadId: "isolated-thread" }], () => [{ type: "done" as const, ok: false, error: "summary backend unavailable" }]]) {
    const h = new Hub({ db, dataDir: root, maxConcurrent: 4, agents: { codex: new FakeAdapter(script), claude } });
    await expect(h.switchAgent(t.id, { target: "claude", expectedSessionId: first.id })).rejects.toThrow();
    expect(current(t.id)).toEqual(first); await h.shutdown(10);
  }
});

it.each(["continue", "restart"] as const)("%s after a first-target interruption uses active session with handoff provenance", async (action) => {
  const t = await task(); await switchTo(t.id, "claude"); const selected = current(t.id).id;
  claude.hold(); hub.sendMessage(t.id, "actual target request"); await tick(); await hub.shutdown(100);
  const restart = new Hub({ db, dataDir: root, maxConcurrent: 4, agents: { codex, claude } }); restart.recoverInterrupted(); claude.release();
  restart.recover(t.id, action); await restart.settled(t.id);
  expect(activeMainSession(restart.getTask(t.id))!.id).toBe(selected);
  expect(claude.runs.at(-1)!.prompt).toContain("Historical peer context");
  expect(claude.runs.at(-1)!.prompt).toContain("actual target request");
  if (action === "restart") expect(claude.runs.at(-1)!.threadId).toBeUndefined();
  expect(codex.runs).toHaveLength(2); await restart.shutdown(10);
});

it("recent oversized/budget entries and duplicate or oversized image metadata have explicit omissions", async () => {
  const t = await task(); const [a] = saveImages(root, t.id, [png]);
  const base = hub.events(t.id)[0]!;
  const original = { ...base, id: "huge", seq: 4, type: "user_message" as const, text: "x".repeat(24001), images: [a!] };
  const middle = { ...base, id: "middle", seq: 5, type: "user_message" as const, text: "y".repeat(15000), images: [a!] };
  const newest = { ...base, id: "newest", seq: 6, type: "user_message" as const, text: "z".repeat(15000), images: [a!, a!, { ...a!, file: "invalid.png", size: 11 * 1048576 }] };
  const { material } = captureHandoff(t, [base, original, middle, newest], root);
  expect(material.recentOmissions).toContainEqual({ seq: 4, reason: "oversized" });
  expect(material.recentOmissions).toContainEqual({ seq: 5, reason: "budget" });
  expect(material.recent.at(-1)!.text).toBe(newest.text);
  expect(material.images.filter((i) => !i.reason)).toHaveLength(1);
  expect(material.images.some((i) => i.reason === "excess")).toBe(true);
  expect(material.images.some((i) => i.reason === "unavailable")).toBe(true);
});

it("successful target results without an SDK thread never discard context for a later fresh call", async () => {
  const t = await task(); const noThread = new FakeAdapter(() => [{ type: "done", ok: true }]);
  const h = new Hub({ db, dataDir: root, maxConcurrent: 4, agents: { codex, claude: noThread } });
  await h.switchAgent(t.id, { target: "claude", expectedSessionId: current(t.id).id });
  h.sendMessage(t.id, "First request"); await h.settled(t.id); h.sendMessage(t.id, "Another fresh request"); await h.settled(t.id);
  expect(noThread.runs.every((r) => r.prompt.includes("Historical peer context"))).toBe(true); await h.shutdown(10);
});
