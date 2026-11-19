import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TaskEvent } from "@agent-hub/shared";
import { FakeAdapter } from "../src/agents/fake";
import type { AgentEvent, AgentRunInput } from "../src/agents/types";
import { createApp } from "../src/app";
import { Hub } from "../src/core/hub";
import { openDb, type Db } from "../src/db/index";

let dataDir: string;
let db: Db;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-hub-test-"));
  db = openDb(":memory:");
});
afterEach(() => fs.rmSync(dataDir, { recursive: true, force: true }));

function makeHub(agent: FakeAdapter, maxConcurrent = 4): Hub {
  return new Hub({ db, dataDir, maxConcurrent, flushMs: 1, agents: { claude: agent } });
}

const chat = (message: string) => ({ title: "", workflow: "chat" as const, agent: "claude" as const, message });
const types = (evs: TaskEvent[]) => evs.map((e) => e.type);
const tick = () => new Promise((r) => setTimeout(r, 5));

describe("chat turn", () => {
  it("runs the first message, streams the reply into events, and keeps the thread id", async () => {
    const hub = makeHub(new FakeAdapter());
    const task = await hub.createTask(chat("hello"));
    await hub.settled(task.id);

    const evs = hub.events(task.id);
    expect(types(evs)).toEqual(["user_message", "invocation_started", "agent_text", "turn_result", "invocation_finished"]);
    expect(evs[2]).toMatchObject({ type: "agent_text", text: "echo: hello" });
    const t = hub.getTask(task.id);
    expect(t.status).toBe("idle");
    expect(t.title).toBe("hello");
    expect(t.sessions[0]!.sdkThreadId).toBe("thread-1");
    expect(fs.existsSync(t.cwd!)).toBe(true); // a scratch dir when none was given
  });

  it("resumes the same thread on the next message", async () => {
    const agent = new FakeAdapter();
    const hub = makeHub(agent);
    const task = await hub.createTask(chat("one"));
    await hub.settled(task.id);
    hub.sendMessage(task.id, "two");
    await hub.settled(task.id);
    expect(agent.runs.map((r) => [r.prompt, r.threadId])).toEqual([
      ["one", undefined],
      ["two", "thread-1"],
    ]);
  });

  it("queues a message sent mid-turn and delivers it as the next turn, never a concurrent one", async () => {
    const agent = new FakeAdapter();
    agent.hold();
    const hub = makeHub(agent);
    const task = await hub.createTask(chat("first"));
    await tick();
    hub.sendMessage(task.id, "second");
    hub.sendMessage(task.id, "third");
    expect(agent.runs).toHaveLength(1);
    expect(hub.events(task.id).filter((e) => e.type === "user_message" && e.queued)).toHaveLength(2);

    agent.release();
    await hub.settled(task.id);
    expect(agent.runs.map((r) => r.prompt)).toEqual(["first", "second\n\nthird"]);
    expect(hub.events(task.id).some((e) => e.type === "user_message" && e.queued)).toBe(false);
  });

  it("records a failed turn and lets the conversation go on", async () => {
    const agent = new FakeAdapter((input, n) =>
      n === 1 ? [{ type: "thread", threadId: "t" }, { type: "done", ok: false, error: "rate limited\nretry later" }] : [{ type: "done", ok: true }],
    );
    const hub = makeHub(agent);
    const task = await hub.createTask(chat("go"));
    await hub.settled(task.id);
    expect(hub.getTask(task.id)).toMatchObject({ status: "failed", activity: "rate limited" });
    hub.sendMessage(task.id, "again");
    await hub.settled(task.id);
    expect(hub.getTask(task.id).status).toBe("idle");
  });
});

describe("stop", () => {
  it("aborts the running turn and does not start queued messages on its own", async () => {
    const agent = new FakeAdapter();
    agent.hold();
    const hub = makeHub(agent);
    const task = await hub.createTask(chat("long job"));
    await tick();
    hub.sendMessage(task.id, "queued behind it");
    hub.stop(task.id);
    await hub.settled(task.id);

    expect(agent.runs).toHaveLength(1);
    expect(hub.getTask(task.id).status).toBe("idle");
    expect(hub.events(task.id).at(-1)).toMatchObject({ type: "status_change", reason: "stopped by you" });

    // The queued message is still waiting and goes out with the next one.
    agent.release(); // the gate outlives the aborted run; open it so the next run is not held
    hub.sendMessage(task.id, "now");
    await hub.settled(task.id);
    expect(agent.runs[1]!.prompt).toBe("queued behind it\n\nnow");
  });
});

describe("concurrency limit", () => {
  it("makes a task wait for a free slot, then runs it", async () => {
    const agent = new FakeAdapter();
    agent.hold();
    const hub = makeHub(agent, 1);
    const a = await hub.createTask(chat("a"));
    const b = await hub.createTask(chat("b"));
    await tick();
    expect(agent.runs).toHaveLength(1);
    expect(hub.getTask(b.id)).toMatchObject({ status: "running", activity: expect.stringContaining("Waiting for a free slot") });

    agent.release();
    await hub.settled(a.id);
    await hub.settled(b.id);
    expect(agent.runs.map((r) => r.prompt)).toEqual(["a", "b"]);
    expect(hub.getTask(b.id).status).toBe("idle");
  });
});

describe("restart recovery (design.md §8)", () => {
  // A turn that dies with an ssh call in flight, as a killed server would leave it.
  const crashing = (input: AgentRunInput, n: number): AgentEvent[] =>
    n === 1
      ? [
          { type: "thread", threadId: "thread-x" },
          { type: "tool_start", callId: "c1", name: "ssh_exec", input: "nas: docker image prune -a -f", sideEffect: "ssh" },
          { type: "done", ok: true },
        ]
      : [{ type: "done", ok: true }];

  async function interruptedTask() {
    const agent = new FakeAdapter(crashing);
    agent.hold(1); // pause right after the ssh call started
    const before = makeHub(agent);
    const task = await before.createTask(chat("clean the NAS"));
    await tick();
    // "Restart": a fresh Hub over the same database, the old process simply gone.
    const agent2 = new FakeAdapter(crashing);
    agent2.runs.push({} as AgentRunInput); // so its scripted run number is 2 (no crash)
    const after = makeHub(agent2);
    expect(after.recoverInterrupted()).toBe(1);
    return { hub: after, agent: agent2, id: task.id };
  }

  it("marks the task interrupted instead of re-running it", async () => {
    const { hub, agent, id } = await interruptedTask();
    expect(hub.getTask(id).status).toBe("interrupted");
    expect(agent.runs).toHaveLength(1); // only the placeholder: nothing was re-run
    const tool = hub.events(id).find((e) => e.type === "tool_call");
    expect(tool).toMatchObject({ pending: true, sideEffect: "ssh" });
  });

  it("continue resumes the same thread and names the calls whose effect is unknown", async () => {
    const { hub, agent, id } = await interruptedTask();
    hub.recover(id, "continue");
    await hub.settled(id);
    const run = agent.runs[1]!;
    expect(run.threadId).toBe("thread-x");
    expect(run.prompt).toContain("may or may not have completed");
    expect(run.prompt).toContain("ssh_exec: nas: docker image prune -a -f");
    expect(hub.getTask(id).status).toBe("idle");
  });

  it("restart starts a new conversation from the original request", async () => {
    const { hub, agent, id } = await interruptedTask();
    hub.recover(id, "restart");
    await hub.settled(id);
    expect(agent.runs[1]).toMatchObject({ prompt: "clean the NAS", threadId: undefined });
  });

  it("a graceful shutdown aborts the turn but leaves it to be marked interrupted, not stopped", async () => {
    const agent = new FakeAdapter(crashing);
    agent.hold(1);
    const hub = makeHub(agent);
    const task = await hub.createTask(chat("clean the NAS"));
    await tick();
    await hub.shutdown();
    expect(hub.getTask(task.id).status).toBe("running");
    expect(hub.events(task.id).some((e) => e.type === "status_change" && e.reason === "stopped by you")).toBe(false);
    expect(makeHub(new FakeAdapter()).recoverInterrupted()).toBe(1);
    expect(hub.getTask(task.id).status).toBe("interrupted");
  });

  it("end closes it without running anything", async () => {
    const { hub, agent, id } = await interruptedTask();
    hub.recover(id, "end");
    expect(hub.getTask(id).status).toBe("done");
    expect(agent.runs).toHaveLength(1);
  });
});

describe("permission requests (auto mode asking the user)", () => {
  const asking = (): FakeAdapter =>
    new FakeAdapter((input, n) =>
      n === 1
        ? [{ type: "thread", threadId: "t1" }, { type: "ask", toolName: "Bash", input: "rm -rf build/" }, { type: "done", ok: true }]
        : [{ type: "done", ok: true }],
    );
  const pendingRequest = (hub: Hub, id: string) => hub.events(id).find((e) => e.type === "waiting_user")!;

  it("waits for the user, and Allow lets the turn go on", async () => {
    const agent = asking();
    const hub = makeHub(agent);
    const task = await hub.createTask(chat("clean up"));
    await tick();
    expect(hub.getTask(task.id)).toMatchObject({ status: "waiting_user", activity: "Needs your approval: Bash" });
    const req = pendingRequest(hub, task.id);
    expect(req).toMatchObject({ detail: "rm -rf build/", options: ["Allow", "Deny"] });

    hub.answer(task.id, req.id, "Allow");
    await hub.settled(task.id);
    expect(agent.decisions).toEqual([{ allow: true }]);
    expect(pendingRequest(hub, task.id)).toMatchObject({ answer: "Allow" });
    expect(hub.getTask(task.id).status).toBe("idle");
  });

  it("Deny reaches the agent as a refusal it can act on", async () => {
    const agent = asking();
    const hub = makeHub(agent);
    const task = await hub.createTask(chat("clean up"));
    await tick();
    hub.answer(task.id, pendingRequest(hub, task.id).id, "Deny");
    await hub.settled(task.id);
    expect(agent.decisions[0]).toMatchObject({ allow: false, message: expect.stringContaining("denied") });
    expect(() => hub.answer(task.id, pendingRequest(hub, task.id).id, "Allow")).toThrow(/no longer waiting/);
  });

  it("stopping while it waits cancels the request instead of hanging", async () => {
    const agent = asking();
    const hub = makeHub(agent);
    const task = await hub.createTask(chat("clean up"));
    await tick();
    hub.stop(task.id);
    await hub.settled(task.id);
    expect(pendingRequest(hub, task.id)).toMatchObject({ answer: "Cancelled" });
    expect(hub.getTask(task.id).status).toBe("idle");
  });

  it("a restart while it waits marks the task interrupted and expires the question", async () => {
    const hub = makeHub(asking());
    const task = await hub.createTask(chat("clean up"));
    await tick();
    const after = makeHub(new FakeAdapter());
    expect(after.recoverInterrupted()).toBe(1);
    expect(after.getTask(task.id).status).toBe("interrupted");
    expect(pendingRequest(after, task.id)).toMatchObject({ answer: "Expired (server restarted)" });
  });
});

describe("models", () => {
  it("asks each agent, caches the answer, and survives an agent that cannot answer", async () => {
    let asked = 0;
    const claude = Object.assign(new FakeAdapter(), {
      listModels: async () => {
        asked++;
        return [{ id: "m1", label: "Model One", effortLevels: ["low" as const, "high" as const] }];
      },
    });
    const codex = Object.assign(new FakeAdapter(), {
      listModels: async () => {
        throw new Error("not logged in");
      },
    });
    const hub = new Hub({ db, dataDir, maxConcurrent: 1, agents: { claude, codex } });
    expect(await hub.models()).toEqual({ claude: [{ id: "m1", label: "Model One", effortLevels: ["low", "high"] }], codex: [] });
    await hub.models();
    expect(asked).toBe(1); // cached
  });
});

describe("deleteTask", () => {
  it("removes the task and its scratch directory, refuses while it runs, and never touches a directory the user chose", async () => {
    const agent = new FakeAdapter();
    agent.hold();
    const hub = makeHub(agent);
    const task = await hub.createTask(chat("hi"));
    await tick();
    await expect(hub.deleteTask(task.id)).rejects.toThrow(/still running/);
    agent.release();
    await hub.settled(task.id);
    const scratch = hub.getTask(task.id).cwd!;
    const seen: string[] = [];
    hub.subscribe((m) => m.type === "task_deleted" && seen.push(m.taskId));
    await hub.deleteTask(task.id);
    expect(() => hub.getTask(task.id)).toThrow(/no task/);
    expect(fs.existsSync(scratch)).toBe(false);
    expect(seen).toEqual([task.id]);

    const mine = fs.mkdtempSync(path.join(os.tmpdir(), "user-dir-"));
    const chatInMine = await hub.createTask({ ...chat("look here"), repoPath: mine });
    await hub.settled(chatInMine.id);
    await hub.deleteTask(chatInMine.id);
    expect(fs.existsSync(mine)).toBe(true);
    fs.rmSync(mine, { recursive: true, force: true });
  });
});

describe("createTask validation", () => {
  it("rejects missing agents, missing directories, and worktree workflows without a git repo", async () => {
    const hub = makeHub(new FakeAdapter());
    await expect(hub.createTask({ ...chat("x"), agent: "codex" })).rejects.toThrow(/not connected/);
    await expect(hub.createTask({ ...chat("x"), repoPath: "/definitely/not/here" })).rejects.toThrow(/not a directory/);
    await expect(hub.createTask({ ...chat("x"), workflow: "implement" })).rejects.toThrow(/needs a repository/);
    await expect(hub.createTask({ ...chat("x"), workflow: "implement", repoPath: dataDir })).rejects.toThrow(/not a git repository/);
  });
});

describe("API auth", () => {
  it("refuses without the token and accepts the bearer header or the cookie from /api/auth", async () => {
    const app = createApp(makeHub(new FakeAdapter()), "s3cret");
    expect((await app.request("/api/tasks")).status).toBe(401);
    expect((await app.request("/api/tasks", { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
    expect((await app.request("/api/tasks", { headers: { authorization: "Bearer s3cret" } })).status).toBe(200);

    const bad = await app.request("/api/auth", { method: "POST", body: JSON.stringify({ token: "nope" }), headers: { "content-type": "application/json" } });
    expect(bad.status).toBe(401);
    const ok = await app.request("/api/auth", { method: "POST", body: JSON.stringify({ token: "s3cret" }), headers: { "content-type": "application/json" } });
    const cookie = ok.headers.get("set-cookie")!;
    expect(cookie).toMatch(/HttpOnly/);
    expect((await app.request("/api/tasks", { headers: { cookie: cookie.split(";")[0]! } })).status).toBe(200);
  });

  it("maps hub errors to their status codes", async () => {
    const app = createApp(makeHub(new FakeAdapter()), "t");
    const res = await app.request("/api/tasks/nope", { headers: { authorization: "Bearer t" } });
    expect(res.status).toBe(404);
  });
});

describe("usage-limit turns", () => {
  it.each(["claude", "codex"] as const)("pauses %s turns until the latest quota reset without retrying", async (kind) => {
    const error = "You've hit your usage limit. Try again at 9:41 PM.";
    const agent = new FakeAdapter(() => [{ type: "done", ok: false, error }]);
    const reset = new Date(Date.now() + 86_400_000).toISOString();
    agent.quotaScript = async () => ({ status: "ok", windows: [{ id: "weekly", bucket: "Weekly", durationMins: null, remainingPercent: 0, resetsAt: reset }] });
    const hub = new Hub({ db, dataDir, maxConcurrent: 4, agents: { [kind]: agent } });
    const task = await hub.createTask({ ...chat("go"), agent: kind });
    await hub.settled(task.id);
    expect(hub.events(task.id).filter((e) => e.type === "turn_result").at(-1)).toMatchObject({ type: "turn_result", ok: false, error, limit: { agent: kind, resetsAt: reset } });
    expect(hub.getTask(task.id)).toMatchObject({ status: "paused", options: { quotaPause: { agent: kind, resetsAt: reset } } });
    expect(agent.runs).toHaveLength(1);
    expect(agent.quotaCalls).toBe(1);
    await hub.shutdown();
  });

  it("labels thrown usage errors and falls back when quota is unavailable", async () => {
    const agent = new FakeAdapter(() => { throw new Error("session limit reached"); });
    agent.quotaScript = async () => { throw new Error("unavailable"); };
    const hub = makeHub(agent);
    const task = await hub.createTask(chat("go"));
    await hub.settled(task.id);
    expect(hub.events(task.id).filter((e) => e.type === "turn_result").at(-1)).toMatchObject({ type: "turn_result", error: "session limit reached", limit: { agent: "claude", resetsAt: null } });
    expect(agent.runs).toHaveLength(1);
    await hub.shutdown();
  });
});
