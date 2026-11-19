import { briefingFixture } from "./briefing-fixture";
import { briefingAppendix } from "../src/core/briefing";
import { eq } from "drizzle-orm";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NewTaskInput, PrDraft, RepoSettings, TaskEvent, Workspace } from "@agent-hub/shared";
import { FakeAdapter, type FakeStep } from "../src/agents/fake";
import type { AgentRunInput } from "../src/agents/types";
import * as media from "../src/media/video";
import { createApp } from "../src/app";
import { Hub } from "../src/core/hub";
import { SYSTEM_APPEND, PLANNER_SYSTEM, REVIEWER_SYSTEM, SCOPE_GUIDANCE, worktreeNote } from "../src/core/prompts";
import { parsePrDraft, readPrTemplate, readRepoSettings, withTicketLink } from "../src/core/repo-settings";
import { openDb, schema } from "../src/db/index";
import { GitHubForge, type Forge, type PrState } from "../src/workspace/forge";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const template = "## Type of changes\n\n- [ ] Feature\n- [ ] Fix\n- [ ] Docs\n- [ ] Refactor\n- [ ] CI\n- [ ] Test\n- [ ] Chore\n\n## Purpose\n\n## Additional Information\n";
const draft: PrDraft = { type: "feat", summary: "Add durable recovery status", slug: "durable-recovery-status", body: "## Type of changes\n\n- [x] Feature\n\n## Purpose\n\nAdd durable status.\n\n## Additional Information\n\nTests cover recovery." };
const settings: RepoSettings = {
  base: "origin/main", ticket: { required: true, pattern: "^ACME-[0-9]+$", url: "https://example.atlassian.net/browse/{ticket}" },
  branch: "{type}/{ticket}-{slug}", commit: "{type}: {summary} ({ticket})", prTitle: "[{ticket}] {type}: {summary}",
  prLanguage: "en", prTemplate: ".github/PULL_REQUEST_TEMPLATE.md", testCommand: "git diff --check",
};

/** Real local pushes catch refspec errors and non-fast-forward history changes without GitHub. */
class TeamForge implements Forge {
  pushes: Workspace[] = [];
  opened: { ws: Workspace; title: string; body: string }[] = [];
  closed: number[] = [];
  remoteState: PrState = "open";
  failOpen = false;
  async repoOf() { return "example/team"; }
  async listIssues() { return []; }
  async readIssue(): Promise<never> { throw new Error("No issues"); }
  async push(ws: Workspace) {
    await new GitHubForge().push(ws);
    this.pushes.push(structuredClone(ws));
  }
  async openPullRequest(ws: Workspace, _repo: string, title: string, body: string) {
    if (this.failOpen) throw new Error("Forge unavailable");
    this.opened.push({ ws: structuredClone(ws), title, body });
    return { number: 11, url: "https://github.com/example/team/pull/11", state: "open" as const };
  }
  async state() { return this.remoteState; }
  async close(_repo: string, number: number) {
    this.closed.push(number);
    const ws = this.opened.at(-1)!.ws;
    git(ws.worktreePath, "push", "origin", "--delete", ws.remoteBranch ?? ws.branch);
  }
}

let root: string;
let origin: string;
let repo: string;
let upstream: string;
let dataDir: string;
let before: { branch: string; head: string; status: string; contents: string; untracked: string };
function snapshot() {
  return { branch: git(repo, "branch", "--show-current"), head: git(repo, "rev-parse", "HEAD"), status: git(repo, "status", "--porcelain"), contents: fs.readFileSync(path.join(repo, "README.md"), "utf8"), untracked: fs.readFileSync(path.join(repo, "untracked.txt"), "utf8") };
}
function configure(value: unknown = settings) {
  fs.writeFileSync(path.join(dataDir, "repos.json"), JSON.stringify({ [repo]: value }));
}
const reply = (input: AgentRunInput, text: string): FakeStep[] => [
  { type: "thread", threadId: input.threadId ?? "author-thread" }, { type: "text_start" }, { type: "text_delta", text }, { type: "done", ok: true },
];
function authorScript(metadata: string = JSON.stringify(draft)) {
  return (input: AgentRunInput, n: number): FakeStep[] => briefingFixture(input) ?? (input.toolsDisabled ? reply(input, metadata) : [
    { type: "write", path: "recovery.txt", content: `round ${n}\n` }, ...reply(input, "Implemented recovery."),
  ]);
}
function makeHub(author = new FakeAdapter(authorScript()), forge = new TeamForge(), dbFile = ":memory:") {
  const run = author.run.bind(author);
  author.run = async function* (input) {
    const fixture = briefingFixture(input);
    if (fixture) { author.runs.push(input); for (const event of fixture) if (event.type !== "write" && event.type !== "ask") yield event; }
    else yield* run(input);
  };
  const reviewer = new FakeAdapter((i) => i.toolsDisabled ? reply(i, '{"hunks":[]}') : reply(i, "VERDICT: approve\nFINDINGS: none"));
  const db = openDb(dbFile);
  return { db, hub: new Hub({ db, dataDir, agents: { claude: author, codex: reviewer }, forge, flushMs: 1, maxConcurrent: 4 }), author, reviewer, forge };
}
const input = (extra: Partial<NewTaskInput> = {}): NewTaskInput => ({ title: "Recovery", workflow: "review", agent: "claude", reviewer: "codex", repoPath: repo, ticket: "ACME-84", message: "Add recovery", ...extra });

const confirmation = (event: Extract<TaskEvent, { type: "pr_draft" }>) => ({ draftId: event.id, branch: event.branch, commitMessage: event.commitMessage, title: event.title, body: event.body });
async function publish(hub: Hub, taskId: string) {
  return hub.openPr(taskId, confirmation(await hub.preparePrDraft(taskId)));
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-hub-team-"));
  origin = path.join(root, "origin.git"); upstream = path.join(root, "upstream"); repo = path.join(root, "checkout"); dataDir = path.join(root, "data");
  fs.mkdirSync(dataDir);
  git(root, "init", "--bare", "-q", "-b", "main", origin);
  git(root, "clone", "-q", origin, upstream);
  git(upstream, "config", "user.name", "Test"); git(upstream, "config", "user.email", "test@example.invalid");
  fs.mkdirSync(path.join(upstream, ".github"));
  fs.writeFileSync(path.join(upstream, ".github/PULL_REQUEST_TEMPLATE.md"), template);
  fs.writeFileSync(path.join(upstream, "README.md"), "base\n");
  git(upstream, "add", "."); git(upstream, "commit", "-qm", "base"); git(upstream, "push", "-q", "origin", "main");
  git(root, "clone", "-q", origin, repo);
  git(repo, "config", "user.name", "Test"); git(repo, "config", "user.email", "test@example.invalid");
  git(repo, "checkout", "-qb", "teammate-feature");
  fs.writeFileSync(path.join(repo, "private-feature.txt"), "private work\n");
  git(repo, "add", "."); git(repo, "commit", "-qm", "private feature");
  fs.writeFileSync(path.join(repo, "README.md"), "uncommitted user work\n");
  fs.writeFileSync(path.join(repo, "untracked.txt"), "untracked user work\n");
  before = snapshot();
  // Origin moves after the user's clone: task creation must fetch this new commit.
  fs.writeFileSync(path.join(upstream, "fresh.txt"), "fresh main\n");
  git(upstream, "add", "."); git(upstream, "commit", "-qm", "new upstream commit"); git(upstream, "push", "-q", "origin", "main");
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("team repository tasks", () => {
  it("fetches the configured base while preserving the user's checkout and uses the saved ticket and test default", async () => {
    configure();
    const { hub, author } = makeHub();
    const task = await hub.createTask(input());
    await hub.settled(task.id);
    const current = hub.getTask(task.id);
    expect(current.workspace).toMatchObject({ baseRef: "origin/main", prBase: "main", baseSha: git(origin, "rev-parse", "main") });
    expect(current.options).toMatchObject({ repoSettings: settings, ticket: "ACME-84", ticketUrl: "https://example.atlassian.net/browse/ACME-84", testCommand: "git diff --check" });
    expect(fs.existsSync(path.join(current.cwd!, "private-feature.txt"))).toBe(false);
    expect(fs.readFileSync(path.join(current.cwd!, "fresh.txt"), "utf8")).toBe("fresh main\n");
    expect(author.runs[0]!.prompt).toContain("This work is for ACME-84");
    expect(hub.events(task.id)).toContainEqual(expect.objectContaining({ type: "test_result", exitCode: 0 }));
    expect(snapshot()).toEqual(before);
  });

  it("keeps local HEAD and the old PR format for a repository without an entry", async () => {
    const { hub, forge, author } = makeHub();
    const task = await hub.createTask(input({ ticket: undefined }));
    await hub.settled(task.id);
    expect(task.workspace).toMatchObject({ baseRef: before.branch, baseSha: before.head });
    await expect(hub.preparePrDraft(task.id)).rejects.toMatchObject({ status: 409 });
    await hub.openPr(task.id);
    expect(forge.pushes[0]!.remoteBranch).toBeUndefined();
    expect(forge.opened[0]!.body).toContain("## 需求");
    expect(forge.opened[0]!.title).toBe("Recovery");
    expect(author.runs.filter((run) => !run.systemPrompt?.startsWith("Generate a whole-change"))).toHaveLength(1);
    expect(git(origin, "log", "-1", "--format=%s", task.workspace!.branch)).toBe("agent-hub: Recovery (round 1)");
    expect(snapshot()).toEqual(before);
  });

  it("squashes private rounds and publishes conventions, then appends fast-forward commits across a restart and detects merge", async () => {
    configure();
    const file = path.join(dataDir, "test.db");
    const { hub, author, forge } = makeHub(undefined, undefined, file);
    const task = await hub.createTask(input());
    await hub.settled(task.id);
    hub.sendMessage(task.id, "Refine recovery"); await hub.settled(task.id);
    expect(git(task.cwd!, "rev-list", "--count", `${task.workspace!.baseSha}..HEAD`)).toBe("2");
    await publish(hub, task.id);
    const ws = hub.getTask(task.id).workspace!;
    const remote = "feat/ACME-84-durable-recovery-status";
    expect(ws).toMatchObject({ remoteBranch: remote, prDraft: draft });
    expect(git(origin, "for-each-ref", "--format=%(refname:short)", "refs/heads").split("\n").sort()).toEqual([remote, "main"]);
    expect(git(origin, "rev-list", "--count", `${ws.baseSha}..${remote}`)).toBe("1");
    expect(git(origin, "log", "-1", "--format=%s", remote)).toBe("feat: Add durable recovery status (ACME-84)");
    expect(git(origin, "log", "-1", "--format=%an <%ae>", remote)).toBe("Agent Hub <agent-hub@localhost>");
    expect(forge.opened[0]).toMatchObject({ title: "[ACME-84] feat: Add durable recovery status", ws: { baseRef: "origin/main", remoteBranch: remote } });
    expect(forge.opened[0]!.body).toContain("## Purpose\n\n[ACME-84](https://example.atlassian.net/browse/ACME-84)");
    expect(forge.opened[0]!.body).toContain("Agent Hub: Written by Claude; reviewed by Codex. Review rounds: 2. Tests: `git diff --check`: passed.");
    expect(forge.opened[0]!.body.split("\n\n<details")[0]).not.toMatch(/[\u3400-\u9fff]/);
    expect(forge.opened[0]!.body).toContain("<summary>整體變更導讀（繁體中文）</summary>");
    expect(author.runs.at(-1)).toMatchObject({ threadId: "author-thread", readOnly: true, toolsDisabled: true, mcp: undefined });
    expect(author.runs.at(-1)!.prompt).toContain(template);
    const first = git(origin, "rev-parse", remote);
    // Repository configuration edits must not change an existing task's publication target.
    configure({ ...settings, branch: "fix/{slug}", commit: "changed: {summary}" });
    const { hub: restarted } = makeHub(author, forge, file);
    restarted.sendMessage(task.id, "Address teammate feedback"); await restarted.settled(task.id);
    expect(git(origin, "rev-parse", `${remote}~1`)).toBe(first);
    expect(git(origin, "log", "-1", "--format=%s", remote)).toBe("feat: address review feedback (ACME-84)");
    expect(forge.pushes.map((push) => push.remoteBranch)).toEqual([remote, remote]);
    await restarted.pollPullRequests(); expect(restarted.getTask(task.id).workspace!.state).toBe("active");
    forge.remoteState = "merged"; await restarted.pollPullRequests();
    expect(restarted.getTask(task.id).workspace).toMatchObject({ state: "merged", pr: { state: "merged" }, remoteBranch: remote });
    expect(fs.existsSync(ws.worktreePath)).toBe(false);
    expect(snapshot()).toEqual(before);
  });

  it("closes and deletes the conventional remote branch on discard, and keeps externally closed worktrees", async () => {
    configure();
    const { hub, forge } = makeHub();
    const task = await hub.createTask(input()); await hub.settled(task.id); await publish(hub, task.id);
    forge.remoteState = "closed"; await hub.pollPullRequests();
    expect(hub.getTask(task.id).workspace).toMatchObject({ state: "active", pr: { state: "closed" } });
    const head = git(task.cwd!, "rev-parse", "HEAD");
    const reopened = await hub.preparePrDraft(task.id);
    expect(reopened).toMatchObject({ published: true, branch: hub.getTask(task.id).workspace!.remoteBranch });
    expect(reopened.commitMessage).toBeUndefined();
    const events = hub.events(task.id);
    const pushes = forge.pushes.length;
    await expect(hub.openPr(task.id, { ...confirmation(reopened), branch: "feat/different-branch" })).rejects.toMatchObject({ status: 409, message: "Published PR branch cannot be changed" });
    expect(hub.events(task.id)).toEqual(events);
    expect(forge.pushes).toHaveLength(pushes);
    expect(hub.isBusy(task.id)).toBe(false);
    await hub.openPr(task.id, { ...confirmation(reopened), commitMessage: "Ignored", title: "Reopen recovery" });
    expect(git(task.cwd!, "rev-parse", "HEAD")).toBe(head);
    await hub.discard(task.id);
    expect(forge.closed).toEqual([11]);
    expect(git(origin, "for-each-ref", "--format=%(refname:short)", "refs/heads")).toBe("main");
    expect(hub.getTask(task.id).workspace!.state).toBe("discarded");
    expect(snapshot()).toEqual(before);
  });

  it("retries PR creation after a push without regenerating metadata or rewriting published history", async () => {
    configure();
    const { hub, forge, author } = makeHub();
    const task = await hub.createTask(input()); await hub.settled(task.id);
    const prepared = await hub.preparePrDraft(task.id);
    forge.failOpen = true; await expect(hub.openPr(task.id, confirmation(prepared))).rejects.toThrow("Forge unavailable");
    expect(hub.events(task.id)).toContainEqual(expect.objectContaining({ type: "turn_result", ok: false, error: "Forge unavailable" }));
    expect(hub.isBusy(task.id)).toBe(false);
    const ws = hub.getTask(task.id).workspace!;
    const first = git(origin, "rev-parse", ws.remoteBranch!);
    forge.failOpen = false; await hub.openPr(task.id, confirmation(prepared));
    expect(author.runs.filter((run) => run.toolsDisabled && !run.systemPrompt?.startsWith("Generate a whole-change"))).toHaveLength(1);
    expect(git(origin, "rev-parse", ws.remoteBranch!)).toBe(first);
  });

  it("prepares exact complete strings without squashing or publishing, then publishes without another agent call", async () => {
    configure();
    const { hub, forge, author, db } = makeHub();
    const task = await hub.createTask(input()); await hub.settled(task.id);
    // Issue capture normally comes from a planning proposal; preserve it as a task option here.
    const current = hub.getTask(task.id);
    current.options.issue = { number: 7, url: "https://github.com/example/team/issues/7" };
    // Persist the fixture through the database rather than relying on in-memory task objects.
    db.update(schema.tasks).set({ options: current.options }).where(eq(schema.tasks.id, task.id)).run();
    const head = git(task.cwd!, "rev-parse", "HEAD");
    const prepared = await hub.preparePrDraft(task.id);
    expect(prepared).toMatchObject({ type: "pr_draft", by: "agent", changeType: "feat", branch: "feat/ACME-84-durable-recovery-status", commitMessage: "feat: Add durable recovery status (ACME-84)", title: "[ACME-84] feat: Add durable recovery status" });
    expect(prepared.body).toContain("[ACME-84](https://example.atlassian.net/browse/ACME-84)");
    expect(prepared.body).toContain("Agent Hub: Written by Claude; reviewed by Codex.");
    expect(prepared.body).toContain("Closes #7");
    expect(hub.events(task.id)).toContainEqual(prepared);
    expect(forge.pushes).toEqual([]); expect(forge.opened).toEqual([]);
    expect(git(task.cwd!, "rev-parse", "HEAD")).toBe(head);
    expect(git(origin, "for-each-ref", "--format=%(refname:short)", "refs/heads")).toBe("main");
    const calls = author.runs.length;
    await hub.openPr(task.id, confirmation(prepared));
    expect(author.runs).toHaveLength(calls);
    expect(forge.opened[0]).toMatchObject({ title: prepared.title, body: prepared.body, ws: { remoteBranch: prepared.branch } });
    expect(git(origin, "log", "-1", "--format=%s", prepared.branch)).toBe(prepared.commitMessage);
    expect(hub.events(task.id).filter((e) => e.type === "pr_draft" && e.by === "user")).toEqual([]);
  });

  it("publishes human edits exactly and records the confirmed values", async () => {
    configure(); const { hub, forge } = makeHub();
    const task = await hub.createTask(input()); await hub.settled(task.id);
    const prepared = await hub.preparePrDraft(task.id);
    const edited = { ...confirmation(prepared), branch: "fix/custom-recovery", commitMessage: "Custom recovery commit\n\nPreserve the complete recovery details.\nInclude the verification results.", title: "Human title", body: "Human body without template sections" + briefingAppendix((await hub.briefing(task.id)).briefing!) };
    await hub.openPr(task.id, edited);
    expect(forge.opened[0]).toMatchObject({ title: edited.title, body: edited.body, ws: { remoteBranch: edited.branch } });
    expect(git(origin, "log", "-1", "--format=%B", edited.branch)).toBe(edited.commitMessage);
    expect(hub.events(task.id).filter((e) => e.type === "pr_draft" && e.by === "user")).toEqual([expect.objectContaining({ type: "pr_draft", by: "user", changeType: prepared.changeType, branch: edited.branch, commitMessage: edited.commitMessage, title: edited.title, body: edited.body })]);
  });

  it("refuses missing confirmation without appending events or reserving the task", async () => {
    configure(); const { hub, forge } = makeHub();
    const task = await hub.createTask(input()); await hub.settled(task.id);
    const events = hub.events(task.id);
    await expect(hub.openPr(task.id)).rejects.toMatchObject({ status: 409, message: "Prepare a PR draft first" });
    expect(hub.events(task.id)).toEqual(events);
    expect(forge.pushes).toEqual([]);
    expect(hub.isBusy(task.id)).toBe(false);
    await publish(hub, task.id);
    expect(forge.opened).toHaveLength(1);
  });

  it.each(["missing", "superseded", "stale"])("refuses a %s draft without appending events or reserving the task", async (reason) => {
    configure(); const { hub, forge } = makeHub();
    const task = await hub.createTask(input()); await hub.settled(task.id);
    const first = await hub.preparePrDraft(task.id);
    let latest = first;
    if (reason === "superseded") { await hub.generateBriefing(task.id, true); latest = await hub.preparePrDraft(task.id); }
    if (reason === "stale") {
      hub.sendMessage(task.id, "Refine recovery"); await hub.settled(task.id);
    }
    const events = hub.events(task.id);
    const invalid = { ...confirmation(first), draftId: reason === "missing" ? "missing-draft" : first.id };
    await expect(hub.openPr(task.id, invalid)).rejects.toMatchObject({ status: 409, message: "The PR draft is out of date; prepare it again" });
    expect(hub.events(task.id)).toEqual(events);
    expect(forge.pushes).toEqual([]);
    expect(hub.isBusy(task.id)).toBe(false);
    if (reason === "stale") latest = await hub.preparePrDraft(task.id);
    await hub.openPr(task.id, confirmation(latest));
    expect(forge.opened).toHaveLength(1);
  });

  it.each([
    { branch: "agent-hub/x" }, { branch: "bad..name" }, { title: "" }, { title: "Multiple\nlines" },
    { title: "x".repeat(257) }, { body: "" }, { body: "bad\0body" }, { body: "x".repeat(100001) },
    { commitMessage: "" }, { commitMessage: "bad\0commit" },
  ].map((values, index) => ({ values, index, message: "branch" in values ? "Invalid PR branch name" : "title" in values ? "Invalid PR title" : "body" in values ? "Invalid PR body" : "Invalid PR commit message" })))("rejects invalid confirmed values before altering history ($index)", async ({ values, message }) => {
    configure(); const { hub, forge } = makeHub();
    const task = await hub.createTask(input()); await hub.settled(task.id);
    const prepared = await hub.preparePrDraft(task.id);
    const head = git(task.cwd!, "rev-parse", "HEAD");
    const events = hub.events(task.id);
    await expect(hub.openPr(task.id, { ...confirmation(prepared), ...values })).rejects.toMatchObject({ status: 409, message });
    expect(git(task.cwd!, "rev-parse", "HEAD")).toBe(head);
    expect(forge.pushes).toEqual([]);
    expect(hub.events(task.id)).toEqual(events);
    expect(hub.isBusy(task.id)).toBe(false);
    await hub.openPr(task.id, confirmation(prepared));
    expect(forge.opened).toHaveLength(1);
  });

  it("publishes only once when confirmations validate concurrently", async () => {
    configure(); const { hub, forge } = makeHub();
    const task = await hub.createTask(input()); await hub.settled(task.id);
    const prepared = await hub.preparePrDraft(task.id);
    const results = await Promise.allSettled([
      hub.openPr(task.id, confirmation(prepared)),
      hub.openPr(task.id, confirmation(prepared)),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(2);
    expect(results.filter((result) => result.status === "rejected")).toEqual([]);
    expect(forge.pushes).toHaveLength(1);
    expect(forge.opened).toHaveLength(1);
    expect(hub.events(task.id).filter((event) => event.type === "turn_result" && !event.ok)).toEqual([]);
    expect(hub.isBusy(task.id)).toBe(false);
  });

  it("strips the change type from slugs and rejects a one-word remainder", async () => {
    configure(); const metadata = { ...draft, type: "fix", slug: "fix-project-condition-summary", body: draft.body.replace("[x] Feature", "[x] Fix") };
    const { hub } = makeHub(new FakeAdapter(authorScript(JSON.stringify(metadata))));
    const task = await hub.createTask(input()); await hub.settled(task.id);
    expect((await hub.preparePrDraft(task.id)).branch).toBe("fix/ACME-84-project-condition-summary");
    expect(() => parsePrDraft(JSON.stringify({ ...metadata, slug: "fix-summary" }))).toThrow("Invalid PR JSON");
  });

  it("exposes draft and confirmation routes with conflict responses", async () => {
    configure(); const { hub } = makeHub();
    const task = await hub.createTask(input()); await hub.settled(task.id);
    const app = createApp(hub, "test-token");
    const post = (suffix: string, body: unknown) => app.request(`/api/tasks/${task.id}/pr${suffix}`, { method: "POST", headers: { authorization: "Bearer test-token", "content-type": "application/json" }, body: JSON.stringify(body) });
    const missing = await post("", {}); expect(missing.status).toBe(409);
    expect(await missing.json()).toEqual({ error: "Prepare a PR draft first" });
    const response = await post("/draft", {}); expect(response.status).toBe(200);
    const prepared = await response.json() as Extract<TaskEvent, { type: "pr_draft" }>;
    expect((await post("", confirmation(prepared))).status).toBe(200);
  });

  it.each([undefined, "ACME-abc", "OTHER-84", "ACME-84\nACME-85"])("rejects missing or invalid tickets (%s) before creating a task or fetching", async (ticket) => {
    configure(); const { hub, forge } = makeHub();
    const oldRef = git(repo, "rev-parse", "origin/main");
    await expect(hub.createTask(input({ ticket }))).rejects.toThrow(/Ticket/);
    expect(hub.listTasks()).toEqual([]); expect(forge.pushes).toEqual([]);
    expect(git(repo, "rev-parse", "origin/main")).toBe(oldRef);
    expect(snapshot()).toEqual(before);
  });

  it("supports optional tickets and editable or explicitly disabled test defaults", async () => {
    configure({ ...settings, ticket: { ...settings.ticket, required: false } });
    const { hub } = makeHub();
    const task = await hub.createTask(input({ ticket: undefined, testCommand: "" })); await hub.settled(task.id);
    expect(task.options.ticket).toBeUndefined(); expect(task.options.testCommand).toBeUndefined();
    expect(hub.events(task.id).filter((event) => event.type === "test_result")).toEqual([]);
    const edited = await hub.createTask(input({ ticket: "ACME-85", testCommand: "git status --short" })); await hub.settled(edited.id);
    expect(edited.options.testCommand).toBe("git status --short");
  });

  it.each(["not json", JSON.stringify({ ...draft, type: "invalid" }), JSON.stringify({ ...draft, slug: "bad;slug" }), JSON.stringify({ ...draft, summary: "Add recovery (ACME-84)" }), JSON.stringify({ ...draft, body: "Missing sections" }), JSON.stringify({ ...draft, body: draft.body.replace("[x] Feature", "[ ] Feature") }), JSON.stringify({ ...draft, body: draft.body.replace("[x] Feature", "[x] Fix") })])("rejects bad author metadata before squash or push: %s", async (metadata) => {
    configure(); const { hub, forge } = makeHub(new FakeAdapter(authorScript(metadata)));
    const task = await hub.createTask(input()); await hub.settled(task.id);
    const head = git(task.cwd!, "rev-parse", "HEAD");
    await expect(hub.preparePrDraft(task.id)).rejects.toThrow(/Invalid PR JSON/);
    expect(forge.pushes).toEqual([]); expect(forge.opened).toEqual([]);
    expect(git(task.cwd!, "rev-parse", "HEAD")).toBe(head);
    expect(git(origin, "for-each-ref", "--format=%(refname:short)", "refs/heads")).toBe("main");
    expect(hub.getTask(task.id).workspace!.remoteBranch).toBeUndefined();
    expect(hub.events(task.id)).toContainEqual(expect.objectContaining({ type: "turn_result", ok: false, error: expect.stringContaining("Invalid PR JSON") }));
    expect(snapshot()).toEqual(before);
  });

  it("rejects a dirty worktree with a replaced template before asking the author or pushing", async () => {
    configure(); const { hub, author, forge } = makeHub();
    const task = await hub.createTask(input()); await hub.settled(task.id);
    const outside = path.join(root, "outside.md"); fs.writeFileSync(outside, "outside");
    const file = path.join(task.cwd!, ".github/PULL_REQUEST_TEMPLATE.md"); fs.unlinkSync(file); fs.symlinkSync(outside, file);
    await expect(hub.preparePrDraft(task.id)).rejects.toThrow(/clean committed/);
    expect(author.runs.filter((run) => run.toolsDisabled)).toHaveLength(0); expect(forge.pushes).toEqual([]);
  });

  it("directly rejects template symlink escape while permitting an in-worktree template target", () => {
    const worktree = path.join(root, "template-worktree"); fs.mkdirSync(worktree);
    const outside = path.join(root, "outside-template.md"); fs.writeFileSync(outside, "Outside template\n");
    const linked = path.join(worktree, "template.md"); fs.symlinkSync(outside, linked);
    expect(() => readPrTemplate(worktree, { prTemplate: "template.md" })).toThrow("prTemplate must stay inside the worktree (including symlinks)");
    fs.unlinkSync(linked); fs.writeFileSync(path.join(worktree, "inside.md"), template); fs.symlinkSync("inside.md", linked);
    expect(readPrTemplate(worktree, { prTemplate: "template.md" })).toBe(template);
  });

  it.each([false, true])("rejects failed or incomplete metadata calls without publishing (incomplete=%s)", async (incomplete) => {
    configure();
    const agent = new FakeAdapter((i, n) => i.toolsDisabled
      ? incomplete ? reply(i, JSON.stringify(draft)).filter((event) => event.type !== "done") : [{ type: "done", ok: false, error: "Metadata failure" }]
      : authorScript()(i, n));
    const { hub, forge } = makeHub(agent);
    const task = await hub.createTask(input()); await hub.settled(task.id);
    await expect(hub.preparePrDraft(task.id)).rejects.toThrow(incomplete ? "ended without a result" : "Metadata failure");
    expect(forge.pushes).toEqual([]);
  });

  it("rejects an invalid conventional branch name before rewriting task history or pushing", async () => {
    configure({ ...settings, branch: "feat/{summary}" });
    const { hub, forge } = makeHub();
    const task = await hub.createTask(input()); await hub.settled(task.id);
    const head = git(task.cwd!, "rev-parse", "HEAD");
    await expect(hub.preparePrDraft(task.id)).rejects.toThrow("Invalid PR branch name");
    expect(forge.pushes).toEqual([]); expect(git(task.cwd!, "rev-parse", "HEAD")).toBe(head);
  });

  it("reserves the author thread during PR preparation and supports stopping without publishing", async () => {
    configure(); const { hub, author, forge } = makeHub();
    const task = await hub.createTask(input()); await hub.settled(task.id);
    author.hold();
    const opening = hub.preparePrDraft(task.id);
    const coalesced = hub.preparePrDraft(task.id);
    void coalesced.catch(() => {});
    await expect(hub.discard(task.id)).rejects.toThrow(/still running/);
    hub.stop(task.id); author.release();
    await expect(opening).rejects.toThrow(/interrupted/); await hub.settled(task.id);
    expect(forge.pushes).toEqual([]); expect(hub.isBusy(task.id)).toBe(false);
  });
});

describe("repository settings validation and API", () => {
  it("reads settings on every request, resolves repository roots, and reports bad configuration clearly", async () => {
    const { hub } = makeHub(); const app = createApp(hub, "test-token");
    const get = (repoPath: string) => app.request(`/api/repo-settings?path=${encodeURIComponent(repoPath)}`, { headers: { authorization: "Bearer test-token" } });
    expect(await (await get(repo)).json()).toBeNull();
    configure(); expect(await (await get(path.join(repo, ".github"))).json()).toEqual(settings);
    configure({ testCommand: "make test" }); expect(await (await get(repo)).json()).toEqual({ testCommand: "make test" });
    fs.writeFileSync(path.join(dataDir, "repos.json"), "{");
    const res = await get(repo); expect(res.status).toBe(400); expect(await res.json()).toMatchObject({ error: expect.stringContaining("Invalid repos.json") });
    await expect(hub.createTask(input())).rejects.toThrow(/Invalid repos.json/);
    expect(hub.listTasks()).toEqual([]); expect(snapshot()).toEqual(before);
  });

  it.each([[], null, { relative: {} }, { "/example/repo": { base: "main" } }, { "/example/repo": { base: "origin/main..bad" } }, { "/example/repo": { base: "origin/main.lock" } }, { "/example/repo": { ticket: { required: true, pattern: "[" } } }, { "/example/repo": { unknown: true } }, { "/example/repo": { prTemplate: "../outside" } }, { "/example/repo": { commit: "{unknown}" } }, { "/example/repo": { branch: "{ticket}/{slug}" } }, { "/example/repo": { prLanguage: "invalid" } }])("validates the whole config even if this repo has no entry (%j)", (value) => {
    fs.writeFileSync(path.join(dataDir, "repos.json"), JSON.stringify(value));
    expect(() => readRepoSettings(dataDir, repo)).toThrow(/Invalid repos.json/);
  });

  it("returns agent defaults through the API without replacing explicit task choices", async () => {
    const agents = { author: { agent: "codex", effort: "high" }, reviewer: { agent: "claude", model: "opus", effort: "medium" } };
    configure({ agents });
    const { hub } = makeHub();
    const app = createApp(hub, "test-token");
    const response = await app.request(`/api/repo-settings?path=${encodeURIComponent(repo)}`, { headers: { authorization: "Bearer test-token" } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ agents });
    configure({ agents: { reviewer: { agent: "unknown" } } });
    const invalid = await app.request(`/api/repo-settings?path=${encodeURIComponent(repo)}`, { headers: { authorization: "Bearer test-token" } });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: expect.stringContaining("agents.reviewer.agent must be codex or claude") });
    configure({ agents });
    const task = await hub.createTask(input({ model: "chosen-author", effort: "low", reviewerModel: "chosen-reviewer", reviewerEffort: "high" }));
    await hub.settled(task.id);
    expect(hub.getTask(task.id).sessions.filter((session) => session.role !== "explainer")).toMatchObject([
      { agent: "claude", model: "chosen-author", effort: "low" },
      { agent: "codex", model: "chosen-reviewer", effort: "high" },
    ]);
  });

  it.each([null, [], "claude", { main: {} }, { author: null }, { reviewer: [] }, { author: { unknown: true } }, { author: { agent: "other" } }, { reviewer: { effort: "ultra" } }, { reviewer: { model: "" } }, { reviewer: { model: "a".repeat(129) } }, { reviewer: { model: "opus\n" } }, { reviewer: { model: "../opus" } }, { reviewer: { model: "$(command)" } }, { reviewer: { model: 42 } }])("rejects invalid agent defaults clearly (%j)", (agents) => {
    configure({ agents });
    expect(() => readRepoSettings(dataDir, repo)).toThrow(/Invalid repos.json: .*agents/);
  });

  it("accepts partial agent defaults and safe model names", () => {
    const agents = { author: { model: "gpt-5.4", effort: "xhigh" }, reviewer: { agent: "claude" } };
    configure({ agents });
    expect(readRepoSettings(dataDir, repo)).toEqual({ agents });
    configure({ agents: { author: {}, reviewer: {} } });
    expect(readRepoSettings(dataDir, repo)?.agents).toEqual({ author: {}, reviewer: {} });
  });

  it("expands home paths and rejects duplicate normalized keys", () => {
    fs.writeFileSync(path.join(dataDir, "repos.json"), JSON.stringify({ "~/example/repo": settings }));
    expect(readRepoSettings(dataDir, path.join(os.homedir(), "example/repo"))).toEqual(settings);
    fs.writeFileSync(path.join(dataDir, "repos.json"), JSON.stringify({ "~/example/repo": settings, [path.join(os.homedir(), "example/repo")]: {} }));
    expect(() => readRepoSettings(dataDir, repo)).toThrow(/duplicate repository path/);
  });

  it("requires strict JSON and inserts the Jira link specifically into Purpose once", () => {
    expect(() => parsePrDraft(`\`\`\`json\n${JSON.stringify(draft)}\n\`\`\``)).toThrow(/JSON object only/);
    const url = "https://example.atlassian.net/browse/ACME-84";
    const original = draft.body + `\n\n[ACME-84](${url})`;
    const linked = withTicketLink(original, "ACME-84", url);
    expect(linked).toContain(`## Purpose\n\n[ACME-84](${url})`);
    expect(withTicketLink(linked, "ACME-84", url)).toBe(linked);
  });
});

describe("project document settings", () => {
  it("normalizes absolute and home-relative directories and rejects invalid values", () => {
    configure({ documentsDir: "/example/project-docs" });
    expect(readRepoSettings(dataDir, repo)).toEqual({ documentsDir: "/example/project-docs" });
    configure({ documentsDir: "~/project-docs" });
    expect(readRepoSettings(dataDir, repo)).toEqual({ documentsDir: path.join(os.homedir(), "project-docs") });
    for (const documentsDir of ["", " ", "relative/docs", "~", "~/docs\nsecret", "/docs\0hidden", 42]) {
      configure({ documentsDir });
      expect(() => readRepoSettings(dataDir, repo)).toThrow(/Invalid repos.json.*documentsDir/);
    }
  });

  it("keeps docs-only coding publication defaults and strips only document configuration", async () => {
    configure({ documentsDir: path.join(root, "not-required-for-coding") });
    const { hub, forge, author } = makeHub();
    const task = await hub.createTask(input({ ticket: undefined })); await hub.settled(task.id);
    expect(task.options.repoSettings).toBeUndefined();
    expect(task.workspace).toMatchObject({ baseRef: before.branch, baseSha: before.head });
    await expect(hub.preparePrDraft(task.id)).rejects.toMatchObject({ status: 409 });
    await hub.openPr(task.id);
    expect(forge.pushes[0]!.remoteBranch).toBeUndefined();
    expect(forge.opened[0]!.title).toBe("Recovery");
    expect(author.runs.filter((run) => !run.systemPrompt?.startsWith("Generate a whole-change"))).toHaveLength(1);
    expect(snapshot()).toEqual(before);
    configure({ ...settings, documentsDir: "/example/project-docs" });
    const explicit = await hub.createTask(input()); await hub.settled(explicit.id);
    expect(explicit.options.repoSettings).toEqual(settings);
    expect(explicit.workspace?.baseRef).toBe("origin/main");
  });
});

describe("managed PR issue relationships", () => {
  const linkedForge = () => Object.assign(new TeamForge(), {
    readIssue: async (_repo: string, number: number) => {
      if (![7, 8].includes(number)) throw new Error("Not a repository issue");
      return { number, url: `https://github.com/example/team/issues/${number}`, title: "Fixture issue", body: "Requirements", state: "open" as const, labels: [], comments: [] };
    },
  });

  it.each(["partial", "complete"] as const)("uses %s deterministically, preserves prose/appendix and survives saved override preparation and restart", async (mode) => {
    configure(); const forge = linkedForge(); const file = path.join(root, "relationships.db");
    const { hub } = makeHub(undefined, forge, file);
    const task = await hub.createTask(input({ issue: 7, issueCompletion: mode })); await hub.settled(task.id);
    const prepared = await hub.preparePrDraft(task.id);
    expect(prepared.issueLink).toMatchObject({ issue: { number: 7 }, issueCompletion: mode });
    expect(prepared.managedIssue).toContain(`${mode === "partial" ? "Refs" : "Closes"} #7`);
    const prose = "Human prose: Closes #55 and Refs #7.\n\n  Preserve spaces.\n";
    const edited = await hub.editPrDraft(task.id, { ...confirmation(prepared), issue: 8, issueCompletion: "partial", title: "Human title", branch: "fix/human-branch", commitMessage: "Human commit\n\nExact details", body: prose + prepared.body });
    expect(edited.body).toContain(prose);
    expect(edited.body).toContain("Refs #8");
    expect(edited.body).not.toContain(prepared.managedIssue!);
    const appendix = briefingAppendix((await hub.briefing(task.id)).briefing!);
    expect(edited.body.endsWith(appendix)).toBe(true);
    expect(hub.getTask(task.id).options.prIssueLink).toEqual(edited.issueLink);
    expect(hub.getTask(task.id).options.issue?.number).toBe(7);
    await expect(hub.openPr(task.id, confirmation(prepared))).rejects.toThrow(/out of date/);
    // Force a new briefing while preserving the original source association and edited main body.
    await hub.generateBriefing(task.id, true);
    const fresh = await hub.preparePrDraft(task.id);
    expect(fresh).toMatchObject({ branch: edited.branch, title: edited.title, commitMessage: edited.commitMessage, issueLink: edited.issueLink, mainBody: edited.mainBody });
    expect(fresh.body.split("<!-- agent-hub:issue -->")).toHaveLength(2);
    await hub.shutdown(100);
    const restarted = makeHub(undefined, forge, file).hub;
    expect(restarted.getTask(task.id).options.prIssueLink).toEqual(edited.issueLink);
    const detached = await restarted.editPrDraft(task.id, { ...confirmation(fresh), issue: null });
    expect(detached.issueLink).toEqual({ issue: null });
    expect(detached.managedIssue).toBeUndefined();
    expect(detached.body).toBe(fresh.body.replace(fresh.managedIssue!, ""));
    expect(detached.body).toContain(prose);
    await expect(restarted.openPr(task.id, confirmation(fresh))).rejects.toThrow(/out of date/);
    await restarted.openPr(task.id, confirmation(detached));
    expect(forge.opened.at(-1)!.body).toBe(detached.body);
    expect(forge.closed).toEqual([]);
    await restarted.shutdown(100);
  });

  it("refuses changed managed text and invalid issue reads without saving or publishing", async () => {
    configure(); const { hub, forge } = makeHub(undefined, linkedForge());
    const task = await hub.createTask(input({ issue: 7 })); await hub.settled(task.id);
    const prepared = await hub.preparePrDraft(task.id);
    for (const command of [
      { ...confirmation(prepared), body: prepared.body.replace("Refs #7", "Closes #55") },
      { ...confirmation(prepared), issue: 8, body: prepared.body.replace("Refs #7", "Closes #55") },
      { ...confirmation(prepared), body: prepared.body.replace(prepared.managedIssue!, "") },
      { ...confirmation(prepared), issue: 999 },
      { ...confirmation(prepared), issue: 0 },
    ]) await expect(hub.editPrDraft(task.id, command)).rejects.toThrow(/managed issue relationship was edited|Not a repository issue|positive integer/);
    expect(hub.events(task.id).filter(e => e.type === "pr_draft")).toEqual([prepared]);
    expect(forge.opened).toEqual([]);
    // Resolve the conflict in the existing editor by matching the structured selection exactly.
    const complete = await hub.editPrDraft(task.id, { ...confirmation(prepared), issueCompletion: "complete", body: prepared.body.replace("Refs #7", "Closes #7") });
    expect(complete.body).toContain("Closes #7"); expect(complete.issueLink?.issueCompletion).toBe("complete");
    await hub.shutdown(100);
  });
});

it.each(["partial", "detach"] as const)("keeps a legacy draft's Closes mode through title edits, then allows explicit %s selection", async (selection) => {
  configure(); const { hub, db } = makeHub();
  const task = await hub.createTask(input()); await hub.settled(task.id);
  const current = hub.getTask(task.id);
  db.update(schema.tasks).set({ options: { ...current.options, issue: { number: 7, url: "https://github.com/example/team/issues/7" } } }).where(eq(schema.tasks.id, task.id)).run();
  const generated = await hub.preparePrDraft(task.id);
  // A pre-feature persisted draft has a plain host suffix and no structured draft metadata.
  const mainBody = generated.mainBody!.replace(generated.managedIssue!, "\n\nCloses #7");
  const legacyBody = generated.body.replace(generated.managedIssue!, "\n\nCloses #7");
  const { id: _id, taskId: _taskId, sessionId: _sessionId, createdAt: _createdAt, seq: _seq, type: _type, issueLink: _link, managedIssue: _managed, ...payload } = generated;
  db.update(schema.events).set({ payload: { ...payload, mainBody, body: legacyBody } }).where(eq(schema.events.id, generated.id)).run();
  const legacy = hub.events(task.id).find(e => e.id === generated.id) as typeof generated;
  await expect(hub.editPrDraft(task.id, { ...confirmation(legacy), issue: null, body: legacy.body.replace("Closes #7", "Closes #55") }))
    .rejects.toThrow(/managed issue relationship was edited/);
  expect(hub.events(task.id).filter(e => e.type === "pr_draft")).toHaveLength(1);
  const titled = await hub.editPrDraft(task.id, { ...confirmation(legacy), title: "Human legacy title" });
  expect(titled.body).toBe(legacy.body); expect(titled.issueLink?.issueCompletion).toBeUndefined();
  expect(titled.managedIssue).toBe("\n\nCloses #7");
  await expect(hub.editPrDraft(task.id, { ...confirmation(titled), issue: null, body: titled.body.replace("Closes #7", "Closes #55") }))
    .rejects.toThrow(/managed issue relationship was edited/);
  if (selection === "detach") {
    // The editor submits the intact legacy suffix for the host to remove, preserving human prose.
    const human = "Human reference: Closes #55.\n\n  Keep this formatting.  \n";
    const detached = await hub.editPrDraft(task.id, { ...confirmation(titled), issue: null, body: human + titled.body });
    expect(detached.issueLink).toEqual({ issue: null });
    expect(detached.body).toBe(human + titled.body.replace(titled.managedIssue!, ""));
    expect(detached.body).toContain("Human reference: Closes #55.");
    expect(detached.body).not.toContain("Closes #7");
    await hub.shutdown(100);
    return;
  }
  // Use the exact saved managed text, as the editor does, rather than inferring a marker block.
  const { managedIssueBlock, updateManagedIssue } = await import("@agent-hub/shared");
  const next = managedIssueBlock({ issue: titled.issueLink!.issue, issueCompletion: "partial" });
  const body = updateManagedIssue(titled.mainBody!, titled.managedIssue, next) + titled.body.slice(titled.mainBody!.length);
  const partial = await hub.editPrDraft(task.id, { ...confirmation(titled), issueCompletion: "partial", body });
  expect(partial.body).toBe(body); expect(partial.issueLink?.issueCompletion).toBe("partial");
  expect(partial.title).toBe("Human legacy title"); expect(partial.body).not.toContain("Closes #7");
  expect(partial.body.split("Refs #7")).toHaveLength(2);
  await hub.shutdown(100);
});

it("rejects an issue edit when source changes during Forge validation of a plain draft", async () => {
  configure(); const { hub, db, forge } = makeHub();
  const task = await hub.createTask(input()); await hub.settled(task.id);
  const generated = await hub.preparePrDraft(task.id);
  const { id: _id, taskId: _taskId, sessionId: _sessionId, createdAt: _createdAt, seq: _seq, type: _type, ...payload } = generated;
  db.update(schema.events).set({ payload: { ...payload, briefingId: undefined, briefingError: "Fixture briefing unavailable", body: generated.mainBody } }).where(eq(schema.events.id, generated.id)).run();
  const plain = hub.events(task.id).find(e => e.id === generated.id) as typeof generated;
  let release!: () => void; let reading = false;
  (forge as Forge).readIssue = async (_repo, number) => {
    reading = true; await new Promise<void>(resolve => { release = resolve; });
    return { number, url: `https://github.com/example/team/issues/${number}`, title: "Issue", state: "open", labels: [], body: "Requirements", comments: [] };
  };
  const saving = hub.editPrDraft(task.id, { ...confirmation(plain), issue: 7 }).then(() => "saved", err => String(err));
  while (!reading) await new Promise(resolve => setTimeout(resolve, 5));
  db.insert(schema.events).values({ id: "new-source", taskId: task.id, sessionId: null, seq: plain.seq + 1, createdAt: new Date().toISOString(), type: "diff_snapshot", payload: { round: 2, filesChanged: 1, additions: 1, deletions: 0 } }).run();
  release(); expect(await saving).toMatch(/source is out of date/);
  expect(hub.events(task.id).filter(e => e.type === "pr_draft")).toHaveLength(1);
  expect(forge.opened).toEqual([]); await hub.shutdown(100);
});

describe("legacy issue relationship confirmation previews", () => {
  async function legacyDraft() {
    configure(); const context = makeHub(); const { hub, db } = context;
    const task = await hub.createTask(input()); await hub.settled(task.id);
    const current = hub.getTask(task.id);
    db.update(schema.tasks).set({ options: { ...current.options, issue: { number: 7, url: "https://github.com/example/team/issues/7" } } }).where(eq(schema.tasks.id, task.id)).run();
    const generated = await hub.preparePrDraft(task.id);
    const mainBody = "Human prose: Refs #55.\n\n" + generated.mainBody!.replace(generated.managedIssue!, "\n\nCloses #7");
    const body = mainBody + generated.body.slice(generated.mainBody!.length);
    const { id: _id, taskId: _taskId, sessionId: _sessionId, createdAt: _createdAt, seq: _seq, type: _type, issueLink: _link, managedIssue: _managed, ...payload } = generated;
    db.update(schema.events).set({ payload: { ...payload, mainBody, body } }).where(eq(schema.events.id, generated.id)).run();
    const draft = hub.events(task.id).find(e => e.id === generated.id) as typeof generated;
    return { ...context, task, draft };
  }

  it.each([false, true])("publishes the exact legacy UI preview when the saved issue is supplied (edited first: %s)", async editedFirst => {
    const { hub, forge, author, task, draft } = await legacyDraft();
    let preview = draft;
    if (editedFirst) {
      preview = await hub.editPrDraft(task.id, { ...confirmation(draft), issue: 7, title: "Human title" });
      await expect(hub.openPr(task.id, { ...confirmation(draft), issue: 7 })).rejects.toThrow(/out of date/);
      expect(forge.pushes).toEqual([]); expect(forge.opened).toEqual([]);
    }
    const calls = author.runs.length;
    // PrDraftCard includes the saved issue even when no selection was edited.
    await hub.openPr(task.id, { ...confirmation(preview), issue: 7, issueCompletion: preview.issueLink?.issueCompletion });
    expect(forge.opened[0]!.body).toBe(preview.body);
    expect(forge.opened[0]!.body).toContain("Human prose: Refs #55.");
    expect(forge.opened[0]!.body).toContain("\n\nCloses #7");
    expect(forge.opened[0]!.body).not.toContain("<!-- agent-hub:issue -->");
    expect(forge.opened[0]!.body.endsWith(briefingAppendix((await hub.briefing(task.id)).briefing!))).toBe(true);
    expect(author.runs.length).toBe(calls);
    await hub.shutdown(100);
  });

  it.each(["edit", "confirm"] as const)("requires a saved preview for a legacy marker conversion through %s", async action => {
    const { hub, forge, task, draft } = await legacyDraft();
    const { managedIssueBlock, updateManagedIssue } = await import("@agent-hub/shared");
    const original = "\n\nCloses #7";
    const issue = { number: 7, url: "https://github.com/example/team/issues/7" };
    const partial = managedIssueBlock({ issue, issueCompletion: "partial" });
    const complete = managedIssueBlock({ issue, issueCompletion: "complete" });
    // Actual editor sequence: change mode to partial, then back to complete before saving.
    const partialMain = updateManagedIssue(draft.mainBody!, original, partial);
    const main = updateManagedIssue(partialMain, partial, complete);
    const body = main + draft.body.slice(draft.mainBody!.length);
    const request = { ...confirmation(draft), issue: 7, issueCompletion: "complete" as const, body };
    if (action === "edit") await hub.editPrDraft(task.id, request);
    else await expect(hub.openPr(task.id, request)).rejects.toThrow(/review the saved edited draft/);
    expect(forge.pushes).toEqual([]); expect(forge.opened).toEqual([]);
    const edited = hub.events(task.id).filter(e => e.type === "pr_draft").at(-1)!;
    expect(edited.body).toBe(body);
    expect(edited.managedIssue).toBe(complete);
    await expect(hub.openPr(task.id, { ...confirmation(draft), issue: 7 })).rejects.toThrow(/out of date/);
    await hub.openPr(task.id, { ...confirmation(edited), issue: 7, issueCompletion: "complete" });
    expect(forge.opened[0]!.body).toBe(body);
    await hub.shutdown(100);
  });

  it("saves a changed relationship as a new preview and rejects its previous confirmation before publishing", async () => {
    const { hub, forge, task, draft } = await legacyDraft();
    await expect(hub.openPr(task.id, { ...confirmation(draft), issue: 7, issueCompletion: "partial" }))
      .rejects.toThrow(/review the saved edited draft/);
    expect(forge.pushes).toEqual([]); expect(forge.opened).toEqual([]);
    const edited = hub.events(task.id).filter(e => e.type === "pr_draft").at(-1)!;
    expect(edited.id).not.toBe(draft.id);
    expect(edited.issueLink).toMatchObject({ issue: { number: 7 }, issueCompletion: "partial" });
    expect(edited.body).toBe(draft.body.replace("\n\nCloses #7", "\n\n<!-- agent-hub:issue -->\nRefs #7\n<!-- /agent-hub:issue -->"));
    await expect(hub.openPr(task.id, { ...confirmation(draft), issue: 7 })).rejects.toThrow(/out of date/);
    await hub.openPr(task.id, { ...confirmation(edited), issue: 7, issueCompletion: "partial" });
    expect(forge.opened[0]!.body).toBe(edited.body);
    await hub.shutdown(100);
  });
});

it.each(["plan", "implement", "review"] as const)("snapshots rule packs for %s and keeps prompts after restart", async workflow => {
  const packFile = path.join(dataDir, "rules/example.md");
  fs.mkdirSync(path.dirname(packFile));
  const pack = "---\ntag: example\nparams: [docsRoot]\nroles: [author, reviewer, planner]\n---\n# Invented example\nIntro\n## Mandatory\n- ex-1 Use {docsRoot}.\n## Reference\nPrivate background\n";
  fs.writeFileSync(packFile, pack);
  const rules: Record<string, Record<string, string>> = { example: { docsRoot: "/example/docs" } };
  for (const role of ["author", "reviewer", "planner"]) {
    fs.writeFileSync(path.join(dataDir, `rules/${role}.md`), `---\ntag: ${role}\nparams: []\nroles: [${role}]\n---\n# ${role} only\n## Mandatory\n${role} exclusive rule`);
    rules[role] = {};
  }
  configure({ rules });
  const file = path.join(dataDir, "snapshot.db");
  const author = workflow === "plan" ? new FakeAdapter(i => reply(i, "Plan ready")) : undefined;
  const { hub, author: adapter, reviewer } = makeHub(author, undefined, file);
  const task = await hub.createTask(input({ workflow })); await hub.settled(task.id);
  const applied = hub.getTask(task.id).options.appliedRules;
  expect(applied).toHaveLength(4);
  expect(applied!.map(pack => pack.tag)).toEqual(["author", "example", "planner", "reviewer"]);
  expect(applied![1]).toMatchObject({ tag: "example", text: "# Invented example\nIntro\n\n## Mandatory\n- ex-1 Use /example/docs." });
  const first = adapter.runs.find(r => !r.toolsDisabled)!;
  expect(first.systemPrompt).toContain(applied![1]!.text);
  expect(first.systemPrompt).not.toContain("Private background");
  const expectedRole = workflow === "plan" ? "planner" : "author";
  for (const role of ["author", "reviewer", "planner"]) {
    expect(first.systemPrompt!.includes(`${role} exclusive rule`)).toBe(role === expectedRole);
    if (workflow === "review") expect(reviewer.runs[0]!.systemPrompt!.includes(`${role} exclusive rule`)).toBe(role === "reviewer");
  }
  if (workflow === "review") expect(reviewer.runs[0]!.systemPrompt).toContain(applied![1]!.text);
  await hub.shutdown(100);
  fs.writeFileSync(packFile, "Invalid edited content");
  const resumed = new FakeAdapter(i => reply(i, "Resumed"));
  const restarted = makeHub(resumed, undefined, file).hub;
  expect(restarted.getTask(task.id).options.appliedRules).toEqual(applied);
  await restarted.sendMessage(task.id, "Continue"); await restarted.settled(task.id);
  expect(resumed.runs[0]!.systemPrompt).toContain(applied![1]!.text);
  fs.writeFileSync(packFile, pack.replace("Use {docsRoot}", "Updated {docsRoot}"));
  const fresh = await restarted.createTask(input({ workflow })); await restarted.settled(fresh.id);
  expect(fresh.options.appliedRules![1]!.sha256).not.toBe(applied![1]!.sha256);
  expect(fresh.options.appliedRules![1]!.text).toContain("Updated /example/docs");
  expect(restarted.getTask(task.id).options.appliedRules).toEqual(applied);
  await restarted.shutdown(100);
});

it.each([{}, { docsRoot: "/example/docs" }])("rejects pack resolution with HTTP 400 without creating tasks or worktrees: %j", async params => {
  const { hub } = makeHub();
  fs.mkdirSync(path.join(dataDir, "rules"));
  fs.writeFileSync(path.join(dataDir, "rules/example.md"), "---\ntag: example\nparams: [docsRoot]\nroles: [author]\n---\n## Mandatory\nex-1 Example");
  if (Object.keys(params).length) fs.unlinkSync(path.join(dataDir, "rules/example.md"));
  configure({ rules: { example: params } });
  const app = createApp(hub, "test-token");
  const response = await app.request("/api/tasks", { method: "POST", headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" }, body: JSON.stringify(input()) });
  expect(response.status).toBe(400);
  expect(await response.text()).toContain(`${repo}: rules example:`);
  expect(hub.listTasks()).toEqual([]);
  expect(fs.existsSync(path.join(dataDir, "worktrees"))).toBe(false);
  await hub.shutdown(100);
});

it.each(["plan", "implement", "review"] as const)("preserves system prompts and option shape without rules for %s", async workflow => {
  const author = workflow === "plan" ? new FakeAdapter(i => reply(i, "Plan ready")) : undefined;
  const { hub, author: adapter, reviewer } = makeHub(author);
  const task = await hub.createTask(input({ workflow })); await hub.settled(task.id);
  expect(task.options).not.toHaveProperty("appliedRules");
  expect(task.options).not.toHaveProperty("repoSettings");
  expect(adapter.runs.find(r => !r.toolsDisabled)!.systemPrompt).toBe((workflow === "plan" ? PLANNER_SYSTEM : SYSTEM_APPEND + worktreeNote(task.workspace!)) + SCOPE_GUIDANCE);
  if (workflow === "review") expect(reviewer.runs[0]!.systemPrompt).toBe(REVIEWER_SYSTEM + SCOPE_GUIDANCE);
  await hub.shutdown(100);
});

it("does not snapshot or inject configured rules into chat or video", async () => {
  fs.mkdirSync(path.join(dataDir, "rules"));
  fs.writeFileSync(path.join(dataDir, "rules/example.md"), "---\ntag: example\nparams: []\nroles: [author, reviewer, planner]\n---\n# Example\n## Mandatory\nex-1 Invented rule");
  configure({ rules: { example: {} } });
  const { hub, author } = makeHub(new FakeAdapter(i => reply(i, "Hello")));
  const chat = await hub.createTask(input({ workflow: "chat" })); await hub.settled(chat.id);
  expect(chat.options).not.toHaveProperty("appliedRules");
  expect(chat.options).not.toHaveProperty("repoSettings");
  expect(author.runs[0]!.systemPrompt).toBe(SYSTEM_APPEND);
  const download = vi.spyOn(media, "fetchVideoTranscript").mockResolvedValue({
    meta: { id: "example", title: "Example", uploader: null, duration: null, url: "https://example.invalid/video", extractor: "fixture", language: null, subtitles: [], autoCaptions: [] },
    source: "subtitles", segments: [], markdown: "Invented transcript",
  });
  const video = await hub.createTask(input({ workflow: "video", message: "https://example.invalid/video" })); await hub.settled(video.id);
  download.mockRestore();
  expect(author.runs.at(-1)!.systemPrompt).toBe(SYSTEM_APPEND);
  expect(video.options).not.toHaveProperty("appliedRules");
  expect(video.options).not.toHaveProperty("repoSettings");
  await hub.shutdown(100);
});

it.each([
  ["invalid frontmatter", "invalid or missing frontmatter"],
  ["missing file", "pack file is missing or unreadable"],
])("isolates a repository's %s from settings reads, chat and other repositories", async (problem, message) => {
  const repositoryA = repo;
  const repositoryB = upstream;
  fs.mkdirSync(path.join(dataDir, "rules"));
  if (problem === "invalid frontmatter") fs.writeFileSync(path.join(dataDir, "rules/broken.md"), "Invalid pack frontmatter");
  fs.writeFileSync(path.join(dataDir, "rules/healthy.md"), "---\ntag: healthy\nparams: []\nroles: [author, reviewer]\n---\n# Healthy example\n## Mandatory\nhe-1 Invented healthy rule");
  const settingsA = { rules: { broken: {} } };
  const settingsB = { rules: { healthy: {} } };
  fs.writeFileSync(path.join(dataDir, "repos.json"), JSON.stringify({ [repositoryA]: settingsA, [repositoryB]: settingsB }));
  const script = authorScript();
  const { hub, author, reviewer } = makeHub(new FakeAdapter((i, n) => i.cwd === repositoryA ? reply(i, "Chat ready") : script(i, n)));
  try {
    const app = createApp(hub, "test-token");
    const headers = { authorization: "Bearer test-token", "content-type": "application/json" };
    for (const [repository, expected] of [[repositoryA, settingsA], [repositoryB, settingsB]] as const) {
      const response = await app.request(`/api/repo-settings?path=${encodeURIComponent(repository)}`, { headers });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(expected);
    }
    for (const workflow of ["plan", "implement", "review"] as const) {
      const response = await app.request("/api/tasks", { method: "POST", headers, body: JSON.stringify(input({ workflow, repoPath: repositoryA })) });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: `${repositoryA}: rules broken: ${message}` });
      expect(hub.listTasks()).toEqual([]);
      expect(fs.existsSync(path.join(dataDir, "worktrees"))).toBe(false);
      expect(author.runs).toEqual([]);
      expect(reviewer.runs).toEqual([]);
    }
    const chatResponse = await app.request("/api/tasks", { method: "POST", headers, body: JSON.stringify(input({ workflow: "chat", repoPath: repositoryA })) });
    expect(chatResponse.status).toBe(201);
    const chat = await chatResponse.json() as { id: string };
    await hub.settled(chat.id);
    expect(hub.events(chat.id)).toContainEqual(expect.objectContaining({ type: "turn_result", ok: true }));
    expect(hub.getTask(chat.id).options).not.toHaveProperty("appliedRules");
    expect(author.runs[0]!.systemPrompt).toBe(SYSTEM_APPEND);

    const reviewResponse = await app.request("/api/tasks", { method: "POST", headers, body: JSON.stringify(input({ workflow: "review", repoPath: repositoryB })) });
    expect(reviewResponse.status).toBe(201);
    const review = await reviewResponse.json() as { id: string };
    await hub.settled(review.id);
    expect(hub.events(review.id)).toContainEqual(expect.objectContaining({ type: "review_result", verdict: "approve" }));
    expect(hub.getTask(review.id).options.appliedRules?.map(pack => pack.tag)).toEqual(["healthy"]);
    expect(author.runs.find(run => run.cwd !== repositoryA && !run.toolsDisabled)!.systemPrompt).toContain("he-1 Invented healthy rule");
    expect(reviewer.runs[0]!.systemPrompt).toContain("he-1 Invented healthy rule");
  } finally {
    await hub.shutdown(100);
  }
});
