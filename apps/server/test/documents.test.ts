import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Documents, DocumentError, DOCUMENT_CONTENT_BYTES } from "../src/core/documents";
import { openDb, schema, type Db } from "../src/db";

const draft = { title: " Fictional SOP ", contentFormat: "plain_text", content: "  中文😀\r\nsecond\nlast\r  " };
let root: string, db: Db, service: Documents;
let clients: Database.Database[];
const native = (value: Db) => (value as Db & { $client: Database.Database }).$client;
function connect(file: string) { const value = openDb(file); clients.push(native(value)); return value; }
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "document-core-")); clients = [];
  db = connect(path.join(root, "test.db")); service = new Documents(db);
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const client of clients) if (client.open) client.close();
  fs.rmSync(root, { recursive: true, force: true });
});
function code(action: () => unknown, expected: string) {
  try { action(); throw new Error("Expected document failure"); }
  catch (error) { expect(error).toBeInstanceOf(DocumentError); expect(error).toMatchObject({ code: expected }); }
}

it("creates independent identities, round-trips exact Unicode/CRLF, and appends title/content snapshots", () => {
  const first = service.create(draft), revision = first.currentRevision;
  expect(first.id).not.toBe(revision.id);
  expect(revision).toMatchObject({ documentId: first.id, revisionNumber: 1, title: "Fictional SOP", content: draft.content, restoredFromRevisionId: null });
  expect(service.get(first.id.toUpperCase())).toEqual(first);
  const updated = service.update(first.id, { ...draft, title: "Changed", expectedRevisionId: revision.id });
  expect(updated).toMatchObject({ revisionCreated: true, document: { currentRevision: { revisionNumber: 2, title: "Changed", content: draft.content } } });
  expect(service.getRevision(first.id, revision.id)).toEqual(revision);
  const changed = service.update(first.id, { ...draft, title: "Changed", content: "new text", expectedRevisionId: updated.document.currentRevision.id });
  expect(changed.document.currentRevision.revisionNumber).toBe(3);
  expect(service.create(draft).id).not.toBe(first.id); // Identical create bodies are separate documents.
});

it("checks CAS before no-op, never duplicates a successful update on retransmission", () => {
  const first = service.create(draft), expectedRevisionId = first.currentRevision.id;
  expect(service.update(first.id, { ...draft, expectedRevisionId })).toEqual({ document: first, revisionCreated: false });
  const next = { ...draft, content: "edited", expectedRevisionId };
  const result = service.update(first.id, next);
  code(() => service.update(first.id, next), "revision_conflict");
  code(() => service.update(first.id, { ...draft, expectedRevisionId }), "revision_conflict");
  expect(service.listRevisions(first.id).revisions).toHaveLength(2);
  expect(service.update(first.id, { ...next, expectedRevisionId: result.document.currentRevision.id }).revisionCreated).toBe(false);
});

it("restores the full historical snapshot as a new revision, including explicit restore of current", () => {
  const first = service.create(draft);
  const second = service.update(first.id, { ...draft, title: "Changed title", content: "new text", expectedRevisionId: first.currentRevision.id }).document;
  const restored = service.restore(first.id, first.currentRevision.id, { expectedRevisionId: second.currentRevision.id });
  expect(restored).toMatchObject({ revisionCreated: true, document: { currentRevision: {
    revisionNumber: 3, title: "Fictional SOP", contentFormat: "plain_text", content: draft.content, restoredFromRevisionId: first.currentRevision.id,
  } } });
  expect(service.getRevision(first.id, second.currentRevision.id)).toEqual(second.currentRevision);
  code(() => service.restore(first.id, first.currentRevision.id, { expectedRevisionId: second.currentRevision.id }), "revision_conflict");
  const current = restored.document.currentRevision;
  expect(service.restore(first.id, current.id, { expectedRevisionId: current.id }).document.currentRevision.revisionNumber).toBe(4);
});

it("paginates metadata without bodies and keeps revision order independent of timestamps", () => {
  const first = service.create(draft);
  vi.useFakeTimers();
  try {
    vi.setSystemTime(new Date("2000-01-01"));
    const second = service.update(first.id, { ...draft, content: "two", expectedRevisionId: first.currentRevision.id }).document;
    vi.setSystemTime(new Date("1999-01-01"));
    const third = service.update(first.id, { ...draft, content: "three", expectedRevisionId: second.currentRevision.id }).document;
    expect(service.get(first.id)).toEqual(third);
    const page = service.listRevisions(first.id, { limit: "1" });
    expect(page.revisions[0]).not.toHaveProperty("content");
    expect(page.nextBeforeRevisionNumber).toBe(3);
    expect(service.listRevisions(first.id, { beforeRevisionNumber: "3" }).revisions.map((r) => r.revisionNumber)).toEqual([2, 1]);
    expect(service.listRevisions(first.id, { beforeRevisionNumber: "1" }).revisions).toEqual([]);
    service.create(draft);
    const list = service.list({ limit: "1" });
    expect(list.documents[0]).toMatchObject({ id: first.id, revisionNumber: 3 });
    expect(list.documents[0]).not.toHaveProperty("content");
    expect(list.nextOffset).toBe(1);
    expect(service.list({ offset: "1" }).documents).toHaveLength(1);
  } finally { vi.useRealTimers(); }
});

it("does not disclose a revision from another document and validates IDs/pagination", () => {
  const first = service.create(draft), other = service.create(draft);
  code(() => service.getRevision(first.id, other.currentRevision.id), "revision_not_found");
  code(() => service.restore(first.id, other.currentRevision.id, { expectedRevisionId: first.currentRevision.id }), "revision_not_found");
  for (const missing of [() => service.get(randomUUID()), () => service.listRevisions(randomUUID()), () => service.getRevision(randomUUID(), first.currentRevision.id)]) code(missing, "document_not_found");
  code(() => service.get("../bad"), "invalid_document_id");
  code(() => service.getRevision(first.id, "bad"), "invalid_revision_id");
  for (const limit of ["0", "101", "-1", "01", "1.5", "Infinity", "9007199254740992"]) code(() => service.list({ limit }), "invalid_pagination");
  code(() => service.list({ offset: "-1" }), "invalid_pagination");
  code(() => service.listRevisions(first.id, { beforeRevisionNumber: "0" }), "invalid_pagination");
});

it("allows blank drafts, enforces UTF-16 titles and UTF-8 body bytes, and rejects malformed Unicode", () => {
  for (const text of ["", " \r\n\t", "<script>fictional</script>", "\uFEFFkeep BOM", "😀".repeat(DOCUMENT_CONTENT_BYTES / 4)]) {
    expect(service.create({ ...draft, content: text }).currentRevision.content).toBe(text);
  }
  expect(service.create({ ...draft, title: "😀".repeat(100) }).currentRevision.title.length).toBe(200);
  for (const title of ["", " \n\t", "😀".repeat(101), "a\nb", "a\rb", "a\u2028b", "x\0", "\ud800", "\udfff"]) code(() => service.create({ ...draft, title }), "invalid_input");
  for (const text of ["\ud800", "\udfff", "a\0b", "😀\ud800"]) code(() => service.create({ ...draft, content: text }), "invalid_input");
  code(() => service.create({ ...draft, content: "😀".repeat(DOCUMENT_CONTENT_BYTES / 4) + "x" }), "payload_too_large");
  for (const input of [null, [], {}, { ...draft, id: randomUUID() }, { ...draft, content: 1 }]) code(() => service.create(input), "invalid_input");
  code(() => service.create({ ...draft, contentFormat: "html" }), "unsupported_content_format");
});

describe("database invariants", () => {
  it("rejects direct UPDATE/DELETE, REPLACE by id or sequence, UPSERT, gaps and foreign restore sources", () => {
    const first = service.create(draft), other = service.create(draft), row = first.currentRevision;
    const insert = (patch = {}) => db.insert(schema.documentRevisions).values({ ...row, id: randomUUID(), revisionNumber: 2, ...patch }).run();
    expect(() => native(db).prepare("UPDATE document_revisions SET content = 'overwrite' WHERE id = ?").run(row.id)).toThrow(/immutable/);
    expect(() => native(db).prepare("DELETE FROM document_revisions WHERE id = ?").run(row.id)).toThrow(/immutable/);
    for (const patch of [{ id: row.id }, { revisionNumber: 1 }, { revisionNumber: 0 }, { revisionNumber: 3 }, { revisionNumber: 1.5 }, { restoredFromRevisionId: other.currentRevision.id }, { restoredFromRevisionId: randomUUID() }, { documentId: randomUUID(), revisionNumber: 1 }]) expect(() => insert(patch)).toThrow();
    const statement = native(db).prepare("INSERT OR REPLACE INTO document_revisions (id,document_id,revision_number,title,content_format,content,created_at) VALUES (?,?,?,?,?,?,?)");
    expect(() => statement.run(row.id, first.id, 2, "replace", "plain_text", "overwrite", row.createdAt)).toThrow(/duplicate/);
    expect(() => statement.run(randomUUID(), first.id, 1, "replace", "plain_text", "overwrite", row.createdAt)).toThrow(/duplicate/);
    expect(() => db.insert(schema.documentRevisions).values({ ...row }).onConflictDoUpdate({ target: schema.documentRevisions.id, set: { content: "overwrite" } }).run()).toThrow();
    expect(() => native(db).prepare("DELETE FROM documents WHERE id = ?").run(first.id)).toThrow(/FOREIGN KEY/);
    expect(() => native(db).prepare("UPDATE documents SET id = ? WHERE id = ?").run(randomUUID(), first.id)).toThrow(/FOREIGN KEY/);
    expect(native(db).pragma("foreign_keys", { simple: true })).toBe(1);
    expect(service.get(first.id)).toEqual(first);
    insert();
    expect(service.get(first.id).currentRevision.revisionNumber).toBe(2);
  });

  it("enforces CHECK constraints independently of the HTTP validator", () => {
    const first = service.create(draft), row = first.currentRevision;
    for (const patch of [{ title: "" }, { title: "x\n" }, { title: "x".repeat(201) }, { contentFormat: "html" as "plain_text" }, { content: "x\0y" }, { content: "x".repeat(DOCUMENT_CONTENT_BYTES + 1) }]) {
      expect(() => db.insert(schema.documentRevisions).values({ ...row, id: randomUUID(), revisionNumber: 2, ...patch }).run()).toThrow(/CHECK/);
    }
  });

  it("rolls back create, save and restore if an AFTER INSERT trigger fails, without retaining private errors", () => {
    const fail = () => db.run(sql`CREATE TRIGGER fail_document AFTER INSERT ON document_revisions BEGIN SELECT RAISE(ABORT, 'private SQL failure'); END`);
    const drop = () => db.run(sql`DROP TRIGGER fail_document`);
    fail();
    code(() => service.create(draft), "storage_error");
    expect(db.select().from(schema.documents).all()).toEqual([]);
    drop();
    const first = service.create(draft);
    fail();
    code(() => service.update(first.id, { ...draft, content: "changed", expectedRevisionId: first.currentRevision.id }), "storage_error");
    code(() => service.restore(first.id, first.currentRevision.id, { expectedRevisionId: first.currentRevision.id }), "storage_error");
    expect(service.get(first.id)).toEqual(first);
    expect(service.listRevisions(first.id).revisions).toHaveLength(1);
  });
});

it("persists snapshots after closing and reopening the file with a fresh service", () => {
  const first = service.create(draft);
  const next = service.restore(first.id, first.currentRevision.id, { expectedRevisionId: first.currentRevision.id }).document;
  native(db).close();
  const reopened = new Documents(connect(path.join(root, "test.db")));
  expect(reopened.get(first.id)).toEqual(next);
  expect(reopened.getRevision(first.id, first.currentRevision.id)).toEqual(first.currentRevision);
});

it("performs CAS across two independent connections with the same previously read base", () => {
  const first = service.create(draft), second = new Documents(connect(path.join(root, "test.db")));
  const baseA = service.get(first.id), baseB = second.get(first.id);
  const winner = service.update(first.id, { ...draft, content: "A", expectedRevisionId: baseA.currentRevision.id });
  code(() => second.update(first.id, { ...draft, content: "B", expectedRevisionId: baseB.currentRevision.id }), "revision_conflict");
  expect(second.get(first.id)).toEqual(winner.document);
  expect(second.listRevisions(first.id).revisions).toHaveLength(2);
});

it("tests a real overlapping SQLite writer lock separately from stale sequential CAS", () => {
  const first = service.create(draft), connectionB = connect(path.join(root, "test.db")), second = new Documents(connectionB);
  native(connectionB).pragma("busy_timeout = 1"); // Test only: do not block the event loop for the driver default.
  native(db).exec("BEGIN IMMEDIATE");
  try {
    db.insert(schema.documentRevisions).values({ ...first.currentRevision, id: randomUUID(), revisionNumber: 2, content: "writer A" }).run();
    expect(second.get(first.id)).toEqual(first); // WAL reader cannot see the uncommitted revision.
    code(() => second.update(first.id, { ...draft, content: "writer B", expectedRevisionId: first.currentRevision.id }), "storage_busy");
    code(() => second.restore(first.id, first.currentRevision.id, { expectedRevisionId: first.currentRevision.id }), "storage_busy");
    native(db).exec("COMMIT");
  } finally { if (native(db).inTransaction) native(db).exec("ROLLBACK"); }
  code(() => second.update(first.id, { ...draft, content: "writer B", expectedRevisionId: first.currentRevision.id }), "revision_conflict");
  expect(second.get(first.id).currentRevision.content).toBe("writer A");
  expect(second.listRevisions(first.id).revisions).toHaveLength(2);
});
