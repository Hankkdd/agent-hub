import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readProjectCollapse, SidebarProject } from "../components/sidebar-project";
import { setLanguage } from "../i18n";
import { describe, expect, it } from "vitest";
import type { Task, TaskListSummary, Workspace } from "@agent-hub/shared";
import { COLLAPSED_STATES, DISPLAY_STATES, groupTasks, taskState } from "./task-groups";

const task = (id: string, status: Task["status"], reportsTo?: string): Task => ({
  id, status, title: id, workflow: reportsTo ? "review" : "plan", options: { reportsTo },
  activity: null, cwd: null, workspace: null, sessions: [], createdAt: "", updatedAt: "",
});
const ws = (state?: "open" | "closed" | "merged"): Workspace => ({
  id: "ws", repoPath: "/repos/project", worktreePath: "/worktrees/task", branch: "task", baseRef: "main", baseSha: "sha", state: "active",
  ...(state ? { pr: { state, number: 1, url: "https://example.invalid/pr/1" } } : { prDraft: { type: "feat", summary: "Draft", slug: "draft", body: "Draft" } }),
});
const summary = (id: string, root: string | null): TaskListSummary => ({ taskId: id, project: root ? { id: root, name: root.split("/").at(-1)! } : null, pendingAsk: false, awaitingAcceptance: false });
const rows = (tasks: Task[], facts: TaskListSummary[] = []) => groupTasks(tasks, facts).flatMap((p) => DISPLAY_STATES.flatMap((s) => p.groups[s].map((r) => [r.task.id, r.depth, s, r.state])));

describe("project groups shared by desktop and phone", () => {
  it.each([
    ["idle", "running", "running"], ["done", "waiting_user", "needsYou"],
    ["idle", "failed", "needsYou"], ["idle", "interrupted", "needsYou"],
    ["idle", "done", "finished"],
  ] as const)("aggregates %s parent and %s worker as %s", (parent, child, state) => {
    expect(rows([task("child", child, "parent"), task("parent", parent)])).toEqual([
      ["parent", 0, state, state], ["child", 1, state, taskState(task("child", child, "parent"))],
    ]);
  });

  it("keeps standalone idle conversations on standby and open PRs above standby", () => {
    const worker = { ...task("worker", "idle", "parent"), workspace: ws("open") };
    expect(rows([worker, task("parent", "idle"), { ...task("chat", "idle"), workflow: "chat" }])).toEqual([
      ["chat", 0, "standby", "standby"], ["parent", 0, "prAwaitingMerge", "prAwaitingMerge"], ["worker", 1, "prAwaitingMerge", "prAwaitingMerge"],
    ]);
  });

  it("uses needs-you, running, and open PR precedence and ignores finished children", () => {
    const tasks = [task("root", "done"), task("running", "running", "root"), { ...task("pr", "idle", "root"), workspace: ws("open") }, task("closed", "done", "root")];
    expect(rows(tasks)[0]![2]).toBe("running");
    expect(rows([...tasks, task("blocked", "waiting_user", "root")])[0]![2]).toBe("needsYou");
    expect(rows(tasks.filter((t) => t.id !== "running"))[0]![2]).toBe("prAwaitingMerge");
  });

  it("keeps drafts and closed unmerged retained worktrees needing acceptance", () => {
    expect(taskState({ ...task("draft", "idle", "plan"), workspace: ws() })).toBe("needsYou");
    expect(taskState({ ...task("closed", "done", "plan"), workspace: ws("closed") })).toBe("needsYou");
    expect(taskState({ ...task("merged", "idle", "plan"), workspace: ws("merged") })).toBe("finished");
    expect(taskState({ ...task("merged", "running", "plan"), workspace: ws("merged") })).toBe("running");
    expect(taskState({ ...task("merged", "done", "plan"), workspace: ws("merged") }, { ...summary("merged", null), pendingAsk: true })).toBe("needsYou");
  });

  it("separates same-name repositories, inherits root projects, and sorts Other last", () => {
    const groups = groupTasks([task("child", "running", "root"), task("other", "idle"), task("root", "idle"), task("second", "idle")],
      [summary("root", "/a/project"), summary("child", "/worktrees/different"), summary("second", "/b/project")]);
    expect(groups.map((p) => [p.id, p.name, p.pathHint])).toEqual([["/a/project", "project", "/a/project"], ["/b/project", "project", "/b/project"], ["other", null, undefined]]);
    expect(groups[0]!.groups.running.map((r) => r.task.id)).toEqual(["root", "child"]);
  });

  it("preserves roots' recency and sibling order, including grandchildren and missing metadata", () => {
    const tasks = [task("second-child", "done", "parent"), task("grandchild", "done", "first-child"), task("first-child", "done", "parent"), task("recent", "idle"), task("parent", "idle")];
    expect(rows(tasks).map((r) => r.slice(0, 2))).toEqual([["recent", 0], ["parent", 0], ["second-child", 1], ["first-child", 1], ["grandchild", 2]]);
  });

  it("keeps orphans, self references, and cycles visible exactly once deterministically", () => {
    const tasks = [task("self", "idle", "self"), task("a", "done", "b"), task("b", "running", "a"), task("orphan", "failed", "removed")];
    expect(rows(tasks)).toEqual([["orphan", 0, "needsYou", "needsYou"], ["a", 0, "running", "running"], ["b", 1, "running", "running"], ["self", 0, "standby", "standby"]]);
    expect(new Set(rows(tasks).map((r) => r[0])).size).toBe(tasks.length);
  });
});


describe("shared project section presentation", () => {
  it("validates stored preferences and tolerates unavailable browser storage", () => {
    expect(readProjectCollapse({ getItem: () => '{"/repo":true,"other":false,"invalid":"true"}' })).toEqual({ "/repo": true, other: false });
    for (const value of ["null", "[]", "broken"]) expect(readProjectCollapse({ getItem: () => value })).toEqual({});
    expect(readProjectCollapse({ getItem: () => { throw new Error("unavailable"); } })).toEqual({});
  });
  it.each(["en", "zh-TW"] as const)("renders accessible native expansion buttons and root counts in %s", (language) => {
    setLanguage(language);
    const project = groupTasks([task("worker", "running", "plan"), task("plan", "idle"), task("idle", "idle")], [summary("plan", "/repos/example"), summary("idle", "/repos/example")])[0]!;
    const collapsed = renderToStaticMarkup(createElement(SidebarProject, { project, collapsed: true, onToggle: () => {}, children: "Conversation rows" }));
    expect(collapsed).toContain('type="button"');
    expect(collapsed).toContain('aria-expanded="false"');
    expect(collapsed).toContain(language === "en" ? 'aria-label="Expand example. ' : 'aria-label="展開 example。');
    expect(collapsed).toContain(language === "en" ? "Running · 1" : "執行中 · 1");
    expect(collapsed).toContain(language === "en" ? "Standby · 1" : "待命 · 1");
    expect(collapsed).not.toContain("· 0");
    expect(collapsed).not.toContain("Conversation rows");
    const expanded = renderToStaticMarkup(createElement(SidebarProject, { project, collapsed: false, onToggle: () => {}, children: "Conversation rows" }));
    expect(expanded).toContain('aria-expanded="true"');
    expect(expanded).toContain("Conversation rows");
    setLanguage("zh-TW");
  });
});

describe("global pinned shortcuts", () => {
  it("duplicates only individual pinned rows, preserving trees/counts, inherited facts, same-name hints and exact child IDs", async () => {
    const { pinnedShortcuts } = await import("./task-groups");
    const tasks = [task("child", "running", "parent"), task("parent", "idle"), task("second", "idle")];
    const facts = [summary("parent", "/a/project"), summary("child", "/wrong/project"), summary("second", "/b/project")];
    const original = groupTasks(tasks, facts);
    tasks[0]!.options.pinnedAt = "2026-01-02";
    tasks[1]!.options.pinnedAt = "2026-01-01";
    const projects = groupTasks(tasks, facts);
    const before = JSON.stringify(projects);
    const shortcuts = pinnedShortcuts(projects);
    expect(shortcuts.map((r) => [r.task.id, r.state, r.project.id, r.depth, r.parentTitle])).toEqual([
      ["parent", "running", "/a/project", 0, undefined], ["child", "running", "/a/project", 0, "parent"],
    ]);
    expect(shortcuts[1]!.project.pathHint).toBe("/a/project");
    expect(JSON.stringify(projects)).toBe(before);
    expect(projects.map((p) => DISPLAY_STATES.map((s) => p.groups[s].length))).toEqual(original.map((p) => DISPLAY_STATES.map((s) => p.groups[s].length)));
    // Project collapse affects its tree presentation, not the global projection.
    expect(readProjectCollapse({ getItem: () => '{"/a/project":true}' })[shortcuts[1]!.project.id]).toBe(true);
    expect(shortcuts[1]!.task.id).toBe("child");
  });

  it("sorts stable pin times with ID ties, ignores activity/recency and appends re-pins", async () => {
    const { pinnedShortcuts } = await import("./task-groups");
    const tasks = [task("b", "idle"), task("a", "idle"), task("c", "idle")];
    for (const t of tasks) t.options.pinnedAt = "2026-01-01";
    const ids = () => pinnedShortcuts(groupTasks(tasks)).map((r) => r.task.id);
    expect(ids()).toEqual(["a", "b", "c"]);
    tasks.reverse(); tasks[1]!.updatedAt = "2030-01-01"; tasks[1]!.status = "running";
    expect(ids()).toEqual(["a", "b", "c"]);
    delete tasks.find((t) => t.id === "a")!.options.pinnedAt;
    expect(ids()).toEqual(["b", "c"]);
    tasks.find((t) => t.id === "a")!.options.pinnedAt = "2026-01-02";
    expect(ids()).toEqual(["b", "c", "a"]);
  });

  it("handles cycles, orphans, self references, independent parent pins and deletion consistently", async () => {
    const { pinnedShortcuts } = await import("./task-groups");
    const tasks = [task("a", "idle", "b"), task("b", "running", "a"), task("orphan", "done", "missing"), task("self", "idle", "self")];
    expect(pinnedShortcuts(groupTasks(tasks))).toEqual([]);
    for (const t of tasks) t.options.pinnedAt = "2026-01-01";
    const shortcuts = pinnedShortcuts(groupTasks(tasks));
    expect(shortcuts.map((r) => r.task.id)).toEqual(["a", "b", "orphan", "self"]);
    expect(shortcuts.find((r) => r.task.id === "orphan")!.parentTitle).toBeUndefined();
    expect(shortcuts.find((r) => r.task.id === "self")!.parentTitle).toBeUndefined();
    delete tasks[0]!.options.pinnedAt;
    expect(pinnedShortcuts(groupTasks(tasks)).map((r) => r.task.id)).toEqual(["b", "orphan", "self"]);
    tasks.splice(0, 1);
    expect(pinnedShortcuts(groupTasks(tasks)).find((r) => r.task.id === "b")!.parentTitle).toBeUndefined();
  });
});

describe("transcript-only video tasks", () => {
  const video = (id: string, status: Task["status"], transcriptOnly = true): Task => ({ ...task(id, status), workflow: "video", options: { transcriptOnly } });
  const fact = (id: string, untouched: boolean): TaskListSummary => ({ ...summary(id, null), ...(untouched ? { transcriptOnlyUntouched: true } : {}) });

  it("keeps untouched ones out of Standby in their own collapsed group", () => {
    expect(rows([video("api", "idle")], [fact("api", true)])).toEqual([["api", 0, "apiTranscripts", "apiTranscripts"]]);
    expect(COLLAPSED_STATES).toContain("apiTranscripts");
  });

  it("returns them to the main lists once someone writes in them, and while they run or fail", () => {
    expect(rows([video("api", "idle")], [fact("api", false)])).toEqual([["api", 0, "standby", "standby"]]);
    expect(taskState(video("api", "running"), fact("api", true))).toBe("running");
    expect(taskState(video("api", "failed"), fact("api", true))).toBe("needsYou");
  });

  it("leaves ordinary video tasks unchanged", () => {
    expect(rows([video("summary", "idle", false)], [summary("summary", null)])).toEqual([["summary", 0, "standby", "standby"]]);
  });
});
