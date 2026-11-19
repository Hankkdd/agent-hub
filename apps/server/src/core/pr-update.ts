import fs from "node:fs";
import path from "node:path";
import type { PrRevision, PrUpdate, Task, TaskEvent, Workspace } from "@agent-hub/shared";
import { git, completeUpdateMerge, runCommand, captureMergeUntracked, abandonOwnedMerge, retainedUntracked } from "../workspace/git";
import { reviewPrUpdate } from "./workflows/review";
import type { WorkflowDeps } from "./workflows/types";

export const lastPrUpdate = (events: TaskEvent[]) => events.filter((e) => e.type === "pr_update").at(-1)?.update;
export const sameRevision = (a: PrRevision, b: PrRevision) => a.head === b.head && a.headSha === b.headSha && a.target === b.target && a.targetSha === b.targetSha && a.crossRepository === b.crossRepository;
export const updateFinished = (u: PrUpdate) => ["succeeded", "noop", "failed", "interrupted", "abandoned"].includes(u.stage);

export const updateReportOutcome = (u: PrUpdate) => u.stage === "abandoned" ? "update_abandoned" as const
  : u.stage === "interrupted" ? "update_interrupted" as const : u.stage === "failed" ? "update_failed" as const : "updated" as const;

interface UpdateDeps extends WorkflowDeps {
  updateWorkspace(id: string, fields: Partial<Workspace>): void;
}

/** One explicitly approved operation. All checkpoints are durable; retry always obtains new approval. */
export async function updatePr(deps: UpdateDeps, task: Task, initial: PrUpdate, ac: AbortController): Promise<PrUpdate> {
  const ws = task.workspace!;
  const cwd = ws.worktreePath;
  const forge = deps.forge!;
  const previous = lastPrUpdate(deps.events(task.id).filter(e => e.type !== "pr_update" || e.update.id !== initial.id));
  let op = { ...initial };
  const save = (fields: Partial<PrUpdate>) => {
    op = { ...op, ...fields };
    deps.append(task.id, null, { type: "pr_update", update: op });
  };
  const checkStop = () => { if (ac.signal.aborted) throw new Error("Update interrupted; retained local progress requires an explicit retry"); };
  const read = async (args: string[]) => (await git(cwd, args, { signal: ac.signal })).stdout.trim();
  const head = () => read(["rev-parse", "HEAD"]);
  const dirty = () => read(["status", "--porcelain", "--untracked-files=all"]);
  const mergeHead = async () => (await git(cwd, ["rev-parse", "-q", "--verify", "MERGE_HEAD"], { allowFail: true, signal: ac.signal })).stdout.trim();
  const remote = async () => {
    const value = await forge.inspectPullRequest!(ws.github!, ws.pr!.number, ac.signal);
    checkStop();
    if (value.state !== "open" || value.crossRepository || !sameRevision(value, op.revision)) throw new Error("PR source or target changed; poll and approve a new update");
    return value;
  };
  try {
    checkStop();
    if (op.revision.head !== (ws.remoteBranch ?? ws.branch)) throw new Error("PR source branch differs from the task's published branch");
    if (await forge.repoOf(cwd) !== ws.github) throw new Error("Origin repository changed");
    if (await read(["branch", "--show-current"]) !== ws.branch) throw new Error("Task branch changed");
    for (const name of ["rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD", "REVERT_HEAD"]) {
      if (fs.existsSync(path.resolve(cwd, await read(["rev-parse", "--git-path", name])))) throw new Error("Unrelated Git operation is pending");
    }
    const pendingMerge = await mergeHead();
    const retained = previous?.owned;
    if (retained && (previous.pr.repo !== op.pr.repo || previous.pr.number !== op.pr.number)) throw new Error("Retained update belongs to another PR");
    if (pendingMerge && (!retained || pendingMerge !== previous.revision.targetSha)) throw new Error("Unrelated merge is pending");
    const reconcilesPush = retained && previous.publication && previous.resultSha === op.revision.headSha && sameRevision({ ...previous.revision, headSha: previous.resultSha }, op.revision);
    if (retained && !sameRevision(previous.revision, op.revision) && !reconcilesPush) throw new Error("Retained update belongs to different revisions; user intervention is required");
    if (pendingMerge && retained && await head() !== previous.preSha) throw new Error("Retained merge source changed");
    if (!pendingMerge && await dirty()) throw new Error("Worktree must be clean; local progress is retained");
    if (retained && previous.resultSha && await head() !== previous.resultSha) throw new Error("Retained result changed; refusing to absorb unrelated commits");
    await remote();
    await git(cwd, ["fetch", "origin"], { signal: ac.signal });
    checkStop();
    const revision = op.revision;
    for (const branch of [revision.head, revision.target]) await git(cwd, ["check-ref-format", `refs/heads/${branch}`]);
    const fetchedTarget = await read(["rev-parse", "--verify", `refs/remotes/origin/${revision.target}^{commit}`]);
    const published = (await git(cwd, ["ls-remote", "--heads", "origin", `refs/heads/${revision.head}`], { signal: ac.signal })).stdout.split(/\s/)[0];
    if (fetchedTarget !== revision.targetSha || published !== revision.headSha) throw new Error("Fetched source or target differs from the approved observation");
    const before = await head();
    if (retained && !pendingMerge && !previous.resultSha && before !== previous.preSha) {
      // A crash can fall between the merge commit and its event. Only its exact two parents prove ownership.
      const parents = (await read(["rev-list", "--parents", "-n", "1", before])).split(" ").slice(1);
      if (parents.length !== 2 || parents[0] !== previous.preSha || parents[1] !== revision.targetSha)
        throw new Error("Unrecorded local commits do not match the owned merge");
      save({ resultSha: before });
    }
    await git(cwd, ["merge-base", "--is-ancestor", revision.headSha, before]);
    if (!retained && before !== revision.headSha) throw new Error("Local branch differs from the published branch; refusing unpublished edits");
    save({ stage: "fetched", preSha: retained ? previous.preSha : before, owned: retained, conflicted: retained ? previous.conflicted : false });
    // A push may have succeeded before a crash. Reconcile before attempting any further write.
    if (retained && previous.resultSha === published && previous.publication) {
      if (previous.validatedSha !== published) throw new Error("Published revision lacks matching validation evidence");
      deps.updateWorkspace(task.id, { baseSha: revision.targetSha, prBase: revision.target });
      save({ stage: "succeeded", resultSha: published, owned: false, publication: "published", tests: previous.tests, reviewedSha: previous.reviewedSha, validatedSha: previous.validatedSha });
      return op;
    }
    save({ tests: undefined, reviewedSha: undefined, validatedSha: undefined, validationOperationId: undefined, publication: undefined });
    const contained = (await git(cwd, ["merge-base", "--is-ancestor", revision.targetSha, before], { allowFail: true })).code === 0;
    if (!retained && contained) {
      deps.updateWorkspace(task.id, { baseSha: revision.targetSha, prBase: revision.target });
      save({ stage: "noop", resultSha: before, owned: false }); return op;
    }
    if (retained && !pendingMerge && !contained && before !== previous.preSha) throw new Error("Retained integration ancestry is incomplete");
    if (!retained || (!pendingMerge && !contained)) {
      // Persist ownership BEFORE merge: a crash can leave MERGE_HEAD even without a later event.
      save({ stage: "merging", owned: true });
      const merged = await git(cwd, ["-c", "user.name=Agent Hub", "-c", "user.email=agent-hub@localhost", "merge", "--no-ff", "--no-commit", revision.targetSha], { allowFail: true, signal: ac.signal });
      checkStop();
      save({ mergeUntracked: await captureMergeUntracked(cwd) });
      const conflicts = await read(["diff", "--name-only", "--diff-filter=U"]);
      if (merged.code !== 0 && !conflicts) throw new Error("Git merge failed; inspect retained state");
      save({ stage: conflicts ? "resolving" : "merging", conflicted: !!conflicts });
    }
    if (pendingMerge && (await read(["ls-files", "-u"]))) save({ conflicted: true });
    deps.updateWorkspace(task.id, { baseSha: revision.targetSha, prBase: revision.target });
    const baseline = { ...ws, baseSha: revision.targetSha, prBase: revision.target };
    if (op.conflicted) {
      const scope = "Resolve only these conflicts and directly necessary integration edits within ALL original requirements. Do not change requirements or fix unrelated problems. If that is impossible, reply INTEGRATION_BLOCKED and stop. Do not commit, push, abort, reset, merge, rebase or stage files; Hub owns Git writes.";
      const prompt = `${scope}\n\nOriginal and cumulative requests:\n${deps.requests(task.id).join("\n\n")}\n\nBound revisions: ${JSON.stringify(op)}\n\nConflicted index:\n${(await read(["ls-files", "-u"])).slice(0, 16000)}\n\nConflict diff:\n${(await read(["diff", "--cc"])).slice(0, 48000)}`;
      const reviewedSha = await reviewPrUpdate(deps, task, baseline, op.id, prompt, scope, ac,
        (sha) => save({ stage: "merged", resultSha: sha }));
      save({ reviewedSha });
    } else {
      await completeUpdateMerge(cwd, `Merge ${revision.target} into task PR`);
      save({ stage: "merged", resultSha: await head() });
    }
    checkStop();
    if (await read(["ls-files", "-u"]) || await mergeHead() || await dirty()) throw new Error("Merge is incomplete or worktree changed");
    const result = await head();
    const files = await deps.diff(task.id);
    deps.append(task.id, null, { type: "diff_snapshot", round: 0, filesChanged: files.length, additions: files.reduce((n, f) => n + f.additions, 0), deletions: files.reduce((n, f) => n + f.deletions, 0), binaryFiles: files.filter(f => f.binary).length });
    const command = task.options.testCommand;
    if (command) {
      deps.setRunning(task.id, "Testing PR update");
      const test = await runCommand(cwd, command, { signal: ac.signal });
      checkStop();
      deps.append(task.id, null, { type: "test_result", operationId: op.id, sha: result, round: 0, command, ...test });
      save({ tests: test.exitCode === 0 ? "passed" : "failed", validationOperationId: op.id });
      if (test.exitCode !== 0) throw new Error("PR update tests failed; no repairs or publication authorized");
    } else save({ tests: "none", validationOperationId: op.id });
    if (await head() !== result || await dirty() || await mergeHead() || await read(["ls-files", "-u"])) throw new Error("Result changed during validation");
    if (op.conflicted && op.reviewedSha !== result) throw new Error("Review does not cover this commit");
    save({ stage: "validated", validatedSha: result, resultSha: result });
    await remote();
    if (await head() !== result || await dirty() || await read(["branch", "--show-current"]) !== ws.branch) throw new Error("Validated commit changed before publication");
    checkStop();
    if (op.validationOperationId !== op.id) throw new Error("Validation belongs to another update operation");
    save({ stage: "publishing", publication: "uncertain" });
    await forge.push({ ...ws, remoteBranch: revision.head }, { signal: ac.signal, sha: result });
    checkStop();
    save({ stage: "succeeded", publication: "published", owned: false });
  } catch (error) {
    save({ stoppedAt: op.stage, stage: ac.signal.aborted ? "interrupted" : "failed", error: error instanceof Error ? error.message : String(error) });
  }
  return op;
}

/** Read remote identities before a strictly local, explicitly approved rollback. Never writes to the forge. */
export async function abandonPrUpdate(deps: UpdateDeps, task: Task, initial: PrUpdate, ac: AbortController): Promise<PrUpdate> {
  const ws = task.workspace!;
  if (await deps.forge!.repoOf(ws.worktreePath) !== initial.pr.repo) throw new Error("Origin repository changed");
  const remote = await deps.forge!.inspectPullRequest!(initial.pr.repo, initial.pr.number, ac.signal);
  const published = (await git(ws.worktreePath, ["ls-remote", "--heads", "origin", `refs/heads/${initial.revision.head}`], { signal: ac.signal })).stdout.split(/\s/)[0];
  if (remote.crossRepository || remote.head !== initial.revision.head || remote.headSha !== initial.preSha || published !== initial.preSha)
    throw new Error("Remote PR head changed; reconcile through an explicit update retry before abandoning");
  if (ac.signal.aborted) throw new Error("Abandonment interrupted before local changes");
  await abandonOwnedMerge(ws, initial, ac.signal);
  deps.updateWorkspace(task.id, { baseSha: initial.previousBase!.baseSha, prBase: initial.previousBase!.prBase });
  const result: PrUpdate = { ...initial, stage: "abandoned", owned: false, resultSha: initial.preSha,
    retainedUntracked: await retainedUntracked(ws.worktreePath),
    tests: undefined, reviewedSha: undefined, validatedSha: undefined, validationOperationId: undefined };
  deps.append(task.id, null, { type: "pr_update", update: result });
  return result;
}
