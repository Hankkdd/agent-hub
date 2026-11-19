import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex, type AnySQLiteColumn } from "drizzle-orm/sqlite-core";

// design.md §6. JSON columns hold shapes defined in @agent-hub/shared.

export const tasks = sqliteTable("tasks", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  workflow: text("workflow").notNull(),
  status: text("status").notNull(),
  activity: text("activity"),
  cwd: text("cwd"),
  workspace: text("workspace", { mode: "json" }),
  options: text("options", { mode: "json" }).notNull().default({}),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  taskId: text("task_id").notNull(),
  agent: text("agent").notNull(),
  role: text("role").notNull(),
  model: text("model"),
  effort: text("effort"),
  sdkThreadId: text("sdk_thread_id"),
  status: text("status").notNull(),
});

export const events = sqliteTable(
  "events",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id").notNull(),
    sessionId: text("session_id"),
    seq: integer("seq").notNull(),
    type: text("type").notNull(),
    payload: text("payload", { mode: "json" }).notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [uniqueIndex("events_task_seq").on(t.taskId, t.seq)],
);

/** Messages sent while a turn was running, waiting to be the next turn's input. */
export const queuedMessages = sqliteTable("queued_messages", {
  id: text("id").primaryKey(),
  taskId: text("task_id").notNull(),
  eventId: text("event_id").notNull(),
  text: text("text").notNull(),
  /** ImageAttachment[]: pictures that travel with this message into the turn. */
  images: text("images", { mode: "json" }).notNull().default([]),
  createdAt: text("created_at").notNull(),
});

/** Devices agents may reach with ssh_exec. */
export const hosts = sqliteTable("hosts", {
  name: text("name").primaryKey(),
  address: text("address").notNull(),
  user: text("user").notNull(),
  port: integer("port").notNull().default(22),
  keyPath: text("key_path").notNull(),
  note: text("note").notNull().default(""),
  prod: integer("prod", { mode: "boolean" }).notNull().default(false),
  shell: text("shell").notNull().default("posix"),
  createdAt: text("created_at").notNull(),
});

/** Every ssh_exec call: the audit trail for commands that run without asking (design.md §7.3). */
export const sshLog = sqliteTable("ssh_log", {
  id: text("id").primaryKey(),
  taskId: text("task_id"),
  host: text("host").notNull(),
  command: text("command").notNull(),
  exitCode: integer("exit_code"),
  output: text("output").notNull(),
  startedAt: text("started_at").notNull(),
  durationMs: integer("duration_ms").notNull(),
});

/** Identity only; the highest revision number is the current document. */
export const documents = sqliteTable("documents", {
  id: text("id").primaryKey().notNull(),
  createdAt: text("created_at").notNull(),
}, (t) => [index("documents_created_at_id").on(t.createdAt, t.id)]);

export const documentRevisions = sqliteTable("document_revisions", {
  id: text("id").primaryKey().notNull(),
  documentId: text("document_id").notNull().references(() => documents.id, { onUpdate: "restrict", onDelete: "restrict" }),
  revisionNumber: integer("revision_number").notNull(),
  title: text("title").notNull(),
  contentFormat: text("content_format", { enum: ["plain_text"] }).notNull(),
  content: text("content").notNull(),
  restoredFromRevisionId: text("restored_from_revision_id").references((): AnySQLiteColumn => documentRevisions.id, { onUpdate: "restrict", onDelete: "restrict" }),
  createdAt: text("created_at").notNull(),
}, (t) => [
  uniqueIndex("document_revisions_document_number").on(t.documentId, t.revisionNumber),
  check("document_revision_number", sql`typeof(${t.revisionNumber}) = 'integer' AND ${t.revisionNumber} BETWEEN 1 AND 9007199254740991`),
  check("document_revision_title", sql`typeof(${t.title}) = 'text' AND length(trim(${t.title})) BETWEEN 1 AND 200 AND instr(${t.title}, char(0)) = 0 AND instr(${t.title}, char(10)) = 0 AND instr(${t.title}, char(13)) = 0`),
  check("document_revision_format", sql`${t.contentFormat} = 'plain_text'`),
  check("document_revision_content", sql`typeof(${t.content}) = 'text' AND length(CAST(${t.content} AS BLOB)) <= 262144 AND instr(${t.content}, char(0)) = 0`),
]);

/** Immutable manual payload and permanent terminal receipt; no retention/purge API. */
export const documentSuggestions = sqliteTable("document_suggestions", {
  id: text("id").primaryKey().notNull(),
  documentId: text("document_id").notNull().references(() => documents.id, { onUpdate: "restrict", onDelete: "restrict" }),
  importRequestId: text("import_request_id").notNull(),
  source: text("source", { enum: ["manual_import", "claude", "codex"] }).notNull(),
  baseRevisionId: text("base_revision_id").notNull().references(() => documentRevisions.id, { onUpdate: "restrict", onDelete: "restrict" }),
  selectionStart: integer("selection_start").notNull(),
  selectionEnd: integer("selection_end").notNull(),
  originalText: text("original_text").notNull(),
  originalSha256: text("original_sha256").notNull(),
  replacementText: text("replacement_text").notNull(),
  status: text("status", { enum: ["pending", "accepted", "rejected"] }).notNull(),
  acceptedRevisionId: text("accepted_revision_id").references(() => documentRevisions.id, { onUpdate: "restrict", onDelete: "restrict" }),
  createdAt: text("created_at").notNull(),
  resolvedAt: text("resolved_at"),
}, (t) => [
  uniqueIndex("document_suggestions_import_identity").on(t.documentId, t.importRequestId),
  uniqueIndex("document_suggestions_accepted_revision").on(t.acceptedRevisionId),
  index("document_suggestions_document_created").on(t.documentId, t.createdAt, t.id),
  check("document_suggestion_source", sql`${t.source} IN ('manual_import','claude','codex')`),
  check("document_suggestion_import_key", sql`length(${t.importRequestId}) BETWEEN 16 AND 96 AND ${t.importRequestId} NOT GLOB '*[^A-Za-z0-9_-]*'`),
  check("document_suggestion_range", sql`typeof(${t.selectionStart}) = 'integer' AND typeof(${t.selectionEnd}) = 'integer' AND ${t.selectionStart} >= 0 AND ${t.selectionEnd} > ${t.selectionStart} AND ${t.selectionEnd} <= 9007199254740991`),
  check("document_suggestion_original", sql`typeof(${t.originalText}) = 'text' AND length(CAST(${t.originalText} AS BLOB)) BETWEEN 1 AND 16384 AND instr(${t.originalText}, char(0)) = 0 AND instr(${t.originalText}, char(13)) = 0`),
  check("document_suggestion_hash", sql`length(${t.originalSha256}) = 64 AND ${t.originalSha256} NOT GLOB '*[^0-9a-f]*'`),
  check("document_suggestion_replacement", sql`typeof(${t.replacementText}) = 'text' AND length(CAST(${t.replacementText} AS BLOB)) <= 65536 AND instr(${t.replacementText}, char(0)) = 0 AND instr(${t.replacementText}, char(13)) = 0`),
  check("document_suggestion_state", sql`(${t.status} = 'pending' AND ${t.acceptedRevisionId} IS NULL AND ${t.resolvedAt} IS NULL) OR (${t.status} = 'accepted' AND ${t.acceptedRevisionId} IS NOT NULL AND ${t.resolvedAt} IS NOT NULL) OR (${t.status} = 'rejected' AND ${t.acceptedRevisionId} IS NULL AND ${t.resolvedAt} IS NOT NULL)`),
]);
