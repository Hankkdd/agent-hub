import { afterEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Task, TaskEvent } from "@agent-hub/shared";
import { setLanguage, t } from "@/i18n";
import { groupTasks, taskState } from "@/lib/task-groups";
import { ChatTab } from "./chat-tab";
import { QuotaPauseBanner } from "./quota-pause-banner";
import { SidebarTaskRow } from "./sidebar-task-row";

vi.mock("@/i18n", async (original) => ({ ...await original<object>(), useLanguage: () => "en" }));
vi.mock("@/lib/client", () => ({ client: {}, label: (agent: string) => agent === "codex" ? "Codex" : "Claude" }));

const session = { id: "s1", taskId: "p", agent: "codex", role: "main", model: null, effort: null, sdkThreadId: null, status: "failed" } as const;
const paused = (resetsAt: string | null, workflow: Task["workflow"] = "chat"): Task => ({
  id: "p", title: "Paused chat", workflow, status: "paused", activity: "Waiting for Codex quota", cwd: "/tmp/x", workspace: null,
  options: { quotaPause: { agent: "codex", resetsAt, since: "" } }, sessions: [session], createdAt: "", updatedAt: "",
});
afterEach(() => { setLanguage("zh-TW"); vi.useRealTimers(); });

it("groups a paused task with the waiting tasks, not with the failed ones", () => {
  const task = paused(null);
  expect(taskState(task)).toBe("standby");
  expect(groupTasks([task])[0]!.groups.standby.map((r) => r.task.id)).toEqual(["p"]);
  expect(groupTasks([task])[0]!.groups.needsYou).toEqual([]);
});

it.each(["zh-TW", "en"] as const)("shows the localized waiting line in the sidebar in %s", (language) => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 9, 16, 8));
  setLanguage(language);
  const reset = new Date(2026, 9, 16, 21, 41).toISOString();
  const row = (task: Task) => renderToStaticMarkup(<SidebarTaskRow task={task} state="standby" depth={0} selectedId={null} onSelect={() => {}} onPin={() => {}} />);
  expect(row(paused(reset))).toContain(t("quotaPause.waiting", { agent: "Codex", time: "21:41" }));
  expect(row(paused(null))).toContain(t("quotaPause.waiting", { agent: "Codex", time: t("quotaPause.timeUnknown") }));
  expect(t("quotaPause.waiting", { agent: "Codex", time: "21:41" })).toBe(language === "en" ? "Waiting for Codex quota, continues around 21:41" : "等 Codex 額度，約 21:41 後自動繼續");
});

it.each(["zh-TW", "en"] as const)("renders the three controls on a paused chat in %s", (language) => {
  setLanguage(language);
  const html = renderToStaticMarkup(<QuotaPauseBanner task={paused(null)} events={[]} />);
  for (const key of ["quotaPause.continueNow", "quotaPause.stopWaiting"] as const) expect(html).toContain(t(key));
  expect(html).toContain(t("quotaPause.switchTo", { agent: "Claude" }));
});

it("offers no agent switch on implement tasks", () => {
  setLanguage("en");
  const html = renderToStaticMarkup(<QuotaPauseBanner task={paused(null, "implement")} events={[]} />);
  expect(html).toContain("Continue now");
  expect(html).not.toContain("Switch to");
});


it.each(["zh-TW", "en"] as const)("keeps queued feedback accurate through quota and capacity waits until consumption in %s", language => {
  setLanguage(language);
  const task = paused(null);
  const event: TaskEvent = { id: "message", taskId: task.id, sessionId: null, seq: 1, createdAt: "", type: "user_message", text: "Waiting message", queued: true };
  const markup = (selected: Task, row = event) => renderToStaticMarkup(<ChatTab task={selected} events={[row]} onSelectTask={() => {}} />);
  expect(markup(task)).toContain(t("chat.queuedQuota"));
  expect(markup(task)).not.toContain(t("chat.queued"));
  const waitingForSlot = { ...task, status: "running" as const, options: {}, activity: "Waiting for a free slot (1 running)" };
  expect(markup(waitingForSlot)).toContain(t("chat.queued"));
  expect(markup({ ...task, status: "idle", options: {} })).toContain(t("chat.queued"));
  expect(markup(waitingForSlot, { ...event, queued: undefined })).not.toContain(t("chat.queued"));
  expect(markup(waitingForSlot, { ...event, queued: undefined })).not.toContain(t("chat.queuedQuota"));
});
