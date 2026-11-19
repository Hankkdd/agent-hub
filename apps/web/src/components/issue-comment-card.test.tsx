import { afterEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Task, TaskEvent } from "@agent-hub/shared";
import { IssueCommentCard } from "./issue-comment-card";
import { issueCommentProjection, issueCommentVersion } from "./issue-comment-projection";
import { ChatTab } from "./chat-tab";
import { setLanguage, t } from "@/i18n";
vi.mock("@/lib/client", () => ({ client: { issueComment: vi.fn() }, label: (s: string) => s }));
const envelope = { taskId: "plan", sessionId: null, createdAt: "" };
const proposal: TaskEvent = { ...envelope, id: "proposal", seq: 1, type: "task_proposal", title: "Source", spec: "English worker instructions", issue: { number: 7, url: "https://github.com/example/project/issues/7" } };
const draft: Extract<TaskEvent, { type: "issue_comment_draft" }> = { ...envelope, id: "draft-event", seq: 2, type: "issue_comment_draft", draftId: "draft", revision: 1, proposalId: proposal.id, sourceIdentity: "source-hash", sourceReference: "plan/proposal", repo: "example/project", issue: { number: 7, title: "Requirements", url: "https://github.com/example/project/issues/7" }, operationId: "operation", content: "## 驗收條件\n\n1. Confirm", body: '## 驗收條件\n\n1. Confirm\n<script>alert(1)</script>\n<!-- agent-hub-requirements:operation -->', bodyIdentity: "body-hash" };
const task = { id: "plan", workflow: "plan", status: "idle", options: {}, sessions: [] } as unknown as Task;
const outcome = (state: "preparing" | "publishing" | "published" | "failed" | "uncertain"): TaskEvent => ({ ...envelope, id: "outcome", seq: 3, type: "issue_comment_outcome", ...issueCommentVersion(draft), operationId: draft.operationId, bodyIdentity: draft.bodyIdentity, repo: draft.repo, issueNumber: 7, state, ...(state === "published" ? { comment: { id: 42, url: `${draft.issue.url}#issuecomment-42` } } : {}), ...(state === "uncertain" ? { error: "unknown" } : {}) });
const render = (events: TaskEvent[]) => renderToStaticMarkup(<IssueCommentCard taskId="plan" proposalId={proposal.id} events={JSON.parse(JSON.stringify(events))} />);
afterEach(() => setLanguage("zh-TW"));

it.each(["en", "zh-TW"] as const)("renders localized accessible exact preview and explicit external action in %s without executing raw HTML", (language) => {
  setLanguage(language);
  const html = render([proposal, draft]);
  for (const value of [t("issueComment.title"), t("issueComment.confirm"), t("issueComment.independent"), t("issueComment.exact"), "example/project", "plan/proposal", "agent-hub-requirements:operation", 'role="status"', 'aria-label=', "flex-wrap", "min-w-0"]) expect(html).toContain(value);
  expect(html).not.toContain("<script>");
  expect(html).toContain("&lt;script&gt;");
});
it("projects saved revision exactly across reload and handoff without changing source provenance", () => {
  const next = { ...draft, id: "revision-event", revision: 2, seq: 3, content: "Saved edit", body: "Saved edit + protected source", operationId: "operation2" };
  const projected = issueCommentProjection(JSON.parse(JSON.stringify([proposal, draft, next])), proposal.id)!;
  expect(projected.draft.revision).toBe(2);
  expect(projected.draft.sourceIdentity).toBe(draft.sourceIdentity);
  expect(issueCommentVersion(projected.draft)).toEqual({ draftId: "draft", revision: 2 });
  const html = renderToStaticMarkup(<ChatTab task={{ ...task, options: { activeMainSessionId: "switched" } }} events={[proposal, draft, next]} onSelectTask={() => {}} />);
  expect(html).toContain("English worker instructions"); expect(html).toContain(next.body);
  expect(html.split(t("issueComment.confirm"))).toHaveLength(2);
  expect(html).not.toContain(draft.body);
});
it("published and superseded cards preserve history and cannot republish; uncertain only reconciles", () => {
  const published = render([proposal, draft, outcome("published")]);
  expect(published).toContain("#issuecomment-42"); expect(published).not.toContain(t("issueComment.confirm"));
  for (const state of ["preparing", "publishing"] as const) {
    const html = render([proposal, draft, outcome(state)]);
    expect(html).not.toContain(t("issueComment.confirm")); expect(html).not.toContain(t("issueComment.reconcile"));
  }
  const unknown = render([proposal, draft, outcome("uncertain")]);
  expect(unknown).toContain(t("issueComment.reconcile")); expect(unknown).toContain(t("issueComment.unknownHelp"));
  expect(unknown).not.toContain(t("issueComment.confirm"));
  const superseded = render([proposal, draft, { ...proposal, id: "new", seq: 5 }]);
  expect(superseded).toContain(t("issueComment.superseded")); expect(superseded).not.toContain(t("issueComment.confirm"));
  expect(render([proposal, draft, outcome("failed")])).toContain(t("issueComment.confirm"));
});
