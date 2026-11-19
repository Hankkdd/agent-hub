import { afterEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { PrUpdate, Task, TaskEvent, TaskReport } from "@agent-hub/shared";
import { ChatTab } from "./chat-tab";
import { setLanguage, t } from "@/i18n";
vi.mock("@/lib/client", () => ({ client: {}, label: (value: string) => value }));
const task = { id: "plan", title: "Plan", workflow: "plan", status: "idle", options: {}, sessions: [] } as unknown as Task;
const revision = { head: "feature/task", headSha: "a".repeat(40), target: "release/v2", targetSha: "b".repeat(40), crossRepository: false };
const operation: PrUpdate = { id: "operation", pr: { repo: "example/repo", number: 41 }, revision, stage: "failed", owned: true, resultSha: "c".repeat(40), tests: "failed", error: "Integration tests failed" };
const report: TaskReport = { taskId: "worker", title: "Worker", finalSeq: 10, outcome: "update_failed", rounds: 1, lastVerdict: "approve", findings: [], test: "failed", filesChanged: 1, additions: 1, deletions: 0, branch: revision.head, pr: { number: 41, url: "https://github.com/example/repo/pull/41" }, prUpdate: operation };
const event = { id: "event", taskId: task.id, sessionId: null, createdAt: "", seq: 1 };
afterEach(() => setLanguage("zh-TW"));
it.each(["en", "zh-TW"] as const)("renders worker update progress and planner evidence distinctly from a new PR in %s", (language) => {
  setLanguage(language);
  const events: TaskEvent[] = [
    { ...event, id: "conflict", seq: 1, type: "pr_conflict", revision, state: "conflicting" },
    { ...event, id: "update", seq: 2, type: "pr_update", update: operation },
    { ...event, id: "report", seq: 3, type: "task_report", report },
  ];
  const html = renderToStaticMarkup(<ChatTab task={task} events={events} onSelectTask={vi.fn()} />);
  for (const text of [t("prConflict.conflicting"), t("report.update_failed"), t("prUpdate.failed"), t("prUpdate.tests.failed"), "release/v2", "cccccccc", "Integration tests failed", "https://github.com/example/repo/pull/41"]) expect(html).toContain(text);
  expect(html).not.toContain(t("diff.openPr"));
});

it.each(["en", "zh-TW"] as const)("renders abandonment as its own terminal worker/planner outcome in %s", language => {
  setLanguage(language);
  const abandoned: PrUpdate = { ...operation, stage: "abandoned", owned: false, error: undefined, tests: undefined };
  const events: TaskEvent[] = [{ ...event, type: "pr_update", update: abandoned },
    { ...event, id: "report", seq: 2, type: "task_report", report: { ...report, outcome: "update_abandoned", prUpdate: abandoned, test: "none" } }];
  const html = renderToStaticMarkup(<ChatTab task={task} events={events} onSelectTask={vi.fn()} />);
  expect(html).toContain(t("report.update_abandoned")); expect(html).toContain(t("prUpdate.abandoned"));
  expect(html).toContain(report.pr!.url); expect(html).not.toContain(t("diff.openPr"));
});

it.each(["en", "zh-TW"] as const)("explains retained untracked files in the planner abandonment report in %s", language => {
  setLanguage(language);
  const abandoned: PrUpdate = { ...operation, stage: "abandoned", owned: false,
    retainedUntracked: { paths: ["unfinished/<notes>.txt"], total: 2 } };
  const events: TaskEvent[] = [{ ...event, type: "task_report", report: { ...report, outcome: "update_abandoned", prUpdate: abandoned } }];
  const html = renderToStaticMarkup(<ChatTab task={task} events={events} onSelectTask={vi.fn()} />);
  expect(html).toContain(t("prUpdate.leftovers", { count: 2 }));
  expect(html).toContain(t("prUpdate.leftoversTruncated", { count: 1 }));
  expect(html).toContain("unfinished/&lt;notes&gt;.txt");
  expect(html).not.toContain(t("diff.openPr"));
});
