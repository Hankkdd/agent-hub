export const DOCUMENT_CONTENT_BYTES = 256 * 1024;

export type DocumentTextErrorCode = "invalid_text" | "invalid_unicode" | "nul_character" |
  "content_too_large" | "invalid_title" | "invalid_offset" | "invalid_range" |
  "lf_required" | "conversion_confirmation_required" | "conversion_required" | "invalid_draft";

/** Only fixed codes belong in errors: a caller may log an Error without leaking the document. */
export class DocumentTextError extends Error {
  constructor(readonly code: DocumentTextErrorCode) {
    super(`Document text validation failed: ${code}`);
  }
}

function textError(value: unknown): DocumentTextErrorCode | null {
  if (typeof value !== "string") return "invalid_text";
  if (value.includes("\0")) return "nul_character";
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value)) return "invalid_unicode";
  return null;
}

function assertText(value: string): void {
  const error = textError(value);
  if (error) throw new DocumentTextError(error);
}

export function documentContentError(value: unknown): DocumentTextErrorCode | null {
  const error = textError(value);
  if (error) return error;
  return new TextEncoder().encode(value as string).byteLength > DOCUMENT_CONTENT_BYTES ? "content_too_large" : null;
}

export function documentTitleError(value: unknown): DocumentTextErrorCode | null {
  const error = textError(value);
  if (error) return error;
  const title = value as string;
  return !title.trim() || title.trim().length > 200 || /[\r\n\u2028\u2029]/.test(title) ? "invalid_title" : null;
}

export function hasDocumentCarriageReturn(content: string): boolean {
  return content.includes("\r");
}

/** Read-only projection. Never use this as a save value for an unconverted document. */
export function projectDocumentText(canonical: string): string {
  assertText(canonical);
  return canonical.replace(/\r\n?/g, "\n");
}

export function lfDocumentContentError(value: unknown): DocumentTextErrorCode | null {
  const error = documentContentError(value);
  if (error) return error;
  return hasDocumentCarriageReturn(value as string) ? "lf_required" : null;
}

/** Local body state only, not a revision or an HTTP write. The source snapshot never changes. */
export interface DocumentTextDraft {
  readonly originalCanonical: string;
  readonly content: string;
  readonly conversion: "not_required" | "required" | "confirmed";
}

function assertContent(content: string): void {
  const error = documentContentError(content);
  if (error) throw new DocumentTextError(error);
}

function assertDraft(draft: DocumentTextDraft): void {
  assertContent(draft.originalCanonical);
  assertContent(draft.content);
  const sourceHasCr = hasDocumentCarriageReturn(draft.originalCanonical);
  if (draft.conversion === "required") {
    if (!sourceHasCr || draft.content !== draft.originalCanonical) throw new DocumentTextError("invalid_draft");
  } else {
    if ((draft.conversion !== "not_required" && draft.conversion !== "confirmed") ||
      sourceHasCr !== (draft.conversion === "confirmed")) throw new DocumentTextError("invalid_draft");
    if (hasDocumentCarriageReturn(draft.content)) throw new DocumentTextError("lf_required");
  }
}

function assertEditable(draft: DocumentTextDraft): void {
  assertDraft(draft);
  if (draft.conversion === "required") throw new DocumentTextError("conversion_required");
}

/** Load existing canonical content without conversion, so a display projection cannot make it dirty. */
export function createDocumentTextDraft(originalCanonical: string): DocumentTextDraft {
  assertContent(originalCanonical);
  return Object.freeze({ originalCanonical, content: originalCanonical,
    conversion: hasDocumentCarriageReturn(originalCanonical) ? "required" : "not_required" });
}

/** New document bodies must already be LF-only. Reject CR rather than silently normalizing it. */
export function createLfDocumentTextDraft(content = ""): DocumentTextDraft {
  const error = lfDocumentContentError(content);
  if (error) throw new DocumentTextError(error);
  return createDocumentTextDraft(content);
}

/** The future caller must obtain explicit user confirmation; this function performs no persistence. */
export function confirmDocumentLfConversion(draft: DocumentTextDraft, confirmed: boolean): DocumentTextDraft {
  assertDraft(draft);
  if (confirmed !== true) throw new DocumentTextError("conversion_confirmation_required");
  if (draft.conversion !== "required") return draft;
  return Object.freeze({ ...draft, content: projectDocumentText(draft.content), conversion: "confirmed" });
}

/** Assign the complete native textarea value verbatim. No diff, range splice or EOL reconstruction. */
export function updateDocumentTextDraft(draft: DocumentTextDraft, content: string): DocumentTextDraft {
  assertEditable(draft);
  const error = lfDocumentContentError(content);
  if (error) throw new DocumentTextError(error);
  return Object.freeze({ ...draft, content });
}

export function discardDocumentTextDraft(draft: DocumentTextDraft): DocumentTextDraft {
  assertDraft(draft);
  return createDocumentTextDraft(draft.originalCanonical);
}

export function documentTextDraftIsDirty(draft: DocumentTextDraft): boolean {
  assertDraft(draft);
  return draft.content !== draft.originalCanonical;
}

function assertOffset(text: string, offset: number): void {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length ||
    (offset > 0 && offset < text.length && /[\uD800-\uDBFF]/.test(text[offset - 1]!) && /[\uDC00-\uDFFF]/.test(text[offset]!))) {
    throw new DocumentTextError("invalid_offset");
  }
}

export interface DocumentTextSelection { start: number; end: number; text: string }

/** Selection is available only in an editable LF draft, whose display and canonical offsets coincide. */
export function documentTextSelection(draft: DocumentTextDraft, start: number, end: number): DocumentTextSelection | null {
  assertEditable(draft);
  assertOffset(draft.content, start);
  assertOffset(draft.content, end);
  if (end < start) throw new DocumentTextError("invalid_range");
  return start === end ? null : { start, end, text: draft.content.slice(start, end) };
}

export function documentTextStats(canonical: string): { englishWords: number; unicodeCharacters: number; utf8Bytes: number } {
  const display = projectDocumentText(canonical);
  return {
    englishWords: display.match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g)?.length ?? 0,
    unicodeCharacters: Array.from(display).length,
    utf8Bytes: new TextEncoder().encode(canonical).byteLength,
  };
}
