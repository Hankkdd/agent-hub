import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeAdapter, type FakeStep } from "../src/agents/fake";
import type { AgentRunInput } from "../src/agents/types";
import { Hub, parseReview } from "../src/core/hub";
import { openDb } from "../src/db/index";
import { reviewPrompt, REVIEWER_SYSTEM, SCOPE_GUIDANCE } from "../src/core/prompts";

let root: string;
let repo: string;

const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-hub-wf-"));
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

function makeHub(author: FakeAdapter, reviewer?: FakeAdapter): Hub {
  return new Hub({ db: openDb(":memory:"), dataDir: path.join(root, "data"), maxConcurrent: 4, flushMs: 1, agents: { claude: author, codex: reviewer } });
}

/** A scripted turn: optional file writes, then a reply. */
const turn = (input: AgentRunInput, n: number, reply: string, writes: Record<string, string> = {}): FakeStep[] => [
  { type: "thread", threadId: input.threadId ?? `thread-${n}` },
  ...Object.entries(writes).map(([p, content]) => ({ type: "write" as const, path: p, content })),
  { type: "text_start" },
  { type: "text_delta", text: reply },
  { type: "done", ok: true },
];

const implement = (message: string) => ({ title: "", workflow: "implement" as const, agent: "claude" as const, repoPath: repo, message });
const review = (message: string, extra: object = {}) => ({ title: "", workflow: "review" as const, agent: "claude" as const, reviewer: "codex" as const, repoPath: repo, message, ...extra });

describe("implement workflow", () => {
  it("works in a worktree, commits each turn, and merges back into the base branch", async () => {
    const hub = makeHub(new FakeAdapter((i, n) => turn(i, n, "added a greeting", { "greet.txt": "hi\n" })));
    const task = await hub.createTask(implement("add a greeting file"));
    await hub.settled(task.id);

    const t = hub.getTask(task.id);
    expect(t.workspace).toMatchObject({ baseRef: "main", state: "active", branch: expect.stringMatching(/^agent-hub\//) });
    expect(t.cwd).toBe(t.workspace!.worktreePath);
    expect(t.activity).toBe("Review the diff, then merge or discard");
    expect(fs.existsSync(path.join(repo, "greet.txt"))).toBe(false); // the user's checkout is untouched
    expect(hub.events(task.id).find((e) => e.type === "diff_snapshot")).toMatchObject({ round: 1, filesChanged: 1, additions: 1 });
    expect(await hub.diff(task.id)).toEqual([{ path: "greet.txt", status: "added", additions: 1, deletions: 0 }]);
    expect(await hub.diffFile(task.id, "greet.txt")).toMatchObject({ original: "", modified: "hi\n", binary: false });

    await hub.merge(task.id);
    expect(fs.readFileSync(path.join(repo, "greet.txt"), "utf8")).toBe("hi\n");
    expect(fs.existsSync(t.workspace!.worktreePath)).toBe(false);
    expect(sh(repo, "branch", "--list", t.workspace!.branch)).toBe(""); // merged branch deleted
    expect(hub.getTask(task.id)).toMatchObject({ status: "done", workspace: { state: "merged" } });
    expect(() => hub.sendMessage(task.id, "more")).toThrow(/merged/);
  });

  it("refuses to merge into a repo with uncommitted changes, and leaves everything as it was", async () => {
    const hub = makeHub(new FakeAdapter((i, n) => turn(i, n, "done", { "greet.txt": "hi\n" })));
    const task = await hub.createTask(implement("add a greeting file"));
    await hub.settled(task.id);
    fs.writeFileSync(path.join(repo, "README.md"), "edited by the user\n");
    await expect(hub.merge(task.id)).rejects.toThrow(/uncommitted changes/);
    expect(hub.getTask(task.id).workspace!.state).toBe("active");
    expect(fs.readFileSync(path.join(repo, "README.md"), "utf8")).toBe("edited by the user\n");
  });

  it("discard removes the worktree and its branch without touching the repo", async () => {
    const hub = makeHub(new FakeAdapter((i, n) => turn(i, n, "done", { "greet.txt": "hi\n" })));
    const task = await hub.createTask(implement("add a greeting file"));
    await hub.settled(task.id);
    const ws = hub.getTask(task.id).workspace!;
    await hub.discard(task.id);
    expect(fs.existsSync(ws.worktreePath)).toBe(false);
    expect(sh(repo, "branch", "--list", ws.branch)).toBe("");
    expect(fs.existsSync(path.join(repo, "greet.txt"))).toBe(false);
    expect(hub.getTask(task.id).workspace!.state).toBe("discarded");
  });
});

describe("deleting a worktree task", () => {
  it("removes its worktree and branch, and leaves the repo alone", async () => {
    const hub = makeHub(new FakeAdapter((i, n) => turn(i, n, "done", { "greet.txt": "hi\n" })));
    const task = await hub.createTask(implement("add a greeting file"));
    await hub.settled(task.id);
    const ws = hub.getTask(task.id).workspace!;
    await hub.deleteTask(task.id);
    expect(fs.existsSync(ws.worktreePath)).toBe(false);
    expect(sh(repo, "branch", "--list", ws.branch)).toBe("");
    expect(fs.readFileSync(path.join(repo, "README.md"), "utf8")).toBe("hello\n");
  });
});

describe("review workflow", () => {
  it("observes requests/diff repetition within one loop without altering review inputs, rounds or continuation", async () => {
    const baseSha = sh(repo, "rev-parse", "HEAD");
    const message = "Keep the greeting clear 規劃😀";
    const author = new FakeAdapter((input, n) => turn(input, n, "Implemented", n === 1 ? { "greet.txt": "first\n" } : n === 3 ? { "greet.txt": "changed\n" } : {}));
    let reviewCount = 0;
    const reviewer = new FakeAdapter((input, n) => {
      if (input.toolsDisabled) return turn(input, n, '{"items":[]}');
      reviewCount++;
      const diff = execFileSync("git", ["diff", `${baseSha}..HEAD`], { cwd: input.cwd, encoding: "utf8" });
      expect(input.prompt).toBe(reviewPrompt(reviewCount <= 3 ? [message] : [message, "Continue reviewing"], diff, reviewCount <= 3 ? reviewCount : 1));
      expect(input.systemPrompt).toBe(REVIEWER_SYSTEM + SCOPE_GUIDANCE);
      expect(input.readOnly).toBe(true);
      expect(input).not.toHaveProperty("inputDiagnostics");
      expect(input).not.toHaveProperty("hostInput");
      return turn(input, n, reviewCount < 3 ? "VERDICT: changes\nFINDINGS:\n- [low] Check again" : "VERDICT: approve\nFINDINGS: none");
    });
    const hub = makeHub(author, reviewer);
    const task = await hub.createTask(review(message)); await hub.settled(task.id);
    const calls = () => hub.usageCalls(task.id).calls.filter(c => c.role === "reviewer" && c.purpose === "workflow");
    expect(calls().map(c => c.hostInput?.components?.review)).toMatchObject([
      { requestsCount: 1, requestsUtf8Bytes: Buffer.byteLength(message), requestsComparison: "unknown", suppliedDiffComparison: "unknown", diffCoverage: "supplied_bounded_text" },
      { requestsComparison: "same", suppliedDiffComparison: "same" },
      { requestsComparison: "same", suppliedDiffComparison: "changed" },
    ]);
    const inputs = reviewer.runs.filter(input => !input.toolsDisabled);
    expect(inputs[0]!.threadId).toBeUndefined();
    expect(inputs[1]!.threadId).toBe(inputs[2]!.threadId);
    expect(inputs).toHaveLength(3);
    hub.sendMessage(task.id, "Continue reviewing"); await hub.settled(task.id);
    expect(calls()).toHaveLength(4);
    expect(calls()[3]?.hostInput?.components?.review).toMatchObject({ requestsCount: 2, requestsComparison: "unknown", suppliedDiffComparison: "unknown" });
    expect(hub.events(task.id).filter(e => e.type === "review_result").map(e => e.type === "review_result" && e.round)).toEqual([1, 2, 3, 1]);
  });

  it("loops author -> reviewer until approved, feeding findings back, and never keeps reviewer edits", async () => {
    const author = new FakeAdapter((i, n) => turn(i, n, n === 1 ? "first try" : "fixed it", { "greet.txt": n === 1 ? "helo\n" : "hello\n" }));
    const reviewer = new FakeAdapter((i, n) =>
      n === 1
        ? turn(i, n, "Typo.\nVERDICT: changes\nFINDINGS:\n- [high] greet.txt:1 - says helo, should say hello", { "reviewer-scratch.txt": "should not survive" })
        : turn(i, n, "Good now.\nVERDICT: approve\nFINDINGS: none"),
    );
    const hub = makeHub(author, reviewer);
    const task = await hub.createTask(review("add a greeting file that says hello"));
    await hub.settled(task.id);

    expect(author.runs).toHaveLength(2);
    expect(author.runs[1]!.prompt).toContain("greet.txt:1 - says helo, should say hello");
    expect(author.runs[1]!.threadId).toBe("thread-1"); // the author keeps its own conversation
    expect(reviewer.runs.filter((r) => !r.toolsDisabled)).toHaveLength(2);
    expect(reviewer.runs.every((r) => r.readOnly)).toBe(true);
    expect(reviewer.runs[0]!.prompt).toContain("+helo");
    expect(reviewer.runs[1]!.prompt).toContain("+hello");

    const results = hub.events(task.id).filter((e) => e.type === "review_result");
    expect(results).toMatchObject([
      { round: 1, verdict: "changes", findings: [{ severity: "high", location: "greet.txt:1", message: "says helo, should say hello" }] },
      { round: 2, verdict: "approve", findings: [] },
    ]);
    expect(hub.getTask(task.id)).toMatchObject({ status: "idle", activity: expect.stringContaining("Approved by Codex in round 2/3") });
    expect((await hub.diff(task.id)).map((f) => f.path)).toEqual(["greet.txt"]); // reviewer's scratch file was reset away
  });

  it("stops for the user when the rounds run out", async () => {
    const author = new FakeAdapter((i, n) => turn(i, n, "try", { "f.txt": `attempt ${n}\n` }));
    const reviewer = new FakeAdapter((i, n) => turn(i, n, "VERDICT: changes\nFINDINGS:\n- [medium] f.txt:1 - still wrong"));
    const hub = makeHub(author, reviewer);
    const task = await hub.createTask(review("do it", { maxRounds: 2 }));
    await hub.settled(task.id);
    expect(author.runs).toHaveLength(2);
    expect(hub.getTask(task.id).activity).toMatch(/Not approved after 2 rounds/);
  });

  it("runs the test command after approval and sends a failure back to the author", async () => {
    // The test passes only once the file says "ok".
    const author = new FakeAdapter((i, n) => turn(i, n, "done", { "status.txt": n === 1 ? "broken\n" : "ok\n" }));
    const reviewer = new FakeAdapter((i, n) => turn(i, n, "VERDICT: approve\nFINDINGS: none"));
    const hub = makeHub(author, reviewer);
    const task = await hub.createTask(review("make status ok", { testCommand: "grep -q '^ok$' status.txt && echo passed" }));
    await hub.settled(task.id);

    const tests = hub.events(task.id).filter((e) => e.type === "test_result");
    expect(tests).toMatchObject([
      { round: 1, exitCode: 1 },
      { round: 2, exitCode: 0, output: expect.stringContaining("passed") },
    ]);
    expect(author.runs[1]!.prompt).toContain("the tests failed");
    expect(hub.getTask(task.id).activity).toMatch(/tests pass/);
  });

  it("skips the review when the author changed nothing", async () => {
    const reviewer = new FakeAdapter();
    const hub = makeHub(new FakeAdapter((i, n) => turn(i, n, "nothing to do")), reviewer);
    const task = await hub.createTask(review("do nothing"));
    await hub.settled(task.id);
    expect(reviewer.runs).toHaveLength(0);
    expect(hub.getTask(task.id).activity).toMatch(/made no changes/);
  });
});

describe("model and effort", () => {
  it("defaults: chat is Codex at low effort; code is Codex (medium) reviewed by Claude sonnet (medium)", async () => {
    const claude = new FakeAdapter();
    const codex = new FakeAdapter((i, n) => turn(i, n, "VERDICT: approve\nFINDINGS: none"));
    const hub = makeHub(claude, codex);

    const chatTask = await hub.createTask({ title: "", workflow: "chat", message: "hi" });
    await hub.settled(chatTask.id);
    expect(hub.getTask(chatTask.id).sessions).toMatchObject([{ agent: "codex", role: "main", effort: "low", model: null }]);
    expect(codex.runs[0]).toMatchObject({ effort: "low", model: undefined });

    const writer = new FakeAdapter((i, n) => turn(i, n, "done", { "x.txt": "x\n" }));
    const hub2 = makeHub(new FakeAdapter((i, n) => turn(i, n, "VERDICT: approve\nFINDINGS: none")), writer);
    const reviewTask = await hub2.createTask({ title: "", workflow: "review", repoPath: repo, message: "add x" });
    await hub2.settled(reviewTask.id);
    expect(hub2.getTask(reviewTask.id).sessions.filter((s) => s.role !== "explainer")).toMatchObject([
      { agent: "codex", role: "author", effort: "medium", model: null },
      { agent: "claude", role: "reviewer", effort: "medium", model: "sonnet" },
    ]);
    expect(writer.runs[0]!.effort).toBe("medium");
    expect(hub2.getTask(reviewTask.id)).toMatchObject({ status: "idle", activity: expect.stringContaining("Approved by Claude") });
  });

  it("keeps explicitly selected agents and does not give Codex a Claude default model", async () => {
    const author = new FakeAdapter((i, n) => turn(i, n, "done", { "x.txt": "x\n" }));
    const reviewer = new FakeAdapter((i, n) => turn(i, n, "VERDICT: approve\nFINDINGS: none"));
    const hub = makeHub(author, reviewer);
    const task = await hub.createTask(review("add x"));
    await hub.settled(task.id);
    expect(hub.getTask(task.id).sessions.filter((s) => s.role !== "explainer")).toMatchObject([
      { agent: "claude", role: "author", effort: "medium", model: null },
      { agent: "codex", role: "reviewer", effort: "medium", model: null },
    ]);
    expect(reviewer.runs.find((run) => !run.toolsDisabled)).toMatchObject({ model: undefined, effort: "medium" });
  });

  it("preserves an explicit choice of the reviewer's own default model", async () => {
    const writer = new FakeAdapter((i, n) => turn(i, n, "done", { "x.txt": "x\n" }));
    const reviewer = new FakeAdapter((i, n) => turn(i, n, "VERDICT: approve\nFINDINGS: none"));
    const hub = makeHub(reviewer, writer);
    const task = await hub.createTask({ title: "", workflow: "review", repoPath: repo, message: "add x", reviewerModel: "" });
    await hub.settled(task.id);
    expect(hub.getTask(task.id).sessions.find((s) => s.role === "reviewer")).toMatchObject({ agent: "claude", model: null });
    expect(reviewer.runs[0]).toMatchObject({ model: undefined });
  });

  it("a chosen model and effort are kept for every turn of that session", async () => {
    const codex = new FakeAdapter();
    const hub = makeHub(new FakeAdapter(), codex);
    const task = await hub.createTask({ title: "", workflow: "chat", agent: "codex", model: "some-small-model", effort: "medium", message: "one" });
    await hub.settled(task.id);
    hub.sendMessage(task.id, "two");
    await hub.settled(task.id);
    expect(codex.runs.map((r) => [r.model, r.effort])).toEqual([
      ["some-small-model", "medium"],
      ["some-small-model", "medium"],
    ]);
  });
});

describe("reply language", () => {
  it.each(["chat", "implement", "review"] as const)("sets the reply and file languages for %s on both adapters", async (workflow) => {
    const author = new FakeAdapter((i, n) => turn(i, n, "done", { "x.txt": "x\n" }));
    const reviewer = new FakeAdapter((i, n) => turn(i, n, "VERDICT: approve\nFINDINGS: none"));
    const hub = makeHub(author, reviewer);
    const task = await hub.createTask({ title: "", workflow, agent: "claude", reviewer: "codex", repoPath: workflow === "chat" ? undefined : repo, message: "add x" });
    await hub.settled(task.id);
    for (const run of [...author.runs, ...reviewer.runs]) {
      expect(run.systemPrompt).toContain("Traditional Chinese (Taiwan usage)");
      expect(run.systemPrompt).toContain("even when the task or spec is written in English");
      expect(run.systemPrompt).toContain("Keep code, code comments, identifiers, and file contents you write in English");
    }
    if (workflow === "review") {
      expect(reviewer.runs.filter((r) => !r.toolsDisabled)).toHaveLength(1);
      expect(reviewer.runs[0]!.systemPrompt).toContain("Write your findings in Traditional Chinese");
      expect(reviewer.runs[0]!.systemPrompt).toContain("VERDICT: approve | changes");
      expect(reviewer.runs[0]!.systemPrompt).toContain("FINDINGS:");
      expect(reviewer.runs[0]!.systemPrompt).toContain("[high|medium|low]");
    }
  });
});

describe("parseReview", () => {
  it("takes the last verdict and reads findings in the common shapes", () => {
    const r = parseReview(
      [
        "I first thought VERDICT: approve but no.",
        "**VERDICT:** changes",
        "FINDINGS:",
        "- [high] src/a.ts:12 - off by one",
        "* [low] `src/b.ts:3-5` — naming",
        "- [medium] the README is missing the new flag",
      ].join("\n"),
    );
    expect(r).toEqual({
      verdict: "changes",
      findings: [
        { severity: "high", location: "src/a.ts:12", message: "off by one" },
        { severity: "low", location: "src/b.ts:3-5", message: "naming" },
        { severity: "medium", location: "", message: "the README is missing the new flag" },
      ],
    });
  });

  it("preserves Traditional Chinese findings with the existing English markers", () => {
    const message = "這裡會漏掉最後一筆資料";
    expect(parseReview(`VERDICT: changes\nFINDINGS:\n- [high] src/a.ts:12 - ${message}`)).toEqual({
      verdict: "changes",
      findings: [{ severity: "high", location: "src/a.ts:12", message }],
    });
  });

  it("returns null when there is no verdict", () => {
    expect(parseReview("looks fine to me")).toBeNull();
  });
});
