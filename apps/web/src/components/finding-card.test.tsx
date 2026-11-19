import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Task, TaskEvent } from "@agent-hub/shared";
import { FindingCard } from "./finding-card";
import { t } from "@/i18n";
vi.mock("@/lib/client", () => ({ client: { retryFindingExport: vi.fn() } }));
const finding: Extract<TaskEvent, { type: "finding_recorded" }> = { id: "observation", taskId: "task", sessionId: "session", seq: 1, createdAt: "2026-10-14", type: "finding_recorded", findingId: "logical", submission: "digest", project: "/example/project", agent: "codex", topic: "cache-lifetime", title: "Cache lifetime", evidence: "Concrete evidence" };
const task = { id: "task", status: "idle", options: { findingExport: { documentsDir: "/example/documents", owner: "Owner" } } } as Task;
const result = (state: "exported" | "conflict", seq: number): TaskEvent => ({ id: String(seq), taskId: "task", sessionId: null, seq, createdAt: "2026-10-14", type: "finding_export", findingId: "logical", observationIds: [finding.id], state, document: "personal-view/agent-findings/cache-lifetime.md", ...(state === "exported" ? { commit: "commit-id" } : { reason: "Manual note edit" }) });
const render = (events: TaskEvent[], current = task) => renderToStaticMarkup(<FindingCard finding={finding} events={JSON.parse(JSON.stringify(events))} task={current} />);
it("rebuilds pending/unconfigured/exported/conflict state from durable events and task options", () => {
  expect(render([finding])).toContain(t("finding.pending"));
  expect(render([finding], { ...task, options: {} })).toContain(t("finding.unconfigured"));
  const exported = render([finding, result("exported", 2)]);
  expect(exported).toContain("commit-id"); expect(exported).not.toContain(t("finding.retry"));
  const conflicted = render([finding, result("exported", 2), result("conflict", 3)]);
  expect(conflicted).toContain("Manual note edit"); expect(conflicted).toContain(t("finding.retry")); expect(conflicted).toContain(t("finding.authority"));
  expect(render([finding, result("conflict", 2), result("exported", 3)])).not.toContain("Manual note edit");
});
it("disables export retry while the task is running", () => {
  expect(render([finding], { ...task, status: "running" })).toContain('disabled=""');
});
