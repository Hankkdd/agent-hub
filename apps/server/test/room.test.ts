import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ROOM_BRIEF_MAX, ROOM_QUOTE_BYTES, ROOM_EXCHANGE_TEXT, type DocumentDetail, type Task } from "@agent-hub/shared";
import { createApp } from "../src/app";
import { FakeAdapter, type FakeStep } from "../src/agents/fake";
import type { AgentRunInput } from "../src/agents/types";
import { Documents } from "../src/core/documents";
import { Hub } from "../src/core/hub";
import { openDb, type Db } from "../src/db";
import { Hosts } from "../src/tools/hosts";
import { ToolServer } from "../src/tools/mcp";

let root: string, db: Db, hub: Hub, documents: Documents, document: DocumentDetail;
let claude: FakeAdapter, codex: FakeAdapter, tools: ToolServer;
let app: ReturnType<typeof createApp>;
let hubs: Hub[];
const headers = { authorization: "Bearer room-test", "content-type": "application/json" };
const reply = (text: string, ok = true, error?: string): FakeStep[] => [
  { type: "thread", threadId: "room-thread" }, { type: "text_start" }, { type: "text_delta", text }, { type: "done", ok, error },
];
function start() {
  hub = new Hub({ db, dataDir: root, agents: { claude, codex }, maxConcurrent: 2, tools, flushMs: 1 });
  hubs.push(hub);
  app = createApp(hub, "room-test", undefined, undefined, undefined, { documents });
}
beforeEach(async () => {
  hubs = [];
  root = fs.mkdtempSync(path.join(os.tmpdir(), "room-test-"));
  db = openDb(path.join(root, "test.db")); documents = new Documents(db);
  document = documents.create({ title: "Resume", contentFormat: "plain_text", content: "Original passage.\nRepeated Repeated\n" });
  claude = new FakeAdapter(() => reply("Claude angle @GPT"));
  codex = new FakeAdapter(() => reply("GPT angle @Claude"));
  tools = new ToolServer(new Hosts(db, root)); await tools.listen("127.0.0.1", 0);
  start();
});
afterEach(async () => {
  await Promise.all(hubs.map(h => h.shutdown())); tools.close();
  (db as Db & { $client: Database.Database }).$client.close();
  fs.rmSync(root, { recursive: true, force: true });
});
const request = (url: string, method = "GET", body?: unknown) => app.request(url, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
async function room() {
  const response = await request("/api/rooms", "POST", { documentId: document.id, brief: "Explore different wording", claudeModel: "test-claude", codexModel: "test-codex" });
  expect(response.status).toBe(201);
  return await response.json() as Task;
}
async function send(id: string, text: string, extra = {}) {
  const response = await request(`/api/tasks/${id}/messages`, "POST", { text, ...extra });
  expect(response.status).toBe(200); await hub.settled(id);
}

it("creates two main sessions without a first message and finds the newest room", async () => {
  const task = await room();
  expect(task).toMatchObject({ title: "Room: Resume", workflow: "room", options: { noDevices: true, room: { documentId: document.id } } });
  expect(task.sessions.map(s => [s.agent, s.role, s.model]).sort()).toEqual([["claude", "main", "test-claude"], ["codex", "main", "test-codex"]]);
  expect(hub.events(task.id)).toEqual([]); expect(claude.runs).toHaveLength(0);
  expect(((await (await request(`/api/rooms?documentId=${document.id}`)).json()) as { room: Task }).room.id).toBe(task.id);
  expect(await (await request(`/api/rooms?documentId=${randomUUID()}`)).json()).toEqual({ room: null });
  expect((await request("/api/rooms", "POST", { documentId: randomUUID() })).status).toBe(404);
});

it("runs one sequential round, alternates after restart and excludes own replies from deltas", async () => {
  const task = await room(); await send(task.id, "First question");
  expect(claude.runs).toHaveLength(1); expect(codex.runs).toHaveLength(1);
  expect(claude.runs[0]!.prompt).not.toContain("GPT angle");
  expect(codex.runs[0]!.prompt).toContain("[Claude]: Claude angle @GPT");
  await hub.shutdown(); start();
  await send(task.id, "Second question");
  expect(codex.runs[1]!.prompt).not.toContain("GPT angle");
  expect(codex.runs[1]!.prompt).not.toContain("Claude angle");
  expect(claude.runs[1]!.prompt).toContain("[GPT]: GPT angle @Claude");
  expect(claude.runs[1]!.prompt).not.toContain("Claude angle");
  expect(claude.runs[1]!.threadId).toBe("room-thread");
  expect(hub.events(task.id).some(e => e.type === "tool_call" && e.name === "room_round")).toBe(false);
  expect(hub.getTask(task.id).status).toBe("idle");
});

it.each(["@CLAUDE", "@gpt", "@Codex"])("targets only the mentioned member: %s", async mention => {
  const task = await room(); await send(task.id, `${mention} ideas`);
  expect(claude.runs).toHaveLength(mention.toLowerCase() === "@claude" ? 1 : 0);
  expect(codex.runs).toHaveLength(mention.toLowerCase() === "@claude" ? 0 : 1);
});

it("does not treat a longer word as a mention and stores pass normally", async () => {
  claude = new FakeAdapter(() => reply("(pass)")); start();
  const task = await room(); await send(task.id, "@claudette ideas");
  expect(claude.runs).toHaveLength(1); expect(codex.runs).toHaveLength(1);
  expect(hub.events(task.id).some(e => e.type === "agent_text" && e.text === "(pass)")).toBe(true);
});

it("exchanges exactly one more round with both latest replies", async () => {
  const task = await room(); await send(task.id, "Ideas");
  expect((await request(`/api/tasks/${task.id}/room/exchange`, "POST", {})).status).toBe(200);
  await hub.settled(task.id);
  expect(claude.runs).toHaveLength(2); expect(codex.runs).toHaveLength(2);
  expect(claude.runs[1]!.prompt).toContain("GPT angle"); expect(codex.runs[1]!.prompt).toContain("Claude angle");
  expect(codex.runs[1]!.prompt).toContain(ROOM_EXCHANGE_TEXT);
  expect(hub.events(task.id).filter(e => e.type === "user_message" && e.exchange)).toHaveLength(1);
});

it("isolates failures and pauses only when everyone fails and a member reaches a limit", async () => {
  claude = new FakeAdapter(() => reply("", false, "failure")); start();
  const task = await room(); await send(task.id, "Ideas");
  expect(codex.runs).toHaveLength(1); expect(hub.getTask(task.id).status).toBe("idle");
  codex = new FakeAdapter(() => reply("", false, "failure")); start();
  await send(task.id, "More"); expect(hub.getTask(task.id).status).toBe("failed");
  await hub.shutdown();
  codex = new FakeAdapter(() => reply("", false, "usage limit reached")); start();
  await send(task.id, "Retry"); expect(hub.getTask(task.id).status).toBe("paused");
});

it("sends full document only on revision changes and persists the brief", async () => {
  const task = await room(); await send(task.id, "Ideas");
  expect(claude.runs[0]!.turnContext).toContain("Original passage.");
  expect((await request(`/api/tasks/${task.id}/room/brief`, "PUT", { brief: "New brief" })).status).toBe(200);
  expect((await request(`/api/tasks/${task.id}/room/brief`, "PUT", { brief: "x".repeat(ROOM_BRIEF_MAX + 1) })).status).toBe(400);
  await hub.shutdown(); start(); await send(task.id, "More");
  for (const agent of [claude, codex]) {
    expect(agent.runs[1]!.turnContext).toContain("Document unchanged (revision 1)");
    expect(agent.runs[1]!.turnContext).toContain("New brief");
  }
  documents.update(document.id, { title: "Resume", contentFormat: "plain_text", content: "Revised passage.", expectedRevisionId: document.currentRevision.id });
  await send(task.id, "Again"); expect(claude.runs[2]!.turnContext).toContain("Revised passage.");
});

it("validates quote ownership, snapshots partial quotes and caps UTF-8 at scalar boundaries", async () => {
  const task = await room(); await send(task.id, "First");
  const event = hub.events(task.id).find(e => e.type === "agent_text")!;
  const partial = "\u{1f600}".repeat(1100);
  await send(task.id, "Quoted question", { replyTo: { eventId: event.id, part: partial } });
  const message = hub.events(task.id).filter(e => e.type === "user_message").at(-1)!;
  if (message.type !== "user_message") throw new Error("Expected message");
  expect(message.quote).toMatchObject({ part: true, author: "claude" });
  expect(Buffer.byteLength(message.quote!.text)).toBe(ROOM_QUOTE_BYTES);
  expect(claude.runs[1]!.prompt).toContain(`[Quoting Claude's reply: "${message.quote!.text}"]`);
  const foreign = await room(); await send(foreign.id, "Foreign");
  for (const eventId of [randomUUID(), hub.events(foreign.id)[0]!.id])
    expect((await request(`/api/tasks/${task.id}/messages`, "POST", { text: "Bad", replyTo: { eventId } })).status).toBe(400);
  expect((await request(`/api/tasks/${task.id}/messages`, "POST", { text: "Bad", replyTo: { eventId: event.id, part: "" } })).status).toBe(400);
});

it("rejects room fields and exchange on ordinary chat tasks", async () => {
  const task = await hub.createTask({ workflow: "chat", title: "Chat", message: "Hello" }); await hub.settled(task.id);
  for (const extra of [{ selection: {} }, { replyTo: { eventId: randomUUID() } }])
    expect((await request(`/api/tasks/${task.id}/messages`, "POST", { text: "Test", ...extra })).status).toBe(400);
  expect((await request(`/api/tasks/${task.id}/room/exchange`, "POST", {})).status).toBe(409);
});

it("consumes busy messages individually without skipping queued deltas and stops the round", async () => {
  claude.hold(); const task = await room(); hub.sendMessage(task.id, "First");
  await vi.waitFor(() => expect(claude.runs).toHaveLength(1));
  hub.sendMessage(task.id, "Second"); hub.sendMessage(task.id, "Third");
  claude.release(); await hub.settled(task.id);
  expect(claude.runs).toHaveLength(3); expect(codex.runs).toHaveLength(3);
  expect(codex.runs[0]!.prompt).not.toContain("Second");
  expect(codex.runs[1]!.prompt).toContain("Second"); expect(codex.runs[1]!.prompt).not.toContain("Third");
  expect(codex.runs[2]!.prompt).toContain("Third");
  codex.hold(); hub.sendMessage(task.id, "Stop this round");
  await vi.waitFor(() => expect(codex.runs).toHaveLength(4)); hub.stop(task.id); await hub.settled(task.id);
  expect(claude.runs).toHaveLength(3);
  expect(hub.getTask(task.id).status).toBe("idle");
});

class ToolAdapter extends FakeAdapter {
  results: Awaited<ReturnType<Client["callTool"]>>[] = [];
  names: string[] = [];
  inputs: { originalText?: string; replacementText: string; reason?: string }[] = [];
  override async *run(input: AgentRunInput) {
    if (input.mcp) {
      const client = new Client({ name: "room-fake", version: "1" });
      await client.connect(new StreamableHTTPClientTransport(new URL(input.mcp.url), { requestInit: { headers: { Authorization: `Bearer ${input.mcp.token}` } } }));
      try {
        this.names = (await client.listTools()).tools.map(t => t.name);
        for (const args of this.inputs) this.results.push(await client.callTool({ name: "suggest_document_edit", arguments: args }));
      } finally { await client.close(); }
    }
    yield* super.run(input);
  }
}

it("offers room-only suggestions, validates unique matches and frozen/stale selections", async () => {
  const agent = new ToolAdapter(() => reply("Proposed")); claude = agent; start();
  agent.inputs = [{ originalText: "Original passage.", replacementText: "Better wording.", reason: "Clearer" },
    { originalText: "Missing", replacementText: "No" }, { originalText: "Repeated", replacementText: "No" }, { replacementText: "No selection" }];
  const task = await room(); await send(task.id, "@claude Suggest");
  expect(agent.names).toEqual(["suggest_document_edit"]);
  expect(agent.results.map(r => !!r.isError)).toEqual([false, true, true, true]);
  expect(documents.listSuggestions(document.id).suggestions[0]).toMatchObject({ source: "claude", status: "pending" });
  expect(hub.events(task.id).find(e => e.type === "room_suggestion")).toMatchObject({ agent: "claude", reason: "Clearer" });
  expect(documents.get(document.id)).toEqual(document);
  agent.inputs = [{ replacementText: "Frozen replacement" }];
  const selection = { baseRevisionId: document.currentRevision.id, startUtf16: 0, endUtf16: 8, originalText: "Original" };
  await send(task.id, "@claude Frozen", { selection }); expect(agent.results.at(-1)!.isError).not.toBe(true);
  expect(agent.runs.at(-1)!.turnContext).toContain("Frozen selection");
  documents.update(document.id, { title: "Resume", contentFormat: "plain_text", content: "Changed", expectedRevisionId: document.currentRevision.id });
  await send(task.id, "@claude Stale", { selection }); expect(agent.results.at(-1)!.isError).toBe(true);
  expect((await request(`/api/tasks/${task.id}/messages`, "POST", { text: "Bad", selection: { ...selection, endUtf16: 7 } })).status).toBe(409);
  agent.inputs = [];
  const chat = await hub.createTask({ title: "Chat", workflow: "chat", agent: "claude", message: "Hello" }); await hub.settled(chat.id);
  expect(agent.names).not.toContain("suggest_document_edit");
});

it("sends only final text to the other member, excluding tools and preliminary text", async () => {
  claude = new FakeAdapter(() => [
    { type: "text_start" }, { type: "text_delta", text: "Preliminary thought" },
    { type: "tool_start", callId: "test", name: "test_tool", input: "private tool input", sideEffect: "none" },
    { type: "tool_end", callId: "test", output: "private tool output", isError: false },
    ...reply("Final idea"),
  ]); start();
  const task = await room(); await send(task.id, "Ideas");
  expect(codex.runs[0]!.prompt).toContain("[Claude]: Final idea");
  expect(codex.runs[0]!.prompt).not.toMatch(/Preliminary|private tool/);
});

it("attributes Codex suggestions and caps excerpts without splitting scalars", async () => {
  const agent = new ToolAdapter(() => reply("Proposed")); codex = agent; start();
  agent.inputs = [{ originalText: "Original", replacementText: "\u{1f600}".repeat(301) }];
  const task = await room(); await send(task.id, "@gpt Suggest");
  const event = hub.events(task.id).find(e => e.type === "room_suggestion");
  expect(event).toMatchObject({ agent: "codex", replacementExcerpt: "\u{1f600}".repeat(300) });
  expect(documents.listSuggestions(document.id).suggestions[0]!.source).toBe("codex");
});
