import type { SuggestionSource } from "./room";
import type { DocumentDetail } from "./documents";

export const SUGGESTION_SELECTION_BYTES = 16 * 1024;
export const SUGGESTION_REPLACEMENT_BYTES = 64 * 1024;
export type SuggestionStatus = "pending" | "accepted" | "rejected";
export interface SuggestionSelection { startUtf16: number; endUtf16: number; originalText: string }
export interface ImportSuggestionInput {
  importRequestId: string;
  source: SuggestionSource;
  baseRevisionId: string;
  selection: SuggestionSelection;
  replacementText: string;
}
export interface SuggestionMetadata {
  id: string;
  documentId: string;
  importRequestId: string;
  source: SuggestionSource;
  baseRevisionId: string;
  baseRevisionNumber: number;
  selection: { startUtf16: number; endUtf16: number; originalSha256: string };
  originalUtf8Bytes: number;
  replacementUtf8Bytes: number;
  status: SuggestionStatus;
  acceptedRevisionId: string | null;
  createdAt: string;
  resolvedAt: string | null;
}
export interface SuggestionDetail extends SuggestionMetadata { originalText: string; replacementText: string }
export interface SuggestionList { suggestions: SuggestionMetadata[]; nextOffset: number | null }
export interface SuggestionImportResult { suggestion: SuggestionDetail; replayed: boolean }
export interface AcceptSuggestionInput { expectedRevisionId: string }
export type RejectSuggestionInput = Record<string, never>;
export interface SuggestionRejectResult { suggestion: SuggestionMetadata; replayed: boolean }
export interface SuggestionAcceptResult {
  suggestion: SuggestionMetadata;
  acceptedRevisionId: string;
  acceptedRevisionNumber: number;
  replayed: boolean;
  /** Actual tip read in the transaction; it can be newer than the accepted receipt. */
  document: DocumentDetail;
}
export type SuggestionErrorCode = "invalid_suggestion_id" | "invalid_selection" | "lf_required" |
  "no_change" | "suggestion_not_found" | "selection_mismatch" | "import_key_conflict" |
  "suggestion_rejected" | "suggestion_already_accepted";
