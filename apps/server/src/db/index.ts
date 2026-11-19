import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema";

export type Db = BetterSQLite3Database<typeof schema>;

const MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../drizzle");

/** Open (or create) the database and bring it to the current schema. `:memory:` for tests. */
export function openDb(file: string): Db {
  const sqlite = new Database(file);
  sqlite.pragma("foreign_keys = ON");
  if (sqlite.pragma("foreign_keys", { simple: true }) !== 1) {
    sqlite.close();
    throw new Error("SQLite foreign keys are required");
  }
  sqlite.pragma("journal_mode = WAL");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: MIGRATIONS });
  return db;
}

export { schema };
