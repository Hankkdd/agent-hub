import type { IssueCommentDraft, TaskEvent } from "@agent-hub/shared";

/** Append-only event projection: HTTP command responses never replace this state. */
export function issueCommentProjection(events: TaskEvent[], proposalId: string) {
  const versions = events.filter((e) => e.type === "issue_comment_draft" && e.proposalId === proposalId);
  const draft = versions.at(-1);
  if (draft?.type !== "issue_comment_draft") return null;
  const source = events.find((e) => e.id === proposalId);
  const result = events.filter((e) => e.type === "issue_comment_outcome" && e.draftId === draft.draftId && e.revision === draft.revision).at(-1);
  const outcome = result?.type === "issue_comment_outcome" ? result : undefined;
  const superseded = events.some((e) => e.type === "task_proposal" && e.seq > (source?.seq ?? Infinity) && e.issue?.number === draft.issue.number);
  const state: "draft" | "superseded" | "preparing" | "publishing" | "published" | "failed" | "uncertain" = outcome?.state === "published" ? "published" : superseded && (!outcome || outcome.state === "failed") ? "superseded" : outcome?.state ?? "draft";
  return { draft, state, outcome, superseded };
}
export function issueCommentVersion(draft: IssueCommentDraft) { return { draftId: draft.draftId, revision: draft.revision }; }
