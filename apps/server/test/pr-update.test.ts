import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrRevision, PrUpdate, Workspace } from "@agent-hub/shared";
import { FakeAdapter, type FakeStep } from "../src/agents/fake";
import { Hub } from "../src/core/hub";
import { lastPrUpdate } from "../src/core/pr-update";
import { completeUpdateMerge } from "../src/workspace/git";
import { schema } from "../src/db/index";
import { eq } from "drizzle-orm";
import { openDb } from "../src/db/index";
import type { Forge } from "../src/workspace/forge";
import { createApp } from "../src/app";
import { briefingFixture } from "./briefing-fixture";

const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
let root: string, repo: string, remote: string;
let hubs: Hub[];
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "hub-pr-update-"));
  repo = path.join(root, "repo"); remote = path.join(root, "remote.git");
  fs.mkdirSync(repo);
  sh(repo, "init", "-q", "-b", "release");
  sh(repo, "config", "user.name", "Test"); sh(repo, "config", "user.email", "test@example.invalid");
  fs.writeFileSync(path.join(repo, "file.txt"), "original\n");
  sh(repo, "add", "."); sh(repo, "commit", "-qm", "initial");
  sh(root, "init", "--bare", "-q", remote);
  sh(repo, "remote", "add", "origin", remote); sh(repo, "push", "-q", "origin", "release");
  hubs = [];
});
afterEach(async () => { await Promise.all(hubs.map(h => h.shutdown())); fs.rmSync(root, { recursive: true, force: true }); });

class LocalForge implements Forge {
  pushes: string[] = [];
  opened = 0;
  stateValue: "open" | "closed" | "merged" = "open";
  mergeable: "CONFLICTING" | "MERGEABLE" | "UNKNOWN" = "UNKNOWN";
  target = "release";
  reject = false;
  afterInspect?: () => void;
  uncertain = false;
  inspectError = false;
  async repoOf() { return "example/repo"; }
  async listIssues() { return []; }
  async readIssue(): Promise<never> { throw new Error("Not found"); }
  async state() { return this.stateValue; }
  async close() {}
  async openPullRequest() { this.opened++; return { number: 41, url: "https://github.com/example/repo/pull/41", state: "open" as const }; }
  async inspectPullRequest(): Promise<PrRevision & { state: "open" | "closed" | "merged"; mergeable: "CONFLICTING" | "MERGEABLE" | "UNKNOWN" }> {
    if (this.inspectError) throw new Error("Inspection unavailable");
    const value = { head: this.branch!, headSha: sh(remote, "rev-parse", `refs/heads/${this.branch}`), target: this.target,
      targetSha: sh(remote, "rev-parse", `refs/heads/${this.target}`), crossRepository: false, state: this.stateValue, mergeable: this.mergeable };
    this.afterInspect?.();
    return value;
  }
  branch?: string;
  async push(ws: Workspace, options?: { signal: AbortSignal; sha: string }) {
    if (this.reject) throw new Error("Normal push rejected");
    if (options?.signal.aborted) throw new Error("Stopped");
    this.branch = ws.remoteBranch ?? ws.branch;
    const sha = options?.sha ?? sh(ws.worktreePath, "rev-parse", "HEAD");
    sh(ws.worktreePath, "push", "origin", `${sha}:refs/heads/${this.branch}`);
    this.pushes.push(sha);
    if (this.uncertain) throw new Error("Push outcome uncertain");
  }
}
async function fixture(testCommand?: string, conflict = false, verdict = "approve", resolution = "integrated\n") {
  const forge = new LocalForge();
  const author = new FakeAdapter((i) => briefingFixture(i) ?? (i.toolsDisabled ? [{ type: "text_delta", text: '{"hunks":[]}' }, { type: "done", ok: true }] : [
    { type: "write", path: conflict ? "file.txt" : "task.txt", content: i.prompt.includes("Resolve only") ? resolution : "task\n" },
    { type: "text_delta", text: "Implemented" }, { type: "done", ok: true },
  ]));
  const reviewer = new FakeAdapter(() => [{ type: "text_delta", text: `VERDICT: ${verdict}\nFINDINGS: none` }, { type: "done", ok: true }]);
  const db = openDb(":memory:");
  const options = { db, dataDir: path.join(root, "data"), maxConcurrent: 3, flushMs: 1, forge, agents: { codex: author, claude: reviewer } };
  const hub = new Hub(options); hubs.push(hub);
  const task = await hub.createTask({ title: "Task", workflow: "implement", agent: "codex", repoPath: repo, message: "Original requirements: add task change only", testCommand });
  await hub.settled(task.id); await hub.openPr(task.id);
  const ws = hub.getTask(task.id).workspace!;
  fs.writeFileSync(path.join(repo, conflict ? "file.txt" : "upstream.txt"), "upstream\n");
  sh(repo, "add", "."); sh(repo, "commit", "-qm", "advance release"); sh(repo, "push", "-q", "origin", "release");
  forge.mergeable = conflict ? "CONFLICTING" : "MERGEABLE";
  await hub.pollPullRequests();
  return { hub, options, forge, author, reviewer, id: task.id, ws, revision: hub.getTask(task.id).workspace!.pr!.revision! };
}

async function finishUpdate(hub: Hub, taskId: string, revision: PrRevision): Promise<PrUpdate> {
  const started = hub.updatePr(taskId, revision);
  await hub.settled(taskId);
  const result = lastPrUpdate(hub.events(taskId))!;
  expect(result.id).toBe(started.id);
  return result;
}

describe("explicit existing PR updates", () => {
  it.each([undefined, "git diff --check"])("merges the actual non-main target, tests %s, publishes once and is then a no-op", async (command) => {
    const f = await fixture(command);
    const calls = f.author.runs.length;
    const result = await finishUpdate(f.hub, f.id, f.revision);
    expect(result).toMatchObject({ stage: "succeeded", tests: command ? "passed" : "none", publication: "published", owned: false });
    expect(f.forge.pushes).toHaveLength(2);
    expect(f.author.runs).toHaveLength(calls); expect(f.reviewer.runs).toHaveLength(0);
    expect(sh(f.ws.worktreePath, "rev-list", "--parents", "-n", "1", "HEAD").split(" ")).toHaveLength(3);
    expect(sh(f.ws.worktreePath, "merge-base", "--is-ancestor", f.revision.headSha, "HEAD")).toBe("");
    expect(f.hub.getTask(f.id).workspace!.baseSha).toBe(f.revision.targetSha);
    expect((await f.hub.diff(f.id)).map(x => x.path)).toEqual(["task.txt"]);
    await f.hub.pollPullRequests();
    expect((await finishUpdate(f.hub, f.id, f.hub.getTask(f.id).workspace!.pr!.revision!)).stage).toBe("noop");
    expect(f.forge.pushes).toHaveLength(2); expect(f.forge.opened).toBe(1);
  });

  it("keeps a failed clean integration for explicit retry and blocks ordinary snapshots", async () => {
    const f = await fixture("test ! -f upstream.txt");
    const result = await finishUpdate(f.hub, f.id, f.revision);
    expect(result).toMatchObject({ stage: "failed", tests: "failed", owned: true });
    expect(f.forge.pushes).toHaveLength(1);
    expect(() => f.hub.sendMessage(f.id, "continue")).toThrow(/Retained PR update/);
    const first = sh(f.ws.worktreePath, "rev-parse", "HEAD");
    const again = await finishUpdate(f.hub, f.id, f.revision);
    expect(again.stage).toBe("failed"); expect(sh(f.ws.worktreePath, "rev-parse", "HEAD")).toBe(first);
    expect(f.author.runs.filter(r => !r.toolsDisabled)).toHaveLength(1);
  });

  it("resolves conflicts under original scope, obtains a reviewer for implement tasks and never pushes snapshots", async () => {
    const f = await fixture("git diff --check", true);
    const result = await finishUpdate(f.hub, f.id, f.revision);
    expect(result).toMatchObject({ stage: "succeeded", conflicted: true, tests: "passed" });
    expect(result.validationOperationId).toBe(result.id);
    expect(result.reviewedSha).toBe(result.resultSha); expect(result.validatedSha).toBe(result.resultSha);
    expect(f.author.runs.at(-1)!.prompt).toContain("Original requirements");
    expect(f.reviewer.runs.at(-1)!.readOnly).toBe(true);
    expect(f.reviewer.runs.at(-1)!.prompt).toContain("directly necessary integration");
    expect(f.forge.pushes).toHaveLength(2);
  });

  it("completes and reviews an unchanged-tree conflict resolution before the same-PR push", async () => {
    const f = await fixture(undefined, true, "approve", "task\n");
    const result = await finishUpdate(f.hub, f.id, f.revision);
    expect(result).toMatchObject({ stage: "succeeded", conflicted: true, tests: "none" });
    expect(sh(f.ws.worktreePath, "rev-parse", "HEAD^{tree}")).toBe(sh(f.ws.worktreePath, "rev-parse", `${f.revision.headSha}^{tree}`));
    expect(sh(f.ws.worktreePath, "rev-list", "--parents", "-n", "1", "HEAD").split(" ")).toHaveLength(3);
    expect(f.reviewer.runs).toHaveLength(1); expect(f.forge.pushes).toHaveLength(2);
  });

  it("stops after review rejection, retaining the merge without publishing", async () => {
    const f = await fixture(undefined, true, "changes");
    const result = await finishUpdate(f.hub, f.id, f.revision);
    expect(result.stage).toBe("failed"); expect(result.error).toMatch(/review rejected/);
    expect(f.reviewer.runs).toHaveLength(3); expect(f.forge.pushes).toHaveLength(1);
  });

  it("refuses unresolved markers and retains the owned merge", async () => {
    const f = await fixture(undefined, true);
    // The resolution script starts with a write step, which never yields, so hold after the first
    // yielded event and stop only once the owned merge exists and the author is resolving it.
    f.author.hold(1);
    const running = finishUpdate(f.hub, f.id, f.revision);
    await vi.waitFor(() => expect(lastPrUpdate(f.hub.events(f.id))?.stage).toBe("resolving"));
    await vi.waitFor(() => expect(f.author.runs.at(-1)!.prompt).toContain("Resolve only"));
    f.hub.stop(f.id); f.author.release();
    const result = await running;
    expect(result.stage).toBe("interrupted"); expect(f.forge.pushes).toHaveLength(1);
    expect(result.owned).toBe(true);
    expect(() => f.hub.sendMessage(f.id, "continue")).toThrow(/Retained/);
  });

  it("rejects duplicate/busy requests and preserves Stop", async () => {
    const f = await fixture("sleep 1");
    const running = finishUpdate(f.hub, f.id, f.revision);
    expect(() => f.hub.updatePr(f.id, f.revision)).toThrow(/still running/);
    f.hub.stop(f.id);
    expect((await running).stage).toBe("interrupted"); expect(f.forge.pushes).toHaveLength(1);
  });

  it("refuses remote changes, dirty worktrees and normal push rejection", async () => {
    const f = await fixture();
    fs.writeFileSync(path.join(f.ws.worktreePath, "unrelated"), "dirty");
    expect((await finishUpdate(f.hub, f.id, f.revision)).error).toMatch(/clean/);
    fs.unlinkSync(path.join(f.ws.worktreePath, "unrelated"));
    f.forge.stateValue = "closed";
    expect((await finishUpdate(f.hub, f.id, f.revision)).error).toMatch(/changed/);
    f.forge.stateValue = "open";
    f.forge.reject = true;
    expect((await finishUpdate(f.hub, f.id, f.revision)).error).toMatch(/push rejected/);
    expect(f.forge.pushes).toHaveLength(1);
    f.forge.reject = false;
    expect((await finishUpdate(f.hub, f.id, f.revision)).stage).toBe("succeeded");
    expect(f.forge.pushes).toHaveLength(2);
  });

  it("persists only explicit conflict transitions and deduplicates polling/restart", async () => {
    const f = await fixture();
    expect(f.hub.events(f.id).filter(e => e.type === "pr_conflict")).toHaveLength(0);
    f.forge.mergeable = "CONFLICTING";
    await f.hub.pollPullRequests(); await f.hub.pollPullRequests();
    expect(f.hub.events(f.id).filter(e => e.type === "pr_conflict")).toHaveLength(1);
    f.hub.recoverInterrupted(); await f.hub.pollPullRequests();
    expect(f.hub.events(f.id).filter(e => e.type === "pr_conflict")).toHaveLength(1);
    f.forge.mergeable = "UNKNOWN"; await f.hub.pollPullRequests();
    expect(f.hub.events(f.id).filter(e => e.type === "pr_conflict")).toHaveLength(1);
    f.forge.mergeable = "MERGEABLE"; await f.hub.pollPullRequests();
    expect(f.hub.events(f.id).filter(e => e.type === "pr_conflict").at(-1)).toMatchObject({ state: "resolved" });
  });

  it.each(["target", "head", "closed", "merged"])("refuses %s changes between validation and publication", async (change) => {
    const f = await fixture();
    let reads = 0;
    const original = f.forge.inspectPullRequest.bind(f.forge);
    f.forge.inspectPullRequest = async () => {
      const result = await original();
      if (++reads === 2) {
        if (change === "target") result.target = "different-target";
        if (change === "head") result.headSha = "a".repeat(40);
        if (change === "closed" || change === "merged") result.state = change;
      }
      return result;
    };
    const result = await finishUpdate(f.hub, f.id, f.revision);
    expect(result).toMatchObject({ stage: "failed", owned: true });
    expect(result.error).toMatch(/source or target changed/);
    expect(f.forge.pushes).toHaveLength(1);
  });

  it("rejects test-side edits even when the test exits successfully", async () => {
    const f = await fixture("test ! -f upstream.txt || echo unexpected >> task.txt");
    const result = await finishUpdate(f.hub, f.id, f.revision);
    expect(result.error).toMatch(/changed during validation/);
    expect(result.validatedSha).toBeUndefined(); expect(f.forge.pushes).toHaveLength(1);
  });

  it("rejects externally published edits and unrelated local merge state", async () => {
    const f = await fixture();
    const external = sh(repo, "commit-tree", "HEAD^{tree}", "-p", f.revision.headSha, "-m", "external update");
    sh(repo, "push", "origin", `${external}:refs/heads/${f.ws.branch}`);
    await f.hub.pollPullRequests();
    const result = await finishUpdate(f.hub, f.id, f.hub.getTask(f.id).workspace!.pr!.revision!);
    expect(result.stage).toBe("failed"); expect(f.forge.pushes).toHaveLength(1);
    sh(f.ws.worktreePath, "fetch", "origin");
    sh(f.ws.worktreePath, "merge", "--no-ff", "--no-commit", "origin/release");
    expect((await finishUpdate(f.hub, f.id, f.revision)).error).toMatch(/Unrelated merge/);
  });

  it("records changed observations and does not treat inspection errors as conflicts", async () => {
    const f = await fixture(undefined, true);
    fs.writeFileSync(path.join(repo, "another.txt"), "more upstream\n");
    sh(repo, "add", "."); sh(repo, "commit", "-qm", "advance again"); sh(repo, "push", "-q", "origin", "release");
    await f.hub.pollPullRequests(); await f.hub.pollPullRequests();
    expect(f.hub.events(f.id).filter(e => e.type === "pr_conflict").map(e => e.state)).toEqual(["conflicting", "changed", "conflicting"]);
    f.forge.inspectError = true; await f.hub.pollPullRequests();
    expect(f.hub.events(f.id).filter(e => e.type === "pr_conflict")).toHaveLength(3);
  });

  it("preserves unresolved markers, requires review approval, and stops for scope decisions", async () => {
    const f = await fixture(undefined, true);
    const noResolution: FakeStep[] = [{ type: "text_delta", text: "done" }, { type: "done", ok: true }];
    const adapter = new FakeAdapter(() => noResolution);
    f.options.agents.codex = adapter;
    const result = await finishUpdate(f.hub, f.id, f.revision);
    expect(result.error).toMatch(/Unresolved conflict/);
    expect(sh(f.ws.worktreePath, "ls-files", "-u")).not.toBe("");
    noResolution[0] = { type: "text_delta", text: "INTEGRATION_BLOCKED: requires a requirement change" };
    expect((await finishUpdate(f.hub, f.id, f.revision)).error).toMatch(/user decision/);
    expect(f.forge.pushes).toHaveLength(1);
  });

  it("does not publish conflicted integrations on missing review or failing tests", async () => {
    const f = await fixture("test ! -f upstream.txt", true);
    f.options.agents.claude = new FakeAdapter(() => [{ type: "text_delta", text: "No verdict" }, { type: "done", ok: true }]);
    expect((await finishUpdate(f.hub, f.id, f.revision)).error).toMatch(/approval is missing/);
    f.options.agents.claude = f.reviewer;
    // The existing test command succeeds on the original tree and fails on the integrated resolution.
    f.options.db.update(schema.tasks).set({ options: { ...f.hub.getTask(f.id).options, testCommand: "test \"$(cat file.txt)\" != integrated" } }).where(eq(schema.tasks.id, f.id)).run();
    expect((await finishUpdate(f.hub, f.id, f.revision)).error).toMatch(/tests failed/);
    expect(f.forge.pushes).toHaveLength(1);
  });

  it("retains progress across restart without running agents, and retries the completed merge safely", async () => {
    const f = await fixture("test ! -f upstream.txt");
    await finishUpdate(f.hub, f.id, f.revision);
    const progress = lastPrUpdate(f.hub.events(f.id))!;
    const sha = sh(f.ws.worktreePath, "rev-parse", "HEAD");
    const event = f.hub.events(f.id).filter(e => e.type === "pr_update").at(-1)!;
    f.options.db.update(schema.events).set({ payload: { update: { ...progress, stage: "merged" } } }).where(eq(schema.events.id, event.id)).run();
    await f.hub.shutdown();
    const restarted = new Hub(f.options); hubs.push(restarted);
    restarted.recoverInterrupted(); await restarted.settled(f.id);
    expect(lastPrUpdate(restarted.events(f.id))).toMatchObject({ stage: "interrupted", owned: true });
    expect(f.forge.pushes).toHaveLength(1);
    expect(sh(f.ws.worktreePath, "rev-parse", "HEAD")).toBe(sha);
    const retried = await finishUpdate(restarted, f.id, f.revision);
    expect(retried.stage).toBe("failed"); expect(retried.tests).toBe("failed");
    expect(sh(f.ws.worktreePath, "rev-parse", "HEAD")).toBe(sha);
  });

  it("reconciles an accepted push after an uncertain outcome without pushing again", async () => {
    const f = await fixture("git diff --check");
    f.forge.uncertain = true;
    const uncertain = await finishUpdate(f.hub, f.id, f.revision);
    expect(uncertain).toMatchObject({ stage: "failed", publication: "uncertain", owned: true });
    expect(f.forge.pushes).toHaveLength(2);
    await f.hub.pollPullRequests();
    const revision = f.hub.getTask(f.id).workspace!.pr!.revision!;
    const result = await finishUpdate(f.hub, f.id, revision);
    expect(result).toMatchObject({ stage: "succeeded", publication: "published", owned: false, tests: "passed", validationOperationId: uncertain.id });
    expect(f.forge.pushes).toHaveLength(2);
  });

  it("retains local resolutions if the existing PR merges externally", async () => {
    const f = await fixture("test ! -f upstream.txt");
    await finishUpdate(f.hub, f.id, f.revision);
    f.forge.stateValue = "merged"; await f.hub.pollPullRequests();
    expect(fs.existsSync(f.ws.worktreePath)).toBe(true);
    expect(f.hub.getTask(f.id).workspace!.state).toBe("active");
    expect(f.hub.getTask(f.id).workspace!.pr!.state).toBe("merged");
  });

  it("stops during author resolution and requires an explicit retry", async () => {
    const f = await fixture(undefined, true);
    f.author.hold(1);
    const running = finishUpdate(f.hub, f.id, f.revision);
    await vi.waitFor(() => expect(lastPrUpdate(f.hub.events(f.id))?.stage).toBe("resolving"));
    await vi.waitFor(() => expect(f.author.runs.at(-1)!.prompt).toContain("Resolve only"));
    f.hub.stop(f.id); f.author.release();
    expect((await running).stage).toBe("interrupted");
    expect(f.forge.pushes).toHaveLength(1);
    expect((await finishUpdate(f.hub, f.id, f.revision)).stage).toBe("succeeded");
  });

  it("recognizes an unrecorded completed merge only by its exact owned parents", async () => {
    const f = await fixture("test ! -f upstream.txt");
    await finishUpdate(f.hub, f.id, f.revision);
    const op = lastPrUpdate(f.hub.events(f.id))!;
    const ev = f.hub.events(f.id).filter(e => e.type === "pr_update").at(-1)!;
    f.options.db.update(schema.events).set({ payload: { update: { ...op, resultSha: undefined, stage: "interrupted" } } }).where(eq(schema.events.id, ev.id)).run();
    expect((await finishUpdate(f.hub, f.id, f.revision)).error).toMatch(/tests failed/);
    const previous = lastPrUpdate(f.hub.events(f.id))!;
    const last = f.hub.events(f.id).filter(e => e.type === "pr_update").at(-1)!;
    f.options.db.update(schema.events).set({ payload: { update: { ...previous, resultSha: undefined } } }).where(eq(schema.events.id, last.id)).run();
    fs.writeFileSync(path.join(f.ws.worktreePath, "external.txt"), "external\n");
    sh(f.ws.worktreePath, "add", "."); sh(f.ws.worktreePath, "commit", "-qm", "unrelated commit");
    expect((await finishUpdate(f.hub, f.id, f.revision)).error).toMatch(/Unrecorded local commits/);
  });

  it.each(["claude", "codex"] as const)("selects the configured %s integration reviewer without applying another adapter's model default", async (agent) => {
    const f = await fixture(undefined, true);
    f.options.db.update(schema.tasks).set({ options: { ...f.hub.getTask(f.id).options, repoSettings: { agents: { reviewer: { agent } } } } }).where(eq(schema.tasks.id, f.id)).run();
    const result = await finishUpdate(f.hub, f.id, f.revision);
    const reviewer = f.hub.getTask(f.id).sessions.find(s => s.role === "reviewer")!;
    expect(reviewer).toMatchObject({ agent, model: agent === "claude" ? "sonnet" : null, effort: "medium" });
    if (agent === "claude") expect(result.stage).toBe("succeeded");
    else expect(result.stage).toBe("failed");
  });

  it("counts updates against the shared concurrency limit", async () => {
    const f = await fixture();
    f.options.maxConcurrent = 0;
    expect(() => f.hub.updatePr(f.id, f.revision)).toThrow(/execution slots are busy/);
    expect(lastPrUpdate(f.hub.events(f.id))).toBeUndefined();
    expect(f.forge.pushes).toHaveLength(1);
  });

  it("stops a reviewer without publishing and preserves unexpected reviewer writes", async () => {
    const f = await fixture(undefined, true);
    f.reviewer.hold(0);
    const running = finishUpdate(f.hub, f.id, f.revision);
    await vi.waitFor(() => expect(f.reviewer.runs).toHaveLength(1));
    f.hub.stop(f.id); f.reviewer.release();
    expect((await running)).toMatchObject({ stage: "interrupted", owned: true });
    expect(f.forge.pushes).toHaveLength(1);
    f.options.agents.claude = new FakeAdapter(() => [
      { type: "write", path: "reviewer-edit.txt", content: "unexpected\n" },
      { type: "text_delta", text: "VERDICT: approve\nFINDINGS: none" }, { type: "done", ok: true },
    ]);
    expect((await finishUpdate(f.hub, f.id, f.revision)).error).toMatch(/Reviewer failed or changed/);
    expect(fs.readFileSync(path.join(f.ws.worktreePath, "reviewer-edit.txt"), "utf8")).toBe("unexpected\n");
    expect(f.forge.pushes).toHaveLength(1);
  });

  it("treats a real non-fast-forward push rejection as a final error without force or automatic retry", async () => {
    const f = await fixture();
    const push = f.forge.push.bind(f.forge);
    f.forge.push = async (ws, options) => {
      const external = sh(repo, "commit-tree", "HEAD^{tree}", "-p", f.revision.headSha, "-m", "external edit during publication");
      sh(repo, "push", "origin", `${external}:refs/heads/${f.revision.head}`);
      await push(ws, options);
    };
    const result = await finishUpdate(f.hub, f.id, f.revision);
    expect(result).toMatchObject({ stage: "failed", stoppedAt: "publishing", publication: "uncertain" });
    expect(result.error).toMatch(/rejected/); expect(f.forge.pushes).toHaveLength(1);
    expect(sh(remote, "rev-parse", `refs/heads/${f.revision.head}`)).not.toBe(result.resultSha);
  });

  it("requires authentication and explicit API confirmation", async () => {
    const f = await fixture(); const app = createApp(f.hub, "test-token");
    const request = (body: unknown, auth = true) => app.request(`/api/tasks/${f.id}/pr/update`, { method: "POST", headers: { "Content-Type": "application/json", ...(auth ? { Authorization: "Bearer test-token" } : {}) }, body: JSON.stringify(body) });
    expect((await request({ confirmed: true, revision: f.revision }, false)).status).toBe(401);
    expect((await request({ revision: f.revision })).status).toBe(400);
    const accepted = await request({ confirmed: true, revision: f.revision });
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toMatchObject({ stage: "intent" });
    await f.hub.settled(f.id);
  });
});

it("completes an unchanged-tree resolved merge instead of skipping the second parent", async () => {
  sh(repo, "checkout", "-qb", "task");
  fs.writeFileSync(path.join(repo, "file.txt"), "task\n"); sh(repo, "add", "."); sh(repo, "commit", "-qm", "task");
  sh(repo, "checkout", "-q", "release");
  fs.writeFileSync(path.join(repo, "file.txt"), "upstream\n"); sh(repo, "add", "."); sh(repo, "commit", "-qm", "upstream");
  sh(repo, "checkout", "-q", "task");
  try { sh(repo, "merge", "--no-commit", "release"); } catch { /* expected conflict */ }
  await expect(completeUpdateMerge(repo, "integration")).rejects.toThrow(/Unresolved/);
  sh(repo, "checkout", "--ours", "file.txt"); sh(repo, "add", ".");
  expect(sh(repo, "diff", "--cached")).toBe("");
  await completeUpdateMerge(repo, "integration");
  expect(sh(repo, "rev-list", "--parents", "-n", "1", "HEAD").split(" ")).toHaveLength(3);
});

async function finishAbandon(hub: Hub, taskId: string): Promise<PrUpdate> {
  const started = hub.abandonPrUpdate(taskId);
  await hub.settled(taskId);
  const result = lastPrUpdate(hub.events(taskId))!;
  expect(result.id).toBe(started.id);
  return result;
}

describe("abandon retained unpublished PR updates", () => {
  it.each(["clean-test-failure", "pending-conflict", "completed-conflict"] as const)("restores the original baseline and unlocks ordinary turns after %s without changing the PR", async (scenario) => {
    const f = await fixture(scenario === "clean-test-failure" ? "test ! -f upstream.txt" : undefined,
      scenario !== "clean-test-failure", scenario === "completed-conflict" ? "changes" : "approve");
    if (scenario === "pending-conflict") f.options.agents.codex = new FakeAdapter(() => [{ type: "done", ok: true }]);
    const failed = await finishUpdate(f.hub, f.id, f.revision);
    expect(failed).toMatchObject({ stage: "failed", owned: true, previousBase: { baseSha: f.ws.baseSha } });
    const remoteBefore = sh(remote, "rev-parse", `refs/heads/${f.revision.head}`);
    fs.writeFileSync(path.join(f.ws.worktreePath, "user-notes.txt"), "keep user file\n");
    fs.mkdirSync(path.join(f.ws.worktreePath, "cache"));
    fs.writeFileSync(path.join(f.ws.worktreePath, "cache", "ignored.txt"), "keep ignored file\n");
    fs.appendFileSync(path.join(repo, ".git", "info", "exclude"), "\ncache/\n");
    const abandoned = await finishAbandon(f.hub, f.id);
    expect(abandoned).toMatchObject({ stage: "abandoned", owned: false, action: "abandon" });
    expect(sh(f.ws.worktreePath, "rev-parse", "HEAD")).toBe(f.revision.headSha);
    expect(sh(remote, "rev-parse", `refs/heads/${f.revision.head}`)).toBe(remoteBefore);
    expect(f.forge.pushes).toHaveLength(1); expect(f.forge.opened).toBe(1);
    expect(f.hub.getTask(f.id).workspace).toMatchObject({ baseSha: f.ws.baseSha, pr: { state: "open", number: 41 } });
    expect(f.hub.getTask(f.id).workspace!.prBase).toBe(f.ws.prBase);
    expect(fs.readFileSync(path.join(f.ws.worktreePath, "user-notes.txt"), "utf8")).toContain("keep user");
    expect(fs.readFileSync(path.join(f.ws.worktreePath, "cache", "ignored.txt"), "utf8")).toContain("keep ignored");
    expect(abandoned.retainedUntracked).toEqual({ paths: ["user-notes.txt"], total: 1 });
    expect(() => f.hub.sendMessage(f.id, "Inspect the task again")).toThrow(/Review or remove leftover files/);
    fs.unlinkSync(path.join(f.ws.worktreePath, "user-notes.txt"));
    f.options.agents.codex = new FakeAdapter();
    expect(() => f.hub.sendMessage(f.id, "Inspect the task again")).not.toThrow();
    await f.hub.settled(f.id);
    expect(f.options.agents.codex.runs.filter(run => !run.toolsDisabled)).toHaveLength(1);
  });

  it.each(["uncertain", "published"] as const)("refuses %s publication before starting abandonment", async (publication) => {
    const f = await fixture("test ! -f upstream.txt");
    const failed = await finishUpdate(f.hub, f.id, f.revision);
    const ev = f.hub.events(f.id).filter(e => e.type === "pr_update").at(-1)!;
    f.options.db.update(schema.events).set({ payload: { update: { ...failed, publication } } }).where(eq(schema.events.id, ev.id)).run();
    expect(() => f.hub.abandonPrUpdate(f.id)).toThrow(/reconcile uncertain publication/);
    expect(sh(f.ws.worktreePath, "rev-parse", "HEAD")).toBe(failed.resultSha);
  });

  it.each(["remote-head", "unrelated-local-commit", "unrelated-pending-merge"] as const)("refuses %s without resetting local work", async (change) => {
    const f = await fixture("test ! -f upstream.txt");
    const failed = await finishUpdate(f.hub, f.id, f.revision);
    if (change === "remote-head") {
      const external = sh(repo, "commit-tree", "HEAD^{tree}", "-p", f.revision.headSha, "-m", "external update");
      sh(repo, "push", "origin", `${external}:refs/heads/${f.revision.head}`);
    } else if (change === "unrelated-local-commit") {
      fs.writeFileSync(path.join(f.ws.worktreePath, "external.txt"), "unrelated\n");
      sh(f.ws.worktreePath, "add", "."); sh(f.ws.worktreePath, "commit", "-qm", "external local commit");
    } else {
      const gitDir = sh(f.ws.worktreePath, "rev-parse", "--absolute-git-dir");
      fs.writeFileSync(path.join(gitDir, "MERGE_HEAD"), f.revision.headSha + "\n");
    }
    const before = sh(f.ws.worktreePath, "rev-parse", "HEAD");
    const result = await finishAbandon(f.hub, f.id);
    expect(result).toMatchObject({ stage: "failed", owned: true });
    expect(result.error).toMatch(/changed|exact owned merge/);
    expect(sh(f.ws.worktreePath, "rev-parse", "HEAD")).toBe(before);
    expect(f.forge.pushes).toHaveLength(1);
    expect(failed.resultSha).toBeDefined();
  });

  it("refuses while another operation is active and requires authenticated standalone confirmation", async () => {
    const f = await fixture(undefined, true);
    // The resolution script starts with a write step, which never yields; hold after the first yielded event.
    f.author.hold(1);
    f.hub.updatePr(f.id, f.revision);
    expect(() => f.hub.abandonPrUpdate(f.id)).toThrow(/still running/);
    await vi.waitFor(() => expect(lastPrUpdate(f.hub.events(f.id))?.stage).toBe("resolving"));
    f.hub.stop(f.id); f.author.release(); await f.hub.settled(f.id);
    const app = createApp(f.hub, "test-token");
    const request = (body: unknown, auth = true) => app.request(`/api/tasks/${f.id}/pr/abandon-update`, {
      method: "POST", headers: { "Content-Type": "application/json", ...(auth ? { Authorization: "Bearer test-token" } : {}) }, body: JSON.stringify(body),
    });
    expect((await request({ confirmed: true }, false)).status).toBe(401);
    expect((await request({})).status).toBe(400);
    const accepted = await request({ confirmed: true });
    expect(accepted.status).toBe(202); expect(await accepted.json()).toMatchObject({ stage: "abandoning" });
    await f.hub.settled(f.id);
    expect(lastPrUpdate(f.hub.events(f.id))?.stage).toBe("abandoned");
  });

  it("cleans only recorded unchanged merge artifacts while preserving unrelated files", async () => {
    const f = await fixture("test ! -f upstream.txt");
    const failed = await finishUpdate(f.hub, f.id, f.revision);
    fs.writeFileSync(path.join(f.ws.worktreePath, "merge-artifact"), "owned merge backup\n");
    const { captureMergeUntracked } = await import("../src/workspace/git");
    const manifest = await captureMergeUntracked(f.ws.worktreePath);
    const ev = f.hub.events(f.id).filter(e => e.type === "pr_update").at(-1)!;
    f.options.db.update(schema.events).set({ payload: { update: { ...failed, mergeUntracked: manifest } } }).where(eq(schema.events.id, ev.id)).run();
    fs.writeFileSync(path.join(f.ws.worktreePath, "user-file"), "unrelated\n");
    expect((await finishAbandon(f.hub, f.id)).stage).toBe("abandoned");
    expect(fs.existsSync(path.join(f.ws.worktreePath, "merge-artifact"))).toBe(false);
    expect(fs.readFileSync(path.join(f.ws.worktreePath, "user-file"), "utf8")).toBe("unrelated\n");
  });

  it("refuses edited artifacts and symlink cleanup parents without deleting user files", async () => {
    const f = await fixture("test ! -f upstream.txt");
    const failed = await finishUpdate(f.hub, f.id, f.revision);
    fs.mkdirSync(path.join(f.ws.worktreePath, "artifacts"));
    fs.writeFileSync(path.join(f.ws.worktreePath, "artifacts", "backup"), "owned\n");
    const { captureMergeUntracked } = await import("../src/workspace/git");
    const manifest = await captureMergeUntracked(f.ws.worktreePath);
    const ev = f.hub.events(f.id).filter(e => e.type === "pr_update").at(-1)!;
    f.options.db.update(schema.events).set({ payload: { update: { ...failed, mergeUntracked: manifest } } }).where(eq(schema.events.id, ev.id)).run();
    fs.writeFileSync(path.join(f.ws.worktreePath, "artifacts", "backup"), "user edit\n");
    expect((await finishAbandon(f.hub, f.id)).error).toMatch(/artifact was changed/);
    expect(fs.readFileSync(path.join(f.ws.worktreePath, "artifacts", "backup"), "utf8")).toBe("user edit\n");
    fs.renameSync(path.join(f.ws.worktreePath, "artifacts"), path.join(root, "outside-artifacts"));
    fs.symlinkSync(path.join(root, "outside-artifacts"), path.join(f.ws.worktreePath, "artifacts"));
    expect((await finishAbandon(f.hub, f.id)).error).toMatch(/parent changed/);
    expect(fs.readFileSync(path.join(root, "outside-artifacts", "backup"), "utf8")).toBe("user edit\n");
  });
});

it("returns an intent immediately while an update remains tracked and guards reviewer session setup failures", async () => {
  const f = await fixture();
  f.options.agents.codex = new FakeAdapter();
  const parent = await f.hub.createTask({ workflow: "plan", title: "Original planner", repoPath: repo, message: "Plan this task" });
  await f.hub.settled(parent.id);
  f.options.db.update(schema.tasks).set({ options: { ...f.hub.getTask(f.id).options, reportsTo: parent.id } }).where(eq(schema.tasks.id, f.id)).run();
  const started = f.hub.updatePr(f.id, f.revision, parent.id);
  expect(started).toMatchObject({ stage: "intent" }); expect(f.hub.isBusy(f.id)).toBe(true);
  vi.spyOn(f.options.db, "insert").mockImplementationOnce(() => { throw new Error("reviewer session setup failed"); });
  await f.hub.settled(f.id);
  expect(lastPrUpdate(f.hub.events(f.id))).toMatchObject({ id: started.id, stage: "failed", error: "reviewer session setup failed" });
  expect(f.hub.getTask(f.id).status).toBe("idle"); expect(f.hub.isBusy(f.id)).toBe(false);
  await f.hub.settled(parent.id);
  expect(f.hub.events(parent.id).find(e => e.type === "task_report")).toMatchObject({
    report: { outcome: "update_failed", prUpdate: { id: started.id, error: "reviewer session setup failed" } },
  });
  expect(f.forge.pushes).toHaveLength(1);
});

it("refuses an ignored user file obstructing restoration instead of letting reset delete it", async () => {
  const f = await fixture("test ! -f upstream.txt");
  await finishUpdate(f.hub, f.id, f.revision);
  sh(f.ws.worktreePath, "rm", "--cached", "file.txt");
  fs.appendFileSync(path.join(repo, ".git", "info", "exclude"), "\nfile.txt\n");
  fs.writeFileSync(path.join(f.ws.worktreePath, "file.txt"), "user-owned ignored contents\n");
  const before = sh(f.ws.worktreePath, "rev-parse", "HEAD");
  expect((await finishAbandon(f.hub, f.id)).error).toMatch(/User files obstruct restoration/);
  expect(sh(f.ws.worktreePath, "rev-parse", "HEAD")).toBe(before);
  expect(fs.readFileSync(path.join(f.ws.worktreePath, "file.txt"), "utf8")).toBe("user-owned ignored contents\n");
});

it("delivers successful abandonment as a distinct durable report to the original planner", async () => {
  const f = await fixture("test ! -f upstream.txt");
  await finishUpdate(f.hub, f.id, f.revision);
  f.options.agents.codex = new FakeAdapter();
  const parent = await f.hub.createTask({ workflow: "plan", title: "Original planner", repoPath: repo, message: "Plan this task" });
  await f.hub.settled(parent.id);
  f.options.db.update(schema.tasks).set({ options: { ...f.hub.getTask(f.id).options, reportsTo: parent.id } }).where(eq(schema.tasks.id, f.id)).run();
  fs.writeFileSync(path.join(f.ws.worktreePath, "retained-notes.txt"), "Review before continuing\n");
  const started = f.hub.abandonPrUpdate(f.id, parent.id);
  await f.hub.settled(f.id); await f.hub.settled(parent.id);
  const report = f.hub.events(parent.id).find(e => e.type === "task_report")!;
  expect(report).toMatchObject({ report: { outcome: "update_abandoned", prUpdate: { id: started.id, stage: "abandoned", owned: false, resultSha: f.revision.headSha } } });
  expect(report).toMatchObject({ report: { prUpdate: { retainedUntracked: { paths: ["retained-notes.txt"], total: 1 } } } });
  expect(report.type === "task_report" && report.prompt).toContain("retainedUntracked");
  expect(report.type === "task_report" && report.prompt).not.toContain("Open the PR now");
  expect(sh(remote, "rev-parse", `refs/heads/${f.revision.head}`)).toBe(f.revision.headSha);
});

it("retains an interrupted author's new file, blocks all ordinary entry points and snapshots, then resumes after removal", async () => {
  const f = await fixture(undefined, true);
  const author = new FakeAdapter(() => [
    { type: "write", path: "leftover-integration.txt", content: "unfinished resolution\n" },
    { type: "text_delta", text: "Resolution in progress" }, { type: "done", ok: true },
  ]);
  author.hold(1); f.options.agents.codex = author;
  f.hub.updatePr(f.id, f.revision);
  const leftover = path.join(f.ws.worktreePath, "leftover-integration.txt");
  await vi.waitFor(() => expect(fs.existsSync(leftover)).toBe(true));
  f.hub.stop(f.id); author.release(); await f.hub.settled(f.id);
  expect(lastPrUpdate(f.hub.events(f.id))).toMatchObject({ stage: "interrupted", mergeUntracked: [] });
  await f.hub.diff(f.id);
  expect(sh(f.ws.worktreePath, "ls-files", "--others", "--exclude-standard")).toContain("leftover-integration.txt");
  const result = await finishAbandon(f.hub, f.id);
  expect(result).toMatchObject({ stage: "abandoned", retainedUntracked: { paths: ["leftover-integration.txt"], total: 1 } });
  expect(fs.readFileSync(leftover, "utf8")).toBe("unfinished resolution\n");
  const reject = (action: () => void) => {
    expect(action).toThrow(/Review or remove leftover files.*leftover-integration/);
    try { action(); } catch (error) { expect(error).toMatchObject({ status: 409 }); }
  };
  await f.hub.diff(f.id);
  expect(sh(f.ws.worktreePath, "ls-files", "--others", "--exclude-standard")).toContain("leftover-integration.txt");
  reject(() => f.hub.sendMessage(f.id, "Continue the original task"));
  reject(() => f.hub["kick"](f.id));
  reject(() => f.hub.updatePr(f.id, f.revision));
  expect(lastPrUpdate(f.hub.events(f.id))?.stage).toBe("abandoned");
  const { snapshot } = await import("../src/core/workflows/snapshot");
  await expect(snapshot(f.hub["workflowDeps"], f.hub.getTask(f.id), 1)).rejects.toThrow(/Review or remove leftover files/);
  expect(sh(f.ws.worktreePath, "rev-parse", "HEAD")).toBe(f.revision.headSha);
  expect(sh(remote, "rev-parse", `refs/heads/${f.revision.head}`)).toBe(f.revision.headSha);
  expect(f.forge.pushes).toHaveLength(1);
  f.options.db.update(schema.tasks).set({ status: "interrupted" }).where(eq(schema.tasks.id, f.id)).run();
  const sessions = f.hub.getTask(f.id).sessions;
  reject(() => f.hub.recover(f.id, "restart"));
  expect(f.hub.getTask(f.id).sessions).toEqual(sessions);
  expect(f.hub.getTask(f.id).status).toBe("interrupted");
  const restarted = new Hub(f.options); hubs.push(restarted);
  reject(() => restarted.sendMessage(f.id, "Continue after restart"));
  fs.unlinkSync(leftover);
  f.options.agents.codex = new FakeAdapter();
  expect(() => restarted.recover(f.id, "restart")).not.toThrow();
  await restarted.settled(f.id);
  expect(f.options.agents.codex.runs).toHaveLength(1);
  expect(sh(remote, "rev-parse", `refs/heads/${f.revision.head}`)).toBe(f.revision.headSha);
});

it("does not block abandonment with no leftovers and accepts files deliberately staged after review", async () => {
  const f = await fixture("test ! -f upstream.txt");
  await finishUpdate(f.hub, f.id, f.revision);
  expect((await finishAbandon(f.hub, f.id)).retainedUntracked).toEqual({ paths: [], total: 0 });
  f.options.agents.codex = new FakeAdapter();
  expect(() => f.hub.sendMessage(f.id, "Inspect only")).not.toThrow(); await f.hub.settled(f.id);
  await finishUpdate(f.hub, f.id, f.revision);
  fs.writeFileSync(path.join(f.ws.worktreePath, "reviewed.txt"), "retained work\n");
  expect((await finishAbandon(f.hub, f.id)).retainedUntracked).toEqual({ paths: ["reviewed.txt"], total: 1 });
  sh(f.ws.worktreePath, "add", "--", "reviewed.txt");
  expect(() => f.hub.sendMessage(f.id, "Continue with the reviewed file")).not.toThrow(); await f.hub.settled(f.id);
});

it("bounds the persisted leftover list and blocks omitted paths until they are removed", async () => {
  const f = await fixture("test ! -f upstream.txt");
  await finishUpdate(f.hub, f.id, f.revision);
  for (let i = 0; i < 85; i++) fs.writeFileSync(path.join(f.ws.worktreePath, `leftover-${i}.txt`), "leftover\n");
  const result = await finishAbandon(f.hub, f.id);
  expect(result.retainedUntracked?.total).toBe(85);
  expect(result.retainedUntracked?.paths).toHaveLength(80);
  for (const file of result.retainedUntracked!.paths) fs.unlinkSync(path.join(f.ws.worktreePath, file));
  expect(() => f.hub.sendMessage(f.id, "Continue")).toThrow(/Review or remove leftover files/);
  for (let i = 0; i < 85; i++) fs.rmSync(path.join(f.ws.worktreePath, `leftover-${i}.txt`), { force: true });
  f.options.agents.codex = new FakeAdapter();
  expect(() => f.hub.sendMessage(f.id, "Continue after cleanup")).not.toThrow(); await f.hub.settled(f.id);
});

it("injects persisted author and reviewer rule snapshots during PR conflict resolution", async () => {
  const f = await fixture(undefined, true);
  const task = f.hub.getTask(f.id);
  const appliedRules = [
    { tag: "author-rules", sha256: "a".repeat(64), roles: ["author"] as const, text: "# Author example\n## Mandatory\na-1 Author rule" },
    { tag: "review-rules", sha256: "b".repeat(64), roles: ["reviewer"] as const, text: "# Reviewer example\n## Mandatory\nr-1 Reviewer rule" },
  ].map(pack => ({ ...pack, roles: [...pack.roles] }));
  f.options.db.update(schema.tasks).set({ options: { ...task.options, appliedRules } }).where(eq(schema.tasks.id, f.id)).run();
  const result = await finishUpdate(f.hub, f.id, f.revision);
  expect(result.stage).toBe("succeeded");
  const author = f.author.runs.find(run => run.prompt.includes("Resolve only"))!;
  expect(author.systemPrompt).toContain(appliedRules[0]!.text);
  expect(author.systemPrompt).not.toContain(appliedRules[1]!.text);
  expect(f.reviewer.runs.at(-1)!.systemPrompt).toContain(appliedRules[1]!.text);
  expect(f.reviewer.runs.at(-1)!.systemPrompt).not.toContain(appliedRules[0]!.text);
});
