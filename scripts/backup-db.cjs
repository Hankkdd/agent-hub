// Resolve the native dependency from production's existing install before changing its checkout.
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");

const [prod, data, sha] = process.argv.slice(2);
const Database = createRequire(path.join(prod, "apps/server/package.json"))("better-sqlite3");
const backups = path.join(data, "backups");
const timestamp = new Date().toISOString().replace(/[-:]/g, "");
const destination = path.join(backups, `agent-hub-${timestamp}-${sha}.db`);
fs.mkdirSync(backups, { recursive: true, mode: 0o700 });
const db = new Database(path.join(data, "agent-hub.db"), { fileMustExist: true });
try {
  db.prepare("VACUUM INTO ?").run(destination);
  fs.chmodSync(destination, 0o600);
} catch (error) {
  fs.rmSync(destination, { force: true });
  throw error;
} finally {
  db.close();
}

// Only prune our own completed database backups, after a new one succeeds.
const files = fs.readdirSync(backups)
  .filter(name => /^agent-hub-\d{8}T\d{6}\.\d{3}Z-[a-f0-9]+\.db$/.test(name))
  .sort().reverse();
for (const file of files.slice(10)) fs.unlinkSync(path.join(backups, file));
console.log(`Database backup: ${destination}`);
