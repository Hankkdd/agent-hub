import type { AgentKind } from "@agent-hub/shared";
import { completeUpdateMerge, git, diffFiles, resetWorktree, runCommand, unifiedDiff } from "../../workspace/git";
import { rulesPrompt, SYSTEM_APPEND, REVIEWER_SYSTEM, worktreeNote, reviewPrompt, parseReview,
  testsFailedPrompt, findingsPrompt } from "../prompts";
import { nextStep, snapshot } from "./snapshot";
import type { Task, Workspace } from "@agent-hub/shared";
import type { Outcome, TurnImages, WorkflowDeps } from "./types";
import { reviewInputDiagnostics, type ReviewInputBasis } from "../invocations";

const AGENT_LABEL: Record<AgentKind, string> = { claude: "Claude", codex: "Codex", gemini: "Gemini" };
export const DEFAULT_MAX_ROUNDS = 3;

/**
 * Author and reviewer take turns until the reviewer approves (and the tests pass, when there are
 * any), or the rounds run out. Every exit stops for the user: nothing is ever merged automatically.
 */
export async function reviewWorkflow(deps: WorkflowDeps, task: Task, prompt: string, ac: AbortController, images: TurnImages): Promise<Outcome> {
  const ws = task.workspace!;
  const author = deps.session(task, "author");
  const reviewer = deps.session(task, "reviewer");
  const A = AGENT_LABEL[author.agent];
  const R = AGENT_LABEL[reviewer.agent];
  const maxRounds = task.options.maxRounds ?? DEFAULT_MAX_ROUNDS;
  let authorPrompt = prompt;
  let previousReviewInput: ReviewInputBasis | undefined;

  for (let round = 1; round <= maxRounds; round++) {
    const roundLabel = `round ${round}/${maxRounds}`;
    // The user's pictures go with their request (round 1); later rounds are the reviewer's findings.
    const a = await deps.streamAgent(task, author, authorPrompt, ac, { round, systemPrompt: SYSTEM_APPEND + worktreeNote(ws) + rulesPrompt(task.options.appliedRules, "author"), activity: `${A} implementing (${roundLabel})`, images: round === 1 ? images : undefined });
    if (ac.signal.aborted || !a.ok) return a;
    await snapshot(deps, task, round);
    if ((await diffFiles(ws)).length === 0) return { ok: true, activity: `${A} made no changes, so there is nothing to review` };

    const requests = deps.requests(task.id), diff = await unifiedDiff(ws);
    const observed = reviewInputDiagnostics(reviewer.id, requests, diff, previousReviewInput);
    previousReviewInput = observed.basis;
    const reviewPromptText = reviewPrompt(requests, diff, round);
    const r = await deps.streamAgent(task, reviewer, reviewPromptText, ac, { round, systemPrompt: REVIEWER_SYSTEM + rulesPrompt(task.options.appliedRules, "reviewer"), readOnly: true, activity: `${R} reviewing (${roundLabel})`, inputDiagnostics: { review: observed.metadata } });
    await resetWorktree(ws.worktreePath); // a reviewer may not leave changes behind, whatever it did
    if (ac.signal.aborted || !r.ok) return r;

    const parsed = parseReview(r.text);
    if (!parsed) return { ok: true, activity: `Could not read ${R}'s verdict; see its reply` };
    deps.append(task.id, reviewer.id, { type: "review_result", round, verdict: parsed.verdict, findings: parsed.findings });

    if (parsed.verdict === "approve") {
      const testCommand = task.options.testCommand;
      if (!testCommand) return { ok: true, explain: true, activity: `Approved by ${R} in ${roundLabel}. Review the diff, then ${nextStep(ws)}` };
      deps.setRunning(task.id, `Running tests (${roundLabel})`);
      const t = await runCommand(ws.worktreePath, testCommand, { signal: ac.signal });
      if (ac.signal.aborted) return { ok: true };
      deps.append(task.id, null, { type: "test_result", round, command: testCommand, exitCode: t.exitCode, output: t.output });
      if (t.exitCode === 0) return { ok: true, explain: true, activity: `Approved by ${R} and tests pass (${roundLabel}). Review the diff, then ${nextStep(ws)}` };
      if (round === maxRounds) return { ok: true, activity: `Tests still failing after ${maxRounds} rounds. Read the output, then reply or discard` };
      authorPrompt = testsFailedPrompt(testCommand, t.exitCode, t.output, round);
      continue;
    }
    if (round === maxRounds) return { ok: true, activity: `Not approved after ${maxRounds} rounds. Read the findings, then reply, merge or discard` };
    authorPrompt = findingsPrompt(R, parsed.findings, round);
  }
  return { ok: true };
}

/** Bounded integration-only author/reviewer rounds. Commits stay local; publication belongs to the caller. */
export async function reviewPrUpdate(deps: WorkflowDeps, task: Task, baseline: Workspace, operationId: string,
  initialPrompt: string, scope: string, ac: AbortController, recordCommit: (sha: string) => void): Promise<string> {
  const cwd = baseline.worktreePath;
  const author = task.sessions.find(s => s.role === "author" || s.role === "main")!;
  const reviewer = task.sessions.find(s => s.role === "reviewer");
  if (!reviewer) throw new Error("A configured reviewer is required to resolve conflicts");
  const checkStop = () => { if (ac.signal.aborted) throw new Error("PR integration interrupted; local progress retained"); };
  const read = async (args: string[]) => (await git(cwd, args, { signal: ac.signal })).stdout.trim();
  let prompt = initialPrompt;
  let previousReviewInput: ReviewInputBasis | undefined;
  const rounds = task.options.maxRounds ?? DEFAULT_MAX_ROUNDS;
  for (let round = 1; round <= rounds; round++) {
    const a = await deps.streamAgent(task, author, prompt, ac, { round, systemPrompt: SYSTEM_APPEND + "\n" + scope + rulesPrompt(task.options.appliedRules, "author"), activity: `Resolving PR conflicts (${round}/${rounds})` });
    checkStop();
    if (!a.ok || a.text.includes("INTEGRATION_BLOCKED")) throw new Error(a.error ?? "Conflict resolution stopped for user decision");
    const unmerged = (await read(["diff", "--name-only", "--diff-filter=U", "-z"])).split("\0").filter(Boolean);
    for (const file of unmerged) {
      if ((await git(cwd, ["diff", "--check", "--", file], { allowFail: true, signal: ac.signal })).code)
        throw new Error("Unresolved conflict markers remain");
    }
    await git(cwd, ["add", "-A"], { signal: ac.signal });
    if (await read(["ls-files", "-u"])) throw new Error("Unresolved index entries remain");
    await completeUpdateMerge(cwd, `Merge ${baseline.prBase} into task PR`);
    const sha = await read(["rev-parse", "HEAD"]);
    recordCommit(sha);
    const requests = [...deps.requests(task.id), scope], diff = await unifiedDiff(baseline);
    const observed = reviewInputDiagnostics(reviewer.id, requests, diff, previousReviewInput);
    previousReviewInput = observed.basis;
    const r = await deps.streamAgent(task, reviewer, reviewPrompt(requests, diff, round), ac, {
      round, systemPrompt: REVIEWER_SYSTEM + rulesPrompt(task.options.appliedRules, "reviewer") + "\nIntegration review only: reject requirement changes or unrelated fixes. Review all original requirements and the supplied integration scope; do not resolve conflicts or edit files.",
      readOnly: true, activity: `Reviewing PR integration (${round}/${rounds})`, inputDiagnostics: { review: observed.metadata },
    });
    checkStop();
    // Preserve evidence of unexpected writes instead of resetting the user's retained integration.
    if (!r.ok || await read(["status", "--porcelain", "--untracked-files=all"]) || await read(["rev-parse", "HEAD"]) !== sha)
      throw new Error("Reviewer failed or changed the validated source");
    const parsed = parseReview(r.text);
    if (!parsed) throw new Error("Reviewer approval is missing");
    deps.append(task.id, reviewer.id, { type: "review_result", operationId, sha, round, ...parsed });
    if (parsed.verdict === "approve") return sha;
    prompt = scope + "\n" + findingsPrompt("Reviewer", parsed.findings, round);
  }
  throw new Error("Integration review rejected; local progress retained");
}
