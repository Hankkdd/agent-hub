import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, lt, sql } from "drizzle-orm";
import type { DocumentContent, DocumentDetail, DocumentErrorCode, DocumentList, DocumentRevision, DocumentRevisionList, DocumentWriteResult } from "@agent-hub/shared";
import { SUGGESTION_SELECTION_BYTES, SUGGESTION_REPLACEMENT_BYTES, type SuggestionDetail, type SuggestionMetadata,
  type SuggestionList, type SuggestionImportResult, type SuggestionAcceptResult, type SuggestionRejectResult } from "@agent-hub/shared";
import { schema, type Db } from "../db";

const { documents, documentRevisions: revisions, documentSuggestions: suggestions } = schema;
export const DOCUMENT_CONTENT_BYTES = 256 * 1024;
export const DOCUMENT_BODY_BYTES = 2 * 1024 * 1024;
const errors = {
  invalid_input: [400, "Invalid document input."],
  malformed_json: [400, "Invalid JSON body."],
  invalid_document_id: [400, "Invalid document ID."],
  invalid_revision_id: [400, "Invalid revision ID."],
  invalid_pagination: [400, "Invalid document pagination."],
  unsupported_content_format: [400, "Only plain_text is supported."],
  document_not_found: [404, "Document not found."],
  revision_not_found: [404, "Revision not found."],
  revision_conflict: [409, "Document revision changed. Reload before saving."],
  payload_too_large: [413, "Document payload is too large."],
  unsupported_media_type: [415, "Expected uncompressed UTF-8 application/json."],
  storage_busy: [503, "Document storage is busy. Retry later."],
  storage_error: [500, "Document storage failed."],
  documents_unavailable: [503, "Documents are unavailable."],
  invalid_suggestion_id: [400, "Invalid suggestion ID."],
  invalid_selection: [400, "Invalid UTF-16 selection."],
  lf_required: [400, "Suggestion text must be LF-only."],
  no_change: [400, "The replacement must change the selected text."],
  suggestion_not_found: [404, "Suggestion not found."],
  selection_mismatch: [409, "The selected text does not match the saved revision."],
  import_key_conflict: [409, "Import identity was already used for a different payload."],
  suggestion_rejected: [409, "The suggestion was rejected."],
  suggestion_already_accepted: [409, "The suggestion was already accepted."],
} as const satisfies Record<DocumentErrorCode, readonly [number, string]>;

/** Never carries raw input, a SQL query, parameters or an upstream cause. */
export class DocumentError extends Error {
  readonly status;
  constructor(readonly code: DocumentErrorCode, readonly currentRevisionId?: string) {
    super(errors[code][1]);
    this.status = errors[code][0];
  }
}

export function safeDocumentError(error: unknown): DocumentError {
  if (error instanceof DocumentError) return error;
  // Drizzle wraps the native SQLite error. Inspect only bounded, allowlisted codes.
  let current = error;
  for (let i = 0; i < 5 && current && typeof current === "object"; i++) {
    const value = current as { code?: unknown; cause?: unknown };
    if (typeof value.code === "string" && /^(SQLITE_BUSY|SQLITE_LOCKED)(_|$)/.test(value.code)) return new DocumentError("storage_busy");
    current = value.cause;
  }
  return new DocumentError("storage_error");
}

function safe<T>(action: () => T): T {
  try { return action(); } catch (error) { throw safeDocumentError(error); }
}
function id(value: unknown, code: "invalid_document_id" | "invalid_revision_id" | "invalid_suggestion_id"): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new DocumentError(code);
  return value.toLowerCase();
}
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) throw new DocumentError("invalid_input");
  return value as Record<string, unknown>;
}
function validText(value: unknown): value is string {
  return typeof value === "string" && !value.includes("\0") &&
    !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value);
}
function content(value: Record<string, unknown>): DocumentContent {
  if (!validText(value.title) || !value.title.trim() || value.title.trim().length > 200 || /[\r\n\u2028\u2029]/.test(value.title)) throw new DocumentError("invalid_input");
  if (value.contentFormat !== "plain_text") throw new DocumentError("unsupported_content_format");
  if (!validText(value.content)) throw new DocumentError("invalid_input");
  if (Buffer.byteLength(value.content, "utf8") > DOCUMENT_CONTENT_BYTES) throw new DocumentError("payload_too_large");
  return { title: value.title.trim(), contentFormat: "plain_text", content: value.content };
}
function page(value: string | undefined, fallback: number, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (value === undefined) return fallback;
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new DocumentError("invalid_pagination");
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new DocumentError("invalid_pagination");
  return n;
}
type Store = Pick<Db, "select" | "insert">;
const metadata = { id: revisions.id, documentId: revisions.documentId, revisionNumber: revisions.revisionNumber,
  title: revisions.title, contentFormat: revisions.contentFormat, restoredFromRevisionId: revisions.restoredFromRevisionId, createdAt: revisions.createdAt };
const tip = eq(revisions.id, sql`(SELECT id FROM document_revisions WHERE document_id = ${documents.id} ORDER BY revision_number DESC LIMIT 1)`);

type SuggestionRow = typeof suggestions.$inferSelect;
const suggestionFields = {
  id: suggestions.id, documentId: suggestions.documentId, importRequestId: suggestions.importRequestId,
  source: suggestions.source, baseRevisionId: suggestions.baseRevisionId, baseRevisionNumber: revisions.revisionNumber,
  selection: { startUtf16: suggestions.selectionStart, endUtf16: suggestions.selectionEnd, originalSha256: suggestions.originalSha256 },
  originalUtf8Bytes: sql<number>`length(CAST(${suggestions.originalText} AS BLOB))`,
  replacementUtf8Bytes: sql<number>`length(CAST(${suggestions.replacementText} AS BLOB))`,
  status: suggestions.status, acceptedRevisionId: suggestions.acceptedRevisionId,
  createdAt: suggestions.createdAt, resolvedAt: suggestions.resolvedAt,
};
function importKey(value: unknown): string {
  if (typeof value !== "string" || value.length < 16 || value.length > 96 || /[^A-Za-z0-9_-]/.test(value)) throw new DocumentError("invalid_input");
  return value;
}
function lfText(value: unknown, max: number): string {
  if (!validText(value)) throw new DocumentError("invalid_input");
  if (value.includes("\r")) throw new DocumentError("lf_required");
  if (Buffer.byteLength(value, "utf8") > max) throw new DocumentError("payload_too_large");
  return value;
}
function range(start: unknown, end: unknown): asserts start is number {
  if (typeof start !== "number" || typeof end !== "number" || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start) throw new DocumentError("invalid_selection");
}
function hash(text: string): string { return createHash("sha256").update(text, "utf8").digest("hex"); }
function replaceSelection(revision: DocumentRevision, start: number, end: number, original: string, replacement: string): string {
  const text = lfText(revision.content, DOCUMENT_CONTENT_BYTES);
  range(start, end);
  const splitsPair = (offset: number) => offset > 0 && offset < text.length &&
    /[\uD800-\uDBFF]/.test(text[offset - 1]!) && /[\uDC00-\uDFFF]/.test(text[offset]!);
  if (end > text.length || splitsPair(start) || splitsPair(end)) throw new DocumentError("invalid_selection");
  if (text.slice(start, end) !== original) throw new DocumentError("selection_mismatch");
  if (replacement === original) throw new DocumentError("no_change");
  return lfText(text.slice(0, start) + replacement + text.slice(end), DOCUMENT_CONTENT_BYTES);
}

/** Independent storage domain: no Hub, task, agent, tool, quota or event dependency. */
export class Documents {
  constructor(private readonly db: Db) {}

  create(input: unknown): DocumentDetail {
    return safe(() => {
      const snapshot = content(object(input, ["title", "contentFormat", "content"]));
      const documentId = randomUUID(), createdAt = new Date().toISOString();
      return this.db.transaction((tx) => {
        tx.insert(documents).values({ id: documentId, createdAt }).run();
        tx.insert(revisions).values({ ...snapshot, id: randomUUID(), documentId, revisionNumber: 1, createdAt }).run();
        return this.detail(tx, documentId);
      }, { behavior: "immediate" });
    });
  }

  list(query: { limit?: string; offset?: string } = {}): DocumentList {
    return safe(() => {
      const limit = page(query.limit, 50, 1, 100), offset = page(query.offset, 0, 0);
      const rows = this.db.select({ id: documents.id, createdAt: documents.createdAt,
        title: revisions.title, contentFormat: revisions.contentFormat, currentRevisionId: revisions.id,
        revisionNumber: revisions.revisionNumber, updatedAt: revisions.createdAt }).from(documents)
        .leftJoin(revisions, tip).orderBy(desc(documents.createdAt), desc(documents.id)).limit(limit + 1).offset(offset).all();
      const summaries = rows.slice(0, limit).map((row) => {
        if (row.currentRevisionId === null || row.title === null || row.contentFormat === null || row.revisionNumber === null || row.updatedAt === null) throw new DocumentError("storage_error");
        return { ...row, title: row.title, contentFormat: row.contentFormat, currentRevisionId: row.currentRevisionId, revisionNumber: row.revisionNumber, updatedAt: row.updatedAt };
      });
      return { documents: summaries, nextOffset: rows.length > limit ? offset + limit : null };
    });
  }

  get(documentId: string): DocumentDetail {
    return safe(() => this.detail(this.db, id(documentId, "invalid_document_id")));
  }

  update(documentId: string, input: unknown): DocumentWriteResult {
    return safe(() => {
      const document = id(documentId, "invalid_document_id");
      const value = object(input, ["expectedRevisionId", "title", "contentFormat", "content"]);
      const expected = id(value.expectedRevisionId, "invalid_revision_id"), snapshot = content(value);
      return this.db.transaction((tx) => {
        const current = this.compare(tx, document, expected);
        const previous = current.currentRevision;
        if (snapshot.title === previous.title && snapshot.contentFormat === previous.contentFormat && snapshot.content === previous.content) return { document: current, revisionCreated: false };
        this.append(tx, current, snapshot, null);
        return { document: this.detail(tx, document), revisionCreated: true };
      }, { behavior: "immediate" });
    });
  }

  listRevisions(documentId: string, query: { limit?: string; beforeRevisionNumber?: string } = {}): DocumentRevisionList {
    return safe(() => {
      const document = id(documentId, "invalid_document_id");
      const limit = page(query.limit, 50, 1, 100);
      const before = query.beforeRevisionNumber === undefined ? undefined : page(query.beforeRevisionNumber, 1, 1);
      this.exists(this.db, document);
      const rows = this.db.select(metadata).from(revisions).where(and(eq(revisions.documentId, document), before === undefined ? undefined : lt(revisions.revisionNumber, before)))
        .orderBy(desc(revisions.revisionNumber)).limit(limit + 1).all();
      const items = rows.slice(0, limit);
      return { revisions: items, nextBeforeRevisionNumber: rows.length > limit ? items.at(-1)!.revisionNumber : null };
    });
  }

  getRevision(documentId: string, revisionId: string): DocumentRevision {
    return safe(() => {
      const document = id(documentId, "invalid_document_id"), revision = id(revisionId, "invalid_revision_id");
      this.exists(this.db, document);
      return this.revision(this.db, document, revision);
    });
  }

  restore(documentId: string, revisionId: string, input: unknown): DocumentWriteResult {
    return safe(() => {
      const document = id(documentId, "invalid_document_id"), revision = id(revisionId, "invalid_revision_id");
      const value = object(input, ["expectedRevisionId"]), expected = id(value.expectedRevisionId, "invalid_revision_id");
      return this.db.transaction((tx) => {
        const current = this.compare(tx, document, expected);
        const source = this.revision(tx, document, revision);
        this.append(tx, current, { title: source.title, contentFormat: source.contentFormat, content: source.content }, source.id);
        return { document: this.detail(tx, document), revisionCreated: true };
      }, { behavior: "immediate" });
    });
  }

  validateSelection(documentId: string, input: unknown): import("@agent-hub/shared").RoomSelection {
    return safe(() => {
      const value = object(input, ["baseRevisionId", "startUtf16", "endUtf16", "originalText"]);
      const baseRevisionId = id(value.baseRevisionId, "invalid_revision_id");
      range(value.startUtf16, value.endUtf16);
      const originalText = lfText(value.originalText, SUGGESTION_SELECTION_BYTES);
      if (!originalText) throw new DocumentError("invalid_selection");
      const revision = this.getRevision(documentId, baseRevisionId);
      replaceSelection(revision, value.startUtf16, value.endUtf16 as number, originalText, "");
      return { baseRevisionId, startUtf16: value.startUtf16, endUtf16: value.endUtf16 as number, originalText };
    });
  }

  importSuggestion(documentId: string, input: unknown): SuggestionImportResult {
    return safe(() => {
      const document = id(documentId, "invalid_document_id");
      const value = object(input, ["importRequestId", "source", "baseRevisionId", "selection", "replacementText"]);
      const key = importKey(value.importRequestId), base = id(value.baseRevisionId, "invalid_revision_id");
      if (value.source !== "manual_import" && value.source !== "claude" && value.source !== "codex") throw new DocumentError("invalid_input");
      const source = value.source;
      const selection = object(value.selection, ["startUtf16", "endUtf16", "originalText"]);
      range(selection.startUtf16, selection.endUtf16);
      const start = selection.startUtf16, end = selection.endUtf16 as number;
      const original = lfText(selection.originalText, SUGGESTION_SELECTION_BYTES);
      const replacement = lfText(value.replacementText, SUGGESTION_REPLACEMENT_BYTES);
      if (!original) throw new DocumentError("invalid_selection");
      return this.db.transaction((tx) => {
        this.exists(tx, document);
        const previous = tx.select().from(suggestions).where(and(eq(suggestions.documentId, document), eq(suggestions.importRequestId, key))).get();
        if (previous) {
          if (previous.baseRevisionId !== base || previous.selectionStart !== start || previous.selectionEnd !== end ||
            previous.originalText !== original || previous.replacementText !== replacement || previous.source !== value.source) throw new DocumentError("import_key_conflict");
          return { suggestion: this.suggestionDetail(tx, document, previous.id), replayed: true };
        }
        const current = this.compare(tx, document, base);
        replaceSelection(current.currentRevision, start, end, original, replacement);
        const suggestionId = randomUUID();
        tx.insert(suggestions).values({ id: suggestionId, documentId: document, importRequestId: key, source, baseRevisionId: base,
          selectionStart: start, selectionEnd: end, originalText: original, originalSha256: hash(original), replacementText: replacement,
          status: "pending", acceptedRevisionId: null, createdAt: new Date().toISOString(), resolvedAt: null }).run();
        return { suggestion: this.suggestionDetail(tx, document, suggestionId), replayed: false };
      }, { behavior: "immediate" });
    });
  }

  listSuggestions(documentId: string, query: { limit?: string; offset?: string; status?: string; importRequestId?: string } = {}): SuggestionList {
    return safe(() => {
      const document = id(documentId, "invalid_document_id");
      const limit = page(query.limit, 50, 1, 100), offset = page(query.offset, 0, 0);
      const status = query.status;
      if (status !== undefined && status !== "pending" && status !== "accepted" && status !== "rejected") throw new DocumentError("invalid_input");
      const key = query.importRequestId === undefined ? undefined : importKey(query.importRequestId);
      this.exists(this.db, document);
      const rows = this.db.select(suggestionFields).from(suggestions).innerJoin(revisions, and(eq(revisions.id, suggestions.baseRevisionId), eq(revisions.documentId, suggestions.documentId)))
        .where(and(eq(suggestions.documentId, document), status === undefined ? undefined : eq(suggestions.status, status), key === undefined ? undefined : eq(suggestions.importRequestId, key)))
        .orderBy(desc(suggestions.createdAt), desc(suggestions.id)).limit(limit + 1).offset(offset).all();
      return { suggestions: rows.slice(0, limit), nextOffset: rows.length > limit ? offset + limit : null };
    });
  }

  getSuggestion(documentId: string, suggestionId: string): SuggestionDetail {
    return safe(() => {
      const document = id(documentId, "invalid_document_id"), suggestion = id(suggestionId, "invalid_suggestion_id");
      this.exists(this.db, document);
      return this.suggestionDetail(this.db, document, suggestion);
    });
  }

  acceptSuggestion(documentId: string, suggestionId: string, input: unknown): SuggestionAcceptResult {
    return safe(() => {
      const document = id(documentId, "invalid_document_id"), suggestion = id(suggestionId, "invalid_suggestion_id");
      const expected = id(object(input, ["expectedRevisionId"]).expectedRevisionId, "invalid_revision_id");
      return this.db.transaction((tx) => {
        this.exists(tx, document);
        const row = this.suggestionRow(tx, document, suggestion);
        if (expected !== row.baseRevisionId) throw new DocumentError("revision_conflict");
        if (row.status === "rejected") throw new DocumentError("suggestion_rejected");
        const replayed = row.status === "accepted";
        if (!replayed) {
          const current = this.compare(tx, document, expected);
          const original = lfText(row.originalText, SUGGESTION_SELECTION_BYTES), replacement = lfText(row.replacementText, SUGGESTION_REPLACEMENT_BYTES);
          const next = replaceSelection(current.currentRevision, row.selectionStart, row.selectionEnd, original, replacement);
          if (hash(current.currentRevision.content.slice(row.selectionStart, row.selectionEnd)) !== row.originalSha256) throw new DocumentError("selection_mismatch");
          const revisionId = this.append(tx, current, { title: current.currentRevision.title, contentFormat: "plain_text", content: next }, null);
          const updated = tx.update(suggestions).set({ status: "accepted", acceptedRevisionId: revisionId, resolvedAt: new Date().toISOString() })
            .where(and(eq(suggestions.documentId, document), eq(suggestions.id, suggestion), eq(suggestions.status, "pending"))).run();
          if (updated.changes !== 1) throw new DocumentError("storage_error");
        }
        const result = this.suggestionDetail(tx, document, suggestion);
        if (!result.acceptedRevisionId) throw new DocumentError("storage_error");
        const accepted = this.revision(tx, document, result.acceptedRevisionId);
        return { suggestion: this.withoutSuggestionText(result), acceptedRevisionId: accepted.id, acceptedRevisionNumber: accepted.revisionNumber,
          replayed, document: this.detail(tx, document) };
      }, { behavior: "immediate" });
    });
  }

  rejectSuggestion(documentId: string, suggestionId: string, input: unknown): SuggestionRejectResult {
    return safe(() => {
      const document = id(documentId, "invalid_document_id"), suggestion = id(suggestionId, "invalid_suggestion_id");
      object(input, []);
      return this.db.transaction((tx) => {
        this.exists(tx, document);
        const row = this.suggestionRow(tx, document, suggestion);
        if (row.status === "accepted") throw new DocumentError("suggestion_already_accepted");
        const replayed = row.status === "rejected";
        if (!replayed) {
          const result = tx.update(suggestions).set({ status: "rejected", resolvedAt: new Date().toISOString() })
            .where(and(eq(suggestions.documentId, document), eq(suggestions.id, suggestion), eq(suggestions.status, "pending"))).run();
          if (result.changes !== 1) throw new DocumentError("storage_error");
        }
        return { suggestion: this.withoutSuggestionText(this.suggestionDetail(tx, document, suggestion)), replayed };
      }, { behavior: "immediate" });
    });
  }

  private suggestionRow(store: Store, documentId: string, suggestionId: string): SuggestionRow {
    const row = store.select().from(suggestions).where(and(eq(suggestions.documentId, documentId), eq(suggestions.id, suggestionId))).get();
    if (!row) throw new DocumentError("suggestion_not_found");
    return row;
  }
  private suggestionDetail(store: Store, documentId: string, suggestionId: string): SuggestionDetail {
    const row = store.select({ ...suggestionFields, originalText: suggestions.originalText, replacementText: suggestions.replacementText })
      .from(suggestions).innerJoin(revisions, and(eq(revisions.id, suggestions.baseRevisionId), eq(revisions.documentId, suggestions.documentId)))
      .where(and(eq(suggestions.documentId, documentId), eq(suggestions.id, suggestionId))).get();
    if (!row) throw new DocumentError("suggestion_not_found");
    return row;
  }
  private withoutSuggestionText(detail: SuggestionDetail): SuggestionMetadata {
    const { originalText: _original, replacementText: _replacement, ...metadata } = detail;
    return metadata;
  }

  private exists(store: Store, documentId: string): void {
    if (!store.select({ id: documents.id }).from(documents).where(eq(documents.id, documentId)).get()) throw new DocumentError("document_not_found");
  }
  private detail(store: Store, documentId: string): DocumentDetail {
    const row = store.select({ document: documents, revision: revisions }).from(documents).leftJoin(revisions, tip).where(eq(documents.id, documentId)).get();
    if (!row) throw new DocumentError("document_not_found");
    if (!row.revision) throw new DocumentError("storage_error");
    return { ...row.document, updatedAt: row.revision.createdAt, currentRevision: row.revision };
  }
  private revision(store: Store, documentId: string, revisionId: string): DocumentRevision {
    const row = store.select().from(revisions).where(and(eq(revisions.documentId, documentId), eq(revisions.id, revisionId))).get();
    if (!row) throw new DocumentError("revision_not_found");
    return row;
  }
  private compare(store: Store, documentId: string, expected: string): DocumentDetail {
    const current = this.detail(store, documentId);
    if (current.currentRevision.id !== expected) throw new DocumentError("revision_conflict", current.currentRevision.id);
    return current;
  }
  private append(store: Store, current: DocumentDetail, snapshot: DocumentContent, source: string | null): string {
    const revisionId = randomUUID();
    store.insert(revisions).values({ ...snapshot, id: revisionId, documentId: current.id,
      revisionNumber: current.currentRevision.revisionNumber + 1, restoredFromRevisionId: source, createdAt: new Date().toISOString() }).run();
    return revisionId;
  }
}
