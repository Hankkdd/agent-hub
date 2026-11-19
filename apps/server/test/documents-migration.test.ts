import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { expect, it } from "vitest";
import { openDb, schema as currentSchema, type Db } from "../src/db";
import { Documents } from "../src/core/documents";

const native = (db: Db) => (db as Db & { $client: Database.Database }).$client;
const source = path.resolve("drizzle");

it("adds only the two document tables to the legacy schema, preserving existing records and schema objects", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "document-migration-"));
  const file = path.join(root, "test.db"), folder = path.join(root, "legacy");
  const clients: Database.Database[] = [];
  try {
    fs.mkdirSync(path.join(folder, "meta"), { recursive: true });
    const journal = JSON.parse(fs.readFileSync(path.join(source, "meta/_journal.json"), "utf8"));
    journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx <= 6);
    for (const entry of journal.entries) fs.copyFileSync(path.join(source, `${entry.tag}.sql`), path.join(folder, `${entry.tag}.sql`));
    fs.writeFileSync(path.join(folder, "meta/_journal.json"), JSON.stringify(journal));
    const legacy = new Database(file); clients.push(legacy);
    migrate(drizzle(legacy), { migrationsFolder: folder });
    legacy.prepare("INSERT INTO tasks (id,title,workflow,status,created_at,updated_at) VALUES (?,?,?,?,?,?)").run("task", "existing", "chat", "idle", "now", "now");
    legacy.prepare("INSERT INTO sessions (id,task_id,agent,role,status) VALUES (?,?,?,?,?)").run("session", "task", "claude", "main", "idle");
    legacy.prepare("INSERT INTO events (id,task_id,session_id,seq,type,payload,created_at) VALUES (?,?,?,?,?,?,?)").run("event", "task", "session", 1, "user_message", '{"text":"existing"}', "now");
    legacy.prepare("INSERT INTO queued_messages (id,task_id,event_id,text,created_at) VALUES (?,?,?,?,?)").run("queued", "task", "event", "existing", "now");
    const names = ["tasks", "sessions", "events", "queued_messages", "hosts", "ssh_log"];
    const contents = Object.fromEntries(names.map((name) => [name, legacy.prepare(`SELECT * FROM ${name}`).all()]));
    const schema = legacy.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>;
    legacy.close();

    // Pin this regression to 0006 -> 0007 even after later document migrations are added.
    const fullJournal = JSON.parse(fs.readFileSync(path.join(source, "meta/_journal.json"), "utf8"));
    const documentEntry = fullJournal.entries.find((entry: { idx: number }) => entry.idx === 7);
    fs.copyFileSync(path.join(source, `${documentEntry.tag}.sql`), path.join(folder, `${documentEntry.tag}.sql`));
    journal.entries.push(documentEntry);
    fs.writeFileSync(path.join(folder, "meta/_journal.json"), JSON.stringify(journal));
    const openPr1a = () => {
      const client = new Database(file); client.pragma("foreign_keys = ON"); client.pragma("journal_mode = WAL");
      const value = drizzle(client, { schema: currentSchema });
      migrate(value, { migrationsFolder: folder });
      return value;
    };
    const upgraded = openPr1a(), client = native(upgraded); clients.push(client);
    expect(client.pragma("foreign_keys", { simple: true })).toBe(1);
    for (const name of names) expect(client.prepare(`SELECT * FROM ${name}`).all()).toEqual(contents[name]);
    for (const previous of schema) expect(client.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name=?").get(previous.name)).toEqual(previous);
    const newTables = (client.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>).map((t) => t.name).filter((name) => !schema.some((old) => old.name === name));
    expect(newTables.sort()).toEqual(["document_revisions", "documents"]);
    expect(client.prepare("PRAGMA foreign_key_list(document_revisions)").all()).toHaveLength(2);
    expect(client.prepare("PRAGMA index_list(document_revisions)").all()).toEqual(expect.arrayContaining([expect.objectContaining({ name: "document_revisions_document_number", unique: 1 })]));
    expect(client.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='document_revisions'").all()).toHaveLength(3);
    const documents = new Documents(upgraded), first = documents.create({ title: "Fictional", contentFormat: "plain_text", content: "中文😀\r\n" });
    const restored = documents.restore(first.id, first.currentRevision.id, { expectedRevisionId: first.currentRevision.id }).document;
    const migrationCount = client.prepare("SELECT count(*) AS n FROM __drizzle_migrations").get();
    client.close();

    const reopened = openPr1a(), reopenedClient = native(reopened); clients.push(reopenedClient);
    expect(reopenedClient.prepare("SELECT count(*) AS n FROM __drizzle_migrations").get()).toEqual(migrationCount);
    expect(new Documents(reopened).get(first.id)).toEqual(restored);
    expect(reopenedClient.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(() => reopenedClient.prepare("DELETE FROM document_revisions WHERE id=?").run(first.currentRevision.id)).toThrow(/immutable/);
    expect(() => reopenedClient.prepare("UPDATE document_revisions SET title='changed' WHERE id=?").run(first.currentRevision.id)).toThrow(/immutable/);
    expect(() => reopenedClient.prepare("INSERT OR REPLACE INTO document_revisions (id,document_id,revision_number,title,content_format,content,created_at) VALUES (?,?,?,?,?,?,?)")
      .run(first.currentRevision.id, first.id, 3, "changed", "plain_text", "changed", "now")).toThrow(/duplicate/);
    expect(() => reopenedClient.prepare("INSERT INTO document_revisions (id,document_id,revision_number,title,content_format,content,created_at) VALUES (?,?,?,?,?,?,?)")
      .run(randomUUID(), randomUUID(), 1, "orphan", "plain_text", "", "now")).toThrow(/FOREIGN KEY/);
    for (const name of names) expect(reopenedClient.prepare(`SELECT * FROM ${name}`).all()).toEqual(contents[name]);
  } finally {
    for (const client of clients) if (client.open) client.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("creates the complete schema on an empty database without rebuilding legacy tables", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "document-fresh-migration-"));
  let client: Database.Database | undefined;
  try {
    const db = openDb(path.join(root, "test.db")); client = native(db);
    const documents = new Documents(db);
    expect(documents.create({ title: "Empty", contentFormat: "plain_text", content: "" }).currentRevision.revisionNumber).toBe(1);
    expect(client.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('documents','document_revisions')").all()).toHaveLength(2);
    const journal = JSON.parse(fs.readFileSync(path.join(source, "meta/_journal.json"), "utf8"));
    const migration = fs.readFileSync(path.join(source, `${journal.entries.find((e: { idx: number }) => e.idx === 7).tag}.sql`), "utf8");
    expect(migration).not.toMatch(/(?:ALTER|DROP)\s+TABLE/i);
    expect(migration).not.toMatch(/(?:UPDATE|INSERT\s+INTO|DELETE\s+FROM)\s+[`"]?(?:tasks|sessions|events)\b/i);
    expect(client.prepare("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
  } finally { client?.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
