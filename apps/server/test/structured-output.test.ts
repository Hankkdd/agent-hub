import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { activeMainSession, type NewTaskInput } from "@agent-hub/shared";
import { FakeAdapter } from "../src/agents/fake";
import { Hub } from "../src/core/hub";
import { createApp } from "../src/app";
import { openDb, schema as tables, type Db } from "../src/db";

let dataDir: string;
let db: Db;
const hubs: Hub[] = [];
const schema = { type: "object", properties: { count: { type: "integer" } } };
const chat = { title: "", workflow: "chat" as const, message: "judge" };
beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "structured-output-"));
  db = openDb(path.join(dataDir, "hub.db"));
});
afterEach(async () => {
  await Promise.all(hubs.splice(0).map(hub => hub.shutdown(50)));
  fs.rmSync(dataDir, { recursive: true, force: true });
});
function makeHub(agent: FakeAdapter) {
  const hub = new Hub({ db, dataDir, maxConcurrent: 4, flushMs: 1, agents: { codex: agent, claude: agent, gemini: agent } });
  hubs.push(hub);
  return hub;
}
it.each(["codex", "claude"] as const)("snapshots the schema for %s follow-ups and resumed turns after restart", async agentKind => {
  const agent = new FakeAdapter(input => [
    { type: "thread", threadId: input.threadId ?? "structured-thread" },
    { type: "text_delta", text: '{"count":2}' },
    { type: "done", ok: true, output: { count: 2 } },
  ]);
  const hub = makeHub(agent);
  const supplied = structuredClone(schema);
  const task = await hub.createTask({ ...chat, agent: agentKind, outputSchema: supplied });
  supplied.type = "array";
  await hub.settled(task.id);
  hub.sendMessage(task.id, "again");
  await hub.settled(task.id);
  await hub.shutdown(50);
  db = openDb(path.join(dataDir, "hub.db"));
  const after = makeHub(agent);
  after.recoverInterrupted();
  after.sendMessage(task.id, "after restart");
  await after.settled(task.id);
  expect(agent.runs).toHaveLength(3);
  expect(agent.runs.map(r => r.outputSchema)).toEqual([schema, schema, schema]);
  expect(agent.runs.map(r => r.threadId)).toEqual([undefined, "structured-thread", "structured-thread"]);
  expect(after.getTask(task.id).options.outputSchema).toEqual(schema);
  expect(after.events(task.id).filter(e => e.type === "turn_result").map(e => e.output)).toEqual([{ count: 2 }, { count: 2 }, { count: 2 }]);
  expect(after.events(task.id).filter(e => e.type === "agent_text").map(e => e.text)).toEqual(Array(3).fill('{"count":2}'));
});
it.each([
  { workflow: "plan", outputSchema: {}, reason: "chat" },
  { workflow: "implement", outputSchema: {}, reason: "chat" },
  { workflow: "review", outputSchema: {}, reason: "chat" },
  { workflow: "video", outputSchema: {}, reason: "chat" },
  { agent: "gemini", outputSchema: {}, reason: "Gemini" },
  ...[null, [], "object", 12, true].map(outputSchema => ({ outputSchema, reason: "plain JSON object" })),
  { outputSchema: { description: "x".repeat(32768) }, reason: "32 KB" },
  { outputSchema: { description: "\u5b57".repeat(11000) }, reason: "32 KB" },
])("rejects invalid requests before creating a task: %j", async ({ reason, ...extra }) => {
  const agent = new FakeAdapter();
  const hub = makeHub(agent);
  const app = createApp(hub, "fixture-token");
  const response = await app.request("/api/tasks", {
    method: "POST", headers: { authorization: "Bearer fixture-token", "content-type": "application/json" },
    body: JSON.stringify({ ...chat, ...extra }),
  });
  expect(response.status).toBe(400);
  expect(await response.text()).toContain(reason);
  expect(hub.listTasks()).toHaveLength(0);
  expect(agent.runs).toHaveLength(0);
  expect(fs.existsSync(path.join(dataDir, "scratch"))).toBe(false);
});
it("does not add schema or output fields to ordinary chat turns", async () => {
  const agent = new FakeAdapter();
  const hub = makeHub(agent);
  const task = await hub.createTask(chat);
  await hub.settled(task.id);
  expect(agent.runs[0]).not.toHaveProperty("outputSchema");
  expect(hub.getTask(task.id).options).not.toHaveProperty("outputSchema");
  expect(hub.events(task.id).map(e => e.type)).toEqual(["user_message", "invocation_started", "agent_text", "turn_result", "invocation_finished"]);
  expect(hub.events(task.id).find(e => e.type === "turn_result")).not.toHaveProperty("output");
});
it("rejects non-plain and unserializable schema objects", async () => {
  const hub = makeHub(new FakeAdapter());
  const circular: Record<string, unknown> = {}; circular.self = circular;
  for (const outputSchema of [new Date(), circular, { value: BigInt(1) }]) {
    await expect(hub.createTask({ ...chat, outputSchema } as NewTaskInput)).rejects.toMatchObject({ status: 400 });
  }
  expect(hub.listTasks()).toHaveLength(0);
});

it("keeps handoff summary calls schema-free while retaining it for the new main session", async () => {
  const agent = new FakeAdapter(input => input.toolsDisabled ? [
    { type: "text_delta", text: JSON.stringify({ goals: "\u76ee\u6a19", decisions: "\u7121", constraints: "\u804a\u5929", completed: "\u7121", pending: "\u5f85\u8fa6", uncertainty: "\u7121", references: [1] }) },
    { type: "done", ok: true },
  ] : [{ type: "thread", threadId: "main-thread" }, { type: "done", ok: true, output: {} }]);
  const hub = makeHub(agent);
  const task = await hub.createTask({ ...chat, agent: "codex", outputSchema: schema });
  await hub.settled(task.id);
  await hub.switchAgent(task.id, { target: "claude", expectedSessionId: hub.getTask(task.id).sessions[0]!.id });
  expect(agent.runs.filter(r => r.toolsDisabled)).toHaveLength(1);
  expect(agent.runs.find(r => r.toolsDisabled)).not.toHaveProperty("outputSchema");
  hub.sendMessage(task.id, "continue");
  await hub.settled(task.id);
  expect(agent.runs.at(-1)!.outputSchema).toEqual(schema);
});
it.each(["continue", "restart"] as const)("retains the schema on explicit %s recovery of an interrupted task", async action => {
  const agent = new FakeAdapter();
  agent.hold(0);
  const before = makeHub(agent);
  const task = await before.createTask({ ...chat, outputSchema: schema });
  for (let i = 0; i < 100 && agent.runs.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 5));
  expect(agent.runs).toHaveLength(1);
  await before.shutdown(50);
  db = openDb(path.join(dataDir, "hub.db"));
  const resumed = new FakeAdapter(() => [{ type: "done", ok: true, output: { count: 3 } }]);
  const after = makeHub(resumed);
  expect(after.recoverInterrupted()).toBe(1);
  after.recover(task.id, action);
  await after.settled(task.id);
  expect(resumed.runs[0]!.outputSchema).toEqual(schema);
  expect(resumed.runs[0]!.threadId).toBe(action === "continue" ? "thread-1" : undefined);
  expect(after.events(task.id).filter(e => e.type === "turn_result").at(-1)).toHaveProperty("output", { count: 3 });
});

it("omits the schema for a Gemini main session and restores it when switched back to Codex", async () => {
  const agent = new FakeAdapter();
  const hub = makeHub(agent);
  const task = await hub.createTask({ ...chat, agent: "codex", outputSchema: schema });
  await hub.settled(task.id);
  expect(agent.runs[0]!.outputSchema).toEqual(schema);

  // switchAgent currently rejects Gemini handoffs; exercise persisted session changes without
  // widening that API's supported backends.
  const sessionId = activeMainSession(hub.getTask(task.id))!.id;
  db.update(tables.sessions).set({ agent: "gemini" }).where(eq(tables.sessions.id, sessionId)).run();
  hub.sendMessage(task.id, "Gemini turn");
  await hub.settled(task.id);
  expect(activeMainSession(hub.getTask(task.id))!.agent).toBe("gemini");
  expect(agent.runs).toHaveLength(2);
  expect(agent.runs.at(-1)!.prompt).toContain("Gemini turn");
  expect(agent.runs.at(-1)).not.toHaveProperty("outputSchema");
  expect(hub.getTask(task.id).options.outputSchema).toEqual(schema);

  db.update(tables.sessions).set({ agent: "codex" }).where(eq(tables.sessions.id, sessionId)).run();
  hub.sendMessage(task.id, "Codex turn");
  await hub.settled(task.id);
  expect(activeMainSession(hub.getTask(task.id))!.agent).toBe("codex");
  expect(agent.runs).toHaveLength(3);
  expect(agent.runs.at(-1)!.prompt).toContain("Codex turn");
  expect(agent.runs.at(-1)!.outputSchema).toEqual(schema);
});
