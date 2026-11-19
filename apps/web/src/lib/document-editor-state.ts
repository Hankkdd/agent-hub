import type { DocumentContent, DocumentDetail } from "@agent-hub/shared";
import { createDocumentTextDraft, confirmDocumentLfConversion, documentTitleError, lfDocumentContentError,
  projectDocumentText, updateDocumentTextDraft, documentTextSelection, type DocumentTextDraft } from "./document-text";

export interface DocumentSelection {
  documentId: string; baseRevisionId: string; revisionId: string | null; draftVersion: number;
  start: number; end: number; text: string; source: "saved" | "draft";
}
export interface EditorSession {
  base: DocumentDetail;
  textBase: DocumentTextDraft;
  // Raw DOM input is authoritative even when invalid or temporarily incomplete during composition.
  rawInput: string;
  title: string;
  editVersion: number;
  composing: boolean;
  selection: DocumentSelection | null;
  phase: "idle" | "saving" | "saved" | "error" | "conflict";
  unknownOutcome: boolean;
  conflictRevisionId?: string;
}
export function createEditorSession(base: DocumentDetail): EditorSession {
  const revision = base?.currentRevision;
  if (!base?.id || revision?.documentId !== base.id || !revision.id || revision.contentFormat !== "plain_text" || documentTitleError(revision.title)) throw new Error("Invalid document response");
  return { base, textBase: createDocumentTextDraft(revision.content), rawInput: projectDocumentText(revision.content),
    title: revision.title, editVersion: 0, composing: false, selection: null, phase: "idle", unknownOutcome: false };
}
export function editorContent(s: EditorSession): string { return s.textBase.conversion === "required" ? s.textBase.content : s.rawInput; }
export function editorDirty(s: EditorSession): boolean { return s.title.trim() !== s.base.currentRevision.title || editorContent(s) !== s.base.currentRevision.content; }
export function editorValidation(s: EditorSession): string | null {
  return s.composing ? "composing" : documentTitleError(s.title) ?? (s.textBase.conversion === "required" ? null : lfDocumentContentError(s.rawInput));
}
export function editorCandidate(s: EditorSession): DocumentContent {
  if (editorValidation(s)) throw new Error("Invalid document candidate");
  return { title: s.title.trim(), contentFormat: "plain_text", content: s.textBase.conversion === "required" ? s.textBase.content : updateDocumentTextDraft(s.textBase, s.rawInput).content };
}
export function editorInput(s: EditorSession, rawInput: string): EditorSession {
  return s.textBase.conversion === "required" ? s : { ...s, rawInput, editVersion: s.editVersion + 1, selection: null };
}
export function editorConvert(s: EditorSession): EditorSession {
  const textBase = confirmDocumentLfConversion(s.textBase, true);
  return { ...s, textBase, rawInput: textBase.content, editVersion: s.editVersion + 1, selection: null };
}
/** Rebase against the acknowledged snapshot, never the pre-save non-LF original. */
export function acknowledgeSave(current: EditorSession, submitted: EditorSession, base: DocumentDetail): EditorSession {
  const fresh = createEditorSession(base);
  if (base.id !== current.base.id) throw new Error("Invalid document response");
  return { ...fresh, rawInput: current.rawInput, title: current.title === submitted.title ? fresh.title : current.title,
    editVersion: current.editVersion, composing: current.composing, phase: "saved" };
}
export function editorSelection(s: EditorSession, start: number, end: number): DocumentSelection | null {
  if (s.composing || s.textBase.conversion === "required" || editorValidation(s)) return null;
  try {
    const range = documentTextSelection(updateDocumentTextDraft(s.textBase, s.rawInput), start, end);
    return range ? { ...range, documentId: s.base.id, baseRevisionId: s.base.currentRevision.id,
      revisionId: editorDirty(s) ? null : s.base.currentRevision.id, draftVersion: s.editVersion, source: editorDirty(s) ? "draft" : "saved" } : null;
  } catch { return null; }
}
