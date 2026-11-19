import { fakeUsage } from "./fixtures/usage";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentKind, DiffHunk, NewTaskInput, Workspace } from "@agent-hub/shared";
import { createApp } from "../src/app";
import { FakeAdapter, type FakeStep } from "../src/agents/fake";
import type { AgentRunInput } from "../src/agents/types";
import { Hub, parseExplanations } from "../src/core/hub";
import { openDb, schema } from "../src/db/index";
import { commitAll, diffHunks, squashWorktree } from "../src/workspace/git";

let root: string;
let repo: string;
let baseSha: string;
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const write = (file: string, contents: string | Buffer, cwd = repo) => fs.writeFileSync(path.join(cwd, file), contents);
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-hub-explanations-"));
  repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "fixture@example.invalid");
  git(repo, "config", "user.name", "Fixture");
  write("lines.txt", Array.from({ length: 40 }, (_, n) => `line ${n + 1}\n`).join(""));
  write("delete.txt", "remove me\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "fixture base");
  baseSha = git(repo, "rev-parse", "HEAD");
  vi.stubEnv("AGENT_HUB_EXPLAIN_AGENT", "codex");
  vi.stubEnv("AGENT_HUB_EXPLAIN_EFFORT", "low");
});
afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }); });
const ws = (): Workspace => ({ id: "fixture", repoPath: repo, worktreePath: repo, baseSha, baseRef: "main", branch: "main", state: "active" });
const response = (text: string): FakeStep[] => [{ type: "thread", threadId: "fixture-thread" }, { type: "text_start" }, { type: "text_delta", text }, { type: "done", ok: true, usage: structuredClone(fakeUsage) }];
const answer = (input: AgentRunInput) => response(JSON.stringify({ hunks: [...input.prompt.matchAll(/^Hunk id: (.+)$/gm)].map((m) => ({ id: JSON.parse(m[1]!), explanation: "\u8aaa\u660e" })) }));
const author = () => new FakeAdapter((input) => input.toolsDisabled ? answer(input) : [{ type: "write", path: "new.txt", content: "new content\n" }, ...response("Implementation complete")]);
const input = (workflow: "implement" | "review" = "implement", extra: Partial<NewTaskInput> = {}): NewTaskInput => ({ title: "Explain a change", workflow, agent: "claude", reviewer: "codex", repoPath: repo, message: "Add a file", ...extra });
const makeHub = (claude = author(), codex = new FakeAdapter(answer), fileDb = false) => new Hub({ db: openDb(fileDb ? path.join(root, "hub.db") : ":memory:"), dataDir: path.join(root, "data"), maxConcurrent: 4, agents: { claude, codex } });

describe("committed hunks", () => {
  it("keeps stable IDs and ranges, skips binary data, and excludes dirty work", async () => {
    write("lines.txt", fs.readFileSync(path.join(repo, "lines.txt"), "utf8").replace("line 2\n", "changed 2\n").replace("line 35\n", "changed 35\n"));
    write("a file.txt", "added\n");
    write('tab\tname.txt', "added tab path\n");
    write("binary.dat", Buffer.from([0, 1, 2, 3]));
    fs.unlinkSync(path.join(repo, "delete.txt"));
    await commitAll(repo, "fixture changes");
    write("dirty.txt", "not committed\n");
    const result = await diffHunks(ws());
    expect(result.skipped).toBe(0);
    expect(result.hunks).toHaveLength(5);
    expect(result.hunks.map((h) => h.path)).not.toContain("binary.dat");
    expect(result.hunks.map((h) => h.path)).not.toContain("dirty.txt");
    expect(result.hunks.find((h) => h.path === "a file.txt")).toMatchObject({ id: "a file.txt:0:1", oldStart: 0, oldLines: 0, newStart: 1, newLines: 1 });
    expect(result.hunks.find((h) => h.path === "delete.txt")).toMatchObject({ id: "delete.txt:1:0", oldStart: 1, oldLines: 1, newStart: 0, newLines: 0 });
    expect(result.hunks.filter((h) => h.path === "lines.txt")).toMatchObject([{ id: "lines.txt:1:1" }, { id: "lines.txt:32:32" }]);
    expect(await diffHunks(ws())).toEqual(result);
  });

  it("caps at 200 hunks and 120k patch characters and counts the omitted suffix", async () => {
    for (let n = 0; n < 202; n++) write(`file-${String(n).padStart(3, "0")}.txt`, "new\n");
    await commitAll(repo, "fixture many hunks");
    const result = await diffHunks(ws());
    expect(result.hunks).toHaveLength(200);
    expect(result.skipped).toBe(2);
    expect(result.hunks.reduce((n, h) => n + h.patch.length, 0)).toBeLessThanOrEqual(120_000);
    const prefix = await diffHunks(ws(), "HEAD", { hunks: 200, chars: result.hunks[0]!.patch.length });
    expect(prefix.hunks).toHaveLength(1);
    expect(prefix.skipped).toBe(201);
    write("aaa-large.txt", "x".repeat(120_001));
    await commitAll(repo, "fixture oversized first hunk");
    expect(await diffHunks(ws())).toMatchObject({ hunks: [], skipped: 203 });
  });
});

describe("explanation JSON", () => {
  const hunks: DiffHunk[] = [{ id: "file:1:1", path: "file", oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, patch: "@@ -1 +1 @@\n-old\n+new\n" }];
  it("extracts the first object, including braces and escapes in strings", () => {
    const explanation = 'Explain {a} and "b"';
    const text = '```json\n' + JSON.stringify({ hunks: [{ id: hunks[0]!.id, explanation }] }) + '\n``` trailing {}';
    expect(parseExplanations(text, hunks)).toEqual([{ id: "file:1:1", path: "file", explanation }]);
  });
  it("retains valid entries, discards unknown IDs, blank/wrong values, and deduplicates", () => {
    expect(parseExplanations(JSON.stringify({ hunks: [null, {}, { id: "unknown", explanation: "no" }, { id: "file:1:1", explanation: 9 }, { id: "file:1:1", explanation: "  " }, { id: "file:1:1", explanation: "valid" }, { id: "file:1:1", explanation: " valid " }] }), hunks)).toEqual([{ id: "file:1:1", path: "file", explanation: "valid" }]);
  });
  it.each(["garbage", "{broken}", '{"hunks": [', "{}", '{"hunks": null}'])("rejects unusable JSON: %s", (text) => expect(parseExplanations(text, hunks)).toEqual([]));
});

describe("generation lifecycle", () => {
  it("automatically explains an implementation commit in one fresh read-only call", async () => {
    const explainer = new FakeAdapter(answer);
    const hub = makeHub(author(), explainer);
    const task = await hub.createTask(input());
    await hub.settled(task.id);
    expect(explainer.runs).toHaveLength(1);
    expect(explainer.runs[0]).toMatchObject({ cwd: task.cwd, readOnly: true, toolsDisabled: true, effort: "low" });
    expect(explainer.runs[0]!.mcp).toBeUndefined();
    expect(explainer.runs[0]!.threadId).toBeUndefined();
    expect(explainer.runs[0]!.prompt).toContain("Add a file");
    expect(explainer.runs[0]!.prompt).toContain("+new content");
    expect(hub.getTask(task.id).sessions).toContainEqual(expect.objectContaining({ role: "explainer", agent: "codex", effort: "low", status: "done" }));
    expect(await hub.explanations(task.id)).toMatchObject({ headSha: git(task.cwd!, "rev-parse", "HEAD"), dirty: false, stale: false, generating: false, event: { type: "diff_explanations", items: [{ id: "new.txt:0:1", path: "new.txt", explanation: "\u8aaa\u660e" }] } });
    expect(git(task.cwd!, "status", "--porcelain")).toBe("");
    hub.sendMessage(task.id, "Same content again");
    await hub.settled(task.id);
    expect(explainer.runs).toHaveLength(1); // No commit, no automatic call.
  });

  it("explains only after review approval and passing tests, once after the final round", async () => {
    const claude = new FakeAdapter((_i, n) => [{ type: "write", path: "status.txt", content: n === 1 ? "broken\n" : "ok\n" }, ...response("Done")]);
    const codex = new FakeAdapter((i) => i.toolsDisabled ? answer(i) : response("VERDICT: approve\nFINDINGS: none"));
    const hub = makeHub(claude, codex);
    const task = await hub.createTask(input("review", { testCommand: "grep -q '^ok$' status.txt" }));
    await hub.settled(task.id);
    expect(codex.runs.filter((r) => r.toolsDisabled)).toHaveLength(1);
    const calls = hub.usageCalls(task.id).calls;
    expect(calls.map(c => [c.provider, c.role, c.purpose, c.round])).toEqual([
      ["claude", "author", "workflow", 1], ["codex", "reviewer", "workflow", 1],
      ["claude", "author", "workflow", 2], ["codex", "reviewer", "workflow", 2],
      ["codex", "explainer", "diff_explanation", null],
    ]);
    expect(new Set(calls.map(c => c.callId)).size).toBe(5);
    expect(hub.usageSummary(task.id)).toMatchObject({ calls: 5, inputInclusiveCache: 50, counters: { input: 50, output: 10, cachedInput: 20 } });

    const events = hub.events(task.id);
    expect(events.filter((e) => e.type === "test_result")).toMatchObject([{ exitCode: 1 }, { exitCode: 0 }]);
    expect(events.find((e) => e.type === "diff_explanations")!.seq).toBeGreaterThan(events.filter((e) => e.type === "test_result").at(-1)!.seq);
    expect(hub.getTask(task.id)).toMatchObject({ status: "idle", activity: expect.stringContaining("tests pass") });
  });

  it.each(["changes", "failed tests"])("does not explain unfinished review: %s", async (reason) => {
    const codex = new FakeAdapter(() => response(`VERDICT: ${reason === "changes" ? "changes" : "approve"}\nFINDINGS: none`));
    const hub = makeHub(author(), codex);
    const task = await hub.createTask(input("review", { maxRounds: 1, testCommand: reason === "failed tests" ? "exit 1" : undefined }));
    await hub.settled(task.id);
    expect(codex.runs.filter((r) => r.toolsDisabled)).toHaveLength(0);
    expect((await hub.explanations(task.id)).event).toBeNull();
  });

  it.each(["bad JSON", "quota"])("records final failure without changing status or preventing merge: %s", async (reason) => {
    const codex = new FakeAdapter(() => reason === "bad JSON" ? response("garbage") : [{ type: "done", ok: false, error: "Quota exhausted" }]);
    const claude = reason === "quota" ? new FakeAdapter((input) => input.toolsDisabled
      ? [{ type: "done", ok: false, error: "Quota exhausted" }]
      : [{ type: "write", path: "new.txt", content: "new content\n" }, ...response("Implementation complete")]) : author();
    const hub = makeHub(claude, codex);
    const task = await hub.createTask(input());
    await hub.settled(task.id);
    expect(codex.runs).toHaveLength(1);
    const measured = hub.usageCalls(task.id).calls;
    expect(measured).toHaveLength(reason === "quota" ? 3 : 2);
    expect(measured.filter(c => c.purpose === "diff_explanation").map(c => [c.provider, c.status])).toEqual(reason === "quota"
      ? [["codex", "usage_limit"], ["claude", "usage_limit"]] : [["codex", "success"]]);
    expect((await hub.explanations(task.id)).event).toMatchObject({ items: [], error: expect.stringMatching(/No valid|Quota/) });
    expect(hub.getTask(task.id).status).toBe("idle");
    await hub.merge(task.id);
    expect(hub.getTask(task.id).workspace!.state).toBe("merged");
  });

  it("keeps explanations and hunk mappings fresh after squashing task commits", async () => {
    const claude = new FakeAdapter((_input, n) => [{ type: "write", path: "new.txt", content: `round ${n}\n` }, ...response("Done")]);
    const hub = makeHub(claude);
    const task = await hub.createTask(input());
    await hub.settled(task.id);
    hub.sendMessage(task.id, "Update the file");
    await hub.settled(task.id);
    const saved = (await hub.explanations(task.id)).event!;
    const workspace = hub.getTask(task.id).workspace!;
    const hunks = await diffHunks(workspace);
    expect(saved.items).toHaveLength(1);
    expect(git(task.cwd!, "rev-list", "--count", `${workspace.baseSha}..HEAD`)).toBe("2");

    const squashed = await squashWorktree(workspace, "fixture squashed implementation");

    expect(squashed).not.toBe(saved.sha);
    expect(git(task.cwd!, "rev-parse", `${squashed}^{tree}`)).toBe(git(task.cwd!, "rev-parse", `${saved.sha}^{tree}`));
    expect(await hub.explanations(task.id)).toMatchObject({ headSha: squashed, dirty: false, stale: false, event: saved });
    expect(await diffHunks(workspace)).toEqual(hunks);
  });

  it("marks explanations stale without throwing when the explained commit has been garbage-collected", async () => {
    const hub = makeHub();
    const task = await hub.createTask(input());
    await hub.settled(task.id);
    const saved = (await hub.explanations(task.id)).event!;
    const squashed = await squashWorktree(hub.getTask(task.id).workspace!, "fixture squashed implementation");
    git(repo, "reflog", "expire", "--expire=now", "--all");
    git(repo, "gc", "--prune=now");
    expect(() => git(repo, "cat-file", "-e", `${saved.sha}^{commit}`)).toThrow();

    expect(await hub.explanations(task.id)).toMatchObject({ headSha: squashed, dirty: false, stale: true, event: saved });
  });

  it("persists events across restarts and detects changed trees and uncommitted work", async () => {
    const hub = makeHub(author(), new FakeAdapter(answer), true);
    const task = await hub.createTask(input());
    await hub.settled(task.id);
    const saved = (await hub.explanations(task.id)).event;
    const reloaded = makeHub(author(), new FakeAdapter(answer), true);
    expect((await reloaded.explanations(task.id)).event).toEqual(saved);
    write("untracked.txt", "dirty", task.cwd!);
    expect(await reloaded.explanations(task.id)).toMatchObject({ dirty: true, stale: true });
    await commitAll(task.cwd!, "fixture moved HEAD");
    expect(git(task.cwd!, "rev-parse", "HEAD^{tree}")).not.toBe(git(task.cwd!, "rev-parse", `${saved!.sha}^{tree}`));
    expect(await reloaded.explanations(task.id)).toMatchObject({ dirty: false, stale: true, event: saved });
    reloaded.regenerateExplanations(task.id);
    await reloaded.settled(task.id);
    expect(await reloaded.explanations(task.id)).toMatchObject({ stale: false, generating: false, event: { items: expect.any(Array) } });
    expect(hub.events(task.id).filter((e) => e.type === "diff_explanations")).toHaveLength(2);
  });

  it("honors configured adapter and effort with a fresh explainer session", async () => {
    vi.stubEnv("AGENT_HUB_EXPLAIN_AGENT", "claude");
    vi.stubEnv("AGENT_HUB_EXPLAIN_EFFORT", "medium");
    const claude = author();
    const codex = new FakeAdapter(answer);
    const hub = makeHub(claude, codex);
    const task = await hub.createTask(input());
    await hub.settled(task.id);
    expect(claude.runs[1]).toMatchObject({ toolsDisabled: true, effort: "medium", readOnly: true });
    expect(claude.runs[1]!.threadId).toBeUndefined();
    expect(codex.runs).toHaveLength(0);
    expect(hub.getTask(task.id).sessions.at(-1)).toMatchObject({ role: "explainer", agent: "claude", effort: "medium" });
  });

  it("serves authenticated GET/POST, returns 409 during a turn or another generation", async () => {
    const claude = author();
    claude.hold();
    const codex = new FakeAdapter(answer);
    const hub = makeHub(claude, codex);
    const task = await hub.createTask(input());
    const app = createApp(hub, "fixture-token");
    const url = `/api/tasks/${task.id}/explanations`;
    const headers = { authorization: "Bearer fixture-token" };
    expect((await app.request(url)).status).toBe(401);
    expect((await app.request(url, { method: "POST" })).status).toBe(401);
    expect((await app.request(url, { method: "POST", headers })).status).toBe(409);
    claude.release();
    await hub.settled(task.id);
    codex.hold();
    expect((await app.request(url, { method: "POST", headers })).status).toBe(202);
    await vi.waitFor(() => expect(codex.runs).toHaveLength(2));
    expect(await (await app.request(url, { headers })).json()).toMatchObject({ generating: true, event: { type: "diff_explanations" } });
    expect((await app.request(url, { method: "POST", headers })).status).toBe(409);
    codex.release();
    await hub.settled(task.id);
    expect((await app.request(url, { headers })).status).toBe(200);
  });

  it("does not hold merge while the explainer runs", async () => {
    const codex = new FakeAdapter(answer);
    codex.hold();
    const hub = makeHub(author(), codex);
    const task = await hub.createTask(input());
    await vi.waitFor(() => expect(codex.runs).toHaveLength(1));
    expect(hub.isBusy(task.id)).toBe(false);
    await hub.merge(task.id);
    codex.release();
    await hub.settled(task.id);
    expect(hub.getTask(task.id).workspace!.state).toBe("merged");
  });

  it("generates the newer final commit after an older explanation finishes", async () => {
    const claude = new FakeAdapter((_i, n) => [{ type: "write", path: "new.txt", content: `version ${n}\n` }, ...response("Done")]);
    const codex = new FakeAdapter(answer);
    codex.hold();
    const hub = makeHub(claude, codex);
    const task = await hub.createTask(input());
    await vi.waitFor(() => expect(codex.runs).toHaveLength(1));
    hub.sendMessage(task.id, "Update the file");
    await vi.waitFor(() => expect(claude.runs).toHaveLength(2));
    await vi.waitFor(() => expect(hub.isBusy(task.id)).toBe(false));
    codex.release();
    await hub.settled(task.id);
    expect(codex.runs).toHaveLength(2);
    expect(hub.events(task.id).filter((e) => e.type === "diff_explanations")).toHaveLength(2);
    expect(await hub.explanations(task.id)).toMatchObject({ stale: false, generating: false, headSha: git(task.cwd!, "rev-parse", "HEAD") });
  });

  it("records skipped oversized hunks without spending a model call", async () => {
    const claude = new FakeAdapter(() => [{ type: "write", path: "oversized.txt", content: "x".repeat(120_001) }, ...response("Done")]);
    const codex = new FakeAdapter(answer);
    const hub = makeHub(claude, codex);
    const task = await hub.createTask(input());
    await hub.settled(task.id);
    expect((await hub.explanations(task.id)).event).toMatchObject({ items: [], hunks: [], skipped: 1 });
    expect(codex.runs).toHaveLength(0);
  });

  it("keeps approved review and passing tests intact when explanation generation fails", async () => {
    const codex = new FakeAdapter((i) => i.toolsDisabled ? response("bad JSON") : response("VERDICT: approve\nFINDINGS: none"));
    const hub = makeHub(author(), codex);
    const task = await hub.createTask(input("review", { testCommand: "git diff --check" }));
    await hub.settled(task.id);
    expect(hub.getTask(task.id)).toMatchObject({ status: "idle", activity: expect.stringContaining("tests pass") });
    expect((await hub.explanations(task.id)).event).toMatchObject({ error: expect.stringContaining("No valid") });
    await hub.merge(task.id);
    expect(hub.getTask(task.id).workspace!.state).toBe("merged");
  });

  it("recovers a started event left without a result by a server crash", async () => {
    const hub = makeHub(author(), new FakeAdapter(answer), true);
    const task = await hub.createTask(input());
    await hub.settled(task.id);
    const db = openDb(path.join(root, "hub.db"));
    const result = (await hub.explanations(task.id)).event!;
    // Simulate the persisted state immediately before the explainer result was saved.
    db.delete(schema.events).where(eq(schema.events.id, result.id)).run();
    db.update(schema.sessions).set({ status: "running" }).where(eq(schema.sessions.id, result.sessionId!)).run();
    const codex = new FakeAdapter(answer);
    const reloaded = makeHub(author(), codex, true);
    expect(reloaded.recoverInterrupted()).toBe(0);
    expect(await reloaded.explanations(task.id)).toMatchObject({ generating: false, event: { sha: result.sha, error: "Explanation generation interrupted by server restart" } });
    expect(reloaded.getTask(task.id)).toMatchObject({ status: "idle", sessions: expect.arrayContaining([expect.objectContaining({ role: "explainer", status: "failed" })]) });
    expect(codex.runs).toHaveLength(0);
  });

  it("regenerates committed hunks only when the worktree has uncommitted changes", async () => {
    const codex = new FakeAdapter(answer);
    const hub = makeHub(author(), codex);
    const task = await hub.createTask(input());
    await hub.settled(task.id);
    write("dirty.txt", "Uncommitted content", task.cwd!);
    const before = git(task.cwd!, "rev-parse", "HEAD");
    hub.regenerateExplanations(task.id);
    await hub.settled(task.id);
    const explained = await hub.explanations(task.id);
    expect(explained).toMatchObject({ dirty: true, stale: true, headSha: before, event: { sha: before, items: [{ path: "new.txt" }] } });
    expect(codex.runs[1]!.prompt).not.toContain("Uncommitted content");
    expect(fs.readFileSync(path.join(task.cwd!, "dirty.txt"), "utf8")).toBe("Uncommitted content");
    expect(codex.runs[1]!.threadId).toBeUndefined();
    expect(hub.getTask(task.id).sessions.filter((s) => s.role === "explainer")).toHaveLength(1);
  });

  it("marks interrupted generation failed after restart without changing task status or retrying", async () => {
    const codex = new FakeAdapter(answer);
    codex.hold();
    const hub = makeHub(author(), codex, true);
    const task = await hub.createTask(input());
    await vi.waitFor(() => expect(codex.runs).toHaveLength(1));
    await hub.shutdown(100);
    const reloaded = makeHub(author(), new FakeAdapter(answer), true);
    reloaded.recoverInterrupted();
    expect(await reloaded.explanations(task.id)).toMatchObject({ generating: false, event: { error: expect.stringContaining("interrupted") } });
    expect(reloaded.getTask(task.id).status).toBe("idle");
    expect(codex.runs).toHaveLength(1);
  });
});

describe("Gemini explanations", () => {
  const setup = (gemini?: FakeAdapter, codex = new FakeAdapter(answer), claude = author()) => new Hub({
    db: openDb(":memory:"), dataDir: path.join(root, "data"), maxConcurrent: 4,
    agents: { claude, codex, ...(gemini ? { gemini } : {}) },
  });

  it.each([false, true])("defaults to Gemini only when registered (%s), without transcript or task history", async registered => {
    vi.stubEnv("AGENT_HUB_EXPLAIN_AGENT", undefined);
    const gemini = new FakeAdapter(answer), codex = new FakeAdapter(answer);
    const hub = setup(registered ? gemini : undefined, codex);
    const task = await hub.createTask(input());
    await hub.settled(task.id);
    const selected = registered ? gemini : codex;
    expect(selected.runs).toHaveLength(1);
    expect(selected.runs[0]).toMatchObject({ readOnly: true, toolsDisabled: true });
    for (const key of ["recent", "threadId", "mcp", "images"] as const) expect(selected.runs[0]![key]).toBeUndefined();
    expect(selected.runs[0]!.prompt).not.toContain("Implementation complete");
    expect((await hub.explanations(task.id)).event).toMatchObject({ writtenBy: registered ? "gemini" : "codex", items: [{ path: "new.txt" }] });
    expect(hub.getTask(task.id).sessions.at(-1)).toMatchObject({ agent: registered ? "gemini" : "codex", role: "explainer", status: "done" });
  });

  it.each(["gemini", "codex", "claude"] as AgentKind[])("honors explicit %s with Gemini registered", async agent => {
    vi.stubEnv("AGENT_HUB_EXPLAIN_AGENT", agent);
    const hub = setup(new FakeAdapter(answer));
    const task = await hub.createTask(input());
    await hub.settled(task.id);
    expect((await hub.explanations(task.id)).event).toMatchObject({ writtenBy: agent });
  });

  it("clearly rejects an invalid configured explainer", async () => {
    vi.stubEnv("AGENT_HUB_EXPLAIN_AGENT", "invalid");
    const gemini = new FakeAdapter(answer), codex = new FakeAdapter(answer);
    const hub = setup(gemini, codex);
    const task = await hub.createTask(input());
    await hub.settled(task.id);
    expect((await hub.explanations(task.id)).event).toMatchObject({ error: "Invalid explainer agent configuration" });
    expect([...gemini.runs, ...codex.runs]).toHaveLength(0);
  });

  it.each(["available", "exhausted", "unknown-reset", "missing", "retry-fails"])("falls back once after Gemini quota failure with Codex %s", async mode => {
    vi.stubEnv("AGENT_HUB_EXPLAIN_AGENT", "gemini");
    const failure = (): FakeStep[] => [{ type: "done", ok: false, error: "Gemini usage limit reached" }];
    const gemini = new FakeAdapter(failure);
    const codex = new FakeAdapter(mode === "retry-fails" ? failure : answer);
    codex.quotaScript = async () => ({ status: "ok", windows: [{ id: "main", bucket: "Main", durationMins: null,
      remainingPercent: ["exhausted", "unknown-reset"].includes(mode) ? 0 : 100,
      resetsAt: mode === "unknown-reset" ? null : new Date(Date.now() + 60_000).toISOString() }] });
    const claude = author();
    const hub = mode === "missing"
      ? new Hub({ db: openDb(":memory:"), dataDir: path.join(root, "data"), maxConcurrent: 4, agents: { claude, gemini } })
      : setup(gemini, codex, claude);
    const task = await hub.createTask(input());
    await hub.settled(task.id);
    const result = (await hub.explanations(task.id)).event;
    const useClaude = ["exhausted", "unknown-reset", "missing"].includes(mode);
    expect(result).toMatchObject(mode === "retry-fails" ? { error: "Gemini usage limit reached", limit: { agent: "codex" } }
      : { writtenBy: useClaude ? "claude" : "codex", fallbackFrom: { agent: "gemini" } });
    expect(gemini.runs).toHaveLength(1);
    expect(codex.runs).toHaveLength(useClaude ? 0 : 1);
    expect(claude.runs.filter(i => i.toolsDisabled)).toHaveLength(useClaude ? 1 : 0);
  });

  it.each(["bad JSON", "tool attempt", "timeout"])("does not fall back after Gemini %s", async mode => {
    vi.stubEnv("AGENT_HUB_EXPLAIN_AGENT", "gemini");
    const gemini = new FakeAdapter(() => mode === "bad JSON" ? response("garbage") : [{ type: "done", ok: false,
      error: mode === "tool attempt" ? "Gemini attempted a tool; the run was stopped" : "Gemini turn timed out after 5 minutes" }]);
    const codex = new FakeAdapter(answer), claude = author();
    const hub = setup(gemini, codex, claude);
    const task = await hub.createTask(input());
    await hub.settled(task.id);
    expect((await hub.explanations(task.id)).event?.error).toBeTruthy();
    expect(codex.runs).toHaveLength(0);
    expect(claude.runs).toHaveLength(1);
    expect(hub.getTask(task.id).status).toBe("idle");
  });
});
