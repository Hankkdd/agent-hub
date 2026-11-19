import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import type { FindingBatch } from "@agent-hub/shared";
import { findingHash } from "./findings";

export interface ExportControl { signal?: AbortSignal; gitTimeoutMs?: number }
export function checkExport(control: ExportControl, stopped: () => boolean): void {
  control.signal?.throwIfAborted();
  if (stopped()) throw new Error("Finding export cancelled");
}

/** Process completion waits for child exit before releasing a repository's serialization guard. */
export async function findingGit(root: string, args: string[], control: ExportControl, env: NodeJS.ProcessEnv = {}, input?: string, raw = false): Promise<string> {
  control.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", root, ...args], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", ...env },
      detached: process.platform !== "win32", stdio: "pipe", shell: false,
    });
    let failure: Error | undefined;
    const abort = () => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch { child.kill("SIGKILL"); }
    };
    const timer = setTimeout(() => { failure = new Error("Finding export Git operation timed out"); abort(); }, control.gitTimeoutMs ?? 30_000);
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let size = 0;
    const collect = (target: Buffer[], data: Buffer) => {
      size += data.length;
      if (size > 4 * 1024 * 1024) { failure = new Error("Finding export Git output limit exceeded"); abort(); }
      else target.push(data);
    };
    child.stdout.on("data", (data: Buffer) => collect(stdout, data));
    child.stderr.on("data", (data: Buffer) => collect(stderr, data));
    child.on("error", (error) => { failure = error; });
    child.on("close", (code) => {
      clearTimeout(timer); control.signal?.removeEventListener("abort", abort);
      if (control.signal?.aborted) reject(new Error("Finding export cancelled"));
      else if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`Finding export Git ${args[0]} failed: ${Buffer.concat(stderr).toString("utf8").trim()}`));
      else { const output = Buffer.concat(stdout).toString("utf8"); resolve(raw ? output : output.trimEnd()); }
    });
    control.signal?.addEventListener("abort", abort, { once: true });
    if (control.signal?.aborted) abort();
    child.stdin.on("error", () => { /* Child completion reports early exits; never leave EPIPE unhandled. */ });
    child.stdin.end(input);
  });
}

export const findingDirectory = "personal-view/agent-findings/";
export async function maybeStat(file: string) {
  try { return await fs.lstat(file); } catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw err; }
}
export async function exportDirectory(root: string, create: boolean) {
  const descriptors: { handle: FileHandle; full: string; ino: number; dev: number }[] = [];
  const close = async () => { await Promise.all(descriptors.map((d) => d.handle.close())); };
  try {
    let full = root;
    for (const part of ["", "personal-view", "agent-findings"]) {
      if (part) full = path.join(full, part);
      const parent = descriptors.at(-1);
      const target = parent && part ? `/proc/self/fd/${parent.handle.fd}/${part}` : full;
      if (create && part) { try { await fs.mkdir(target); } catch (err) { if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err; } }
      const handle = await fs.open(target, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      const stat = await handle.stat();
      descriptors.push({ handle, full, ino: stat.ino, dev: stat.dev });
    }
    return { fd: descriptors.at(-1)!.handle.fd, close, sync: async () => { for (const d of [...descriptors].reverse()) await d.handle.sync(); }, verify: async () => {
      for (const d of descriptors) {
        const stat = await fs.lstat(d.full);
        if (!stat.isDirectory() || stat.isSymbolicLink() || stat.ino !== d.ino || stat.dev !== d.dev) throw new Error("Documentation parent changed during export");
      }
    } };
  } catch (err) { await close(); throw err; }
}
export type ExportDirectory = Awaited<ReturnType<typeof exportDirectory>>;

export async function readNote(file: string, linked: boolean | "replacement" = false): Promise<{ content: string; ino: number; dev: number } | undefined> {
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (!stat.isFile() || (linked === "replacement" ? stat.nlink < 1 || stat.nlink > 2 : stat.nlink !== (linked ? 2 : 1)) || (stat.mode & 0o111)) throw new Error("Symlink, hardlink, executable or special file in governed destination");
    if (stat.size > 512_000) throw new Error("Existing note exceeds size limit");
    const buffer = Buffer.alloc(512_001);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > 512_000) throw new Error("Existing note exceeds size limit");
    return { content: buffer.subarray(0, length).toString("utf8"), ino: stat.ino, dev: stat.dev };
  } catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw err; }
  finally { await handle?.close(); }
}
export async function checkedFile(root: string, relative: string): Promise<string | undefined> {
  if (!relative.startsWith(findingDirectory) || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*\.md$/.test(relative.slice(findingDirectory.length))) throw new Error("Invalid governed destination");
  let dirs: ExportDirectory | undefined;
  try {
    dirs = await exportDirectory(root, false);
    await dirs.verify();
    const note = await readNote(`/proc/self/fd/${dirs.fd}/${path.basename(relative)}`);
    await dirs.verify();
    return note?.content;
  } catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw err; }
  finally { await dirs?.close(); }
}

/** A short or failed write never touches the canonical destination. */
export async function writeComplete(handle: FileHandle, content: string | Uint8Array): Promise<void> {
  const bytes = Buffer.from(content);
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, offset);
    if (bytesWritten <= 0 || bytesWritten > bytes.length - offset) throw new Error("Incomplete finding-note write");
    offset += bytesWritten;
  }
  await handle.sync();
}

/** Complete staging plus exclusive installation never replaces a concurrently saved human path. */
export async function replaceNote(dirs: ExportDirectory, name: string, content: string, previous: string | undefined, batchId: string, check: () => void): Promise<void> {
  const parent = `/proc/self/fd/${dirs.fd}`;
  const target = `${parent}/${name}`;
  const stage = `${parent}/.agent-hub-${batchId}-${name}.tmp`;
  const backup = `${parent}/.agent-hub-${batchId}-${name}.previous`;
  let stageHandle: FileHandle | undefined;
  let stageIdentity: { ino: number; dev: number } | undefined;
  let retained = false;
  let installed = false;
  try {
    await dirs.verify(); check();
    if (await maybeStat(stage) || await maybeStat(backup)) throw new Error("Incomplete replacement artifacts require reconciliation");
    stageHandle = await fs.open(stage, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
    stageIdentity = await stageHandle.stat();
    await writeComplete(stageHandle, content);
    const staged = await readNote(stage);
    if (staged?.content !== content) throw new Error("Incomplete finding-note write");
    await dirs.verify(); check();
    const current = await readNote(target);
    if (current?.content !== previous) throw new Error("Human changes conflict with note replacement");
    if (current) {
      // Move, rather than overwrite, whichever inode is actually at the canonical path.
      await fs.rename(target, backup); retained = true;
      const saved = await readNote(backup);
      if (saved?.ino !== current.ino || saved?.dev !== current.dev || saved?.content !== previous) throw new Error("Human changes raced note replacement");
    }
    await dirs.verify(); check();
    // Exclusive link also protects editors that atomically replace the canonical inode.
    await fs.link(stage, target); installed = true;
    await fs.unlink(stage);
    if (retained && (await readNote(backup))?.content !== previous) throw new Error(`Concurrent human edits retained at ${path.basename(backup)}`);
    await dirs.verify();
  } finally {
    await stageHandle?.close();
    if (stageHandle) {
      const stagedStat = await maybeStat(stage);
      if (stagedStat && stageIdentity && stagedStat.ino === stageIdentity.ino && stagedStat.dev === stageIdentity.dev) await fs.unlink(stage);
    }
    if (retained) {
      // Before installation, restore the retained version only into an absent canonical path.
      if (!installed) {
        try { await fs.link(backup, target); }
        catch (err) { if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err; }
      }
      const saved = await readNote(backup, "replacement");
      const canonical = await readNote(target, "replacement");
      if (saved && (saved.content === previous || saved.ino === canonical?.ino && saved.dev === canonical?.dev)) await fs.unlink(backup);
    }
    await dirs.sync();
  }
}

/** Only complete, journal-matching artifacts can be removed after an interrupted replacement. */
export async function reconcileReplacements(dirs: ExportDirectory, batch: FindingBatch): Promise<void> {
  for (const file of batch.files) {
    const name = path.basename(file.path);
    const parent = `/proc/self/fd/${dirs.fd}`;
    const stage = `${parent}/.agent-hub-${batch.id}-${name}.tmp`;
    const backup = `${parent}/.agent-hub-${batch.id}-${name}.previous`;
    if (!await maybeStat(stage) && !await maybeStat(backup)) continue;
    await dirs.verify();
    const staged = await readNote(stage, "replacement");
    const saved = await readNote(backup, "replacement");
    const current = await readNote(`${parent}/${name}`, "replacement");
    if (staged && findingHash(staged.content) !== file.hash || saved && findingHash(saved.content) !== file.beforeHash) {
      const unknown = staged && findingHash(staged.content) !== file.hash ? stage : backup;
      throw new Error(`Unknown changes in replacement artifact ${path.basename(unknown)}; preserved`);
    }
    if (current ? ![file.hash, file.beforeHash].includes(findingHash(current.content)) : !!file.beforeHash && !saved) throw new Error("Human changes conflict with replacement recovery");
    if (!current && saved) await fs.link(backup, `${parent}/${name}`);
    if (staged) await fs.unlink(stage);
    if (saved) await fs.unlink(backup);
    await dirs.verify();
    await dirs.sync();
  }
}
