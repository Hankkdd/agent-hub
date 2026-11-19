import fs from "node:fs";
import asyncFs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { findingNotesZhTW as prose } from "../src/core/finding-notes.zh-TW";
import * as exportIo from "../src/core/finding-export-io";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Task, TaskEvent, TaskEventPayload } from "@agent-hub/shared";
import { exportFindings } from "../src/core/finding-export";
import { findingCatalogue, findingHash, findingIdentity, validateFinding } from "../src/core/findings";

let root: string, docs: string, code: string, task: Task, history: TaskEvent[], seq: number;
const git = (dir: string, ...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const note = "personal-view/agent-findings/cache-lifetime.md";
const content = () => fs.readFileSync(path.join(docs, note), "utf8");
function append(taskId: string, payload: TaskEventPayload): TaskEvent {
  const e = { id: randomUUID(), taskId, sessionId: payload.type === "finding_recorded" ? "session" : null, createdAt: "2026-10-14T12:00:00.000Z", seq: ++seq, ...payload } as TaskEvent;
  history.push(e); return e;
}
const store = { tasks: () => [task], history: () => history, append };
function record(evidence = "Concrete observation", extra = {}) {
  return append(task.id, { type: "finding_recorded", topic: "cache-lifetime", title: "Cache lifetime", evidence, findingId: findingIdentity(code, "cache-lifetime"), submission: randomUUID(), project: code, agent: "codex", revision: git(code, "rev-parse", "HEAD"), ticket: "TEST-12", ...extra });
}
async function flush() { await exportFindings(store, task, () => false); }
function last() { return history.filter((e) => e.type === "finding_export").at(-1); }
function stageHandles(prepare: (handle: FileHandle) => void) {
  const open = asyncFs.open.bind(asyncFs);
  return vi.spyOn(asyncFs, "open").mockImplementation(async (file, flags, mode) => {
    if (String(file).endsWith("cache-lifetime.md") && typeof flags === "number") expect(flags & (fs.constants.O_TRUNC | fs.constants.O_RDWR | fs.constants.O_WRONLY)).toBe(0);
    const handle = await open(file, flags, mode);
    if (String(file).endsWith(".tmp")) prepare(handle);
    return handle;
  });
}
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "hub-finding-export-"));
  docs = path.join(root, "docs"); code = path.join(root, "code");
  for (const dir of [docs, code]) {
    fs.mkdirSync(dir); git(dir, "init", "-q", "-b", "main"); git(dir, "config", "user.name", "Fixture"); git(dir, "config", "user.email", "fixture@example.invalid");
    fs.writeFileSync(path.join(dir, "README.md"), "Fixture\n"); git(dir, "add", "--", "README.md"); git(dir, "commit", "-qm", "fixture");
  }
  history = []; seq = 0;
  task = { id: "task", workflow: "implement", options: { findingProject: code, findingExport: { documentsDir: docs, owner: "Document owner" } } } as Task;
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });

it("exports a governed draft with captured blobs only; preserves code and updates the same note", async () => {
  const codeHead = git(code, "rev-parse", "HEAD");
  const e = record(); await flush();
  expect(last()).toMatchObject({ state: "exported", document: note, observationIds: [e.id], hash: findingHash(content()) });
  expect(content().split("\n").slice(0, 5)).toEqual(["# Cache lifetime", "", "Type: Tech Debt", "Status: Draft", `Source-of-truth: [${prose.canonicalNote}](./cache-lifetime.md)`]);
  expect(content()).toContain("Created: 2026-10-14\nOwner: Document owner\nTicket: TEST-12");
  expect(content()).toContain(e.id); expect(content()).toContain(prose.draftNotice);
  expect(content()).toContain(prose.provenanceNotice);
  expect(content()).toContain(`[${prose.governance}](../../README.md)`);
  expect(content().split("\n")[4]).not.toContain("README.md");
  expect(git(docs, "status", "--porcelain")).toBe("");
  expect(git(docs, "show", "--format=%an <%ae>", "--no-patch")).toBe("Agent Hub <agent-hub@localhost>");
  expect(git(docs, "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD")).toBe(note);
  const commits = git(docs, "rev-list", "--count", "HEAD"); await flush(); expect(git(docs, "rev-list", "--count", "HEAD")).toBe(commits);
  history = JSON.parse(JSON.stringify(history)); record("New evidence"); await flush();
  expect(last()).toMatchObject({ state: "exported", document: note });
  expect(content()).toContain("Concrete observation"); expect(content()).toContain("New evidence"); expect(content()).toContain("Created: 2026-10-14\nUpdated: 2026-10-14");
  expect(fs.readdirSync(path.dirname(path.join(docs, note)))).toEqual(["cache-lifetime.md"]);
  expect(git(code, "rev-parse", "HEAD")).toBe(codeHead); expect(git(code, "status", "--porcelain")).toBe("");
});

it.each(["unstaged", "staged", "merge", "rebase", "cherry", "detached"])("preserves %s repository state and observations", async (state) => {
  record(); const head = git(docs, "rev-parse", "HEAD");
  if (state === "unstaged" || state === "staged") { fs.writeFileSync(path.join(docs, "human.txt"), "Human work\n"); if (state === "staged") git(docs, "add", "--", "human.txt"); }
  if (state === "merge") fs.writeFileSync(path.join(docs, ".git", "MERGE_HEAD"), head);
  if (state === "rebase") fs.mkdirSync(path.join(docs, ".git", "rebase-merge"));
  if (state === "cherry") fs.writeFileSync(path.join(docs, ".git", "CHERRY_PICK_HEAD"), head);
  if (state === "detached") git(docs, "checkout", "--detach", "-q");
  const before = git(docs, "status", "--porcelain"); const index = fs.readFileSync(path.join(docs, ".git", "index"));
  await flush(); expect(last()).toMatchObject({ state: "pending" });
  expect(git(docs, "rev-parse", "HEAD")).toBe(head); expect(git(docs, "status", "--porcelain")).toBe(before);
  expect(fs.readFileSync(path.join(docs, ".git", "index"))).toEqual(index);
  expect(fs.existsSync(path.join(docs, note))).toBe(false);
});

it.each(["manual", "status", "collision", "removed"])("preserves %s documents", async (kind) => {
  if (kind !== "collision") { record(); await flush(); }
  fs.mkdirSync(path.dirname(path.join(docs, note)), { recursive: true });
  if (kind === "removed") fs.unlinkSync(path.join(docs, note));
  else fs.writeFileSync(path.join(docs, note), kind === "status" ? content().replace("Status: Draft", "Status: Deprecated") : "Human-owned content\n");
  git(docs, "add", "--", note); git(docs, "commit", "-qm", "human change");
  const head = git(docs, "rev-parse", "HEAD"); record("Additional observation"); await flush();
  expect(last()).toMatchObject({ state: "conflict" }); expect(git(docs, "rev-parse", "HEAD")).toBe(head);
  expect(fs.existsSync(path.join(docs, note)) ? content() : "removed").toEqual(kind === "removed" ? "removed" : kind === "status" ? expect.stringContaining("Status: Deprecated") : "Human-owned content\n");
});

it.each(["parent-symlink", "file-symlink", "fifo", "hardlink"])("rejects real %s objects without touching targets", async (kind) => {
  const outside = path.join(root, "outside"); fs.mkdirSync(outside); const target = path.join(outside, "target.md"); fs.writeFileSync(target, "Do not touch\n");
  if (kind === "parent-symlink") { fs.symlinkSync(outside, path.join(docs, "personal-view")); git(docs, "add", "--", "personal-view"); }
  else {
    fs.mkdirSync(path.dirname(path.join(docs, note)), { recursive: true });
    if (kind === "file-symlink") fs.symlinkSync(target, path.join(docs, note));
    if (kind === "fifo") execFileSync("mkfifo", [path.join(docs, note)]);
    if (kind === "hardlink") fs.linkSync(target, path.join(docs, note));
    if (kind !== "fifo") git(docs, "add", "--", note);
  }
  if (kind !== "fifo") git(docs, "commit", "-qm", "unsafe fixture");
  record(); await flush(); expect(last()?.state).toMatch(/conflict|pending/); expect(fs.readFileSync(target, "utf8")).toBe("Do not touch\n");
});

it("rejects the coding repository and its sibling worktree as document repositories", async () => {
  task.options.findingExport!.documentsDir = code; record(); await flush(); expect(last()?.reason).toMatch(/distinct/);
  const sibling = path.join(root, "sibling"); git(code, "worktree", "add", "-qb", "docs", sibling);
  task.options.findingExport!.documentsDir = sibling; await flush(); expect(last()?.reason).toMatch(/distinct/);
  expect(git(code, "rev-list", "--count", "HEAD")).toBe("1");
});

it("records references without competing files and works when export is unconfigured or missing", async () => {
  record("Evidence", { existingDocument: "personal-view/human-notes.md" }); await flush(); expect(last()).toMatchObject({ state: "referenced", document: "personal-view/human-notes.md" });
  expect(git(docs, "rev-list", "--count", "HEAD")).toBe("1");
  task.options.findingExport = undefined; record("Unconfigured evidence"); await flush(); expect(last()?.state).toBe("unconfigured");
  task.options.findingExport = { documentsDir: path.join(root, "missing"), owner: "Owner" }; await flush(); expect(last()?.state).toBe("pending");
});

it("reconciles commit-before-event interruption without duplicate commits", async () => {
  record(); let fail = true;
  const interrupted = { ...store, append: (id: string, payload: TaskEventPayload) => {
    if (payload.type === "finding_export" && payload.state === "exported" && fail) { fail = false; throw new Error("Simulated event failure"); }
    return append(id, payload);
  } };
  await exportFindings(interrupted, task, () => false); const head = git(docs, "rev-parse", "HEAD");
  expect(last()?.state).toBe("conflict"); history = JSON.parse(JSON.stringify(history)); await flush();
  expect(last()).toMatchObject({ state: "exported", commit: head }); expect(git(docs, "rev-parse", "HEAD")).toBe(head);
});

it("recovers a written journal after ref/index interruption; leaves unknown edits untouched", async () => {
  record();
  const rename = asyncFs.rename.bind(asyncFs);
  const spy = vi.spyOn(asyncFs, "rename").mockImplementation(async (source, destination) => {
    if (String(source).endsWith("index.lock")) throw new Error("Interrupted index installation");
    return rename(source, destination);
  });
  await flush(); spy.mockRestore(); expect(last()?.state).toBe("conflict");
  const head = git(docs, "rev-parse", "HEAD"); await flush(); expect(last()).toMatchObject({ state: "exported", commit: head });
  expect(git(docs, "status", "--porcelain")).toBe("");
});

it("a Git lock failure is retryable and never changes the user's lock/index", async () => {
  record(); fs.writeFileSync(path.join(docs, ".git", "index.lock"), "Human lock"); await flush();
  expect(last()?.state).toBe("conflict"); expect(fs.readFileSync(path.join(docs, ".git", "index.lock"), "utf8")).toBe("Human lock");
  fs.unlinkSync(path.join(docs, ".git", "index.lock")); await flush(); expect(last()?.state).toBe("exported");
});

it("stopped calls do not start a batch; multiple task observations share one commit", async () => {
  record(); await exportFindings(store, task, () => true); expect(history.filter((e) => e.type === "finding_batch")).toHaveLength(0);
  const other = { ...task, id: "second" }; append(other.id, { type: "finding_recorded", topic: "separate-topic", title: "Other observation", evidence: "Concrete evidence", project: code, agent: "claude", findingId: findingIdentity(code, "separate-topic"), submission: "other" });
  const concurrent = { ...store, tasks: () => [task, other] };
  await Promise.all([Promise.resolve().then(() => exportFindings(concurrent, task, () => false)), Promise.resolve().then(() => exportFindings(concurrent, other, () => false))]);
  expect(git(docs, "rev-list", "--count", "HEAD")).toBe("2"); expect(git(docs, "status", "--porcelain")).toBe("");
  expect(findingCatalogue(history, code)).toHaveLength(2); expect(findingCatalogue(history, "another-project")).toEqual([]);
});

it.each(["../outside", "a/b", "Cache-key", "a_b", "a--b", "-x", "x.md", "a".repeat(81)])("rejects topic attack %s", (topic) => {
  expect(() => validateFinding({ topic, title: "Title", evidence: "Evidence" })).toThrow();
});
it("validates bounded text, code paths and existing-document references", async () => {
  for (const extra of [{ title: "bad\nheader" }, { evidence: "x".repeat(6001) }, { locations: ["../secret"] }, { locations: ["/absolute"] }, { locations: ["C:/secret"] }, { existingDocument: "../README.md" }, { existingDocument: ".git/config.md" }, { existingDocument: "jira-ticket/note.md" }, { locations: Array(21).fill("file.ts") }]) expect(() => validateFinding({ topic: "valid-topic", title: "Title", evidence: "Evidence", ...extra })).toThrow();
});

it("retries a ref-lock commit failure without duplicate history", async () => {
  record(); const lock = path.join(docs, ".git", "refs", "heads", "main.lock"); fs.writeFileSync(lock, "Other Git writer");
  const before = git(docs, "rev-parse", "HEAD"); await flush(); expect(last()?.state).toBe("conflict"); expect(git(docs, "rev-parse", "HEAD")).toBe(before);
  expect(fs.readFileSync(lock, "utf8")).toBe("Other Git writer"); fs.unlinkSync(lock); await flush();
  expect(last()?.state).toBe("exported"); expect(git(docs, "rev-list", "--count", "HEAD")).toBe("2");
});

it("keeps old canonical bytes on stage sync failure and preserves unrelated changes appearing mid-batch", async () => {
  record(); await flush(); const old = content(); record("Later observation");
  const sync = stageHandles((handle) => { vi.spyOn(handle, "sync").mockRejectedValueOnce(new Error("Disk sync failure")); });
  await flush(); sync.mockRestore(); expect(last()?.state).toBe("conflict"); expect(content()).toBe(old);
  expect(git(docs, "status", "--porcelain")).toBe(""); await flush(); expect(last()?.state).toBe("exported");
  record("Another observation"); const head = git(docs, "rev-parse", "HEAD");
  const concurrent = stageHandles((handle) => {
    const sync = handle.sync.bind(handle);
    vi.spyOn(handle, "sync").mockImplementationOnce(async () => { await sync(); await asyncFs.writeFile(path.join(docs, "human.txt"), "Concurrent human edit\n"); });
  });
  await flush(); concurrent.mockRestore(); expect(last()?.state).toBe("conflict"); expect(git(docs, "rev-parse", "HEAD")).toBe(head);
  expect(fs.readFileSync(path.join(docs, "human.txt"), "utf8")).toBe("Concurrent human edit\n");
  git(docs, "add", "--", "human.txt"); const staged = git(docs, "diff", "--cached"); await flush(); expect(last()?.state).toBe("conflict"); expect(git(docs, "diff", "--cached")).toBe(staged);
});

it("rejects a real parent swap before replacement and preserves the outside target", async () => {
  record(); await flush(); record("Later observation");
  const outside = path.join(root, "outside"); fs.mkdirSync(path.join(outside, "agent-findings"), { recursive: true });
  fs.writeFileSync(path.join(outside, "agent-findings", "cache-lifetime.md"), "Outside human file\n");
  const spy = stageHandles((handle) => {
    const sync = handle.sync.bind(handle);
    vi.spyOn(handle, "sync").mockImplementationOnce(async () => {
      await sync(); await asyncFs.rename(path.join(docs, "personal-view"), path.join(root, "displaced")); await asyncFs.symlink(outside, path.join(docs, "personal-view"));
    });
  });
  await flush(); spy.mockRestore(); expect(last()?.state).toBe("conflict");
  expect(fs.readFileSync(path.join(outside, "agent-findings", "cache-lifetime.md"), "utf8")).toBe("Outside human file\n");
  expect(fs.readFileSync(path.join(root, "displaced", "agent-findings", "cache-lifetime.md"), "utf8")).not.toContain("Later observation");
});

it("refuses indexes hiding changes and preserves their bytes", async () => {
  record(); git(docs, "update-index", "--assume-unchanged", "--", "README.md"); fs.writeFileSync(path.join(docs, "README.md"), "Hidden user edit\n");
  const index = fs.readFileSync(path.join(docs, ".git", "index")); await flush(); expect(last()?.reason).toMatch(/unsupported/);
  expect(fs.readFileSync(path.join(docs, ".git", "index"))).toEqual(index); expect(fs.readFileSync(path.join(docs, "README.md"), "utf8")).toBe("Hidden user edit\n");
});

it("reports simultaneous filename collisions across projects without writing either topic", async () => {
  record();
  const otherCode = path.join(root, "other-code"); fs.mkdirSync(otherCode); git(otherCode, "init", "-qb", "main"); git(otherCode, "config", "user.name", "Fixture"); git(otherCode, "config", "user.email", "fixture@example.invalid"); fs.writeFileSync(path.join(otherCode, "README.md"), "Other project\n"); git(otherCode, "add", "--", "README.md"); git(otherCode, "commit", "-qm", "fixture");
  const other = { ...task, id: "other-project", options: { ...task.options, findingProject: otherCode } };
  append(other.id, { type: "finding_recorded", topic: "cache-lifetime", title: "Different project", evidence: "Other evidence", findingId: findingIdentity(otherCode, "cache-lifetime"), submission: "other", project: otherCode, agent: "claude" });
  await exportFindings({ ...store, tasks: () => [task, other] }, task, () => false);
  expect(last()?.reason).toMatch(/collision/); expect(fs.existsSync(path.join(docs, note))).toBe(false); expect(git(docs, "rev-list", "--count", "HEAD")).toBe("1");
});

it.each(["write-error", "partial-then-error", "zero-progress"])("preserves the old note across actual %s without truncation or temporary leftovers", async (failure) => {
  record(); await flush(); const old = content(); const head = git(docs, "rev-parse", "HEAD"); record("New durable evidence");
  const injected = stageHandles((handle) => {
    vi.spyOn(handle, "truncate").mockRejectedValue(new Error("Truncation is forbidden"));
    const write = handle.write.bind(handle);
    let calls = 0;
    vi.spyOn(handle, "write").mockImplementation((async (buffer: Buffer, offset: number, length: number, position: number) => {
      if (failure === "zero-progress") return { bytesWritten: 0, buffer };
      if (failure === "partial-then-error" && calls++ === 0) return write(buffer, offset, Math.min(17, length), position);
      throw new Error("Injected write failure");
    }) as FileHandle["write"]);
  });
  await flush(); injected.mockRestore();
  expect(last()?.state).toBe("conflict"); expect(content()).toBe(old); expect(git(docs, "rev-parse", "HEAD")).toBe(head);
  expect(git(docs, "status", "--porcelain")).toBe(""); expect(fs.readdirSync(path.dirname(path.join(docs, note)))).toEqual(["cache-lifetime.md"]);
  await flush(); expect(last()?.state).toBe("exported"); expect(content()).toContain("New durable evidence");
  expect(git(docs, "rev-list", "--count", "HEAD")).toBe("3"); const updated = git(docs, "rev-parse", "HEAD"); await flush(); expect(git(docs, "rev-parse", "HEAD")).toBe(updated);
  expect(fs.readdirSync(path.dirname(path.join(docs, note)))).toEqual(["cache-lifetime.md"]);
});

it("completes actual short writes before replacing the managed note", async () => {
  record(); await flush(); record("Short writes still preserve complete content");
  const injected = stageHandles((handle) => {
    const write = handle.write.bind(handle);
    vi.spyOn(handle, "write").mockImplementation(((buffer: Buffer, offset: number, length: number, position: number) => write(buffer, offset, Math.min(19, length), position)) as FileHandle["write"]);
  });
  await flush(); injected.mockRestore(); expect(last()?.state).toBe("exported"); expect(content()).toContain("Short writes still preserve complete content"); expect(git(docs, "status", "--porcelain")).toBe("");
});

it("preserves concurrent human edits and atomic editor saves at the replacement boundary", async () => {
  record(); await flush(); const old = content(); record("New evidence");
  const stage = stageHandles((handle) => {
    const sync = handle.sync.bind(handle);
    vi.spyOn(handle, "sync").mockImplementationOnce(async () => { await sync(); await asyncFs.writeFile(path.join(docs, note), "Human edit before replacement\n"); });
  });
  await flush(); stage.mockRestore(); expect(last()?.state).toBe("conflict"); expect(content()).toBe("Human edit before replacement\n");
  fs.writeFileSync(path.join(docs, note), old);
  const rename = asyncFs.rename.bind(asyncFs);
  const swap = vi.spyOn(asyncFs, "rename").mockImplementation(async (source, destination) => {
    if (String(destination).endsWith(".previous")) {
      const replacement = path.join(docs, "human-save.md"); await asyncFs.writeFile(replacement, "Human atomic save at replacement boundary\n"); await rename(replacement, source);
    }
    await rename(source, destination);
  });
  await flush(); swap.mockRestore(); expect(last()?.state).toBe("conflict"); expect(content()).toBe("Human atomic save at replacement boundary\n");
  expect(fs.readdirSync(path.dirname(path.join(docs, note)))).toEqual(["cache-lifetime.md"]);
});

it("keeps distinct project/document repositories isolated during normal export and retry", async () => {
  record(); await flush();
  const taskA = task;
  const codeB = path.join(root, "code-b"), docsB = path.join(root, "docs-b");
  for (const dir of [codeB, docsB]) { fs.mkdirSync(dir); git(dir, "init", "-qb", "main"); git(dir, "config", "user.name", "Fixture"); git(dir, "config", "user.email", "fixture@example.invalid"); fs.writeFileSync(path.join(dir, "README.md"), "Fixture\n"); git(dir, "add", "--", "README.md"); git(dir, "commit", "-qm", "fixture"); }
  const taskB = { ...task, id: "task-b", options: { findingProject: codeB, findingExport: { documentsDir: docsB, owner: "Owner B" } } };
  append(taskB.id, { type: "finding_recorded", topic: "second-topic", title: "B observation", evidence: "B evidence", findingId: findingIdentity(codeB, "second-topic"), submission: "b", project: codeB, agent: "claude" });
  const aEvents = JSON.stringify(history.filter((e) => e.taskId === taskA.id));
  const aNote = content(), aHead = git(docs, "rev-parse", "HEAD"), aIndex = fs.readFileSync(path.join(docs, ".git", "index"));
  const both = { ...store, tasks: () => [taskA, taskB] };
  await exportFindings(both, taskB, () => false); await exportFindings(both, taskB, () => false);
  expect(JSON.stringify(history.filter((e) => e.taskId === taskA.id))).toBe(aEvents);
  expect(content()).toBe(aNote); expect(git(docs, "rev-parse", "HEAD")).toBe(aHead); expect(fs.readFileSync(path.join(docs, ".git", "index"))).toEqual(aIndex);
  expect(git(docsB, "status", "--porcelain")).toBe(""); expect(fs.readdirSync(path.join(docsB, "personal-view", "agent-findings"))).toEqual(["second-topic.md"]);
  expect(history.filter((e) => e.taskId === taskB.id && e.type === "finding_export").every((e) => e.type === "finding_export" && e.state === "exported")).toBe(true);
});

it("retains same-root repeated-topic evidence after the historical task is removed", async () => {
  record(); await flush(); const previous = task;
  task = { ...task, id: "replacement-task" }; record("Evidence from a later authorized task"); await flush();
  expect(last()?.state).toBe("exported"); expect(content()).toContain("Concrete observation"); expect(content()).toContain("Evidence from a later authorized task");
  expect(content()).toContain(`task ${previous.id}`); expect(content()).toContain("Created: 2026-10-14"); expect(fs.readdirSync(path.dirname(path.join(docs, note)))).toEqual(["cache-lifetime.md"]);
});

it("awaits the same-root queue and rechecks work submitted while the first batch was busy", async () => {
  record(); let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const original = exportIo.findingGit; let delayed = false;
  vi.spyOn(exportIo, "findingGit").mockImplementation(async (...args) => {
    if (!delayed && args[0] === docs && args[1].includes("--show-toplevel")) { delayed = true; entered(); await gate; }
    return original(...args);
  });
  const active = [task]; const queued = { ...store, tasks: () => active };
  const first = exportFindings(queued, task, () => false); await ready;
  const second = { ...task, id: "queued-task" }; active.push(second);
  const e = append(second.id, { type: "finding_recorded", topic: "late-topic", title: "Late observation", evidence: "Queued evidence", findingId: findingIdentity(code, "late-topic"), submission: "late", project: code, agent: "claude" });
  let finished = false;
  const next = exportFindings(queued, second, () => false).then(() => { finished = true; });
  await new Promise((resolve) => setTimeout(resolve, 15)); expect(finished).toBe(false);
  release(); await Promise.all([first, next]);
  expect(history.some((x) => x.type === "finding_export" && x.observationIds.includes(e.id) && x.state === "exported")).toBe(true);
  expect(git(docs, "status", "--porcelain")).toBe(""); expect(git(docs, "rev-list", "--count", "HEAD")).toBe("3");
});

it("cancels a queued same-root flush without starting another batch", async () => {
  record(); let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; }), ready = new Promise<void>((resolve) => { entered = resolve; });
  const original = exportIo.findingGit; let delayed = false;
  vi.spyOn(exportIo, "findingGit").mockImplementation(async (...args) => {
    if (!delayed && args[0] === docs) { delayed = true; entered(); await gate; }
    return original(...args);
  });
  const active = [task], shared = { ...store, tasks: () => active };
  const first = exportFindings(shared, task, () => false); await ready;
  const second = { ...task, id: "cancelled-queued-task" }; active.push(second);
  append(second.id, { type: "finding_recorded", topic: "queued-topic", title: "Queued observation", evidence: "Durable evidence", findingId: findingIdentity(code, "queued-topic"), submission: "queued", project: code, agent: "claude" });
  const ac = new AbortController(); const next = exportFindings(shared, second, () => ac.signal.aborted, { signal: ac.signal }); ac.abort();
  await next; expect(history.filter((e) => e.type === "finding_batch")).toHaveLength(0);
  release(); await first;
  expect(history.filter((e) => e.type === "finding_batch")).toHaveLength(1);
  expect(fs.readdirSync(path.dirname(path.join(docs, note)))).toEqual(["cache-lifetime.md"]);
  expect(history.some((e) => e.type === "finding_export" && e.taskId === second.id && e.reason?.match(/cancel/i))).toBe(true);
});

it("reconciles complete replacement artifacts from a durable interrupted journal", async () => {
  record(); await flush(); const old = content(); record("New evidence after restart");
  const blocked = stageHandles((handle) => { vi.spyOn(handle, "write").mockRejectedValueOnce(new Error("Interrupted staging")); });
  await flush(); blocked.mockRestore(); expect(content()).toBe(old);
  const journal = history.filter((e) => e.type === "finding_batch").at(-1)!;
  if (journal.type !== "finding_batch") throw new Error("Expected journal");
  const temporary = path.join(docs, "personal-view", "agent-findings", `.agent-hub-${journal.batch.id}-cache-lifetime.md.tmp`);
  fs.writeFileSync(temporary, journal.batch.files[0]!.content);
  const backup = temporary.replace(/\.tmp$/, ".previous"); fs.linkSync(path.join(docs, note), backup);
  history = JSON.parse(JSON.stringify(history)); await flush();
  expect(last()?.state).toBe("exported"); expect(content()).toContain("New evidence after restart"); expect(git(docs, "rev-list", "--count", "HEAD")).toBe("3");
  expect(git(docs, "status", "--porcelain")).toBe(""); expect(fs.readdirSync(path.dirname(path.join(docs, note)))).toEqual(["cache-lifetime.md"]);
});

it("preserves human note edits arriving while Git prepares the documentation commit", async () => {
  record(); await flush(); record("Later evidence"); const head = git(docs, "rev-parse", "HEAD");
  const original = exportIo.findingGit;
  vi.spyOn(exportIo, "findingGit").mockImplementation(async (...args) => {
    const result = await original(...args);
    if (args[0] === docs && args[1][0] === "commit-tree") await asyncFs.writeFile(path.join(docs, note), "Concurrent human edit during Git preparation\n");
    return result;
  });
  await flush(); expect(last()?.state).toBe("conflict"); expect(content()).toBe("Concurrent human edit during Git preparation\n"); expect(git(docs, "rev-parse", "HEAD")).toBe(head);
  expect(fs.readdirSync(path.dirname(path.join(docs, note)))).toEqual(["cache-lifetime.md"]);
});

it("never overwrites a human canonical path created between retention and installation", async () => {
  record(); await flush(); record("New observation"); const head = git(docs, "rev-parse", "HEAD");
  const link = asyncFs.link.bind(asyncFs);
  const spy = vi.spyOn(asyncFs, "link").mockImplementation(async (source, destination) => {
    if (String(source).endsWith(".tmp")) await asyncFs.writeFile(destination, "Human canonical save during installation\n");
    return link(source, destination);
  });
  await flush(); spy.mockRestore(); expect(last()?.state).toBe("conflict"); expect(content()).toBe("Human canonical save during installation\n");
  expect(git(docs, "rev-parse", "HEAD")).toBe(head); expect(fs.readdirSync(path.dirname(path.join(docs, note)))).toEqual(["cache-lifetime.md"]);
});

it("retains and reports edits through an original inode after exclusive installation", async () => {
  record(); await flush(); record("New observation");
  const link = asyncFs.link.bind(asyncFs);
  const spy = vi.spyOn(asyncFs, "link").mockImplementation(async (source, destination) => {
    await link(source, destination);
    if (String(source).endsWith(".tmp")) await asyncFs.writeFile(String(source).replace(/\.tmp$/, ".previous"), "Human edit through retained inode\n");
  });
  await flush(); spy.mockRestore(); expect(last()?.state).toBe("conflict");
  const retained = fs.readdirSync(path.dirname(path.join(docs, note))).find((name) => name.endsWith(".previous"))!;
  expect(retained).toBeDefined(); expect(last()?.reason).toContain(retained);
  expect(fs.readFileSync(path.join(docs, "personal-view", "agent-findings", retained), "utf8")).toBe("Human edit through retained inode\n");
  const head = git(docs, "rev-parse", "HEAD"); await flush(); expect(last()?.state).toBe("conflict"); expect(git(docs, "rev-parse", "HEAD")).toBe(head);
  expect(fs.readFileSync(path.join(docs, "personal-view", "agent-findings", retained), "utf8")).toBe("Human edit through retained inode\n");
});
