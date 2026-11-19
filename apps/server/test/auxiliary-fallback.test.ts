import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentKind } from "@agent-hub/shared";
import { FakeAdapter, type FakeStep } from "../src/agents/fake";
import type { AgentRunInput } from "../src/agents/types";
import { Hub } from "../src/core/hub";
import { openDb, schema } from "../src/db/index";
import { briefingFixture } from "./briefing-fixture";

let root: string;
let repo: string;
let hub: Hub;
let gemini: FakeAdapter;
const reset = new Date(Date.now() + 3_600_000).toISOString();
const metadata = { type: "feat", summary: "Add answer", slug: "add-answer", body: "Add answer." };
const kind = (input: AgentRunInput) => input.systemPrompt?.includes("metadata") ? "metadata" : input.systemPrompt?.startsWith("Generate a whole-change reference card") ? "briefing" : input.toolsDisabled ? "explanations" : input.systemPrompt?.includes("code reviewer") ? "review" : "turn";
const response = (text: string): FakeStep[] => [{ type: "thread", threadId: "generated-thread" }, { type: "text_delta", text }, { type: "done", ok: true }];
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "hub-auxiliary-fallback-"));
  repo = path.join(root, "repo"); fs.mkdirSync(repo);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo });
  git("init", "-q", "-b", "main"); git("config", "user.email", "fixture@example.invalid"); git("config", "user.name", "Fixture");
  fs.writeFileSync(path.join(repo, "README.md"), "Fixture\n"); git("add", "."); git("commit", "-qm", "base");
  fs.writeFileSync(path.join(root, "repos.json"), JSON.stringify({ [repo]: { prLanguage: "en" } }));
  vi.stubEnv("AGENT_HUB_EXPLAIN_AGENT", "codex");
  gemini = new FakeAdapter(() => { throw new Error("Gemini must never generate auxiliary text"); });
});
afterEach(async () => { await hub?.shutdown(100); expect(gemini.runs).toEqual([]); vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }); });
async function setup(options: { exhausted?: boolean; failure?: string; target?: string; bothFail?: boolean; missingOther?: boolean; workflow?: "implement" | "review" } = {}) {
  const script = (agent: AgentKind) => (input: AgentRunInput): FakeStep[] => {
    if (kind(input) === (options.target ?? "metadata") && (agent === "codex" || options.bothFail) && options.failure) return [{ type: "done", ok: false, error: options.failure }];
    if (kind(input) === "review") return response("VERDICT: approve\nFINDINGS: none");
    if (kind(input) === "metadata") return response(JSON.stringify(metadata));
    const briefing = briefingFixture(input); if (briefing) return briefing;
    if (kind(input) === "explanations") return response(JSON.stringify({ hunks: [...input.prompt.matchAll(/^Hunk id: (.+)$/gm)].map((m) => ({ id: JSON.parse(m[1]!), explanation: "Explains the change." })) }));
    return [{ type: "write", path: "answer.ts", content: "export const answer = 42;\n" }, ...response("Implemented answer")];
  };
  const codex = new FakeAdapter(script("codex")); const claude = new FakeAdapter(script("claude"));
  codex.quotaScript = async () => ({ status: "ok", windows: [{ id: "main", bucket: "Main", durationMins: null, remainingPercent: options.exhausted ? 0 : 100, resetsAt: reset }] });
  const db = openDb(":memory:");
  const forge = { repoOf: async () => "example/project", push: vi.fn(), openPullRequest: vi.fn(), state: vi.fn(), close: vi.fn(), listIssues: vi.fn(), readIssue: vi.fn() };
  hub = new Hub({ db, dataDir: root, maxConcurrent: 4, agents: options.missingOther ? { codex, gemini } : { codex, claude, gemini }, forge });
  const task = await hub.createTask({ title: "Answer", workflow: options.workflow ?? "implement", agent: "codex", reviewer: "claude", repoPath: repo, message: "Add answer" });
  await hub.settled(task.id);
  return { task: hub.getTask(task.id), codex, claude, db };
}
const calls = (agent: FakeAdapter, target: string) => agent.runs.filter((i) => kind(i) === target);

it("uses a fresh reusable writer, preserves author state and attribution across user edits, and routes follow-ups to the author", async () => {
  const { task, codex, claude, db } = await setup({ exhausted: true, workflow: "review" });
  const author = task.sessions.find((s) => s.role === "author" || s.role === "main")!;
  const reviewer = task.sessions.find((s) => s.role === "reviewer")!;
  const first = await hub.preparePrDraft(task.id);
  expect(first).toMatchObject({ writtenBy: "claude", fallbackFrom: { agent: "codex", resetsAt: reset } });
  expect(calls(codex, "metadata")).toHaveLength(0);
  expect(calls(claude, "metadata")[0]).toMatchObject({ effort: "low" });
  expect(calls(claude, "metadata")[0]?.threadId).toBeUndefined();
  expect(hub.getTask(task.id).sessions.find((s) => s.id === author.id)).toEqual(author);
  expect(hub.getTask(task.id).sessions.find((s) => s.id === reviewer.id)).toEqual(reviewer);
  const writer = hub.getTask(task.id).sessions.find((s) => s.role === "writer")!;
  expect(writer.agent).toBe("claude");
  db.update(schema.sessions).set({ sdkThreadId: "stale-writer-thread" }).where(eq(schema.sessions.id, writer.id)).run();
  hub.sendMessage(task.id, "Keep the answer"); await hub.settled(task.id);
  expect(calls(codex, "turn")).toHaveLength(2); expect(calls(claude, "turn")).toHaveLength(0);
  const second = await hub.preparePrDraft(task.id);
  expect(calls(claude, "metadata")).toHaveLength(2);
  expect(calls(claude, "metadata")[1]?.threadId).toBeUndefined();
  expect(hub.getTask(task.id).sessions.filter((s) => s.role === "writer").map((s) => s.id)).toEqual([writer.id]);
  const edited = await hub.editPrDraft(task.id, { draftId: second.id, branch: second.branch, commitMessage: second.commitMessage, title: "Edited title", body: second.body });
  expect(edited).toMatchObject({ by: "user", writtenBy: "claude", fallbackFrom: first.fallbackFrom });
});
it("retries PR metadata exactly once after a usage limit", async () => {
  const { task, codex, claude } = await setup({ failure: "usage limit" });
  expect(await hub.preparePrDraft(task.id)).toMatchObject({ writtenBy: "claude", fallbackFrom: { agent: "codex", resetsAt: null } });
  expect(calls(codex, "metadata")).toHaveLength(1); expect(calls(claude, "metadata")).toHaveLength(1);
});
it.each(["ordinary error", "overloaded", "authentication failed"])("does not retry metadata on %s", async (failure) => {
  const { task, codex, claude } = await setup({ failure });
  await expect(hub.preparePrDraft(task.id)).rejects.toThrow(failure);
  expect(calls(codex, "metadata")).toHaveLength(1); expect(calls(claude, "metadata")).toHaveLength(0);
});
it.each([false, true])("gives a clear final PR quota error (missing other=%s)", async (missingOther) => {
  const { task, codex, claude } = await setup({ failure: "usage limit", bothFail: true, missingOther });
  await expect(hub.preparePrDraft(task.id)).rejects.toThrow(missingOther ? "Codex usage limit reached; Claude unavailable" : "Claude usage limit reached; Codex also at its usage limit");
  expect(calls(codex, "metadata")).toHaveLength(1); expect(calls(claude, "metadata")).toHaveLength(missingOther ? 0 : 1);
});
it.each(["briefing", "explanations"])("falls back up front for %s", async (target) => {
  const { task, codex, claude } = await setup({ exhausted: true });
  const result = target === "briefing" ? await hub.generateBriefing(task.id) : (await hub.explanations(task.id)).event;
  expect(result).toMatchObject({ writtenBy: "claude", fallbackFrom: { agent: "codex", resetsAt: reset } });
  expect(calls(codex, target)).toHaveLength(0); expect(calls(claude, target)).toHaveLength(1);
  expect(calls(claude, target)[0]?.model).toBeUndefined();
  if (target === "explanations") expect(hub.getTask(task.id).sessions.find((s) => s.role === "explainer")?.agent).toBe("claude");
});
it.each(["briefing", "explanations"])("retries %s on a usage failure and records attribution", async (target) => {
  const { task, codex, claude } = await setup({ target, failure: "usage limit" });
  const result = target === "briefing" ? await hub.generateBriefing(task.id) : (await hub.explanations(task.id)).event;
  expect(result).toMatchObject({ writtenBy: "claude", fallbackFrom: { agent: "codex", resetsAt: null } });
  expect(calls(codex, target)).toHaveLength(1); expect(calls(claude, target)).toHaveLength(1);
});
it.each(["briefing", "explanations"])("records final quota failure for %s", async (target) => {
  const { task, codex, claude } = await setup({ target, failure: "usage limit", bothFail: true });
  if (target === "briefing") await expect(hub.generateBriefing(task.id)).rejects.toThrow("usage limit");
  const event = hub.events(task.id).filter((e) => e.type === (target === "briefing" ? "briefing_failed" : "diff_explanations")).at(-1);
  expect(event).toMatchObject({ error: "usage limit", limit: { agent: "claude", resetsAt: null } });
  expect(calls(codex, target)).toHaveLength(1); expect(calls(claude, target)).toHaveLength(1);
});
