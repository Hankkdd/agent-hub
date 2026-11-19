import { createHash } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { DiffHunk, FileContents, FileDiff, PrUpdate, Workspace } from "@agent-hub/shared";

const exec = promisify(execFile);

/** Run git in `cwd`. No shell: arguments are passed as-is, so paths need no quoting. */
export async function git(cwd: string, args: string[], opts: { allowFail?: boolean; maxBuffer?: number; timeout?: number; signal?: AbortSignal } = {}): Promise<{ stdout: string; code: number }> {
  try {
    const { stdout } = await exec("git", args, { cwd, maxBuffer: opts.maxBuffer ?? 64 * 1024 * 1024, timeout: opts.timeout, signal: opts.signal, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    return { stdout, code: 0 };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string; message: string };
    if (opts.allowFail) return { stdout: e.stdout ?? "", code: typeof e.code === "number" ? e.code : 1 };
    throw new Error(`git ${args.join(" ")} failed: ${(e.stderr || e.message).trim()}`);
  }
}

export async function isGitRepo(dir: string): Promise<boolean> {
  return (await git(dir, ["rev-parse", "--is-inside-work-tree"], { allowFail: true })).stdout.trim() === "true";
}

/** `feature/x` or `origin/feature/x` as the remote-tracking ref createWorktree takes. Throws on a bad name. */
export async function baseBranchRef(repoPath: string, branch: string): Promise<string> {
  const ref = `origin/${branch.trim().replace(/^origin\//, "")}`;
  try {
    await git(repoPath, ["check-ref-format", `refs/remotes/${ref}`]);
  } catch {
    throw new Error(`"${branch}" is not a valid branch name`);
  }
  return ref;
}

/** Asks origin itself, because a proposal may name a branch this checkout has not fetched yet. */
export async function assertBaseBranchExists(repoPath: string, ref: string): Promise<void> {
  const branch = ref.slice("origin/".length);
  try {
    await git(repoPath, ["ls-remote", "--exit-code", "--heads", "origin", `refs/heads/${branch}`]);
  } catch {
    throw new Error(`Branch "${branch}" was not found on origin; push it first`);
  }
}

const planCheckoutPath = (repoPath: string, dataDir: string, taskId: string) =>
  path.join(dataDir, "plan-checkouts", `${path.basename(repoPath)}-${taskId.slice(0, 8)}`);

/**
 * A plan's detached worktree at the freshly fetched `ref`, made or moved there. Agents get read-only
 * instructions, not a read-only mount, so anything left behind is thrown away. A failed fetch keeps the
 * last known ref: a plan can still be discussed offline, and the caller says so in the turn.
 */
export async function syncPlanCheckout(repoPath: string, dataDir: string, taskId: string, ref: string): Promise<{ path: string; sha: string; fetched: boolean }> {
  const worktree = planCheckoutPath(repoPath, dataDir, taskId);
  const fetched = (await git(repoPath, ["fetch", "origin"], { allowFail: true })).code === 0;
  const sha = (await git(repoPath, ["rev-parse", "--verify", `refs/remotes/${ref}^{commit}`])).stdout.trim();
  if (fs.existsSync(path.join(worktree, ".git"))) {
    await git(worktree, ["checkout", "--force", "--detach", sha]);
    await git(worktree, ["clean", "-fd"]);
  } else {
    fs.mkdirSync(path.dirname(worktree), { recursive: true });
    await git(repoPath, ["worktree", "prune"]);
    await git(repoPath, ["worktree", "add", "--detach", worktree, sha]);
  }
  return { path: worktree, sha, fetched };
}

export async function removePlanCheckout(repoPath: string, worktree: string): Promise<void> {
  await git(repoPath, ["worktree", "remove", "--force", worktree], { allowFail: true });
}

/**
 * A worktree from a freshly fetched base ref or the repo's current HEAD. The user's own checkout
 * is not touched: the agent works next to it, in `<dataDir>/worktrees/`.
 */
export async function createWorktree(repoPath: string, dataDir: string, taskId: string, base?: string): Promise<Omit<Workspace, "id">> {
  const top = (await git(repoPath, ["rev-parse", "--show-toplevel"])).stdout.trim();
  if (base) {
    await git(top, ["check-ref-format", `refs/remotes/${base}`]);
    await git(top, ["fetch", "origin"]);
  }
  const baseSha = (await git(top, ["rev-parse", "--verify", `${base ? `refs/remotes/${base}` : "HEAD"}^{commit}`])).stdout.trim();
  const head = (await git(top, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
  const baseRef = base ?? (head === "HEAD" ? baseSha : head); // detached HEAD: the commit is the base
  const short = taskId.slice(0, 8);
  const branch = `agent-hub/${short}`;
  const worktreePath = path.join(dataDir, "worktrees", `${path.basename(top)}-${short}`);
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  await git(top, ["worktree", "add", "-b", branch, worktreePath, baseSha]);
  return { repoPath: top, worktreePath, branch, baseRef, baseSha, ...(base ? { prBase: base.slice("origin/".length) } : {}), state: "active" };
}

/** Replace only the private task history; the user's checkout and index are never reset. */
export async function squashWorktree(ws: Workspace, message: string): Promise<string> {
  if ((await git(ws.worktreePath, ["status", "--porcelain"])).stdout.trim()) throw new Error("the worktree has uncommitted changes; finish a round before opening a PR");
  const head = (await git(ws.worktreePath, ["rev-parse", "HEAD"])).stdout.trim();
  await git(ws.worktreePath, ["merge-base", "--is-ancestor", ws.baseSha, head]);
  const sha = (await git(ws.worktreePath, ["-c", "user.name=Agent Hub", "-c", "user.email=agent-hub@localhost", "commit-tree", `${head}^{tree}`, "-p", ws.baseSha, "-m", message])).stdout.trim();
  await git(ws.worktreePath, ["update-ref", `refs/heads/${ws.branch}`, sha, head]);
  return sha;
}

/** Commit everything the agent left in the worktree. Returns the new sha, or null if nothing changed. */
export async function commitAll(worktree: string, message: string): Promise<string | null> {
  await git(worktree, ["add", "-A"]);
  const staged = await git(worktree, ["diff", "--cached", "--quiet"], { allowFail: true });
  if (staged.code === 0) return null;
  await git(worktree, ["-c", "user.name=Agent Hub", "-c", "user.email=agent-hub@localhost", "commit", "-q", "--no-verify", "-m", message]);
  return (await git(worktree, ["rev-parse", "HEAD"])).stdout.trim();
}

/** Unlike commitAll, an unchanged resolved tree still needs to record the second parent. */
export async function completeUpdateMerge(cwd: string, message: string): Promise<void> {
  const pending = (await git(cwd, ["rev-parse", "-q", "--verify", "MERGE_HEAD"], { allowFail: true })).code === 0;
  if ((await git(cwd, ["ls-files", "-u"])).stdout.trim()) throw new Error("Unresolved index entries remain");
  if (pending) await git(cwd, ["-c", "user.name=Agent Hub", "-c", "user.email=agent-hub@localhost", "commit", "--no-verify", "--no-edit", "-m", message]);
  else await commitAll(cwd, message);
}

/** Throw away uncommitted changes (a reviewer is not allowed to leave any). */
export async function resetWorktree(worktree: string): Promise<void> {
  await git(worktree, ["reset", "-q", "--hard", "HEAD"]);
  await git(worktree, ["clean", "-q", "-fd"]);
}

/**
 * Files changed since the base, INCLUDING uncommitted work, so the Diff tab is live mid-turn.
 * Untracked files are marked intent-to-add so `git diff` can see them; that only touches the
 * worktree's own index.
 */
export async function diffFiles(ws: Workspace, preserveUntracked = false): Promise<FileDiff[]> {
  if (ws.state !== "active" || !fs.existsSync(ws.worktreePath)) return [];
  if (!preserveUntracked) await git(ws.worktreePath, ["add", "--intent-to-add", "--all"], { allowFail: true }); // may race an agent's own git; then untracked files just wait
  const numstat = (await git(ws.worktreePath, ["diff", "--numstat", "-z", ws.baseSha])).stdout;
  const status = (await git(ws.worktreePath, ["diff", "--name-status", "-z", ws.baseSha])).stdout;
  const kinds = new Map<string, FileDiff["status"]>();
  const st = status.split("\0").filter(Boolean);
  for (let i = 0; i + 1 < st.length; i += 2) kinds.set(st[i + 1]!, st[i] === "A" ? "added" : st[i] === "D" ? "deleted" : "modified");
  const out: FileDiff[] = [];
  for (const rec of numstat.split("\0").filter(Boolean)) {
    const [add, del, file] = rec.split("\t");
    if (!file) continue;
    out.push({ path: file, status: kinds.get(file) ?? "modified", additions: add === "-" ? 0 : Number(add), deletions: del === "-" ? 0 : Number(del) });
  }
  return out;
}

export async function fileContents(ws: Workspace, file: string): Promise<FileContents> {
  const rel = path.normalize(file);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("path must stay inside the worktree");
  const original = (await git(ws.worktreePath, ["show", `${ws.baseSha}:${rel}`], { allowFail: true })).stdout;
  const abs = path.join(ws.worktreePath, rel);
  const modified = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : "";
  const binary = original.includes("\0") || modified.includes("\0");
  return binary ? { path: rel, original: "", modified: "", binary } : { path: rel, original, modified, binary };
}

/** The committed change as one unified diff, for the reviewer. Truncated so it fits a prompt. */
export async function unifiedDiff(ws: Workspace, maxChars = 80_000): Promise<string> {
  const d = (await git(ws.worktreePath, ["diff", `${ws.baseSha}..HEAD`])).stdout;
  return d.length > maxChars ? `${d.slice(0, maxChars)}\n… (diff truncated: ${d.length - maxChars} more characters; read the files for the rest)` : d;
}

/** Committed hunks only. Read paths separately so quoted/non-ASCII git headers need no decoding. */
export async function diffHunks(ws: Workspace, sha = "HEAD", limits = { hunks: 200, chars: 120_000 }): Promise<{ hunks: DiffHunk[]; skipped: number }> {
  const range = `${ws.baseSha}..${sha}`;
  const paths = (await git(ws.worktreePath, ["diff", "--no-renames", "--name-only", "-z", range])).stdout.split("\0").filter(Boolean);
  const hunks: DiffHunk[] = [];
  let chars = 0;
  let skipped = 0;
  let capped = false;
  for (const file of paths) {
    const patch = (await git(ws.worktreePath, ["diff", "--no-renames", "--no-ext-diff", "--no-textconv", "--no-color", "--unified=3", "--diff-algorithm=myers", range, "--", file])).stdout;
    const headers = [...patch.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@.*$/gm)];
    for (let i = 0; i < headers.length; i++) {
      const h = headers[i]!;
      const body = patch.slice(h.index!, headers[i + 1]?.index ?? patch.length);
      if (capped || hunks.length >= limits.hunks || chars + body.length > limits.chars) {
        capped = true; // Keep a prefix, rather than skipping a large hunk and explaining later ones.
        skipped++;
        continue;
      }
      const oldStart = Number(h[1]);
      const newStart = Number(h[3]);
      hunks.push({ id: `${file}:${oldStart}:${newStart}`, path: file, oldStart, oldLines: Number(h[2] ?? 1), newStart, newLines: Number(h[4] ?? 1), patch: body });
      chars += body.length;
    }
  }
  return { hunks, skipped };
}

/**
 * Merge the task branch into its base in the user's repo. Refuses rather than guessing when the repo
 * is not on the base branch or has uncommitted changes: a merge there would mix the agent's work into
 * whatever the user is doing.
 */
export async function mergeWorktree(ws: Workspace, title: string): Promise<void> {
  const current = (await git(ws.repoPath, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
  if (current !== ws.baseRef) throw new Error(`${ws.repoPath} is on "${current}", not "${ws.baseRef}". Check out ${ws.baseRef} there, then merge again.`);
  const dirty = (await git(ws.repoPath, ["status", "--porcelain", "--untracked-files=no"])).stdout.trim();
  if (dirty) throw new Error(`${ws.repoPath} has uncommitted changes. Commit or stash them, then merge again.`);
  const merged = await git(ws.repoPath, ["merge", "--no-ff", "-m", `Merge ${ws.branch}: ${title}`, ws.branch], { allowFail: true });
  if (merged.code !== 0) {
    await git(ws.repoPath, ["merge", "--abort"], { allowFail: true });
    throw new Error(`The merge into ${ws.baseRef} had conflicts and was aborted; nothing changed. ${merged.stdout.trim().split("\n").slice(-3).join(" ")}`);
  }
  await removeWorktree(ws, false);
}

/** Remove the worktree and its branch. `force` deletes the branch even if it was never merged. */
export async function removeWorktree(ws: Workspace, force: boolean): Promise<void> {
  await git(ws.repoPath, ["worktree", "remove", "--force", ws.worktreePath], { allowFail: true });
  await git(ws.repoPath, ["branch", force ? "-D" : "-d", ws.branch], { allowFail: true });
}

/** Run the task's test command in the worktree. Never throws: a failing command is a result. */
export async function runCommand(
  cwd: string,
  command: string,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<{ exitCode: number | null; output: string }> {
  try {
    // CI=true: nobody can answer a prompt here. Without it pnpm aborted ("no TTY") when it wanted to
    // replace a node_modules an agent had installed, and the test run failed on that, not on the code.
    const env = { ...process.env, CI: "true" };
    const { stdout, stderr } = await exec("bash", ["-lc", command], { cwd, env, timeout: opts.timeoutMs ?? 10 * 60_000, signal: opts.signal, maxBuffer: 16 * 1024 * 1024 });
    return { exitCode: 0, output: tail(`${stdout}${stderr}`) };
  } catch (err) {
    const e = err as { code?: number | string; stdout?: string; stderr?: string; killed?: boolean; message: string };
    const out = `${e.stdout ?? ""}${e.stderr ?? ""}` || e.message;
    return { exitCode: typeof e.code === "number" ? e.code : null, output: tail(e.killed ? `${out}\n(timed out)` : out) };
  }
}

function tail(s: string, max = 8_000): string {
  return s.length > max ? `… (${s.length - max} earlier characters)\n${s.slice(-max)}` : s;
}

const capturedGit = (cwd: string, args: string[], signal?: AbortSignal) => git(cwd, ["--no-optional-locks", ...args], { maxBuffer: 600_000, timeout: 10_000, signal });

/** Read only ordinary blobs from immutable revisions, never resolve filesystem symlinks. */
export async function revisionText(cwd: string, revision: string, file: string, optional = false, signal?: AbortSignal, maxBytes = 200_000): Promise<string | null> {
  if (!file || file.length > 512 || /[\\\x00-\x1f:<>`~]/.test(file) || path.posix.isAbsolute(file) || file.split("/").some((s) => !s || s === "." || s === ".." || s === ".git")) throw new Error(`Invalid captured source path: ${file}`);
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error("Invalid captured revision");
  const entry = (await capturedGit(cwd, ["ls-tree", "-z", revision, "--", `:(literal)${file}`], signal)).stdout;
  if (!entry) {
    if (optional) return null;
    throw new Error(`Captured source is unavailable: ${file}`);
  }
  const match = /^100(?:644|755) blob ([a-f0-9]{40})\t/.exec(entry);
  if (!match) throw new Error(`Captured source is not an ordinary file: ${file}`);
  const size = Number((await capturedGit(cwd, ["cat-file", "-s", match[1]!], signal)).stdout.trim());
  if (size > maxBytes) throw new Error(`Captured file exceeds ${maxBytes} bytes: ${file}`);
  const text = (await capturedGit(cwd, ["cat-file", "blob", match[1]!], signal)).stdout;
  if (text.includes("\0") || text.includes("\ufffd")) throw new Error(`Cannot explain binary or invalid UTF-8 source: ${file}`);
  return text;
}

export async function captureBriefingChange(ws: Workspace, signal?: AbortSignal) {
  const cwd = ws.worktreePath;
  if ((await capturedGit(cwd, ["status", "--porcelain", "--untracked-files=all"], signal)).stdout.trim()) throw new Error("Briefing requires a clean committed worktree");
  const headSha = (await capturedGit(cwd, ["rev-parse", "HEAD"], signal)).stdout.trim();
  const baseSha = ws.baseSha;
  const baseTree = (await capturedGit(cwd, ["rev-parse", `${baseSha}^{tree}`], signal)).stdout.trim();
  const headTree = (await capturedGit(cwd, ["rev-parse", `${headSha}^{tree}`], signal)).stdout.trim();
  const records = (await capturedGit(cwd, ["diff", "--no-renames", "--name-status", "-z", baseSha, headSha], signal)).stdout.split("\0").filter(Boolean);
  if (!records.length) throw new Error("No cumulative changes to explain");
  if (records.length > 160) throw new Error("Briefing coverage exceeds 80 changed files");
  const files: { path: string; deleted: boolean; generated: boolean; sourceExcerpt: boolean; text: string; patch: string }[] = [];
  let bytes = 0;
  for (let i = 0; i < records.length; i += 2) {
    const file = records[i + 1]!;
    const deleted = records[i] === "D";
    const generated = /(?:^|\/)(?:pnpm-lock\.yaml|package-lock\.json|yarn\.lock|Cargo\.lock|go\.sum)$|\.generated\./i.test(file);
    const fullSource = (await revisionText(cwd, deleted ? baseSha : headSha, file, false, signal, generated ? 512_000 : 200_000))!;
    // Generated data gets complete changed coverage via the patch, without redundant unchanged data.
    const text = generated ? fullSource.split("\n").slice(0, 80).join("\n").slice(0, 16000) : fullSource;
    const patch = (await capturedGit(cwd, ["diff", "--no-renames", "--no-ext-diff", "--no-textconv", "--no-color", "--unified=3", baseSha, headSha, "--", file], signal)).stdout;
    bytes += Buffer.byteLength(text) + Buffer.byteLength(patch);
    if (bytes > 800_000) throw new Error(`Briefing coverage exceeds 800000 bytes at ${file}; no partial briefing accepted`);
    files.push({ path: file, deleted, generated, sourceExcerpt: text !== fullSource, text, patch });
  }
  if ((await capturedGit(cwd, ["status", "--porcelain", "--untracked-files=all"], signal)).stdout.trim()
    || (await capturedGit(cwd, ["rev-parse", "HEAD^{tree}"], signal)).stdout.trim() !== headTree) throw new Error("Briefing source changed during capture");
  return { baseSha, headSha, baseTree, headTree, files };
}

/** Only ordinary files or symlinks with real directory parents can be owned cleanup candidates. */
function mergeFileHash(cwd: string, file: string): string | null {
  if (!file || path.isAbsolute(file) || file.split("/").some(part => !part || part === "." || part === ".." || part === ".git"))
    throw new Error("Unsafe merge cleanup path");
  let parent = cwd;
  const parts = file.split("/");
  for (const part of parts.slice(0, -1)) {
    parent = path.join(parent, part);
    if (!fs.existsSync(parent)) return null;
    const stat = fs.lstatSync(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Merge cleanup parent changed");
  }
  const absolute = path.join(cwd, file);
  let stat;
  try { stat = fs.lstatSync(absolute); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  if (stat.isSymbolicLink()) return createHash("sha256").update("symlink\0" + fs.readlinkSync(absolute)).digest("hex");
  if (!stat.isFile() || stat.size > 16 * 1024 * 1024) throw new Error("Cannot safely identify merge cleanup file");
  return createHash("sha256").update("file\0").update(fs.readFileSync(absolute)).digest("hex");
}

/** Called immediately after Git's merge, before an author can create files. Ignored user files stay outside this manifest. */
export async function captureMergeUntracked(cwd: string): Promise<{ path: string; hash: string }[]> {
  const paths = (await git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"])).stdout.split("\0").filter(Boolean);
  if (paths.length > 512) throw new Error("Too many untracked merge artifacts to identify safely");
  return paths.map(file => {
    const hash = mergeFileHash(cwd, file);
    if (!hash) throw new Error("Merge artifact changed during capture");
    return { path: file, hash };
  });
}

/** Validate every destructive path before touching Git. Refuse unrelated history and preserve all unknown user files. */
export async function abandonOwnedMerge(ws: Workspace, update: PrUpdate, signal: AbortSignal): Promise<void> {
  const cwd = ws.worktreePath;
  const pre = update.preSha!;
  const checkStop = () => { if (signal.aborted) throw new Error("Abandonment interrupted; inspect retained local progress"); };
  const read = async (args: string[]) => (await git(cwd, args, { signal })).stdout.trim();
  if (!/^[a-f0-9]{40}$/.test(pre) || pre !== update.revision.headSha || update.publication) throw new Error("Update is not safely unpublished");
  if (await read(["branch", "--show-current"]) !== ws.branch) throw new Error("Task branch changed");
  for (const name of ["rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD", "REVERT_HEAD", "MERGE_AUTOSTASH"]) {
    if (fs.existsSync(path.resolve(cwd, await read(["rev-parse", "--git-path", name])))) throw new Error("Unrelated Git operation is pending");
  }
  const head = await read(["rev-parse", "HEAD"]);
  const pending = (await git(cwd, ["rev-parse", "-q", "--verify", "MERGE_HEAD"], { allowFail: true, signal })).stdout.trim();
  if (head === pre) {
    if (pending && (pending !== update.revision.targetSha || await read(["rev-parse", "ORIG_HEAD"]) !== pre))
      throw new Error("Pending merge does not belong to this update");
  } else {
    const parents = (await read(["rev-list", "--parents", "-n", "1", head])).split(" ").slice(1);
    if (pending || (update.resultSha && head !== update.resultSha) || parents.length !== 2 || parents[0] !== pre || parents[1] !== update.revision.targetSha)
      throw new Error("Local HEAD is not the exact owned merge; unrelated work is retained");
  }
  const manifest = update.mergeUntracked ?? [];
  for (const file of manifest) {
    if ((await git(cwd, ["ls-tree", "-z", pre, "--", `:(literal)${file.path}`], { signal })).stdout)
      throw new Error("Merge cleanup would remove an original tracked path");
    const hash = mergeFileHash(cwd, file.path);
    if (hash && hash !== file.hash) throw new Error("A merge artifact was changed; refusing to delete user work");
  }
  const untracked = (await git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"], { signal })).stdout;
  if (!update.mergeUntracked && untracked) throw new Error("Untracked merge provenance is unavailable; refusing cleanup");
  const affected = (await git(cwd, ["diff", "--no-renames", "--name-only", "-z", pre], { signal })).stdout.split("\0").filter(Boolean);
  // reset --hard can delete untracked/ignored files that obstruct a restored tracked path.
  // Bound argument lists and check ignored files too, without scanning dependency directories elsewhere.
  for (let i = 0; i < affected.length; i += 100) {
    const obstructing = (await git(cwd, ["ls-files", "--others", "-z", "--", ...affected.slice(i, i + 100).map(file => `:(literal)${file}`)], { signal })).stdout.split("\0").filter(Boolean);
    if (obstructing.some(file => !manifest.some(owned => owned.path === file))) throw new Error("User files obstruct restoration; nothing was reset");
  }
  checkStop();
  if (await read(["rev-parse", "HEAD"]) !== head) throw new Error("Local HEAD changed before abandonment");
  if (pending) await git(cwd, ["merge", "--abort"]);
  checkStop();
  await git(cwd, ["reset", "--hard", pre]);
  for (const file of manifest) {
    const hash = mergeFileHash(cwd, file.path);
    if (!hash) continue;
    if (hash !== file.hash) throw new Error("Merge artifact changed during abandonment; file retained");
    fs.unlinkSync(path.join(cwd, file.path));
  }
}

/** Persist a bounded display prefix without losing the fact that more leftovers exist. */
export async function retainedUntracked(cwd: string): Promise<NonNullable<PrUpdate["retainedUntracked"]>> {
  const files = (await git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"])).stdout.split("\0").filter(Boolean);
  const paths: string[] = [];
  let chars = 0;
  for (const file of files) {
    if (paths.length === 80 || chars + file.length > 12_000) break;
    paths.push(file); chars += file.length;
  }
  return { paths, total: files.length };
}

/** Synchronous command gates must reject before queueing input or resetting sessions. No Git writes. */
export function abandonedUntrackedBlock(ws: Workspace | null | undefined, update: PrUpdate | undefined): string | null {
  const retained = update?.stage === "abandoned" ? update.retainedUntracked : undefined;
  if (!ws || !retained?.total) return null;
  let current: string[];
  try {
    current = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
      cwd: ws.worktreePath, encoding: "utf8", timeout: 5_000, maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    }).split("\0").filter(Boolean);
  } catch { return "Review or remove the listed leftover files first; their untracked state could not be verified"; }
  // A truncated prefix cannot prove an omitted original path is gone: conservatively check all remaining untracked files.
  const remaining = retained.total > retained.paths.length ? current : current.filter(file => retained.paths.includes(file));
  if (!remaining.length) return null;
  return `Review or remove leftover files retained after abandoning the PR update before ordinary turns: ${JSON.stringify(remaining.slice(0, 20))}` +
    (remaining.length > 20 ? ` (${remaining.length} files total)` : "");
}
