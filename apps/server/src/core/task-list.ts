import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { StreamMessage, Task, TaskListSummary } from "@agent-hub/shared";
import type { Hub } from "./hub";

const exec = promisify(execFile);
export async function discoverProject(input: string | null): Promise<TaskListSummary["project"]> {
  if (!input || !path.isAbsolute(input) || input.includes("\0") || input.length > 4096) return null;
  try {
    const cwd = await realpath(input);
    const { stdout } = await exec("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { timeout: 5000, maxBuffer: 8192 });
    const root = stdout.trim();
    if (!path.isAbsolute(root)) return null;
    const id = await realpath(root);
    return { id, name: path.basename(id) || id };
  } catch {
    return null;
  }
}

/** Uses only Hub public reads. Each stream owns this small, disposable projection. */
export class TaskListProjection {
  private summaries = new Map<string, TaskListSummary>();
  private inputs = new Map<string, string>();
  private projects = new Map<string, Promise<TaskListSummary["project"]>>();
  constructor(private hub: Pick<Hub, "listTasks" | "events">, private discover = discoverProject) {}

  private async project(task: Task): Promise<TaskListSummary["project"]> {
    // Workspace metadata already records the original root, even after it is deleted.
    if (task.workspace) {
      const input = task.workspace.repoPath;
      if (!input || !path.isAbsolute(input) || input.includes("\0") || input.length > 4096) return null;
      const id = await realpath(input).catch(() => path.normalize(input));
      return { id, name: path.basename(id) || id };
    }
    const input = task.cwd;
    if (!input) return null;
    let pending = this.projects.get(input);
    if (!pending) {
      pending = this.discover(input);
      this.projects.set(input, pending);
    }
    return pending;
  }

  private async summarize(task: Task): Promise<TaskListSummary> {
    const events = this.hub.events(task.id);
    const pendingAsk = events.some((e) => e.type === "ask" && !e.answer && !e.superseded);
    const transcriptOnlyUntouched = task.workflow === "video" && task.options.transcriptOnly === true &&
      events.filter((e) => e.type === "user_message").length <= 1;
    const ws = task.workspace;
    const awaitingAcceptance = (task.workflow === "implement" || task.workflow === "review") &&
      ws?.state === "active" && ws.pr?.state !== "open" && ws.pr?.state !== "merged" && task.status !== "running" && (task.status !== "done" || ws.pr?.state === "closed");
    const summary: TaskListSummary = { taskId: task.id, project: await this.project(task), pendingAsk, awaitingAcceptance,
      ...(transcriptOnlyUntouched ? { transcriptOnlyUntouched } : {}) };
    this.summaries.set(task.id, summary);
    this.inputs.set(task.id, this.fingerprint(task));
    return summary;
  }

  private fingerprint(task: Task): string {
    return JSON.stringify([task.cwd, task.workspace, task.workflow, task.status]);
  }

  async list(): Promise<{ tasks: Task[]; summaries: TaskListSummary[] }> {
    const tasks = this.hub.listTasks();
    const summaries = await Promise.all(tasks.map((task) => this.summarize(task)));
    return { tasks, summaries };
  }

  async update(message: StreamMessage): Promise<TaskListSummary | null> {
    if (message.type === "task_deleted") {
      this.summaries.delete(message.taskId);
      this.inputs.delete(message.taskId);
      return null;
    }
    let task: Task | undefined;
    if (message.type === "task") {
      task = message.task;
      if (this.inputs.get(task.id) === this.fingerprint(task)) return null;
    } else if (message.type === "event" && message.event.type === "ask") {
      task = this.hub.listTasks().find((t) => t.id === message.event.taskId);
    }
    if (!task) return null;
    const previous = this.summaries.get(task.id);
    const summary = await this.summarize(task);
    return JSON.stringify(previous) === JSON.stringify(summary) ? null : summary;
  }
}
