import { briefingFixture } from "./briefing-fixture";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Workspace } from "@agent-hub/shared";
import { FakeAdapter, type FakeStep } from "../src/agents/fake";
import type { AgentRunInput } from "../src/agents/types";
import { Hub } from "../src/core/hub";
import { openDb } from "../src/db/index";
import { parseGithubRemote, type Forge, type PrState } from "../src/workspace/forge";

/** A forge that records what was asked and lets a test decide what GitHub "says". */
class FakeForge implements Forge {
  pushes: string[] = [];
  opened: { title: string; body: string }[] = [];
  closed: number[] = [];
  remoteState: PrState = "open";
  async repoOf() {
    return "me/repo";
  }
  async listIssues() { return []; }
  async readIssue(): Promise<never> { throw new Error("Issue not found"); }
  async push(ws: Workspace) {
    this.pushes.push(ws.branch);
  }
  async openPullRequest(_ws: Workspace, _repo: string, title: string, body: string) {
    this.opened.push({ title, body });
    return { number: 7, url: "https://github.com/me/repo/pull/7", state: "open" as const };
  }
  async state() {
    return this.remoteState;
  }
  async close(_repo: string, n: number) {
    this.closed.push(n);
  }
}

let root: string;
let repo: string;
const sh = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8" }).trim();
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-hub-forge-"));
  repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  sh(repo, "init", "-q", "-b", "main");
  sh(repo, "config", "user.email", "t@t");
  sh(repo, "config", "user.name", "t");
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  sh(repo, "add", ".");
  sh(repo, "commit", "-qm", "init");
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const writes = (i: AgentRunInput, n: number): FakeStep[] => briefingFixture(i) ?? (i.toolsDisabled ? [{ type: "text_delta", text: '{"hunks":[]}' }, { type: "done", ok: true }] : [
  { type: "thread", threadId: i.threadId ?? `t${n}` },
  { type: "write", path: "f.txt", content: `v${n}\n` },
  { type: "text_start" },
  { type: "text_delta", text: `did round ${n}` },
  { type: "done", ok: true },
]);
const approve = (i: AgentRunInput, n: number): FakeStep[] => [{ type: "thread", threadId: `r${n}` }, { type: "text_start" }, { type: "text_delta", text: "VERDICT: approve\nFINDINGS: none" }, { type: "done", ok: true }];

describe("pull requests", () => {
  it("opens a PR with the request and the review, pushes later rounds, and finishes when GitHub merges it", async () => {
    const forge = new FakeForge();
    const hub = new Hub({ db: openDb(":memory:"), dataDir: path.join(root, "data"), maxConcurrent: 2, flushMs: 1, forge, agents: { claude: new FakeAdapter(writes), codex: new FakeAdapter(approve) } });
    const task = await hub.createTask({ title: "add f", workflow: "review", agent: "claude", reviewer: "codex", repoPath: repo, message: "add f.txt", testCommand: "git diff --check" });
    await hub.settled(task.id);
    expect(hub.getTask(task.id).workspace).toMatchObject({ github: "me/repo" });

    const pr = await hub.openPr(task.id);
    expect(pr).toMatchObject({ number: 7 });
    expect(forge.opened[0]!.title).toBe("add f");
    const body = forge.opened[0]!.body;
    expect(body).toContain("## 需求\n\n> add f.txt");
    expect(body).toContain("## Agent 的實作說明\n\ndid round 1");
    expect(body).toContain("## 審查");
    expect(body).not.toContain("explainer");
    expect(body).toContain("## 測試\n\n`git diff --check`: 通過");
    expect(body).toContain("由 Agent Hub 建立。參與的 Agent：Claude (author");
    expect(forge.opened[0]!.body).toContain("第 1 輪：**核准**（未發現問題）");
    expect(hub.events(task.id).some((e) => e.type === "pr_opened")).toBe(true);
    await expect(hub.merge(task.id)).rejects.toThrow(/merge it on GitHub/);
    await expect(hub.openPr(task.id)).rejects.toThrow(/already open/);

    hub.sendMessage(task.id, "one more change");
    await hub.settled(task.id);
    expect(forge.pushes.length).toBe(2); // the PR push, then the new round's commit

    await hub.pollPullRequests();
    expect(hub.getTask(task.id).status).not.toBe("done"); // still open on GitHub
    forge.remoteState = "merged";
    await hub.pollPullRequests();
    const done = hub.getTask(task.id);
    expect(done).toMatchObject({ status: "done", workspace: { state: "merged", pr: { state: "merged" } } });
    expect(fs.existsSync(done.workspace!.worktreePath)).toBe(false);
  });

  it("a PR closed on GitHub keeps the worktree; discarding closes an open PR", async () => {
    const forge = new FakeForge();
    const hub = new Hub({ db: openDb(":memory:"), dataDir: path.join(root, "data"), maxConcurrent: 2, flushMs: 1, forge, agents: { claude: new FakeAdapter(writes) } });
    const a = await hub.createTask({ title: "a", workflow: "implement", agent: "claude", repoPath: repo, message: "x" });
    await hub.settled(a.id);
    await hub.openPr(a.id);
    forge.remoteState = "closed";
    await hub.pollPullRequests();
    expect(hub.getTask(a.id)).toMatchObject({ status: "idle", workspace: { state: "active", pr: { state: "closed" } } });

    forge.remoteState = "open";
    const b = await hub.createTask({ title: "b", workflow: "implement", agent: "claude", repoPath: repo, message: "y" });
    await hub.settled(b.id);
    await hub.openPr(b.id);
    await hub.discard(b.id);
    expect(forge.closed).toEqual([7]);
  });

  it("refuses without a GitHub remote or without changes", async () => {
    const forge = Object.assign(new FakeForge(), { repoOf: async () => null });
    const hub = new Hub({ db: openDb(":memory:"), dataDir: path.join(root, "data"), maxConcurrent: 2, flushMs: 1, forge, agents: { claude: new FakeAdapter(writes) } });
    const t = await hub.createTask({ title: "t", workflow: "implement", agent: "claude", repoPath: repo, message: "x" });
    await hub.settled(t.id);
    await expect(hub.openPr(t.id)).rejects.toThrow(/no GitHub remote/);
  });
});

describe("parseGithubRemote", () => {
  it("reads ssh and https remotes, and nothing else", () => {
    expect(parseGithubRemote("git@github.com:Owner/repo.git")).toBe("Owner/repo");
    expect(parseGithubRemote("https://github.com/Owner/repo")).toBe("Owner/repo");
    expect(parseGithubRemote("https://x-access-token:abc@github.com/Owner/repo.git\n")).toBe("Owner/repo");
    expect(parseGithubRemote("https://gitlab.com/Owner/repo.git")).toBeNull();
    expect(parseGithubRemote("ssh://git@github.com/Owner/repo.git")).toBe("Owner/repo");
    expect(parseGithubRemote("https://notgithub.com/Owner/repo.git")).toBeNull();
    expect(parseGithubRemote("https://example.invalid/github.com/Owner/repo.git")).toBeNull();
    expect(parseGithubRemote("https://github.com.example.invalid/Owner/repo.git")).toBeNull();
  });
});
