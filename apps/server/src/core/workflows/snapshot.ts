import type { Task, TaskEvent, Workspace } from "@agent-hub/shared";
import { lastPrUpdate } from "../pr-update";
import { abandonedUntrackedBlock, commitAll } from "../../workspace/git";
import { fillConvention } from "../repo-settings";
import type { WorkflowDeps } from "./types";

/** Commit what the author left and record the cumulative diff. Returns whether anything changed. */
export async function snapshot(deps: WorkflowDeps, task: Task, round: number): Promise<boolean> {
  if (lastPrUpdate(deps.events(task.id))?.owned) throw new Error("An owned PR integration must be completed through update_pr, never ordinary snapshots");
  const ws = task.workspace!;
  const blocked = abandonedUntrackedBlock(ws, lastPrUpdate(deps.events(task.id)));
  if (blocked) throw new Error(blocked);
  const settings = task.options.repoSettings;
  const message = settings && ws.remoteBranch && ws.prDraft
    ? fillConvention(settings.commit ?? "{type}: {summary}", { ...ws.prDraft, summary: "address review feedback" }, task.options.ticket)
    : `agent-hub: ${task.title} (round ${round})`;
  const sha = await commitAll(ws.worktreePath, message);
  if (!sha) return false;
  const files = await deps.diff(task.id);
  deps.append(task.id, null, {
    type: "diff_snapshot",
    round,
    filesChanged: files.length,
    binaryFiles: files.filter((f) => f.binary).length,
    additions: files.reduce((n, f) => n + f.additions, 0),
    deletions: files.reduce((n, f) => n + f.deletions, 0),
  });
  // With a pull request open, each round's commit goes up so the PR shows the current change.
  const fresh = deps.getTask(task.id).workspace!;
  if (fresh.pr?.state === "open" && deps.forge) {
    try {
      await deps.forge.push(fresh);
    } catch (err) {
      deps.append(task.id, null, { type: "turn_result", ok: false, error: `could not push to PR #${fresh.pr.number}: ${err instanceof Error ? err.message : String(err)}` });
    }
  }
  return true;
}

export function nextRound(events: TaskEvent[]): number {
  return events.filter((e) => e.type === "diff_snapshot").length + 1;
}

/** What the user does with a finished change: a PR where there is GitHub, a local merge otherwise. */
export function nextStep(ws: Workspace): string {
  if (ws.pr?.state === "open") return `merge PR #${ws.pr.number} on GitHub`;
  return ws.github ? "open a PR (or merge locally) or discard" : "merge or discard";
}
