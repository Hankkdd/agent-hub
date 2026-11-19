import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { TaskUsagePage, InvocationFinal, InvocationStart, TaskEventPayload, UsageObservation } from "@agent-hub/shared";
import { claudeUsage, codexUsage, packageVersion } from "../src/agents/usage";
import { FakeAdapter } from "../src/agents/fake";
import type { AgentAdapter, AgentEvent } from "../src/agents/types";
import { normalizeInvocation } from "../src/core/invocation-usage";
import { Hub } from "../src/core/hub";
import { hostTextBytes, reviewInputDiagnostics, HOST_INPUT_TEXT_LIMIT, HOST_INPUT_REQUEST_LIMIT, type MeasuredRun } from "../src/core/invocations";
import { taskLogEvent } from "../src/core/task-log";
import { createApp } from "../src/app";
import { openDb, schema } from "../src/db";
import { claudeResult, codexResult, fakeUsage } from "./fixtures/usage";

const dirs: string[] = [];
const hubs: Hub[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const hub of hubs.splice(0)) await hub.shutdown(100); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const observation = (n = 100) => claudeUsage(claudeResult(n));
const baseline = (o: UsageObservation) => ({ status: "success", usage: { observation: o }, eventId: "prior" }) as InvocationFinal & { eventId: string };
const collect = async (run: AsyncIterable<AgentEvent>) => { const result = []; for await (const e of run) result.push(e); return result; };
function env(file = ":memory:") {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "usage-test-")); dirs.push(dataDir);
  const db = openDb(file), fake = new FakeAdapter();
  const hub = new Hub({ db, dataDir, agents: { claude: fake, codex: fake, gemini: fake }, maxConcurrent: 4 }); hubs.push(hub);
  const now = new Date().toISOString();
  db.insert(schema.tasks).values({ id: "task", title: "Usage", workflow: "chat", status: "idle", options: {}, createdAt: now, updatedAt: now }).run();
  const internal = hub as unknown as { measuredRun: MeasuredRun; append(task: string, session: string | null, payload: TaskEventPayload): unknown };
  const context = { taskId: "task", sessionId: null, workflow: "chat", provider: "claude", role: "main", purpose: "workflow" } as const;
  return { db, hub, fake, internal, context, dataDir };
}
const scripted = (...events: AgentEvent[]) => new FakeAdapter(() => events);

describe("observe-only Host inputs", () => {
  it.each(["claude", "codex"] as const)("records %s Host candidates without changing first/resumed adapter inputs or storing text", async provider => {
    const { hub, internal, context } = env();
    const adapter = scripted({ type: "done", ok: true });
    for (const threadId of [undefined, "existing-thread"]) {
      const input = { prompt: "private prompt 規劃😀", systemPrompt: "private system", turnContext: "", cwd: "/example",
        signal: new AbortController().signal, threadId, model: "fixture-model", effort: "medium" as const, readOnly: true,
        mcp: { url: "http://example.invalid", token: "private bearer" } };
      await collect(internal.measuredRun(adapter, input, { ...context, provider }));
      expect(adapter.runs.at(-1)).toBe(input);
      expect(input).not.toHaveProperty("hostInput");
      const call = hub.usageCalls("task").calls.at(-1)!;
      expect(call.hostInput).toMatchObject({ version: 1, coverage: "host_text_fields",
        promptUtf8Bytes: Buffer.byteLength(input.prompt, "utf8"), systemPromptCandidateUtf8Bytes: 14, turnContextUtf8Bytes: 0 });
      expect(call.resumed).toBe(!!threadId);
      expect(call.usage.observation).toBeNull();
      expect(call.usage.counters.input).toBeNull();
      const start = hub.events("task").find(e => e.type === "invocation_started" && e.callId === call.callId)!;
      expect(start.type === "invocation_started" && start.hostInput).toEqual(call.hostInput);
      expect(taskLogEvent(start, true, null)).not.toContain("hostInput");
    }
    const persisted = JSON.stringify(hub.events("task"));
    for (const text of ["private prompt", "private system", "private bearer", "/example"]) expect(persisted).not.toContain(text);
    expect(persisted).not.toMatch(/wireBytes|estimatedTokens|contextWindow/);
    expect(adapter.runs).toHaveLength(2);
  });

  it("bounds text and request work, keeps missing values unknown, and does not truncate actual inputs", async () => {
    expect(hostTextBytes(undefined)).toBeNull(); expect(hostTextBytes("")).toBe(0);
    expect(hostTextBytes("😀")).toBe(4);
    expect(hostTextBytes("x".repeat(HOST_INPUT_TEXT_LIMIT))).toBe(HOST_INPUT_TEXT_LIMIT);
    const { hub, internal, context } = env();
    const input = { prompt: "x".repeat(HOST_INPUT_TEXT_LIMIT + 1), cwd: "/example", signal: new AbortController().signal };
    const adapter = scripted({ type: "done", ok: true });
    await collect(internal.measuredRun(adapter, input, context));
    expect(adapter.runs[0]).toBe(input);
    expect(hub.usageCalls("task").calls[0]?.hostInput).toMatchObject({ promptUtf8Bytes: null, systemPromptCandidateUtf8Bytes: null, turnContextUtf8Bytes: null });
    const tooMany = reviewInputDiagnostics("s", Array(HOST_INPUT_REQUEST_LIMIT + 1).fill("x"), "diff");
    expect(tooMany.metadata.requestsUtf8Bytes).toBeNull();
    expect(tooMany.metadata.requestsComparison).toBe("unknown");
    const tooLarge = reviewInputDiagnostics("s", [input.prompt], input.prompt);
    expect(tooLarge.metadata).toMatchObject({ requestsUtf8Bytes: null, suppliedDiffUtf8Bytes: null,
      requestsComparison: "unknown", suppliedDiffComparison: "unknown" });
  });

  it.each([
    { limit: "request count", requests: Array(HOST_INPUT_REQUEST_LIMIT + 1).fill("request") as string[] },
    { limit: "individual request text", requests: ["x".repeat(HOST_INPUT_TEXT_LIMIT + 1)] },
    { limit: "total request text", requests: Array(2).fill("x".repeat(HOST_INPUT_TEXT_LIMIT / 2 + 1)) as string[] },
  ])("preserves Diff comparisons when $limit exceeds the diagnostic budget", ({ requests }) => {
    const prior = reviewInputDiagnostics("reviewer", ["request"], "diff");
    for (const [diff, comparison] of [["diff", "same"], ["changed diff", "changed"]] as const) {
      const observed = reviewInputDiagnostics("reviewer", requests, diff, prior.basis);
      expect(observed.metadata).toMatchObject({ requestsUtf8Bytes: null, requestsComparison: "unknown",
        suppliedDiffUtf8Bytes: Buffer.byteLength(diff), suppliedDiffComparison: comparison });
      expect(observed.basis.requests).toBeNull();
      expect(observed.basis.diff).not.toBeNull();
      expect(reviewInputDiagnostics("reviewer", requests, diff, observed.basis).metadata.suppliedDiffComparison).toBe("same");
    }
  });

  it.each(["request", "changed request"])("preserves comparisons for '%s' when Diff exceeds the diagnostic budget", request => {
    const prior = reviewInputDiagnostics("reviewer", ["request"], "diff");
    const observed = reviewInputDiagnostics("reviewer", [request], "x".repeat(HOST_INPUT_TEXT_LIMIT + 1), prior.basis);
    expect(observed.metadata).toMatchObject({ requestsUtf8Bytes: Buffer.byteLength(request),
      requestsComparison: request === "request" ? "same" : "changed", suppliedDiffUtf8Bytes: null, suppliedDiffComparison: "unknown" });
    expect(observed.basis.requests).not.toBeNull();
    expect(observed.basis.diff).toBeNull();
  });

  it("compares only bounded Review fragments in the same loop/session without persisting fingerprints", async () => {
    const a = reviewInputDiagnostics("reviewer", ["ab", "c"], "visible diff\n… (diff truncated: 100 more characters; read the files for the rest)");
    expect(a.metadata.requestsComparison).toBe("unknown");
    const same = reviewInputDiagnostics("reviewer", ["ab", "c"], "visible diff\n… (diff truncated: 100 more characters; read the files for the rest)", a.basis);
    expect(same.metadata).toMatchObject({ requestsUtf8Bytes: 3, requestsComparison: "same", suppliedDiffComparison: "same", diffCoverage: "supplied_bounded_text" });
    const changed = reviewInputDiagnostics("reviewer", ["a", "bc"], "different", a.basis);
    expect(changed.metadata).toMatchObject({ requestsComparison: "changed", suppliedDiffComparison: "changed" });
    expect(reviewInputDiagnostics("other-session", ["ab", "c"], "different", a.basis).metadata).toMatchObject({ requestsComparison: "unknown", suppliedDiffComparison: "unknown" });
    expect(reviewInputDiagnostics("reviewer", ["ab", "c"], "different").metadata.suppliedDiffComparison).toBe("unknown");
    const { hub, internal, context } = env();
    await collect(internal.measuredRun(scripted({ type: "done", ok: true }), { prompt: "x", cwd: "/example", signal: new AbortController().signal },
      { ...context, inputDiagnostics: { review: { ...same.metadata, ...same.basis, secret: "private diagnostic canary" } } } as Parameters<MeasuredRun>[2]));
    const persisted = JSON.stringify(hub.events("task"));
    for (const secret of [a.basis.requests!, a.basis.diff!, "private diagnostic canary", "visible diff"]) expect(persisted).not.toContain(secret);
    expect(hub.usageCalls("task").calls[0]?.hostInput?.components?.review).toEqual(same.metadata);
  });

  it("continues the original invocation if diagnostic byte calculation or component access fails", async () => {
    const { hub, internal, context } = env();
    const adapter = scripted({ type: "done", ok: true });
    const input = { prompt: "original", cwd: "/example", signal: new AbortController().signal };
    const broken = Object.defineProperty({}, "projectBootstrap", { get() { throw new Error("private diagnostic error"); } });
    await collect(internal.measuredRun(adapter, input, { ...context, inputDiagnostics: broken }));
    const spy = vi.spyOn(Buffer, "byteLength").mockImplementation(() => { throw new Error("private byte error"); });
    try {
      expect(reviewInputDiagnostics("reviewer", ["request"], "diff").metadata).toMatchObject({
        requestsUtf8Bytes: null, suppliedDiffUtf8Bytes: null, requestsComparison: "unknown", suppliedDiffComparison: "unknown" });
      await collect(internal.measuredRun(adapter, input, context));
    } finally { spy.mockRestore(); }
    expect(adapter.runs).toEqual([input, input]);
    expect(hub.usageCalls("task").calls.map(c => c.status)).toEqual(["success", "success"]);
    expect(hub.usageCalls("task").calls[1]?.hostInput?.promptUtf8Bytes).toBeNull();
    expect(JSON.stringify(hub.events("task"))).not.toContain("private");
  });

  it("retains start diagnostics on interruption recovery once without recomputing or invoking a model", async () => {
    const { hub, db, internal, context } = env();
    const adapter = scripted({ type: "done", ok: true });
    await collect(internal.measuredRun(adapter, { prompt: "é", cwd: "/example", signal: new AbortController().signal }, context));
    const original = hub.usageCalls("task").calls[0]!.hostInput;
    db.delete(schema.events).where(eq(schema.events.type, "invocation_finished")).run();
    hub.recoverInterrupted(); hub.recoverInterrupted();
    expect(hub.usageCalls("task").calls).toHaveLength(1);
    expect(hub.usageCalls("task").calls[0]).toMatchObject({ status: "interrupted", hostInput: original });
    expect(adapter.runs).toHaveLength(1);
  });
});

describe("pinned producer normalization", () => {
  it("verifies installed versions and separates Claude fresh/cache/reasoning buckets and main-loop observations", () => {
    expect(packageVersion("@anthropic-ai/claude-agent-sdk")).toBe("0.3.296");
    expect(packageVersion("@openai/codex-sdk")).toBe("0.162.1");
    const o = observation();
    const u = normalizeInvocation(o, false, null);
    expect(u.counters).toEqual({ input: 100, output: 20, cachedInput: 30, cacheWriteInput: 40, reasoningOutput: 5 });
    expect(u.inputInclusiveCache).toBe(170);
    expect(u.counters.output).toBe(20); // Thinking is already inside output.
    expect(u.costUsd).toBe(0.1);
    expect(u.observation?.mainLoop?.input).toBe(100); // Retained, never added to model accounting.
    expect(u.partial).toBe(true); // Classifier/probes remain outside pipeline coverage.
  });
  it("derives only compatible per-model, per-field cumulative deltas", () => {
    const a = observation(100), b = observation(150);
    b.models[0]!.counters.output = 30;
    b.models.push({ model: "new-model", canonicalModel: null, provider: null, counters: { input: 2, output: 2, cachedInput: 0, cacheWriteInput: 0, reasoningOutput: null } });
    const u = normalizeInvocation(b, true, baseline(a));
    expect(u.models[0]?.counters).toEqual({ input: 50, output: 10, cachedInput: 0, cacheWriteInput: 0, reasoningOutput: null });
    expect(u.models[1]?.counters.input).toBeNull(); // No baseline for this model.
    expect(u.counters.input).toBeNull();
    expect(u.baselineEventId).toBe("prior");
  });
  it("keeps missing, invalid and unsafe values unknown; known zero and null USD stay distinct", () => {
    const o = claudeUsage(claudeResult(0, { total_cost_usd: null, modelUsage: { m: { inputTokens: 0, outputTokens: -1,
      cacheReadInputTokens: 1.5, cacheCreationInputTokens: Number.MAX_SAFE_INTEGER + 1, thinkingTokens: "9", secret: "do not retain" } } }));
    expect(o.models[0]?.counters).toEqual({ input: 0, output: null, cachedInput: null, cacheWriteInput: null, reasoningOutput: null });
    expect(normalizeInvocation(o, false, null).costUsd).toBeNull();
    expect(JSON.stringify(o)).not.toContain("secret");
    expect(claudeUsage({ modelUsage: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`m${i}`, {}])) }).models).toHaveLength(16);
  });
  it.each(["loss", "thread", "version", "runtime", "coverage", "model"])("rejects a missing/incompatible baseline: %s", kind => {
    const a = observation(), b = observation(150);
    if (kind === "thread") a.threadId = "another-session";
    if (kind === "version") a.version = "older";
    if (kind === "runtime") a.runtimeVersion = "older";
    if (kind === "coverage") a.coverage = "producer_reported_unknown";
    if (kind === "model") a.models[0]!.canonicalModel = "other";
    const u = normalizeInvocation(b, true, kind === "loss" ? null : baseline(a));
    expect(u.counters.input).toBeNull(); expect(u.observation?.models[0]?.counters.input).toBe(150);
  });
  it("never returns a negative delta and keeps unaffected fields", () => {
    const u = normalizeInvocation(observation(50), true, baseline(observation(100)));
    expect(u.counters.input).toBeNull(); expect(u.counters.output).toBe(0);
    expect(u.uncertainty).toBe("counter_reset"); expect(u.costUsd).toBeNull();
  });
  it("keeps call totals unknown when cumulative models disappear or the model set is truncated", () => {
    const previous = observation();
    previous.models.push({ ...previous.models[0]!, model: "missing-model" });
    const current = observation(150);
    const missing = normalizeInvocation(current, true, baseline(previous));
    expect(missing.counters.input).toBeNull();
    expect(missing.inputInclusiveCache).toBeNull();
    expect(missing.models[0]?.counters.input).toBe(50);
    current.truncated = true;
    const truncated = normalizeInvocation(current, false, null);
    expect(truncated.counters.input).toBeNull();
    expect(truncated.models[0]?.counters.input).toBe(150);
  });
  it("does not assume Codex resumed, first or repeated result semantics from the SDK declaration", () => {
    const o = codexUsage(codexResult, "0.162.1");
    expect(o.threadAggregate?.counters).toMatchObject({ input: 100, cachedInput: 30, cacheWriteInput: null, reasoningOutput: null });
    expect(o.models).toEqual([]);
    for (const resumed of [true, false]) {
      const u = normalizeInvocation(o, resumed, baseline(o));
      expect(u.counters.input).toBeNull(); expect(u.uncertainty).toBe("unproven_scope");
    }
  });
});

describe("durable invocation lifecycle and API", () => {
  it.each([0, null])("retains useful consumption before an empty failure observation with USD=%s", async cost => {
    const { hub, internal, context } = env();
    const empty = claudeUsage(claudeResult(0, { uuid: "empty-failure", modelUsage: {}, usage: {}, total_cost_usd: cost }));
    await collect(internal.measuredRun(scripted(
      { type: "done", ok: true, usage: observation() }, { type: "done", ok: false, usage: empty },
    ), { prompt: "x", cwd: "/example", signal: new AbortController().signal }, context));
    const call = hub.usageCalls("task").calls[0]!;
    expect(call).toMatchObject({ status: "failure", usage: { counters: { input: 100 }, previousObservation: { models: [], costUsd: cost } } });
    expect(hub.usageSummary("task").counters.input).toBe(100);
  });
  it("does not count an empty zeroed startup failure as measured zero USD", async () => {
    const { hub, internal, context } = env();
    const empty = claudeUsage(claudeResult(0, { modelUsage: {}, usage: {} }));
    await collect(internal.measuredRun(scripted({ type: "done", ok: false, usage: empty }),
      { prompt: "x", cwd: "/example", signal: new AbortController().signal }, context));
    expect(hub.usageCalls("task").calls[0]?.usage).toMatchObject({ costUsd: null, observation: { costUsd: 0 } });
  });
  it("deduplicates an older repeated result without losing the latest cumulative observation", async () => {
    const { hub, internal, context } = env();
    await collect(internal.measuredRun(scripted(
      { type: "done", ok: true, usage: observation(100) }, { type: "done", ok: true, usage: observation(150) },
      { type: "done", ok: true, usage: observation(100) },
    ), { prompt: "x", cwd: "/example", signal: new AbortController().signal }, context));
    expect(hub.usageCalls("task").calls).toHaveLength(1);
    expect(hub.usageCalls("task").calls[0]?.usage).toMatchObject({ counters: { input: 150 }, observation: { resultId: "result-150" } });
    expect(hub.usageSummary("task").counters.input).toBe(150);
  });
  it("keeps bounded evidence but excludes totals when result identity coverage exceeds its budget", async () => {
    const { hub, internal, context } = env();
    await collect(internal.measuredRun(scripted(...Array.from({ length: 129 }, (_, i): AgentEvent =>
      ({ type: "done", ok: true, usage: observation(i + 1) }))),
    { prompt: "x", cwd: "/example", signal: new AbortController().signal }, context));
    expect(hub.usageCalls("task").calls[0]?.usage).toMatchObject({ counters: { input: null }, uncertainty: "unproven_scope", observation: { resultId: "result-129" } });
    expect(hub.usageSummary("task").counters.input).toBeNull();
    await collect(internal.measuredRun(scripted({ type: "done", ok: true, usage: observation(150) }),
      { prompt: "x", cwd: "/example", signal: new AbortController().signal, threadId: "sdk-session" }, context));
    expect(hub.usageCalls("task").calls[1]?.usage).toMatchObject({ counters: { input: null }, uncertainty: "incompatible_baseline" });
  });
  it("detects a cumulative USD reset within an invocation even when token counters increase", async () => {
    const { hub, internal, context } = env();
    const next = observation(150); next.costUsd = 0.01;
    await collect(internal.measuredRun(scripted({ type: "done", ok: true, usage: observation() }, { type: "done", ok: true, usage: next }),
      { prompt: "x", cwd: "/example", signal: new AbortController().signal }, context));
    expect(hub.usageCalls("task").calls[0]?.usage).toMatchObject({ costUsd: null, uncertainty: "counter_reset", observation: { costUsd: 0.01 } });
  });
  it("persists before invocation, collapses repeated cumulative results and keeps useful data before a zeroed error", async () => {
    const { hub, internal, context } = env();
    const adapter = scripted({ type: "thread", threadId: "sdk-session" }, { type: "done", ok: true, usage: observation() },
      { type: "done", ok: true, usage: observation() }, { type: "done", ok: false, usage: claudeUsage(claudeResult(0, { modelUsage: { m: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, thinkingTokens: 0 } } })) });
    await collect(internal.measuredRun(adapter, { prompt: "private prompt", cwd: "/example", signal: new AbortController().signal }, context));
    const page = hub.usageCalls("task");
    expect(page.calls).toHaveLength(1);
    expect(page.calls[0]).toMatchObject({ status: "failure", usage: { counters: { input: 100 }, previousObservation: { costUsd: 0 } } });
    expect(hub.events("task").map(e => e.type)).toEqual(["invocation_started", "invocation_finished"]);
    expect(JSON.stringify(page)).not.toContain("private prompt");
  });
  it("keeps startup-zero errors unknown and retains reported partial usage on cancellation", async () => {
    const { hub, internal, context } = env();
    const zero = claudeUsage(claudeResult(0, { modelUsage: { m: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } } }));
    const input = { prompt: "x", cwd: "/example", signal: new AbortController().signal };
    await collect(internal.measuredRun(scripted({ type: "done", ok: false, usage: zero }), input, context));
    expect(hub.usageCalls("task").calls[0]?.usage).toMatchObject({ counters: { input: null }, observation: { costUsd: 0 } });
    const ac = new AbortController();
    const adapter = scripted({ type: "done", ok: true, usage: observation() }, { type: "text_start" });
    await expect((async () => {
      for await (const event of internal.measuredRun(adapter, { ...input, signal: ac.signal }, context)) if (event.type === "done") ac.abort();
    })()).rejects.toThrow(/aborted/);
    expect(hub.usageCalls("task").calls[1]).toMatchObject({ status: "cancelled", usage: { counters: { input: 100 } } });
    await hub.deleteTask("task");
    expect(hub.listTasks()).toHaveLength(0);
  });
  it("uses durable baselines after recreating Hub and treats lost baselines as unknown", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "usage-restart-")); dirs.push(directory);
    const filename = path.join(directory, "hub.db");
    const { db, hub, internal, context, dataDir } = env(filename);
    const input = { prompt: "x", cwd: "/example", signal: new AbortController().signal };
    await collect(internal.measuredRun(scripted({ type: "done", ok: true, usage: observation() }), input, context));
    const restarted = new Hub({ db: openDb(filename), dataDir, agents: {}, maxConcurrent: 4 }); hubs.push(restarted);
    const run = (restarted as unknown as { measuredRun: MeasuredRun }).measuredRun.bind(restarted);
    await collect(run(scripted({ type: "done", ok: true, usage: observation(150) }), { ...input, threadId: "sdk-session" }, context));
    expect(hub.usageCalls("task").calls[1]?.usage.counters.input).toBe(50);
    db.delete(schema.events).where(eq(schema.events.type, "invocation_finished")).run();
    await collect(run(scripted({ type: "done", ok: true, usage: observation(200) }), { ...input, threadId: "sdk-session" }, context));
    expect(hub.usageCalls("task").calls[0]?.usage).toMatchObject({ uncertainty: "missing_baseline", counters: { input: null } });
  });
  it("enforces identity in SQLite, permits start/final sharing identity, and recovers interruption once", () => {
    const { db, hub, internal, context } = env();
    const start: InvocationStart = { ...context, callId: "crashed-call", round: null, operationId: null, requestedModel: null, effort: null,
      producer: { source: "fixture", version: "1", runtimeVersion: "1" }, startedAt: new Date().toISOString(), resumed: false,
      quotaBefore: { status: "unknown", sampledAt: null, stale: true, windows: [] } };
    internal.append("task", null, { type: "invocation_started", ...start });
    internal.append("task", null, { type: "invocation_started", ...start }); // Boundary retry is idempotent.
    const row = db.select().from(schema.events).get()!;
    expect(() => db.insert(schema.events).values({ ...row, id: "duplicate", seq: row.seq + 1 }).run()).toThrow(/UNIQUE/);
    hub.recoverInterrupted(); hub.recoverInterrupted();
    expect(hub.usageCalls("task").calls).toHaveLength(1);
    expect(hub.usageCalls("task").calls[0]).toMatchObject({ status: "interrupted", failure: "restart", usage: { counters: { input: null } } });
    expect(hub.usageCalls("task").calls[0]).not.toHaveProperty("hostInput");
    expect(hub.usageSummary("task").activeCalls).toBe(0);
  });
  it("closes thrown streams, consumer exits, aborts and quota failures without raw errors", async () => {
    const { hub, internal, context } = env();
    const input = { prompt: "secret", cwd: "/example", signal: new AbortController().signal };
    const thrown: AgentAdapter = { kind: "fake", queryQuota: async () => ({ status: "unknown", windows: [] }),
      async *run() { throw new Error("secret provider error"); } };
    await expect(collect(internal.measuredRun(thrown, input, context))).rejects.toThrow("secret provider error");
    for await (const _ of internal.measuredRun(scripted({ type: "text_start" }, { type: "done", ok: true }), input, context)) break;
    const ac = new AbortController();
    const held = new FakeAdapter(); held.hold(0);
    const running = collect(internal.measuredRun(held, { ...input, signal: ac.signal }, context));
    await new Promise(r => setTimeout(r, 0));
    ac.abort(); await expect(running).rejects.toThrow(); held.release();
    await collect(internal.measuredRun(scripted({ type: "done", ok: false, error: "usage limit secret" }), input, context));
    expect(hub.usageCalls("task").calls.map(c => c.status)).toEqual(["failure", "interrupted", "cancelled", "usage_limit"]);
    expect(hub.usageCalls("task").calls.every(c => c.hostInput?.promptUtf8Bytes === 6)).toBe(true);
    expect(JSON.stringify(hub.usageCalls("task"))).not.toContain("secret");
  });
  it("closes an abandoned pending next on abort and never accepts a late result", async () => {
    const { hub, internal, context } = env();
    const ac = new AbortController();
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const adapter: AgentAdapter = { kind: "fake", queryQuota: async () => ({ status: "unknown", windows: [] }), async *run() { await gate; yield { type: "done", ok: true, usage: observation() }; } };
    const pending = collect(internal.measuredRun(adapter, { prompt: "x", cwd: "/example", signal: ac.signal }, context));
    ac.abort();
    expect(hub.usageSummary("task").calls).toBe(1);
    release(); await pending;
    expect(hub.usageSummary("task").calls).toBe(1);
    expect(hub.usageCalls("task").calls[0]?.usage.observation).toBeNull();
  });
  it("authenticates, validates and bounds detail pages while aggregating the full task", async () => {
    const { hub, internal, context } = env();
    const input = { prompt: "sensitive", cwd: "/example", signal: new AbortController().signal };
    for (let i = 0; i < 23; i++) await collect(internal.measuredRun(scripted({ type: "done", ok: true, usage: observation(0) }), input, context));
    const app = createApp(hub, "test-token"), headers = { Authorization: "Bearer test-token" };
    expect((await app.request("/api/tasks/task/usage")).status).toBe(401);
    expect((await app.request("/api/tasks/task/usage/calls")).status).toBe(401);
    for (const query of ["limit=0", "limit=101", "limit=1.2", "after=-1", "after=NaN", "after=9007199254740992"]) expect((await app.request(`/api/tasks/task/usage/calls?${query}`, { headers })).status).toBe(400);
    const summary = await (await app.request("/api/tasks/task/usage", { headers })).json();
    expect(summary).toMatchObject({ calls: 23, counters: { input: 0 }, costUsd: 0 });
    const first = await (await app.request("/api/tasks/task/usage/calls", { headers })).json() as TaskUsagePage;
    expect(first.calls).toHaveLength(20);
    const second = await (await app.request(`/api/tasks/task/usage/calls?after=${first.nextCursor}`, { headers })).json() as TaskUsagePage;
    expect(second.calls).toHaveLength(3); expect(second.nextCursor).toBeNull();
    expect(new Set([...first.calls, ...second.calls].map(c => c.callId)).size).toBe(23);
    expect(JSON.stringify(first)).not.toContain("sensitive");
    expect((await app.request("/api/tasks/missing/usage", { headers })).status).toBe(404);
  });
  it("keeps known per-model subtotals when a resumed model has no baseline", async () => {
    const { hub, internal, context } = env();
    const input = { prompt: "x", cwd: "/example", signal: new AbortController().signal };
    await collect(internal.measuredRun(scripted({ type: "done", ok: true, usage: observation() }), input, context));
    const next = observation(150);
    next.models.push({ model: "new-model", canonicalModel: null, provider: null, counters: { input: 999, output: 2, cachedInput: 0, cacheWriteInput: 0, reasoningOutput: null } });
    await collect(internal.measuredRun(scripted({ type: "done", ok: true, usage: next }), { ...input, threadId: "sdk-session" }, context));
    expect(hub.usageCalls("task").calls[1]?.usage.counters.input).toBeNull();
    expect(hub.usageSummary("task")).toMatchObject({ calls: 2, partial: true, counters: { input: 150, output: 20 }, inputInclusiveCache: 220 });
  });
  it("labels mixed provider input buckets and adds inclusive cache only once", async () => {
    const { hub, internal, context } = env();
    const input = { prompt: "x", cwd: "/example", signal: new AbortController().signal };
    await collect(internal.measuredRun(scripted({ type: "done", ok: true, usage: observation() }), input, context));
    await collect(internal.measuredRun(scripted({ type: "done", ok: true, usage: structuredClone(fakeUsage) }), input, { ...context, provider: "codex" }));
    expect(hub.usageSummary("task")).toMatchObject({ calls: 2, inputInclusiveCache: 180, counters: { input: null, output: 22, cachedInput: 34 } });
  });
  it("does not infer legacy cost, usage or Gemini tokens, and never queries quota for measurement", async () => {
    const { hub, internal, fake, context } = env();
    internal.append("task", null, { type: "turn_result", ok: true, costUsd: 99 });
    expect(hub.usageSummary("task")).toMatchObject({ recorded: false, calls: 0, costUsd: null, counters: { input: null } });
    await collect(internal.measuredRun(fake, { prompt: "x", cwd: "/example", signal: new AbortController().signal }, { ...context, provider: "gemini" }));
    expect(fake.quotaCalls).toBe(0);
    expect(hub.usageCalls("task").calls[0]).toMatchObject({ provider: "gemini", usage: { availability: "unavailable", counters: { input: null } }, quotaBefore: { sampledAt: null }, quotaAfter: { sampledAt: null } });
  });
});
