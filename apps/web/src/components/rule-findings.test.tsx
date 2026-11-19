import { afterEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Task, TaskEvent } from "@agent-hub/shared";
import { ChatTab } from "./chat-tab";
import { setLanguage, t } from "@/i18n";
vi.mock("@/lib/client", () => ({ client: {}, label: (value: string) => value }));
afterEach(() => setLanguage("zh-TW"));
it.each(["en", "zh-TW"] as const)("renders optional rule badges alongside severity in %s", language => {
  setLanguage(language);
  const task = { id: "review", workflow: "review", options: {}, sessions: [] } as unknown as Task;
  const event: TaskEvent = { id: "finding", taskId: task.id, sessionId: null, createdAt: "", seq: 1,
    type: "review_result", verdict: "changes", round: 1, findings: [
      { rule: "sc-12", severity: "medium", location: "example.ts:1", message: "Rule violation" },
      { severity: "low", location: "old.ts:2", message: "Legacy finding" },
    ] };
  const html = renderToStaticMarkup(<ChatTab task={task} events={[event]} onSelectTask={() => {}} />);
  expect(html).toContain("sc-12");
  expect(html).toContain(`title="${t("review.rule")}"`);
  expect(html.split(`title="${t("review.rule")}"`)).toHaveLength(2);
  expect(html).toContain(t("severity.medium"));
  expect(html).toContain("Legacy finding");
});
