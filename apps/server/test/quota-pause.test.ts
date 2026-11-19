import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activeMainSession, type AgentKind, type QuotaReading, type QuotaResponse } from "@agent-hub/shared";
import { FakeAdapter, type FakeStep } from "../src/agents/fake";
import type { AgentRunInput } from "../src/agents/types";
import { Hub } from "../src/core/hub";
import { openDb, type Db } from "../src/db/index";
import { notifyDiscord } from "../src/notify/discord";

let root: string;
let db: Db;
let hubs: Hub[];
let clock: number;
const LIMIT = "You've hit your usage limit.";
const exhaustedAt = (resetsAt: string): QuotaReading => ({ status: "ok", windows: [{ id: "w", bucket: "Weekly", durationMins: null, remainingPercent: 0, resetsAt }] });
const available = (): QuotaReading => ({ status: "ok", windows: [{ id: "w", bucket: "Main", durationMins: null, remainingPercent: 80, resetsAt: null }] });
const reset = () => new Date(clock + 3_600_000).toISOString();
const summary = { goals: "目標 #1", decisions: "已同意 #1", constraints: "範圍限制 #1", completed: "完成證據 #1", pending: "待辦 #1", uncertainty: "推論與待驗證 #1", references: [1] };

/** Fails with a usage limit on the listed run numbers and answers normally otherwise. */
function limited(...failing: number[]): FakeAdapter {
  const agent = new FakeAdapter((_input: AgentRunInput, n: number): FakeStep[] => failing.includes(n)
    ? [{ type: "done", ok: false, error: LIMIT }]
    : [{ type: "thread", threadId: `t-${n}` }, { type: "text_delta", text: `ok ${n}` }, { type: "done", ok: true }]);
  agent.quotaScript = async () => exhaustedAt(reset());
  return agent;
}

function makeHub(agents: Partial<Record<AgentKind, FakeAdapter>>, database = db): Hub {
  const hub = new Hub({ db: database, dataDir: root, maxConcurrent: 4, flushMs: 1, now: () => clock, agents });
  hubs.push(hub);
  return hub;
}

const chat = (message: string, agent: AgentKind = "claude") => ({ title: "", workflow: "chat" as const, agent, message });

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-hub-pause-"));
  db = openDb(":memory:");
  hubs = [];
  clock = Date.now();
});
afterEach(async () => {
  await Promise.all(hubs.map((hub) => hub.shutdown(50)));
  fs.rmSync(root, { recursive: true, force: true });
});

describe("quota pause", () => {
  it("still pauses when the SDK throws a generic exit error after reporting the usage limit", async () => {
    // Codex SDK shape: a failed turn with the limit message, then "Codex Exec exited with code 1".
    const agent = limited();
    agent.run = async function* () {
      yield { type: "done" as const, ok: false, error: LIMIT };
      throw new Error("Codex Exec exited with code 1: Reading prompt from stdin...");
    };
    const hub = makeHub({ claude: agent });
    const task = await hub.createTask(chat("go"));
    await hub.settled(task.id);
    expect(hub.getTask(task.id).status).toBe("paused");
    expect(hub.getTask(task.id).options.quotaPause).toMatchObject({ agent: "claude", resetsAt: reset() });
  });

  it("pauses on a usage limit and still fails on other errors", async () => {
    const agent = limited(1);
    const hub = makeHub({ claude: agent });
    const task = await hub.createTask(chat("go"));
    await hub.settled(task.id);
    const paused = hub.getTask(task.id);
    expect(paused.status).toBe("paused");
    expect(paused.options.quotaPause).toMatchObject({ agent: "claude", resetsAt: reset() });
    expect(hub.events(task.id).find((e) => e.type === "status_change" && e.to === "paused")).toMatchObject({ reason: expect.stringContaining("Claude usage limit reached") });

    const other = makeHub({ claude: new FakeAdapter(() => [{ type: "done", ok: false, error: "boom" }]) }, openDb(":memory:"));
    const failed = await other.createTask(chat("go"));
    await other.settled(failed.id);
    expect(other.getTask(failed.id).status).toBe("failed");
  });

  it("queues messages while paused and runs them once, after the reset", async () => {
    const agent = limited(1);
    const hub = makeHub({ claude: agent });
    const task = await hub.createTask(chat("go"));
    await hub.settled(task.id);
    hub.sendMessage(task.id, "while waiting");
    await hub.settled(task.id);
    expect(agent.runs).toHaveLength(1);
    expect(hub.events(task.id).find((e) => e.type === "user_message" && e.text === "while waiting")).toMatchObject({ queued: true });

    await hub.resumeDue();
    expect(hub.getTask(task.id).status).toBe("paused");
    clock += 3_600_001;
    await Promise.all([hub.resumeDue(), hub.resumeDue()]);
    await hub.settled(task.id);
    expect(agent.runs.map((r) => r.prompt)).toEqual(["go", "while waiting"]);
    expect(agent.runs[1]!.threadId).toBeUndefined();
    expect(hub.getTask(task.id)).toMatchObject({ status: "idle" });
    expect(hub.getTask(task.id).options.quotaPause).toBeUndefined();
    await hub.resumeDue();
    expect(agent.runs).toHaveLength(2);
  });

  it("continues the same conversation when nothing was queued", async () => {
    const agent = limited(1);
    const hub = makeHub({ claude: agent });
    const task = await hub.createTask(chat("go"));
    await hub.settled(task.id);
    clock += 3_600_001;
    await hub.resumeDue();
    await hub.settled(task.id);
    expect(agent.runs).toHaveLength(2);
    expect(agent.runs[1]!.prompt).toContain("Continue the task from where you left off");
    expect(hub.events(task.id).some((e) => e.type === "status_change" && e.from === "paused" && e.to === "idle" && e.reason === "Quota reset estimate reached; retrying")).toBe(true);
    expect(hub.getTask(task.id).status).toBe("idle");
  });

  it("pauses again when the resumed turn hits the limit, without a retry loop", async () => {
    const agent = limited(1, 2);
    const hub = makeHub({ claude: agent });
    const task = await hub.createTask(chat("go"));
    await hub.settled(task.id);
    clock += 3_600_001;
    await hub.resumeDue();
    await hub.settled(task.id);
    expect(hub.getTask(task.id)).toMatchObject({ status: "paused", options: { quotaPause: { resetsAt: reset() } } });
    await hub.resumeDue();
    await hub.settled(task.id);
    expect(agent.runs).toHaveLength(2);
  });

  it("resumes a pause with an unknown reset only when a fresh reading shows the agent is back", async () => {
    let remaining = 0;
    const agent = new FakeAdapter((_i, n) => n === 1 ? [{ type: "done", ok: false, error: LIMIT }] : [{ type: "done", ok: true }]);
    agent.quotaScript = async () => ({ status: "ok", windows: [{ id: "w", bucket: "Weekly", durationMins: null, remainingPercent: remaining, resetsAt: null }] });
    const hub = makeHub({ claude: agent });
    const task = await hub.createTask(chat("go"));
    await hub.settled(task.id);
    expect(hub.getTask(task.id).options.quotaPause?.resetsAt).toBeNull();
    await hub.resumeDue();
    expect(hub.getTask(task.id).status).toBe("paused");
    remaining = 80;
    clock += 300_000; // ordinary shared-cache refresh deadline
    await hub.resumeDue();
    await hub.settled(task.id);
    expect(agent.runs).toHaveLength(2);
    expect(hub.getTask(task.id).status).toBe("idle");
  });

  it("continues now on request and rejects it for tasks that are not paused", async () => {
    const agent = limited(1);
    const hub = makeHub({ claude: agent });
    const task = await hub.createTask(chat("go"));
    await hub.settled(task.id);
    hub.continueNow(task.id);
    await hub.settled(task.id);
    expect(agent.runs).toHaveLength(2);
    expect(hub.getTask(task.id).status).toBe("idle");
    expect(() => hub.continueNow(task.id)).toThrow(/not waiting/);
    expect(() => hub.stopWaiting(task.id)).toThrow(/not waiting/);
  });

  it("stops waiting without running anything and keeps queued messages", async () => {
    const agent = limited(1);
    const hub = makeHub({ claude: agent });
    const task = await hub.createTask(chat("go"));
    await hub.settled(task.id);
    hub.sendMessage(task.id, "later");
    hub.stopWaiting(task.id);
    await hub.settled(task.id);
    expect(hub.getTask(task.id)).toMatchObject({ status: "idle" });
    expect(hub.getTask(task.id).options.quotaPause).toBeUndefined();
    expect(agent.runs).toHaveLength(1);
    clock += 3_600_001;
    await hub.resumeDue();
    expect(agent.runs).toHaveLength(1);
    hub.sendMessage(task.id, "next");
    await hub.settled(task.id);
    expect(agent.runs[1]!.prompt).toBe("later\n\nnext");
  });

  it("leaves the pause when the agent is switched and runs the queued messages there", async () => {
    const claude = limited(1);
    const codex = new FakeAdapter((i, n) => i.toolsDisabled
      ? [{ type: "text_delta", text: JSON.stringify(summary) }, { type: "done", ok: true }]
      : [{ type: "text_delta", text: `codex ${n}` }, { type: "done", ok: true }]);
    const hub = makeHub({ claude, codex });
    const task = await hub.createTask(chat("go"));
    await hub.settled(task.id);
    hub.sendMessage(task.id, "carry on please");
    await hub.switchAgent(task.id, { target: "codex", expectedSessionId: activeMainSession(hub.getTask(task.id))!.id });
    await hub.settled(task.id);
    const after = hub.getTask(task.id);
    expect(after.status).toBe("idle");
    expect(after.options.quotaPause).toBeUndefined();
    expect(activeMainSession(after)!.agent).toBe("codex");
    expect(codex.runs.filter((r) => !r.toolsDisabled).map((r) => r.prompt)).toEqual([expect.stringContaining("carry on please")]);
  });

  it("survives a restart and resumes when due", async () => {
    const file = path.join(root, "hub.db");
    const first = makeHub({ claude: limited(1) }, openDb(file));
    const task = await first.createTask(chat("go"));
    await first.settled(task.id);
    await first.shutdown(50);

    const agent = limited();
    const second = makeHub({ claude: agent }, openDb(file));
    second.recoverInterrupted();
    expect(second.getTask(task.id)).toMatchObject({ status: "paused", options: { quotaPause: { agent: "claude" } } });
    await second.resumeDue();
    expect(second.getTask(task.id).status).toBe("paused");
    clock += 3_600_001;
    await vi.waitFor(async () => {
      await second.resumeDue();
      expect(agent.runs).toHaveLength(1);
    });
    await second.settled(task.id);
    expect(second.getTask(task.id).status).toBe("idle");
  });

  it("sends exactly one quiet Discord notification on entering paused and none on resume", async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    const agent = limited(1);
    const hub = makeHub({ claude: agent });
    notifyDiscord(hub, { webhook: "https://discord.com/api/webhooks/<id>/<token>", fetch: send });
    const task = await hub.createTask(chat("go"));
    await hub.settled(task.id);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    const body = JSON.parse(send.mock.calls[0]![1]!.body as string);
    expect(body.flags).toBe(4096);
    expect(body.content).toContain("Claude 額度已用完");
    clock += 3_600_001;
    await hub.resumeDue();
    await hub.settled(task.id);
    await new Promise((r) => setTimeout(r, 20));
    expect(send).toHaveBeenCalledTimes(1);
  });
  it.each(["claude", "codex"] as const)("recovers %s before a future reset and consumes ordered queued input once", async provider => {
    const agent = limited(1);
    const hub = makeHub({ [provider]: agent });
    const task = await hub.createTask(chat("go", provider));
    await hub.settled(task.id);
    const savedReset = hub.getTask(task.id).options.quotaPause!.resetsAt!;
    hub.sendMessage(task.id, "first");
    hub.sendMessage(task.id, "second");
    agent.quotaScript = async () => available();
    clock += 60_000;
    await hub.resumeDue();
    expect(agent.quotaCalls).toBe(1);
    expect(agent.runs).toHaveLength(1);
    clock += 240_000;
    await Promise.all([hub.resumeDue(), hub.resumeDue(), hub.quota()]);
    await hub.settled(task.id);
    expect(clock).toBeLessThan(Date.parse(savedReset));
    expect(agent.quotaCalls).toBe(2);
    expect(agent.runs.map(r => r.prompt)).toEqual(["go", "first\n\nsecond"]);
    expect(hub.events(task.id).filter(e => e.type === "user_message" && e.queued)).toEqual([]);
    await hub.resumeDue();
    expect(agent.runs).toHaveLength(2);
  });

  it("shares one refresh across paused tasks and reuses a manually refreshed cache on the next tick", async () => {
    const agent = limited(1, 2);
    const hub = makeHub({ claude: agent });
    const one = await hub.createTask(chat("one"));
    await hub.settled(one.id);
    const two = await hub.createTask(chat("two"));
    await hub.settled(two.id);
    expect(agent.quotaCalls).toBe(1);
    clock += 10_000;
    agent.quotaScript = async () => available();
    await hub.quota(true);
    const calls = agent.quotaCalls;
    await Promise.all([hub.resumeDue(), hub.resumeDue()]);
    await Promise.all([hub.settled(one.id), hub.settled(two.id)]);
    expect(agent.quotaCalls).toBe(calls);
    expect(agent.runs).toHaveLength(4);
    expect(agent.runs.slice(2).every(r => r.prompt.includes("Continue the task"))).toBe(true);
  });

  it("does not reuse an accepted sample for a later pause or retry on repeated ticks", async () => {
    const agent = limited(1, 2);
    const hub = makeHub({ claude: agent });
    const task = await hub.createTask(chat("go"));
    await hub.settled(task.id);
    agent.quotaScript = async () => available();
    clock += 300_000;
    await hub.resumeDue();
    await hub.settled(task.id);
    expect(hub.getTask(task.id).status).toBe("paused");
    const pause = hub.getTask(task.id).options.quotaPause!;
    expect(pause.since).toBe(new Date(clock).toISOString());
    for (let i = 0; i < 3; i++) { clock += 60_000; await hub.resumeDue(); }
    expect(agent.runs).toHaveLength(2);
    expect(agent.quotaCalls).toBe(2);
  });

  it.each(["cancel", "delete", "shutdown", "continue", "new-pause", "handoff"] as const)("invalidates pending recovery after %s", async action => {
    const agent = limited(1, ...(action === "new-pause" ? [2] : []));
    const codex = new FakeAdapter(i => i.toolsDisabled
      ? [{ type: "text_delta", text: JSON.stringify(summary) }, { type: "done", ok: true }]
      : [{ type: "done", ok: true }]);
    const hub = makeHub({ claude: agent, codex });
    const task = await hub.createTask(chat("go"));
    await hub.settled(task.id);
    const original = hub.getTask(task.id).options.quotaPause!;
    if (action === "handoff") {
      const run = agent.run.bind(agent);
      agent.run = async function* (input) {
        if (input.toolsDisabled) { yield { type: "text_delta", text: JSON.stringify(summary) }; yield { type: "done", ok: true }; }
        else yield* run(input);
      };
    }
    clock += 300_000;
    let release!: (reading: QuotaReading) => void;
    agent.quotaScript = () => new Promise(resolve => { release = resolve; });
    const tick = hub.resumeDue();
    expect(agent.quotaCalls).toBe(2);
    if (action === "cancel") hub.stopWaiting(task.id);
    if (action === "delete") await hub.deleteTask(task.id);
    if (action === "shutdown") await hub.shutdown(1);
    if (action === "continue" || action === "new-pause") {
      hub.continueNow(task.id);
      if (action === "continue") await hub.settled(task.id);
      // A new limit waits for the same in-flight account read before establishing its pause.
    }
    const handoff = action === "handoff" ? hub.switchAgent(task.id, { target: "codex", expectedSessionId: activeMainSession(hub.getTask(task.id))!.id }) : undefined;
    release(available());
    await handoff;
    await tick;
    if (action !== "delete") await hub.settled(task.id);
    if (action === "delete") expect(() => hub.getTask(task.id)).toThrow();
    else if (action === "shutdown") expect(hub.getTask(task.id).options.quotaPause).toEqual(original);
    else if (action === "new-pause") {
      expect(hub.getTask(task.id).status).toBe("paused");
      await hub.resumeDue();
      expect(agent.runs).toHaveLength(2);
    } else {
      expect(hub.getTask(task.id).options.quotaPause).toBeUndefined();
      expect(agent.runs).toHaveLength(action === "continue" ? 2 : 1);
    }
  });

  it("does not apply a positive pending decision to a different pause with identical saved fields", async () => {
    const agent = limited(1, 2);
    const hub = makeHub({ claude: agent });
    const task = await hub.createTask(chat("go"));
    await hub.settled(task.id);
    const original = hub.getTask(task.id).options.quotaPause!;
    const cached = await hub.quota();
    let release!: (reading: QuotaResponse) => void;
    const pending = new Promise<QuotaResponse>(resolve => { release = resolve; });
    vi.spyOn(hub, "quota").mockReturnValueOnce(pending);
    const tick = hub.resumeDue();
    hub.continueNow(task.id);
    await hub.settled(task.id);
    expect(hub.getTask(task.id).options.quotaPause).toEqual(original);
    clock += 1_000;
    release({ ...cached, claude: { ...cached.claude, updatedAt: new Date(clock).toISOString(), stale: false, windows: available().windows } });
    await tick;
    await hub.settled(task.id);
    expect(hub.getTask(task.id).status).toBe("paused");
    expect(agent.runs).toHaveLength(2);
  });

  it("recovers a persisted future pause and queue before reset after restart", async () => {
    const file = path.join(root, "early.db");
    const first = makeHub({ claude: limited(1) }, openDb(file));
    const task = await first.createTask(chat("go"));
    await first.settled(task.id);
    first.sendMessage(task.id, "first");
    first.sendMessage(task.id, "second");
    const pause = first.getTask(task.id).options.quotaPause!;
    await first.shutdown(50);
    clock += 60_000;
    const agent = limited();
    agent.quotaScript = async () => available();
    const second = makeHub({ claude: agent }, openDb(file));
    second.recoverInterrupted();
    await vi.waitFor(() => expect(agent.runs).toHaveLength(1));
    await second.settled(task.id);
    expect(clock).toBeLessThan(Date.parse(pause.resetsAt!));
    expect(agent.runs.map(r => r.prompt)).toEqual(["first\n\nsecond"]);
    expect(second.events(task.id).filter(e => e.type === "user_message" && e.queued)).toEqual([]);
  });

  it("keeps ordinary increasing failure backoff across scheduler ticks", async () => {
    const agent = limited(1);
    const hub = makeHub({ claude: agent });
    const task = await hub.createTask(chat("go"));
    await hub.settled(task.id);
    agent.quotaScript = async () => { throw new Error("offline"); };
    clock += 300_000;
    await hub.resumeDue();
    expect(agent.quotaCalls).toBe(2);
    for (const delay of [60_000, 120_000, 240_000, 300_000]) {
      const calls = agent.quotaCalls;
      for (let elapsed = 60_000; elapsed < delay; elapsed += 60_000) {
        clock += 60_000;
        await hub.resumeDue();
        expect(agent.quotaCalls).toBe(calls);
      }
      clock += 60_000;
      await hub.resumeDue();
      expect(agent.quotaCalls).toBe(calls + 1);
      expect(agent.runs).toHaveLength(1);
    }
  });

  it("keeps queued flags until scheduler capacity is available, then consumes each message once", async () => {
    const agent = limited(1);
    const hub = new Hub({ db, dataDir: root, maxConcurrent: 1, flushMs: 1, now: () => clock, agents: { claude: agent } });
    hubs.push(hub);
    const task = await hub.createTask(chat("go"));
    await hub.settled(task.id);
    hub.sendMessage(task.id, "first");
    hub.sendMessage(task.id, "second");
    agent.hold();
    const blocker = await hub.createTask(chat("blocker"));
    await vi.waitFor(() => expect(agent.runs).toHaveLength(2));
    agent.quotaScript = async () => available();
    clock += 300_000;
    await hub.resumeDue();
    expect(agent.runs).toHaveLength(2);
    expect(hub.getTask(task.id).activity).toContain("Waiting for a free slot");
    expect(hub.events(task.id).filter(e => e.type === "user_message" && e.queued).map(e => e.type === "user_message" && e.text)).toEqual(["first", "second"]);
    await hub.resumeDue();
    agent.release();
    await hub.settled(blocker.id);
    await hub.settled(task.id);
    expect(agent.runs.map(r => r.prompt)).toEqual(["go", "blocker", "first\n\nsecond"]);
    expect(hub.events(task.id).filter(e => e.type === "user_message" && e.queued)).toEqual([]);
  });

  it("continues a recovered task on its existing SDK thread when no messages are queued", async () => {
    const agent = new FakeAdapter((_i, n) => n === 1
      ? [{ type: "thread", threadId: "saved-thread" }, { type: "done", ok: false, error: LIMIT }]
      : [{ type: "done", ok: true }]);
    agent.quotaScript = async () => exhaustedAt(reset());
    const hub = makeHub({ claude: agent });
    const task = await hub.createTask(chat("go"));
    await hub.settled(task.id);
    agent.quotaScript = async () => available();
    clock += 300_000;
    await hub.resumeDue();
    await hub.settled(task.id);
    expect(agent.runs[1]).toMatchObject({ threadId: "saved-thread", prompt: expect.stringContaining("Continue the task") });
  });

  it("processes cached recovery without waiting for another provider's pending refresh", async () => {
    const claude = limited(1);
    const codex = new FakeAdapter();
    codex.quotaScript = async () => ({ status: "error", windows: [] });
    const hub = makeHub({ claude, codex });
    const task = await hub.createTask(chat("go"));
    await hub.settled(task.id);
    clock += 10_000;
    claude.quotaScript = async () => available();
    await hub.quota(true);
    clock += 120_000;
    let release!: (reading: QuotaReading) => void;
    codex.quotaScript = () => new Promise(resolve => { release = resolve; });
    const refresh = hub.quota();
    await hub.resumeDue();
    await hub.settled(task.id);
    expect(claude.runs).toHaveLength(2);
    expect(claude.quotaCalls).toBe(2);
    release(available());
    await refresh;
  });

  it("discovers recovery at the shared deadline plus at most one ordinary scheduler tick", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const agent = limited(1);
    const hub = makeHub({ claude: agent });
    const start = clock;
    try {
      hub.recoverInterrupted();
      const task = await hub.createTask(chat("go"));
      await hub.settled(task.id);
      clock += 10_000;
      const manual = await hub.quota(true);
      const deadline = Date.parse(manual.claude.nextRefreshAt);
      expect(deadline).toBe(start + 310_000);
      agent.quotaScript = async () => available();
      for (let tick = 1; tick <= 5; tick++) {
        clock = start + tick * 60_000;
        await vi.advanceTimersByTimeAsync(60_000);
        expect(agent.runs).toHaveLength(1);
        expect(agent.quotaCalls).toBe(2);
      }
      clock = start + 360_000;
      await vi.advanceTimersByTimeAsync(60_000);
      await hub.settled(task.id);
      expect(agent.runs).toHaveLength(2);
      expect(agent.quotaCalls).toBe(3);
      expect(clock - deadline).toBeLessThanOrEqual(60_000);
    } finally {
      await hub.shutdown(1);
      vi.useRealTimers();
    }
  });

  it("processes newly cached recovery on the next tick while the previous tick still awaits another provider", async () => {
    const claude = limited(1), codex = new FakeAdapter();
    const hub = makeHub({ claude, codex });
    const task = await hub.createTask(chat("go"));
    await hub.settled(task.id);
    clock += 300_000;
    let releaseClaude!: (reading: QuotaReading) => void;
    let releaseCodex!: (reading: QuotaReading) => void;
    claude.quotaScript = () => new Promise(resolve => { releaseClaude = resolve; });
    codex.quotaScript = () => new Promise(resolve => { releaseCodex = resolve; });
    const firstTick = hub.resumeDue();
    releaseClaude(available());
    await new Promise(resolve => setImmediate(resolve));
    await hub.resumeDue();
    await hub.settled(task.id);
    expect(claude.runs).toHaveLength(2);
    expect(codex.quotaCalls).toBe(2);
    releaseCodex(available());
    await firstTick;
    expect(claude.runs).toHaveLength(2);
  });

});
