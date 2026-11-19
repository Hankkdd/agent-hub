/** Child-process fixture: production Documents methods, fictional data and a parent-owned temp DB. */
import type Database from "better-sqlite3";
import { Documents, DocumentError } from "../../src/core/documents";
import { openDb, type Db } from "../../src/db";

const db = openDb(process.argv[2]!);
const native = (db as Db & { $client: Database.Database }).$client;
native.pragma("busy_timeout = 5000");
const service = new Documents(db);
process.once("message", (operation: { kind: string; documentId: string; suggestionId: string; base: string; payload: unknown }) => {
  process.send!({ type: "attempt" });
  try {
    let result: { receipt?: string; replayed?: boolean; suggestionId?: string } = {};
    if (operation.kind === "accept") {
      const accepted = service.acceptSuggestion(operation.documentId, operation.suggestionId, { expectedRevisionId: operation.base });
      result = { receipt: accepted.acceptedRevisionId, replayed: accepted.replayed };
    } else if (operation.kind === "reject") {
      service.rejectSuggestion(operation.documentId, operation.suggestionId, {});
    } else if (operation.kind === "restore") {
      service.restore(operation.documentId, operation.base, { expectedRevisionId: operation.base });
    } else if (operation.kind === "import") {
      const imported = service.importSuggestion(operation.documentId, operation.payload);
      result = { suggestionId: imported.suggestion.id, replayed: imported.replayed };
    } else {
      service.update(operation.documentId, { title: "Fictional race", contentFormat: "plain_text", content: "fictional competing save", expectedRevisionId: operation.base });
    }
    process.send!({ type: "result", outcome: { status: 200, ...result } });
  } catch (error) {
    if (!(error instanceof DocumentError)) throw error;
    process.send!({ type: "result", outcome: { status: error.status, code: error.code } });
  } finally { native.close(); process.disconnect(); }
});
process.send!({ type: "ready" });
