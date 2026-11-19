import { afterEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Task, TaskEvent } from "@agent-hub/shared";
import { ChatTab } from "./chat-tab";
import { setLanguage, t } from "@/i18n";
vi.mock("@/lib/client", () => ({ client: {}, label: vi.fn() }));
const task = { id: "task", workflow: "implement", status: "idle", options: {}, sessions: [], workspace: { state: "active" } } as unknown as Task;
const draft: Extract<TaskEvent, { type: "pr_draft" }> = { id: "draft", taskId: task.id, sessionId: null, seq: 3, createdAt: "", type: "pr_draft", by: "agent", changeType: "fix", branch: "fix/plain-pr", commitMessage: "fix: Allow plain PR", title: "fix: Allow plain PR", body: "Plain description", briefingError: "Guide unavailable" };
const render = (events: TaskEvent[]) => renderToStaticMarkup(<ChatTab task={task} events={JSON.parse(JSON.stringify(events))} onSelectTask={() => {}} />);
afterEach(() => setLanguage("zh-TW"));
it.each(["zh-TW", "en"] as const)("shows the missing briefing warning and permits confirmation in %s", (language) => {
  setLanguage(language);
  const failed: TaskEvent = { id: "failure", taskId: task.id, sessionId: null, seq: 2, createdAt: "", type: "briefing_failed", generationId: "generation", error: draft.briefingError!, interrupted: false };
  const html = render([failed, draft]);
  expect(html).toContain(t("prDraft.briefingError", { reason: draft.briefingError! }));
  expect(html).toContain('role="alert"'); expect(html).toContain(t("prDraft.confirm"));
  expect(html).not.toContain(t("prDraft.stale")); expect(html).toContain(t("prDraft.edit"));
});
it("keeps legacy missing-briefing drafts stale and invalidates a plain draft after a later briefing attempt", () => {
  expect(render([{ ...draft, briefingError: undefined }])).toContain(t("prDraft.stale"));
  const later: TaskEvent = { id: "later", taskId: task.id, sessionId: null, seq: 4, createdAt: "", type: "briefing_started", generationId: "new" };
  const html = render([draft, later]);
  expect(html).toContain(t("prDraft.stale")); expect(html).not.toContain(t("prDraft.confirm"));
});
