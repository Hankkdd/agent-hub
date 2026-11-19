import { runCommand } from "../../workspace/git";
import { rulesPrompt, SYSTEM_APPEND, worktreeNote } from "../prompts";
import { nextRound, nextStep, snapshot } from "./snapshot";
import type { Task } from "@agent-hub/shared";
import type { Outcome, TurnImages, WorkflowDeps } from "./types";

/** One agent works in the worktree; its changes are committed after each turn for the user to review. */
export async function implementWorkflow(deps: WorkflowDeps, task: Task, prompt: string, ac: AbortController, images: TurnImages): Promise<Outcome> {
  const ws = task.workspace!;
  const r = await deps.streamAgent(task, deps.session(task, "main"), prompt, ac, { systemPrompt: SYSTEM_APPEND + worktreeNote(ws) + rulesPrompt(task.options.appliedRules, "author"), images });
  if (ac.signal.aborted || !r.ok) return r;
  const round = nextRound(deps.events(task.id));
  const changed = await snapshot(deps, task, round);
  if (changed && task.options.testCommand) {
    const command = task.options.testCommand;
    deps.setRunning(task.id, `Running tests (round ${round})`);
    const test = await runCommand(ws.worktreePath, command, { signal: ac.signal });
    if (ac.signal.aborted) return { ok: true };
    deps.append(task.id, null, { type: "test_result", round, command, exitCode: test.exitCode, output: test.output });
    if (test.exitCode !== 0) return { ok: true, explain: true, activity: "Tests failed. Read the output, then reply or discard" };
  }
  return { ok: true, explain: changed, activity: changed ? `Review the diff, then ${nextStep(ws)}` : "No changes yet" };
}
