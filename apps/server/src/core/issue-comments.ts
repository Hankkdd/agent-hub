import { createHash, randomUUID } from "node:crypto";
import type { IssueCommentDraft, IssueCommentEdit, IssueRequirementSummary, Task, TaskEvent, TaskEventPayload } from "@agent-hub/shared";
import { CommentWriteError, type Forge, type Issue } from "../workspace/forge";
import { issueCommentsZhTW } from "./issue-comments.zh-TW";

export const commentHash = (text: string) => createHash("sha256").update(text).digest("hex");
export class IssueCommentError extends Error {
  constructor(readonly status: 400 | 404 | 409, message: string) { super(message); }
}
export function validateIssueSummary(input: unknown): IssueRequirementSummary {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new IssueCommentError(400, "Invalid issue summary");
  const value = input as Record<string, unknown>;
  if (Object.keys(value).sort().join() !== "acceptanceCriteria,behavior,outOfScope,problem") throw new IssueCommentError(400, "Invalid summary fields");
  const field = (v: unknown, max: number) => {
    if (typeof v !== "string" || !v.trim() || v.length > max || v.includes("\0")) throw new IssueCommentError(400, "Invalid summary text");
    return v.trim();
  };
  const list = (v: unknown) => {
    if (!Array.isArray(v) || !v.length || v.length > 30) throw new IssueCommentError(400, "Invalid summary list");
    return v.map((item) => field(item, 2000));
  };
  const result = { problem: field(value.problem, 4000), behavior: list(value.behavior), acceptanceCriteria: list(value.acceptanceCriteria), outOfScope: list(value.outOfScope) };
  if (JSON.stringify(result).length > 16000) throw new IssueCommentError(400, "Issue summary exceeds 16000 characters");
  return result;
}

export function normalizedCommentRepo(repo: string): string {
  if (!/^[a-z\d](?:[a-z\d-]*[a-z\d])?\/[a-z\d_.-]+$/i.test(repo)) throw new IssueCommentError(400, "Invalid GitHub repository");
  return repo.toLowerCase();
}

function contentText(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 24000 || value.includes("\0") || /agent-hub-(?:requirements|source)/i.test(value))
    throw new IssueCommentError(400, "Comment content must be 1–24000 characters without reserved Hub markers");
  return value;
}
function snapshot(draft: IssueCommentDraft): IssueCommentDraft {
  const body = `${draft.content}\n\n---\n${issueCommentsZhTW.sourceVersion}${draft.sourceReference}\n${issueCommentsZhTW.publicSummaryNotice}\n<!-- agent-hub-requirements:${draft.operationId} -->`;
  return { ...draft, body, bodyIdentity: commentHash(body) };
}
export function initialCommentDraft(proposal: Extract<TaskEvent, { type: "task_proposal" }>, repo: string, issue: Issue): IssueCommentDraft {
  const summary = validateIssueSummary(proposal.issueSummary);
  const numbered = (items: string[]) => items.map((item, i) => `${i + 1}. ${item.replace(/\n/g, "\n   ")}`).join("\n");
  const content = `## ${issueCommentsZhTW.problem}\n\n${summary.problem}\n\n## ${issueCommentsZhTW.behavior}\n\n${numbered(summary.behavior)}\n\n## ${issueCommentsZhTW.acceptanceCriteria}\n\n${numbered(summary.acceptanceCriteria)}\n\n## ${issueCommentsZhTW.outOfScope}\n\n${numbered(summary.outOfScope)}`;
  contentText(content);
  return snapshot({ draftId: randomUUID(), revision: 1, proposalId: proposal.id,
    sourceIdentity: commentHash(JSON.stringify({ title: proposal.title, spec: proposal.spec, testCommand: proposal.testCommand, ticket: proposal.ticket, scopeEstimate: proposal.scopeEstimate, issue: proposal.issue, summary })),
    sourceReference: `${proposal.taskId}/${proposal.id}`, repo: normalizedCommentRepo(repo),
    issue: { number: issue.number, url: `https://github.com/${normalizedCommentRepo(repo)}/issues/${issue.number}`, title: issue.title },
    operationId: randomUUID(), content, body: "", bodyIdentity: "" });
}

interface CommentStore {
  task(id: string): Task;
  events(id: string): TaskEvent[];
  append(id: string, payload: TaskEventPayload): TaskEvent;
  forge?: Forge;
}

/** Only authenticated HTTP commands call this service. Planning MCP can only prepare an initial draft. */
export class IssueComments {
  private readonly jobs = new Map<string, Promise<TaskEvent>>();
  constructor(private readonly store: CommentStore) {}

  private current(taskId: string, input: unknown, edit = false) {
    const task = this.store.task(taskId);
    if (task.workflow !== "plan" || !task.cwd) throw new IssueCommentError(400, "Issue comments require a saved planning task");
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new IssueCommentError(400, "Invalid comment command");
    const v = input as IssueCommentEdit;
    const allowed = edit ? ["draftId", "revision", "content"] : ["draftId", "revision"];
    if (Object.keys(v).some((key) => !allowed.includes(key)) || typeof v.draftId !== "string" || !v.draftId || v.draftId.length > 128 || !Number.isSafeInteger(v.revision) || v.revision < 1)
      throw new IssueCommentError(400, "Invalid draft version");
    const history = this.store.events(taskId);
    const draft = history.filter((e) => e.type === "issue_comment_draft" && e.draftId === v.draftId).at(-1);
    if (draft?.type !== "issue_comment_draft") throw new IssueCommentError(404, "No draft in this planning task");
    if (draft.revision !== v.revision) throw new IssueCommentError(409, "Draft changed; preview its latest saved version");
    const outcome = history.filter((e) => e.type === "issue_comment_outcome" && e.draftId === draft.draftId && e.revision === draft.revision).at(-1);
    const result = outcome?.type === "issue_comment_outcome" ? outcome : undefined;
    const source = history.find((e) => e.id === draft.proposalId);
    if (source?.type !== "task_proposal") throw new IssueCommentError(409, "Source proposal is unavailable");
    const superseded = history.some((e) => e.type === "task_proposal" && e.seq > source.seq && e.issue?.number === draft.issue.number);
    return { task, draft, result, superseded };
  }

  edit(taskId: string, input: unknown): TaskEvent {
    const { draft, result, superseded } = this.current(taskId, input, true);
    if (superseded || (result && result.state !== "failed")) throw new IssueCommentError(409, "Draft is superseded, publishing, uncertain or already published");
    const content = contentText((input as IssueCommentEdit).content);
    const { id, taskId: _, sessionId, seq, createdAt, type, ...prior } = draft;
    return this.store.append(taskId, { type: "issue_comment_draft", ...snapshot({ ...prior, content, revision: draft.revision + 1, operationId: randomUUID() }) });
  }

  confirm(taskId: string, input: unknown, reconcile = false): Promise<TaskEvent> {
    const { task, draft, result, superseded } = this.current(taskId, input);
    if (result?.state === "published") return Promise.resolve(result);
    const key = `${taskId}/${draft.operationId}`;
    const job = this.jobs.get(key);
    if (job) return job;
    if (superseded && !reconcile) throw new IssueCommentError(409, "A newer proposal superseded this draft");
    if (!reconcile && result && result.state !== "failed") throw new IssueCommentError(409, "Publication may have occurred; reconcile explicitly, do not repost");
    if (reconcile && (!result || result.state === "failed")) throw new IssueCommentError(409, "No uncertain publication to reconcile");
    // run() records intent synchronously before its first await. Other clients observe that intent.
    const done = this.run(task, draft, reconcile).finally(() => this.jobs.delete(key));
    this.jobs.set(key, done);
    return done;
  }

  private async run(task: Task, draft: IssueCommentDraft, reconcile: boolean): Promise<TaskEvent> {
    const outcome = (state: "preparing" | "publishing" | "published" | "failed" | "uncertain", extra = {}) => {
      this.store.task(task.id);
      return this.store.append(task.id, {
        type: "issue_comment_outcome", draftId: draft.draftId, revision: draft.revision, operationId: draft.operationId,
        bodyIdentity: draft.bodyIdentity, repo: draft.repo, issueNumber: draft.issue.number, state, ...extra,
      });
    };
    if (!reconcile) outcome("preparing");
    let mayHavePosted = reconcile;
    try {
      const forge = this.store.forge;
      if (!forge?.createIssueComment || !forge.reconcileIssueComment) throw new Error("Issue comment publication is unavailable");
      const repo = await forge.repoOf(task.cwd!);
      if (!repo || normalizedCommentRepo(repo) !== draft.repo) throw new Error("Repository origin changed; saved destination cannot be redirected");
      const issue = await forge.readIssue(draft.repo, draft.issue.number);
      if (issue.number !== draft.issue.number) throw new Error("Bound issue does not match");
      // Awaited reads may race with deletion, editing or a newer proposal.
      const current = this.current(task.id, { draftId: draft.draftId, revision: draft.revision });
      if (!reconcile && current.superseded) throw new Error("A newer proposal superseded this draft");
      if (reconcile) {
        const found = await forge.reconcileIssueComment(draft.repo, draft.issue.number, draft.body, draft.operationId);
        if (found.state === "found") return outcome("published", { comment: found.comment });
        return outcome("uncertain", { error: "Remote outcome remains unknown. Check the issue manually; no comment was reposted." });
      }
      outcome("publishing");
      mayHavePosted = true;
      const comment = await forge.createIssueComment(draft.repo, draft.issue.number, draft.body);
      return outcome("published", { comment });
    } catch (error) {
      // A remote write can succeed even when its response, or the local result commit, fails.
      this.store.task(task.id); // A deleted task must never be recreated by a late result.
      return outcome((reconcile || (mayHavePosted && !(error instanceof CommentWriteError && error.definite))) ? "uncertain" : "failed", {
        error: mayHavePosted ? "GitHub publication could not be confirmed. Reconcile or check the issue manually before any further action." : "Publication preparation failed. Check repository access and the current proposal before retrying.",
      });
    }
  }

  recover(taskId: string): void {
    const history = this.store.events(taskId);
    for (const draft of history.filter((e) => e.type === "issue_comment_draft")) {
      if (draft.type !== "issue_comment_draft") continue;
      const last = history.filter((e) => e.type === "issue_comment_outcome" && e.operationId === draft.operationId).at(-1);
      if (last?.type === "issue_comment_outcome" && (last.state === "preparing" || last.state === "publishing")) {
        const { id, taskId: _, sessionId, seq, createdAt, type, ...prior } = last;
        this.store.append(taskId, { type: "issue_comment_outcome", ...prior, state: "uncertain", error: "Publication interrupted by restart; reconcile explicitly. No automatic repost." });
      }
    }
  }
}
