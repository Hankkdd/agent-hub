import type { SuggestionErrorCode } from "./document-suggestions";

export interface DocumentContent {
  title: string;
  contentFormat: "plain_text";
  content: string;
}

export interface DocumentRevision extends DocumentContent {
  id: string;
  documentId: string;
  revisionNumber: number;
  restoredFromRevisionId: string | null;
  createdAt: string;
}

export type DocumentRevisionMetadata = Omit<DocumentRevision, "content">;
export interface DocumentDetail {
  id: string;
  createdAt: string;
  updatedAt: string;
  currentRevision: DocumentRevision;
}
export interface DocumentSummary {
  id: string;
  title: string;
  contentFormat: "plain_text";
  currentRevisionId: string;
  revisionNumber: number;
  createdAt: string;
  updatedAt: string;
}
export type CreateDocumentInput = DocumentContent;
export interface UpdateDocumentInput extends DocumentContent { expectedRevisionId: string }
export interface RestoreDocumentInput { expectedRevisionId: string }
export interface DocumentWriteResult { document: DocumentDetail; revisionCreated: boolean }
export interface DocumentList { documents: DocumentSummary[]; nextOffset: number | null }
export interface DocumentRevisionList { revisions: DocumentRevisionMetadata[]; nextBeforeRevisionNumber: number | null }
export type DocumentErrorCode = SuggestionErrorCode | "invalid_input" | "malformed_json" | "invalid_document_id" |
  "invalid_revision_id" | "invalid_pagination" | "unsupported_content_format" |
  "document_not_found" | "revision_not_found" | "revision_conflict" |
  "payload_too_large" | "unsupported_media_type" | "storage_busy" | "storage_error" | "documents_unavailable";
export interface DocumentErrorResponse { error: string; code: DocumentErrorCode; currentRevisionId?: string }
