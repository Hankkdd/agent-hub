import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { AgentKind, TaskEvent } from "@agent-hub/shared";
import { FakeAdapter } from "../src/agents/fake";
import { Hub } from "../src/core/hub";
import { openDb, schema, type Db } from "../src/db/index";
import { Hosts } from "../src/tools/hosts";
import { ToolServer } from "../src/tools/mcp";
import { createApp } from "../src/app";
import * as exportIo from "../src/core/finding-export-io";
import { readRepoSettings } from "../src/core/repo-settings";

let root: string, repo: string, docs: string, data: string, db: Db, tools: ToolServer;
let hubs: Hub[];
const clients: Client[] = [];
const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const observation = { topic: "cache-lifetime", title: "Cache lifetime", evidence: "Concrete evidence at cache.ts:12", locations: ["src/cache.ts:12"], followUp: "Investigate in a separately authorized task" };
const text = (r: Awaited<ReturnType<Client["callTool"]>>) => (r.content as { text: string }[]).map((c) => c.text).join("\n");
function configure(value: unknown = { documentsDir: docs, findings: { owner: "Document owner" } }) { fs.writeFileSync(path.join(data, "repos.json"), JSON.stringify({ [repo]: value })); }
function makeHub(author = new FakeAdapter(), reviewer = author) {
  const hub = new Hub({ db, tools, dataDir: data, maxConcurrent: 4, flushMs: 1, agents: { codex: author, claude: reviewer } }); hubs.push(hub); return hub;
}
async function connect(access: { url: string; token: string }) {
  const c = new Client({ name: "finding-test", version: "1" }); clients.push(c);
  await c.connect(new StreamableHTTPClientTransport(new URL(access.url), { requestInit: { headers: { Authorization: `Bearer ${access.token}` } } })); return c;
}
async function running(hub: Hub, agent: FakeAdapter, workflow: "plan" | "implement" | "review" = "plan", backend: AgentKind = "codex") {
  agent.hold(); const task = await hub.createTask({ title: "Scoped work", workflow, agent: backend, repoPath: repo, message: "Change only the requested feature", scopeEstimate: { maxFiles: 1, maxChangedLines: 2 } });
  await vi.waitFor(() => expect(agent.runs.at(-1)?.mcp).toBeDefined());
  return { task, client: await connect(agent.runs.at(-1)!.mcp!) };
}
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "hub-findings-")); repo = path.join(root, "code"); docs = path.join(root, "docs"); data = path.join(root, "data"); fs.mkdirSync(data);
  for (const dir of [repo, docs]) { fs.mkdirSync(dir); git(dir, "init", "-qb", "main"); git(dir, "config", "user.name", "Fixture"); git(dir, "config", "user.email", "fixture@example.invalid"); fs.writeFileSync(path.join(dir, "README.md"), "Fixture\n"); git(dir, "add", "--", "README.md"); git(dir, "commit", "-qm", "fixture"); }
  db = openDb(path.join(root, "hub.db")); tools = new ToolServer(new Hosts(db, root)); await tools.listen("127.0.0.1", 0); hubs = [];
});
afterEach(async () => { await Promise.all(hubs.map((h) => h.shutdown(100))); await Promise.all(clients.splice(0).map((c) => c.close())); tools.close(); vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });

it.each(["codex", "claude"] as const)("%s has durable, idempotent, project-bound tools with revoked turn authority", async (backend) => {
  configure(); const agent = new FakeAdapter(), hub = makeHub(agent);
  const { task, client } = await running(hub, agent, "plan", backend);
  expect((await client.listTools()).tools.map((t) => t.name)).toEqual(expect.arrayContaining(["record_finding", "list_findings"]));
  const first = JSON.parse(text(await client.callTool({ name: "record_finding", arguments: observation })));
  const retry = JSON.parse(text(await client.callTool({ name: "record_finding", arguments: observation })));
  expect(first).toEqual(retry); expect(first.state).toBe("pending");
  expect(fs.existsSync(path.join(docs, "personal-view"))).toBe(false);
  expect(JSON.parse(text(await client.callTool({ name: "list_findings", arguments: {} }))).items).toMatchObject([{ topic: observation.topic, state: "pending" }]);
  expect(hub.events(task.id).filter((e) => e.type === "finding_recorded")).toHaveLength(1);
  expect(hub.events(task.id).find((e) => e.type === "finding_recorded")).toMatchObject({ project: path.join(repo, ".git"), sessionId: task.sessions[0]!.id, agent: backend, revision: git(repo, "rev-parse", "HEAD") });
  for (const instruction of ["record_finding", "leave them out of this PR", "Recording never authorizes", "Traditional Chinese", "Essential blockers"]) expect(agent.runs[0]!.systemPrompt).toContain(instruction);
  agent.release(); await hub.settled(task.id);
  expect(hub.events(task.id).filter((e) => e.type === "finding_export").at(-1)).toMatchObject({ state: "exported" });
  await expect(client.listTools()).rejects.toThrow();
  const before = git(docs, "rev-parse", "HEAD"); await hub.shutdown(); const restarted = makeHub(); restarted.recoverInterrupted();
  expect(restarted.events(task.id).some((e) => e.type === "finding_recorded")).toBe(true); expect(git(docs, "rev-parse", "HEAD")).toBe(before);
});

it.each(["codex", "claude"] as const)("%s author and the other reviewer record observations without changing verdict/readiness, with bounded parent summaries", async (backend) => {
  configure(); const author = new FakeAdapter((input) => input.readOnly ? [{ type: "thread", threadId: "planner" }, { type: "done", ok: true }] : [{ type: "thread", threadId: "author" }, { type: "write", path: "feature.txt", content: backend === "claude" ? "Feature\nAdditional\n" : "Feature\n" }, { type: "done", ok: true }]);
  const reviewer = new FakeAdapter(() => [{ type: "thread", threadId: "reviewer" }, { type: "text_start" }, { type: "text_delta", text: "VERDICT: approve\nFINDINGS: none" }, { type: "done", ok: true }]);
  const hub = backend === "codex" ? makeHub(author, reviewer) : makeHub(reviewer, author);
  const { task: plan, client: planner } = await running(hub, author, "plan", backend);
  await planner.callTool({ name: "propose_task", arguments: { title: "Scoped feature", spec: "Implement feature only\nAcceptance criteria\n1. Feature works\nOut of scope\nUnrelated fixes", scopeEstimate: { maxFiles: 1, maxChangedLines: 1 } } });
  author.release(); await hub.settled(plan.id);
  const proposal = hub.events(plan.id).find((e): e is Extract<TaskEvent, { type: "task_proposal" }> => e.type === "task_proposal")!;
  author.hold(); reviewer.hold();
  const worker = await hub.createTask({ title: "Feature", workflow: "review", agent: backend, reviewer: backend === "codex" ? "claude" : "codex", message: proposal.spec, repoPath: repo, fromProposal: { taskId: plan.id, eventId: proposal.id } });
  await vi.waitFor(() => expect(author.runs.at(-1)?.readOnly).not.toBe(true));
  const a = await connect(author.runs.at(-1)!.mcp!); await a.callTool({ name: "record_finding", arguments: observation }); author.release();
  await vi.waitFor(() => expect(reviewer.runs.length).toBe(1));
  const r = await connect(reviewer.runs[0]!.mcp!); await r.callTool({ name: "record_finding", arguments: { ...observation, evidence: "Reviewer additional evidence" } });
  for (const requirement of ["met / not met / unclear", "Unrelated PR changes require removal", "never demand they be fixed in this PR"]) expect(reviewer.runs[0]!.systemPrompt).toContain(requirement);
  reviewer.release(); await hub.settled(worker.id); await hub.settled(plan.id);
  expect(hub.getTask(worker.id).options.scopeEstimate).toEqual(proposal.scopeEstimate);
  expect(hub.events(worker.id).filter((e) => e.type === "review_result")).toMatchObject([{ verdict: "approve", findings: [] }]);
  const report = hub.events(plan.id).filter((e) => e.type === "task_report").at(-1);
  expect(report).toMatchObject({ report: { outcome: "ready", filesChanged: 1, additions: backend === "claude" ? 2 : 1, deletions: 0, scopeOverrun: backend === "claude", recordedFindings: [{ topic: observation.topic, state: "exported" }] } });
  expect(git(docs, "rev-list", "--count", "HEAD")).toBe("2");
});

it("isolates projects, lists bounded pages, and old/unconfigured tasks keep recording", async () => {
  const agent = new FakeAdapter(), hub = makeHub(agent); const { task, client } = await running(hub, agent);
  const result = JSON.parse(text(await client.callTool({ name: "record_finding", arguments: observation }))); expect(result.state).toBe("unconfigured");
  await client.callTool({ name: "record_finding", arguments: { ...observation, topic: "second-topic" } });
  const list = JSON.parse(text(await client.callTool({ name: "list_findings", arguments: { offset: 0, limit: 1 } }))); expect(list.items).toHaveLength(1); expect(list.nextOffset).toBe(1);
  const otherAgent = new FakeAdapter(); otherAgent.hold(); const otherHub = makeHub(otherAgent);
  const other = await otherHub.createTask({ title: "Other project", workflow: "plan", repoPath: docs, message: "Discuss" });
  await vi.waitFor(() => expect(otherAgent.runs[0]?.mcp).toBeDefined()); const otherClient = await connect(otherAgent.runs[0]!.mcp!);
  expect(JSON.parse(text(await otherClient.callTool({ name: "list_findings", arguments: {} }))).items).toEqual([]);
  otherAgent.release(); agent.release(); await Promise.all([hub.settled(task.id), otherHub.settled(other.id)]);
});

it("exports only on normal completion or authenticated task retry, never Stop/startup", async () => {
  configure(); const agent = new FakeAdapter(), hub = makeHub(agent); const { task, client } = await running(hub, agent);
  await client.callTool({ name: "record_finding", arguments: observation });
  const app = createApp(hub, "secret-token");
  expect((await app.request(`/api/tasks/${task.id}/findings/retry`, { method: "POST" })).status).toBe(401);
  const headers = { Authorization: "Bearer secret-token" };
  expect((await app.request(`/api/tasks/${task.id}/findings/retry`, { method: "POST", headers })).status).toBe(409);
  hub.stop(task.id); agent.release(); await hub.settled(task.id); expect(git(docs, "rev-list", "--count", "HEAD")).toBe("1");
  await hub.shutdown(); const reboot = makeHub(); reboot.recoverInterrupted(); expect(git(docs, "rev-list", "--count", "HEAD")).toBe("1");
  const rebootApp = createApp(reboot, "secret-token"); expect((await rebootApp.request(`/api/tasks/${task.id}/findings/retry`, { method: "POST", headers })).status).toBe(200);
  expect(git(docs, "rev-list", "--count", "HEAD")).toBe("2"); expect((await rebootApp.request("/api/tasks/missing/findings/retry", { method: "POST", headers })).status).toBe(404);
});

it("snapshots owner/directory independently; document-only settings retain ordinary publication defaults", async () => {
  configure(); const hub = makeHub(); const task = await hub.createTask({ title: "Implement", workflow: "implement", repoPath: repo, message: "Feature", scopeEstimate: { maxFiles: 3 } }); await hub.settled(task.id);
  expect(task.options.repoSettings).toBeUndefined(); expect(task.options.findingExport).toEqual({ documentsDir: docs, owner: "Document owner" });
  configure({ documentsDir: docs, findings: { owner: "Changed owner" } }); expect(hub.getTask(task.id).options.findingExport!.owner).toBe("Document owner");
  for (const owner of ["", " ", "two\nlines", "bad\0owner", 1]) { configure({ documentsDir: docs, findings: { owner } }); expect(() => readRepoSettings(data, repo)).toThrow(/owner/); }
});

it("preserves proposal estimates through inheritance, editable clearing and start_task dispatch", async () => {
  const agent = new FakeAdapter(), hub = makeHub(agent); const { task: plan, client } = await running(hub, agent);
  const estimate = { maxFiles: 4, maxChangedLines: 80 };
  const propose = () => client.callTool({ name: "propose_task", arguments: { title: "Feature", spec: "Only feature work", scopeEstimate: estimate } });
  await propose(); await propose(); await propose();
  const proposals = hub.events(plan.id).filter((e): e is Extract<TaskEvent, { type: "task_proposal" }> => e.type === "task_proposal");
  agent.release(); await hub.settled(plan.id);
  const inherited = await hub.createTask({ title: "Inherited", workflow: "implement", message: "Feature", repoPath: repo, fromProposal: { taskId: plan.id, eventId: proposals[0]!.id } });
  const cleared = await hub.createTask({ title: "Cleared", workflow: "implement", message: "Feature", repoPath: repo, scopeEstimate: null, fromProposal: { taskId: plan.id, eventId: proposals[1]!.id } });
  await Promise.all([hub.settled(inherited.id), hub.settled(cleared.id)]);
  expect(inherited.options.scopeEstimate).toEqual(estimate); expect(cleared.options.scopeEstimate).toBeUndefined();
  agent.hold(); hub.sendMessage(plan.id, "Start the latest proposal");
  await vi.waitFor(() => expect(agent.runs.at(-1)?.prompt).toContain("Start the latest proposal"));
  const fresh = await connect(agent.runs.at(-1)!.mcp!);
  const dispatched = JSON.parse(text(await fresh.callTool({ name: "start_task", arguments: { proposal: proposals[2]!.id } })));
  expect(hub.getTask(dispatched.taskId).options.scopeEstimate).toEqual(estimate);
  agent.release(); await Promise.all([hub.settled(plan.id), hub.settled(dispatched.taskId)]);
  for (const scopeEstimate of [{ maxFiles: 0 }, { maxChangedLines: -1 }, { maxFiles: 1.5 }, { maxFiles: Number.MAX_SAFE_INTEGER + 1 }]) await expect(hub.createTask({ title: "Invalid", workflow: "implement", message: "Feature", repoPath: repo, scopeEstimate })).rejects.toThrow(/positive/);
});

it("persists cumulative added-plus-deleted counts including binary file warnings", async () => {
  const author = new FakeAdapter((_input, n) => [
    { type: "thread", threadId: "author" },
    { type: "write", path: "README.md", content: "Replaced\n" },
    { type: "write", path: n === 1 ? "one.txt" : "two.txt", content: "Added\n" },
    { type: "write", path: "binary.dat", content: "\0binary" },
    { type: "done", ok: true },
  ]);
  const hub = makeHub(author); const task = await hub.createTask({ title: "Cumulative", workflow: "implement", repoPath: repo, message: "Feature", scopeEstimate: { maxFiles: 3, maxChangedLines: 3 } }); await hub.settled(task.id);
  expect(hub.events(task.id).filter((e) => e.type === "diff_snapshot").at(-1)).toMatchObject({ filesChanged: 3, additions: 2, deletions: 1, binaryFiles: 1 });
  hub.sendMessage(task.id, "Authorized follow-up"); await hub.settled(task.id);
  expect(hub.events(task.id).filter((e) => e.type === "diff_snapshot").at(-1)).toMatchObject({ filesChanged: 4, additions: 3, deletions: 1, binaryFiles: 1 });
  expect((await hub.diff(task.id)).filter((f) => f.binary)).toMatchObject([{ path: "binary.dat" }]);
  const reboot = makeHub(); reboot.recoverInterrupted(); expect(reboot.getTask(task.id).options.scopeEstimate).toEqual({ maxFiles: 3, maxChangedLines: 3 });
});

it("chat grants exclude both finding tools", async () => {
  const agent = new FakeAdapter(); agent.hold(); const hub = makeHub(agent);
  const task = await hub.createTask({ title: "Chat", workflow: "chat", message: "Hello" });
  await vi.waitFor(() => expect(agent.runs[0]?.mcp).toBeDefined()); const c = await connect(agent.runs[0]!.mcp!);
  expect((await c.listTools()).tools.map((t) => t.name)).not.toEqual(expect.arrayContaining(["record_finding", "list_findings"]));
  expect((await c.callTool({ name: "record_finding", arguments: observation })).isError).toBe(true);
  agent.release(); await hub.settled(task.id);
});

it("rejects callbacks after the normal turn ends and ignores forged project/task authority", async () => {
  const issue = vi.spyOn(tools, "issue"); const agent = new FakeAdapter(), hub = makeHub(agent);
  const { task, client } = await running(hub, agent);
  const forged = await client.callTool({ name: "record_finding", arguments: { ...observation, taskId: "other-task", project: docs, root: docs } });
  if (!forged.isError) expect(hub.events(task.id).find((e) => e.type === "finding_recorded")).toMatchObject({ project: path.join(repo, ".git"), taskId: task.id });
  const callbacks = issue.mock.calls.at(-1)![4]!;
  agent.release(); await hub.settled(task.id);
  await expect(callbacks.record({ ...observation, topic: "late-topic" })).rejects.toThrow(/ended/);
  await expect(callbacks.list(0, 25)).rejects.toThrow(/ended/);
  expect(hub.events(task.id).filter((e) => e.type === "finding_recorded").every((e) => e.project === path.join(repo, ".git"))).toBe(true);
});

it("startup report delivery cannot silently flush pending external writes", async () => {
  configure(); const agent = new FakeAdapter(), hub = makeHub(agent); const { task, client } = await running(hub, agent);
  await client.callTool({ name: "record_finding", arguments: observation }); hub.stop(task.id); agent.release(); await hub.settled(task.id);
  const worker = await hub.createTask({ title: "Worker", workflow: "chat", message: "Completed" }); await hub.settled(worker.id); await hub.shutdown();
  const report = { taskId: worker.id, title: "Worker", outcome: "ready" as const, finalSeq: 1, rounds: 1, lastVerdict: "approve" as const, findings: [], test: "none" as const, filesChanged: 0, additions: 0, deletions: 0, branch: "agent-hub/worker" };
  db.insert(schema.events).values({ id: "startup-report", taskId: task.id, sessionId: null, seq: hub.events(task.id).at(-1)!.seq + 1, createdAt: new Date().toISOString(), type: "task_report", payload: { report } }).run();
  const restarted = makeHub(); restarted.recoverInterrupted(); await restarted.settled(task.id);
  expect(git(docs, "rev-list", "--count", "HEAD")).toBe("1");
  restarted.sendMessage(task.id, "Continue the authorized discussion"); await restarted.settled(task.id);
  expect(git(docs, "rev-list", "--count", "HEAD")).toBe("2");
});

it("uses the same project catalogue for original and linked worktree requests", async () => {
  const agent = new FakeAdapter(), hub = makeHub(agent); const { task, client } = await running(hub, agent);
  await client.callTool({ name: "record_finding", arguments: observation }); agent.release(); await hub.settled(task.id);
  const alias = path.join(root, "linked"); git(repo, "worktree", "add", "-qb", "linked", alias);
  agent.hold(); const other = await hub.createTask({ title: "Linked checkout", workflow: "plan", repoPath: alias, message: "Discuss" });
  await vi.waitFor(() => expect(agent.runs.at(-1)?.cwd).toBe(alias)); const c = await connect(agent.runs.at(-1)!.mcp!);
  expect(JSON.parse(text(await c.callTool({ name: "list_findings", arguments: {} }))).items).toMatchObject([{ topic: observation.topic }]);
  expect(other.options.findingProject).toBe(task.options.findingProject); agent.release(); await hub.settled(other.id);
});

it("counts a renamed file once in the cumulative diff", async () => {
  const author = new FakeAdapter((input) => { fs.renameSync(path.join(input.cwd, "README.md"), path.join(input.cwd, "guide.md")); return [{ type: "done", ok: true }]; });
  const hub = makeHub(author); const task = await hub.createTask({ title: "Rename", workflow: "implement", repoPath: repo, message: "Rename the guide", scopeEstimate: { maxFiles: 1 } }); await hub.settled(task.id);
  expect(hub.events(task.id).filter((e) => e.type === "diff_snapshot").at(-1)).toMatchObject({ filesChanged: 1, additions: 0, deletions: 0 });
  expect(await hub.diff(task.id)).toMatchObject([{ path: "guide.md" }]);
});

it("keeps unrelated agent streams and authenticated API/heartbeat responses live during delayed export Git", async () => {
  configure(); const agent = new FakeAdapter(), hub = makeHub(agent); const { task, client } = await running(hub, agent);
  await client.callTool({ name: "record_finding", arguments: observation });
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const git = exportIo.findingGit; let delayed = false;
  vi.spyOn(exportIo, "findingGit").mockImplementation(async (...args) => {
    if (!delayed && args[0] === docs) { delayed = true; entered(); await gate; }
    return git(...args);
  });
  agent.release(); await ready;
  let heartbeats = 0; const timer = setInterval(() => { heartbeats++; }, 5);
  try {
    const other = await hub.createTask({ title: "Independent stream", workflow: "chat", message: "Continue independently" }); await hub.settled(other.id);
    expect(hub.events(other.id).some((e) => e.type === "agent_text" && e.text.includes("independently"))).toBe(true);
    const app = createApp(hub, "fixture-token");
    expect((await app.request(`/api/tasks/${task.id}/events`, { headers: { Authorization: "Bearer fixture-token" } })).status).toBe(200);
    await vi.waitFor(() => expect(heartbeats).toBeGreaterThan(1));
    expect(hub.getTask(task.id).status).toBe("running"); expect(hub.events(task.id).some((e) => e.type === "finding_export" && e.state === "exported")).toBe(false);
  } finally { clearInterval(timer); release(); }
  await hub.settled(task.id); expect(hub.events(task.id).filter((e) => e.type === "finding_export").at(-1)).toMatchObject({ state: "exported" });
});

it.each(["stop", "shutdown"] as const)("%s cancels delayed export work without new documentation commits", async (action) => {
  configure(); const agent = new FakeAdapter(), hub = makeHub(agent); const { task, client } = await running(hub, agent);
  await client.callTool({ name: "record_finding", arguments: observation });
  const original = exportIo.findingGit; let entered!: () => void, delayed = false;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  vi.spyOn(exportIo, "findingGit").mockImplementation(async (...args) => {
    if (!delayed && args[0] === docs) {
      delayed = true; entered(); await new Promise<void>((resolve) => { args[2].signal!.addEventListener("abort", () => resolve(), { once: true }); });
    }
    return original(...args);
  });
  agent.release(); await ready;
  if (action === "stop") {
    const app = createApp(hub, "fixture-token");
    expect((await app.request(`/api/tasks/${task.id}/stop`, { method: "POST", headers: { Authorization: "Bearer fixture-token" } })).status).toBe(200);
  } else await hub.shutdown();
  await hub.settled(task.id); expect(git(docs, "rev-list", "--count", "HEAD")).toBe("1");
  expect(hub.events(task.id).some((e) => e.type === "finding_recorded")).toBe(true);
  expect(hub.events(task.id).filter((e): e is Extract<TaskEvent, { type: "finding_export" }> => e.type === "finding_export").at(-1)?.reason).toMatch(/cancel|abort/i);
});

it("normal B turns and its authenticated retry never change exported A observations or Git history", async () => {
  configure(); const agent = new FakeAdapter(), hub = makeHub(agent); const a = await running(hub, agent);
  await a.client.callTool({ name: "record_finding", arguments: observation }); agent.release(); await hub.settled(a.task.id);
  const codeB = path.join(root, "code-b"), docsB = path.join(root, "docs-b");
  for (const dir of [codeB, docsB]) { fs.mkdirSync(dir); git(dir, "init", "-qb", "main"); git(dir, "config", "user.name", "Fixture"); git(dir, "config", "user.email", "fixture@example.invalid"); fs.writeFileSync(path.join(dir, "README.md"), "Fixture\n"); git(dir, "add", "--", "README.md"); git(dir, "commit", "-qm", "fixture"); }
  fs.writeFileSync(path.join(data, "repos.json"), JSON.stringify({ [repo]: { documentsDir: docs, findings: { owner: "Owner A" } }, [codeB]: { documentsDir: docsB, findings: { owner: "Owner B" } } }));
  const eventsA = JSON.stringify(hub.events(a.task.id)); const headA = git(docs, "rev-parse", "HEAD");
  const noteA = fs.readFileSync(path.join(docs, "personal-view", "agent-findings", `${observation.topic}.md`), "utf8");
  const indexA = fs.readFileSync(path.join(docs, ".git", "index"));
  agent.hold(); const b = await hub.createTask({ title: "B", workflow: "plan", repoPath: codeB, message: "Discuss B" });
  await vi.waitFor(() => expect(agent.runs.at(-1)?.cwd).toBe(codeB)); const c = await connect(agent.runs.at(-1)!.mcp!);
  await c.callTool({ name: "record_finding", arguments: { ...observation, topic: "b-topic" } }); agent.release(); await hub.settled(b.id);
  const app = createApp(hub, "fixture-token");
  expect((await app.request(`/api/tasks/${b.id}/findings/retry`, { method: "POST", headers: { Authorization: "Bearer fixture-token" } })).status).toBe(200);
  expect(JSON.stringify(hub.events(a.task.id))).toBe(eventsA); expect(git(docs, "rev-parse", "HEAD")).toBe(headA);
  expect(fs.readFileSync(path.join(docs, "personal-view", "agent-findings", `${observation.topic}.md`), "utf8")).toBe(noteA); expect(fs.readFileSync(path.join(docs, ".git", "index"))).toEqual(indexA);
  expect(fs.readdirSync(path.join(docsB, "personal-view", "agent-findings"))).toEqual(["b-topic.md"]);
  expect(hub.events(b.id).filter((e) => e.type === "finding_export").every((e) => e.type === "finding_export" && e.state === "exported")).toBe(true);
});
