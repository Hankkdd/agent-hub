import fs from "node:fs/promises";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import type { FindingBatch, FindingExport, Task, TaskEvent, TaskEventPayload } from "@agent-hub/shared";
import { findingHash, renderFinding, type RecordedFinding, type ExportEvent } from "./findings";
import { checkExport, checkedFile, exportDirectory, findingDirectory as prefix, findingGit, maybeStat, reconcileReplacements, replaceNote, writeComplete, type ExportControl, type ExportDirectory } from "./finding-export-io";

interface Store {
  tasks(): Task[];
  history(): TaskEvent[];
  append(task: string, payload: TaskEventPayload): TaskEvent;
}
const queues = new Map<string, Promise<void>>();
async function serialized(root: string, control: ExportControl, action: () => Promise<void>): Promise<void> {
  const previous = queues.get(root) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => gate);
  queues.set(root, tail);
  try {
    await new Promise<void>((resolve, reject) => {
      const abort = () => { control.signal?.removeEventListener("abort", abort); reject(new Error("Finding export cancelled while queued")); };
      control.signal?.addEventListener("abort", abort, { once: true });
      void previous.then(() => { control.signal?.removeEventListener("abort", abort); resolve(); });
      if (control.signal?.aborted) abort();
    });
    control.signal?.throwIfAborted();
    await action();
  } finally {
    release();
    void tail.then(() => { if (queues.get(root) === tail) queues.delete(root); });
  }
}
async function common(root: string, control: ExportControl): Promise<string> {
  return fs.realpath(await findingGit(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"], control));
}
async function usable(root: string, codeRoots: string[], control: ExportControl): Promise<void> {
  const git = (args: string[]) => findingGit(root, args, control);
  if (await fs.realpath(await git(["rev-parse", "--show-toplevel"])) !== root) throw new Error("documentsDir must be the Git repository root");
  const codeCommon = await Promise.all(codeRoots.map((source) => common(source, control)));
  if (codeCommon.includes(await common(root, control))) throw new Error("Documentation and code repositories must be distinct");
  await git(["symbolic-ref", "--quiet", "HEAD"]);
  await git(["rev-parse", "--verify", "HEAD"]);
  const index = await maybeStat(await git(["rev-parse", "--path-format=absolute", "--git-path", "index"]));
  if (index && (!index.isFile() || index.isSymbolicLink() || index.nlink !== 1)) throw new Error("Unsafe documentation Git index");
  if (await git(["rev-parse", "--shared-index-path"]) || (await git(["ls-files", "-v"])).split("\n").some((r) => /^[a-zS]/.test(r))) throw new Error("Split, sparse or hidden-change indexes are unsupported for finding export");
  for (const name of ["MERGE_HEAD", "REBASE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "sequencer", "BISECT_LOG"]) {
    if (await maybeStat(await git(["rev-parse", "--path-format=absolute", "--git-path", name]))) throw new Error("Documentation repository has an in-progress Git operation");
  }
}
async function clean(root: string, control: ExportControl): Promise<boolean> {
  return !await findingGit(root, ["status", "--porcelain=v1", "--untracked-files=all"], control);
}
function result(store: Store, batch: FindingBatch, state: FindingExport["state"], reason?: string, commit?: string): void {
  const history = store.history();
  for (const f of batch.files) {
    for (const taskId of new Set(history.filter((e) => f.observationIds.includes(e.id)).map((e) => e.taskId))) {
      store.append(taskId, { type: "finding_export", findingId: f.findingId, observationIds: f.observationIds,
        state, documentRepository: batch.root, reason: reason?.slice(0, 1000), document: f.path, hash: state === "exported" ? f.hash : undefined, batchId: batch.id, commit });
    }
  }
}
async function indexHash(file: string): Promise<string | undefined> {
  return await maybeStat(file) ? findingHash((await fs.readFile(file)).toString("base64")) : undefined;
}

/** Captured blobs in a private index exclude the user's staged set, even during recovery. */
async function execute(store: Store, batch: FindingBatch, codeRoots: string[], control: ExportControl, check: () => void): Promise<void> {
  const root = batch.root;
  const git = (args: string[], env: NodeJS.ProcessEnv = {}, input?: string, raw = false) => findingGit(root, args, control, env, input, raw);
  await usable(root, codeRoots, control); check();
  const branch = await git(["symbolic-ref", "HEAD"]);
  if (branch !== batch.branch) throw new Error("Documentation branch changed; pending batch requires its original branch");
  const head = await git(["rev-parse", "HEAD"]);
  const marker = `Agent-Hub-Findings-Batch: ${batch.id}`;
  const committed = (await git(["log", "--format=%H", "--fixed-strings", `--grep=${marker}`, "HEAD"])).split("\n").filter(Boolean);
  if (committed.length > 1) throw new Error("Ambiguous batch commit history");
  const recovered = committed[0];
  if (!recovered && head !== batch.head) throw new Error("Documentation HEAD changed during incomplete batch");
  if (recovered) {
    const paths = (await git(["diff-tree", "--no-commit-id", "--name-only", "-r", recovered])).split("\n").sort();
    if (JSON.stringify(paths) !== JSON.stringify(batch.files.map((f) => f.path).sort())) throw new Error("Batch commit changed unexpected files");
    for (const f of batch.files) if (findingHash(await git(["show", `${recovered}:${f.path}`], {}, undefined, true)) !== f.hash) throw new Error("Batch commit content mismatch");
    if (await clean(root, control)) { result(store, batch, "exported", undefined, recovered); return; }
    if (head !== recovered) throw new Error("Dirty repository after batch commit; preserve user changes");
  }
  const indexPath = await git(["rev-parse", "--path-format=absolute", "--git-path", "index"]);
  const indexLock = `${indexPath}.lock`;
  const lock = await fs.open(indexLock, "wx", 0o600);
  const lockInode = (await lock.stat()).ino;
  const privateIndex = `${indexPath}.agent-hub-${batch.id}-${randomUUID()}`;
  const env = { GIT_INDEX_FILE: privateIndex };
  let dirs: ExportDirectory | undefined;
  try {
    check();
    const originalIndex = await indexHash(indexPath);
    dirs = await exportDirectory(root, true);
    await reconcileReplacements(dirs, batch);
    const status = (await git(["status", "--porcelain=v1", "-z", "--untracked-files=all"])).split("\0").filter(Boolean);
    for (const row of status) {
      const f = batch.files.find((f) => f.path === row.slice(3));
      if (!f || row.slice(0, 2).includes("R") || row.slice(0, 2).includes("C")) throw new Error("Documentation repository has unrelated staged or unstaged changes");
      const content = await checkedFile(root, f.path);
      if (content === undefined || (findingHash(content) !== f.hash && findingHash(content) !== f.beforeHash)) throw new Error("Human changes conflict with incomplete batch");
      const indexed = await git(["ls-files", "--stage", "--", f.path]);
      if (indexed) {
        const blob = indexed.split(/\s+/)[1]!;
        const hash = findingHash(await git(["cat-file", "blob", blob], {}, undefined, true));
        if (hash !== f.hash && hash !== f.beforeHash) throw new Error("Index conflict in incomplete batch");
      }
    }
    if (await maybeStat(indexPath)) await fs.copyFile(indexPath, privateIndex, constants.COPYFILE_EXCL);
    else await git(["read-tree", head], env);
    for (const f of batch.files) {
      await dirs.verify(); check();
      const previous = await checkedFile(root, f.path);
      if (previous !== undefined && findingHash(previous) !== f.hash && findingHash(previous) !== f.beforeHash) throw new Error("Managed file changed since preparation");
      if (previous === undefined && f.beforeHash) throw new Error("Managed file was removed");
      if (!recovered && previous !== f.content) await replaceNote(dirs, f.path.slice(prefix.length), f.content, previous, batch.id, check);
      await dirs.verify();
      const after = await checkedFile(root, f.path);
      if (after === undefined || findingHash(after) !== f.hash) throw new Error("Managed content changed during export");
      const blob = await git(["hash-object", "-w", "--stdin"], {}, f.content);
      await git(["update-index", "--add", "--cacheinfo", `100644,${blob},${f.path}`], env);
    }
    await usable(root, codeRoots, control);
    await dirs.verify(); check();
    if (await git(["rev-parse", "HEAD"]) !== head || await git(["symbolic-ref", "HEAD"]) !== branch) throw new Error("Documentation HEAD raced export");
    if (await indexHash(indexPath) !== originalIndex) throw new Error("Documentation index changed during export");
    const allowed = new Set(batch.files.map((f) => f.path));
    if ((await git(["status", "--porcelain=v1", "-z", "--untracked-files=all"])).split("\0").filter(Boolean).some((r) => !allowed.has(r.slice(3)))) throw new Error("User changes appeared during export");
    for (const f of batch.files) if (findingHash(await checkedFile(root, f.path) ?? "") !== f.hash) throw new Error("Human changes appeared before commit");
    let commit = recovered;
    if (!commit) {
      const tree = await git(["write-tree"], env);
      commit = await git(["commit-tree", tree, "-p", head], {
        GIT_AUTHOR_NAME: "Agent Hub", GIT_AUTHOR_EMAIL: "agent-hub@localhost", GIT_COMMITTER_NAME: "Agent Hub", GIT_COMMITTER_EMAIL: "agent-hub@localhost",
      }, `docs: record out-of-scope observations\n\n${marker}\n`);
      await dirs.verify(); check();
      if (await git(["rev-parse", "HEAD"]) !== head || await git(["symbolic-ref", "HEAD"]) !== branch) throw new Error("Documentation HEAD changed before commit");
      for (const f of batch.files) if (findingHash(await checkedFile(root, f.path) ?? "") !== f.hash) throw new Error("Human changes appeared before ref update");
      await git(["update-ref", branch, commit, head]);
    }
    // A cancelled ref update is reconciled by its durable marker on the next explicit attempt.
    if (await indexHash(indexPath) !== originalIndex) throw new Error("Documentation index changed before installation; preserved");
    await writeComplete(lock, await fs.readFile(privateIndex));
    await fs.rename(indexLock, indexPath);
    if (!await clean(root, control)) throw new Error("Documentation changed during commit; observations await reconciliation");
    result(store, batch, "exported", undefined, commit);
  } finally {
    await dirs?.close(); await lock.close();
    const remaining = await maybeStat(indexLock);
    if (remaining?.isFile() && remaining.ino === lockInode) await fs.unlink(indexLock);
    await fs.rm(privateIndex, { force: true });
  }
}

/** Normal completions and explicit retries await the root queue, then re-project pending work. */
export async function exportFindings(store: Store, task: Task, stopped: () => boolean, control: ExportControl = {}): Promise<void> {
  const settings = task.options.findingExport;
  const ownPending = () => {
    const history = store.history();
    const done = new Set(history.flatMap((e) => e.type === "finding_export" && ["exported", "referenced"].includes(e.state) ? e.observationIds : []));
    return history.filter((e): e is RecordedFinding => e.type === "finding_recorded" && e.taskId === task.id && !done.has(e.id));
  };
  const pendingReason = (reason: string) => { for (const e of ownPending()) store.append(task.id, { type: "finding_export", findingId: e.findingId, observationIds: [e.id], state: "pending", reason: reason.slice(0, 1000) }); };
  if (stopped() || control.signal?.aborted) return;
  if (!settings) {
    for (const e of ownPending()) store.append(task.id, { type: "finding_export", findingId: e.findingId, observationIds: [e.id], state: "unconfigured", reason: "No saved findings export configuration" });
    return;
  }
  let root: string;
  try { root = await fs.realpath(settings.documentsDir); }
  catch { pendingReason("Documentation repository unavailable"); return; }
  try {
    await serialized(root, control, async () => {
      const check = () => checkExport(control, stopped);
      check();
      const snapshotTasks = await Promise.all(store.tasks().map(async (t) => {
        if (!t.options.findingExport) return undefined;
        try { return await fs.realpath(t.options.findingExport.documentsDir) === root ? t : undefined; } catch { return undefined; }
      }));
      const eligibleTasks = snapshotTasks.filter((t): t is Task => !!t);
      if (!eligibleTasks.some((t) => t.id === task.id)) throw new Error("Saved document directory changed before export; pending observations preserved");
      const codeRoots = [...new Set(eligibleTasks.flatMap((t) => { const source = t.workspace?.repoPath ?? t.cwd ?? t.options.findingProject; return source ? [source] : []; }))];
      await usable(root, codeRoots, control); check();
      const observations = store.history().filter((e): e is RecordedFinding => e.type === "finding_recorded");
      const readExports = () => store.history().filter((e): e is ExportEvent => e.type === "finding_export" && e.documentRepository === root && ["exported", "referenced"].includes(e.state));
      let exportHistory = readExports();
      const rootExports = () => exportHistory;
      const authorized = (e: RecordedFinding) => eligibleTasks.some((t) => t.id === e.taskId && t.options.findingProject === e.project);
      const historical = (e: RecordedFinding) => rootExports().some((x) => x.findingId === e.findingId && x.state === "exported" && x.observationIds.includes(e.id));
      const allowedIds = new Set(observations.filter((e) => authorized(e) || historical(e)).map((e) => e.id));
      // A journal cannot confer another project's or document repository's write authority.
      for (const e of store.history()) {
        if (e.type !== "finding_batch" || e.batch.root !== root) continue;
        const done = e.batch.files.every((f) => f.observationIds.every((id) => rootExports().some((x) => x.batchId === e.batch.id && x.state === "exported" && x.observationIds.includes(id))));
        if (done) continue;
        if (!e.batch.files.every((f) => f.observationIds.every((id) => allowedIds.has(id) && observations.some((o) => o.id === id && o.findingId === f.findingId && `${prefix}${o.topic}.md` === f.path)))) throw new Error("Incomplete batch has no matching authorized project snapshot; preserved");
        check();
        try { await execute(store, e.batch, codeRoots, control, check); exportHistory = readExports(); }
        catch (err) { result(store, e.batch, "conflict", err instanceof Error ? err.message : String(err)); return; }
      }
      const exported = rootExports();
      const eligible = observations.filter((e) => authorized(e) || historical(e));
      // Retained history enriches an authorized topic; it never becomes pending work by itself.
      const pending = observations.filter((e) => authorized(e) && !exported.some((x) => x.observationIds.includes(e.id)));
      if (!pending.length) return;
      check();
      if (!await clean(root, control)) throw new Error("Documentation repository must have a clean working tree and index");
      const batch: FindingBatch = { id: randomUUID(), root, head: await findingGit(root, ["rev-parse", "HEAD"], control), branch: await findingGit(root, ["symbolic-ref", "HEAD"], control), files: [] };
      for (const id of new Set(pending.map((e) => e.findingId))) {
        const group = eligible.filter((e) => e.findingId === id);
        const latestPending = pending.filter((e) => e.findingId === id).at(-1)!;
        const ids = group.map((e) => e.id);
        try {
          const reference = group.find((e) => e.existingDocument)?.existingDocument;
          if (reference) {
            for (const taskId of new Set(group.map((e) => e.taskId))) store.append(taskId, { type: "finding_export", findingId: id, observationIds: ids, state: "referenced", documentRepository: root, document: reference });
            continue;
          }
          if (new Set(pending.filter((e) => e.topic === latestPending.topic).map((e) => e.findingId)).size > 1) throw new Error("Topic filename collision between projects sharing the document repository");
          const relative = `${prefix}${latestPending.topic}.md`;
          const previous = await checkedFile(root, relative);
          const known = exported.filter((e) => e.findingId === id && e.document === relative && e.state === "exported").at(-1);
          if (previous !== undefined && (!known?.hash || findingHash(previous) !== known.hash || !/^Status: Draft$/m.test(previous) || !previous.includes(`<!-- agent-hub-finding: ${id} -->`))) throw new Error("Unmanaged, manually edited or non-Draft note; preserved");
          if (previous === undefined && known) throw new Error("Previously managed note was removed; preserved");
          const owner = eligibleTasks.find((t) => t.id === latestPending.taskId)!.options.findingExport!.owner;
          const content = renderFinding(group, owner, previous);
          batch.files.push({ path: relative, findingId: id, observationIds: ids, beforeHash: previous === undefined ? undefined : findingHash(previous), hash: findingHash(content), content });
        } catch (err) {
          for (const taskId of new Set(group.map((e) => e.taskId))) store.append(taskId, { type: "finding_export", findingId: id, observationIds: ids, state: "conflict", documentRepository: root, reason: (err instanceof Error ? err.message : String(err)).slice(0, 1000) });
        }
      }
      if (!batch.files.length) return;
      check(); store.append(task.id, { type: "finding_batch", batch });
      try { await execute(store, batch, codeRoots, control, check); }
      catch (err) { result(store, batch, "conflict", err instanceof Error ? err.message : String(err)); }
    });
  } catch (err) { pendingReason(err instanceof Error ? err.message : String(err)); }
}
