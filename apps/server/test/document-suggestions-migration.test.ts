import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, expect, it } from "vitest";
import { Documents } from "../src/core/documents";
import { openDb, schema, type Db } from "../src/db";

const native = (db: Db) => (db as Db & { $client: Database.Database }).$client;
const source = path.resolve("drizzle");
let root: string, clients: Database.Database[];
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "suggestion-migration-")); clients = []; });
afterEach(() => { for (const c of clients) if (c.open) c.close(); fs.rmSync(root, { recursive: true, force: true }); });
const open = (name: string) => { const db = openDb(name); clients.push(native(db)); return db; };
const draft = { title: "Fictional", contentFormat: "plain_text", content: "A😀B\n" };

it("upgrades 0007 to latest without changing any legacy table, document, snapshot or revision trigger", () => {
  const folder = path.join(root, "pr1a"), file = path.join(root, "upgrade.db");
  fs.mkdirSync(path.join(folder, "meta"), { recursive: true });
  const journal = JSON.parse(fs.readFileSync(path.join(source, "meta/_journal.json"), "utf8"));
  journal.entries = journal.entries.filter((e: { idx: number }) => e.idx <= 7);
  for (const entry of journal.entries) fs.copyFileSync(path.join(source, `${entry.tag}.sql`), path.join(folder, `${entry.tag}.sql`));
  fs.writeFileSync(path.join(folder, "meta/_journal.json"), JSON.stringify(journal));
  const legacy = new Database(file); clients.push(legacy); legacy.pragma("foreign_keys = ON");
  const old = drizzle(legacy, { schema }); migrate(old, { migrationsFolder: folder });
  const documents = new Documents(old);
  const d = documents.create(draft), cr = documents.create({ ...draft, content: "A\r\n\rB" });
  documents.restore(d.id, d.currentRevision.id, { expectedRevisionId: d.currentRevision.id });
  old.insert(schema.tasks).values({ id: "fictional-task", title: "existing", workflow: "chat", status: "idle", createdAt: "now", updatedAt: "now" }).run();
  old.insert(schema.sessions).values({ id: "fictional-session", taskId: "fictional-task", agent: "claude", role: "main", status: "idle" }).run();
  old.insert(schema.events).values({ id: "fictional-event", taskId: "fictional-task", seq: 1, type: "user_message", payload: { text: "fictional" }, createdAt: "now" }).run();
  const tables = ["documents", "document_revisions", "tasks", "sessions", "events", "queued_messages", "hosts", "ssh_log"];
  const rows = Object.fromEntries(tables.map(table => [table, legacy.prepare(`SELECT * FROM ${table}`).all()]));
  const objects = legacy.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name != '__drizzle_migrations' ORDER BY name").all() as { name: string }[];
  legacy.close();
  const db = open(file), client = native(db);
  for (const table of tables) expect(client.prepare(`SELECT * FROM ${table}`).all()).toEqual(rows[table]);
  for (const object of objects) expect(client.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name=?").get(object.name)).toEqual(object);
  expect(client.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='document_revisions'").all()).toHaveLength(3);
  expect(client.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='document_suggestions'").all()).toHaveLength(3);
  expect(client.pragma("foreign_keys", { simple: true })).toBe(1);
  expect(client.pragma("foreign_key_check")).toEqual([]); expect(client.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
  expect(new Documents(db).get(cr.id)).toEqual(cr);
  const count = client.prepare("SELECT count(*) AS n FROM __drizzle_migrations").get(); client.close();
  const restarted = open(file); expect(native(restarted).prepare("SELECT count(*) AS n FROM __drizzle_migrations").get()).toEqual(count);
  expect(new Documents(restarted).get(cr.id)).toEqual(cr);
  for (const command of ["UPDATE document_revisions SET title='bad'", "DELETE FROM document_revisions"]) expect(() => native(restarted).exec(command)).toThrow(/immutable/);
});

it("creates fresh storage and preserves pending/rejected/accepted payloads and receipts across restart", () => {
  const file = path.join(root, "fresh.db"), db = open(file), service = new Documents(db), d = service.create(draft);
  const make = () => service.importSuggestion(d.id, { importRequestId: randomUUID(), source: "manual_import", baseRevisionId: d.currentRevision.id,
    selection: { startUtf16: 1, endUtf16: 3, originalText: "😀" }, replacementText: "新" }).suggestion;
  const a = make(), b = make(), c = make();
  service.rejectSuggestion(d.id, b.id, {});
  const accepted = service.acceptSuggestion(d.id, a.id, { expectedRevisionId: d.currentRevision.id });
  const snapshots = [a.id, b.id, c.id].map(id => service.getSuggestion(d.id, id));
  native(db).close(); const restarted = new Documents(open(file));
  expect([a.id, b.id, c.id].map(id => restarted.getSuggestion(d.id, id))).toEqual(snapshots);
  expect(restarted.acceptSuggestion(d.id, a.id, { expectedRevisionId: d.currentRevision.id })).toEqual({ ...accepted, replayed: true });
  const journal = JSON.parse(fs.readFileSync(path.join(source, "meta/_journal.json"), "utf8"));
  const migration = fs.readFileSync(path.join(source, `${journal.entries.find((e: { idx: number }) => e.idx === 8).tag}.sql`), "utf8");
  expect(migration).not.toMatch(/(?:ALTER|DROP)\s+TABLE/i);
  expect(migration).not.toMatch(/(?:UPDATE|INSERT\s+INTO|DELETE\s+FROM)\s+[`"]?(?:tasks|sessions|events|documents|document_revisions)\b/i);
});

it("enforces immutable payload, terminal state, receipt and REPLACE/DELETE guards independently of the API", () => {
  const db = open(path.join(root, "guards.db")), client = native(db), service = new Documents(db), d = service.create(draft);
  const make = () => service.importSuggestion(d.id, { importRequestId: randomUUID(), source: "manual_import", baseRevisionId: d.currentRevision.id,
    selection: { startUtf16: 0, endUtf16: 1, originalText: "A" }, replacementText: "new" }).suggestion;
  const a = make(), b = make();
  const row = db.select().from(schema.documentSuggestions).all()[0]!;
  const attempt = (patch: Partial<typeof row>) => db.insert(schema.documentSuggestions).values({ ...row, id: randomUUID(), importRequestId: randomUUID(), ...patch }).run();
  for (const patch of [{ status: "accepted" as const, resolvedAt: "now" }, { status: "rejected" as const, resolvedAt: "now" },
    { baseRevisionId: randomUUID() }, { documentId: randomUUID() }, { source: "provider" as "manual_import" },
    { originalText: "" }, { originalText: "x\r" }, { originalText: "x\0" }, { originalText: "x".repeat(16385) },
    { replacementText: "x\r" }, { replacementText: "x\0" }, { replacementText: "x".repeat(65537) },
    { originalSha256: "q".repeat(64) }, { selectionEnd: 0 }, { selectionStart: 0.5 }, { selectionEnd: Number.MAX_SAFE_INTEGER + 1 }, { importRequestId: "short" }]) expect(() => attempt(patch)).toThrow();
  const other = service.create(draft);
  expect(() => attempt({ documentId: other.id })).toThrow(/base/);
  for (const field of ["id", "document_id", "import_request_id", "source", "base_revision_id", "selection_start", "selection_end", "original_text", "original_sha256", "replacement_text", "created_at"]) {
    expect(() => client.prepare(`UPDATE document_suggestions SET ${field}=? WHERE id=?`).run("changed", a.id)).toThrow(/immutable/);
  }
  expect(() => client.prepare("UPDATE document_suggestions SET status='pending' WHERE id=?").run(a.id)).toThrow(/immutable/);
  expect(() => client.prepare("UPDATE document_suggestions SET status='rejected' WHERE id=?").run(a.id)).toThrow(/CHECK/);
  expect(() => client.prepare("UPDATE document_suggestions SET status='accepted',accepted_revision_id=?,resolved_at='now' WHERE id=?").run(other.currentRevision.id, a.id)).toThrow(/receipt/);
  const insert = (item: typeof row) => db.insert(schema.documentSuggestions).values(item).onConflictDoNothing().run();
  // Even conflict-ignore/REPLACE must not bypass the explicit duplicate guard.
  expect(() => insert(row)).toThrow(/duplicate/);
  const columns = Object.keys(client.prepare("SELECT * FROM document_suggestions LIMIT 1").get() as object);
  const raw = client.prepare("SELECT * FROM document_suggestions WHERE id=?").get(a.id) as Record<string, unknown>;
  const replace = client.prepare(`INSERT OR REPLACE INTO document_suggestions (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`);
  expect(() => replace.run(...columns.map(c => raw[c]))).toThrow(/duplicate/);
  expect(() => replace.run(...columns.map(c => c === "id" ? randomUUID() : raw[c]))).toThrow(/duplicate/);
  const accepted = service.acceptSuggestion(d.id, a.id, { expectedRevisionId: d.currentRevision.id });
  expect(() => client.prepare("UPDATE OR REPLACE document_suggestions SET status='accepted',accepted_revision_id=?,resolved_at='now' WHERE id=?").run(accepted.acceptedRevisionId, b.id)).toThrow(/duplicate_receipt/);
  for (const id of [a.id, b.id]) expect(() => client.prepare("DELETE FROM document_suggestions WHERE id=?").run(id)).toThrow(/immutable/);
  for (const status of ["pending", "accepted", "rejected"]) expect(() => client.prepare("UPDATE document_suggestions SET status=? WHERE id=?").run(status, a.id)).toThrow(/immutable/);
  service.rejectSuggestion(d.id, b.id, {});
  expect(() => client.prepare("UPDATE document_suggestions SET status='accepted',accepted_revision_id=? WHERE id=?").run(accepted.acceptedRevisionId, b.id)).toThrow(/immutable/);
  expect(() => client.prepare("DELETE FROM documents WHERE id=?").run(d.id)).toThrow(/FOREIGN KEY/);
  expect(client.pragma("foreign_key_check")).toEqual([]);
  expect(service.getSuggestion(d.id, a.id).acceptedRevisionId).toBe(accepted.acceptedRevisionId);
});

it("widens the 0008 source check while retaining every suggestion and verbatim guards after reopen", () => {
  const folder = path.join(root, "before-rooms"), file = path.join(root, "room-upgrade.db");
  fs.mkdirSync(path.join(folder, "meta"), { recursive: true });
  const journal = JSON.parse(fs.readFileSync(path.join(source, "meta/_journal.json"), "utf8"));
  journal.entries = journal.entries.filter((e: { idx: number }) => e.idx <= 8);
  for (const entry of journal.entries) fs.copyFileSync(path.join(source, `${entry.tag}.sql`), path.join(folder, `${entry.tag}.sql`));
  fs.writeFileSync(path.join(folder, "meta/_journal.json"), JSON.stringify(journal));
  const legacy = new Database(file); clients.push(legacy); legacy.pragma("foreign_keys = ON");
  const old = drizzle(legacy, { schema }); migrate(old, { migrationsFolder: folder });
  const service = new Documents(old), d = service.create(draft);
  const make = () => service.importSuggestion(d.id, { importRequestId: randomUUID(), source: "manual_import", baseRevisionId: d.currentRevision.id,
    selection: { startUtf16: 0, endUtf16: 1, originalText: "A" }, replacementText: "New" }).suggestion;
  const a = make(), b = make(), c = make();
  service.rejectSuggestion(d.id, b.id, {}); service.acceptSuggestion(d.id, a.id, { expectedRevisionId: d.currentRevision.id });
  const rows = legacy.prepare("SELECT * FROM document_suggestions ORDER BY id").all();
  const guards = legacy.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name='document_suggestions' ORDER BY name").all();
  legacy.close(); const upgraded = open(file);
  expect(native(upgraded).prepare("SELECT * FROM document_suggestions ORDER BY id").all()).toEqual(rows);
  native(upgraded).close(); const restarted = open(file), client = native(restarted);
  expect(client.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name='document_suggestions' ORDER BY name").all()).toEqual(guards);
  expect(() => client.prepare("UPDATE document_suggestions SET original_text='changed' WHERE id=?").run(c.id)).toThrow(/immutable/);
  expect(() => client.prepare("DELETE FROM document_suggestions WHERE id=?").run(c.id)).toThrow(/immutable/);
  const row = client.prepare("SELECT * FROM document_suggestions WHERE id=?").get(c.id) as Record<string, unknown>;
  const columns = Object.keys(row);
  expect(() => client.prepare(`INSERT OR REPLACE INTO document_suggestions (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`).run(...columns.map(k => row[k]))).toThrow(/duplicate/);
  const current = new Documents(restarted).get(d.id).currentRevision;
  for (const agent of ["claude", "codex"]) expect(new Documents(restarted).importSuggestion(d.id, { importRequestId: randomUUID(), source: agent, baseRevisionId: current.id,
    selection: { startUtf16: 0, endUtf16: 3, originalText: "New" }, replacementText: "Better" }).suggestion.source).toBe(agent);
  expect(client.pragma("foreign_key_check")).toEqual([]);
});
