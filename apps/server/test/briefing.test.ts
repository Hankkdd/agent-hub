import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { AgentKind, Task, TaskEvent, Workspace } from "@agent-hub/shared";
import { FakeAdapter } from "../src/agents/fake";
import { Hub } from "../src/core/hub";
import { openDb, schema } from "../src/db/index";
import { createApp } from "../src/app";
import { captureBriefing, validateBriefing, validateBriefingDiagram, composeBriefing, briefingAppendix, BRIEFING_SYSTEM } from "../src/core/briefing";
import { commitAll, revisionText, squashWorktree } from "../src/workspace/git";
import * as workspaceGit from "../src/workspace/git";
import { briefingFixture } from "./briefing-fixture";

let root: string;
let repo: string;
let hubs: Hub[];
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "hub-briefing-")); repo = path.join(root, "repo"); fs.mkdirSync(repo); hubs = [];
  git(repo, "init", "-q", "-b", "main"); git(repo, "config", "user.email", "fixture@example.invalid"); git(repo, "config", "user.name", "Fixture");
  fs.writeFileSync(path.join(repo, "README.md"), "Fixture repository\n");
  fs.writeFileSync(path.join(repo, "deleted.ts"), "export function removed() {}\n");
  git(repo, "add", "."); git(repo, "commit", "-qm", "base");
});
afterEach(async () => { vi.useRealTimers(); vi.unstubAllEnvs(); await Promise.all(hubs.map((h) => h.shutdown(100))); fs.rmSync(root, { recursive: true, force: true }); });
function setup(team = false, maxConcurrent = 4) {
  const db = openDb(path.join(root, "hub.db"));
  const dataDir = path.join(root, "data"); fs.mkdirSync(dataDir, { recursive: true });
  if (team) fs.writeFileSync(path.join(dataDir, "repos.json"), JSON.stringify({ [repo]: { prLanguage: "en" } }));
  let malformed = false;
  const author = new FakeAdapter((input) => {
    const briefing = briefingFixture(input);
    if (briefing) return malformed ? [{ type: "text_delta", text: "{}" }, { type: "done", ok: true }] : briefing;
    if (input.toolsDisabled) return [{ type: "text_delta", text: input.systemPrompt?.includes("metadata") ? JSON.stringify({ type: "feat", summary: "Add answer", slug: "add-answer", body: "## Purpose\n\nAdd answer." }) : '{"hunks":[]}' }, { type: "done", ok: true }];
    if (input.systemPrompt?.includes("code reviewer")) return [{ type: "text_delta", text: "VERDICT: approve\nFINDINGS: none" }, { type: "done", ok: true }];
    return [{ type: "write", path: "answer.ts", content: "export function answer() { return 42; }\n" }, { type: "text_delta", text: "Implemented answer, tests not run." }, { type: "done", ok: true }];
  });
  const forge = { repoOf: vi.fn(async () => "example/project"), push: vi.fn(async () => {}), openPullRequest: vi.fn(async (_ws: Workspace, _repo: string, _title: string, _body: string) => ({ number: 13, url: "https://example.invalid/pr/13", state: "open" as const })), state: vi.fn(async () => "open" as const), close: vi.fn(async () => {}), listIssues: vi.fn(async () => []), readIssue: vi.fn(async () => { throw new Error("unused"); }) };
  const hub = new Hub({ db, dataDir, maxConcurrent, agents: { codex: author, claude: author }, forge }); hubs.push(hub);
  const create = async (agent: AgentKind = "codex", workflow: "implement" | "review" = "implement") => {
    const task = await hub.createTask({ title: "Answer", repoPath: repo, workflow, agent, reviewer: "claude", message: "Implement answer without claiming tests ran" }); await hub.settled(task.id); return hub.getTask(task.id);
  };
  return { hub, author, forge, db, create, fail: () => { malformed = true; }, succeed: () => { malformed = false; } };
}
const generations = (hub: Hub, id: string) => hub.events(id).filter((e) => e.type === "briefing_started");
const confirm = (draft: Extract<TaskEvent, { type: "pr_draft" }>) => ({ draftId: draft.id, branch: draft.branch, commitMessage: draft.commitMessage, title: draft.title, body: draft.body });

const fullPatch = (cwd: string, base: string, file: string) => execFileSync("git", ["diff", "--no-renames", "--no-ext-diff", "--no-textconv", "--no-color", "--unified=3", base, "--", file], { cwd, encoding: "utf8" });
const coverageBytes = (files: { text: string; patch: string }[]) => files.reduce((sum, f) => sum + Buffer.byteLength(f.text) + Buffer.byteLength(f.patch), 0);

async function budgetFixture(bytes: number) {
  // Unchanged middle data consumes complete-source coverage, but stays outside the small patch hunks.
  const files = Array.from({ length: 5 }, (_, n) => ({ path: `budget-${n}.ts`, text: "export const value = 0;\n" + "// context\n".repeat(8) + "// " + "x".repeat(110000) + "\u6e2c\u8a66\n" }));
  for (const f of files) fs.writeFileSync(path.join(repo, f.path), f.text);
  await commitAll(repo, "budget base probe");
  const answer = { path: "answer.ts", text: "export function answer() { return 42; }\n" };
  const changed = (text: string) => text.replace("value = 0", "value = 1");
  for (const f of files) fs.writeFileSync(path.join(repo, f.path), changed(f.text));
  fs.writeFileSync(path.join(repo, answer.path), answer.text); git(repo, "add", ".");
  const measured = coverageBytes([...files.map((f) => ({ text: changed(f.text), patch: fullPatch(repo, "HEAD", f.path) })), { text: answer.text, patch: fullPatch(repo, "HEAD", answer.path) }]);
  const extra = bytes - measured;
  expect(extra).toBeGreaterThan(0);
  // Padding unchanged base/head data changes source bytes only; Git object IDs retain their fixed width.
  for (let n = 0; n < files.length; n++) {
    const f = files[n]!;
    f.text += "// " + "x".repeat(Math.floor(extra / files.length) + (n < extra % files.length ? 1 : 0) - 4) + "\n";
    expect(Buffer.byteLength(f.text)).toBeLessThan(200_000);
    fs.writeFileSync(path.join(repo, f.path), f.text);
  }
  fs.unlinkSync(path.join(repo, answer.path)); await commitAll(repo, "calibrated budget base");
  return async (task: Task) => {
    for (const f of files) fs.writeFileSync(path.join(task.cwd!, f.path), changed(f.text));
    await commitAll(task.cwd!, "small budget fixture edits");
    const expected = [answer, ...files.map((f) => ({ path: f.path, text: changed(f.text) }))].map((f) => ({ ...f, patch: fullPatch(task.cwd!, task.workspace!.baseSha, f.path) }));
    expect(coverageBytes(expected)).toBe(bytes);
    expect(expected.reduce((sum, f) => sum + f.text.length + f.patch.length, 0)).toBeLessThan(bytes);
    return expected;
  };
}

it.each([ ["codex", "implement"], ["claude", "implement"], ["codex", "review"], ["claude", "review"] ] as const)("generates explicitly on ordinary open for %s/%s, preserving readiness and source", async (agent, workflow) => {
  vi.stubEnv("AGENT_HUB_BRIEFING_EFFORT", "medium");
  const { hub, author, forge, create } = setup(); const task = await create(agent, workflow);
  const before = { head: git(repo, "rev-parse", "HEAD"), status: git(repo, "status", "--porcelain") };
  expect(generations(hub, task.id)).toEqual([]);
  expect((await hub.briefing(task.id)).state).toBe("empty");
  expect(generations(hub, task.id)).toEqual([]);
  const readiness = hub.getTask(task.id).status;
  const [a, b] = await Promise.all([hub.openPr(task.id), hub.openPr(task.id)]);
  expect(a).toEqual(b); expect(forge.push).toHaveBeenCalledTimes(1); expect(forge.openPullRequest).toHaveBeenCalledTimes(1);
  const briefing = (await hub.briefing(task.id)).briefing!;
  expect(forge.openPullRequest.mock.calls[0]![3]).toBe(composeBriefing((hub as unknown as { prBody(t: Task): string }).prBody(task), briefing));
  expect(generations(hub, task.id)).toHaveLength(1);
  const run = author.runs.find((r) => r.systemPrompt === BRIEFING_SYSTEM)!;
  expect(run).toMatchObject({ readOnly: true, toolsDisabled: true, effort: task.sessions[0]!.effort });
  expect(run.threadId).toBeUndefined(); expect(run.mcp).toBeUndefined(); expect(run.referenceDirs).toBeUndefined();
  expect(run.prompt).not.toContain("documentsDir");
  expect(BRIEFING_SYSTEM).toContain("inference and unknowns"); expect(BRIEFING_SYSTEM).toContain("historical rejected alternatives");
  expect(hub.getTask(task.id).status).toBe(readiness);
  expect({ head: git(repo, "rev-parse", "HEAD"), status: git(repo, "status", "--porcelain") }).toEqual(before);
  expect(hub.events(task.id).filter((e) => e.type.startsWith("finding_"))).toEqual([]);
});

it.each([undefined, "medium"])("uses configured briefing effort %s while preserving the author model", async (effort) => {
  vi.stubEnv("AGENT_HUB_BRIEFING_EFFORT", effort);
  const { hub, author, db, create } = setup(); const task = await create();
  db.update(schema.sessions).set({ effort: "high", model: "author-model" }).where(eq(schema.sessions.id, task.sessions[0]!.id)).run();
  await hub.generateBriefing(task.id);
  expect(author.runs.find((r) => r.systemPrompt === BRIEFING_SYSTEM)).toMatchObject({
    effort: effort ?? "low", model: "author-model",
  });
});

it("records invalid briefing effort configuration without running the adapter", async () => {
  vi.stubEnv("AGENT_HUB_BRIEFING_EFFORT", "invalid");
  const { hub, author, create } = setup(); const task = await create();
  await expect(hub.generateBriefing(task.id)).rejects.toThrow("Invalid briefing effort configuration: AGENT_HUB_BRIEFING_EFFORT");
  expect(hub.events(task.id).filter((e) => e.type === "briefing_failed")).toMatchObject([
    { error: "Invalid briefing effort configuration: AGENT_HUB_BRIEFING_EFFORT", interrupted: false },
  ]);
  expect(author.runs.filter((r) => r.systemPrompt === BRIEFING_SYSTEM)).toEqual([]);
  vi.stubEnv("AGENT_HUB_BRIEFING_EFFORT", "low");
  await expect(hub.generateBriefing(task.id)).resolves.toBeDefined();
});

it("coalesces generation, reuses current content, ignores unchanged-tree squash and explicitly rewrites", async () => {
  const { hub, author, create } = setup(); const task = await create();
  const [a, b] = await Promise.all([hub.generateBriefing(task.id), hub.generateBriefing(task.id)]);
  expect(hub.usageCalls(task.id).calls.filter(c => c.purpose === "change_briefing")).toHaveLength(1);

  expect(a.generationId).toBe(b.generationId);
  expect((await hub.generateBriefing(task.id)).generationId).toBe(a.generationId);
  await squashWorktree(task.workspace!, "publication squash");
  expect((await hub.briefing(task.id)).state).toBe("current");
  const rewritten = await hub.generateBriefing(task.id, true); expect(rewritten.generationId).not.toBe(a.generationId);
  expect(author.runs.filter((r) => r.systemPrompt === BRIEFING_SYSTEM)).toHaveLength(2);
});

it("preserves successful content after failure, fails before push, and retains coding/review/test readiness", async () => {
  const { hub, forge, create, fail } = setup(); const task = await create("claude", "review");
  const first = await hub.generateBriefing(task.id); const readiness = hub.getTask(task.id);
  fail(); await expect(hub.generateBriefing(task.id, true)).rejects.toThrow();
  expect(await hub.briefing(task.id)).toMatchObject({ state: "failed", briefing: { generationId: first.generationId } });
  await expect(hub.openPr(task.id)).rejects.toThrow(); expect(forge.push).not.toHaveBeenCalled(); expect(forge.openPullRequest).not.toHaveBeenCalled();
  expect(hub.getTask(task.id).status).toBe(readiness.status); expect(hub.getTask(task.id).sessions).toEqual(readiness.sessions);
});

it("binds sources to follow-ups, code and guides, rejects dirty work and records specific coverage failure", async () => {
  const { hub, create } = setup(); const task = await create(); const initial = await hub.generateBriefing(task.id);
  fs.writeFileSync(path.join(task.cwd!, "dirty.txt"), "uncommitted");
  expect((await hub.briefing(task.id)).state).toBe("stale");
  await expect(hub.generateBriefing(task.id)).rejects.toThrow(/clean committed/);
  fs.unlinkSync(path.join(task.cwd!, "dirty.txt"));
  hub.sendMessage(task.id, "Please also explain the follow-up."); await hub.settled(task.id);
  const followup = await hub.generateBriefing(task.id); expect(followup.source.contextId).not.toBe(initial.source.contextId);
  fs.mkdirSync(path.join(task.cwd!, "docs/ai-guides"), { recursive: true }); fs.writeFileSync(path.join(task.cwd!, "docs/ai-guides/cara-explanation-style.md"), "Explain why before how.\n");
  await commitAll(task.cwd!, "guide"); expect((await hub.briefing(task.id)).state).toBe("stale");
  const styled = await hub.generateBriefing(task.id); expect(styled.source.guides.map((g) => g.path)).toContain("docs/ai-guides/cara-explanation-style.md");
  fs.writeFileSync(path.join(task.cwd!, "too-large.txt"), "x".repeat(200001)); await commitAll(task.cwd!, "large");
  await expect(hub.generateBriefing(task.id)).rejects.toThrow(/200000 bytes/);
  expect((await hub.briefing(task.id)).briefing?.generationId).toBe(styled.generationId);
});

it("rejects concurrent committed/dirty code changes and Stop, never accepts late results", async () => {
  const { hub, author, create } = setup(); const task = await create();
  for (const action of ["committed", "dirty", "stop"] as const) {
    author.hold(); const pending = hub.generateBriefing(task.id, true); void pending.catch(() => {});
    await vi.waitFor(() => expect(author.runs.filter((r) => r.systemPrompt === BRIEFING_SYSTEM)).toHaveLength(["committed", "dirty", "stop"].indexOf(action) + 1));
    if (action === "stop") hub.stop(task.id);
    else { fs.writeFileSync(path.join(task.cwd!, "concurrent.ts"), `export const concurrent = '${action}';\n`); if (action === "committed") await commitAll(task.cwd!, "concurrent"); }
    author.release(); await expect(pending).rejects.toThrow(/source changed|interrupted|clean committed/);
    if (action === "dirty") await commitAll(task.cwd!, "finish concurrent");
  }
  expect(hub.events(task.id).filter((e) => e.type === "briefing_completed")).toEqual([]);
  expect((await hub.briefing(task.id)).state).toBe("failed");
});

it("restores content/outcomes and marks orphaned started events interrupted without model runs", async () => {
  const { hub, author, db, create } = setup(); const task = await create(); const success = await hub.generateBriefing(task.id);
  const latest = hub.events(task.id).at(-1)!;
  db.insert(schema.events).values({ id: "orphan", taskId: task.id, sessionId: null, seq: latest.seq + 1, type: "briefing_started", payload: { generationId: "orphan" }, createdAt: new Date().toISOString() }).run();
  const runs = author.runs.length; hub.recoverInterrupted();
  expect(await hub.briefing(task.id)).toMatchObject({ state: "failed", briefing: { generationId: success.generationId }, error: expect.stringContaining("restart") });
  expect(author.runs).toHaveLength(runs);
});

it("uses authenticated read/retry API only and cannot generate for unrelated workflows", async () => {
  const { hub, create } = setup(); const task = await create(); const app = createApp(hub, "fixture-token");
  const url = `/api/tasks/${task.id}/briefing`;
  expect((await app.request(url)).status).toBe(401);
  const headers = { authorization: "Bearer fixture-token", "content-type": "application/json" };
  expect((await app.request(url, { headers })).status).toBe(200); expect(generations(hub, task.id)).toHaveLength(0);
  expect((await app.request(url, { method: "POST", headers, body: "{}" })).status).toBe(200);
  const chat = await hub.createTask({ title: "Chat", workflow: "chat", message: "Read only" }); await hub.settled(chat.id);
  expect(() => hub.generateBriefing(chat.id)).toThrow(/worktree/);
});

it("validates complete tours, deleted/base references, symbols, lines and structured output bounds", async () => {
  const { hub, create } = setup(); const task = await create(); fs.unlinkSync(path.join(task.cwd!, "deleted.ts")); await commitAll(task.cwd!, "delete");
  const captured = await captureBriefing(hub.getTask(task.id), hub.events(task.id));
  const fixture = briefingFixture({ prompt: JSON.stringify(captured), systemPrompt: BRIEFING_SYSTEM } as never)!;
  const content = JSON.parse((fixture[0] as { text: string }).text);
  expect((await validateBriefing(JSON.stringify(content), captured, task.cwd!)).tour.find((s) => s.path === "deleted.ts")?.revision).toBe("base");
  for (const mutate of [ (v: typeof content) => { v.tour.pop(); }, (v: typeof content) => { v.tour[0].path = "../escape"; }, (v: typeof content) => { v.tour[0].symbol = "inventedSymbol"; }, (v: typeof content) => { v.tour[0].line = 999; }, (v: typeof content) => { v.tour.find((s: { path: string }) => s.path === "deleted.ts").revision = "head"; }, (v: typeof content) => { v.problem = "</details>"; }, (v: typeof content) => { v.diagram = "flowchart TD\n A --> B\n click A href https://example.invalid"; }, (v: typeof content) => { v.risks = "```escape"; } ]) {
    const invalid = structuredClone(content); mutate(invalid); await expect(validateBriefing(JSON.stringify(invalid), captured, task.cwd!)).rejects.toThrow();
  }
  await expect(validateBriefing("x".repeat(48001), captured, task.cwd!)).rejects.toThrow(/48000/);
  await expect(validateBriefing('{"tour":', captured, task.cwd!)).rejects.toThrow();
});

it("rejects unsafe/unreadable identified guides and binary sources using revision reads", async () => {
  const { hub, create } = setup(); const task = await create();
  for (const unsafe of ["../escape.md", "/etc/passwd", "a/../../escape", "C:/secret", ".git/config", "a\\b"]) await expect(revisionText(task.cwd!, task.workspace!.baseSha, unsafe)).rejects.toThrow();
  fs.writeFileSync(path.join(task.cwd!, "README.md"), "[Explanation style](docs/missing.md)\n"); await commitAll(task.cwd!, "missing guide");
  await expect(hub.generateBriefing(task.id)).rejects.toThrow(/unavailable: docs\/missing.md/);
  fs.mkdirSync(path.join(task.cwd!, "docs")); fs.symlinkSync("../answer.ts", path.join(task.cwd!, "docs/missing.md")); await commitAll(task.cwd!, "unsafe guide");
  await expect(hub.generateBriefing(task.id)).rejects.toThrow(/ordinary file/);
  fs.unlinkSync(path.join(task.cwd!, "docs/missing.md")); fs.writeFileSync(path.join(task.cwd!, "README.md"), "Fixture\n");
  fs.writeFileSync(path.join(task.cwd!, "binary.dat"), Buffer.from([0, 1, 2])); await commitAll(task.cwd!, "binary");
  await expect(hub.generateBriefing(task.id)).rejects.toThrow(/binary/);
});

it("previews one exact appendix, preserves human edits on rewrite, invalidates old confirmation and blocks injection", async () => {
  const { hub, forge, create } = setup(true); const task = await create();
  const [first, duplicate] = await Promise.all([hub.preparePrDraft(task.id), hub.preparePrDraft(task.id)]); expect(first.id).toBe(duplicate.id);
  expect(hub.usageCalls(task.id).calls.filter(c => c.purpose === "pr_metadata")).toHaveLength(1);
  expect(hub.usageCalls(task.id).calls.filter(c => c.purpose === "change_briefing")).toHaveLength(1);

  const briefing = (await hub.briefing(task.id)).briefing!;
  const edited = await hub.editPrDraft(task.id, { ...confirm(first), title: "Human title", body: "Human main body" + briefingAppendix(briefing) });
  await hub.generateBriefing(task.id, true);
  await expect(hub.openPr(task.id, confirm(edited))).rejects.toThrow(/current briefing/); expect(forge.push).not.toHaveBeenCalled();
  const fresh = await hub.preparePrDraft(task.id);
  expect(fresh.title).toBe("Human title"); expect(fresh.body).toContain("Human main body"); expect(fresh.body.match(/<details /g)).toHaveLength(1);
  await expect(hub.openPr(task.id, { ...confirm(fresh), body: fresh.body + "</details>" })).rejects.toThrow(/composed briefing/);
  expect(forge.push).not.toHaveBeenCalled(); await hub.openPr(task.id, confirm(fresh));
  expect(forge.openPullRequest.mock.calls[0]![3]).toBe(fresh.body);
});

it.each(["stop", "shutdown"] as const)("rejects late results from an adapter ignoring %s cancellation, without blocking explicit retry", async (action) => {
  const { hub, author, create } = setup(); const task = await create();
  const original = author.run.bind(author);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let entered = false;
  author.run = async function* (input) {
    const fixture = briefingFixture(input);
    if (!fixture) { yield* original(input); return; }
    entered = true; await gate;
    for (const event of fixture) if (event.type !== "write" && event.type !== "ask") yield event;
  };
  const pending = hub.generateBriefing(task.id); void pending.catch(() => {});
  await vi.waitFor(() => expect(entered).toBe(true));
  if (action === "stop") hub.stop(task.id); else await hub.shutdown(100);
  await expect(pending).rejects.toThrow("Briefing generation interrupted");
  expect(hub.events(task.id).filter((e) => e.type === "briefing_failed").at(-1)).toMatchObject({ error: "Briefing generation interrupted", interrupted: true });
  expect((await hub.briefing(task.id)).state).toBe("failed");
  if (action === "stop") { author.run = original; await hub.generateBriefing(task.id, true); }
  const completed = hub.events(task.id).filter((e) => e.type === "briefing_completed").length;
  release(); await new Promise((resolve) => setImmediate(resolve)); await new Promise((resolve) => setImmediate(resolve));
  expect(hub.events(task.id).filter((e) => e.type === "briefing_completed")).toHaveLength(completed);
});

it("enforces the finite model deadline without retry, even if the model never completes", async () => {
  const { hub, author, create } = setup(); const task = await create();
  let entered = false; let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  author.run = async function* () { entered = true; await gate; yield { type: "done", ok: true }; };
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const pending = hub.generateBriefing(task.id); void pending.catch(() => {});
  // Real Git processes keep running; only the finite generation timer is virtualized.
  for (let n = 0; n < 1000 && !entered; n++) await new Promise((resolve) => setImmediate(resolve));
  await vi.advanceTimersByTimeAsync(299_999);
  expect(hub.events(task.id).filter((e) => e.type === "briefing_failed")).toEqual([]);
  await vi.advanceTimersByTimeAsync(1);
  await expect(pending).rejects.toThrow("Briefing generation timed out after 5 minutes");
  expect(hub.events(task.id).filter((e) => e.type === "briefing_failed")).toMatchObject([
    { error: "Briefing generation timed out after 5 minutes", interrupted: true },
  ]);
  vi.useRealTimers(); release();
  expect(hub.events(task.id).filter((e) => e.type === "briefing_completed")).toEqual([]);
  expect((await hub.briefing(task.id)).state).toBe("failed");
});

it("invalidates changed base trees, preserves captured guide versions, and excludes metadata from later source context", async () => {
  const { hub, create, db } = setup(true); const task = await create();
  const first = await hub.preparePrDraft(task.id);
  const initial = (await hub.briefing(task.id)).briefing!;
  const metadata = hub.events(task.id).filter((e) => e.type === "agent_text" && e.purpose === "pr_metadata"); expect(metadata.length).toBeGreaterThan(0);
  hub.sendMessage(task.id, "Follow up with no source changes"); await hub.settled(task.id);
  const captured = await captureBriefing(hub.getTask(task.id), hub.events(task.id));
  expect(captured.context.evidence.filter((e) => e.type === "agent_text").some((e) => e.type === "agent_text" && e.text.includes('"slug"'))).toBe(false);
  db.update(schema.tasks).set({ workspace: { ...hub.getTask(task.id).workspace!, baseSha: git(task.cwd!, "rev-parse", "HEAD") } }).where(eq(schema.tasks.id, task.id)).run();
  expect((await hub.briefing(task.id)).state).toBe("stale");
  await expect(hub.openPr(task.id, confirm(first))).rejects.toThrow(/current briefing/);
  expect((await hub.briefing(task.id)).briefing?.source.headSha).toBe(initial.source.headSha);
});

it("fails bounded manifest/patch coverage and invalid guide paths without altering the index", async () => {
  const { hub, create } = setup(); const task = await create();
  for (let n = 0; n < 80; n++) fs.writeFileSync(path.join(task.cwd!, `file-${n}.txt`), "source\n");
  await commitAll(task.cwd!, "many files");
  const index = fs.readFileSync(git(task.cwd!, "rev-parse", "--git-path", "index"));
  await expect(hub.generateBriefing(task.id)).rejects.toThrow(/80 changed/);
  expect(fs.readFileSync(git(task.cwd!, "rev-parse", "--git-path", "index"))).toEqual(index);
});

it("reads named guidance from captured revisions even when the mutable guide changes, and rejects invented supporting tours", async () => {
  const { hub, create } = setup(); const task = await create();
  fs.mkdirSync(path.join(task.cwd!, "docs")); fs.writeFileSync(path.join(task.cwd!, "docs/style.md"), "Explain the source before inference.\n");
  fs.writeFileSync(path.join(task.cwd!, "README.md"), "[Explanation style](docs/style.md)\n"); await commitAll(task.cwd!, "guide");
  const captured = await captureBriefing(hub.getTask(task.id), hub.events(task.id));
  fs.writeFileSync(path.join(task.cwd!, "docs/style.md"), "Mutable content must not be used.\n");
  expect(captured.guides.find((g) => g.path === "docs/style.md")?.text).toBe("Explain the source before inference.\n");
  const result = briefingFixture({ prompt: JSON.stringify(captured), systemPrompt: BRIEFING_SYSTEM } as never)!;
  const content = JSON.parse((result[0] as { text: string }).text);
  content.tour.push({ path: "deleted.ts", line: 1, symbol: "removed", supporting: true, revision: "head", explanation: "輔助來源" });
  await expect(validateBriefing(JSON.stringify(content), captured, task.cwd!)).rejects.toThrow(/not supplied/);
});

it("accounts for large generated/lockfile data with full patches, explicit source coverage and validated tour roles", async () => {
  const { hub, create } = setup(); const task = await create();
  fs.writeFileSync(path.join(task.cwd!, "pnpm-lock.yaml"), "lockfileVersion: 9\n" + "dependency: fixture\n".repeat(12000));
  await commitAll(task.cwd!, "generated lockfile");
  const captured = await captureBriefing(hub.getTask(task.id), hub.events(task.id));
  const file = captured.change.files.find((f) => f.path === "pnpm-lock.yaml")!;
  expect(file.generated).toBe(true); expect(file.sourceExcerpt).toBe(true); expect(file.text.length).toBeLessThanOrEqual(16000); expect(file.patch).toContain("dependency: fixture");
  const briefing = await hub.generateBriefing(task.id);
  expect(briefing.source.generatedFiles).toEqual(["pnpm-lock.yaml"]); expect(briefing.markdown).toContain("未提供未變更的其餘來源");
  const invalid = structuredClone(briefing.content); invalid.tour.find((s) => s.path === "pnpm-lock.yaml")!.explanation = "未說明檔案用途。";
  await expect(validateBriefing(JSON.stringify(invalid), captured, task.cwd!)).rejects.toThrow(/generated\/lockfile role/);
});

it("rejects fabricated/missing rationale evidence and discloses verified sources separately from inference", async () => {
  const { hub, create } = setup(); const task = await create();
  const captured = await captureBriefing(hub.getTask(task.id), hub.events(task.id));
  const result = briefingFixture({ prompt: JSON.stringify(captured), systemPrompt: BRIEFING_SYSTEM } as never)!;
  const valid = JSON.parse((result[0] as { text: string }).text);
  for (const invalid of [
    { ...valid, references: valid.references.filter((r: { section: string }) => r.section !== "rationale") },
    { ...valid, references: valid.references.map((r: { section: string }) => r.section === "rationale" ? { ...r, source: "file:invented.ts" } : r) },
    { ...valid, references: valid.references.map((r: { section: string }) => r.section === "risks" ? { ...r, kind: "unknown", source: "" } : r) },
  ]) await expect(validateBriefing(JSON.stringify(invalid), captured, task.cwd!)).rejects.toThrow(/references|unavailable|supplied/);
  const briefing = await hub.generateBriefing(task.id);
  expect(briefing.markdown).toContain("來源事實 (`event:0`)"); expect(briefing.markdown).toContain("推論 (`file:answer.ts`)"); expect(briefing.markdown).toContain("未知");
});

it.each([628_836, 800_000])("captures and generates complete immutable coverage at %i UTF-8 bytes", async (bytes) => {
  const edit = await budgetFixture(bytes);
  const { hub, author, create } = setup(); const task = await create(); const expected = await edit(task);
  const captured = await captureBriefing(hub.getTask(task.id), hub.events(task.id));
  expect(coverageBytes(captured.change.files)).toBe(bytes);
  expect(captured.change.files).toEqual(expected.map((f) => ({ ...f, deleted: false, generated: false, sourceExcerpt: false })));
  const briefing = await hub.generateBriefing(task.id);
  const input = JSON.parse(author.runs.find((r) => r.systemPrompt === BRIEFING_SYSTEM)!.prompt);
  expect(input.change).toEqual(captured.change);
  expect(briefing.source).toEqual(captured.source);
  expect(briefing.source.headSha).toBe(git(task.cwd!, "rev-parse", "HEAD"));
  expect(briefing.source.headTree).toBe(git(task.cwd!, "rev-parse", "HEAD^{tree}"));
  expect(briefing.content.tour.map((s) => s.path).sort()).toEqual(expected.map((f) => f.path).sort());
  expect((await hub.briefing(task.id)).state).toBe("current");
});

it.each([false, true])("rejects excessive briefing coverage while allowing a plain team draft (team=%s)", async (team) => {
  const { hub, author, forge, create } = setup(team); const task = await create();
  for (let n = 0; n < 5; n++) fs.writeFileSync(path.join(task.cwd!, `large-${n}.txt`), "line\n".repeat(18000));
  await commitAll(task.cwd!, "large patches");
  const calls = author.runs.length; const readiness = hub.getTask(task.id);
  const bytes = coverageBytes(["answer.ts", ...Array.from({ length: 5 }, (_, n) => `large-${n}.txt`)].map((file) => ({ text: fs.readFileSync(path.join(task.cwd!, file), "utf8"), patch: fullPatch(task.cwd!, task.workspace!.baseSha, file) })));
  expect(bytes).toBeGreaterThan(800_000);
  const error = "Briefing coverage exceeds 800000 bytes at large-4.txt; no partial briefing accepted";
  await expect(captureBriefing(hub.getTask(task.id), hub.events(task.id))).rejects.toThrow(error);
  // Hub's existing bounded error presentation retains the allowance and offending path.
  const reported = "Briefing coverage exceeds 800000 bytes at large-4.txt";
  await expect(hub.generateBriefing(task.id)).rejects.toThrow(reported);
  if (team) {
    const draft = await hub.preparePrDraft(task.id);
    expect(draft.briefingError).toContain(reported);
    expect(draft.briefingId).toBeUndefined();
    expect(draft.body).not.toContain("data-agent-hub-briefing");
  } else await expect(hub.openPr(task.id)).rejects.toThrow(reported);
  expect(author.runs).toHaveLength(calls + (team ? 1 : 0));
  expect(forge.push).not.toHaveBeenCalled(); expect(forge.openPullRequest).not.toHaveBeenCalled();
  expect(hub.getTask(task.id).status).toBe(readiness.status); expect(hub.getTask(task.id).sessions).toEqual(readiness.sessions);
  expect((await hub.briefing(task.id)).error).toContain(reported);
});

it("rejects exactly 800001 UTF-8 source/patch bytes, including multibyte text, before generation", async () => {
  const edit = await budgetFixture(800_001);
  const { hub, author, create } = setup(); const task = await create(); await edit(task);
  const calls = author.runs.length;
  await expect(captureBriefing(hub.getTask(task.id), hub.events(task.id))).rejects.toThrow("Briefing coverage exceeds 800000 bytes at budget-4.ts; no partial briefing accepted");
  await expect(hub.generateBriefing(task.id)).rejects.toThrow("Briefing coverage exceeds 800000 bytes at budget-4.ts");
  expect(author.runs).toHaveLength(calls);
});

it.each(["overflow", "tool", "incomplete"] as const)("fails %s model output before publication without changing coding readiness", async (mode) => {
  const { hub, author, create, forge } = setup(); const task = await create(); const state = hub.getTask(task.id).status;
  author.run = async function* () {
    if (mode === "overflow") yield { type: "text_delta", text: "x".repeat(48001) };
    else if (mode === "tool") yield { type: "tool_start", callId: "forbidden", name: "record_finding", input: "{}", sideEffect: "none" };
    else { yield { type: "text_delta", text: "{}" }; return; }
    yield { type: "done", ok: true };
  };
  await expect(hub.openPr(task.id)).rejects.toThrow(/48000|tool use|complete result/);
  expect(forge.push).not.toHaveBeenCalled(); expect(forge.openPullRequest).not.toHaveBeenCalled(); expect(hub.getTask(task.id).status).toBe(state);
});

it("releases the scheduler slot for queued coding work after an auxiliary generation", async () => {
  const { hub, author, create } = setup(false, 1); const task = await create();
  author.hold(); const pending = hub.generateBriefing(task.id);
  await vi.waitFor(() => expect(author.runs.some((r) => r.systemPrompt === BRIEFING_SYSTEM)).toBe(true));
  const queued = await hub.createTask({ title: "Queued", workflow: "implement", agent: "codex", repoPath: repo, message: "Implement another answer" });
  expect(hub.getTask(queued.id).activity).toContain("Waiting for a free slot");
  author.release(); await pending; await hub.settled(queued.id);
  expect(hub.getTask(queued.id).status).toBe("idle"); expect(fs.existsSync(path.join(queued.cwd!, "answer.ts"))).toBe(true);
});

it.each([
  ["added", false], ["cleared", false], ["deleted", false],
  ["added", true], ["cleared", true], ["deleted", true],
] as const)("prepares and publishes complete coverage for an %s empty file (team=%s)", async (change, team) => {
  const file = "empty.txt";
  if (change !== "added") {
    fs.writeFileSync(path.join(repo, file), change === "cleared" ? "Previous content\n" : "");
    await commitAll(repo, "empty-file base fixture");
  }
  const { hub, create, forge } = setup(team); const task = await create();
  if (change === "deleted") fs.unlinkSync(path.join(task.cwd!, file));
  else fs.writeFileSync(path.join(task.cwd!, file), "");
  await commitAll(task.cwd!, "empty-file change fixture");
  const captured = await captureBriefing(hub.getTask(task.id), hub.events(task.id));
  expect(captured.change.files.find((f) => f.path === file)).toMatchObject({ text: "", deleted: change === "deleted" });
  if (team) {
    const draft = await hub.preparePrDraft(task.id);
    expect(forge.push).not.toHaveBeenCalled(); expect(forge.openPullRequest).not.toHaveBeenCalled();
    await hub.openPr(task.id, confirm(draft));
    expect(forge.openPullRequest.mock.calls[0]![3]).toBe(draft.body);
  } else await hub.openPr(task.id);
  const briefing = (await hub.briefing(task.id)).briefing!;
  expect(briefing.content.tour.find((s) => s.path === file)).toEqual({ kind: "file", path: file, revision: change === "deleted" ? "base" : "head", supporting: false, explanation: expect.any(String) });
  expect(briefing.content.tour.map((s) => s.path).sort()).toEqual(captured.change.files.map((f) => f.path).sort());
  expect(briefing.markdown).toContain("`empty.txt` — 空白檔案（檔案層級導讀）");
  expect(briefing.markdown).not.toContain("undefined");
  expect(forge.push).toHaveBeenCalledOnce(); expect(forge.openPullRequest).toHaveBeenCalledOnce();
});

it("restricts file-level stops to empty changed files without weakening symbol, line, revision or coverage checks", async () => {
  const { hub, create } = setup(); const task = await create();
  fs.writeFileSync(path.join(task.cwd!, "empty.txt"), ""); await commitAll(task.cwd!, "empty fixture");
  const captured = await captureBriefing(hub.getTask(task.id), hub.events(task.id));
  const fixture = briefingFixture({ prompt: JSON.stringify(captured), systemPrompt: BRIEFING_SYSTEM } as never)!;
  const valid = JSON.parse((fixture[0] as { text: string }).text);
  const empty = valid.tour.find((s: { path: string }) => s.path === "empty.txt");
  const symbol = valid.tour.find((s: { path: string }) => s.path === "answer.ts");
  for (const invalidStop of [
    { ...empty, symbol: "invented" }, { ...empty, line: 1 }, { ...empty, revision: "base" },
    { ...empty, path: "../escape.txt" }, { ...empty, supporting: true }, { ...empty, kind: "unknown" },
    { ...empty, kind: "symbol", symbol: "invented", line: 1 },
    { ...empty, kind: "symbol", symbol: "", line: 1 },
  ]) await expect(validateBriefing(JSON.stringify({ ...valid, tour: [symbol, invalidStop] }), captured, task.cwd!)).rejects.toThrow();
  const { symbol: _symbol, line: _line, ...normal } = symbol;
  await expect(validateBriefing(JSON.stringify({ ...valid, tour: [{ ...normal, kind: "file" }, empty] }), captured, task.cwd!)).rejects.toThrow(/empty changed file/);
  await expect(validateBriefing(JSON.stringify({ ...valid, tour: [symbol] }), captured, task.cwd!)).rejects.toThrow(/Missing briefing coverage: empty.txt/);
  await expect(validateBriefing(JSON.stringify({ ...valid, tour: [{ ...symbol, symbol: "invented" }, empty] }), captured, task.cwd!)).rejects.toThrow(/symbol does not match/);
  await expect(validateBriefing(JSON.stringify({ ...valid, tour: [{ ...symbol, line: 999 }, empty] }), captured, task.cwd!)).rejects.toThrow(/line outside/);
});

it.each(["absent", "optional task example", "explicit missing", "present"] as const)("keeps default guide discovery optional regardless of repository references (%s)", async (mode) => {
  const { hub, author, forge, create } = setup(true); const task = await create();
  if (mode === "explicit missing" || mode === "present") {
    fs.writeFileSync(path.join(task.cwd!, "README.md"), `[Explanation style](${defaultGuide})\n`);
    if (mode === "present") {
      fs.mkdirSync(path.dirname(path.join(task.cwd!, defaultGuide)), { recursive: true });
      fs.writeFileSync(path.join(task.cwd!, defaultGuide), "Explain source evidence before inference.\n");
    }
    await commitAll(task.cwd!, "default guide reference fixture");
  } else if (mode === "optional task example") {
    hub.sendMessage(task.id, `Check the optional repository-relative ${defaultGuide} when present.\nFor example, an optional [Explanation style](${defaultGuide}) may be supplied.`);
    await hub.settled(task.id);
  }
  const draft = await hub.preparePrDraft(task.id);
  const briefing = (await hub.briefing(task.id)).briefing!;
  expect(briefing.source.guides.some((g) => g.path === defaultGuide)).toBe(mode === "present");
  if (mode === "present") {
    expect(briefing.source.guides.find((g) => g.path === defaultGuide)?.revision).toBe(briefing.source.headSha);
    expect(author.runs.find((r) => r.systemPrompt === BRIEFING_SYSTEM)!.prompt).toContain("Explain source evidence before inference.");
  }
  await hub.openPr(task.id, confirm(draft)); expect(forge.openPullRequest).toHaveBeenCalledOnce();
});

const defaultGuide = "docs/ai-guides/cara-explanation-style.md";
const optionalGuideParagraph = "Sources are the captured cumulative change against the task's saved base, committed changed-file\n"
  + "sources (deleted files use the base), saved requests/follow-ups, ticket/issue metadata and recorded\n"
  + "author/reviewer/test evidence. Other tasks and finding/export records are excluded. README.md,\n"
  + "AGENTS.md, explicit explanation-style guide references and optional\n"
  + `\`${defaultGuide}\` are read from that captured revision as presentation data.\n`
  + "Missing optional guidance uses the standard structure; an explicitly identified missing, unsafe or\n"
  + "unreadable guide fails preparation. Guides never grant tool authority or authorize unrelated fixes.";

it.each([
  ["README.md", optionalGuideParagraph],
  ["AGENTS.md", optionalGuideParagraph],
  ["README.md", `The optional [Explanation style](${defaultGuide}) is used when present.`],
  ["AGENTS.md", `Use the optional\nexplanation-style guide \`${defaultGuide}\` if available.`],
  ["request", `For example, an optional [Explanation style](${defaultGuide}) may be supplied.`],
  ["request", `Check the optional repository-relative\n\`${defaultGuide}\` when present.`],
])("uses standard guidance for an absent optional default in %s", async (location, text) => {
  fs.writeFileSync(path.join(repo, "AGENTS.md"), "Fixture instructions\n"); await commitAll(repo, "repository instructions");
  const { hub, author, forge, create } = setup(true); const task = await create();
  if (location === "request") { hub.sendMessage(task.id, text); await hub.settled(task.id); }
  else { fs.writeFileSync(path.join(task.cwd!, location), text); await commitAll(task.cwd!, "optional guidance documentation"); }
  const draft = await hub.preparePrDraft(task.id);
  const briefing = (await hub.briefing(task.id)).briefing!;
  expect(briefing.source.guides.some((g) => g.path === defaultGuide)).toBe(false);
  expect(author.runs.filter((r) => r.systemPrompt === BRIEFING_SYSTEM)).toHaveLength(1);
  expect(draft.body).toContain(briefingAppendix(briefing));
  expect(forge.push).not.toHaveBeenCalled(); expect(forge.openPullRequest).not.toHaveBeenCalled();
});

it("never promotes the absent default from README and a saved diagnostic follow-up to a required second read", async () => {
  fs.writeFileSync(path.join(repo, "AGENTS.md"), "Fixture instructions\n"); await commitAll(repo, "repository instructions");
  const { hub, author, forge, create } = setup(true); const task = await create();
  fs.writeFileSync(path.join(task.cwd!, "README.md"), `${optionalGuideParagraph}\n\nThe explanation-style guide is required. Use \`${defaultGuide}\`.`);
  await commitAll(task.cwd!, "document default guidance");
  const followup = `A previous attempt reported "Captured source is unavailable: ${defaultGuide}". The default explanation-style guide was described as required; do not create it.`;
  hub.sendMessage(task.id, followup); await hub.settled(task.id);
  const reads = vi.spyOn(workspaceGit, "revisionText");
  try {
    const captured = await captureBriefing(hub.getTask(task.id), hub.events(task.id));
    expect(reads.mock.calls.filter((call) => call[2] === defaultGuide).map((call) => call[3])).toEqual([true]);
    expect(captured.context.evidence.some((e) => e.type === "user_message" && e.text === followup)).toBe(true);
    expect(captured.guides.some((g) => g.path === defaultGuide)).toBe(false);
    reads.mockClear();
    const generated = await hub.generateBriefing(task.id);
    const draft = await hub.preparePrDraft(task.id);
    const defaultReads = reads.mock.calls.filter((call) => call[2] === defaultGuide);
    expect(defaultReads.length).toBeGreaterThan(0);
    expect(defaultReads.every((call) => call[3] === true)).toBe(true);
    expect(generated.source.guides.some((g) => g.path === defaultGuide)).toBe(false);
    expect(draft.body).toContain(briefingAppendix(generated));
    expect(author.runs.filter((r) => r.systemPrompt === BRIEFING_SYSTEM)).toHaveLength(1);
    expect((await hub.briefing(task.id)).state).toBe("current");
    expect(forge.push).not.toHaveBeenCalled(); expect(forge.openPullRequest).not.toHaveBeenCalled();
  } finally { reads.mockRestore(); }
});

it.each(["README.md", "AGENTS.md", "request"])("keeps explicit required custom references mandatory in %s", async (location) => {
  fs.writeFileSync(path.join(repo, "AGENTS.md"), "Fixture instructions\n"); await commitAll(repo, "repository instructions");
  const { hub, author, forge, create } = setup(true); const task = await create();
  const guide = "docs/required-style.md";
  const text = `${optionalGuideParagraph}\n\nAn example is optional.\nAlthough optional by default, the explanation-style guide\n\`${guide}\` is required.`;
  if (location === "request") { hub.sendMessage(task.id, text); await hub.settled(task.id); }
  else { fs.writeFileSync(path.join(task.cwd!, location), text); await commitAll(task.cwd!, "required guidance reference"); }
  const calls = author.runs.length;
  await expect(hub.generateBriefing(task.id)).rejects.toThrow(`Captured source is unavailable: ${guide}`);
  await expect(hub.preparePrDraft(task.id)).resolves.toMatchObject({ briefingError: `Captured source is unavailable: ${guide}` });
  await expect(hub.openPr(task.id)).rejects.toThrow();
  expect(author.runs).toHaveLength(calls + 1);
  expect(forge.push).not.toHaveBeenCalled(); expect(forge.openPullRequest).not.toHaveBeenCalled();
});

it("captures present optional default guidance from the immutable head with provenance", async () => {
  fs.writeFileSync(path.join(repo, "AGENTS.md"), "Fixture instructions\n"); await commitAll(repo, "repository instructions");
  const { hub, author, create } = setup(); const task = await create();
  fs.writeFileSync(path.join(task.cwd!, "README.md"), optionalGuideParagraph);
  fs.mkdirSync(path.dirname(path.join(task.cwd!, defaultGuide)), { recursive: true });
  const text = "Explain immutable source evidence before inference.\n";
  fs.writeFileSync(path.join(task.cwd!, defaultGuide), text); await commitAll(task.cwd!, "present optional guide");
  const captured = await captureBriefing(hub.getTask(task.id), hub.events(task.id));
  const briefing = await hub.generateBriefing(task.id);
  expect(captured.guides.find((g) => g.path === defaultGuide)).toEqual({ path: defaultGuide, text, revision: captured.source.headSha });
  expect(briefing.source.guides.find((g) => g.path === defaultGuide)?.revision).toBe(captured.source.headSha);
  expect(JSON.parse(author.runs.find((r) => r.systemPrompt === BRIEFING_SYSTEM)!.prompt).guides).toEqual(captured.guides);
  fs.writeFileSync(path.join(task.cwd!, defaultGuide), "Mutable content is not captured.\n");
  expect(await revisionText(task.cwd!, briefing.source.headSha, defaultGuide)).toBe(text);
});

it.each(["README.md", "AGENTS.md", "request"].flatMap((location) => ["missing", "unsafe", "present"].map((mode) => [location, mode])))
("preserves cross-sentence required guide context in %s (%s)", async (location, mode) => {
  const guide = "docs/team.md";
  const content = "Explain the required team conventions from immutable source.\n";
  fs.writeFileSync(path.join(repo, "AGENTS.md"), "Fixture instructions\n");
  // Existing guides stay outside the changed-file manifest, exercising reference discovery.
  if (mode !== "missing") {
    fs.mkdirSync(path.join(repo, "docs"));
    if (mode === "unsafe") fs.symlinkSync("../deleted.ts", path.join(repo, guide));
    else fs.writeFileSync(path.join(repo, guide), content);
  }
  await commitAll(repo, "cross-sentence guidance base");
  const { hub, author, forge, create } = setup(true); const task = await create();
  const reference = `The explanation-style guide is required. Use \`${guide}\`.`;
  // An earlier optional example must neither hide this custom path nor require the absent default.
  const text = `${optionalGuideParagraph}\n\n${reference}`;
  if (location === "request") { hub.sendMessage(task.id, text); await hub.settled(task.id); }
  else { fs.writeFileSync(path.join(task.cwd!, location), text); await commitAll(task.cwd!, "cross-sentence guidance reference"); }
  const readiness = hub.getTask(task.id); const calls = author.runs.length;
  if (mode !== "present") {
    const error = mode === "missing" ? `Captured source is unavailable: ${guide}` : `Captured source is not an ordinary file: ${guide}`;
    await expect(hub.generateBriefing(task.id)).rejects.toThrow(error);
    await expect(hub.preparePrDraft(task.id)).resolves.toMatchObject({ briefingError: error });
    await expect(hub.openPr(task.id)).rejects.toThrow("Prepare a PR draft first");
    expect(author.runs).toHaveLength(calls + 1);
    expect(forge.push).not.toHaveBeenCalled(); expect(forge.openPullRequest).not.toHaveBeenCalled();
    expect(hub.getTask(task.id).status).toBe(readiness.status); expect(hub.getTask(task.id).sessions).toEqual(readiness.sessions);
    return;
  }
  const captured = await captureBriefing(hub.getTask(task.id), hub.events(task.id));
  expect(captured.change.files.some((f) => f.path === guide)).toBe(false);
  const draft = await hub.preparePrDraft(task.id);
  const briefing = (await hub.briefing(task.id)).briefing!;
  expect(captured.guides.find((g) => g.path === guide)).toEqual({ path: guide, text: content, revision: captured.source.headSha });
  expect(briefing.source.guides.find((g) => g.path === guide)?.revision).toBe(captured.source.headSha);
  expect(briefing.source.guides.some((g) => g.path === defaultGuide)).toBe(false);
  expect(JSON.parse(author.runs.find((r) => r.systemPrompt === BRIEFING_SYSTEM)!.prompt).guides).toEqual(captured.guides);
  expect(draft.body).toContain(briefingAppendix(briefing));
  expect(forge.push).not.toHaveBeenCalled(); expect(forge.openPullRequest).not.toHaveBeenCalled();
});

it.each(["traversal", "symlink", "gitlink", "optional default symlink"] as const)("rejects unsafe briefing guidance while allowing a plain draft (%s)", async (mode) => {
  const guide = mode === "traversal" ? "../outside.md" : mode === "optional default symlink" ? defaultGuide : "docs/unsafe.md";
  fs.writeFileSync(path.join(repo, "README.md"), mode === "optional default symlink" ? optionalGuideParagraph : `[Explanation style](${guide})\n`);
  if (mode !== "traversal") {
    fs.mkdirSync(path.dirname(path.join(repo, guide)), { recursive: true });
    if (mode === "gitlink") {
      git(repo, "update-index", "--add", "--cacheinfo", `160000,${git(repo, "rev-parse", "HEAD")},${guide}`);
      git(repo, "add", "README.md"); git(repo, "commit", "-qm", "unsafe gitlink guide");
    } else fs.symlinkSync("../deleted.ts", path.join(repo, guide));
  }
  if (mode !== "gitlink") await commitAll(repo, "unsafe guidance base");
  const { hub, author, forge, create } = setup(true); const task = await create(); const calls = author.runs.length;
  await expect(hub.generateBriefing(task.id)).rejects.toThrow(mode === "traversal" ? /Invalid captured source path/ : /not an ordinary file/);
  const draft = await hub.preparePrDraft(task.id);
  expect(draft.briefingError).toMatch(mode === "traversal" ? /Invalid captured source path/ : /not an ordinary file/);
  await expect(hub.openPr(task.id)).rejects.toThrow();
  expect(author.runs).toHaveLength(calls + 1);
  expect(forge.push).not.toHaveBeenCalled(); expect(forge.openPullRequest).not.toHaveBeenCalled();
});

it("keeps the root README compatible with the old running reference scanner", async () => {
  const readme = fs.readFileSync(new URL("../../../README.md", import.meta.url), "utf8");
  const agents = fs.readFileSync(new URL("../../../AGENTS.md", import.meta.url), "utf8");
  // Frozen pre-fix repository discovery: verify host compatibility without a production fallback.
  const references = new Set<string>();
  for (const text of [readme, agents]) {
    for (const line of text.split("\n")) {
      for (const match of line.matchAll(/\[[^\]]*(?:explanation|style)[^\]]*\]\(([^)]+)\)/gi)) references.add(match[1]!);
      if (!/(?:explanation[- ]style|style[- ]guide|explanation (?:guide|guidance))/i.test(line)) continue;
      for (const match of line.matchAll(/(?:^|[\s`"(])([^\s`"()]+\.(?:md|txt))(?=$|[\s`"),.;])/gi)) references.add(match[1]!);
    }
  }
  expect([...references]).toEqual([]);
  expect(readme).toContain("[planning guide](docs/guide/planning.md)"); expect(readme).not.toContain(defaultGuide);
  const { hub, create } = setup(true); const task = await create();
  fs.writeFileSync(path.join(task.cwd!, "README.md"), readme); fs.writeFileSync(path.join(task.cwd!, "AGENTS.md"), agents);
  await commitAll(task.cwd!, "root documentation compatibility fixture");
  await expect(hub.preparePrDraft(task.id)).resolves.toMatchObject({ body: expect.any(String) });
});

it("allows embedded scheme-like words in prose and rejects actual schemes, HTML, links and fences", async () => {
  const { hub, create } = setup(); const task = await create();
  const captured = await captureBriefing(hub.getTask(task.id), hub.events(task.id));
  const fixture = briefingFixture({ prompt: JSON.stringify(captured), systemPrompt: BRIEFING_SYSTEM } as never)!;
  const valid = JSON.parse((fixture[0] as { text: string }).text);
  const risks = "檢查 metadata: 與 userData: 欄位，風險依來源記錄判定。";
  expect((await validateBriefing(JSON.stringify({ ...valid, risks }), captured, task.cwd!)).risks).toBe(risks);
  for (const text of ["http:payload", "HTTPS:payload", "ftp:payload", "javascript:payload", "data:payload", "</details>", "```escape", "~~~escape", "[link](payload)", "![image](payload)"]) {
    await expect(validateBriefing(JSON.stringify({ ...valid, risks: `風險 ${text}` }), captured, task.cwd!)).rejects.toThrow(/Invalid briefing risks/);
  }
});

it("accepts embedded scheme-like diagram labels and rejects actual schemes and directives", () => {
  for (const label of ["metadata: value", "userData: value"]) expect(() => validateBriefingDiagram(`flowchart TD\n A["${label}"] --> B`)).not.toThrow();
  for (const label of ["https:payload", "HTTP:payload", "javascript:payload", "DATA:payload"]) expect(() => validateBriefingDiagram(`flowchart TD\n A["${label}"] --> B`)).toThrow();
  expect(() => validateBriefingDiagram("%%{init: bad}%%\nflowchart TD\n A --> B")).toThrow();
});

it("prepares, edits and publishes a plain draft after invalid briefing output", async () => {
  const { hub, forge, create, fail } = setup(true); const task = await create(); fail();
  const draft = await hub.preparePrDraft(task.id);
  expect(draft.briefingError).toBeTruthy(); expect(draft.briefingId).toBeUndefined();
  expect(draft.body).toContain("## Purpose"); expect(draft.body).toContain("Agent Hub:");
  expect(draft.body).not.toContain("data-agent-hub-briefing"); expect(draft.mainBody).toBe(draft.body);
  expect(hub.events(task.id).some((e) => e.type === "briefing_failed")).toBe(true);
  await expect(hub.openPr(task.id, { ...confirm(draft), branch: "agent-hub/invalid" })).rejects.toThrow("Invalid PR branch");
  await expect(hub.openPr(task.id, { ...confirm(draft), title: "" })).rejects.toThrow("Invalid PR title");
  const edited = await hub.editPrDraft(task.id, { ...confirm(draft), title: "Human title", body: "Human description" });
  expect(edited.briefingError).toBe(draft.briefingError); expect(edited.mainBody).toBe("Human description");
  const fresh = await hub.preparePrDraft(task.id);
  expect(fresh).toMatchObject({ title: edited.title, body: edited.body, branch: edited.branch, commitMessage: edited.commitMessage, changeType: edited.changeType });
  await expect(hub.openPr(task.id, confirm(edited))).rejects.toThrow("out of date");
  await hub.openPr(task.id, { ...confirm(fresh), body: "Final plain description" });
  expect(forge.openPullRequest).toHaveBeenCalledWith(expect.anything(), "example/project", "Human title", "Final plain description");
  const publishedDraft = hub.events(task.id).filter((e) => e.type === "pr_draft").at(-1)!;
  expect(publishedDraft).toMatchObject({ briefingError: draft.briefingError, mainBody: "Final plain description" });
});

it("attaches a later successful briefing while retaining edits from a plain draft", async () => {
  const { hub, create, fail, succeed } = setup(true); const task = await create(); fail();
  const draft = await hub.preparePrDraft(task.id);
  const edited = await hub.editPrDraft(task.id, { ...confirm(draft), body: "Human description" });
  succeed();
  const fresh = await hub.preparePrDraft(task.id);
  expect(fresh.briefingError).toBeUndefined(); expect(fresh.briefingId).toBeTruthy();
  expect(fresh.mainBody).toBe(edited.body); expect(fresh.body).toContain("data-agent-hub-briefing");
});

it.each(["x".repeat(350), "First line", ""])("bounds the plain draft failure reason to its first line: %s", async (reason) => {
  const { hub, create } = setup(true); const task = await create();
  vi.spyOn(hub as unknown as { ensureBriefing: () => Promise<never> }, "ensureBriefing").mockRejectedValue(new Error(reason ? reason + "\nSecond line" : ""));
  const draft = await hub.preparePrDraft(task.id);
  expect(draft.briefingError).toBe(reason.slice(0, 300));
  await hub.editPrDraft(task.id, confirm(draft));
});

it("rejects a plain draft confirmation after a subsequent coding round", async () => {
  const { hub, forge, create, fail } = setup(true); const task = await create(); fail();
  const draft = await hub.preparePrDraft(task.id);
  fs.writeFileSync(path.join(task.cwd!, "later.ts"), "export const later = true;\n");
  hub.sendMessage(task.id, "Check the implementation again"); await hub.settled(task.id);
  await expect(hub.openPr(task.id, confirm(draft))).rejects.toThrow("out of date");
  expect(forge.push).not.toHaveBeenCalled();
});

it("does not continue PR preparation after the user stops briefing generation", async () => {
  const { hub, author, create } = setup(true); const task = await create();
  author.hold();
  const pending = hub.preparePrDraft(task.id); void pending.catch(() => {});
  await vi.waitFor(() => expect(generations(hub, task.id)).toHaveLength(1));
  hub.stop(task.id);
  await expect(pending).rejects.toThrow("PR preparation interrupted");
  expect(hub.events(task.id).some((e) => e.type === "pr_draft")).toBe(false);
  author.release();
});
