import { beforeEach, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeAdapter } from "../src/agents/claude";
import { CodexAdapter } from "../src/agents/codex";
import { claudeResult, codexCumulativeReadings, codexResult } from "./fixtures/usage";
import type { AgentEvent } from "../src/agents/types";
import { Hub } from "../src/core/hub";
import { openDb, schema } from "../src/db";

let messages: unknown[];
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: vi.fn(() => (async function* () { for (const message of messages) yield message; })()) }));
const calls = vi.hoisted(() => ({ start: vi.fn(), resume: vi.fn() }));
vi.mock("@openai/codex-sdk", () => ({ Codex: class { startThread = calls.start; resumeThread = calls.resume; } }));
beforeEach(() => {
  vi.clearAllMocks(); messages = [];
  const runStreamed = async () => ({ events: (async function* () { yield { type: "turn.completed", usage: codexResult }; yield { type: "turn.completed", usage: codexResult }; })() });
  calls.start.mockReturnValue({ runStreamed }); calls.resume.mockReturnValue({ runStreamed });
});
const input = { prompt: "same prompt", cwd: "/example", signal: new AbortController().signal, model: "requested-alias", effort: "high" as const };
const collect = async (events: AsyncIterable<AgentEvent>) => { const result: AgentEvent[] = []; for await (const e of events) result.push(e); return result; };
it("maps each Claude result's pipeline totals, excludes child result traffic and preserves original SDK options", async () => {
  messages = [claudeResult(50), claudeResult(100), { ...claudeResult(999), parent_tool_use_id: "child" }];
  const result = await collect(new ClaudeAdapter({ permissionMode: "default", settingSources: [] }).run({ ...input, threadId: "sdk-session", readOnly: true }));
  const done = result.filter(e => e.type === "done");
  expect(done).toHaveLength(2);
  expect(done[1]).toMatchObject({ type: "done", usage: { scope: "session_cumulative", models: [{ counters: { input: 100 } }] } });
  expect(vi.mocked(query).mock.calls[0]?.[0]).toMatchObject({ prompt: "same prompt", options: {
    resume: "sdk-session", model: "requested-alias", effort: "high", permissionMode: "default", disallowedTools: ["Edit", "Write", "MultiEdit", "NotebookEdit"],
  } });
});
it.each([false, true])("retains Codex observations for first/resumed=%s and multiple results without declaring a delta", async resumed => {
  const result = await collect(new CodexAdapter({ runtime: "host" }).run({ ...input, threadId: resumed ? "saved-thread" : undefined }));
  expect(result.filter(e => e.type === "done")).toHaveLength(2);
  expect(result.at(-1)).toMatchObject({ usage: { scope: "unknown", version: "0.162.1", models: [], threadAggregate: { model: null, counters: { input: 100, cacheWriteInput: null, reasoningOutput: null } } } });
  expect(resumed ? calls.resume : calls.start).toHaveBeenCalledTimes(1);
});

it.each([false, true])("binds Codex usage to this run's matching thread event without inventing a model or result ID; resumed=%s", async resumed => {
  const runStreamed = vi.fn(async () => ({ events: (async function* () {
    yield { type: "thread.started", thread_id: "reported-thread" };
    yield { type: "turn.completed", usage: codexCumulativeReadings.first };
  })() }));
  calls.start.mockReturnValue({ runStreamed });
  calls.resume.mockReturnValue({ runStreamed });
  const result = await collect(new CodexAdapter({ runtime: "host" }).run({ ...input, threadId: resumed ? "reported-thread" : undefined }));
  expect(result[0]).toEqual({ type: "thread", threadId: "reported-thread" });
  expect(result.at(-1)).toMatchObject({ type: "done", ok: true, usage: {
    source: "codex.turn.completed.usage", version: "0.162.1", runtimeVersion: null, scope: "unknown", threadId: "reported-thread", resultId: null,
    models: [], threadAggregate: { model: null, counters: { input: 100, output: 20, cachedInput: 30, cacheWriteInput: 10, reasoningOutput: 5 } },
    codex: { threadMode: resumed ? "resume" : "start", threadBinding: "matched", runtimeVerification: "unverified" },
  } });
  const options = { model: "requested-alias", modelReasoningEffort: "high", workingDirectory: "/example", skipGitRepoCheck: true, sandboxMode: "workspace-write", approvalPolicy: "never" };
  if (resumed) expect(calls.resume).toHaveBeenCalledWith("reported-thread", options);
  else expect(calls.start).toHaveBeenCalledWith(options);
});

it.each([
  ["missing event", [], undefined, "missing"],
  ["resume mismatch", ["other-thread"], "saved-thread", "conflict"],
  ["changing thread", ["reported-thread", "other-thread", "reported-thread"], undefined, "conflict"],
  ["invalid thread", [""], undefined, "conflict"],
] as const)("does not bind Codex usage with %s", async (_, ids, threadId, binding) => {
  const runStreamed = async () => ({ events: (async function* () {
    for (const id of ids) yield { type: "thread.started", thread_id: id };
    yield { type: "turn.completed", usage: codexCumulativeReadings.first };
  })() });
  calls.start.mockReturnValue({ runStreamed }); calls.resume.mockReturnValue({ runStreamed });
  const result = await collect(new CodexAdapter({ runtime: "host" }).run({ ...input, threadId }));
  expect(result.at(-1)).toMatchObject({ usage: { threadId: null, resultId: null, codex: { threadBinding: binding }, threadAggregate: { model: null } } });
});

it("does not borrow a thread event from an earlier SDK execution", async () => {
  const adapter = new CodexAdapter({ runtime: "host" });
  calls.start.mockReturnValue({ runStreamed: async () => ({ events: (async function* () {
    yield { type: "thread.started", thread_id: "old-thread" };
    yield { type: "turn.completed", usage: codexCumulativeReadings.first };
  })() }) });
  expect((await collect(adapter.run(input))).at(-1)).toMatchObject({ usage: { threadId: "old-thread", codex: { threadBinding: "matched" } } });
  calls.resume.mockReturnValue({ runStreamed: async () => ({ events: (async function* () {
    yield { type: "turn.completed", usage: codexCumulativeReadings.resumed };
  })() }) });
  expect((await collect(adapter.run({ ...input, threadId: "old-thread" }))).at(-1)).toMatchObject({ usage: { threadId: null, codex: { threadBinding: "missing", threadMode: "resume" } } });
});

it("M1: conflicting SDK thread events never overwrite the real Hub Session sdkThreadId", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-thread-conflict-"));
  const db = openDb(":memory:");
  const hub = new Hub({ db, dataDir, agents: { codex: new CodexAdapter({ runtime: "host" }) }, maxConcurrent: 1 });
  const seenSessionIds: (string | null)[] = [];
  const scripted = (ids: string[]) => ({ runStreamed: async () => ({ events: (async function* () {
    for (const id of ids) {
      yield { type: "thread.started", thread_id: id };
      // Inspect after each event is consumed, so a later valid ID cannot hide a transient overwrite.
      seenSessionIds.push(db.select().from(schema.sessions).get()!.sdkThreadId);
    }
    yield { type: "turn.completed", usage: codexCumulativeReadings.first };
  })() }) });
  try {
    calls.start.mockReturnValue(scripted(["safe-thread", "other-thread", "safe-thread"]));
    const task = await hub.createTask({ title: "Thread conflict", workflow: "chat", agent: "codex", message: "first" });
    await hub.settled(task.id);
    const expectSafe = (binding: "conflict" | "matched") => {
      expect(hub.getTask(task.id)).toMatchObject({ status: "idle", sessions: [{ sdkThreadId: "safe-thread" }] });
      expect(seenSessionIds).toEqual(Array(seenSessionIds.length).fill("safe-thread"));
      expect(hub.usageCalls(task.id).calls.at(-1)!.usage).toMatchObject({ uncertainty: "unproven_scope", counters: { input: null, output: null },
        observation: { scope: "unknown", codex: { threadBinding: binding } } });
    };
    expectSafe("conflict");
    for (const ids of [["other-thread", "safe-thread"], ["safe-thread", "other-thread", "safe-thread"], ["", "safe-thread"], ["   ", "safe-thread"], ["x".repeat(201), "safe-thread"]]) {
      calls.resume.mockReturnValue(scripted(ids));
      hub.sendMessage(task.id, "resume");
      await hub.settled(task.id);
      expect(calls.resume).toHaveBeenLastCalledWith("safe-thread", expect.any(Object));
      expectSafe("conflict");
    }
    // Conflict state lasts for one SDK execution only; an ordinary later resume still works.
    calls.resume.mockReturnValue(scripted(["safe-thread"]));
    hub.sendMessage(task.id, "normal resume");
    await hub.settled(task.id);
    expectSafe("matched");
    expect(seenSessionIds).toHaveLength(15);
  } finally {
    await hub.shutdown(100);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
