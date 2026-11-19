import type { Task, TaskListSummary } from "@agent-hub/shared";

export const DISPLAY_STATES = ["needsYou", "running", "standby", "prAwaitingMerge", "finished", "apiTranscripts"] as const;
/** Groups the sidebar renders collapsed until opened: rows that are not waiting on anyone. */
export const COLLAPSED_STATES: readonly DisplayState[] = ["apiTranscripts"];
export type DisplayState = typeof DISPLAY_STATES[number];
export interface TaskRow { task: Task; depth: number; state: DisplayState }
export interface ProjectGroup {
  id: string;
  name: string | null;
  pathHint?: string;
  groups: Record<DisplayState, TaskRow[]>;
}

export function taskState(task: Task, summary?: TaskListSummary): DisplayState {
  const state = baseState(task, summary);
  // A transcript fetched for an API caller is not waiting on the user; keep it out of Standby until
  // someone writes in it, then it is an ordinary task again.
  return state === "standby" && summary?.transcriptOnlyUntouched && task.status !== "paused" ? "apiTranscripts" : state;
}

function baseState(task: Task, summary?: TaskListSummary): DisplayState {
  const ws = task.workspace;
  if (task.status === "paused") return "standby";
  if (task.status === "waiting_user" || task.status === "failed" || task.status === "interrupted" || summary?.pendingAsk) return "needsYou";
  if (task.status === "running") return "running";
  if (ws?.pr?.state === "merged" || ws?.state === "merged" || ws?.state === "discarded") return "finished";
  if (ws?.pr?.state === "open") return "prAwaitingMerge";
  if (summary?.awaitingAcceptance || (ws?.state === "active" &&
    (ws.pr?.state === "closed" || ((task.workflow === "implement" || task.workflow === "review") && task.status !== "done")))) return "needsYou";
  if (task.status === "done") return "finished";
  return "standby";
}

/** A tree inherits its root's project; cycles choose the first row in list order as their root. */
export function groupTasks(tasks: Task[], summaries: TaskListSummary[] = []): ProjectGroup[] {
  const facts = new Map(summaries.map((s) => [s.taskId, s]));
  const ids = new Set(tasks.map((task) => task.id));
  const children = new Map<string, Task[]>();
  for (const task of tasks) {
    const parent = task.options.reportsTo;
    if (parent && parent !== task.id && ids.has(parent)) {
      const siblings = children.get(parent) ?? [];
      siblings.push(task);
      children.set(parent, siblings);
    }
  }
  const projects = new Map<string, ProjectGroup>();
  const visited = new Set<string>();
  const visit = (task: Task, rows: TaskRow[], depth: number) => {
    if (visited.has(task.id)) return;
    visited.add(task.id);
    rows.push({ task, depth, state: taskState(task, facts.get(task.id)) });
    for (const child of children.get(task.id) ?? []) visit(child, rows, depth + 1);
  };
  const addTree = (root: Task) => {
    if (visited.has(root.id)) return;
    const rows: TaskRow[] = [];
    visit(root, rows, 0);
    const states = rows.map((r) => r.state);
    let state: DisplayState = states.includes("needsYou") ? "needsYou" : states.includes("running") ? "running" :
      states.includes("prAwaitingMerge") ? "prAwaitingMerge" : states.includes("standby") ? "standby" :
      states.includes("apiTranscripts") ? "apiTranscripts" : "finished";
    if (state === "standby" && root.workflow === "plan" && root.status === "idle" && rows.length > 1 &&
      rows[0]!.state === "standby" && !root.workspace && states.slice(1).every((s) => s === "finished")) state = "finished";
    rows[0]!.state = state;
    const project = facts.get(root.id)?.project;
    const id = project?.id ?? "other";
    let group = projects.get(id);
    if (!group) {
      group = { id, name: project?.name ?? null, groups: { needsYou: [], running: [], standby: [], prAwaitingMerge: [], finished: [], apiTranscripts: [] } };
      projects.set(id, group);
    }
    group.groups[state].push(...rows);
  };
  for (const task of tasks) {
    if (task.options.reportsTo && task.options.reportsTo !== task.id && ids.has(task.options.reportsTo)) continue;
    addTree(task);
  }
  for (const task of tasks) addTree(task);
  const result = [...projects.values()];
  for (const group of result) if (group.name && result.some((p) => p.id !== group.id && p.name === group.name)) group.pathHint = group.id;
  return result.sort((a, b) => a.name === null ? 1 : b.name === null ? -1 : a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

export interface PinnedShortcut extends TaskRow {
  project: Pick<ProjectGroup, "id" | "name" | "pathHint">;
  parentTitle?: string;
}

/** Reuse rendered tree facts so inherited projects and aggregate root states cannot diverge. */
export function pinnedShortcuts(projects: ProjectGroup[]): PinnedShortcut[] {
  const rows = projects.flatMap((project) => DISPLAY_STATES.flatMap((state) => project.groups[state].map((row) => ({ ...row, project }))));
  const tasks = new Map(rows.map((row) => [row.task.id, row.task]));
  return rows.filter((row) => !!row.task.options.pinnedAt).map((row) => ({
    ...row, depth: 0,
    parentTitle: row.task.options.reportsTo !== row.task.id ? tasks.get(row.task.options.reportsTo ?? "")?.title : undefined,
  })).sort((a, b) => a.task.options.pinnedAt!.localeCompare(b.task.options.pinnedAt!) || a.task.id.localeCompare(b.task.id));
}
