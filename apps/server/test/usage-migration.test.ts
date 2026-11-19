import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { expect, it } from "vitest";
import { openDb, schema } from "../src/db";

it("migrates legacy events without accounting/backfill and enforces lifecycle identity after reopening SQLite", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "usage-migration-"));
  const file = path.join(root, "hub.db"), folder = path.join(root, "legacy");
  fs.mkdirSync(path.join(folder, "meta"), { recursive: true });
  const source = path.resolve("drizzle");
  const journal = JSON.parse(fs.readFileSync(path.join(source, "meta/_journal.json"), "utf8"));
  journal.entries = journal.entries.filter((e: { idx: number }) => e.idx < 6);
  for (const entry of journal.entries) fs.copyFileSync(path.join(source, `${entry.tag}.sql`), path.join(folder, `${entry.tag}.sql`));
  fs.writeFileSync(path.join(folder, "meta/_journal.json"), JSON.stringify(journal));
  const legacy = new Database(file);
  try {
    migrate(drizzle(legacy), { migrationsFolder: folder });
    legacy.prepare("INSERT INTO events (id,task_id,seq,type,payload,created_at) VALUES (?,?,?,?,?,?)").run("legacy", "task", 1, "turn_result", JSON.stringify({ costUsd: 7 }), "now");
  } finally { legacy.close(); }
  try {
    const db = openDb(file);
    expect(db.select().from(schema.events).all()).toMatchObject([{ id: "legacy", payload: { costUsd: 7 } }]);
    const row = { id: "start", taskId: "task", sessionId: null, seq: 2, type: "invocation_started", payload: { callId: "stable" }, createdAt: "now" };
    db.insert(schema.events).values(row).run();
    const restarted = openDb(file);
    expect(() => restarted.insert(schema.events).values({ ...row, id: "duplicate", seq: 3 }).run()).toThrow(/UNIQUE/);
    restarted.insert(schema.events).values({ ...row, id: "final", seq: 3, type: "invocation_finished" }).run();
    expect(() => db.insert(schema.events).values({ ...row, id: "duplicate-final", seq: 4, type: "invocation_finished" }).run()).toThrow(/UNIQUE/);
    expect(db.select().from(schema.events).all()).toHaveLength(3);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
