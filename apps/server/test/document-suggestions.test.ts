import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fork, type ChildProcess } from "node:child_process";
import type Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { DocumentDetail, ImportSuggestionInput } from "@agent-hub/shared";
import { Documents, DocumentError } from "../src/core/documents";
import { openDb, schema, type Db } from "../src/db";

const native = (db: Db) => (db as Db & { $client: Database.Database }).$client;
let root: string, file: string, db: Db, service: Documents;
let clients: Database.Database[];
const draft = (content = "prefix 中文😀\npassage\nsuffix") => ({ title: "Fictional SOP", contentFormat: "plain_text" as const, content });
const input = (document: DocumentDetail, replacementText = "revised", start = 0, end = 6): ImportSuggestionInput => ({
  importRequestId: randomUUID(), source: "manual_import", baseRevisionId: document.currentRevision.id,
  selection: { startUtf16: start, endUtf16: end, originalText: document.currentRevision.content.slice(start, end) }, replacementText,
});
const code = (action: () => unknown, expected: string) => {
  try { action(); throw new Error("Expected failure"); }
  catch (error) { expect(error).toBeInstanceOf(DocumentError); expect(error).toMatchObject({ code: expected }); }
};
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "suggestion-core-")); file = path.join(root, "test.db");
  db = openDb(file); clients = [native(db)]; service = new Documents(db);
});
afterEach(() => {
  for (const client of clients) if (client.open) client.close();
  fs.rmSync(root, { recursive: true, force: true });
});

it("imports pending data with a server hash, lists only metadata, and scopes reads to documents", () => {
  const document = service.create(draft()), payload = input(document);
  const { suggestion: first, replayed } = service.importSuggestion(document.id, payload);
  expect(replayed).toBe(false);
  expect(first).toMatchObject({ source: "manual_import", status: "pending", originalText: "prefix", acceptedRevisionId: null, resolvedAt: null,
    baseRevisionNumber: 1, originalUtf8Bytes: 6, replacementUtf8Bytes: 7,
    selection: { startUtf16: 0, endUtf16: 6, originalSha256: createHash("sha256").update("prefix").digest("hex") } });
  expect(service.getSuggestion(document.id.toUpperCase(), first.id.toUpperCase())).toEqual(first);
  const second = service.importSuggestion(document.id, input(document, "other")).suggestion;
  const page = service.listSuggestions(document.id, { limit: "1" });
  expect(page.suggestions).toHaveLength(1); expect(page.nextOffset).toBe(1);
  for (const row of page.suggestions) { expect(row).not.toHaveProperty("originalText"); expect(row).not.toHaveProperty("replacementText"); }
  expect(service.listSuggestions(document.id, { offset: "1" }).suggestions).toHaveLength(1);
  expect(service.listSuggestions(document.id, { importRequestId: payload.importRequestId }).suggestions.map(s => s.id)).toEqual([first.id]);
  expect(service.listSuggestions(document.id, { status: "accepted" }).suggestions).toEqual([]);
  expect(service.get(document.id)).toEqual(document);
  const other = service.create(draft());
  for (const op of [() => service.getSuggestion(other.id, first.id), () => service.acceptSuggestion(other.id, first.id, { expectedRevisionId: payload.baseRevisionId }), () => service.rejectSuggestion(other.id, first.id, {})]) code(op, "suggestion_not_found");
  code(() => service.importSuggestion(other.id, payload), "revision_conflict");
  code(() => service.getSuggestion(document.id, randomUUID()), "suggestion_not_found");
  code(() => service.getSuggestion(randomUUID(), second.id), "document_not_found");
});

it("replays only the same import identity and exact immutable payload, even after resolution/tip changes", () => {
  const document = service.create(draft()), payload = input(document);
  const first = service.importSuggestion(document.id, payload).suggestion;
  expect(service.importSuggestion(document.id, payload)).toEqual({ suggestion: first, replayed: true });
  for (const patch of [{ replacementText: "different" }, { baseRevisionId: randomUUID() }, { selection: { ...payload.selection, endUtf16: 5 } }]) {
    code(() => service.importSuggestion(document.id, { ...payload, ...patch }), "import_key_conflict");
  }
  const another = service.importSuggestion(document.id, { ...payload, importRequestId: randomUUID() }).suggestion;
  expect(another.id).not.toBe(first.id);
  const accepted = service.acceptSuggestion(document.id, first.id, { expectedRevisionId: payload.baseRevisionId });
  expect(service.importSuggestion(document.id, payload)).toMatchObject({ replayed: true, suggestion: { id: first.id, status: "accepted", acceptedRevisionId: accepted.acceptedRevisionId } });
  code(() => service.importSuggestion(document.id, { ...payload, importRequestId: randomUUID() }), "revision_conflict");
  service.rejectSuggestion(document.id, another.id, {});
  expect(service.importSuggestion(document.id, { ...payload, importRequestId: another.importRequestId })).toMatchObject({ replayed: true, suggestion: { status: "rejected" } });
});

it.each([
  ["A😀B 中文\nend", 1, 3, "😺", "A😺B 中文\nend"],
  ["same\nsame\nlast", 5, 9, "new", "same\nnew\nlast"],
  ["A e\u0301 中文\uFEFF\n B", 2, 4, "é", "A é 中文\uFEFF\n B"],
  ["before\nselected\nafter", 7, 15, "", "before\n\nafter"],
])("uses exact UTF-16 offsets and preserves every byte outside the selection: %s", (text, start, end, replacement, expected) => {
  const document = service.create(draft(text as string));
  const suggestion = service.importSuggestion(document.id, input(document, replacement as string, start as number, end as number)).suggestion;
  const result = service.acceptSuggestion(document.id, suggestion.id, { expectedRevisionId: document.currentRevision.id });
  expect(result).toMatchObject({ replayed: false, acceptedRevisionNumber: 2, suggestion: { status: "accepted" }, document: { currentRevision: { title: document.currentRevision.title, contentFormat: "plain_text", restoredFromRevisionId: null, content: expected } } });
  expect(service.getRevision(document.id, document.currentRevision.id)).toEqual(document.currentRevision);
});

it("rejects invalid offsets, half surrogates, wrong text, malformed Unicode and unknown fields", () => {
  const document = service.create(draft("A😀B")), payload = input(document, "new", 1, 3);
  for (const [start, end] of [[1, 2], [2, 3], [-1, 3], [0.5, 3], [0, 5], [0, 0], [1, Number.MAX_SAFE_INTEGER + 1], ["1", 3], [null, 3]]) {
    code(() => service.importSuggestion(document.id, { ...payload, selection: { ...payload.selection, startUtf16: start, endUtf16: end } }), "invalid_selection");
  }
  code(() => service.importSuggestion(document.id, { ...payload, selection: { ...payload.selection, originalText: "x" } }), "selection_mismatch");
  for (const replacementText of ["\0", "\ud800", "\udfff"]) code(() => service.importSuggestion(document.id, { ...payload, replacementText }), "invalid_input");
  for (const originalText of ["\0", "\ud800", "\udfff"]) code(() => service.importSuggestion(document.id, { ...payload, selection: { ...payload.selection, originalText } }), "invalid_input");
  code(() => service.importSuggestion(document.id, { ...payload, selection: { ...payload.selection, originalText: "" } }), "invalid_selection");
  for (const patch of [{ extra: true }, { source: "provider" }, { importRequestId: "short" }, { importRequestId: "x".repeat(97) }, { importRequestId: "a!".repeat(10) }, { importRequestId: "a".repeat(16) + "\n" }, { importRequestId: "a".repeat(16) + "\0" }]) code(() => service.importSuggestion(document.id, { ...payload, ...patch }), "invalid_input");
  code(() => service.importSuggestion(document.id, { ...payload, selection: { ...payload.selection, extra: 1 } }), "invalid_input");
  code(() => service.importSuggestion(document.id, { ...payload, replacementText: "😀" }), "no_change");
  expect(service.listSuggestions(document.id).suggestions).toEqual([]);
});

it.each(["A\r\nB", "A\rB", "A\r\n\rB", "A\rX\nB"])("never converts a non-LF saved document: %j", text => {
  const document = service.create(draft(text));
  code(() => service.importSuggestion(document.id, input(document, "new", 0, 1)), "lf_required");
  expect(service.get(document.id)).toEqual(document);
});
it.each(["\r\n", "\r", "\r\n\r\n"])("rejects CR replacement without normalization: %j", text => {
  const document = service.create(draft()); code(() => service.importSuggestion(document.id, input(document, text)), "lf_required");
});

it("validates exact UTF-8 limits and total result bytes (not UTF-16 lengths)", () => {
  const original = "😀".repeat(4096), document = service.create(draft(original));
  const payload = input(document, "中".repeat(21845) + "x", 0, original.length); // exactly 65536 bytes
  const s = service.importSuggestion(document.id, payload).suggestion;
  expect(s.originalUtf8Bytes).toBe(16384); expect(s.replacementUtf8Bytes).toBe(65536);
  expect(Buffer.byteLength(service.acceptSuggestion(document.id, s.id, { expectedRevisionId: document.currentRevision.id }).document.currentRevision.content)).toBe(65536);
  const over = service.create(draft(original + "x"));
  code(() => service.importSuggestion(over.id, input(over, "new", 0, original.length + 1)), "payload_too_large");
  code(() => service.importSuggestion(over.id, input(over, payload.replacementText + "x", 0, 2)), "payload_too_large");
  const full = service.create(draft("x".repeat(262144)));
  const exact = service.importSuggestion(full.id, input(full, "y", 0, 1)).suggestion;
  code(() => service.importSuggestion(full.id, input(full, "yy", 0, 1)), "payload_too_large");
  expect(Buffer.byteLength(service.acceptSuggestion(full.id, exact.id, { expectedRevisionId: full.currentRevision.id }).document.currentRevision.content)).toBe(262144);
  for (const key of ["a".repeat(16), "Z_-" + "b".repeat(93)]) {
    const d = service.create(draft()); expect(service.importSuggestion(d.id, { ...input(d), importRequestId: key }).suggestion.importRequestId).toBe(key);
  }
});

it("keeps a permanent receipt after save/restore advances the tip and after reopening the database", () => {
  const document = service.create(draft()), payload = input(document);
  const s = service.importSuggestion(document.id, payload).suggestion;
  const first = service.acceptSuggestion(document.id, s.id, { expectedRevisionId: payload.baseRevisionId });
  expect(service.acceptSuggestion(document.id, s.id, { expectedRevisionId: payload.baseRevisionId })).toEqual({ ...first, replayed: true });
  code(() => service.acceptSuggestion(document.id, s.id, { expectedRevisionId: first.acceptedRevisionId }), "revision_conflict");
  const later = service.update(document.id, { ...draft("later"), expectedRevisionId: first.acceptedRevisionId }).document;
  const restored = service.restore(document.id, document.currentRevision.id, { expectedRevisionId: later.currentRevision.id }).document;
  native(db).close(); db = openDb(file); clients.push(native(db)); service = new Documents(db);
  expect(service.acceptSuggestion(document.id, s.id, { expectedRevisionId: payload.baseRevisionId })).toMatchObject({ replayed: true, acceptedRevisionId: first.acceptedRevisionId, acceptedRevisionNumber: 2, document: restored });
  expect(service.listRevisions(document.id).revisions).toHaveLength(4);
  expect(service.getSuggestion(document.id, s.id).status).toBe("accepted");
});

it("reject is idempotent, does not write a revision, and terminal outcomes are mutually exclusive", () => {
  const document = service.create(draft()), s = service.importSuggestion(document.id, input(document)).suggestion;
  const rejected = service.rejectSuggestion(document.id, s.id, {});
  expect(rejected).toMatchObject({ replayed: false, suggestion: { status: "rejected", acceptedRevisionId: null } });
  expect(service.rejectSuggestion(document.id, s.id, {})).toEqual({ ...rejected, replayed: true });
  code(() => service.acceptSuggestion(document.id, s.id, { expectedRevisionId: document.currentRevision.id }), "suggestion_rejected");
  expect(service.get(document.id)).toEqual(document); expect(service.listRevisions(document.id).revisions).toHaveLength(1);
  const second = service.importSuggestion(document.id, input(document)).suggestion;
  service.acceptSuggestion(document.id, second.id, { expectedRevisionId: document.currentRevision.id });
  code(() => service.rejectSuggestion(document.id, second.id, {}), "suggestion_already_accepted");
  code(() => service.rejectSuggestion(document.id, second.id, { extra: true }), "invalid_input");
});

it.each(["BEFORE UPDATE ON document_suggestions", "AFTER UPDATE ON document_suggestions", "AFTER INSERT ON document_revisions"])("rolls back the revision and receipt when a %s trigger fails", position => {
  const document = service.create(draft()), s = service.importSuggestion(document.id, input(document)).suggestion;
  native(db).exec(`CREATE TRIGGER fail_accept ${position} BEGIN SELECT RAISE(ABORT, 'fictional private SQL payload'); END`);
  code(() => service.acceptSuggestion(document.id, s.id, { expectedRevisionId: document.currentRevision.id }), "storage_error");
  expect(service.get(document.id)).toEqual(document); expect(service.listRevisions(document.id).revisions).toHaveLength(1);
  expect(service.getSuggestion(document.id, s.id)).toEqual(s);
  native(db).exec("DROP TRIGGER fail_accept");
  expect(service.acceptSuggestion(document.id, s.id, { expectedRevisionId: document.currentRevision.id }).acceptedRevisionNumber).toBe(2);
});

it("revalidates the stored hash and total result inside accept, failing closed without appending", () => {
  const document = service.create(draft()), s = service.importSuggestion(document.id, input(document)).suggestion;
  // Simulate damaged storage in this temp DB only; normal SQL cannot mutate the payload.
  native(db).exec("DROP TRIGGER document_suggestions_update_guard");
  db.update(schema.documentSuggestions).set({ originalSha256: "0".repeat(64) }).where(eq(schema.documentSuggestions.id, s.id)).run();
  code(() => service.acceptSuggestion(document.id, s.id, { expectedRevisionId: document.currentRevision.id }), "selection_mismatch");
  expect(service.get(document.id)).toEqual(document);
  expect(service.getSuggestion(document.id, s.id).status).toBe("pending");
});

it("distinguishes sequential two-connection CAS from a real overlapping writer lock", () => {
  const document = service.create(draft()), s = service.importSuggestion(document.id, input(document)).suggestion;
  const b = openDb(file); clients.push(native(b)); const second = new Documents(b); native(b).pragma("busy_timeout = 1");
  native(db).exec("BEGIN IMMEDIATE");
  try {
    // Run the production path inside the held transaction (Drizzle savepoint); B must see the old snapshot.
    const accepted = service.acceptSuggestion(document.id, s.id, { expectedRevisionId: document.currentRevision.id });
    expect(accepted.acceptedRevisionNumber).toBe(2);
    expect(second.getSuggestion(document.id, s.id).status).toBe("pending");
    code(() => second.acceptSuggestion(document.id, s.id, { expectedRevisionId: document.currentRevision.id }), "storage_busy");
    code(() => second.rejectSuggestion(document.id, s.id, {}), "storage_busy");
    native(db).exec("COMMIT");
  } finally { if (native(db).inTransaction) native(db).exec("ROLLBACK"); }
  expect(second.acceptSuggestion(document.id, s.id, { expectedRevisionId: document.currentRevision.id }).replayed).toBe(true);
  code(() => second.update(document.id, { ...draft("other"), expectedRevisionId: document.currentRevision.id }), "revision_conflict");
  expect(second.listRevisions(document.id).revisions).toHaveLength(2);
});

// Separate processes run synchronous writers while this test's connection holds the barrier lock.
type Operation = { kind: "accept" | "reject" | "save" | "restore" | "import"; documentId: string; suggestionId?: string; base: string; payload?: ImportSuggestionInput };
type Outcome = { status: number; code?: string; receipt?: string; replayed?: boolean; suggestionId?: string };
async function race(operations: Operation[]): Promise<Outcome[]> {
  const children: ChildProcess[] = [];
  const outcomes: Promise<Outcome>[] = [];
  const attempts: Promise<void>[] = [];
  const ready: Promise<void>[] = [];
  const starts: Array<() => void> = [];
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let completed = 0;
  try {
    for (const operation of operations) {
      const child = fork(path.resolve("test/fixtures/suggestion-writer.ts"), [file], { execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "pipe", "ipc"] }); children.push(child);
      let stderr = ""; child.stderr!.on("data", chunk => { stderr += String(chunk); });
      let begin!: () => void, attempt!: () => void, done!: (value: Outcome) => void, fail!: (error: Error) => void;
      ready.push(new Promise(resolve => { begin = resolve; })); attempts.push(new Promise(resolve => { attempt = resolve; }));
      outcomes.push(new Promise((resolve, reject) => { done = resolve; fail = reject; }));
      child.on("error", fail);
      child.on("exit", code => { if (code) fail(new Error(`Writer exited ${code}: ${stderr}`)); });
      child.on("message", (message: { type: string; outcome: Outcome }) => {
        if (message.type === "ready") begin();
        if (message.type === "attempt") attempt();
        if (message.type === "result") { completed++; done(message.outcome); }
      });
      starts.push(() => { child.send(operation); });
    }
    // Deadline applies to setup, barriers and results; children are always killed in finally.
    return await Promise.race([
      (async () => {
        await Promise.all(ready);
        native(db).exec("BEGIN IMMEDIATE");
        for (const start of starts) start();
        await Promise.all(attempts);
        await new Promise(resolve => setTimeout(resolve, 50));
        expect(completed).toBe(0); // Both service calls are waiting behind a real SQLite writer.
        native(db).exec("COMMIT");
        return Promise.all(outcomes);
      })(),
      new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error("Writer barrier timeout")), 12000); }),
    ]);
  } finally {
    clearTimeout(deadline);
    if (native(db).inTransaction) native(db).exec("ROLLBACK");
    await Promise.all(children.map(child => new Promise<void>(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      child.once("exit", () => resolve()); child.kill();
    })));
  }
}

it.each(["same", "different", "save", "restore", "reject", "import"] as const)("runs real independent-process SQLite writer contention: %s", async kind => {
  const document = service.create(draft()), payload = input(document);
  const a = service.importSuggestion(document.id, payload).suggestion;
  const b = kind === "different" ? service.importSuggestion(document.id, input(document, "another")).suggestion : a;
  const first: Operation = { kind: "accept", documentId: document.id, suggestionId: a.id, base: document.currentRevision.id };
  const other: Operation = { ...first, kind: kind === "same" || kind === "different" ? "accept" : kind === "import" ? "import" : kind, suggestionId: b.id };
  const ops = kind === "import" ? [{ ...other, payload: input(document) }, { ...other, payload: undefined }] : [first, other];
  if (kind === "import") ops[1] = { ...ops[0]! };
  const result = await race(ops);
  if (kind === "same") {
    expect(result.map(r => r.status)).toEqual([200, 200]); expect(result.map(r => r.replayed).sort()).toEqual([false, true]);
    expect(result[0]!.receipt).toBe(result[1]!.receipt);
  } else if (kind === "import") {
    expect(result.map(r => r.status)).toEqual([200, 200]); expect(result.map(r => r.replayed).sort()).toEqual([false, true]);
    expect(result[0]!.suggestionId).toBe(result[1]!.suggestionId);
  } else {
    expect(result.map(r => r.status).sort()).toEqual([200, 409]);
    if (kind === "different" || kind === "save" || kind === "restore") expect(result.find(r => r.status === 409)!.code).toBe("revision_conflict");
  }
  const final = service.getSuggestion(document.id, a.id);
  expect(service.listRevisions(document.id).revisions).toHaveLength(kind === "import" || final.status === "rejected" ? 1 : 2);
  if (kind === "reject") expect(["accepted", "rejected"]).toContain(final.status);
}, 15000);
