import { briefingFixture } from "./briefing-fixture";
import { createApp } from "../src/app";
import { eq, sql } from "drizzle-orm";
import { schema } from "../src/db/index";
import { execFileSync } from "node:child_process";
import { PLANNER_SYSTEM, REVIEWER_SYSTEM } from "../src/core/prompts";
import fs from "node:fs";
import asyncFs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { NewTaskInput, TaskEvent, TaskEventPayload, Workspace } from "@agent-hub/shared";
import { FakeAdapter, type FakeStep } from "../src/agents/fake";
import { Hub, type HubOptions } from "../src/core/hub";
import { openDb, type Db } from "../src/db/index";
import { notifyDiscord } from "../src/notify/discord";
import { Hosts } from "../src/tools/hosts";
import { ToolServer } from "../src/tools/mcp";
import { CommentWriteError } from "../src/workspace/forge";
import type { Forge, Issue, IssueState } from "../src/workspace/forge";
import { HOST_INPUT_EVENT_WINDOW, HOST_INPUT_TEXT_LIMIT } from "../src/core/invocations";
import type { WorkflowDeps } from "../src/core/workflows/types";

let root: string;
let repo: string;
let db: Db;
let tools: ToolServer;
let hubs: Hub[];
const clients: Client[] = [];
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-hub-plan-"));
  repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  git("init", "-q", "-b", "main");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Test");
  fs.writeFileSync(path.join(repo, "README.md"), "Original checkout\n");
  git("add", ".");
  git("commit", "-qm", "initial fixture");
  db = openDb(path.join(root, "hub.db"));
  tools = new ToolServer(new Hosts(db, root));
  await tools.listen("127.0.0.1", 0);
  hubs = [];
});

afterEach(async () => {
  await Promise.all(hubs.map((hub) => hub.shutdown(100)));
  await Promise.all(clients.splice(0).map((client) => client.close()));
  tools.close();
  fs.rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function makeHub(agent = new FakeAdapter(), extra: Partial<HubOptions> = {}) {
  const original = agent.run.bind(agent);
  agent.run = async function* (input) {
    const fixture = briefingFixture(input);
    if (fixture) { agent.runs.push(input); for (const event of fixture) if (event.type !== "write" && event.type !== "ask") yield event; }
    else yield* original(input);
  };
  const hub = new Hub({ db, tools, agents: { codex: agent, claude: agent }, dataDir: path.join(root, "data"), maxConcurrent: 4, flushMs: 1, ...extra });
  hubs.push(hub);
  return hub;
}

const plan = (): NewTaskInput => ({ title: "Plan CD", workflow: "plan", repoPath: repo, message: "I want CD" });
const proposal = { title: "Add deployment", spec: "Background: add deployment.\n\nChange deploy.ts only. Add deployment tests and update the runbook. Do not edit files outside this scope.", testCommand: "git diff --check" };

const issue: Issue = {
  number: 7, title: "Add deployment", state: "open", labels: ["enhancement"],
  url: "https://github.com/example/project/issues/7", body: "Deploy after approval",
  comments: [{ author: "example", date: "2026-01-01T00:00:00Z", text: "Include a rollback command" }],
};

function fakeForge() {
  return {
    repoOf: vi.fn(async (_path: string): Promise<string | null> => "example/project"),
    listIssues: vi.fn(async (_repo: string, _state: IssueState | "all", _limit: number) => [issue]),
    readIssue: vi.fn(async (_repo: string, number: number) => {
      if (number !== issue.number) throw new Error(`gh api failed: issue #${number} not found (404)`);
      return issue;
    }),
    createIssueComment: vi.fn(async (_repo: string, _number: number, _body: string) => ({ id: 42, url: `${issue.url}#issuecomment-42` })),
    reconcileIssueComment: vi.fn(async () => ({ state: "unknown" as const })),
    push: vi.fn(async (_ws: Workspace) => {}),
    openPullRequest: vi.fn(async (_ws: Workspace, _repo: string, _title: string, _body: string) => ({ number: 8, url: "https://github.com/example/project/pull/8", state: "open" as const })),
    state: vi.fn(async () => "open" as const),
    close: vi.fn(async () => {}),
  } satisfies Forge;
}

const toolText = (result: Awaited<ReturnType<Client["callTool"]>>) => (result.content as { text: string }[]).map((content) => content.text).join("\n");

async function connect(access: { url: string; token: string }) {
  const client = new Client({ name: "test", version: "1" });
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL(access.url), { requestInit: { headers: { Authorization: `Bearer ${access.token}` } } }));
  return client;
}

async function propose(hub: Hub, agent: FakeAdapter) {
  agent.hold();
  const task = await hub.createTask(plan());
  await vi.waitFor(() => expect(agent.runs.at(-1)?.mcp).toBeDefined());
  const client = await connect(agent.runs.at(-1)!.mcp!);
  const result = await client.callTool({ name: "propose_task", arguments: proposal });
  expect(result.content).toEqual([{ type: "text", text: "Proposal shown to the user" }]);
  const event = hub.events(task.id).find((event): event is Extract<TaskEvent, { type: "task_proposal" }> => event.type === "task_proposal")!;
  agent.release();
  await hub.settled(task.id);
  return { task, event };
}

describe("task base branch", () => {
  beforeEach(() => {
    const remote = path.join(root, "base-remote.git");
    execFileSync("git", ["init", "--bare", "-q", remote]);
    git("remote", "add", "origin", remote);
    git("push", "-q", "origin", "HEAD:refs/heads/main");
    git("switch", "-qc", "stack/lower");
    fs.writeFileSync(path.join(repo, "lower.txt"), "lower layer\n");
    git("add", ".");
    git("commit", "-qm", "lower layer");
    git("push", "-q", "origin", "stack/lower");
    git("switch", "-q", "-");
    git("branch", "-qD", "stack/lower");
    git("update-ref", "-d", "refs/remotes/origin/stack/lower"); // proves the base is fetched, not assumed
  });
  const worker = (base?: string): NewTaskInput => ({ title: "Stacked", workflow: "implement", repoPath: repo, message: "Do it", base });
  const remoteTip = () => execFileSync("git", ["ls-remote", "origin", "refs/heads/stack/lower"], { cwd: repo, encoding: "utf8" }).split("\t")[0];

  it.each(["stack/lower", "origin/stack/lower"])("starts a worker from %s and targets it", async (base) => {
    const task = await makeHub().createTask(worker(base));
    expect(task.workspace).toMatchObject({ baseRef: "origin/stack/lower", prBase: "stack/lower", baseSha: remoteTip() });
    expect(fs.existsSync(path.join(task.workspace!.worktreePath, "lower.txt"))).toBe(true);
  });

  it("refuses a branch origin does not have and a bad name, without creating a task", async () => {
    const hub = makeHub();
    await expect(hub.createTask(worker("stack/missing"))).rejects.toThrow(/not found on origin/);
    await expect(hub.createTask(worker("../escape"))).rejects.toThrow(/not a valid branch name/);
    expect(hub.listTasks()).toHaveLength(0);
  });

  it("keeps the configured base when none is given", async () => {
    fs.mkdirSync(path.join(root, "data"), { recursive: true });
    fs.writeFileSync(path.join(root, "data", "repos.json"), JSON.stringify({ [repo]: { base: "origin/main" } }));
    const task = await makeHub().createTask(worker());
    expect(task.workspace).toMatchObject({ baseRef: "origin/main", prBase: "main" });
  });

  it("plans in a worktree at the base, follows it each turn, and leaves the user's checkout alone", async () => {
    fs.writeFileSync(path.join(repo, "user-notes.txt"), "Uncommitted notes\n");
    const before = git("rev-parse", "HEAD");
    const agent = new FakeAdapter();
    const hub = makeHub(agent);
    const task = await hub.createTask({ ...plan(), base: "stack/lower" });
    await hub.settled(task.id);
    const checkout = task.options.planCheckout!;
    expect(checkout.ref).toBe("origin/stack/lower");
    const run = agent.runs.find((r) => r.cwd === checkout.path)!;
    expect(run.turnContext).toContain("read-only worktree at origin/stack/lower");
    expect(fs.existsSync(path.join(checkout.path, "lower.txt"))).toBe(true);
    expect(fs.existsSync(path.join(checkout.path, "user-notes.txt"))).toBe(false);

    const other = path.join(root, "other-clone");
    execFileSync("git", ["clone", "-q", "-b", "stack/lower", path.join(root, "base-remote.git"), other]);
    fs.writeFileSync(path.join(other, "newer.txt"), "newer\n");
    fs.writeFileSync(path.join(checkout.path, "stray.txt"), "left by an agent\n");
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "add", "."], { cwd: other });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "newer"], { cwd: other });
    execFileSync("git", ["push", "-q", "origin", "stack/lower"], { cwd: other });
    hub.sendMessage(task.id, "again");
    await hub.settled(task.id);
    expect(agent.runs.at(-1)!.turnContext).toContain(remoteTip());
    expect(fs.existsSync(path.join(checkout.path, "newer.txt"))).toBe(true);
    expect(fs.existsSync(path.join(checkout.path, "stray.txt"))).toBe(false);

    expect(git("rev-parse", "HEAD")).toBe(before);
    expect(fs.readFileSync(path.join(repo, "user-notes.txt"), "utf8")).toBe("Uncommitted notes\n");
    await hub.deleteTask(task.id);
    expect(fs.existsSync(checkout.path)).toBe(false);
    expect(fs.readFileSync(path.join(repo, "user-notes.txt"), "utf8")).toBe("Uncommitted notes\n");
  });

  it("keeps planning when the fetch fails, and says the worktree may be behind", async () => {
    const agent = new FakeAdapter();
    const hub = makeHub(agent);
    const task = await hub.createTask({ ...plan(), base: "stack/lower" });
    await hub.settled(task.id);
    git("remote", "set-url", "origin", path.join(root, "gone.git"));
    hub.sendMessage(task.id, "again");
    await hub.settled(task.id);
    expect(agent.runs.at(-1)!.cwd).toBe(task.options.planCheckout!.path);
    expect(agent.runs.at(-1)!.turnContext).toMatch(/fetch from origin failed/);
  });

  it("plans in the checkout when no base is configured", async () => {
    const agent = new FakeAdapter();
    const hub = makeHub(agent);
    const task = await hub.createTask(plan());
    await hub.settled(task.id);
    expect(task.options.planCheckout).toBeUndefined();
    expect(fs.realpathSync(agent.runs[0]!.cwd)).toBe(fs.realpathSync(repo));
  });

  it("gives a worker the plan's base when the proposal names none", async () => {
    const agent = new FakeAdapter();
    const hub = makeHub(agent);
    agent.hold();
    const plannerTask = await hub.createTask({ ...plan(), base: "stack/lower" });
    await vi.waitFor(() => expect(agent.runs.at(-1)?.mcp).toBeDefined());
    const client = await connect(agent.runs.at(-1)!.mcp!);
    expect((await client.callTool({ name: "propose_task", arguments: proposal })).isError).toBeFalsy();
    agent.release();
    await hub.settled(plannerTask.id);
    const planner = await plannerTurn(hub, agent, plannerTask.id);
    expect((await planner.callTool({ name: "start_task", arguments: {} })).isError).toBeFalsy();
    const worker = hub.listTasks().find((t) => t.options.reportsTo === plannerTask.id)!;
    expect(hub.getTask(worker.id).workspace).toMatchObject({ baseRef: "origin/stack/lower", prBase: "stack/lower" });
  });

  it("asks planners to surface excluded risks and reviewers to look past the criteria", () => {
    expect(PLANNER_SYSTEM).toContain("put it in knownRisks");
    expect(REVIEWER_SYSTEM).toContain("who else writes the state it changes");
    expect(REVIEWER_SYSTEM).toContain("otherwise leave the verdict alone");
  });

  it("shows a proposal's known risks to the user and keeps them from the worker", async () => {
    const agent = new FakeAdapter();
    const hub = makeHub(agent);
    agent.hold();
    const plannerTask = await hub.createTask(plan());
    await vi.waitFor(() => expect(agent.runs.at(-1)?.mcp).toBeDefined());
    const client = await connect(agent.runs.at(-1)!.mcp!);
    const knownRisks = ["A concurrent heartbeat can undo a drain; fix before ACME-62"];
    expect((await client.callTool({ name: "propose_task", arguments: { ...proposal, knownRisks } })).isError).toBeFalsy();
    expect((await client.callTool({ name: "propose_task", arguments: { ...proposal, knownRisks: [""] } })).isError).toBe(true);
    agent.release();
    await hub.settled(plannerTask.id);
    expect(hub.events(plannerTask.id).filter((e) => e.type === "task_proposal")).toMatchObject([{ knownRisks }]);
    const planner = await plannerTurn(hub, agent, plannerTask.id);
    expect((await planner.callTool({ name: "start_task", arguments: {} })).isError).toBeFalsy();
    agent.release();
    const worker = hub.listTasks().find((t) => t.options.reportsTo === plannerTask.id)!;
    await hub.settled(worker.id);
    expect(agent.runs.filter((r) => r.prompt.includes(proposal.spec)).length).toBeGreaterThan(0);
    expect(agent.runs.filter((r) => r.prompt.includes(proposal.spec)).some((r) => r.prompt.includes(knownRisks[0]!))).toBe(false);
  });

  it("carries a proposal's base to the worker the planner starts, and rejects an unknown one", async () => {
    const agent = new FakeAdapter();
    const hub = makeHub(agent);
    agent.hold();
    const plannerTask = await hub.createTask(plan());
    await vi.waitFor(() => expect(agent.runs.at(-1)?.mcp).toBeDefined());
    const client = await connect(agent.runs.at(-1)!.mcp!);
    const bad = await client.callTool({ name: "propose_task", arguments: { ...proposal, base: "stack/missing" } });
    expect(bad.isError).toBe(true);
    expect(toolText(bad)).toMatch(/not found on origin/);
    const good = await client.callTool({ name: "propose_task", arguments: { ...proposal, base: "stack/lower" } });
    expect(good.isError).toBeFalsy();
    agent.release();
    await hub.settled(plannerTask.id);
    expect(hub.events(plannerTask.id).filter((e) => e.type === "task_proposal")).toMatchObject([{ base: "stack/lower" }]);
    const planner = await plannerTurn(hub, agent, plannerTask.id);
    const started = await planner.callTool({ name: "start_task", arguments: {} });
    expect(started.isError).toBeFalsy();
    const dispatched = hub.listTasks().find((t) => t.options.reportsTo === plannerTask.id)!;
    expect(hub.getTask(dispatched.id).workspace).toMatchObject({ baseRef: "origin/stack/lower", prBase: "stack/lower" });
  });
});

describe("plan workflow", () => {
  it("does not allow E3 downloads", async () => {
    const issue = vi.spyOn(tools, "issue");
    const hub = makeHub();
    const task = await hub.createTask(plan());
    await hub.settled(task.id);
    expect(issue.mock.calls[0]![5]).toEqual({ e3Download: false, devices: true });
  });

  it.each([
    { agentKind: "codex", mapAvailable: false },
    { agentKind: "claude", mapAvailable: false },
    { agentKind: "codex", mapAvailable: true },
    { agentKind: "claude", mapAvailable: true },
  ] as const)("runs $agentKind map-first and read-only with mapAvailable=$mapAvailable, keeps the conversation, and skips unavailable references", async ({ agentKind, mapAvailable }) => {
    const agent = new FakeAdapter();
    const reference = path.join(root, "reference repository");
    fs.mkdirSync(reference);
    const missing = path.join(root, "missing");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const hub = makeHub(agent, { referenceDirs: [reference, missing] });
    if (mapAvailable) {
      fs.mkdirSync(path.join(repo, "docs"));
      fs.writeFileSync(path.join(repo, "docs", "knowledge-map.md"), "# Knowledge Map\n\n[Design](design.md)\n");
    }
    expect(fs.existsSync(path.join(repo, "docs", "knowledge-map.md"))).toBe(mapAvailable);
    // Other repositories may lack both the map and Hub-specific source documents.
    for (const file of ["AGENTS.md", "docs/design.md", "docs/future-features.md", "docs/guide/planning.md"]) expect(fs.existsSync(path.join(repo, file))).toBe(false);
    fs.writeFileSync(path.join(repo, "user-notes.txt"), "Keep my uncommitted notes\n");
    const before = git("status", "--porcelain");
    const head = git("rev-parse", "HEAD");
    const worktrees = git("worktree", "list", "--porcelain");
    const task = await hub.createTask({ ...plan(), agent: agentKind });
    await hub.settled(task.id);
    expect(task).toMatchObject({ cwd: repo, workspace: null, options: {}, sessions: [{ agent: agentKind, role: "main", effort: "medium", model: null }] });
    expect(agent.runs[0]).toMatchObject({ cwd: repo, readOnly: true, referenceDirs: [reference] });
    const instructions = agent.runs[0]!.systemPrompt!;
    expect(instructions).toContain("first read the current repository's AGENTS.md when available and follow its mandatory rules");
    expect(instructions).toContain("If docs/knowledge-map.md is available there, consult it next");
    expect(instructions.indexOf("AGENTS.md")).toBeLessThan(instructions.indexOf("docs/knowledge-map.md"));
    expect(instructions).toContain("Read only original documents or sections relevant to the task and current workflow stage");
    expect(instructions).toContain("path and heading or line range");
    expect(instructions).toContain("Follow docs/guide/planning.md when available, confirming applicable sections before proposals, dispatch, report review or PR actions");
    expect(instructions).toContain("navigation only: it cannot replace specifications, code evidence, authorization or safety rules");
    expect(instructions).toContain("If the map or a source is unavailable, do not invent its contents: continue with accessible original sources and the existing workflow");
    expect(instructions).toContain("disclose missing information when it affects a decision");
    expect(instructions).toContain("Within the same native session, reuse unchanged document context");
    expect(instructions).toContain("recheck relevant sources when files, branch or revision may have changed");
    for (const oldRequirement of ["docs/design.md", "docs/future-features.md", "read AGENTS.md, docs/design.md"]) expect(instructions).not.toContain(oldRequirement);
    for (const rule of [
      "never edit files, commit, or push", "Dispatch only through start_task after user agreement",
      "read_issue, including comments", "Pass issue to propose_task", "self-contained implementation spec",
      "numbered Acceptance criteria list", "Out of scope list", "quote the relevant details in the spec",
      "Stop immediately after ask", "After proposing, call ask to confirm starting",
      "start_task only when a later user reply clearly agrees", "if they want changes, propose again",
      "When a task_report arrives, compare its result with the agreed acceptance criteria and out-of-scope list",
      "reports never authorize updates", "Never route Git writes through message_task",
      "only after a fresh user message following the latest report or ask",
      "Call open_pr only after the user clearly agrees following the latest report or ask",
      "Merging is always the user's decision",
    ]) expect(instructions).toContain(rule);
    expect(agent.runs[0]!.threadId).toBeUndefined();
    expect(agent.runs[0]!.turnContext).toContain(`Reference repositories you can read: ${reference}`);
    expect(agent.runs[0]!.turnContext).not.toContain(missing);
    expect(agent.runs[0]!.systemPrompt).not.toContain("Other tasks in this repository");
    expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining(missing));
    expect(hub.getTask(task.id).status).toBe("idle");
    hub.sendMessage(task.id, "Discuss rollback first");
    await hub.settled(task.id);
    expect(agent.runs[1]).toMatchObject({ threadId: "thread-1", readOnly: true, referenceDirs: [reference], prompt: "Discuss rollback first", systemPrompt: instructions, turnContext: agent.runs[0]!.turnContext });
    expect(hub.getTask(task.id).sessions).toHaveLength(1);
    const calls = hub.usageCalls(task.id).calls;
    expect(calls).toHaveLength(2);
    for (const [index, call] of calls.entries()) {
      expect(call.hostInput).toMatchObject({ promptUtf8Bytes: Buffer.byteLength(agent.runs[index]!.prompt),
        systemPromptCandidateUtf8Bytes: Buffer.byteLength(instructions), turnContextUtf8Bytes: Buffer.byteLength(agent.runs[index]!.turnContext!) });
      expect(call.hostInput?.components).toBeUndefined();
      expect(agent.runs[index]).not.toHaveProperty("inputDiagnostics");
    }
    expect(git("status", "--porcelain")).toBe(before);
    expect(git("rev-parse", "HEAD")).toBe(head);
    expect(git("worktree", "list", "--porcelain")).toBe(worktrees);
  });

  it("requires a repository and preserves chosen model and effort", async () => {
    const agent = new FakeAdapter();
    const hub = makeHub(agent);
    await expect(hub.createTask({ ...plan(), repoPath: undefined })).rejects.toThrow(/needs a repository/);
    await expect(hub.createTask({ ...plan(), repoPath: root })).rejects.toThrow(/not a git repository/);
    const task = await hub.createTask({ ...plan(), model: "chosen-model", effort: "xhigh" });
    await hub.settled(task.id);
    expect(agent.runs[0]).toMatchObject({ model: "chosen-model", effort: "xhigh" });
  });

  it("never deletes a planning checkout, even when it is under the Hub's scratch directory", async () => {
    const scratch = path.join(root, "data", "scratch");
    fs.mkdirSync(scratch, { recursive: true });
    const checkout = path.join(scratch, "repo");
    fs.renameSync(repo, checkout);
    repo = checkout;
    fs.writeFileSync(path.join(repo, "user-notes.txt"), "Uncommitted notes\n");
    const hub = makeHub();
    const task = await hub.createTask(plan());
    await hub.settled(task.id);
    await hub.deleteTask(task.id);
    expect(fs.readFileSync(path.join(repo, "user-notes.txt"), "utf8")).toBe("Uncommitted notes\n");
    expect(git("branch", "--show-current")).toBe("main");
    expect(hub.listTasks()).toEqual([]);
  });

  it("refreshes other running tasks and idle open workspaces in the planning context", async () => {
    const worker = new FakeAdapter();
    const planner = new FakeAdapter();
    const hub = makeHub(planner, { agents: { claude: worker, codex: planner } });
    const idle = await hub.createTask({ ...plan(), title: "Open change", workflow: "implement", agent: "claude" });
    await hub.settled(idle.id);
    const task = await hub.createTask(plan());
    await hub.settled(task.id);
    expect(planner.runs[0]!.turnContext).toContain(`"Open change": ${idle.workspace!.branch}`);
    worker.hold();
    const running = await hub.createTask({ ...plan(), title: "Running change", workflow: "implement", agent: "claude" });
    await vi.waitFor(() => expect(worker.runs).toHaveLength(2));
    hub.sendMessage(task.id, "Continue planning");
    await hub.settled(task.id);
    expect(planner.runs[1]!.turnContext).toContain(`"Running change": ${running.workspace!.branch}`);
    expect(planner.runs[1]!.turnContext).not.toContain('"Plan CD":');
    worker.release();
    await hub.settled(running.id);
    await hub.discard(idle.id);
    hub.sendMessage(task.id, "Check conflicts again");
    await hub.settled(task.id);
    expect(planner.runs[2]!.turnContext).not.toContain('"Open change":');
  });

  it.each(["codex", "claude"] as const)("offers planning tools only in %s plan turns, without tools that bypass the read-only checkout", async (agentKind) => {
    const agent = new FakeAdapter();
    const hub = makeHub(agent, { referenceDirs: [repo] });
    for (const workflow of ["plan", "chat", "implement", "review"] as const) {
      agent.hold();
      const task = await hub.createTask({ ...plan(), workflow, agent: agentKind });
      await vi.waitFor(() => expect(agent.runs.at(-1)?.mcp).toBeDefined());
      const client = await connect(agent.runs.at(-1)!.mcp!);
      const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
      expect(names).toEqual(workflow === "plan" ? ["abandon_pr_update", "ask", "host_status", "list_findings", "list_hosts", "list_issues", "list_project_docs", "message_task", "open_pr", "propose_task", "read_issue", "read_project_doc", "read_service_log", "read_task_log", "read_task_test_output", "record_finding", "search_project_docs", "search_task_log", "start_task", "update_pr"] : workflow === "chat" ? ["copy_file", "list_hosts", "ssh_exec"] : ["copy_file", "list_findings", "list_hosts", "record_finding", "ssh_exec"]);
      if (workflow !== "plan") {
        for (const name of ["host_status", "read_service_log", "read_task_log", "read_task_test_output", "search_task_log", "list_project_docs", "search_project_docs", "read_project_doc"]) expect((await client.callTool({ name, arguments: {} })).isError).toBe(true);
        expect((await client.callTool({ name: "ask", arguments: { question: "Start?" } })).isError).toBe(true);
        expect((await client.callTool({ name: "message_task", arguments: { task: task.id, text: "Fix it" } })).isError).toBe(true);
        expect(agent.runs.at(-1)!.referenceDirs).toBeUndefined();
        expect((await client.callTool({ name: "propose_task", arguments: proposal })).isError).toBe(true);
        expect((await client.callTool({ name: "start_task", arguments: {} })).isError).toBe(true);
        expect((await client.callTool({ name: "open_pr", arguments: { task: task.id } })).isError).toBe(true);
        expect((await client.callTool({ name: "list_issues", arguments: {} })).isError).toBe(true);
        expect((await client.callTool({ name: "read_issue", arguments: { number: 7 } })).isError).toBe(true);
      }
      agent.release();
      await hub.settled(task.id);
    }
  });

  it.each(["codex", "claude"] as const)("wires %s host reads to the planning repository and base", async (agentKind) => {
    const hostStatus = { status: vi.fn(async () => "Host fixture"), serviceLog: vi.fn(async () => "Log fixture") };
    const agent = new FakeAdapter();
    const hub = makeHub(agent, { hostStatus });
    agent.hold();
    fs.mkdirSync(path.join(root, "data"), { recursive: true });
    fs.writeFileSync(path.join(root, "data", "repos.json"), JSON.stringify({ [repo]: { base: "origin/release" } }));
    git("update-ref", "refs/remotes/origin/release", "HEAD");
    const task = await hub.createTask({ ...plan(), agent: agentKind });
    await vi.waitFor(() => expect(agent.runs.at(-1)?.mcp).toBeDefined());
    const client = await connect(agent.runs.at(-1)!.mcp!);
    const definitions = (await client.listTools()).tools;
    for (const name of ["host_status", "read_service_log"]) {
      expect(definitions.find((tool) => tool.name === name)?.annotations?.readOnlyHint).toBe(true);
    }
    expect(toolText(await client.callTool({ name: "host_status", arguments: {} }))).toBe("Host fixture");
    expect(hostStatus.status).toHaveBeenCalledWith(repo, "origin/release");
    expect(toolText(await client.callTool({ name: "read_service_log", arguments: { unit: "deploy", lines: 12, grep: ["failure"] } }))).toBe("Log fixture");
    expect(hostStatus.serviceLog).toHaveBeenCalledWith({ unit: "deploy", lines: 12, grep: ["failure"] });
    for (const args of [{ unit: "other" }, { unit: "prod", lines: 301 }, { unit: "prod", grep: [""] }]) {
      expect((await client.callTool({ name: "read_service_log", arguments: args })).isError).toBe(true);
    }
    agent.release();
    await hub.settled(task.id);
  });

  it("reports unconfigured host reads clearly", async () => {
    const agent = new FakeAdapter();
    const hub = makeHub(agent);
    agent.hold();
    const task = await hub.createTask(plan());
    await vi.waitFor(() => expect(agent.runs.at(-1)?.mcp).toBeDefined());
    const client = await connect(agent.runs.at(-1)!.mcp!);
    for (const [name, args] of [["host_status", {}], ["read_service_log", { unit: "prod" }]] as const) {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError).toBe(true);
      expect(toolText(result)).toContain("Host status is not configured on this Hub");
    }
    agent.release();
    await hub.settled(task.id);
  });

  it.each(["codex", "claude"] as const)("lets %s read issues only from the planning repository with bounded output", async (agentKind) => {
    const forge = fakeForge();
    const agent = new FakeAdapter();
    agent.hold();
    const hub = makeHub(agent, { forge, referenceDirs: [root] });
    const task = await hub.createTask({ ...plan(), agent: agentKind });
    await vi.waitFor(() => expect(agent.runs[0]?.mcp).toBeDefined());
    const client = await connect(agent.runs[0]!.mcp!);
    const definitions = (await client.listTools()).tools;
    for (const name of ["list_issues", "read_issue"]) {
      const tool = definitions.find((tool) => tool.name === name)!;
      expect(tool.annotations?.readOnlyHint).toBe(true);
      expect(tool.inputSchema.properties).not.toHaveProperty("repo");
      expect(tool.inputSchema.properties).not.toHaveProperty("url");
    }
    expect(toolText(await client.callTool({ name: "list_issues", arguments: {} }))).toBe("#7 [open] Add deployment (enhancement)");
    expect(forge.listIssues).toHaveBeenLastCalledWith("example/project", "open", 30);
    for (const state of ["open", "closed", "all"]) {
      await client.callTool({ name: "list_issues", arguments: { state, limit: 100, repo: "other/repo", url: "https://github.com/other/repo" } });
      expect(forge.listIssues).toHaveBeenLastCalledWith("example/project", state, 100);
    }
    for (const limit of [0, 101, 1.5]) expect((await client.callTool({ name: "list_issues", arguments: { limit } })).isError).toBe(true);
    expect(forge.listIssues).toHaveBeenCalledTimes(4);
    expect((await client.callTool({ name: "list_issues", arguments: { state: "merged" } })).isError).toBe(true);
    const read = toolText(await client.callTool({ name: "read_issue", arguments: { number: 7, repo: "other/repo" } }));
    for (const value of [issue.title, issue.state, issue.labels[0]!, issue.url, issue.body, "example (2026-01-01T00:00:00Z)", issue.comments[0]!.text]) expect(read).toContain(value);
    expect(read).not.toContain("Truncated");
    expect(forge.readIssue).toHaveBeenCalledWith("example/project", 7);
    expect(forge.repoOf.mock.calls.every(([path]) => path === repo)).toBe(true);
    forge.readIssue.mockResolvedValueOnce({ ...issue, comments: [{ ...issue.comments[0]!, text: "x".repeat(60_000) }] });
    const long = toolText(await client.callTool({ name: "read_issue", arguments: { number: 7 } }));
    expect(long).toHaveLength(60_000);
    expect(long).toContain("Truncated: issue output exceeded 60,000 characters");
    agent.release();
    await hub.settled(task.id);
  });

  it.each(["no forge", "non-GitHub", "gh failure"])("reports %s and still allows planning without an issue", async (failure) => {
    const forge = fakeForge();
    if (failure === "non-GitHub") forge.repoOf.mockResolvedValue(null);
    if (failure === "gh failure") {
      forge.listIssues.mockRejectedValue(new Error("gh issue list failed: authentication required"));
      forge.readIssue.mockRejectedValue(new Error("gh api failed: authentication required"));
    }
    const agent = new FakeAdapter();
    agent.hold();
    const hub = makeHub(agent, { forge: failure === "no forge" ? undefined : forge });
    const task = await hub.createTask(plan());
    await vi.waitFor(() => expect(agent.runs[0]?.mcp).toBeDefined());
    const client = await connect(agent.runs[0]!.mcp!);
    for (const [name, args] of [["list_issues", {}], ["read_issue", { number: 7 }], ["propose_task", { ...proposal, issue: 7 }]] as const) {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError).toBe(true);
      expect(toolText(result)).toMatch(/no forge|no github.com remote|authentication required/);
    }
    expect(hub.events(task.id).filter((event) => event.type === "task_proposal")).toEqual([]);
    expect((await client.callTool({ name: "propose_task", arguments: proposal })).isError).not.toBe(true);
    agent.release();
    await hub.settled(task.id);
    expect(hub.getTask(task.id).status).toBe("idle");
  });

  it.each(["implement", "review"] as const)("validates linked issues, persists them across restarts, and appends the closing line only for linked %s tasks", async (workflow) => {
    const forge = fakeForge();
    const agent = new FakeAdapter((input) => [
      { type: "thread", threadId: "fixture-thread" },
      ...(input.readOnly ? [] : [{ type: "write" as const, path: "deployment.txt", content: "Deployment implemented\n" }]),
      { type: "text_start" }, { type: "text_delta", text: input.readOnly ? "VERDICT: approve\nFINDINGS: none" : "Implementation complete" }, { type: "done", ok: true },
    ]);
    agent.hold();
    const hub = makeHub(agent, { forge });
    const task = await hub.createTask(plan());
    await vi.waitFor(() => expect(agent.runs[0]?.mcp).toBeDefined());
    const client = await connect(agent.runs[0]!.mcp!);
    const bad = await client.callTool({ name: "propose_task", arguments: { ...proposal, issue: 999 } });
    expect(bad.isError).toBe(true);
    expect(toolText(bad)).toContain("issue #999 not found");
    expect(hub.events(task.id).filter((event) => event.type === "task_proposal")).toHaveLength(0);
    await client.callTool({ name: "propose_task", arguments: { ...proposal, issue: 7 } });
    const event = hub.events(task.id).find((event) => event.type === "task_proposal")!;
    const ref = { number: issue.number, url: issue.url };
    expect(event).toMatchObject({ ...proposal, issue: ref });
    agent.release();
    await hub.settled(task.id);
    await hub.shutdown(100);
    const reloaded = makeHub(agent, { db: openDb(path.join(root, "hub.db")), forge });
    expect(reloaded.events(task.id).find((e) => e.id === event.id)).toMatchObject({ issue: ref });
    const input = { ...plan(), workflow, message: proposal.spec, fromProposal: { taskId: task.id, eventId: event.id } };
    await expect(reloaded.createTask({ ...input, issue: 999 })).rejects.toThrow(/not found/);
    const started = await reloaded.createTask(input);
    await reloaded.settled(started.id);
    expect(started.options.issue).toEqual(ref);
    await reloaded.shutdown(100);
    const restarted = makeHub(agent, { db: openDb(path.join(root, "hub.db")), forge });
    expect(restarted.getTask(started.id).options.issue).toEqual(ref);
    await restarted.openPr(started.id);
    const linkedBody = forge.openPullRequest.mock.calls[0]![3];
    expect(linkedBody).toContain("\n\nRefs #7\n\n<details");
    const ordinary = await restarted.createTask({ ...input, fromProposal: undefined, issue: null });
    await restarted.settled(ordinary.id);
    expect(ordinary.options.issue).toBeUndefined();
    await restarted.openPr(ordinary.id);
    const ordinaryBody = forge.openPullRequest.mock.calls[1]![3];
    expect(ordinaryBody).not.toContain("Closes #");
    expect(linkedBody.split("\n\n<details")[0]!.replace("\n\nRefs #7", "")).toBe(ordinaryBody.split("\n\n<details")[0]);
    expect(forge.close).not.toHaveBeenCalled();
  });

  it("persists separate proposals, starts only on submission, and keeps the link after reopening the database", async () => {
    const agent = new FakeAdapter();
    const hub = makeHub(agent);
    const { task, event } = await propose(hub, agent);
    expect(hub.listTasks()).toHaveLength(1);
    expect(event).toMatchObject({ type: "task_proposal", ...proposal });
    agent.hold();
    hub.sendMessage(task.id, "Revise the plan");
    await vi.waitFor(() => expect(agent.runs).toHaveLength(2));
    const client = await connect(agent.runs[1]!.mcp!);
    await client.callTool({ name: "propose_task", arguments: { ...proposal, title: "Revised deployment" } });
    agent.release();
    await hub.settled(task.id);
    expect(hub.events(task.id).filter((e) => e.type === "task_proposal")).toHaveLength(2);
    const input: NewTaskInput = { ...proposal, workflow: "review", repoPath: repo, message: proposal.spec, fromProposal: { taskId: task.id, eventId: event.id } };
    const started = await hub.createTask(input);
    await hub.settled(started.id);
    expect(started).toMatchObject({ workflow: "review", options: { testCommand: proposal.testCommand }, sessions: [{ agent: "codex", effort: "medium" }, { agent: "claude", model: "sonnet", effort: "medium" }] });
    expect(agent.runs.find((run) => !run.readOnly && run.prompt === proposal.spec)).toBeDefined();
    const reloaded = makeHub(new FakeAdapter(), { db: openDb(path.join(root, "hub.db")) });
    expect(reloaded.events(task.id).find((e) => e.id === event.id)).toMatchObject({ ...proposal, startedTaskId: started.id });
    expect(reloaded.getTask(started.id).workflow).toBe("review");
    await expect(reloaded.createTask(input)).rejects.toThrow(/already been started/);
    await expect(hub.createTask({ ...input, fromProposal: { taskId: task.id, eventId: "missing" } })).rejects.toThrow(/not a planning proposal/);
    expect(hub.listTasks()).toHaveLength(2);
  });

  it("sends a loud proposal notification, no plan-turn finish, and no second ping when started", async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    const agent = new FakeAdapter();
    const hub = makeHub(agent);
    notifyDiscord(hub, { webhook: "https://discord.com/api/webhooks/<webhook-id>/<webhook-token>", mention: "1", fetch: send });
    const { task, event } = await propose(hub, agent);
    expect(send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(send.mock.calls[0]![1]!.body as string)).toEqual({ content: `<@1> 規劃完成，等你確認\n任務：${task.title}\n提案：${proposal.title}`, allowed_mentions: { parse: [], users: ["1"] } });
    hub.sendMessage(task.id, "Another question");
    await hub.settled(task.id);
    expect(send).toHaveBeenCalledTimes(1);
    const started = await hub.createTask({ ...plan(), workflow: "chat", fromProposal: { taskId: task.id, eventId: event.id } });
    await hub.settled(started.id);
    expect(send).toHaveBeenCalledTimes(1);
  });
});


function workerScript(verdict = "approve", extra: FakeStep[] = []): FakeAdapter {
  return new FakeAdapter((input) => {
    const fixture = briefingFixture(input);
    if (fixture) return fixture;
    if (input.toolsDisabled) return [
      { type: "text_start" }, { type: "text_delta", text: JSON.stringify({ type: "feat", summary: "Add deployment", slug: "add-deployment", body: "## Purpose\n\nAdd deployment" }) }, { type: "done", ok: true },
    ];
    return [
      { type: "thread", threadId: "worker-thread" },
      ...(input.readOnly ? [] : [{ type: "write" as const, path: "deployment.txt", content: "Deployment implemented\n" }, ...extra]),
      { type: "text_start" }, { type: "text_delta", text: input.readOnly ? `VERDICT: ${verdict}\nFINDINGS:\n- [high] deployment.txt:1: Requires revision` : "Implementation complete" }, { type: "done", ok: true },
    ];
  });
}

function flowHub(worker = workerScript(), extra: Partial<HubOptions> = {}, planner = new FakeAdapter()) {
  const adapter = { kind: "fake", queryQuota: worker.queryQuota.bind(worker), run: (input: Parameters<FakeAdapter["run"]>[0]) =>
    input.systemPrompt?.includes("You are a planning agent") ? planner.run(input) : worker.run(input) };
  const forge = fakeForge();
  const hub = makeHub(planner, { agents: { codex: adapter, claude: adapter }, forge, ...extra });
  return { hub, planner, worker, forge };
}

async function plannerTurn(hub: Hub, planner: FakeAdapter, taskId: string, message = "Yes, start it") {
  const count = planner.runs.length;
  planner.hold();
  hub.sendMessage(taskId, message);
  await vi.waitFor(() => expect(planner.runs).toHaveLength(count + 1));
  return connect(planner.runs.at(-1)!.mcp!);
}

const reports = (hub: Hub, id: string) => hub.events(id).filter((e): e is Extract<TaskEvent, { type: "task_report" }> => e.type === "task_report");

async function dispatch(flow: ReturnType<typeof flowHub>, arguments_: Record<string, unknown> = {}) {
  const { task, event } = await propose(flow.hub, flow.planner);
  const client = await plannerTurn(flow.hub, flow.planner, task.id);
  const result = await client.callTool({ name: "start_task", arguments: arguments_ });
  expect(result.isError, toolText(result)).not.toBe(true);
  const started: { taskId: string; title: string } = JSON.parse(toolText(result));
  return { task, event, client, started };
}

describe("planning dispatch and reports", () => {
  it.each(["codex", "claude"] as const)("guards dispatch after proposal for %s, selects unstarted proposals and uses repository defaults", async (agent) => {
    const flow = flowHub();
    fs.mkdirSync(path.join(root, "data"), { recursive: true });
    fs.writeFileSync(path.join(root, "data/repos.json"), JSON.stringify({ [repo]: {
      agents: { author: { agent: "claude", model: "opus", effort: "high" }, reviewer: { agent: "codex", model: "gpt-test", effort: "low" } },
      testCommand: "false",
    } }));
    flow.planner.hold();
    const task = await flow.hub.createTask({ ...plan(), agent });
    await vi.waitFor(() => expect(flow.planner.runs[0]?.mcp).toBeDefined());
    const client = await connect(flow.planner.runs[0]!.mcp!);
    await client.callTool({ name: "propose_task", arguments: { ...proposal, issue: 7 } });
    const refused = await client.callTool({ name: "start_task", arguments: {} });
    expect(refused.isError).toBe(true);
    expect(toolText(refused)).toContain("user message is required after");
    expect(flow.hub.listTasks()).toHaveLength(1);
    // Even a queued user reply counts; the guard uses event order rather than timestamps.
    flow.hub.sendMessage(task.id, "Yes, start it");
    const started = JSON.parse(toolText(await client.callTool({ name: "start_task", arguments: {} })));
    const worker = flow.hub.getTask(started.taskId);
    expect(worker).toMatchObject({ title: proposal.title, workflow: "review", options: {
      reportsTo: task.id, testCommand: proposal.testCommand, issue: { number: 7, url: issue.url },
    }, sessions: [{ agent: "claude", model: "opus", effort: "high" }, { agent: "codex", model: "gpt-test", effort: "low" }] });
    expect(worker.workspace?.repoPath).toBe(repo);
    expect(flow.hub.events(worker.id).find((e) => e.type === "user_message")).toMatchObject({ text: proposal.spec });
    expect(flow.hub.events(task.id)).toContainEqual(expect.objectContaining({ type: "task_started", task: worker.id, title: worker.title }));
    expect(toolText(await client.callTool({ name: "start_task", arguments: {} }))).toContain("No unstarted proposal");
    expect((await client.callTool({ name: "start_task", arguments: { proposal: "foreign" } })).isError).toBe(true);
    await client.callTool({ name: "propose_task", arguments: { ...proposal, title: "Revised" } });
    expect((await client.callTool({ name: "start_task", arguments: {} })).isError).toBe(true);
    flow.planner.release();
    await flow.hub.settled(worker.id);
    await flow.hub.settled(task.id);
    expect(reports(flow.hub, task.id)).toHaveLength(1);
  });

  it("validates proposal tickets and refuses dispatch when the required ticket is missing", async () => {
    const flow = flowHub();
    fs.mkdirSync(path.join(root, "data"), { recursive: true });
    fs.writeFileSync(path.join(root, "data/repos.json"), JSON.stringify({ [repo]: { ticket: { required: true, pattern: "^TASK-[0-9]+$" } } }));
    const { task, event } = await propose(flow.hub, flow.planner);
    const client = await plannerTurn(flow.hub, flow.planner, task.id);
    const missing = await client.callTool({ name: "start_task", arguments: { proposal: event.id } });
    expect(toolText(missing)).toContain("Ticket is required");
    expect(flow.hub.listTasks()).toHaveLength(1);
    expect((await client.callTool({ name: "propose_task", arguments: { ...proposal, ticket: "invalid" } })).isError).toBe(true);
    await client.callTool({ name: "propose_task", arguments: { ...proposal, ticket: "TASK-12" } });
    expect((await client.callTool({ name: "start_task", arguments: {} })).isError).toBe(true);
    flow.hub.sendMessage(task.id, "Yes, start the revised proposal");
    const result = JSON.parse(toolText(await client.callTool({ name: "start_task", arguments: {} })));
    expect(flow.hub.getTask(result.taskId).options.ticket).toBe("TASK-12");
    flow.planner.release();
    await flow.hub.settled(result.taskId);
    await flow.hub.settled(task.id);
  });

  it("queues a ready report behind a busy planner, sends one loud notification, and opens the PR only after a later reply", async () => {
    const flow = flowHub();
    const send = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    notifyDiscord(flow.hub, { webhook: "https://discord.com/api/webhooks/<webhook-id>/<webhook-token>", fetch: send });
    const { task, started, client } = await dispatch(flow);
    const count = flow.planner.runs.length;
    await flow.hub.settled(started.taskId);
    expect(flow.planner.runs).toHaveLength(count);
    const report = reports(flow.hub, task.id)[0]!;
    expect(report.report).toMatchObject({ taskId: started.taskId, title: proposal.title, outcome: "ready", rounds: 1,
      lastVerdict: "approve", test: "passed", filesChanged: 1, additions: 1, deletions: 0, branch: flow.hub.getTask(started.taskId).workspace!.branch });
    const notifications = send.mock.calls.map((call) => JSON.parse(call[1]!.body as string));
    expect(notifications).toHaveLength(1); // Report waits for its planner turn to end.
    const early = await client.callTool({ name: "open_pr", arguments: { task: started.taskId } });
    expect(early.isError).toBe(true);
    expect(toolText(early)).toContain("user message is required after");
    flow.planner.release();
    await flow.hub.settled(task.id);
    const completedNotifications = send.mock.calls.map((call) => JSON.parse(call[1]!.body as string));
    expect(completedNotifications).toHaveLength(2);
    expect(completedNotifications[1]).toMatchObject({ content: `任務完成，等你確認\n任務：${proposal.title}\n結果：審查 1 輪・測試通過・1 個檔案 +1 −0・1 項審查意見` });
    expect(completedNotifications[1]).not.toHaveProperty("flags");
    // The planner wrote the spec in this thread; the report points back to it instead of repeating it.
    expect(flow.planner.runs.at(-1)!.prompt).not.toContain(proposal.spec);
    expect(flow.planner.runs.at(-1)!.prompt).toContain(`read_task_log (task ${JSON.stringify(started.taskId)}, afterSeq 0, tail 1)`);
    expect(flow.planner.runs.at(-1)!.prompt).toContain('"outcome":"ready"');
    expect(flow.planner.runs.at(-1)!.prompt).toContain("acceptance criteria and out-of-scope");
    expect(reports(flow.hub, task.id)[0]!.report.handled).toBe(true);
    expect(send).toHaveBeenCalledTimes(2); // handling updates do not re-notify
    const next = await plannerTurn(flow.hub, flow.planner, task.id, "Yes, open the PR");
    const foreign = await flow.hub.createTask({ ...plan(), workflow: "review" });
    await flow.hub.settled(foreign.id);
    expect(toolText(await next.callTool({ name: "open_pr", arguments: { task: foreign.id } }))).toContain("not started by");
    const result = await next.callTool({ name: "open_pr", arguments: { task: started.taskId } });
    expect(result.isError, toolText(result)).not.toBe(true);
    expect(JSON.parse(toolText(result))).toEqual({ number: 8, url: "https://github.com/example/project/pull/8", state: "open" });
    expect(flow.hub.events(task.id)).toContainEqual(expect.objectContaining({ type: "pr_opened", task: started.taskId, number: 8 }));
    expect(flow.forge.push).toHaveBeenCalledTimes(1);
    expect(flow.forge.close).not.toHaveBeenCalled();
    expect(git("branch", "--show-current")).toBe("main");
    expect(fs.existsSync(path.join(repo, "deployment.txt"))).toBe(false);
    flow.planner.release();
    await flow.hub.settled(task.id);
    // Repeated recovery never repeats the report or its notification.
    flow.hub.recoverInterrupted();
    flow.hub.recoverInterrupted();
    expect(reports(flow.hub, task.id)).toHaveLength(1);
  });

  it.each(["changes_requested", "failed", "interrupted", "needs_user"] as const)("reports %s once and refuses to open a PR", async (outcome) => {
    const worker = outcome === "failed" ? new FakeAdapter(() => [{ type: "thread", threadId: "failed" }, { type: "done", ok: false, error: "Worker failed" }]) :
      workerScript(outcome === "changes_requested" ? "changes" : "approve", outcome === "needs_user" ? [{ type: "ask", toolName: "Bash", input: "Check permission" }] : []);
    if (outcome === "interrupted") worker.hold();
    const flow = flowHub(worker);
    const { task, started, client } = await dispatch(flow);
    if (outcome === "interrupted") {
      await vi.waitFor(() => expect(worker.runs).toHaveLength(1));
      flow.hub.stop(started.taskId);
    }
    if (outcome === "needs_user") await vi.waitFor(() => expect(flow.hub.getTask(started.taskId).status).toBe("waiting_user"));
    else await flow.hub.settled(started.taskId);
    expect(reports(flow.hub, task.id)).toHaveLength(1);
    expect(reports(flow.hub, task.id)[0]!.report.outcome).toBe(outcome);
    flow.hub.sendMessage(task.id, "Open the PR");
    expect(toolText(await client.callTool({ name: "open_pr", arguments: { task: started.taskId } }))).toContain("not ready");
    expect(flow.forge.push).not.toHaveBeenCalled();
    if (outcome === "needs_user") {
      const question = flow.hub.events(started.taskId).find((e) => e.type === "waiting_user")!;
      flow.hub.answer(started.taskId, question.id, "Allow");
      await flow.hub.settled(started.taskId);
      expect(reports(flow.hub, task.id).map((e) => e.report.outcome)).toEqual(["needs_user", "ready"]);
    }
    flow.planner.release();
    await flow.hub.settled(task.id);
  });

  it("reports a failed test as changes_requested and never treats approval alone as ready", async () => {
    const flow = flowHub();
    const { task, event } = await propose(flow.hub, flow.planner);
    // Exercise the same card submission path with a failing test command.
    const worker = await flow.hub.createTask({ title: proposal.title, workflow: "review", repoPath: repo,
      message: proposal.spec, testCommand: "exit 1", maxRounds: 1, fromProposal: { taskId: task.id, eventId: event.id } });
    await flow.hub.settled(worker.id);
    await flow.hub.settled(task.id);
    expect(reports(flow.hub, task.id)[0]!.report).toMatchObject({ outcome: "changes_requested", lastVerdict: "approve", test: "failed" });
    const client = await plannerTurn(flow.hub, flow.planner, task.id, "Open PR");
    expect((await client.callTool({ name: "open_pr", arguments: { task: worker.id } })).isError).toBe(true);
    flow.planner.release();
    await flow.hub.settled(task.id);
  });

  it.each(["none", "passed", "failed", "no_commit"] as const)("uses commits and tests for proposal-card implement readiness: %s", async (test) => {
    const flow = flowHub(test === "no_commit" ? new FakeAdapter() : workerScript());
    const { task, event } = await propose(flow.hub, flow.planner);
    const command = test === "passed" ? "git diff --check" : test === "failed" ? "exit 1" : "";
    const worker = await flow.hub.createTask({ title: proposal.title, workflow: "implement", repoPath: repo,
      message: proposal.spec, testCommand: command, fromProposal: { taskId: task.id, eventId: event.id } });
    await flow.hub.settled(worker.id);
    await flow.hub.settled(task.id);
    const ready = test === "none" || test === "passed";
    expect(worker.options.reportsTo).toBe(task.id);
    expect(flow.hub.events(worker.id).filter((e) => e.type === "review_result")).toHaveLength(0);
    expect(flow.hub.events(worker.id).filter((e) => e.type === "diff_snapshot")).toHaveLength(test === "no_commit" ? 0 : 1);
    expect(reports(flow.hub, task.id)[0]!.report).toMatchObject({
      outcome: ready ? "ready" : "changes_requested", lastVerdict: null,
      test: test === "no_commit" ? "none" : test,
    });
    const client = await plannerTurn(flow.hub, flow.planner, task.id, "Open the PR");
    const result = await client.callTool({ name: "open_pr", arguments: { task: worker.id } });
    expect(result.isError === true).toBe(!ready);
    expect(flow.forge.push).toHaveBeenCalledTimes(ready ? 1 : 0);
    flow.planner.release();
    await flow.hub.settled(task.id);
  });

  it.each(["failed", "aborted", "shutdown"] as const)("delivers a report once when its planner turn is %s, across two restarts", async (outcome) => {
    const isReport = (input: Parameters<FakeAdapter["run"]>[0]) => input.prompt.startsWith("Hub task report");
    const planner = new FakeAdapter((input) => {
      if (isReport(input) && outcome !== "failed") planner.hold();
      return [
        { type: "thread", threadId: "planner-thread" },
        { type: "done", ok: !isReport(input) || outcome !== "failed", error: "Planner failed" },
      ];
    });
    const flow = flowHub(workerScript(), {}, planner);
    const { task, started } = await dispatch(flow);
    await flow.hub.settled(started.taskId);
    flow.planner.release();
    await vi.waitFor(() => expect(planner.runs.filter(isReport)).toHaveLength(1));
    expect(reports(flow.hub, task.id)[0]!.report.handled).toBe(true);
    if (outcome === "aborted") flow.hub.stop(task.id);
    if (outcome === "shutdown") await flow.hub.shutdown(100);
    else {
      await flow.hub.settled(task.id);
      expect(flow.hub.getTask(task.id).status).toBe(outcome === "failed" ? "failed" : "idle");
      await flow.hub.shutdown(100);
    }
    const reloaded = flowHub(workerScript(), { db: openDb(path.join(root, "hub.db")) });
    reloaded.hub.recoverInterrupted();
    await reloaded.hub.settled(task.id);
    expect(reports(reloaded.hub, task.id)).toHaveLength(1);
    expect(reloaded.planner.runs).toHaveLength(0);
    await reloaded.hub.shutdown(100);
    const again = flowHub(workerScript(), { db: openDb(path.join(root, "hub.db")) });
    again.hub.recoverInterrupted();
    await again.hub.settled(task.id);
    expect(reports(again.hub, task.id)).toHaveLength(1);
    expect(again.planner.runs).toHaveLength(0);
    expect(planner.runs.filter(isReport)).toHaveLength(1);
  });

  it("reports a missing briefing and its reason when open_pr prepares a plain draft", async () => {
    const flow = flowHub();
    fs.mkdirSync(path.join(root, "data"), { recursive: true });
    fs.writeFileSync(path.join(root, "data/repos.json"), JSON.stringify({ [repo]: { prLanguage: "en" } }));
    fs.writeFileSync(path.join(repo, "README.md"), "The explanation-style guide is required. Use `docs/required.md`.\n");
    git("add", "."); git("commit", "-qm", "required guide reference");
    const { task, started } = await dispatch(flow);
    await flow.hub.settled(started.taskId);
    flow.planner.release(); await flow.hub.settled(task.id);
    const client = await plannerTurn(flow.hub, flow.planner, task.id, "Open the PR");
    const result = await client.callTool({ name: "open_pr", arguments: { task: started.taskId } });
    expect(result.isError, toolText(result)).not.toBe(true);
    expect(toolText(result)).toContain("Briefing not generated: Captured source is unavailable: docs/required.md");
    expect(JSON.parse(toolText(result).split("\n")[0]!)).toMatchObject({ status: "draft" });
    expect(flow.forge.push).not.toHaveBeenCalled();
    flow.planner.release(); await flow.hub.settled(task.id);
  });

  it("prepares and reuses a team draft, then records human-confirmed publication in the plan", async () => {
    const flow = flowHub();
    fs.mkdirSync(path.join(root, "data"), { recursive: true });
    fs.writeFileSync(path.join(root, "data/repos.json"), JSON.stringify({ [repo]: {
      branch: "{type}/{slug}", commit: "{type}: {summary}", prTitle: "{type}: {summary}", prLanguage: "en",
    } }));
    flow.planner.hold();
    const task = await flow.hub.createTask(plan());
    await vi.waitFor(() => expect(flow.planner.runs[0]?.mcp).toBeDefined());
    const initial = await connect(flow.planner.runs[0]!.mcp!);
    await initial.callTool({ name: "propose_task", arguments: { title: proposal.title, spec: proposal.spec, issue: 7 } });
    flow.hub.sendMessage(task.id, "Yes, start it");
    const started = JSON.parse(toolText(await initial.callTool({ name: "start_task", arguments: {} })));
    await flow.hub.settled(started.taskId);
    expect(reports(flow.hub, task.id)[0]!.report).toMatchObject({ outcome: "ready", test: "none" });
    flow.planner.release();
    await flow.hub.settled(task.id);
    const client = await plannerTurn(flow.hub, flow.planner, task.id, "Open the PR");
    const result = await client.callTool({ name: "open_pr", arguments: { task: started.taskId } });
    expect(result.isError, toolText(result)).not.toBe(true);
    const prepared = JSON.parse(toolText(result).split("\n")[0]!);
    expect(prepared).toMatchObject({ status: "draft", task: started.taskId, branch: "feat/add-deployment", title: "feat: Add deployment" });
    expect(toolText(result)).toContain("The user must review and press Confirm and open PR");
    expect(flow.forge.push).not.toHaveBeenCalled();
    expect(flow.forge.openPullRequest).not.toHaveBeenCalled();
    const calls = flow.worker.runs.length;
    const reused = await client.callTool({ name: "open_pr", arguments: { task: started.taskId } });
    expect(JSON.parse(toolText(reused).split("\n")[0]!)).toEqual(prepared);
    expect(flow.worker.runs).toHaveLength(calls);
    const draft = flow.hub.events(started.taskId).find((e): e is Extract<TaskEvent, { type: "pr_draft" }> => e.id === prepared.draftId && e.type === "pr_draft")!;
    await flow.hub.openPr(started.taskId, { draftId: draft.id, branch: draft.branch, commitMessage: draft.commitMessage, title: draft.title, body: draft.body });
    expect(flow.worker.runs).toHaveLength(calls);
    expect(flow.hub.events(task.id).filter((e) => e.type === "pr_opened" && e.task === started.taskId)).toHaveLength(1);
    expect(flow.forge.push).toHaveBeenCalledWith(expect.objectContaining({ remoteBranch: "feat/add-deployment" }));
    expect(flow.forge.openPullRequest).toHaveBeenCalledWith(expect.anything(), "example/project", "feat: Add deployment", expect.stringContaining("Refs #7"));
    expect(flow.worker.runs.at(-1)).toMatchObject({ readOnly: true, toolsDisabled: true });
    expect(git("log", "-1", "--format=%s", flow.hub.getTask(started.taskId).workspace!.branch)).toBe("feat: Add deployment");
    const alreadyOpen = await client.callTool({ name: "open_pr", arguments: { task: started.taskId } });
    expect(alreadyOpen.isError).toBe(true);
    expect(toolText(alreadyOpen)).toContain("already open");
    flow.planner.release();
    await flow.hub.settled(task.id);
  });

  it("selects an explicit proposal and prevents simultaneous starts of the same card", async () => {
    const flow = flowHub();
    const { task, event } = await propose(flow.hub, flow.planner);
    const client = await plannerTurn(flow.hub, flow.planner, task.id);
    await client.callTool({ name: "propose_task", arguments: { ...proposal, title: "Newer plan" } });
    const results = await Promise.all([
      client.callTool({ name: "start_task", arguments: { proposal: event.id } }),
      client.callTool({ name: "start_task", arguments: { proposal: event.id } }),
    ]);
    expect(results.filter((r) => !r.isError)).toHaveLength(1);
    const started = JSON.parse(toolText(results.find((r) => !r.isError)!));
    expect(flow.hub.getTask(started.taskId).title).toBe(proposal.title);
    expect(flow.hub.listTasks()).toHaveLength(2);
    expect(flow.hub.events(task.id).filter((e) => e.type === "task_started")).toHaveLength(1);
    flow.planner.release();
    await flow.hub.settled(started.taskId);
    await flow.hub.settled(task.id);
  });

  it("recovers missed reports and undelivered planner turns from disk without duplication", async () => {
    const flow = flowHub();
    const { task, started } = await dispatch(flow);
    await flow.hub.settled(started.taskId);
    const report = reports(flow.hub, task.id)[0]!;
    await flow.hub.shutdown(100);
    flow.planner.release();
    // Simulate a crash after the end marker, before its report was delivered.
    db.delete(schema.queuedMessages).where(eq(schema.queuedMessages.eventId, report.id)).run();
    db.delete(schema.events).where(eq(schema.events.id, report.id)).run();
    const reloaded = flowHub(workerScript(), { db: openDb(path.join(root, "hub.db")) });
    const send = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    notifyDiscord(reloaded.hub, { webhook: "https://discord.com/api/webhooks/<webhook-id>/<webhook-token>", fetch: send });
    reloaded.hub.recoverInterrupted();
    await reloaded.hub.settled(task.id);
    expect(reports(reloaded.hub, task.id)).toHaveLength(1);
    expect(reloaded.planner.runs).toHaveLength(1);
    expect(reloaded.planner.runs[0]!.prompt).toContain('"outcome":"ready"');
    expect(send).toHaveBeenCalledTimes(2); // interrupted planner + one recovered report
    reloaded.hub.recoverInterrupted();
    expect(reports(reloaded.hub, task.id)).toHaveLength(1);
    expect(reloaded.planner.runs).toHaveLength(1);
    await reloaded.hub.shutdown(100);
    const again = flowHub(workerScript(), { db: openDb(path.join(root, "hub.db")) });
    again.hub.recoverInterrupted();
    expect(reports(again.hub, task.id)).toHaveLength(1);
    expect(again.planner.runs).toHaveLength(0);
  });

  it("reports a worker interrupted by server shutdown without replaying its interrupted planner turn", async () => {
    const flow = flowHub(workerScript());
    flow.worker.hold();
    const { task, started } = await dispatch(flow);
    await vi.waitFor(() => expect(flow.worker.runs).toHaveLength(1));
    await flow.hub.shutdown(100);
    flow.planner.release();
    const reloaded = flowHub(workerScript(), { db: openDb(path.join(root, "hub.db")) });
    reloaded.planner.hold();
    reloaded.hub.recoverInterrupted();
    await vi.waitFor(() => expect(reloaded.planner.runs).toHaveLength(1));
    expect(reports(reloaded.hub, task.id)).toHaveLength(1);
    expect(reports(reloaded.hub, task.id)[0]!.report.outcome).toBe("interrupted");
    await reloaded.hub.shutdown(100);
    reloaded.planner.release();
    const again = flowHub(workerScript(), { db: openDb(path.join(root, "hub.db")) });
    again.hub.recoverInterrupted();
    await again.hub.settled(task.id);
    expect(reloaded.planner.runs[0]!.prompt).toContain('"outcome":"interrupted"');
    expect(again.planner.runs).toHaveLength(0);
    expect(reports(again.hub, task.id)).toHaveLength(1);
    expect(reports(again.hub, task.id)[0]!.report.handled).toBe(true);
  });
});

const decision = {
  question: "Fix findings before opening the PR?",
  context: "## Result\n\nTests passed, but two details need a decision.",
  options: [
    { label: "Fix items 1 and 2 first", detail: "Another review round improves correctness but takes longer." },
    { label: "Open the PR now", detail: "Publish sooner and leave the minor findings for review." },
  ],
  recommended: "Fix items 1 and 2 first",
  items: [{ text: "Missing edge case", severity: "medium", suggestion: "Add coverage" }, { text: "Unclear label" }],
};

const asks = (hub: Hub, id: string) => hub.events(id).filter((e): e is Extract<TaskEvent, { type: "ask" }> => e.type === "ask");

describe("planner decisions and follow-ups", () => {
  it.each(["codex", "claude"] as const)("persists an ask and ends %s without blocking; any user message answers it", async (agentKind) => {
    const agent = new FakeAdapter();
    agent.hold();
    const hub = makeHub(agent);
    const send = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    notifyDiscord(hub, { webhook: "https://discord.com/api/webhooks/<webhook-id>/<webhook-token>", mention: "1", fetch: send });
    const task = await hub.createTask({ ...plan(), agent: agentKind });
    await vi.waitFor(() => expect(agent.runs[0]?.mcp).toBeDefined());
    const client = await connect(agent.runs[0]!.mcp!);
    const invalid = await client.callTool({ name: "ask", arguments: { ...decision, recommended: "Missing" } });
    expect(invalid.isError).toBe(true);
    expect(asks(hub, task.id)).toHaveLength(0);
    const result = await client.callTool({ name: "ask", arguments: decision });
    expect(toolText(result)).toBe("Question shown to the user; end your turn now and wait for the answer.");
    await hub.settled(task.id); // The fake remains held: ask ends the adapter, not just its prompt.
    expect(hub.isBusy(task.id)).toBe(false);
    expect(hub.getTask(task.id).status).toBe("idle");
    expect(asks(hub, task.id)).toEqual([expect.objectContaining(decision)]);
    expect(hub.events(task.id).filter((e) => e.type === "turn_result" && !e.ok)).toHaveLength(0);
    expect(send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(send.mock.calls[0]![1]!.body as string)).toEqual({ content: `<@1> 需要你決定\n任務：${task.title}\n問題：${decision.question}`, allowed_mentions: { parse: [], users: ["1"] } });
    agent.release();
    await hub.shutdown();
    const reloaded = makeHub(agent, { db: openDb(path.join(root, "hub.db")) });
    const resend = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    notifyDiscord(reloaded, { webhook: "https://discord.com/api/webhooks/<webhook-id>/<webhook-token>", fetch: resend });
    reloaded.recoverInterrupted();
    expect(asks(reloaded, task.id)).toEqual(asks(hub, task.id));
    reloaded.sendMessage(task.id, "My own answer");
    await reloaded.settled(task.id);
    expect(asks(reloaded, task.id)[0]?.answer).toBe("My own answer");
    expect(agent.runs.at(-1)?.prompt).toBe("My own answer");
    expect(resend).not.toHaveBeenCalled();
    await reloaded.shutdown();
    const again = makeHub(agent, { db: openDb(path.join(root, "hub.db")) });
    expect(asks(again, task.id)[0]?.answer).toBe("My own answer");
  });

  it("supersedes an open ask on a report and sends only the new ask notification for that turn", async () => {
    const planner = new FakeAdapter((input) => {
      if (input.prompt.startsWith("Hub task report")) planner.hold();
      return [{ type: "thread", threadId: "planner-thread" }, { type: "done", ok: true }];
    });
    const flow = flowHub(workerScript(), {}, planner);
    const send = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    notifyDiscord(flow.hub, { webhook: "https://discord.com/api/webhooks/<webhook-id>/<webhook-token>", fetch: send });
    const { task, event } = await propose(flow.hub, planner);
    const client = await plannerTurn(flow.hub, planner, task.id, "Discuss the proposal");
    await client.callTool({ name: "ask", arguments: { question: "Start?" } });
    await flow.hub.settled(task.id);
    planner.release();
    const worker = await flow.hub.createTask({ ...plan(), title: proposal.title, workflow: "review", message: proposal.spec, testCommand: proposal.testCommand, fromProposal: { taskId: task.id, eventId: event.id } });
    await flow.hub.settled(worker.id);
    await vi.waitFor(() => expect(planner.runs.at(-1)?.prompt).toMatch(/^Hub task report/));
    const reportClient = await connect(planner.runs.at(-1)!.mcp!);
    expect((await reportClient.callTool({ name: "message_task", arguments: { task: worker.id, text: "Fix" } })).isError).toBe(true);
    expect(send).toHaveBeenCalledTimes(2); // Proposal and first ask only.
    await reportClient.callTool({ name: "ask", arguments: decision });
    await flow.hub.settled(task.id);
    expect(asks(flow.hub, task.id)).toMatchObject([{ question: "Start?", superseded: true }, decision]);
    expect(send).toHaveBeenCalledTimes(3);
    expect(JSON.parse(send.mock.calls[2]![1]!.body as string).content).toBe(`需要你決定\n任務：${task.title}\n問題：${decision.question}`);
    const ended = flow.hub.events(task.id).filter((e) => e.type === "plan_turn_end").at(-1);
    expect(ended).toMatchObject({ reports: [reports(flow.hub, task.id)[0]!.id], ask: asks(flow.hub, task.id)[1]!.id });
    planner.release();
    // An option is an ordinary user message; no worker mutation happens until the planner calls a tool.
    const next = await plannerTurn(flow.hub, planner, task.id, decision.options[0]!.label);
    expect(asks(flow.hub, task.id)[1]?.answer).toBe(decision.options[0]!.label);
    expect(flow.worker.runs.filter((run) => !run.readOnly && !run.toolsDisabled)).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(3);
    const sent = await next.callTool({ name: "message_task", arguments: { task: worker.id, text: "Fix the two items" } });
    expect(sent.isError, toolText(sent)).not.toBe(true);
    await flow.hub.settled(worker.id);
    expect(reports(flow.hub, task.id)).toHaveLength(2);
    expect(flow.hub.events(worker.id).filter((e) => e.type === "user_message").at(-1)).toMatchObject({ text: "From the planner:\n\nFix the two items" });
    expect(flow.hub.events(task.id)).toContainEqual(expect.objectContaining({ type: "task_message_sent", task: worker.id }));
    expect(flow.worker.runs.filter((run) => run.readOnly && !run.toolsDisabled)).toHaveLength(2);
    expect(flow.hub.events(worker.id).filter((e) => e.type === "test_result")).toHaveLength(2);
    expect((await next.callTool({ name: "message_task", arguments: { task: worker.id, text: "Again without permission" } })).isError).toBe(true);
    planner.release();
    // The automatically delivered new report is held by the script.
    await vi.waitFor(() => expect(reports(flow.hub, task.id)[1]?.report.handled).toBe(true));
    planner.release();
    await flow.hub.settled(task.id);
    flow.hub.recoverInterrupted();
    expect(reports(flow.hub, task.id)).toHaveLength(2);
  });

  it("refuses foreign workers and queues a follow-up while its own worker is busy", async () => {
    const flow = flowHub();
    const { task, started } = await dispatch(flow);
    await flow.hub.settled(started.taskId);
    flow.planner.release();
    await flow.hub.settled(task.id);
    const foreign = await flow.hub.createTask({ ...plan(), workflow: "implement" });
    await flow.hub.settled(foreign.id);
    const client = await plannerTurn(flow.hub, flow.planner, task.id, "Fix the remaining issue");
    const refused = await client.callTool({ name: "message_task", arguments: { task: foreign.id, text: "Fix" } });
    expect(refused.isError).toBe(true);
    expect(toolText(refused)).toContain("not started by");
    flow.worker.hold();
    flow.hub.sendMessage(started.taskId, "Check one more detail");
    await vi.waitFor(() => expect(flow.hub.isBusy(started.taskId)).toBe(true));
    const runCount = flow.worker.runs.length;
    const sent = await client.callTool({ name: "message_task", arguments: { task: started.taskId, text: "Fix after this round" } });
    expect(sent.isError, toolText(sent)).not.toBe(true);
    expect(flow.hub.events(started.taskId).filter((e) => e.type === "user_message").at(-1)).toMatchObject({ text: "From the planner:\n\nFix after this round", queued: true });
    expect(flow.worker.runs).toHaveLength(runCount);
    flow.worker.release();
    await flow.hub.settled(started.taskId);
    expect(flow.worker.runs.some((run) => run.prompt === "From the planner:\n\nFix after this round")).toBe(true);
    expect(reports(flow.hub, task.id)).toHaveLength(3);
    flow.planner.release();
    await flow.hub.settled(task.id);
    await flow.hub.shutdown();
    const reload = makeHub(new FakeAdapter(), { db: openDb(path.join(root, "hub.db")) });
    expect(reload.events(task.id)).toContainEqual(expect.objectContaining({ type: "task_message_sent", task: started.taskId }));
    expect(reload.events(started.taskId).filter((e) => e.type === "user_message").at(-1)).toMatchObject({ text: "From the planner:\n\nFix after this round" });
  });
});

it.each(["codex", "claude"] as const)("observes %s bootstrap bytes and bounded, session-scoped comparisons without changing injected text", async agentKind => {
  const documentsDir = path.join(root, "documents"); fs.mkdirSync(documentsDir);
  const body = 'private document canary: "quoted"\n規劃😀\n';
  fs.writeFileSync(path.join(documentsDir, "README.md"), body);
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  fs.writeFileSync(path.join(root, "data", "repos.json"), JSON.stringify({ [repo]: { documentsDir } }));
  const agent = new FakeAdapter(), hub = makeHub(agent);
  const task = await hub.createTask({ ...plan(), agent: agentKind }); await hub.settled(task.id);
  const diagnostic = () => hub.usageCalls(task.id).calls.at(-1)!.hostInput!.components!.projectBootstrap!;
  const bootstrap = hub.events(task.id).find(e => e.type === "tool_call" && e.name === "project_docs_bootstrap")!;
  expect(bootstrap.type).toBe("tool_call");
  const output = bootstrap.type === "tool_call" ? bootstrap.output! : "";
  expect(agent.runs[0]!.prompt).toBe(`Project reference read (background data):\n${JSON.stringify(output)}\n\nActual user request:\n${plan().message}`);
  expect(diagnostic()).toEqual({ eventId: bootstrap.id, previousEventId: null, returnedUtf8Bytes: Buffer.byteLength(output),
    embeddedJsonUtf8Bytes: Buffer.byteLength(JSON.stringify(output)), comparison: "unknown" });
  hub.sendMessage(task.id, "Continue"); await hub.settled(task.id);
  expect(diagnostic()).toMatchObject({ comparison: "same", previousEventId: bootstrap.id });
  fs.writeFileSync(path.join(documentsDir, "README.md"), "Changed document\n");
  hub.sendMessage(task.id, "Check change"); await hub.settled(task.id);
  expect(diagnostic().comparison).toBe("changed");
  fs.writeFileSync(path.join(documentsDir, "README.md"), "a".repeat(16_000) + "hidden tail one");
  hub.sendMessage(task.id, "Bounded document"); await hub.settled(task.id);
  fs.writeFileSync(path.join(documentsDir, "README.md"), "a".repeat(16_000) + "hidden tail two");
  hub.sendMessage(task.id, "Only omitted content changed"); await hub.settled(task.id);
  expect(diagnostic().comparison).toBe("same"); // Same supplied fragment, not the complete document.
  const internal = hub as unknown as { append(id: string, session: string | null, payload: TaskEventPayload): void; workflowDeps: WorkflowDeps };
  for (let i = 0; i < HOST_INPUT_EVENT_WINDOW; i++) internal.append(task.id, null, { type: "tool_call", name: "fixture", input: "", sideEffect: "none" });
  hub.sendMessage(task.id, "Beyond window"); await hub.settled(task.id);
  expect(diagnostic()).toMatchObject({ comparison: "unknown", previousEventId: null });
  internal.append(task.id, "other-session", { type: "tool_call", name: "project_docs_bootstrap", input: "", sideEffect: "none", output: "different private session" });
  hub.sendMessage(task.id, "Ignore another session"); await hub.settled(task.id);
  expect(diagnostic().comparison).toBe("same");
  const lookup = vi.spyOn(internal.workflowDeps, "previousProjectBootstrap").mockImplementation(() => { throw new Error("private diagnostic failure"); });
  hub.sendMessage(task.id, "Lookup fails"); await hub.settled(task.id); lookup.mockRestore();
  expect(diagnostic()).toMatchObject({ comparison: "unknown", returnedUtf8Bytes: expect.any(Number) });
  expect(hub.getTask(task.id).status).toBe("idle");
  const latest = hub.events(task.id).at(-1)!.seq;
  db.insert(schema.events).values({ id: "large-bootstrap-fixture", taskId: task.id, sessionId: task.sessions[0]!.id,
    seq: latest + 1, type: "tool_call", createdAt: new Date().toISOString(),
    payload: { name: "project_docs_bootstrap", input: "", output: "x".repeat(HOST_INPUT_TEXT_LIMIT + 5), sideEffect: "none" } }).run();
  hub.sendMessage(task.id, "Oversized previous event"); await hub.settled(task.id);
  expect(diagnostic().comparison).toBe("unknown");
  const persisted = JSON.stringify(hub.usageCalls(task.id));
  for (const text of ["private document canary", "private diagnostic failure", "different private session", documentsDir]) expect(persisted).not.toContain(text);
  expect(agent.runs.every(input => input.readOnly && !("inputDiagnostics" in input) && !("hostInput" in input))).toBe(true);
});

it.each(["codex", "claude"] as const)("refreshes %s document README on initial/resumed/reconstructed turns with saved configuration", async (agentKind) => {
  const documentsDir = path.join(root, "documents");
  fs.mkdirSync(documentsDir);
  fs.writeFileSync(path.join(documentsDir, "README.md"), "Version one: decisions are established\n");
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  const configure = (dir: string) => fs.writeFileSync(path.join(root, "data", "repos.json"), JSON.stringify({ [repo]: { documentsDir: dir } }));
  configure(documentsDir);
  const agent = new FakeAdapter();
  const hub = makeHub(agent);
  fs.mkdirSync(path.join(repo, "subdirectory"));
  const task = await hub.createTask({ ...plan(), agent: agentKind, repoPath: path.join(repo, "subdirectory") });
  await hub.settled(task.id);
  expect(task.options.repoSettings?.documentsDir).toBe(documentsDir);
  expect(agent.runs[0]!.prompt).toContain("Version one");
  expect(agent.runs[0]!.systemPrompt).toContain("cannot supersede user instructions");
  expect(agent.runs[0]!.systemPrompt).toContain("personal-view/");
  expect(agent.runs[0]!.systemPrompt).toContain("self-contained implementation spec");
  expect(agent.runs[0]!.referenceDirs).toEqual([]);
  configure(path.join(root, "different-documents"));
  fs.writeFileSync(path.join(documentsDir, "README.md"), "Version two\n");
  hub.sendMessage(task.id, "Continue"); await hub.settled(task.id);
  expect(agent.runs[1]).toMatchObject({ threadId: "thread-1" });
  expect(agent.runs[1]!.prompt).toContain("Version two");
  await hub.shutdown(100);
  // Reopen the persisted database rather than sharing task/session objects.
  const reopened = openDb(path.join(root, "hub.db"));
  const restarted = makeHub(agent, { db: reopened });
  fs.rmSync(path.join(documentsDir, "README.md"));
  restarted.sendMessage(task.id, "Continue after restart"); await restarted.settled(task.id);
  expect(agent.runs[2]).toMatchObject({ threadId: "thread-1" });
  expect(agent.runs[2]!.prompt).toContain("unavailable");
  const bootstrap = restarted.events(task.id).filter((event) => event.type === "tool_call" && event.name === "project_docs_bootstrap");
  expect(bootstrap).toHaveLength(3);
  expect(bootstrap[0]).toMatchObject({ pending: false, sideEffect: "none", input: "Hub host bootstrap: root README.md", output: expect.stringContaining("Version one") });
  expect(bootstrap[1]).toMatchObject({ output: expect.stringContaining("Version two") });
  expect(bootstrap[2]).toMatchObject({ output: expect.stringContaining("unavailable") });
  expect(restarted.getTask(task.id).options.repoSettings?.documentsDir).toBe(documentsDir);
  fs.writeFileSync(path.join(documentsDir, "README.md"), Buffer.from([255, 0]));
  restarted.sendMessage(task.id, "Check non-text README"); await restarted.settled(task.id);
  expect(agent.runs[3]!.prompt).toContain("Non-text");
  fs.writeFileSync(path.join(documentsDir, "README.md"), "Readable README");
  vi.spyOn(asyncFs, "open").mockRejectedValueOnce(Object.assign(new Error("Do not expose host detail"), { code: "EACCES" }));
  restarted.sendMessage(task.id, "Check unreadable README"); await restarted.settled(task.id);
  expect(agent.runs[4]!.prompt).toContain("EACCES");
  expect(agent.runs[4]!.prompt).not.toContain("Do not expose host detail");
  fs.writeFileSync(path.join(documentsDir, "README.md"), Array.from({ length: 400 }, (_, i) => `Rule ${i}: ${"x".repeat(80)}`).join("\n"));
  restarted.sendMessage(task.id, "Check long README"); await restarted.settled(task.id);
  expect(agent.runs[5]!.prompt).toContain("Truncated at 16,000");
  expect(restarted.events(task.id).filter((event) => event.type === "tool_call" && event.name === "project_docs_bootstrap")).toHaveLength(6);
  await restarted.shutdown(100);
});

it.each(["codex", "claude"] as const)("serves %s task-bound read-only document MCP calls and rejects ended/revoked grants", async (agentKind) => {
  const documentsDir = path.join(root, "documents");
  fs.mkdirSync(path.join(documentsDir, "decisions"), { recursive: true });
  fs.writeFileSync(path.join(documentsDir, "README.md"), Array.from({ length: 400 }, (_, i) => `Rule ${i}: ${"x".repeat(80)}`).join("\n"));
  fs.writeFileSync(path.join(documentsDir, "decisions", "adr.md"), "Literal [a.*]\nAgreed constraint\n");
  const other = path.join(root, "other"); fs.mkdirSync(other);
  fs.writeFileSync(path.join(other, "private.md"), "OTHER_PROJECT_SECRET");
  fs.symlinkSync(other, path.join(documentsDir, "alias"));
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  fs.writeFileSync(path.join(root, "data", "repos.json"), JSON.stringify({ [repo]: { documentsDir } }));
  const issueGrant = vi.spyOn(tools, "issue");
  const agent = new FakeAdapter(); agent.hold();
  const hub = makeHub(agent);
  const task = await hub.createTask({ ...plan(), agent: agentKind });
  await vi.waitFor(() => expect(agent.runs[0]?.mcp).toBeDefined());
  expect(agent.runs[0]!.prompt).toContain("Truncated at 16,000");
  const access = agent.runs[0]!.mcp!;
  const client = await connect(access);
  const definitions = (await client.listTools()).tools;
  for (const name of ["list_project_docs", "search_project_docs", "read_project_doc"]) {
    expect(definitions.find((tool) => tool.name === name)?.annotations?.readOnlyHint).toBe(true);
  }
  const call = async (name: string, args: Record<string, unknown>) => toolText(await client.callTool({ name, arguments: args }));
  expect(await call("list_project_docs", {})).toContain("directory: decisions");
  expect(await call("list_project_docs", { directory: "decisions" })).toContain("decisions/adr.md");
  expect(await call("search_project_docs", { query: "[a.*]" })).toContain("decisions/adr.md:1: Literal [a.*]");
  expect(await call("read_project_doc", { path: "decisions/adr.md", maxLines: 1 })).toContain("next line 2");
  expect(await call("read_project_doc", { path: "decisions/adr.md", startLine: 2 })).toContain("2: Agreed constraint");
  expect(await call("read_project_doc", { path: "README.md", startLine: 201 })).toContain("201: Rule 200");
  fs.writeFileSync(path.join(documentsDir, "long-line.txt"), "x".repeat(40_000));
  const partialLine = await call("read_project_doc", { path: "long-line.txt" });
  const column = Number(/next column (\d+)/.exec(partialLine)![1]);
  const continuation = await call("read_project_doc", { path: "long-line.txt", startLine: 1, startColumn: column });
  expect(partialLine.length).toBeLessThanOrEqual(32_000);
  expect(continuation).toContain("End of document");
  for (const file of [path.join(other, "private.md"), "../other/private.md", "alias/private.md", ".git/config", "jira-ticket/secret.md"]) {
    const forbidden = await client.callTool({ name: "read_project_doc", arguments: { path: file } });
    expect(forbidden.isError).toBe(true);
    expect(toolText(forbidden)).not.toContain("OTHER_PROJECT_SECRET");
  }
  expect(hub.events(task.id)).toContainEqual(expect.objectContaining({ type: "tool_call", name: "read_project_doc", sideEffect: "none", pending: false, output: expect.stringContaining("2: Agreed constraint") }));
  const otherRepo = path.join(root, "second-project"); fs.mkdirSync(otherRepo);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: otherRepo });
  fs.writeFileSync(path.join(otherRepo, "README.md"), "Second project checkout");
  execFileSync("git", ["add", "."], { cwd: otherRepo });
  execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"], { cwd: otherRepo });
  fs.writeFileSync(path.join(root, "data", "repos.json"), JSON.stringify({ [repo]: { documentsDir }, [otherRepo]: { documentsDir: other } }));
  const second = await hub.createTask({ ...plan(), agent: agentKind, repoPath: otherRepo });
  await vi.waitFor(() => expect(agent.runs[1]?.mcp).toBeDefined());
  const secondClient = await connect(agent.runs[1]!.mcp!);
  expect(toolText(await secondClient.callTool({ name: "read_project_doc", arguments: { path: "private.md" } }))).toContain("OTHER_PROJECT_SECRET");
  expect(await call("read_project_doc", { path: "private.md" })).not.toContain("OTHER_PROJECT_SECRET");
  // Keep an ended grant present long enough to test the handler independently of revocation timing.
  const savedCallbacks = issueGrant.mock.calls[0]![3]!;
  const endedAccess = tools.issue(task.id, task.sessions[0]!.id, repo, { ...savedCallbacks, ask: async () => {} })!;
  const endedClient = await connect(endedAccess);
  await endedClient.callTool({ name: "ask", arguments: { question: "Continue?" } });
  const ended = await endedClient.callTool({ name: "list_project_docs", arguments: {} });
  expect(ended.isError).toBe(true); expect(toolText(ended)).toContain("ended");
  tools.revoke(endedAccess.token);
  await client.callTool({ name: "ask", arguments: { question: "Continue?" } });
  agent.release(); await hub.settled(task.id); await hub.settled(second.id);
  await expect(connect(access)).rejects.toThrow();
  expect(fs.readFileSync(path.join(documentsDir, "decisions", "adr.md"), "utf8")).toBe("Literal [a.*]\nAgreed constraint\n");
});

it("keeps plans without configured documents usable and returns actionable MCP status", async () => {
  const agent = new FakeAdapter(); agent.hold();
  const hub = makeHub(agent); const task = await hub.createTask(plan());
  await vi.waitFor(() => expect(agent.runs[0]?.mcp).toBeDefined());
  const client = await connect(agent.runs[0]!.mcp!);
  expect(toolText(await client.callTool({ name: "list_project_docs", arguments: {} }))).toContain("Configure documentsDir");
  expect(hub.events(task.id).some((event) => event.type === "tool_call" && event.name === "project_docs_bootstrap")).toBe(false);
  agent.release(); await hub.settled(task.id); expect(hub.getTask(task.id).status).toBe("idle");
});

it("keeps Host diagnostics when ask cancels a held planner without adding another invocation", async () => {
  const agent = new FakeAdapter(); agent.hold();
  const hub = makeHub(agent), task = await hub.createTask(plan());
  await vi.waitFor(() => expect(agent.runs[0]?.mcp).toBeDefined());
  const client = await connect(agent.runs[0]!.mcp!);
  await client.callTool({ name: "ask", arguments: { question: "Confirm the plan?" } });
  await hub.settled(task.id); agent.release();
  expect(agent.runs).toHaveLength(1);
  expect(hub.usageCalls(task.id).calls).toHaveLength(1);
  expect(hub.usageCalls(task.id).calls[0]).toMatchObject({ status: "cancelled", endReason: "planner_ask",
    hostInput: { promptUtf8Bytes: Buffer.byteLength(agent.runs[0]!.prompt) }, usage: { observation: null } });
});

it.each(["codex", "claude"] as const)("handoff from %s keeps proposals, pending asks, live README and fresh grants without authorizing dispatch", async (source) => {
  const summary = { goals: "目標 #1", decisions: "決策 #1", constraints: "限制 #1", completed: "完成 #1", pending: "待辦 #1", uncertainty: "待驗證 #1", references: [1] };
  const outgoing = new FakeAdapter((input) => input.toolsDisabled ? [
    { type: "text_delta", text: JSON.stringify(summary) }, { type: "done", ok: true },
  ] : [{ type: "thread", threadId: "old-thread" }, { type: "done", ok: true }]);
  const incoming = new FakeAdapter();
  const target = source === "codex" ? "claude" : "codex";
  const documentsDir = path.join(root, "documents"); fs.mkdirSync(documentsDir);
  fs.writeFileSync(path.join(documentsDir, "README.md"), "Previous reference");
  fs.mkdirSync(path.join(root, "data"), { recursive: true });
  fs.writeFileSync(path.join(root, "data", "repos.json"), JSON.stringify({ [repo]: { documentsDir } }));
  const hub = makeHub(outgoing, { agents: { [source]: outgoing, [target]: incoming } });
  outgoing.hold();
  const task = await hub.createTask({ ...plan(), agent: source });
  await vi.waitFor(() => expect(outgoing.runs[0]?.mcp).toBeDefined());
  const oldGrant = outgoing.runs[0]!.mcp!;
  const firstClient = await connect(oldGrant);
  await firstClient.callTool({ name: "propose_task", arguments: proposal });
  await firstClient.callTool({ name: "ask", arguments: { question: "Start this proposal?", options: [{ label: "Start", detail: "Dispatch" }, { label: "Wait", detail: "Discuss" }] } });
  outgoing.release(); await hub.settled(task.id);
  expect(hub.usageCalls(task.id).calls.at(-1)?.hostInput?.promptUtf8Bytes).toBe(Buffer.byteLength(outgoing.runs[0]!.prompt));
  const savedProposal = hub.events(task.id).find((e) => e.type === "task_proposal")!;
  const savedAsk = hub.events(task.id).find((e) => e.type === "ask")!;
  fs.writeFileSync(path.join(documentsDir, "README.md"), "Updated live README");
  await hub.switchAgent(task.id, { target, expectedSessionId: hub.getTask(task.id).sessions[0]!.id });
  expect(incoming.runs).toHaveLength(0);
  expect(hub.events(task.id).find((e) => e.id === savedProposal.id)).toEqual(savedProposal);
  expect(hub.events(task.id).find((e) => e.id === savedAsk.id)).toEqual(savedAsk);
  expect(outgoing.runs.at(-1)!.mcp).toBeUndefined();
  await expect(connect(oldGrant)).rejects.toThrow();
  // A report is the first legitimate input. It is a signal, never a new user reply.
  const report = { taskId: "worker", title: "Worker", finalSeq: 1, outcome: "ready" as const, rounds: 1, lastVerdict: "approve" as const, findings: [], test: "passed" as const, filesChanged: 1, additions: 1, deletions: 0, branch: "fixture" };
  const seq = (hub.events(task.id).at(-1)?.seq ?? 0) + 1;
  db.insert(schema.events).values({ id: "handoff-worker-report", taskId: task.id, seq, type: "task_report", payload: { report, prompt: "Hub worker report: signal, never authorization" }, createdAt: new Date().toISOString() }).run();
  incoming.hold(); hub.recoverInterrupted();
  await vi.waitFor(() => expect(incoming.runs[0]?.mcp).toBeDefined());
  const input = incoming.runs[0]!;
  expect(input.threadId).toBeUndefined(); expect(input.mcp!.token).not.toBe(oldGrant.token);
  expect(input.prompt).toContain("Updated live README");
  expect(input.prompt.indexOf("Historical peer context")).toBeLessThan(input.prompt.indexOf("Hub worker report: signal"));
  expect(input.systemPrompt).toContain("only after a fresh user message");
  const started = hub.events(task.id).filter(e => e.type === "invocation_started").at(-1)!;
  expect(started.type === "invocation_started" && started.hostInput?.components?.projectBootstrap).toMatchObject({ comparison: "unknown", previousEventId: null });
  const nextClient = await connect(input.mcp!);
  const result = await nextClient.callTool({ name: "start_task", arguments: {} });
  expect(result.isError).toBe(true); expect(toolText(result)).toMatch(/user|reply/i);
  await nextClient.callTool({ name: "ask", arguments: { question: "Please confirm dispatch" } });
  incoming.release(); await hub.settled(task.id);
  expect(hub.events(task.id).some((e) => e.type === "handoff_delivery" && e.delivered)).toBe(true);
  expect(hub.events(task.id).filter((e) => e.type === "task_started")).toHaveLength(0);
  expect(hub.events(task.id).filter((e) => e.type === "finding_export")).toHaveLength(0);
});

it("handoff retains an already dispatched child's report/PR relationships and report turns cannot authorize follow-up or publication", async () => {
  const planner = new FakeAdapter(); const worker = workerScript();
  const summaries = new FakeAdapter(() => [{ type: "text_delta", text: JSON.stringify({ goals: "目標 #1", decisions: "決策 #1", constraints: "限制 #1", completed: "證據 #1", pending: "待辦 #1", uncertainty: "待驗證 #1", references: [1] }) }, { type: "done", ok: true }]);
  const adapter = { kind: "fake", queryQuota: worker.queryQuota.bind(worker), run: (input: Parameters<FakeAdapter["run"]>[0]) =>
    input.systemPrompt?.startsWith("Produce a historical peer handoff") ? summaries.run(input) : input.systemPrompt?.includes("You are a planning agent") ? planner.run(input) : worker.run(input) };
  const flow = flowHub(worker, { agents: { codex: adapter, claude: adapter } }, planner);
  const { task, event, started } = await dispatch(flow);
  planner.release(); await flow.hub.settled(started.taskId); await flow.hub.settled(task.id);
  const child = flow.hub.getTask(started.taskId); const oldReport = reports(flow.hub, task.id).at(-1)!;
  expect(oldReport.report.outcome).toBe("ready");
  const count = planner.runs.length;
  await flow.hub.switchAgent(task.id, { target: "claude", expectedSessionId: flow.hub.getTask(task.id).sessions[0]!.id });
  expect(planner.runs).toHaveLength(count); expect(summaries.runs).toHaveLength(1);
  expect(flow.hub.getTask(started.taskId).options.reportsTo).toBe(task.id);
  expect(flow.hub.getTask(started.taskId).workspace).toEqual(child.workspace);
  expect(flow.hub.events(task.id).find((e) => e.id === event.id)).toMatchObject({ startedTaskId: started.taskId });
  const seq = flow.hub.events(task.id).at(-1)!.seq + 1;
  db.insert(schema.events).values({ id: "handoff-ready-report", taskId: task.id, seq, type: "task_report", payload: { report: { ...oldReport.report, handled: false, finalSeq: oldReport.report.finalSeq + 1 }, prompt: oldReport.prompt }, createdAt: new Date().toISOString() }).run();
  planner.hold(); flow.hub.recoverInterrupted();
  await vi.waitFor(() => expect(planner.runs).toHaveLength(count + 1));
  const input = planner.runs.at(-1)!; expect(input.prompt).toContain("Historical peer context");
  const client = await connect(input.mcp!);
  for (const [name, arguments_] of [["message_task", { task: started.taskId, text: "Unauthorized follow-up" }], ["open_pr", { task: started.taskId }]] as const) {
    const result = await client.callTool({ name, arguments: arguments_ });
    expect(result.isError).toBe(true); expect(toolText(result)).toContain("user message is required after");
  }
  const duplicate = await client.callTool({ name: "start_task", arguments: { proposal: event.id } });
  expect(duplicate.isError).toBe(true);
  expect(flow.forge.openPullRequest).not.toHaveBeenCalled();
  planner.release(); await flow.hub.settled(task.id);
});


const publicSummary = { problem: "需求需留下紀錄", behavior: ["使用者確認後發布"], acceptanceCriteria: ["顯示來源版本"], outOfScope: ["不修改 issue 內文"] };
describe("issue requirements comment proposals", () => {
  it.each(["codex", "claude"] as const)("%s prepares durable draft through the existing turn and only authenticated UI commands publish", async (agentKind) => {
    const agent = new FakeAdapter(); agent.hold();
    const forge = fakeForge(); const hub = makeHub(agent, { forge });
    const task = await hub.createTask({ ...plan(), agent: agentKind });
    await vi.waitFor(() => expect(agent.runs[0]?.mcp).toBeDefined());
    const mcp = await connect(agent.runs[0]!.mcp!);
    const definitions = (await mcp.listTools()).tools;
    expect(definitions.some((t) => /confirm.*comment|publish.*comment/.test(t.name))).toBe(false);
    expect(agent.runs[0]!.systemPrompt).toContain("issueSummary");
    expect((await mcp.callTool({ name: "propose_task", arguments: { ...proposal, issue: 7, issueSummary: publicSummary } })).isError).not.toBe(true);
    const source = hub.events(task.id).find((e) => e.type === "task_proposal")!;
    const draft = hub.events(task.id).find((e) => e.type === "issue_comment_draft")!;
    expect(draft).toMatchObject({ proposalId: source.id, repo: "example/project", revision: 1 });
    expect(forge.readIssue).toHaveBeenCalledWith("example/project", 7);
    expect(forge.createIssueComment).not.toHaveBeenCalled(); expect(agent.runs).toHaveLength(1);
    agent.release(); await hub.settled(task.id);
    if (draft.type !== "issue_comment_draft") throw new Error("Missing draft");
    const app = createApp(hub, "test-token");
    const version = { draftId: draft.draftId, revision: 1 };
    const request = (action: string, value: unknown, authenticated = true, id = task.id) => app.request(`/api/tasks/${id}/issue-comment/${action}`, { method: "POST", headers: { "content-type": "application/json", ...(authenticated ? { Authorization: "Bearer test-token" } : {}) }, body: JSON.stringify(value) });
    expect((await request("confirm", version, false)).status).toBe(401);
    for (const bad of [null, [], { ...version, body: "unsaved" }, { ...version, revision: "1" }, { ...version, repo: "other/project" }]) expect((await request("confirm", bad)).status).toBe(400);
    expect((await request("confirm", version, true, "missing")).status).toBe(404);
    const other = await hub.createTask(plan()); await hub.settled(other.id);
    expect((await request("confirm", version, true, other.id)).status).toBe(404);
    const chat = await hub.createTask({ title: "Chat", workflow: "chat", message: "Hello" }); await hub.settled(chat.id);
    expect((await request("confirm", version, true, chat.id)).status).toBe(400);
    const originalMessages = hub.events(task.id).filter((e) => e.type === "user_message").length;
    expect((await request("edit", { ...version, content: "Edited public summary" })).status).toBe(200);
    expect((await request("confirm", version)).status).toBe(409);
    expect(forge.createIssueComment).not.toHaveBeenCalled();
    expect((await request("confirm", { ...version, revision: 2 })).status).toBe(200);
    const posted = forge.createIssueComment.mock.calls[0]!;
    expect(posted[2]).toContain("Edited public summary"); expect(posted[2]).toContain(draft.sourceReference);
    expect(posted[2]).not.toContain(proposal.spec);
    expect(hub.events(task.id).filter((e) => e.type === "user_message")).toHaveLength(originalMessages);
    expect(agent.runs.filter((r) => r.cwd === repo)).toHaveLength(2); // The other planning task only.
    const reloaded = makeHub(new FakeAdapter(), { forge }); reloaded.recoverInterrupted();
    expect(reloaded.events(task.id)).toEqual(hub.events(task.id));
    expect((await request("confirm", { ...version, revision: 2 })).status).toBe(200);
    expect(forge.createIssueComment).toHaveBeenCalledTimes(1);
    expect(hub.events(task.id).find((e) => e.id === source.id)).toHaveProperty("spec", proposal.spec);
  });

  it("rejects summaries without issues, invalid fields, aggregate overflow and PR numbers; legacy proposals have no fabricated draft", async () => {
    const agent = new FakeAdapter(); agent.hold(); const forge = fakeForge(); const hub = makeHub(agent, { forge });
    const task = await hub.createTask(plan()); await vi.waitFor(() => expect(agent.runs[0]?.mcp).toBeDefined());
    const mcp = await connect(agent.runs[0]!.mcp!);
    for (const args of [
      { ...proposal, issueSummary: publicSummary },
      { ...proposal, issue: 7, issueSummary: { ...publicSummary, behavior: [] } },
      { ...proposal, issue: 7, issueSummary: { ...publicSummary, behavior: Array(20).fill("x".repeat(1000)) } },
    ]) expect((await mcp.callTool({ name: "propose_task", arguments: args })).isError).toBe(true);
    forge.readIssue.mockRejectedValueOnce(new Error("#8 is a pull request, not an issue"));
    expect((await mcp.callTool({ name: "propose_task", arguments: { ...proposal, issue: 8, issueSummary: publicSummary } })).isError).toBe(true);
    expect(hub.events(task.id).some((e) => e.type === "task_proposal")).toBe(false);
    expect((await mcp.callTool({ name: "propose_task", arguments: proposal })).isError).not.toBe(true);
    expect(hub.events(task.id).some((e) => e.type === "issue_comment_draft")).toBe(false);
    agent.release(); await hub.settled(task.id);
  });

  it("rolls back proposal and draft together and emits neither on local transaction failure", async () => {
    const agent = new FakeAdapter(); agent.hold(); const hub = makeHub(agent, { forge: fakeForge() });
    const task = await hub.createTask(plan()); await vi.waitFor(() => expect(agent.runs[0]?.mcp).toBeDefined());
    const mcp = await connect(agent.runs[0]!.mcp!);
    const seen: TaskEvent[] = []; const off = hub.subscribe((m) => { if (m.type === "event") seen.push(m.event); });
    db.run(sql`CREATE TRIGGER reject_comment BEFORE INSERT ON events WHEN NEW.type = 'issue_comment_draft' BEGIN SELECT RAISE(ABORT, 'draft fixture failure'); END`);
    expect((await mcp.callTool({ name: "propose_task", arguments: { ...proposal, issue: 7, issueSummary: publicSummary } })).isError).toBe(true);
    expect(hub.events(task.id).some((e) => e.type === "task_proposal" || e.type === "issue_comment_draft")).toBe(false);
    expect(seen.some((e) => e.type === "task_proposal" || e.type === "issue_comment_draft")).toBe(false);
    off(); agent.release(); await hub.settled(task.id);
  });
});

it("comment failure grants no agreement and cannot block a later independently authorized dispatch", async () => {
  const agent = new FakeAdapter(); agent.hold(); const forge = fakeForge(); const hub = makeHub(agent, { forge });
  const task = await hub.createTask(plan()); await vi.waitFor(() => expect(agent.runs[0]?.mcp).toBeDefined());
  const mcp = await connect(agent.runs[0]!.mcp!);
  await mcp.callTool({ name: "propose_task", arguments: { ...proposal, issue: 7, issueSummary: publicSummary } });
  const source = hub.events(task.id).find((e) => e.type === "task_proposal")!;
  const draft = hub.events(task.id).find((e) => e.type === "issue_comment_draft")!;
  if (draft.type !== "issue_comment_draft") throw new Error("Missing draft");
  forge.createIssueComment.mockRejectedValueOnce(new CommentWriteError(true));
  const published = await hub.issueComments.confirm(task.id, { draftId: draft.draftId, revision: 1 });
  expect(published).toMatchObject({ state: "failed" });
  expect((await mcp.callTool({ name: "start_task", arguments: { proposal: source.id } })).isError).toBe(true);
  expect(hub.events(task.id).some((e) => e.type === "task_started")).toBe(false);
  agent.release(); await hub.settled(task.id);
  agent.hold(); hub.sendMessage(task.id, "Please start implementing this proposal");
  await vi.waitFor(() => expect(agent.runs.at(-1)?.mcp?.token).not.toBe(agent.runs[0]!.mcp!.token));
  const next = await connect(agent.runs.at(-1)!.mcp!);
  const started = await next.callTool({ name: "start_task", arguments: { proposal: source.id } });
  expect(started.isError).not.toBe(true);
  expect((await next.callTool({ name: "start_task", arguments: { proposal: source.id } })).isError).toBe(true);
  expect(forge.createIssueComment).toHaveBeenCalledTimes(1);
  agent.release(); await hub.settled(task.id);
});

describe("planner worker log tools", () => {
  const logTools = ["read_task_log", "read_task_test_output", "search_task_log"] as const;

  function addEvent(hub: Hub, taskId: string, event: import("@agent-hub/shared").TaskEventPayload) {
    const seq = (hub.events(taskId).at(-1)?.seq ?? 0) + 1;
    const { type, ...payload } = event;
    db.insert(schema.events).values({ id: `${taskId}-log-${seq}`, taskId, seq, type, payload, createdAt: new Date().toISOString() }).run();
    return seq;
  }

  it("reads a dispatched fake worker's transcript and tests, pages, searches and rejects ended turns", async () => {
    const issueGrant = vi.spyOn(tools, "issue");
    const flow = flowHub();
    const { hub } = flow;
    const { task, started, client } = await dispatch(flow);
    await hub.settled(started.taskId);
    const definitions = (await client.listTools()).tools;
    for (const name of logTools) expect(definitions.find((tool) => tool.name === name)?.annotations?.readOnlyHint).toBe(true);
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const result = await client.callTool({ name, arguments: { task: started.taskId.slice(0, 8), ...args } });
      expect(result.isError, toolText(result)).not.toBe(true);
      return toolText(result);
    };
    const initial = await call("read_task_log");
    expect(initial).toContain(proposal.spec);
    expect(initial).toContain("Implementation complete");
    expect(initial).toContain("Review round 1: approve");
    expect(await call("read_task_test_output")).toContain("Exit code: 0");
    const first = addEvent(hub, started.taskId, { type: "user_message", text: "Evidence request" });
    addEvent(hub, started.taskId, { type: "tool_call", name: "fixture_tool", input: "fixture input", output: "tool evidence", sideEffect: "none" });
    addEvent(hub, started.taskId, { type: "test_result", round: 2, command: "fixture-test", exitCode: 1, output: 'test evidence {"status":"failed"}' });
    const final = addEvent(hub, started.taskId, { type: "agent_text", text: "Evidence conclusion" });
    expect(await call("read_task_log", { tail: 2 })).toContain(`shown: ${final - 1}-${final}`);
    const page = await call("read_task_log", { afterSeq: first, tail: 2 });
    expect(page).toContain(`shown: ${first + 1}-${first + 2}`);
    expect(page).toContain("fixture input");
    expect(page).not.toContain("tool evidence");
    expect(page).not.toContain("test evidence");
    const withOutputs = await call("read_task_log", { afterSeq: first, includeOutputs: true });
    expect(withOutputs).toContain("tool evidence");
    expect(withOutputs).toContain('test evidence {"status":"failed"}');
    expect(await call("read_task_test_output")).toContain("Test round 2\nCommand: fixture-test\nExit code: 1");
    expect(await call("read_task_test_output", { round: 1 })).toContain("Exit code: 0");
    expect(await call("read_task_test_output", { round: 99 })).toContain("No test result recorded for round 99");
    expect(await call("search_task_log", { pattern: "TOOL EVIDENCE" })).toBe(`[seq ${first + 1}] tool evidence`);
    expect(await call("search_task_log", { pattern: "/test evidence.*status/" })).toContain(`[seq ${first + 2}] test evidence`);
    expect(await call("search_task_log", { pattern: "unmatched evidence" })).toBe("No matching lines.");
    const invalid = await client.callTool({ name: "search_task_log", arguments: { task: started.taskId, pattern: "/[/" } });
    expect(invalid.isError).toBe(true);
    expect(toolText(invalid)).toBe("Invalid regular expression");
    for (const [name, args] of [
      ["read_task_log", { tail: 0 }], ["read_task_log", { tail: 301 }], ["read_task_log", { afterSeq: -1 }],
      ["read_task_test_output", { round: 0 }], ["search_task_log", { pattern: "" }], ["search_task_log", { pattern: "x".repeat(201) }],
    ] as const) expect((await client.callTool({ name, arguments: { task: started.taskId, ...args } })).isError).toBe(true);
    const callbacks = issueGrant.mock.calls.find((call) => call[0] === task.id && call[3])![3]!;
    const endedAccess = tools.issue(task.id, task.sessions[0]!.id, repo, { ...callbacks, ask: async () => {} })!;
    const endedClient = await connect(endedAccess);
    await endedClient.callTool({ name: "ask", arguments: { question: "Continue?" } });
    for (const name of logTools) {
      const result = await endedClient.callTool({ name, arguments: { task: started.taskId, pattern: "evidence" } });
      expect(result.isError).toBe(true);
      expect(toolText(result)).toBe("This turn has ended");
    }
    tools.revoke(endedAccess.token);
    flow.planner.release();
    await hub.settled(task.id);
    await expect(connect(endedAccess)).rejects.toThrow();
  });

  it("returns the same denial for top-level, another planner's worker, absent and ambiguous tasks", async () => {
    const flow = flowHub();
    const { hub } = flow;
    const { task, started, client } = await dispatch(flow);
    await hub.settled(started.taskId);
    // Stored rows model a different planner's worker without running another model or workflow.
    const foreignId = `${started.taskId}-foreign`;
    db.insert(schema.tasks).values({ id: foreignId, title: "Private foreign worker", workflow: "review", status: "idle", options: { reportsTo: "other-planner" }, createdAt: "2026-01-01", updatedAt: "2026-01-01" }).run();
    for (const name of logTools) {
      const replies: string[] = [];
      for (const id of [task.id, foreignId, "missing-task", started.taskId.slice(0, 8)]) {
        const result = await client.callTool({ name, arguments: { task: id, pattern: "evidence" } });
        expect(result.isError).toBe(true);
        replies.push(toolText(result));
      }
      expect(new Set(replies)).toEqual(new Set(["Task log access denied: select a task started by this planning conversation"]));
    }
    flow.planner.release();
  });

  it("redacts all log tools, enforces output budgets and fails closed on unreadable Hub tokens", async () => {
    const flow = flowHub();
    const { hub } = flow;
    const { started, client } = await dispatch(flow);
    await hub.settled(started.taskId);
    const secretValues = ["hub-private-value", "bearer-private-value", `ghp_${"a".repeat(25)}`, "oauth-private-code", "oauth-private-state", "access-private-value", "cookie-private-value"];
    fs.writeFileSync(path.join(root, "data", "token"), `${secretValues[0]}\n`);
    const secrets = [secretValues[0], `Authorization: Bearer ${secretValues[1]}`, secretValues[2],
      `https://login.example.invalid/callback?code=${secretValues[3]}&state=${secretValues[4]}`,
      `{"access_token":"${secretValues[5]}"}`, `Set-Cookie: session=${secretValues[6]}`].join("\n");
    addEvent(hub, started.taskId, { type: "tool_call", name: "secrets", input: secrets, output: secrets, sideEffect: "none" });
    addEvent(hub, started.taskId, { type: "test_result", round: 2, command: "fixture", exitCode: 0, output: secrets });
    for (const name of logTools) {
      const result = await client.callTool({ name, arguments: { task: started.taskId, includeOutputs: true, pattern: "/.*/" } });
      const text = toolText(result);
      expect(result.isError).not.toBe(true);
      for (const value of secretValues) expect(text).not.toContain(value);
      expect(text).toContain("[redacted]");
    }
    const large = `discarded-prefix${"x".repeat(20_000)}retained-suffix`;
    const seq = addEvent(hub, started.taskId, { type: "tool_call", name: "big", input: "input", output: large, sideEffect: "none" });
    addEvent(hub, started.taskId, { type: "test_result", round: 3, command: "big-test", exitCode: null, output: large });
    const log = toolText(await client.callTool({ name: "read_task_log", arguments: { task: started.taskId, afterSeq: seq - 1, includeOutputs: true } }));
    const outputs = log.split("Output:\n").slice(1);
    expect(outputs).toHaveLength(2);
    expect(outputs[0]!.split(`\n[seq ${seq + 1}]`)[0]).toHaveLength(4_000);
    expect(outputs[1]).toHaveLength(4_000);
    expect(log).not.toContain("discarded-prefix");
    const test = toolText(await client.callTool({ name: "read_task_test_output", arguments: { task: started.taskId } }));
    expect(test.split("Output:\n")[1]).toHaveLength(16_000);
    expect(test).toContain("retained-suffix");
    expect(test).toContain("[truncated]");
    addEvent(hub, started.taskId, { type: "agent_text", text: "z".repeat(40_000) });
    const capped = toolText(await client.callTool({ name: "read_task_log", arguments: { task: started.taskId } }));
    expect(capped).toHaveLength(32_000);
    expect(capped).toMatch(/\[truncated\]$/);
    addEvent(hub, started.taskId, { type: "agent_text", text: Array.from({ length: 120 }, (_, i) => `MATCH line ${i}`).join("\n") });
    const search = toolText(await client.callTool({ name: "search_task_log", arguments: { task: started.taskId, pattern: "match line" } }));
    expect(search.split("\n")).toHaveLength(100);
    expect(search).toContain("MATCH line 99");
    expect(search).not.toContain("MATCH line 100");
    fs.unlinkSync(path.join(root, "data", "token"));
    fs.mkdirSync(path.join(root, "data", "token"));
    for (const name of logTools) {
      const result = await client.callTool({ name, arguments: { task: started.taskId, pattern: "match" } });
      expect(result.isError).toBe(true);
      expect(toolText(result)).toBe("Task log unavailable: token redaction could not be loaded.");
    }
    flow.planner.release();
  });

  it("reports a worker without test results clearly", async () => {
    const flow = flowHub();
    const { hub } = flow;
    const { started, client } = await dispatch(flow);
    await hub.settled(started.taskId);
    db.delete(schema.events).where(sql`${schema.events.taskId} = ${started.taskId} AND ${schema.events.type} = 'test_result'`).run();
    expect(toolText(await client.callTool({ name: "read_task_test_output", arguments: { task: started.taskId } }))).toBe("No test result recorded for this task.");
    flow.planner.release();
  });
});

it("routes deduplicated conflict reports through durable planner input and gates update_pr by ownership and fresh user agreement", async () => {
  const flow = flowHub();
  const { task, started, client } = await dispatch(flow);
  await flow.hub.settled(started.taskId);
  await flow.hub.openPr(started.taskId);
  const worker = flow.hub.getTask(started.taskId);
  const revision = { head: worker.workspace!.branch, headSha: git("rev-parse", worker.workspace!.branch), target: "release", targetSha: "a".repeat(40), crossRepository: false };
  Object.assign(flow.forge, { inspectPullRequest: async () => ({ ...revision, state: "open", mergeable: "CONFLICTING" }) });
  await flow.hub.pollPullRequests(); await flow.hub.pollPullRequests();
  const conflict = reports(flow.hub, task.id).filter(e => e.report.outcome === "conflict");
  expect(conflict).toHaveLength(1);
  expect(conflict[0]!.report.conflict).toEqual(revision);
  expect(conflict[0]!.prompt).toContain("updating this SAME existing PR");
  expect(conflict[0]!.prompt).not.toContain("Open the PR now");
  expect(toolText(await client.callTool({ name: "update_pr", arguments: { task: started.taskId } }))).toContain("user message is required after");
  flow.planner.release(); await flow.hub.settled(task.id);
  expect(flow.planner.runs.at(-1)!.prompt).toContain('"outcome":"conflict"');
  const approved = await plannerTurn(flow.hub, flow.planner, task.id, "Yes, update this existing PR and push after validation");
  const update = vi.spyOn(flow.hub, "updatePr").mockReturnValue({ id: "approved-update", revision, pr: { repo: "example/project", number: 8 }, stage: "noop" });
  expect((await approved.callTool({ name: "update_pr", arguments: { task: started.taskId } })).isError).not.toBe(true);
  expect(update).toHaveBeenCalledExactlyOnceWith(started.taskId, revision, task.id);
  expect(toolText(await approved.callTool({ name: "update_pr", arguments: { task: started.taskId } }))).toContain("user message is required after");
  expect(toolText(await approved.callTool({ name: "update_pr", arguments: { task: task.id } }))).toContain("not started by this planning conversation");
  update.mockRestore();
  const app = createApp(flow.hub, "test-token");
  expect((await app.request(`/api/tasks/${started.taskId}/pr/update`, { method: "POST", headers: { "content-type": "application/json", Authorization: "Bearer test-token" }, body: JSON.stringify({ confirmed: true, revision }) })).status).toBe(409);
  flow.planner.release(); await flow.hub.settled(task.id);
  flow.hub.recoverInterrupted(); flow.hub.recoverInterrupted();
  expect(reports(flow.hub, task.id).filter(e => e.report.outcome === "conflict")).toHaveLength(1);
});

it("cannot reuse pre-restart agreement when a durable conflict report is replayed", async () => {
  const flow = flowHub();
  const { task, started } = await dispatch(flow);
  await flow.hub.settled(started.taskId); await flow.hub.openPr(started.taskId);
  const ws = flow.hub.getTask(started.taskId).workspace!;
  const revision = { head: ws.branch, headSha: git("rev-parse", ws.branch), target: "release", targetSha: "a".repeat(40), crossRepository: false };
  Object.assign(flow.forge, { inspectPullRequest: async () => ({ ...revision, state: "open", mergeable: "CONFLICTING" }) });
  await flow.hub.pollPullRequests();
  flow.planner.release(); await flow.hub.settled(task.id);
  await plannerTurn(flow.hub, flow.planner, task.id, "Yes, update this PR after validation");
  flow.planner.release(); await flow.hub.settled(task.id);
  const report = reports(flow.hub, task.id).find(e => e.report.outcome === "conflict")!;
  db.update(schema.events).set({ payload: { report: { ...report.report, handled: false }, prompt: report.prompt } }).where(eq(schema.events.id, report.id)).run();
  const planner = new FakeAdapter(); planner.hold();
  const restarted = makeHub(planner, { forge: flow.forge });
  restarted.recoverInterrupted();
  await vi.waitFor(() => expect(planner.runs.at(-1)?.mcp).toBeDefined());
  const replay = await connect(planner.runs.at(-1)!.mcp!);
  expect(toolText(await replay.callTool({ name: "update_pr", arguments: { task: started.taskId } }))).toContain("user message is required after");
  planner.release(); await restarted.settled(task.id);
  const approved = await plannerTurn(restarted, planner, task.id, "Yes, retry the update now");
  const update = vi.spyOn(restarted, "updatePr").mockReturnValue({ id: "new-update", pr: { repo: "example/project", number: 8 }, revision, stage: "noop" });
  expect((await approved.callTool({ name: "update_pr", arguments: { task: started.taskId } })).isError).not.toBe(true);
  expect(update).toHaveBeenCalledTimes(1);
  planner.release(); await restarted.settled(task.id);
});

it("update_pr returns its operation id before a held worker finishes and reports completion durably", async () => {
  const flow = flowHub();
  const { task, started } = await dispatch(flow);
  await flow.hub.settled(started.taskId);
  const remote = path.join(root, "remote.git");
  git("init", "--bare", "-q", remote); git("remote", "add", "origin", remote); git("push", "-q", "origin", "main");
  flow.forge.push.mockImplementation(async (ws: Workspace) => { git("-C", ws.worktreePath, "push", "origin", `${ws.branch}:refs/heads/${ws.branch}`); });
  await flow.hub.openPr(started.taskId);
  fs.writeFileSync(path.join(repo, "deployment.txt"), "Upstream implementation\n");
  git("add", "."); git("commit", "-qm", "target advances"); git("push", "-q", "origin", "main");
  const ws = flow.hub.getTask(started.taskId).workspace!;
  Object.assign(flow.forge, { inspectPullRequest: async () => ({ state: "open", mergeable: "CONFLICTING", head: ws.branch,
    headSha: git("--git-dir", remote, "rev-parse", `refs/heads/${ws.branch}`), target: "main", targetSha: git("rev-parse", "main"), crossRepository: false }) });
  await flow.hub.pollPullRequests();
  flow.planner.release(); await flow.hub.settled(task.id);
  const approved = await plannerTurn(flow.hub, flow.planner, task.id, "Yes, update the existing PR and push after validation");
  const calls = flow.worker.runs.length;
  flow.worker.hold(0);
  try {
    let result: Awaited<ReturnType<Client["callTool"]>> | undefined;
    const call = approved.callTool({ name: "update_pr", arguments: { task: started.taskId } }).then(value => { result = value; });
    await vi.waitFor(() => expect(result).toBeDefined(), { timeout: 1500 });
    await call;
    const intent = JSON.parse(toolText(result!));
    expect(intent).toMatchObject({ stage: "intent" }); expect(intent.id).toEqual(expect.any(String));
    await vi.waitFor(() => expect(flow.worker.runs.length).toBe(calls + 1));
    expect(flow.hub.isBusy(started.taskId)).toBe(true);
    expect(flow.hub.events(task.id).filter(e => e.type === "pr_update_authorized").at(-1)).toMatchObject({ operationId: intent.id });
    expect(reports(flow.hub, task.id).some(e => e.report.prUpdate?.id === intent.id)).toBe(false);
  } finally {
    flow.worker.release(); flow.planner.release();
    await flow.hub.settled(started.taskId); await flow.hub.settled(task.id);
  }
  expect(reports(flow.hub, task.id).at(-1)).toMatchObject({ report: { outcome: "updated", prUpdate: { stage: "succeeded" } } });
});

it("abandon_pr_update consumes only fresh ownership-checked agreement and planning-owned HTTP abandonment is refused", async () => {
  const flow = flowHub();
  const { task, started, client } = await dispatch(flow);
  await flow.hub.settled(started.taskId);
  expect(toolText(await client.callTool({ name: "abandon_pr_update", arguments: { task: started.taskId } }))).toContain("user message is required after");
  expect(toolText(await client.callTool({ name: "abandon_pr_update", arguments: { task: task.id } }))).toContain("not started by this planning conversation");
  flow.planner.release(); await flow.hub.settled(task.id);
  const approved = await plannerTurn(flow.hub, flow.planner, task.id, "Yes, abandon the retained local update; keep the PR unchanged");
  const revision = { head: "feature/task", headSha: "a".repeat(40), target: "release", targetSha: "b".repeat(40), crossRepository: false };
  const abandon = vi.spyOn(flow.hub, "abandonPrUpdate").mockReturnValue({ id: "abandon-operation", pr: { repo: "example/project", number: 8 }, revision, stage: "abandoning", owned: true, action: "abandon" });
  const markers = flow.hub.events(task.id).filter(e => e.type === "pr_update_authorized").length;
  abandon.mockImplementationOnce(() => { throw new Error("Execution slot unavailable"); });
  expect((await approved.callTool({ name: "abandon_pr_update", arguments: { task: started.taskId } })).isError).toBe(true);
  expect(flow.hub.events(task.id).filter(e => e.type === "pr_update_authorized")).toHaveLength(markers);
  expect((await approved.callTool({ name: "abandon_pr_update", arguments: { task: started.taskId } })).isError).not.toBe(true);
  expect(abandon).toHaveBeenLastCalledWith(started.taskId, task.id);
  expect(flow.hub.events(task.id).filter(e => e.type === "pr_update_authorized").at(-1)).toMatchObject({ operationId: "abandon-operation", action: "abandon" });
  expect(toolText(await approved.callTool({ name: "abandon_pr_update", arguments: { task: started.taskId } }))).toContain("user message is required after");
  abandon.mockRestore();
  const app = createApp(flow.hub, "test-token");
  expect((await app.request(`/api/tasks/${started.taskId}/pr/abandon-update`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer test-token" }, body: JSON.stringify({ confirmed: true }) })).status).toBe(409);
  flow.planner.release(); await flow.hub.settled(task.id);
});

it("starts actual abandonment through MCP only after fresh agreement and consumes that agreement immediately", async () => {
  const flow = flowHub();
  const { task, started, client } = await dispatch(flow);
  await flow.hub.settled(started.taskId);
  const remote = path.join(root, "abandon-remote.git");
  git("init", "--bare", "-q", remote); git("remote", "add", "origin", remote); git("push", "-q", "origin", "main");
  flow.forge.push.mockImplementation(async (ws: Workspace) => { git("-C", ws.worktreePath, "push", "origin", `${ws.branch}:refs/heads/${ws.branch}`); });
  await flow.hub.openPr(started.taskId);
  const worker = flow.hub.getTask(started.taskId);
  db.update(schema.tasks).set({ options: { ...worker.options, testCommand: "test ! -f upstream.txt" } }).where(eq(schema.tasks.id, worker.id)).run();
  fs.writeFileSync(path.join(repo, "upstream.txt"), "target advances\n");
  git("add", "."); git("commit", "-qm", "advance target"); git("push", "-q", "origin", "main");
  const ws = worker.workspace!;
  const inspect = async () => ({ state: "open", mergeable: "MERGEABLE", head: ws.branch,
    headSha: git("--git-dir", remote, "rev-parse", `refs/heads/${ws.branch}`), target: "main", targetSha: git("rev-parse", "main"), crossRepository: false });
  Object.assign(flow.forge, { inspectPullRequest: inspect });
  await flow.hub.pollPullRequests();
  flow.hub.updatePr(worker.id, flow.hub.getTask(worker.id).workspace!.pr!.revision!, task.id);
  await flow.hub.settled(worker.id);
  expect(flow.hub.events(worker.id).filter(e => e.type === "pr_update").at(-1)).toMatchObject({ update: { stage: "failed", owned: true } });
  const foreign = await flow.hub.createTask({ workflow: "implement", title: "Other task", repoPath: repo, message: "Separate task" });
  await flow.hub.settled(foreign.id);
  expect(toolText(await client.callTool({ name: "abandon_pr_update", arguments: { task: foreign.id } }))).toContain("not started by this planning conversation");
  expect(toolText(await client.callTool({ name: "abandon_pr_update", arguments: { task: worker.id } }))).toContain("user message is required after");
  flow.planner.release(); await flow.hub.settled(task.id);
  const approved = await plannerTurn(flow.hub, flow.planner, task.id, "Yes, abandon this update and leave the existing PR unchanged");
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  Object.assign(flow.forge, { inspectPullRequest: async () => { await gate; return inspect(); } });
  try {
    let response: Awaited<ReturnType<Client["callTool"]>> | undefined;
    const call = approved.callTool({ name: "abandon_pr_update", arguments: { task: worker.id } }).then(value => { response = value; });
    await vi.waitFor(() => expect(response).toBeDefined(), { timeout: 1500 }); await call;
    expect(response!.isError).not.toBe(true);
    const operation = JSON.parse(toolText(response!));
    expect(operation).toMatchObject({ stage: "abandoning" }); expect(operation.id).toEqual(expect.any(String));
    expect(flow.hub.isBusy(worker.id)).toBe(true);
    expect(flow.hub.events(task.id).filter(e => e.type === "pr_update_authorized").at(-1)).toMatchObject({ operationId: operation.id, action: "abandon" });
    expect(toolText(await approved.callTool({ name: "abandon_pr_update", arguments: { task: worker.id } }))).toContain("user message is required after");
    expect(reports(flow.hub, task.id).some(e => e.report.prUpdate?.id === operation.id)).toBe(false);
  } finally {
    release(); flow.planner.release(); await flow.hub.settled(worker.id); await flow.hub.settled(task.id);
  }
  expect(reports(flow.hub, task.id).at(-1)).toMatchObject({ report: { outcome: "update_abandoned", prUpdate: { stage: "abandoned", retainedUntracked: { total: 0 } } } });
});

describe("durable planning issue relationships", () => {
  it.each(["codex", "claude"] as const)("%s saves the first successful read, inherits summaries and keeps overrides local across restart", async (agentKind) => {
    const forge = fakeForge();
    forge.readIssue.mockImplementation(async (_repo, number) => {
      if (number === 9) throw new Error("#9 is a pull request, not an issue");
      if (number === 99) throw new Error("Not found");
      return { ...issue, number, url: `https://github.com/example/project/issues/${number}` };
    });
    const agent = new FakeAdapter(); agent.hold(); const hub = makeHub(agent, { forge });
    const task = await hub.createTask({ ...plan(), agent: agentKind });
    await vi.waitFor(() => expect(agent.runs[0]?.mcp).toBeDefined());
    const client = await connect(agent.runs[0]!.mcp!);
    await client.callTool({ name: "list_issues", arguments: {} });
    for (const number of [9, 99]) expect((await client.callTool({ name: "read_issue", arguments: { number } })).isError).toBe(true);
    expect(hub.getTask(task.id).options.planningIssue).toBeUndefined();
    await client.callTool({ name: "propose_task", arguments: proposal });
    const unlinked = hub.events(task.id).filter(e => e.type === "task_proposal").at(-1)!;
    expect(unlinked).not.toHaveProperty("issue"); expect(unlinked).not.toHaveProperty("issueCompletion");
    const observations: number[] = [];
    const off = hub.subscribe(m => {
      if (m.type === "event" && m.event.type === "planning_issue") {
        expect(hub.getTask(task.id).options.planningIssue).toEqual(m.event.issue);
        observations.push(m.event.issue.number);
      }
    });
    await client.callTool({ name: "read_issue", arguments: { number: 7 } });
    hub.setPinned(task.id, true);
    await client.callTool({ name: "read_issue", arguments: { number: 8 } });
    expect(observations).toEqual([7]); off();
    for (const args of [
      { ...proposal, issueSummary: publicSummary },
      { ...proposal, issue: 8, issueCompletion: "complete" },
      { ...proposal, issue: null, issueCompletion: "complete" },
    ]) expect((await client.callTool({ name: "propose_task", arguments: args })).isError).not.toBe(true);
    const sources = hub.events(task.id).filter(e => e.type === "task_proposal");
    expect(sources.slice(1)).toMatchObject([{ issue: { number: 7 }, issueCompletion: "partial" }, { issue: { number: 8 }, issueCompletion: "complete" }, {}]);
    expect(sources.at(-1)).not.toHaveProperty("issue"); expect(sources.at(-1)).not.toHaveProperty("issueCompletion");
    const summary = hub.events(task.id).find(e => e.type === "issue_comment_draft")!;
    expect(summary).toMatchObject({ issue: { number: 7 }, proposalId: sources[1]!.id });
    expect((await client.callTool({ name: "propose_task", arguments: { ...proposal, issue: null, issueSummary: publicSummary } })).isError).toBe(true);
    expect(hub.getTask(task.id).options).toMatchObject({ planningIssue: { number: 7 }, pinnedAt: expect.any(String) });
    agent.release(); await hub.settled(task.id);
    const restarted = makeHub(agent, { forge });
    expect(restarted.getTask(task.id).options.planningIssue?.number).toBe(7);
    restarted.sendMessage(task.id, "Continue"); await restarted.settled(task.id);
    expect(agent.runs.at(-1)!.turnContext).toContain('Saved planning issue default: {"number":7');
    const worker = await restarted.createTask({ ...plan(), workflow: "implement", fromProposal: { taskId: task.id, eventId: sources[1]!.id }, issue: 8, issueCompletion: "partial" });
    await restarted.settled(worker.id);
    expect(worker.options).toMatchObject({ issue: { number: 8 }, issueCompletion: "partial" });
    expect(restarted.events(task.id).find(e => e.id === sources[1]!.id)).toMatchObject({ issue: { number: 7 } });
    expect(restarted.events(task.id).find(e => e.id === summary.id)).toMatchObject({ issue: { number: 7 } });
    expect(forge.createIssueComment).not.toHaveBeenCalled();
  });

  it("validates seeded creation through HTTP and ignores issue-like prompt text", async () => {
    const forge = fakeForge(); const agent = new FakeAdapter(); const hub = makeHub(agent, { forge });
    const app = createApp(hub, "fixture-token");
    const post = (value: unknown) => app.request("/api/tasks", { method: "POST", headers: { Authorization: "Bearer fixture-token", "content-type": "application/json" }, body: JSON.stringify(value) });
    for (const issue of [0, -1, 1.5, "7", {}, 999]) expect((await post({ ...plan(), issue })).status).toBe(400);
    const seeded = await hub.createTask({ ...plan(), issue: 7 }); await hub.settled(seeded.id);
    expect(seeded.options.planningIssue?.number).toBe(7);
    expect(hub.events(seeded.id).filter(e => e.type === "planning_issue")).toHaveLength(1);
    expect(agent.runs[0]!.turnContext).toContain('"number":7');
    const unseeded = await hub.createTask({ ...plan(), message: "Read #7 at https://github.com/other/repo/issues/7" }); await hub.settled(unseeded.id);
    expect(unseeded.options.planningIssue).toBeUndefined();
    expect(forge.readIssue.mock.calls.every(([repo]) => repo === "example/project")).toBe(true);
  });

  it("serializes simultaneous successful reads without losing latest task options", async () => {
    const forge = fakeForge(); const agent = new FakeAdapter(); agent.hold(); const hub = makeHub(agent, { forge });
    const task = await hub.createTask(plan()); await vi.waitFor(() => expect(agent.runs[0]?.mcp).toBeDefined());
    const client = await connect(agent.runs[0]!.mcp!);
    const releases = new Map<number, () => void>();
    forge.readIssue.mockImplementation(async (_repo, number) => {
      await new Promise<void>(resolve => releases.set(number, resolve));
      return { ...issue, number };
    });
    const first = client.callTool({ name: "read_issue", arguments: { number: 7 } });
    const second = client.callTool({ name: "read_issue", arguments: { number: 8 } });
    await vi.waitFor(() => expect(releases.size).toBe(2)); hub.setPinned(task.id, true);
    releases.get(8)!(); await second; releases.get(7)!(); await first;
    expect(hub.getTask(task.id).options).toMatchObject({ planningIssue: { number: 8 }, pinnedAt: expect.any(String) });
    expect(hub.events(task.id).filter(e => e.type === "planning_issue")).toHaveLength(1);
    agent.release(); await hub.settled(task.id);
  });

  it.each(["ask", "end", "abort"])("does not save a read completing after %s", async (ending) => {
    const forge = fakeForge(); const agent = new FakeAdapter(); agent.hold(); const hub = makeHub(agent, { forge });
    const task = await hub.createTask(plan()); await vi.waitFor(() => expect(agent.runs[0]?.mcp).toBeDefined());
    const client = await connect(agent.runs[0]!.mcp!);
    let release!: () => void; let reading = false;
    forge.readIssue.mockImplementation(async () => { reading = true; await new Promise<void>(resolve => { release = resolve; }); return issue; });
    const pending = client.callTool({ name: "read_issue", arguments: { number: 7 } }).catch(() => undefined);
    await vi.waitFor(() => expect(reading).toBe(true));
    if (ending === "ask") await client.callTool({ name: "ask", arguments: { question: "Continue?" } });
    else if (ending === "abort") hub.stop(task.id);
    else { agent.release(); await hub.settled(task.id); }
    release(); await pending; agent.release(); await hub.settled(task.id);
    expect(hub.getTask(task.id).options.planningIssue).toBeUndefined();
    expect(hub.events(task.id).some(e => e.type === "planning_issue")).toBe(false);
  });

  it("rolls back the default projection and SSE with its typed event", async () => {
    const forge = fakeForge(); const agent = new FakeAdapter(); agent.hold(); const hub = makeHub(agent, { forge });
    const task = await hub.createTask(plan()); await vi.waitFor(() => expect(agent.runs[0]?.mcp).toBeDefined());
    const client = await connect(agent.runs[0]!.mcp!); const seen: TaskEvent[] = [];
    const off = hub.subscribe(m => { if (m.type === "event") seen.push(m.event); });
    db.run(sql`CREATE TRIGGER reject_default BEFORE INSERT ON events WHEN NEW.type = 'planning_issue' BEGIN SELECT RAISE(ABORT, 'default fixture failure'); END`);
    expect((await client.callTool({ name: "read_issue", arguments: { number: 7 } })).isError).toBe(true);
    expect(hub.getTask(task.id).options.planningIssue).toBeUndefined();
    expect(seen.some(e => e.type === "planning_issue")).toBe(false);
    off(); agent.release(); await hub.settled(task.id);
  });
});

it.each([
  { name: "inherit", overrides: {}, issue: 7, mode: "partial" },
  { name: "complete", overrides: { issueCompletion: "complete" as const }, issue: 7, mode: "complete" },
  { name: "replace", overrides: { issue: 8 }, issue: 8, mode: "partial" },
  { name: "detach", overrides: { issue: null }, issue: undefined, mode: undefined },
])("start_task and editable creation produce equivalent $name choices", async ({ overrides, issue: number, mode }) => {
  const flow = flowHub(); flow.forge.readIssue.mockImplementation(async (_repo, number) => ({ ...issue, number, url: `https://github.com/example/project/issues/${number}` }));
  flow.planner.hold(); const task = await flow.hub.createTask({ ...plan(), issue: 7 });
  await vi.waitFor(() => expect(flow.planner.runs[0]?.mcp).toBeDefined());
  const client = await connect(flow.planner.runs[0]!.mcp!);
  for (let n = 0; n < 2; n++) expect((await client.callTool({ name: "propose_task", arguments: proposal })).isError).not.toBe(true);
  const sources = flow.hub.events(task.id).filter(e => e.type === "task_proposal");
  expect((await client.callTool({ name: "start_task", arguments: { proposal: sources[0]!.id, ...overrides } })).isError).toBe(true);
  flow.hub.sendMessage(task.id, "Yes, start the agreed proposal with these choices");
  const reply = await client.callTool({ name: "start_task", arguments: { proposal: sources[0]!.id, ...overrides } });
  expect(reply.isError, toolText(reply)).not.toBe(true);
  const workerId = JSON.parse(toolText(reply)).taskId;
  const manual = await flow.hub.createTask({ ...plan(), workflow: "review", title: proposal.title, message: proposal.spec, fromProposal: { taskId: task.id, eventId: sources[1]!.id }, ...overrides });
  const direct = flow.hub.getTask(workerId);
  expect(direct.options.issue?.number).toBe(number); expect(direct.options.issueCompletion).toBe(mode);
  expect(manual.options.issue).toEqual(direct.options.issue); expect(manual.options.issueCompletion).toBe(direct.options.issueCompletion);
  expect((await client.callTool({ name: "start_task", arguments: { proposal: sources[0]!.id } })).isError).toBe(true);
  expect(flow.hub.getTask(task.id).options.planningIssue?.number).toBe(7);
  expect(flow.hub.events(task.id).find(e => e.id === sources[0]!.id)).toMatchObject({ issue: { number: 7 }, issueCompletion: "partial" });
  flow.planner.release(); await flow.hub.settled(workerId); await flow.hub.settled(manual.id); await flow.hub.settled(task.id);
});

it.each(["partial", "complete", "legacy"] as const)("ordinary PR uses %s mode without requiring a draft", async mode => {
  const forge = fakeForge(); const agent = workerScript(); const hub = makeHub(agent, { forge });
  const task = await hub.createTask({ ...plan(), workflow: "implement", issue: 7, issueCompletion: mode === "legacy" ? undefined : mode });
  await hub.settled(task.id);
  if (mode === "legacy") {
    const options = { ...hub.getTask(task.id).options }; delete options.issueCompletion;
    db.update(schema.tasks).set({ options }).where(eq(schema.tasks.id, task.id)).run();
  }
  await hub.openPr(task.id);
  const body = forge.openPullRequest.mock.calls[0]![3];
  expect(body).toContain(`\n\n${mode === "partial" ? "Refs" : "Closes"} #7`);
  expect(hub.events(task.id).some(e => e.type === "pr_draft")).toBe(false);
  expect(forge.close).not.toHaveBeenCalled();
});

it("retains a seeded planning default through a real chat/plan backend handoff", async () => {
  const summary = { goals: "保留需求 #1", decisions: "已確認 #1", constraints: "範圍 #1", completed: "已讀 #1", pending: "待辦 #1", uncertainty: "待確認 #1", references: [1] };
  const agent = new FakeAdapter(input => input.toolsDisabled
    ? [{ type: "text_delta", text: JSON.stringify(summary) }, { type: "done", ok: true }]
    : [{ type: "thread", threadId: "fixture-thread" }, { type: "done", ok: true }]);
  const hub = makeHub(agent, { forge: fakeForge() });
  const task = await hub.createTask({ ...plan(), issue: 7 }); await hub.settled(task.id);
  const source = task.sessions.find(s => s.role === "main")!;
  await hub.switchAgent(task.id, { target: "claude", expectedSessionId: source.id });
  hub.sendMessage(task.id, "Continue planning"); await hub.settled(task.id);
  expect(hub.getTask(task.id).options.planningIssue?.number).toBe(7);
  expect(agent.runs.at(-1)!.turnContext).toContain('Saved planning issue default: {"number":7');
  expect(hub.events(task.id).filter(e => e.type === "planning_issue")).toHaveLength(1);
});

it("revalidates active turn before an asynchronously validated start_task commits", async () => {
  const flow = flowHub(); const { task, event } = await propose(flow.hub, flow.planner);
  const client = await plannerTurn(flow.hub, flow.planner, task.id);
  let reading = false; let release!: () => void;
  flow.forge.readIssue.mockImplementation(async () => { reading = true; await new Promise<void>(resolve => { release = resolve; }); return issue; });
  const pending = client.callTool({ name: "start_task", arguments: { proposal: event.id, issue: 7 } });
  await vi.waitFor(() => expect(reading).toBe(true));
  await client.callTool({ name: "ask", arguments: { question: "Reconsider?" } });
  release(); const result = await pending;
  expect(result.isError).toBe(true); expect(toolText(result)).toContain("This turn has ended");
  expect(flow.hub.listTasks()).toHaveLength(1);
  expect(flow.hub.events(task.id).find(e => e.id === event.id)).not.toHaveProperty("startedTaskId");
  flow.planner.release(); await flow.hub.settled(task.id);
});

it.each(["inherit", "replace", "detach", "complete"] as const)("legacy dialog creation payload matches start_task for %s", async selection => {
  const web = path.resolve(import.meta.dirname, "../../web");
  const { createServer } = await import(path.join(web, "node_modules/vite/dist/node/index.js"));
  const server = await createServer({
    root: web, configFile: false, resolve: { alias: { "@": path.join(web, "src") } }, esbuild: { jsx: "automatic" },
    // This SSR-only contract check does not need browser dependency discovery or optimization.
    optimizeDeps: { noDiscovery: true, include: [] },
    cacheDir: path.join(root, "vite-cache"),
    server: { middlewareMode: true, hmr: false, watch: null },
  });
  try {
    const { initialIssueChoice, changeIssueChoice, issueChoiceInput } = await server.ssrLoadModule("/src/components/issue-link.tsx");
    const source = { issue: 7 };
    let choice = initialIssueChoice(source);
    const overrides = selection === "inherit" ? {} : selection === "detach" ? { issue: null } : selection === "complete" ? { issue: 8, issueCompletion: "complete" } : { issue: 8 };
    if (selection !== "inherit") choice = changeIssueChoice(choice, selection === "detach" ? "" : "8", "complete", "issue", source);
    if (selection === "complete") choice = changeIssueChoice(choice, "8", "complete", "completion", source);
    const uiPayload = JSON.parse(JSON.stringify(issueChoiceInput(choice)));
    const flow = flowHub();
    flow.forge.readIssue.mockImplementation(async (_repo, number) => ({ ...issue, number, url: `https://github.com/example/project/issues/${number}` }));
    flow.planner.hold(); const task = await flow.hub.createTask({ ...plan(), issue: 7 });
    await vi.waitFor(() => expect(flow.planner.runs[0]?.mcp).toBeDefined());
    const client = await connect(flow.planner.runs[0]!.mcp!);
    for (let n = 0; n < 2; n++) await client.callTool({ name: "propose_task", arguments: proposal });
    const sources = flow.hub.events(task.id).filter(e => e.type === "task_proposal");
    for (const event of sources) {
      const { id, taskId: _taskId, sessionId: _sessionId, seq: _seq, createdAt: _createdAt, type: _type, issueCompletion: _completion, ...payload } = event;
      db.update(schema.events).set({ payload }).where(eq(schema.events.id, id)).run();
    }
    flow.hub.sendMessage(task.id, "Yes, start with these issue choices");
    const reply = await client.callTool({ name: "start_task", arguments: { proposal: sources[0]!.id, ...overrides } });
    expect(reply.isError, toolText(reply)).not.toBe(true);
    const workerId = JSON.parse(toolText(reply)).taskId;
    const manual = await flow.hub.createTask({ ...plan(), workflow: "review", title: proposal.title, message: proposal.spec, fromProposal: { taskId: task.id, eventId: sources[1]!.id }, ...uiPayload });
    const direct = flow.hub.getTask(workerId);
    expect(manual.options.issue).toEqual(direct.options.issue);
    expect(manual.options.issueCompletion).toBe(direct.options.issueCompletion);
    expect(manual.options.issue?.number).toBe(selection === "detach" ? undefined : selection === "inherit" ? 7 : 8);
    expect(manual.options.issueCompletion).toBe(selection === "complete" ? "complete" : selection === "replace" ? "partial" : undefined);
    expect(flow.hub.getTask(task.id).options.planningIssue?.number).toBe(7);
    expect(flow.hub.events(task.id).find(e => e.id === sources[1]!.id)).toMatchObject({ issue: { number: 7 } });
    flow.planner.release(); await flow.hub.settled(workerId); await flow.hub.settled(manual.id); await flow.hub.settled(task.id);
  } finally { await server.close(); }
});
