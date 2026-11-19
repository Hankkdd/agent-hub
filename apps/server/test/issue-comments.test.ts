import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import type { IssueCommentDraft, Task, TaskEvent, TaskEventPayload } from "@agent-hub/shared";
import { IssueComments, initialCommentDraft, validateIssueSummary } from "../src/core/issue-comments";
import { CommentWriteError, type Forge, type Issue } from "../src/workspace/forge";

const summary = { problem: "需求尚未留下公開紀錄", behavior: ["使用者確認後發布"], acceptanceCriteria: ["同一版本不重複發布"], outOfScope: ["不修改 issue 內文"] };
const issue: Issue = { number: 7, title: "Requirements", url: "https://github.com/example/project/issues/7", state: "open", labels: [], body: "Original", comments: [] };
const comment = { id: 42, url: `${issue.url}#issuecomment-42` };
function fixture() {
  const task = { id: "plan", workflow: "plan", cwd: "/local/private", options: { pinnedAt: "saved" } } as Task;
  const history: TaskEvent[] = [];
  const append = (id: string, payload: TaskEventPayload) => {
    const event = { id: `event-${history.length}`, taskId: id, sessionId: null, seq: history.length + 1, createdAt: "", ...payload } as TaskEvent;
    history.push(event); return event;
  };
  const proposal = append(task.id, { type: "task_proposal", title: "Implement", spec: "ENGLISH PRIVATE SPEC /local/private token=secret", issue: { number: 7, url: issue.url }, issueSummary: summary }) as Extract<TaskEvent, { type: "task_proposal" }>;
  const draft = append(task.id, { type: "issue_comment_draft", ...initialCommentDraft(proposal, "Example/Project", issue) }) as Extract<TaskEvent, { type: "issue_comment_draft" }>;
  const forge = { repoOf: vi.fn(async () => "example/project"), readIssue: vi.fn(async () => issue),
    createIssueComment: vi.fn(async () => comment), reconcileIssueComment: vi.fn(async () => ({ state: "unknown" as const })) };
  let deleted = false;
  const store = { task: (id: string) => { if (deleted || id !== task.id) throw new Error("No task"); return task; }, events: () => history,
    append, forge: forge as unknown as Forge };
  const service = new IssueComments(store);
  const version = { draftId: draft.draftId, revision: draft.revision };
  return { task, history, draft, forge, service, store, append, version, remove: () => { deleted = true; history.length = 0; } };
}
const state = (e: TaskEvent) => e.type === "issue_comment_outcome" ? e.state : undefined;

describe("local public summary", () => {
  it("formats only supplied public fields with immutable opaque source and protected operation marker", () => {
    const f = fixture();
    const expectedContent = "## 問題與背景\n\n需求尚未留下公開紀錄\n\n## 已議定行為\n\n1. 使用者確認後發布\n\n## 驗收條件\n\n1. 同一版本不重複發布\n\n## 不在範圍內（Out of scope）\n\n1. 不修改 issue 內文";
    const expectedBody = `${expectedContent}\n\n---\n來源提案版本：plan/event-0\n此摘要為公開需求紀錄；完整實作規格保留於 Hub 提案。\n<!-- agent-hub-requirements:${f.draft.operationId} -->`;
    expect(f.draft.content).toBe(expectedContent);
    expect(f.draft.body).toBe(expectedBody);
    expect(f.draft.bodyIdentity).toBe(createHash("sha256").update(expectedBody).digest("hex"));
    expect(f.draft.body).toContain("## 驗收條件\n\n1. 同一版本不重複發布");
    expect(f.draft.body).toContain("Out of scope");
    expect(f.draft.body).toContain("plan/event-0");
    expect(f.draft.body).toContain(`<!-- agent-hub-requirements:${f.draft.operationId} -->`);
    expect(f.draft.body).not.toMatch(/ENGLISH PRIVATE|local\/private|token=secret/);
    expect(f.draft.repo).toBe("example/project");
    expect(f.forge.createIssueComment).not.toHaveBeenCalled();
  });
  it.each([null, {}, { ...summary, problem: " " }, { ...summary, behavior: [] }, { ...summary, problem: 7 }, { ...summary, behavior: [""] }, { ...summary, extra: "x" }, { ...summary, behavior: Array(31).fill("x") }, { ...summary, behavior: Array(20).fill("x".repeat(1000)) }])("rejects malformed/bounded summary %j", (input) => {
    expect(() => validateIssueSummary(input)).toThrow();
  });
  it("saves a new revision without changing provenance/spec; invalidates older devices", async () => {
    const f = fixture();
    const event = f.service.edit("plan", { ...f.version, content: "Edited\n`$() quotes`" });
    expect(event).toMatchObject({ type: "issue_comment_draft", revision: 2, sourceIdentity: f.draft.sourceIdentity, sourceReference: f.draft.sourceReference });
    expect(event.type === "issue_comment_draft" && event.operationId).not.toBe(f.draft.operationId);
    if (event.type !== "issue_comment_draft") throw new Error("Missing draft revision");
    const expectedBody = `Edited\n\`$() quotes\`\n\n---\n來源提案版本：plan/event-0\n此摘要為公開需求紀錄；完整實作規格保留於 Hub 提案。\n<!-- agent-hub-requirements:${event.operationId} -->`;
    expect(event.body).toBe(expectedBody);
    expect(event.bodyIdentity).toBe(createHash("sha256").update(expectedBody).digest("hex"));
    expect(() => f.service.confirm("plan", f.version)).toThrow(/changed/);
    expect(f.history[0]).toHaveProperty("spec", "ENGLISH PRIVATE SPEC /local/private token=secret");
    expect(f.forge.createIssueComment).not.toHaveBeenCalled();
  });
  it.each([null, [], {}, { revision: 1, draftId: "x", repo: "other/project" }, { revision: "1", draftId: "x" }, { revision: 1, draftId: "x", body: "unsaved" }])("rejects invalid authenticated command shape %j", (v) => {
    expect(() => fixture().service.confirm("plan", v)).toThrow();
  });
  it.each(["", "x".repeat(24001), "<!-- agent-hub-requirements:spoof -->", "x\0"])("rejects invalid edit", (content) => {
    const f = fixture(); expect(() => f.service.edit("plan", { ...f.version, content })).toThrow();
  });
});

describe("durable independent publication", () => {
  it("coalesces clients and repeated confirmations to one POST and the same persisted result", async () => {
    const f = fixture();
    const a = f.service.confirm("plan", f.version), b = f.service.confirm("plan", f.version);
    expect(a).toBe(b);
    const published = await a;
    expect(published).toMatchObject({ state: "published", comment, repo: "example/project", issueNumber: 7, bodyIdentity: f.draft.bodyIdentity });
    expect(await f.service.confirm("plan", f.version)).toEqual(published);
    expect(f.forge.createIssueComment).toHaveBeenCalledExactlyOnceWith("example/project", 7, f.draft.body);
    expect(f.history.filter((e) => e.type === "issue_comment_outcome").map(state)).toEqual(["preparing", "publishing", "published"]);
    expect(f.history.some((e) => ["user_message", "task_started", "ask", "pr_opened"].includes(e.type))).toBe(false);
    expect(f.task.options).toEqual({ pinnedAt: "saved" });
    expect(() => f.service.edit("plan", { ...f.version, content: "later" })).toThrow();
  });
  it("rejects edits in flight and allows publication after independent source dispatch", async () => {
    const f = fixture();
    Object.assign(f.history[0]!, { startedTaskId: "worker" });
    const posting = f.service.confirm("plan", f.version);
    expect(() => f.service.edit("plan", { ...f.version, content: "race" })).toThrow();
    expect(state(await posting)).toBe("published");
  });
  it("supersedes unpublished same-issue drafts, preserving published history", async () => {
    const f = fixture();
    f.append("plan", { type: "task_proposal", title: "New", spec: "New", issue: { number: 7, url: issue.url } });
    expect(() => f.service.confirm("plan", f.version)).toThrow(/superseded/);
    const g = fixture(); await g.service.confirm("plan", g.version);
    g.append("plan", { type: "task_proposal", title: "New", spec: "New", issue: { number: 7, url: issue.url } });
    expect(state(await g.service.confirm("plan", g.version))).toBe("published");
    expect(g.forge.createIssueComment).toHaveBeenCalledTimes(1);
  });
  it("prevents changed-origin redirection and unsupported workflows/wrong-task drafts", async () => {
    const f = fixture(); f.forge.repoOf.mockResolvedValue("other/project");
    expect(state(await f.service.confirm("plan", f.version))).toBe("failed");
    expect(f.forge.createIssueComment).not.toHaveBeenCalled();
    expect(() => f.service.confirm("plan", { ...f.version, draftId: "other" })).toThrow(/No draft/);
    f.task.workflow = "chat"; expect(() => f.service.confirm("plan", f.version)).toThrow(/planning/);
  });
  it("records definite failures and requires explicit retry", async () => {
    const f = fixture(); f.forge.createIssueComment.mockRejectedValueOnce(new CommentWriteError(true));
    expect(state(await f.service.confirm("plan", f.version))).toBe("failed");
    expect(f.forge.createIssueComment).toHaveBeenCalledTimes(1);
    expect(state(await f.service.confirm("plan", f.version))).toBe("published");
  });
  it("keeps timeout unknown and reconciles late success without reposting", async () => {
    const f = fixture(); f.forge.createIssueComment.mockRejectedValueOnce(new Error("timeout"));
    expect(state(await f.service.confirm("plan", f.version))).toBe("uncertain");
    expect(() => f.service.confirm("plan", f.version)).toThrow(/reconcile/);
    expect(state(await f.service.confirm("plan", f.version, true))).toBe("uncertain");
    f.forge.reconcileIssueComment.mockResolvedValueOnce({ state: "found", comment } as never);
    expect(state(await f.service.confirm("plan", f.version, true))).toBe("published");
    expect(f.forge.createIssueComment).toHaveBeenCalledTimes(1);
  });
  it("reconstructs interrupted intent as uncertain with no startup reads/writes; explicit recovery reuses snapshot", async () => {
    const f = fixture();
    f.append("plan", { type: "issue_comment_outcome", ...f.version, state: "publishing", operationId: f.draft.operationId, repo: f.draft.repo, issueNumber: 7, bodyIdentity: f.draft.bodyIdentity });
    const rebooted = new IssueComments(f.store); rebooted.recover("plan");
    expect(state(f.history.at(-1)!)).toBe("uncertain");
    expect(f.forge.repoOf).not.toHaveBeenCalled(); expect(f.forge.createIssueComment).not.toHaveBeenCalled();
    f.forge.reconcileIssueComment.mockResolvedValueOnce({ state: "found", comment } as never);
    expect(state(await rebooted.confirm("plan", f.version, true))).toBe("published");
  });
  it("recovers remote-success-before-local-result failure and does not claim premature success", async () => {
    const f = fixture(); const append = f.store.append;
    f.store.append = (id, payload) => { if (payload.type === "issue_comment_outcome" && payload.state === "published") throw new Error("DB failed"); return append(id, payload); };
    const s = new IssueComments(f.store);
    expect(state(await s.confirm("plan", f.version))).toBe("uncertain");
    f.store.append = append;
    f.forge.reconcileIssueComment.mockResolvedValueOnce({ state: "found", comment } as never);
    expect(state(await new IssueComments(f.store).confirm("plan", f.version, true))).toBe("published");
    expect(f.forge.createIssueComment).toHaveBeenCalledTimes(1);
  });
  it("does not write when intent persistence fails and does not resurrect deletion during a request", async () => {
    const f = fixture(); f.store.append = () => { throw new Error("DB failed"); };
    await expect(f.service.confirm("plan", f.version)).rejects.toThrow("DB failed");
    expect(f.forge.createIssueComment).not.toHaveBeenCalled();
    const g = fixture(); let release!: () => void;
    g.forge.createIssueComment.mockImplementationOnce(async () => { await new Promise<void>((r) => { release = r; }); return comment; });
    const pending = g.service.confirm("plan", g.version);
    await vi.waitFor(() => expect(release).toBeDefined());
    g.remove(); release();
    await expect(pending).rejects.toThrow("No task");
    expect(g.history).toEqual([]);
  });
});

it("revalidates supersession after awaited host reads before POST", async () => {
  const f = fixture(); let release!: () => void;
  f.forge.readIssue.mockImplementationOnce(async () => { await new Promise<void>((r) => { release = r; }); return issue; });
  const pending = f.service.confirm("plan", f.version);
  await vi.waitFor(() => expect(release).toBeDefined());
  f.append("plan", { type: "task_proposal", title: "New", spec: "Revised", issue: { number: 7, url: issue.url } });
  release(); expect(state(await pending)).toBe("failed");
  expect(f.forge.createIssueComment).not.toHaveBeenCalled();
});
