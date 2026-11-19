/**
 * Invocation usage tracking around planner asks, user Stop and Claude cumulative readings.
 *
 * Expectations that are not met yet are an `it.todo` naming them, never an `it.fails`.
 *
 * All SDK data is synthetic. No real model is called.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { InvocationFinal, UsageCall, UsageObservation } from "@agent-hub/shared";
import { FakeAdapter, type FakeStep } from "../src/agents/fake";
import type { AgentAdapter, AgentEvent, AgentRunInput } from "../src/agents/types";
import { claudeUsage, codexUsage } from "../src/agents/usage";
import { normalizeInvocation, normalizeSpan, trustedReading } from "../src/core/invocation-usage";
import { codexCumulativeReadings, fakeUsage } from "./fixtures/usage";
import type { MeasuredRun } from "../src/core/invocations";
import { Hub, type HubOptions } from "../src/core/hub";
import { openDb, schema, type Db } from "../src/db/index";
import { Hosts } from "../src/tools/hosts";
import { ToolServer } from "../src/tools/mcp";

let root: string;
let repo: string;
let db: Db;
let tools: ToolServer;
const hubs: Hub[] = [];
const clients: Client[] = [];

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "usage-baseline-"));
  repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Test");
  fs.writeFileSync(path.join(repo, "README.md"), "fixture\n");
  git("add", ".");
  git("commit", "-qm", "fixture");
  db = openDb(path.join(root, "hub.db"));
  tools = new ToolServer(new Hosts(db, root));
  await tools.listen("127.0.0.1", 0);
});

afterEach(async () => {
  await Promise.all(hubs.splice(0).map((hub) => hub.shutdown(100)));
  await Promise.all(clients.splice(0).map((client) => client.close()));
  tools.close();
  fs.rmSync(root, { recursive: true, force: true });
});

function makeHub(agent: AgentAdapter, extra: Partial<HubOptions> = {}) {
  const hub = new Hub({ db, tools, agents: { claude: agent, codex: agent }, dataDir: path.join(root, "data"), maxConcurrent: 4, flushMs: 1, ...extra });
  hubs.push(hub);
  return hub;
}

async function connect(access: { url: string; token: string }) {
  const client = new Client({ name: "test", version: "1" });
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL(access.url), { requestInit: { headers: { Authorization: `Bearer ${access.token}` } } }));
  return client;
}

const workflowCalls = (hub: Hub, taskId: string): InvocationFinal[] =>
  hub.usageCalls(taskId, 0, 100).calls.filter((c) => c.role === "main" && c.purpose === "workflow");
const pick = (c: InvocationFinal) => ({ status: c.status, failure: c.failure, observation: c.usage.observation, uncertainty: c.usage.uncertainty, counters: c.usage.counters });
const allNull = { input: null, output: null, cachedInput: null, cacheWriteInput: null, reasoningOutput: null };

// Synthetic Claude SDK result messages shaped like 0.3.296 SDKResultMessage. A helper model whose
// cumulative counters never move, and a main model whose cumulative counters grow every turn.
const THREAD = "sdk-session";
interface Turn { uuid: string; opus: [number, number, number, number]; cost: number }
const HAIKU = { inputTokens: 17822, outputTokens: 24, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.02 };
const claudeMessage = ({ uuid, opus: [input, output, read, write], cost }: Turn) => ({
  type: "result", subtype: "success", is_error: false, result: "ok", session_id: THREAD, uuid,
  total_cost_usd: cost, duration_ms: 1, num_turns: 1,
  usage: { input_tokens: 4, output_tokens: 100, cache_read_input_tokens: 1000, cache_creation_input_tokens: 10 },
  modelUsage: {
    "claude-haiku-5-5": HAIKU,
    "claude-opus-5-5": { inputTokens: input, outputTokens: output, cacheReadInputTokens: read, cacheCreationInputTokens: write, costUSD: cost - 0.02 },
  },
});
const TURN1: Turn = { uuid: "r1", opus: [16, 5493, 423824, 192243], cost: 1.73 };
const TURN2: Turn = { uuid: "r2", opus: [30, 17814, 1237685, 225665], cost: 2.41 };
const TURN3: Turn = { uuid: "r3", opus: [44, 25162, 2305594, 248069], cost: 2.95 };
const claudeObs = (turn: Turn): UsageObservation => claudeUsage(claudeMessage(turn));
/** The real Claude adapter's producer matches its observations; a fake must too for spans to be measured. */
const CLAUDE_PRODUCER = (({ source, version, runtimeVersion }) => ({ source, version, runtimeVersion }))(claudeObs(TURN1));
function asClaude<T extends AgentAdapter>(agent: T, producer: AgentAdapter["usageProducer"] = CLAUDE_PRODUCER): T {
  return Object.defineProperty(agent, "usageProducer", { value: producer });
}
const done = (usage?: UsageObservation): AgentEvent => ({ type: "done", ok: true, costUsd: 0, durationMs: 1, numTurns: 1, ...(usage ? { usage } : {}) });

/** A planner agent keyed by prompt; `hold` stops it after its first event until ask, Stop or release. */
function planner(steps: Record<string, { hold?: boolean; events: FakeStep[] }>) {
  const agent: FakeAdapter = asClaude(new FakeAdapter((input: AgentRunInput) => {
    const key = Object.keys(steps).find((k) => input.prompt.includes(k));
    if (!key) return [{ type: "thread", threadId: THREAD }, done()];
    if (steps[key]!.hold) agent.hold(0);
    return steps[key]!.events;
  }));
  return agent;
}

/** The fake only listens for abort once it waits at its gate; Stop must not arrive before that. */
async function reachedGate(hub: Hub, taskId: string) {
  await vi.waitFor(() => expect(hub.getTask(taskId).sessions[0]?.sdkThreadId).toBe(THREAD));
  await new Promise((r) => setTimeout(r, 20));
}

describe("T1 planner ask through the real Hub path", () => {
  it("closes the provider call as cancelled with endReason planner_ask, not a failure, keeping usage unknown", async () => {
    const agent = planner({ "turn-ask": { hold: true, events: [{ type: "thread", threadId: THREAD }, done(claudeObs(TURN1))] } });
    const hub = makeHub(agent);
    const task = await hub.createTask({ title: "Plan", workflow: "plan", repoPath: repo, message: "turn-ask", agent: "claude" });
    await vi.waitFor(() => expect(agent.runs[0]?.mcp).toBeDefined());
    const client = await connect(agent.runs[0]!.mcp!);
    await client.callTool({ name: "ask", arguments: { question: "Start?" } });
    await hub.settled(task.id);

    const [call] = workflowCalls(hub, task.id);
    // The SDK call really was cancelled; the ask is the business reason, not an error.
    expect(pick(call!)).toEqual({ status: "cancelled", failure: null, observation: null, uncertainty: "missing_usage", counters: allNull });
    expect(call!.endReason).toBe("planner_ask");
    expect(call!.usage.availability).toBe("unknown"); // Unknown, never coerced to zero.
    // Business state: an ordinary, successful end of a planning turn.
    expect(hub.getTask(task.id).status).toBe("idle");
    const history = hub.events(task.id);
    expect(history.filter((e) => e.type === "turn_result")).toHaveLength(0); // The ask turn writes no turn_result at all.
    const ask = history.find((e) => e.type === "ask")!;
    expect(history.find((e) => e.type === "plan_turn_end")).toMatchObject({ ask: ask.id });
    expect(history.some((e) => e.type === "status_change" && e.reason === "stopped by you")).toBe(false);
    // The invocation closes synchronously on abort, before the turn's own end markers: the ask card
    // never waits for the SDK to wind down.
    const finished = history.find((e) => e.type === "invocation_finished")!;
    expect(finished.seq).toBeLessThan(history.find((e) => e.type === "plan_turn_end")!.seq);
    agent.release();
  });

  it("still drops a result the SDK delivers after the ask abort, and refuses tools after the ask", async () => {
    // Stands in for an SDK that flushes its result after being aborted (the fake would otherwise throw).
    const runs: AgentRunInput[] = [];
    const agent: AgentAdapter = {
      kind: "fake", usageProducer: { source: "fake", version: "fixture", runtimeVersion: "fixture" },
      queryQuota: async () => ({ status: "unknown", windows: [] }),
      async *run(input) {
        runs.push(input);
        yield { type: "thread", threadId: THREAD };
        await new Promise<void>((r) => (input.signal.aborted ? r() : input.signal.addEventListener("abort", () => r(), { once: true })));
        yield done(claudeObs(TURN1));
      },
    };
    const hub = makeHub(agent);
    const task = await hub.createTask({ title: "Plan", workflow: "plan", repoPath: repo, message: "turn-ask", agent: "claude" });
    await vi.waitFor(() => expect(runs[0]?.mcp).toBeDefined());
    const client = await connect(runs[0]!.mcp!);
    await client.callTool({ name: "ask", arguments: { question: "Start?" } });
    await hub.settled(task.id);

    expect(pick(workflowCalls(hub, task.id)[0]!)).toMatchObject({ status: "cancelled", failure: null, observation: null });
    expect(hub.events(task.id).filter((e) => e.type === "turn_result")).toHaveLength(0);
    // Authorization after ask must stay closed whatever is done for usage.
    const after = await client.callTool({ name: "propose_task", arguments: { title: "x", spec: "x", testCommand: "true" } }).catch((e: unknown) => ({ isError: true, error: e }));
    expect(after.isError).toBe(true);
  });

  it("records planner_ask even when the adapter yields again before the deferred abort lands", async () => {
    const runs: AgentRunInput[] = [];
    let signalAtAsk: boolean | undefined;
    let hub!: Hub;
    const agent: AgentAdapter = {
      kind: "fake", usageProducer: CLAUDE_PRODUCER,
      queryQuota: async () => ({ status: "unknown", windows: [] }),
      async *run(input) {
        runs.push(input);
        yield { type: "thread", threadId: THREAD };
        // Resume on the microtask after the ask is recorded: before the 0 ms abort timer can fire.
        await new Promise<void>((r) => { const off = hub.subscribe((m) => { if (m.type === "event" && m.event.type === "ask") { off(); r(); } }); });
        signalAtAsk = input.signal.aborted;
        yield { type: "text_start" };
        yield done(claudeObs(TURN1));
      },
    };
    hub = makeHub(agent);
    const task = await hub.createTask({ title: "Plan", workflow: "plan", repoPath: repo, message: "turn-ask", agent: "claude" });
    await vi.waitFor(() => expect(runs[0]?.mcp).toBeDefined());
    const client = await connect(runs[0]!.mcp!);
    await client.callTool({ name: "ask", arguments: { question: "Start?" } });
    await hub.settled(task.id);
    expect(signalAtAsk).toBe(false); // The race really happened: the adapter ran on before any abort.
    const call = workflowCalls(hub, task.id)[0]!;
    expect([call.status, call.failure, call.endReason]).toEqual(["cancelled", null, "planner_ask"]);
    expect(call.usage).toMatchObject({ observation: null, uncertainty: "missing_usage", counters: allNull });
    const after = await client.callTool({ name: "propose_task", arguments: { title: "x", spec: "x", testCommand: "true" } }).catch(() => ({ isError: true }));
    expect(after.isError).toBe(true);
  });

  it.todo("not in this round: keep a result the SDK still delivers after an ask, without reopening tools");
});

describe("T2 user Stop versus planner ask", () => {
  it("records both as cancelled provider calls, told apart by endReason and failure", async () => {
    const agent = planner({
      "turn-ask": { hold: true, events: [{ type: "thread", threadId: THREAD }, done(claudeObs(TURN1))] },
      "turn-stop": { hold: true, events: [{ type: "thread", threadId: THREAD }, done(claudeObs(TURN1))] },
    });
    const hub = makeHub(agent);
    const asked = await hub.createTask({ title: "Ask", workflow: "plan", repoPath: repo, message: "turn-ask", agent: "claude" });
    await vi.waitFor(() => expect(agent.runs[0]?.mcp).toBeDefined());
    await (await connect(agent.runs[0]!.mcp!)).callTool({ name: "ask", arguments: { question: "Start?" } });
    await hub.settled(asked.id);
    agent.release();

    const stopped = await hub.createTask({ title: "Stop", workflow: "plan", repoPath: repo, message: "turn-stop", agent: "claude" });
    await vi.waitFor(() => expect(agent.runs[1]?.mcp).toBeDefined());
    await reachedGate(hub, stopped.id);
    hub.stop(stopped.id);
    await hub.settled(stopped.id);
    agent.release();

    const askCall = workflowCalls(hub, asked.id)[0]!, stopCall = workflowCalls(hub, stopped.id)[0]!;
    expect([askCall.status, askCall.failure, askCall.endReason]).toEqual(["cancelled", null, "planner_ask"]);
    expect([stopCall.status, stopCall.failure, stopCall.endReason]).toEqual(["cancelled", "abort", "user_stop"]);
    expect(pick(stopCall)).toMatchObject({ observation: null, uncertainty: "missing_usage", counters: allNull });
    const stopHistory = hub.events(stopped.id);
    expect(stopHistory.some((e) => e.type === "status_change" && e.reason === "stopped by you")).toBe(true);
    const stopEnd = stopHistory.find((e) => e.type === "plan_turn_end");
    expect(stopEnd).toBeDefined();
    expect(stopEnd && "ask" in stopEnd ? stopEnd.ask : undefined).toBeUndefined();
    expect(hub.events(asked.id).find((e) => e.type === "plan_turn_end")).toMatchObject({ ask: expect.any(String) });
  });
});

/** The bare measured boundary, on a chat task, for synthetic producer sequences. */
function measured(provider: "claude" | "codex", extra: Partial<HubOptions> = {}, producer = CLAUDE_PRODUCER) {
  const fake = new FakeAdapter();
  const hub = new Hub({ db, dataDir: path.join(root, "data"), agents: { claude: fake, codex: fake }, maxConcurrent: 4, ...extra });
  hubs.push(hub);
  const now = new Date().toISOString();
  for (const id of ["task", "other"]) db.insert(schema.tasks).values({ id, title: "Usage", workflow: "chat", status: "idle", options: {}, createdAt: now, updatedAt: now }).run();
  const run = (hub as unknown as { measuredRun: MeasuredRun }).measuredRun.bind(hub);
  const context = { taskId: "task", sessionId: null, workflow: "chat", provider, role: "main", purpose: "workflow" } as const;
  const once = async (events: AgentEvent[], threadId?: string, signal = new AbortController().signal, taskId = "task", by = producer) => {
    try { for await (const _ of run(asClaude(new FakeAdapter(() => events), by), { prompt: "x", cwd: repo, threadId, signal }, { ...context, taskId })) { /* drain */ } }
    catch { /* aborted runs throw; the record is what is under test */ }
  };
  /** A resumed call cancelled before any reading: it leaves a gap on the thread. */
  const gap = (by = producer) => { const ac = new AbortController(); ac.abort(); return once([{ type: "thread", threadId: THREAD }], THREAD, ac.signal, "task", by); };
  return { hub, fake, run, context, once, gap };
}

describe("T3 Claude multi-model cumulative normalization (characterization)", () => {
  it("derives per-model deltas: the unchanged helper model contributes zero, the main model its growth", () => {
    const first = claudeObs(TURN1), second = claudeObs(TURN2);
    expect(second.scope).toBe("session_cumulative"); // Only because the installed SDK is exactly 0.3.296.
    const u = normalizeInvocation(second, true, { status: "success", usage: { observation: first }, eventId: "prior" } as InvocationFinal & { eventId: string });
    const by = Object.fromEntries(u.models.map((m) => [m.model, m.counters]));
    expect(by["claude-haiku-5-5"]).toEqual({ input: 0, output: 0, cachedInput: 0, cacheWriteInput: 0, reasoningOutput: null });
    expect(by["claude-opus-5-5"]).toEqual({ input: 14, output: 12321, cachedInput: 813861, cacheWriteInput: 33422, reasoningOutput: null });
    expect(u.counters.output).toBe(12321);
    expect(u.costUsd).toBeCloseTo(0.68, 10);
    expect(u.baselineEventId).toBe("prior");
    // The raw cumulative observation is kept beside the delta, and still shows the frozen helper value.
    expect(u.observation?.models.find((m) => m.model === "claude-haiku-5-5")?.counters.input).toBe(17822);
  });

  it("sums only derived deltas, so the task total equals the latest cumulative value, never twice", async () => {
    const { hub, once } = measured("claude");
    await once([{ type: "thread", threadId: THREAD }, done(claudeObs(TURN1))]);
    await once([{ type: "thread", threadId: THREAD }, done(claudeObs(TURN2))], THREAD);
    const [a, b] = hub.usageCalls("task").calls;
    expect(a!.usage.counters.output).toBe(24 + 5493); // First, unresumed call: the full value is its own.
    expect(b!.usage.counters.output).toBe(12321);
    expect(hub.usageSummary("task").counters.output).toBe(24 + 17814);
  });

  it("labels a cumulative decrease as a counter reset and never yields negative or zero-filled deltas", async () => {
    const { hub, once } = measured("claude");
    await once([{ type: "thread", threadId: THREAD }, done(claudeObs(TURN2))]);
    await once([{ type: "thread", threadId: THREAD }, done(claudeObs({ uuid: "after-clear", opus: [3, 50, 900, 20], cost: 0.05 }))], THREAD);
    const after = hub.usageCalls("task").calls[1]!.usage;
    expect(after.uncertainty).toBe("counter_reset");
    expect(after.costUsd).toBeNull();
    for (const m of after.models) for (const v of Object.values(m.counters)) expect(v === null || v >= 0).toBe(true);
  });

  it("keeps a result without modelUsage unknown rather than zero", async () => {
    const { hub, once } = measured("claude");
    const bare = claudeUsage({ ...claudeMessage(TURN1), modelUsage: undefined, total_cost_usd: undefined });
    await once([done(bare)]);
    const call = hub.usageCalls("task").calls[0]!;
    expect(call.usage.counters).toEqual(allNull);
    expect(hub.usageSummary("task").counters.output).toBeNull();
  });
});

describe("T4 Claude success, cancelled ask, success through the real Hub path", () => {
  async function threeTurns() {
    const agent = planner({
      "turn-one": { events: [{ type: "thread", threadId: THREAD }, done(claudeObs(TURN1))] },
      "turn-two": { hold: true, events: [{ type: "thread", threadId: THREAD }, done(claudeObs(TURN2))] },
      "turn-three": { events: [{ type: "thread", threadId: THREAD }, done(claudeObs(TURN3))] },
    });
    const hub = makeHub(agent);
    const task = await hub.createTask({ title: "Plan", workflow: "plan", repoPath: repo, message: "turn-one", agent: "claude" });
    await hub.settled(task.id);
    hub.sendMessage(task.id, "turn-two");
    await vi.waitFor(() => expect(agent.runs[1]?.mcp).toBeDefined());
    await (await connect(agent.runs[1]!.mcp!)).callTool({ name: "ask", arguments: { question: "Continue?" } });
    await hub.settled(task.id);
    agent.release();
    hub.sendMessage(task.id, "turn-three");
    await hub.settled(task.id);
    return { hub, task, agent };
  }

  it("keeps the third turn unknown per call and records the spanned usage once, as an unattributed interval", async () => {
    const { hub, task, agent } = await threeTurns();
    expect(agent.runs.map((r) => r.threadId)).toEqual([undefined, THREAD, THREAD]);
    const [one, two, three] = workflowCalls(hub, task.id) as UsageCall[];
    expect([one, two, three].map((c) => c!.status)).toEqual(["success", "cancelled", "success"]);
    expect(two!.endReason).toBe("planner_ask");
    expect(three!.usage).toMatchObject({ uncertainty: "unattributed_interval", counters: allNull, models: [], baselineEventId: null });
    expect(three!.usage.observation?.models.find((m) => m.model === "claude-opus-5-5")?.counters.output).toBe(25162); // Raw cumulative kept.
    const interval = three!.usage.interval!;
    expect(interval).toMatchObject({ kind: "unattributed", threadId: THREAD, toResultId: "r3", precision: "derived", uncertainty: "partial_fields",
      from: { eventId: one!.eventId, callId: one!.callId, resultId: "r1", origin: "reading" }, callIds: [two!.callId, three!.callId] });
    const by = Object.fromEntries(interval.models.map((m) => [m.model, m.counters]));
    expect(by["claude-opus-5-5"]).toEqual({ input: 28, output: 19669, cachedInput: 1881770, cacheWriteInput: 55826, reasoningOutput: null });
    expect(by["claude-haiku-5-5"]).toMatchObject({ input: 0, output: 0 });
    expect(interval.costUsd).toBeCloseTo(1.22, 10);
    const summary = hub.usageSummary(task.id);
    expect(summary.counters.output).toBe(24 + 5493); // Per call: only the first turn.
    expect(summary.unattributed).toMatchObject({ intervals: 1, counters: { output: 19669, reasoningOutput: null } });
    expect(summary.counters.output! + summary.unattributed.counters.output!).toBe(24 + 25162); // Equals the last cumulative reading.
    expect(summary.costUsd! + summary.unattributed.costUsd!).toBeCloseTo(2.95, 10);
  });

  it("guard: the interval spanning the cancelled turn is never attributed to the last turn alone", async () => {
    const { hub, task } = await threeTurns();
    const three = workflowCalls(hub, task.id)[2]!;
    const spanning = 25162 - 5493;
    expect(three.usage.counters.output).not.toBe(spanning);
    expect(three.usage.models.find((m) => m.model === "claude-opus-5-5")?.counters.output ?? null).not.toBe(spanning);
    expect(three.usage.counters.output).not.toBe(25162 + 24); // Raw cumulative is not a per-call value.
  });

  it("measures from the thread start when the very first turn is the ask", async () => {
    const agent = planner({
      "turn-one": { hold: true, events: [{ type: "thread", threadId: THREAD }, done(claudeObs(TURN1))] },
      "turn-two": { events: [{ type: "thread", threadId: THREAD }, done(claudeObs(TURN2))] },
    });
    const hub = makeHub(agent);
    const task = await hub.createTask({ title: "Plan", workflow: "plan", repoPath: repo, message: "turn-one", agent: "claude" });
    await vi.waitFor(() => expect(agent.runs[0]?.mcp).toBeDefined());
    await (await connect(agent.runs[0]!.mcp!)).callTool({ name: "ask", arguments: { question: "Start?" } });
    await hub.settled(task.id);
    agent.release();
    hub.sendMessage(task.id, "turn-two");
    await hub.settled(task.id);
    const [one, two] = workflowCalls(hub, task.id) as UsageCall[];
    expect(two!.usage.interval).toMatchObject({ from: { callId: one!.callId, origin: "thread_start", resultId: null }, callIds: [one!.callId, two!.callId], counters: { output: 24 + 17814 } });
    const summary = hub.usageSummary(task.id);
    expect(summary.counters.output).toBeNull(); // No call is known on its own.
    expect(summary.unattributed.counters.output).toBe(24 + 17814);
  });
});

describe("T7 unattributed intervals on one thread", () => {
  const TURN4: Turn = { uuid: "r4", opus: [58, 30000, 3000000, 260000], cost: 3.4 };
  const TURN5: Turn = { uuid: "r5", opus: [70, 33000, 3500000, 270000], cost: 3.8 };
  const reading = (turn: Turn) => [{ type: "thread", threadId: THREAD } as const, done(claudeObs(turn))];

  it("covers consecutive readings exactly once: intervals never overlap and never contain a per-call delta", async () => {
    const { hub, once, gap } = measured("claude");
    await once(reading(TURN1));
    await gap();
    await once(reading(TURN2), THREAD);
    await gap();
    await gap();
    await once(reading(TURN4), THREAD);
    await once(reading(TURN5), THREAD);
    const calls = hub.usageCalls("task").calls;
    const [, c2, s3, c4, c5, s6, s7] = calls;
    const first = s3!.usage.interval!, second = s6!.usage.interval!;
    expect(first.callIds).toEqual([c2!.callId, s3!.callId]);
    expect(second.callIds).toEqual([c4!.callId, c5!.callId, s6!.callId]);
    expect(second.from).toMatchObject({ callId: s3!.callId, resultId: "r2", origin: "reading" }); // Starts where the first ended.
    expect(s7!.usage).toMatchObject({ uncertainty: "partial_fields", baselineEventId: s6!.eventId, counters: { output: 3000 } });
    expect(s7!.usage.interval).toBeUndefined();
    const spanned = new Set([...first.callIds, ...second.callIds]);
    for (const c of calls) if (c.usage.models.some((m) => m.counters.output !== null)) expect(spanned.has(c.callId)).toBe(false);
    const summary = hub.usageSummary("task");
    expect(summary.unattributed.intervals).toBe(2);
    expect(summary.counters.output! + summary.unattributed.counters.output!).toBe(24 + 33000);
    expect(summary.costUsd! + summary.unattributed.costUsd!).toBeCloseTo(3.8, 10);
  });

  it("trusts a reading carried by a cancelled call when it arrived before the abort", async () => {
    const { hub, run, context, once } = measured("claude");
    await once(reading(TURN1));
    const ac = new AbortController();
    try {
      for await (const e of run(asClaude(new FakeAdapter(() => [...reading(TURN2), { type: "text_start" }])), { prompt: "x", cwd: repo, threadId: THREAD, signal: ac.signal }, context)) if (e.type === "done") ac.abort();
    } catch { /* aborted */ }
    await once(reading(TURN3), THREAD);
    const [, cancelled, third] = hub.usageCalls("task").calls;
    expect(cancelled).toMatchObject({ status: "cancelled", usage: { counters: { output: 12321 } } });
    expect(third!.usage).toMatchObject({ baselineEventId: cancelled!.eventId, counters: { output: 25162 - 17814 } });
    expect(hub.usageSummary("task").unattributed.intervals).toBe(0);
  });

  it.each([
    ["an SDK upgrade between the readings", (o: UsageObservation) => { o.version = "0.3.297"; }, { ...CLAUDE_PRODUCER, version: "0.3.297" }],
    ["a different thread", (o: UsageObservation) => { o.threadId = "other-session"; }, CLAUDE_PRODUCER],
    ["a model missing from the later reading", (o: UsageObservation) => { o.models = o.models.filter((m) => m.model !== "claude-haiku-5-5"); }, CLAUDE_PRODUCER],
  ] as const)("does not compute an interval across %s", async (_, change, producer) => {
    const { hub, once, gap } = measured("claude");
    await once(reading(TURN1));
    // The gap call runs on the later producer, so only the two readings disagree.
    await gap(producer);
    const changed = claudeObs(TURN3);
    change(changed);
    await once([{ type: "thread", threadId: THREAD }, done(changed)], THREAD, undefined, "task", producer);
    const last = hub.usageCalls("task").calls.at(-1)!;
    expect(last.usage).toMatchObject({ uncertainty: "incompatible_baseline", counters: allNull });
    expect(last.usage.interval).toBeUndefined();
    expect(hub.usageSummary("task").unattributed).toMatchObject({ intervals: 0, counters: allNull, costUsd: null });
  });

  it("labels a decrease across a gap as a counter reset, with no interval and nothing negative", async () => {
    const { hub, once, gap } = measured("claude");
    await once(reading(TURN2));
    await gap();
    await once(reading(TURN1), THREAD);
    const last = hub.usageCalls("task").calls.at(-1)!;
    expect(last.usage).toMatchObject({ uncertainty: "counter_reset", counters: allNull, models: [] });
    expect(last.usage.interval).toBeUndefined();
    expect(hub.usageSummary("task").unattributed.intervals).toBe(0);
  });

  it("keeps unknown fields unknown inside an interval instead of completing the total", async () => {
    const { hub, once, gap } = measured("claude");
    await once(reading(TURN1));
    await gap();
    const message = claudeMessage(TURN3);
    const { cacheCreationInputTokens: _, ...opus } = message.modelUsage["claude-opus-5-5"];
    await once([{ type: "thread", threadId: THREAD }, done(claudeUsage({ ...message, modelUsage: { ...message.modelUsage, "claude-opus-5-5": opus } }))], THREAD);
    const interval = hub.usageCalls("task").calls.at(-1)!.usage.interval!;
    expect(interval).toMatchObject({ uncertainty: "partial_fields", inputInclusiveCache: null, counters: { output: 19669, cacheWriteInput: null } });
    expect(hub.usageSummary("task").unattributed.counters).toMatchObject({ output: 19669, cacheWriteInput: null });
  });

  it("reads events without the new fields as before", async () => {
    const { hub, once } = measured("claude");
    await once(reading(TURN1));
    const [call] = hub.usageCalls("task").calls;
    expect("interval" in call!.usage).toBe(false);
    expect("endReason" in call!).toBe(false);
    expect(hub.usageSummary("task")).toMatchObject({ counters: { output: 24 + 5493 }, unattributed: { intervals: 0, counters: allNull, inputInclusiveCache: null, costUsd: null } });
  });

  /** A Claude result that reports USD but no modelUsage: it counts cost per call, never tokens. */
  const costOnly = (uuid: string, cost: number) => claudeUsage({ ...claudeMessage({ uuid, opus: [0, 0, 0, 0], cost }), modelUsage: undefined });
  const withCost = (turn: Turn, cost: number) => [{ type: "thread", threadId: THREAD } as const, done(claudeObs({ ...turn, cost }))];
  const measuredCost = (hub: Hub) => { const s = hub.usageSummary("task"); return (s.costUsd ?? 0) + (s.unattributed.costUsd ?? 0); };

  it("does not pass over a cost-only call: cost is never counted per call and again in a span", async () => {
    const { hub, once } = measured("claude");
    await once(withCost(TURN1, 1.0));
    await once([{ type: "thread", threadId: THREAD }, done(costOnly("r2", 1.5))], THREAD);
    await once(withCost(TURN3, 2.0), THREAD);
    const [, second, third] = hub.usageCalls("task").calls;
    expect(second!.usage.costUsd).toBeCloseTo(0.5, 10);
    expect(third!.usage).toMatchObject({ uncertainty: "incompatible_baseline", costUsd: null, counters: allNull });
    expect(third!.usage.interval).toBeUndefined();
    expect(measuredCost(hub)).toBeCloseTo(1.5, 10); // Known so far; the third call stays unknown rather than 2.5.
    expect(measuredCost(hub)).toBeLessThanOrEqual(2.0);
  });

  it("does not open a span from zero after a cost-only first call", async () => {
    const { hub, once } = measured("claude");
    await once([{ type: "thread", threadId: THREAD }, done(costOnly("r1", 1.0))]);
    await once(withCost(TURN2, 2.0), THREAD);
    const [first, second] = hub.usageCalls("task").calls;
    expect(first!.usage).toMatchObject({ costUsd: 1.0, counters: allNull });
    expect(second!.usage).toMatchObject({ uncertainty: "incompatible_baseline", costUsd: null, counters: allNull });
    expect(second!.usage.interval).toBeUndefined();
    expect(hub.usageSummary("task").unattributed).toMatchObject({ intervals: 0, counters: allNull, costUsd: null });
    expect(measuredCost(hub)).toBeCloseTo(1.0, 10);
  });

  it("rejects an interval cost total beyond the safe range instead of reporting it", async () => {
    const { hub, once, gap } = measured("claude");
    await once(reading(TURN1));
    await gap();
    await once(reading(TURN3), THREAD);
    const call = hub.usageCalls("task").calls.at(-1)!;
    const append = (hub as unknown as { append(task: string, session: string | null, payload: object): unknown }).append.bind(hub);
    // Two stored spans, each within range on its own, whose sum is not a safe value.
    const { eventId: _e, seq: _s, startedEventId: _st, ...final } = call;
    for (const callId of ["huge-1", "huge-2"]) append("task", null, { type: "invocation_finished", ...final, callId,
      usage: { ...call.usage, interval: { ...call.usage.interval!, costUsd: Number.MAX_SAFE_INTEGER } } });
    expect(hub.usageSummary("task").unattributed).toMatchObject({ intervals: 3, costUsd: null, counters: { output: 3 * 19669 } });
  });
});

describe("T5 Codex resumed cumulative-looking sequence (Hub behaviour only, not SDK evidence)", () => {
  const raw = (input: number, cached: number, output: number, reasoning: number) =>
    codexUsage({ input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: reasoning, cache_write_input_tokens: 0 }, "0.162.1");

  it("characterization: unknown scope keeps every call unproven, retains raw values, and sums nothing", async () => {
    const { hub, once } = measured("codex");
    await once([{ type: "thread", threadId: "codex-thread" }, done(raw(1529687, 1429376, 14206, 1666))]);
    await once([{ type: "thread", threadId: "codex-thread" }, done(raw(2762304, 2644736, 16722, 2787))], "codex-thread");
    await once([{ type: "thread", threadId: "codex-thread" }, done(raw(3346461, 3224192, 17742, 2787))], "codex-thread");
    const calls = hub.usageCalls("task").calls;
    expect(calls.map((c) => c.resumed)).toEqual([false, true, true]);
    for (const c of calls) {
      expect(c.usage).toMatchObject({ availability: "recorded", uncertainty: "unproven_scope", counters: allNull, models: [], baselineEventId: null });
      expect(c.usage.observation?.scope).toBe("unknown");
    }
    expect(calls[2]!.usage.observation?.threadAggregate?.counters.input).toBe(3346461);
    const summary = hub.usageSummary("task");
    expect(summary.counters).toEqual(allNull); // Neither raw values nor zeros.
    expect(summary.unknownCalls).toBe(3);
  });

  it("characterization: a failed turn has no usage, and a lower reading on a new thread is not called a reset", async () => {
    const { hub, once } = measured("codex");
    await once([{ type: "thread", threadId: "codex-thread" }, done(raw(2762304, 2644736, 16722, 2787))]);
    await once([{ type: "thread", threadId: "codex-thread" }, { type: "done", ok: false, error: "turn failed" }], "codex-thread");
    await once([{ type: "thread", threadId: "new-thread" }, done(raw(128792, 9216, 4590, 63))]);
    const [first, failed, fresh] = hub.usageCalls("task").calls;
    expect(first!.usage.uncertainty).toBe("unproven_scope");
    expect(failed).toMatchObject({ status: "failure", failure: "provider", usage: { observation: null, uncertainty: "missing_usage", counters: allNull } });
    expect(fresh!.usage.uncertainty).toBe("unproven_scope");
  });
});

describe("T8 Codex cumulative safety contract (offline Experiment 002-B)", () => {
  const CODEX_THREAD = "codex-thread";
  const CODEX_PRODUCER = { source: "codex.turn.completed.usage", version: "0.162.1", runtimeVersion: "0.162.1" } as const;
  const observed = (raw: unknown, runtimeVersion: string | null = "0.162.1") => codexUsage(raw, runtimeVersion);
  const reading = (raw: unknown) => [{ type: "thread", threadId: CODEX_THREAD } as const, done(observed(raw))];
  const setup = () => measured("codex", {}, CODEX_PRODUCER);
  const expectUnproven = (call: UsageCall) => {
    expect(call.status).toBe("success");
    expect(call.failure).toBeNull();
    expect(call.usage).toMatchObject({ availability: "recorded", uncertainty: "unproven_scope", precision: "unknown",
      partial: true, counters: allNull, models: [], inputInclusiveCache: null, costUsd: null, baselineEventId: null });
    expect(call.usage.interval).toBeUndefined();
    expect(call.usage.observation?.scope).toBe("unknown");
  };
  const expectUnknownTotals = (hub: Hub, calls: number) => {
    expect(hub.usageSummary("task")).toMatchObject({ calls, unknownCalls: calls, partial: true, counters: allNull,
      inputInclusiveCache: null, costUsd: null, unattributed: { intervals: 0, counters: allNull, inputInclusiveCache: null, costUsd: null } });
  };

  it("retains new-thread 100 and resumed 160 without counting either snapshot or the possible delta 60", async () => {
    const { hub, once } = setup();
    await once(reading(codexCumulativeReadings.first));
    await once(reading(codexCumulativeReadings.resumed), CODEX_THREAD);
    const calls = hub.usageCalls("task").calls;
    expect(calls.map(c => c.resumed)).toEqual([false, true]);
    expect(calls.map(c => c.threadId)).toEqual([CODEX_THREAD, CODEX_THREAD]);
    expect(calls.map(c => c.usage.observation?.threadAggregate?.counters.input)).toEqual([100, 160]);
    for (const call of calls) {
      expect(call.producer).toEqual(CODEX_PRODUCER);
      expect(call.usage.observation).toMatchObject({ threadId: null, resultId: null });
      expectUnproven(call);
    }
    expectUnknownTotals(hub, 2);
  });

  it("keeps 100 -> 160 -> missing -> 200 unknown, without attributing the possible interval 40 to the last call", async () => {
    const { hub, once } = setup();
    await once(reading(codexCumulativeReadings.first));
    await once(reading(codexCumulativeReadings.resumed), CODEX_THREAD);
    await once([{ type: "thread", threadId: CODEX_THREAD }, done()], CODEX_THREAD);
    await once(reading(codexCumulativeReadings.afterGap), CODEX_THREAD);
    const calls = hub.usageCalls("task").calls;
    expect(calls.map(c => c.usage.observation?.threadAggregate?.counters.input ?? null)).toEqual([100, 160, null, 200]);
    expect(calls[2]!.usage).toMatchObject({ observation: null, uncertainty: "missing_usage", counters: allNull });
    for (const call of [calls[0]!, calls[1]!, calls[3]!]) expectUnproven(call);
    expectUnknownTotals(hub, 4);
  });

  it("does not add duplicate 160 snapshots within one invocation or across separate invocations", async () => {
    const { hub, once } = setup();
    await once(reading(codexCumulativeReadings.first));
    await once([...reading(codexCumulativeReadings.resumed), done(observed({ ...codexCumulativeReadings.resumed }))], CODEX_THREAD);
    await once(reading(codexCumulativeReadings.resumed), CODEX_THREAD);
    const calls = hub.usageCalls("task").calls;
    expect(calls).toHaveLength(3); // Two done events still close exactly one invocation.
    expect(new Set(calls.map(c => c.callId)).size).toBe(3);
    expect(calls.map(c => c.usage.observation?.threadAggregate?.counters.input)).toEqual([100, 160, 160]);
    calls.forEach(expectUnproven);
    expectUnknownTotals(hub, 3);
  });

  it("retains a same-thread decrease 200 -> 30 without negative deltas or claiming a verified reset", async () => {
    const { hub, once } = setup();
    await once(reading(codexCumulativeReadings.afterGap));
    await once(reading(codexCumulativeReadings.reset), CODEX_THREAD);
    const calls = hub.usageCalls("task").calls;
    expect(calls.map(c => c.usage.observation?.threadAggregate?.counters.input)).toEqual([200, 30]);
    calls.forEach(expectUnproven); // A decrease cannot establish the currently unproven scope.
    expectUnknownTotals(hub, 2);
  });

  it.each([false, true])("does not treat CLI default zero as measured zero or a baseline; resumed=%s", async resumed => {
    const { hub, once } = setup();
    if (resumed) await once(reading(codexCumulativeReadings.afterGap));
    await once(reading(codexCumulativeReadings.defaultZero), resumed ? CODEX_THREAD : undefined);
    await once(reading(codexCumulativeReadings.reset), CODEX_THREAD);
    const calls = hub.usageCalls("task").calls;
    expect(calls[resumed ? 1 : 0]!.usage.observation?.threadAggregate?.counters).toEqual({ input: 0, output: 0, cachedInput: 0, cacheWriteInput: 0, reasoningOutput: 0 });
    expect(calls[resumed ? 1 : 0]!.usage.accountingBlockers).toContain("zero_snapshot");
    calls.forEach(expectUnproven);
    expectUnknownTotals(hub, resumed ? 3 : 2);
  });

  it.each([
    ["new thread", undefined, "other-thread"],
    ["resume input disagrees with thread event", CODEX_THREAD, "other-thread"],
    ["resume without a thread event", CODEX_THREAD, null],
  ] as const)("does not infer comparable observations from %s", async (_, requestedThread, eventThread) => {
    const { hub, once } = setup();
    await once(reading(codexCumulativeReadings.first));
    await once([...(eventThread ? [{ type: "thread" as const, threadId: eventThread }] : []), done(observed(codexCumulativeReadings.resumed))], requestedThread);
    const call = hub.usageCalls("task").calls[1]!;
    expect(call.threadId).toBe(eventThread ?? requestedThread);
    expect(call.usage.observation?.threadId).toBeNull(); // Outer association is not SDK usage provenance.
    expectUnproven(call);
    expectUnknownTotals(hub, 2);
  });

  it.each([
    ["runtime upgrade", "0.162.1", "0.162.2"],
    ["SDK upgrade", "0.162.2", "0.162.1"],
    ["unknown host runtime", "0.162.1", null],
  ] as const)("retains %s without establishing a compatible baseline", async (_, version, runtimeVersion) => {
    const { hub, once } = setup();
    await once(reading(codexCumulativeReadings.first));
    const next = { ...observed(codexCumulativeReadings.resumed, runtimeVersion), version };
    await once([{ type: "thread", threadId: CODEX_THREAD }, done(next)], CODEX_THREAD, undefined, "task", { ...CODEX_PRODUCER, version, runtimeVersion });
    const call = hub.usageCalls("task").calls[1]!;
    expect(call.producer).toEqual({ ...CODEX_PRODUCER, version, runtimeVersion });
    expect(call.usage.observation).toMatchObject({ version, runtimeVersion });
    expect(call.usage.accountingBlockers).toContain("producer_unverified");
    expect(call.usage.accountingBlockers).toContain("runtime_unverified");
    expectUnproven(call);
    expectUnknownTotals(hub, 2);
  });

  it("records requestedModel separately and never fills the unreported aggregate model or resultId", async () => {
    const { hub, run, context } = setup();
    const agent = asClaude(new FakeAdapter(() => reading(codexCumulativeReadings.first)), CODEX_PRODUCER);
    for await (const _ of run(agent, { prompt: "x", cwd: repo, model: "requested-alias", signal: new AbortController().signal }, context)) { /* drain */ }
    expect(agent.runs[0]?.model).toBe("requested-alias");
    const call = hub.usageCalls("task").calls[0]!;
    expect(call.requestedModel).toBe("requested-alias");
    expect(call.usage.observation).toMatchObject({ resultId: null, models: [], threadAggregate: { model: null } });
    expectUnproven(call);
    expectUnknownTotals(hub, 1);
  });

  it("preserves missing and invalid fields as null, retaining only valid reported counters", async () => {
    const { hub, once } = setup();
    const { cached_input_tokens: _, ...missing } = codexCumulativeReadings.first;
    await once(reading({ ...missing, cache_write_input_tokens: -1, reasoning_output_tokens: Number.MAX_SAFE_INTEGER + 1 }));
    const call = hub.usageCalls("task").calls[0]!;
    expect(call.usage.observation?.threadAggregate?.counters).toEqual({ input: 100, output: 20, cachedInput: null, cacheWriteInput: null, reasoningOutput: null });
    expect(call.usage.accountingBlockers).toContain("incomplete_snapshot");
    expectUnproven(call);
    expectUnknownTotals(hub, 1);
  });

  it("retains input/cache/reasoning buckets separately and never promotes their sum from an unproven snapshot", async () => {
    const { hub, once } = setup();
    await once(reading(codexCumulativeReadings.first));
    const call = hub.usageCalls("task").calls[0]!;
    expect(call.usage.observation?.threadAggregate?.counters).toEqual({ input: 100, cachedInput: 30, cacheWriteInput: 10, output: 20, reasoningOutput: 5 });
    expectUnproven(call); // Neither 140 input nor 25 output is a measured total.
    expectUnknownTotals(hub, 1);
  });

  it("keeps existing inclusive-cache normalization from adding cache or reasoning subsets to their parent buckets", () => {
    // This is the existing fake call contract, not a fabricated trusted Codex observation/model.
    const fixture = structuredClone(fakeUsage);
    fixture.models[0]!.counters = { input: 100, cachedInput: 30, cacheWriteInput: 10, output: 20, reasoningOutput: 5 };
    const usage = normalizeInvocation(fixture, false, null);
    expect(usage.inputInclusiveCache).toBe(100);
    expect(usage.counters).toEqual(fixture.models[0]!.counters);
    expect(usage.counters.output).toBe(20);
  });

  it("002-C: persists aggregate model null and local call identity, with no invented resultId or model breakdown", async () => {
    const { hub, once } = setup();
    await once([...reading(codexCumulativeReadings.first), done(observed(codexCumulativeReadings.first))]);
    await once(reading(codexCumulativeReadings.resumed), CODEX_THREAD);
    const [first, second] = hub.usageCalls("task").calls;
    expect(first!.usage.observation).toMatchObject({ models: [], resultId: null, threadAggregate: { model: null }, localObservation: { callId: first!.callId, sequence: 2 } });
    expect(first!.usage.previousObservation?.localObservation).toEqual({ callId: first!.callId, sequence: 1 });
    expect(second!.usage.observation?.localObservation).toEqual({ callId: second!.callId, sequence: 1 });
    expect(first!.usage.accountingBlockers).toContain("multiple_snapshots");
    // Reading the persisted events again preserves identity; paging never generates a new ID.
    expect(hub.usageCalls("task").calls[0]!.usage.observation?.localObservation).toEqual(first!.usage.observation?.localObservation);
    expectUnknownTotals(hub, 2);
  });

  it("L1: a failed synthetic zero snapshot preserves the earlier Codex observation and retains failure diagnostics", async () => {
    const { hub, run, context } = setup();
    const agent = asClaude(new FakeAdapter(() => [
      ...reading(codexCumulativeReadings.first),
      { type: "done", ok: false, error: "synthetic failure", usage: observed(codexCumulativeReadings.defaultZero) },
    ]), CODEX_PRODUCER);
    const returned: AgentEvent[] = [];
    for await (const event of run(agent, { prompt: "x", cwd: repo, signal: new AbortController().signal }, context)) returned.push(event);
    expect(returned.filter(e => e.type === "done").map(e => e.ok)).toEqual([true, false]);
    const call = hub.usageCalls("task").calls[0]!;
    expect(call).toMatchObject({ status: "failure", failure: "provider", usage: { uncertainty: "unproven_scope", counters: allNull,
      models: [], inputInclusiveCache: null, costUsd: null, baselineEventId: null,
      observation: { threadAggregate: { counters: { input: 100, output: 20 } }, localObservation: { callId: call.callId, sequence: 1 } },
      previousObservation: { threadAggregate: { counters: { input: 0, output: 0, cachedInput: 0, cacheWriteInput: 0, reasoningOutput: 0 } },
        localObservation: { callId: call.callId, sequence: 2 } } } });
    expect(call.usage.interval).toBeUndefined();
    expectUnknownTotals(hub, 1);
  });

  it.each([false, true])("002-C: even a matched thread and verified binary cannot prove counter origin/epoch; resumed=%s", async resumed => {
    const { hub, once } = setup();
    const bound = (raw: unknown, mode: "start" | "resume") => {
      const o = codexUsage(raw, "0.162.1", { mode, id: CODEX_THREAD, binding: "matched" });
      // Synthetic evidence for this guard only. Production does not inherit our manual image probe.
      o.codex!.runtimeVerification = "verified";
      return o;
    };
    if (resumed) await once([{ type: "thread", threadId: CODEX_THREAD }, done(bound(codexCumulativeReadings.first, "start"))]);
    await once([{ type: "thread", threadId: CODEX_THREAD }, done(bound(codexCumulativeReadings.resumed, resumed ? "resume" : "start"))], resumed ? CODEX_THREAD : undefined);
    const call = hub.usageCalls("task").calls.at(-1)!;
    expect(call.usage.observation?.threadId).toBe(CODEX_THREAD);
    expect(call.usage.accountingBlockers).toEqual([resumed ? "counter_epoch_unproven" : "counter_origin_unproven", "writers_untracked"]);
    expectUnproven(call);
    expectUnknownTotals(hub, resumed ? 2 : 1);
  });

  it("002-C: a visible aggregate decrease is diagnostic, never a measured negative delta or a new zero baseline", async () => {
    const { hub, once } = setup();
    const bound = (raw: unknown, mode: "start" | "resume") => codexUsage(raw, "0.162.1", { mode, id: CODEX_THREAD, binding: "matched" });
    await once([{ type: "thread", threadId: CODEX_THREAD }, done(bound(codexCumulativeReadings.afterGap, "start"))]);
    await once([{ type: "thread", threadId: CODEX_THREAD }, done(bound(codexCumulativeReadings.reset, "resume"))], CODEX_THREAD);
    const last = hub.usageCalls("task").calls[1]!;
    expect(last.usage.accountingBlockers).toContain("counter_decrease");
    expectUnproven(last);
    expectUnknownTotals(hub, 2);
  });

  it("002-C: resume without any baseline stays unknown even when the thread matches and the binary version is verified", () => {
    const o = codexUsage(codexCumulativeReadings.resumed, "0.162.1", { mode: "resume", id: CODEX_THREAD, binding: "matched" });
    o.codex!.runtimeVerification = "verified";
    const usage = normalizeInvocation(o, true, null);
    expect(usage).toMatchObject({ uncertainty: "unproven_scope", counters: allNull, models: [], costUsd: null, baselineEventId: null });
    expect(usage.accountingBlockers).toContain("counter_epoch_unproven");
    expect(usage.interval).toBeUndefined();
  });

  it.each(["call", "turn", "session_cumulative"] as const)("002-C: a caller-supplied scope=%s cannot bypass Codex aggregate guards or open a Claude interval", scope => {
    const o = { ...observed(codexCumulativeReadings.first), scope, threadId: CODEX_THREAD, resultId: "forged-provider-result", costUsd: 99,
      models: [{ ...fakeUsage.models[0]!, model: "requested-alias" }] };
    const normal = normalizeInvocation(o, false, null);
    const span = normalizeSpan(o, { kind: "span", from: { eventId: "prior", callId: "prior-call", resultId: null, origin: "thread_start" }, prior: null, between: ["gap"] }, "call", false);
    for (const usage of [normal, span]) {
      expect(usage).toMatchObject({ counters: allNull, models: [], costUsd: null, inputInclusiveCache: null, uncertainty: "unproven_scope" });
      expect(usage.interval).toBeUndefined();
    }
    expect(trustedReading({ usage: normal })).toBe(false);
  });

  it("002-C: legacy Codex observations without optional aggregate/provenance fields remain readable and uncounted", async () => {
    const { hub, once } = setup();
    const legacy = observed(codexCumulativeReadings.first);
    legacy.models = [{ model: null, canonicalModel: null, provider: null, counters: legacy.threadAggregate!.counters }];
    delete legacy.threadAggregate; delete legacy.codex;
    await once([done(legacy)]);
    const call = hub.usageCalls("task").calls[0]!;
    expect(call.usage.observation?.models[0]?.counters.input).toBe(100);
    expect(call.usage.accountingBlockers).toContain("legacy_observation");
    expectUnproven(call);
    expectUnknownTotals(hub, 1);
    // An already persisted pre-002-C record is returned without backfilling any new fields.
    const { eventId: _event, seq: _seq, startedEventId: _start, ...old } = structuredClone(call);
    delete old.usage.accountingBlockers;
    delete old.usage.observation!.localObservation;
    const append = (hub as unknown as { append(task: string, session: string | null, payload: object): unknown }).append.bind(hub);
    append("task", null, { type: "invocation_finished", ...old, callId: "legacy-call" });
    const persisted = hub.usageCalls("task").calls[1]!.usage;
    expect(persisted.observation?.models[0]?.counters.input).toBe(100);
    expect(persisted.accountingBlockers).toBeUndefined();
    expect(persisted.observation?.threadAggregate).toBeUndefined();
    expect(persisted.observation?.codex).toBeUndefined();
    expect(persisted.observation?.localObservation).toBeUndefined();
    expectUnknownTotals(hub, 2);
  });

  it("002-C: Codex observations beside a Claude interval never add another per-call value or interval", async () => {
    const { hub, once, gap } = measured("claude");
    await once([{ type: "thread", threadId: THREAD }, done(claudeObs(TURN1))]);
    await gap();
    await once([{ type: "thread", threadId: THREAD }, done(claudeObs(TURN3))], THREAD);
    const before = hub.usageSummary("task");
    const run = (hub as unknown as { measuredRun: MeasuredRun }).measuredRun.bind(hub);
    const agent = asClaude(new FakeAdapter(() => reading(codexCumulativeReadings.afterGap)), CODEX_PRODUCER);
    for await (const _ of run(agent, { prompt: "x", cwd: repo, signal: new AbortController().signal }, { taskId: "task", sessionId: null, workflow: "chat", provider: "codex", role: "main", purpose: "workflow" })) { /* drain */ }
    const after = hub.usageSummary("task");
    expect(after.counters).toEqual(before.counters);
    expect(after.inputInclusiveCache).toBe(before.inputInclusiveCache);
    expect(after.costUsd).toBe(before.costUsd);
    expect(after.unattributed).toEqual(before.unattributed);
    expect(after.calls).toBe(before.calls + 1);
  });

  // 002-C acceptance rules only: none of these TODOs enables counting in production. The zero
  // baseline must be proven, the runtime independently verified, and aggregate identity represented.
  it.todo("002-C: proven fresh thread and complete non-synthetic snapshot 100 count aggregate 100; resumed-without-baseline 160 stays UNKNOWN");
  it.todo("002-C: verified same-thread SDK/runtime 0.162.1 snapshots 100 -> 160 count 100 then delta 60, total 160");
  it.todo("002-C: 100 -> 160 -> missing -> 200 records per-call 100 + 60 and one interval 40 covering only the gap and final call, total 200");
  it.todo("002-C: replayed 160 within one call is idempotent; a separate proven complete call ending at 160 has delta 0, never another 160");
  it.todo("002-C: 200 -> 30 invalidates the counter epoch; no negative delta, zero baseline or interval bridges the reset");
  it.todo("002-C: default zero without a proven usage update remains UNKNOWN and cannot replace the trusted baseline 200");
  it.todo("002-C: different thread, conflicting thread event, SDK/runtime upgrade or unverified host runtime cannot reuse the baseline");
  it.todo("future transport evidence: deduplicate identified replay without merging distinct calls with equal snapshots; SDK 0.162.1 has no provider resultId");
  it.todo("002-C: missing/invalid fields remain UNKNOWN per field and an unobserved counter reset cannot be inferred from nondecreasing endpoints");
  it.todo("002-C: input 100 includes cache read 30/write 10 and output 20 includes reasoning 5; comparable totals are input 100/output 20, never 140/25");
  it.todo("002-C: a completed reading received before cancellation may close a proven interval; late or missing observations cannot silently overwrite accounting");
});

describe("T6 quota before/after come from one cached snapshot (controlled clock)", () => {
  const T0 = Date.parse("2026-01-01T00:00:00.000Z");

  it("characterization: before and after are the same reading taken minutes before the call, and no fresh read happens", async () => {
    let now = T0;
    const { hub, fake, run, context } = measured("claude", { now: () => now });
    fake.quotaScript = async () => ({ status: "ok", windows: [{ id: "5h", bucket: "session", durationMins: 300, remainingPercent: 40, resetsAt: null }] });
    await hub.quota();
    const reads = fake.quotaCalls;

    now = T0 + 4 * 60_000; // The call starts four minutes after the only reading.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const adapter: AgentAdapter = { kind: "fake", queryQuota: async () => ({ status: "unknown", windows: [] }),
      async *run() { await gate; yield done(); } };
    const pending = (async () => { for await (const _ of run(adapter, { prompt: "x", cwd: repo, signal: new AbortController().signal }, context)) { /* drain */ } })();
    now = T0 + 6 * 60_000; // ...and ends six minutes after it, past the five-minute interval.
    release();
    await pending;

    const call = hub.usageCalls("task").calls[0]!;
    expect(call.quotaBefore.sampledAt).toBe(new Date(T0).toISOString());
    expect(call.quotaAfter.sampledAt).toBe(call.quotaBefore.sampledAt);
    expect(call.quotaAfter.windows).toEqual(call.quotaBefore.windows);
    expect(call.quotaBefore.stale).toBe(false);
    expect(call.quotaAfter.stale).toBe(true);
    expect(fake.quotaCalls).toBe(reads);
    // startedAt/endedAt use the wall clock, not the injected one: the two time bases are not comparable.
    expect(Math.abs(Date.parse(call.startedAt) - T0)).toBeGreaterThan(60 * 60_000);
  });

  it("characterization: two tasks' invocations share one reading, so a quota change cannot be attributed to either", async () => {
    const now = T0;
    const { hub, fake, once } = measured("claude", { now: () => now });
    fake.quotaScript = async () => ({ status: "ok", windows: [{ id: "5h", bucket: "session", durationMins: 300, remainingPercent: 40, resetsAt: null }] });
    await hub.quota();
    await Promise.all([once([done()], undefined, undefined, "task"), once([done()], undefined, undefined, "other")]);
    const a = hub.usageCalls("task").calls[0]!, b = hub.usageCalls("other").calls[0]!;
    expect([a.quotaBefore.sampledAt, a.quotaAfter.sampledAt, b.quotaBefore.sampledAt, b.quotaAfter.sampledAt]).toEqual(Array(4).fill(new Date(T0).toISOString()));
  });

  it.todo("expected (needs a decision): a before/after pair from the same snapshot is labelled as a shared reference, not a per-call measurement");
});
