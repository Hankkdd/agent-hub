import { describe, expect, it, vi } from "vitest";
import * as documentText from "./document-text";
import {
  confirmDocumentLfConversion, createDocumentTextDraft, createLfDocumentTextDraft,
  discardDocumentTextDraft, documentContentError, documentTextDraftIsDirty, documentTextSelection,
  documentTextStats, documentTitleError, DocumentTextError, hasDocumentCarriageReturn,
  lfDocumentContentError, projectDocumentText, updateDocumentTextDraft,
  DOCUMENT_CONTENT_BYTES, type DocumentTextDraft, type DocumentTextErrorCode,
} from "./document-text";

const emoji = "\u{1f600}";
const legacyBodies = ["a\r\nb\r\n", "a\rb\r", "a\r\nb\rc\n", "A\r\n\rB", "A\rX\nB"];
function fails(action: () => unknown, code: DocumentTextErrorCode) {
  let failure: unknown;
  try { action(); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(DocumentTextError);
  expect((failure as DocumentTextError).code).toBe(code);
}

// The body state remains separate from title state and from the future API input.
describe("explicit LF document drafts", () => {
  it.each(["", "plain text", "a\nb\n", `中文 ${emoji}\n`])("loads LF-only text directly as editable: %j", (content) => {
    const draft = createDocumentTextDraft(content);
    expect(hasDocumentCarriageReturn(content)).toBe(false);
    expect(draft.conversion).toBe("not_required");
    expect(draft.content).toBe(content);
    expect(projectDocumentText(draft.content)).toBe(draft.content);
    expect(documentTextDraftIsDirty(draft)).toBe(false);
    const next = updateDocumentTextDraft(draft, content + "new\n");
    expect(next.content).toBe(content + "new\n");
    expect(documentTextDraftIsDirty(next)).toBe(true);
    expect(draft.content).toBe(content);
  });

  it.each(legacyBodies)("retains non-LF canonical text and requires confirmation: %j", (canonical) => {
    const draft = createDocumentTextDraft(canonical);
    expect(hasDocumentCarriageReturn(canonical)).toBe(true);
    expect(draft).toEqual({ originalCanonical: canonical, content: canonical, conversion: "required" });
    expect(projectDocumentText(draft.content)).not.toContain("\r");
    expect(documentTextDraftIsDirty(draft)).toBe(false);
    expect(Object.isFrozen(draft)).toBe(true);
    fails(() => updateDocumentTextDraft(draft, projectDocumentText(canonical)), "conversion_required");
    fails(() => updateDocumentTextDraft(draft, canonical), "conversion_required");
    fails(() => documentTextSelection(draft, 0, 1), "conversion_required");
    fails(() => confirmDocumentLfConversion(draft, false), "conversion_confirmation_required");
    expect(draft.content).toBe(canonical);
    expect(documentTextDraftIsDirty(draft)).toBe(false);
  });

  it.each(legacyBodies)("preserves original body bytes when only the title changes: %j", (canonical) => {
    const form = { title: "Old", body: createDocumentTextDraft(canonical) };
    const renamed = { ...form, title: "New" };
    expect(renamed.body).toBe(form.body);
    expect(new TextEncoder().encode(renamed.body.content)).toEqual(new TextEncoder().encode(canonical));
    expect(renamed.body.conversion).toBe("required");
    expect(documentTextDraftIsDirty(renamed.body)).toBe(false);
  });

  it.each(legacyBodies)("converts only an explicitly confirmed local draft: %j", (canonical) => {
    const original = createDocumentTextDraft(canonical);
    const converted = confirmDocumentLfConversion(original, true);
    expect(converted.conversion).toBe("confirmed");
    expect(converted.originalCanonical).toBe(canonical);
    expect(converted.content).toBe(projectDocumentText(canonical));
    expect(lfDocumentContentError(converted.content)).toBeNull();
    expect(projectDocumentText(converted.content)).toBe(projectDocumentText(original.content));
    expect(documentTextDraftIsDirty(converted)).toBe(true);
    expect(original.content).toBe(canonical);
    expect(original.conversion).toBe("required");
    expect(documentTextDraftIsDirty(original)).toBe(false);
    expect(Object.isFrozen(converted)).toBe(true);
    expect(confirmDocumentLfConversion(converted, true)).toBe(converted);
  });

  it("requires literal true rather than truthy values for confirmation", () => {
    const draft = createDocumentTextDraft("a\r\nb");
    for (const value of [false, undefined, null, 1, "true", {}]) {
      fails(() => confirmDocumentLfConversion(draft, value as boolean), "conversion_confirmation_required");
    }
  });

  it("creates new LF drafts without converting non-LF inputs", () => {
    expect(createLfDocumentTextDraft().content).toBe("");
    expect(createLfDocumentTextDraft("a\nb").conversion).toBe("not_required");
    for (const content of legacyBodies) {
      expect(lfDocumentContentError(content)).toBe("lf_required");
      fails(() => createLfDocumentTextDraft(content), "lf_required");
    }
  });

  it("performs conversion without HTTP, browser storage, or DOM access", () => {
    const unexpected = vi.fn(() => { throw new Error("Unexpected external effect"); });
    const storage = { getItem: unexpected, setItem: unexpected, removeItem: unexpected };
    vi.stubGlobal("fetch", unexpected);
    vi.stubGlobal("XMLHttpRequest", unexpected);
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal("sessionStorage", storage);
    vi.stubGlobal("indexedDB", { open: unexpected });
    vi.stubGlobal("window", new Proxy({}, { get: unexpected }));
    vi.stubGlobal("document", new Proxy({}, { get: unexpected }));
    try {
      const before = createDocumentTextDraft("fictional\r\nbody");
      const after = confirmDocumentLfConversion(before, true);
      expect(after.content).toBe("fictional\nbody");
      expect(before.content).toBe("fictional\r\nbody");
      expect(unexpected).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });

  it.each(legacyBodies)("discards conversion and edits back to original readonly content: %j", (canonical) => {
    const original = createDocumentTextDraft(canonical);
    const converted = confirmDocumentLfConversion(original, true);
    expect(discardDocumentTextDraft(converted)).toEqual(original);
    const edited = updateDocumentTextDraft(converted, "a completely new draft\n");
    expect(discardDocumentTextDraft(edited)).toEqual(original);
    expect(edited.originalCanonical).toBe(canonical);
    expect(original.content).toBe(canonical);
  });

  it("discards LF edits and treats loaded restored non-LF snapshots as requiring confirmation again", () => {
    const first = createLfDocumentTextDraft("new\n");
    const edited = updateDocumentTextDraft(first, "changed\n");
    expect(discardDocumentTextDraft(edited)).toEqual(first);
    const legacy = createDocumentTextDraft("old\r\n");
    const converted = confirmDocumentLfConversion(legacy, true);
    // Model only loading canonical strings; there are no save or restore requests in this layer.
    expect(createDocumentTextDraft(converted.content).conversion).toBe("not_required");
    expect(createDocumentTextDraft(legacy.originalCanonical).conversion).toBe("required");
  });

  it("assigns LF textarea values verbatim without trim, Unicode normalization or rebuilding mixed EOL", () => {
    const draft = confirmDocumentLfConversion(createDocumentTextDraft("old\r\n"), true);
    const value = `\ufeff中${emoji}e\u0301\t \n\n`;
    const result = updateDocumentTextDraft(draft, value);
    expect(result.content).toBe(value);
    expect(result.content).not.toBe(value.normalize("NFC"));
    expect(projectDocumentText(result.content)).toBe(result.content);
    fails(() => updateDocumentTextDraft(result, "a\r\nb"), "lf_required");
    expect(result.content).toBe(value);
    expect(result.originalCanonical).toBe("old\r\n");
  });

  it("accepts LF undo/redo values without reintroducing original CR into the draft", () => {
    const source = createDocumentTextDraft("A\r\nB\r");
    const initial = confirmDocumentLfConversion(source, true);
    const edited = updateDocumentTextDraft(initial, "A\nnew\nB\n");
    const undone = updateDocumentTextDraft(edited, initial.content);
    const redone = updateDocumentTextDraft(undone, edited.content);
    expect(undone.content).toBe("A\nB\n");
    expect(documentTextDraftIsDirty(undone)).toBe(true); // Explicit conversion has not been saved.
    expect(redone.content).toBe(edited.content);
    expect(discardDocumentTextDraft(redone).content).toBe("A\r\nB\r");
  });

  it("rejects inconsistent conversion states and editable drafts still containing CR", () => {
    const original = createDocumentTextDraft("a\r\nb");
    for (const forged of [
      { ...original, conversion: "not_required" },
      { ...original, content: "a\nb" },
      { ...original, conversion: "confirmed" },
    ]) {
      expect(() => updateDocumentTextDraft(forged as DocumentTextDraft, "new")).toThrow(DocumentTextError);
    }
  });

  it("removes old mixed-EOL mapping and write helpers from the public module", () => {
    for (const name of ["applyVerifiedDocumentEdit", "applyDocumentDisplayChange", "canonicalOffsetForDisplay", "displayOffsetForCanonical"]) {
      expect(documentText).not.toHaveProperty(name);
    }
  });
});

describe("regressions for the previous ambiguous mixed-EOL examples", () => {
  it("keeps A CRLF CR B readonly, then makes repeated blank-line edits unambiguous in LF", () => {
    const source = createDocumentTextDraft("A\r\n\rB");
    fails(() => updateDocumentTextDraft(source, "A\nB"), "conversion_required");
    const editable = confirmDocumentLfConversion(source, true);
    expect(editable.content).toBe("A\n\nB");
    // Either blank-line deletion has the same LF canonical result; no EOL reconstruction occurs.
    const removeFirst = updateDocumentTextDraft(editable, editable.content.slice(0, 1) + editable.content.slice(2));
    const removeSecond = updateDocumentTextDraft(editable, editable.content.slice(0, 2) + editable.content.slice(3));
    expect(removeFirst.content).toBe("A\nB");
    expect(removeSecond.content).toBe("A\nB");
    expect(discardDocumentTextDraft(removeFirst).content).toBe("A\r\n\rB");
  });

  it("keeps A CR X LF B readonly and preserves both LF newlines when X is deleted after confirmation", () => {
    const source = createDocumentTextDraft("A\rX\nB");
    fails(() => updateDocumentTextDraft(source, "A\n\nB"), "conversion_required");
    const editable = confirmDocumentLfConversion(source, true);
    expect(editable.content).toBe("A\nX\nB");
    const edited = updateDocumentTextDraft(editable, editable.content.slice(0, 2) + editable.content.slice(3));
    expect(edited.content).toBe("A\n\nB");
    expect(projectDocumentText(edited.content)).toBe("A\n\nB");
    expect(source.content).toBe("A\rX\nB");
  });

  it("does not reinterpret identical displayed LF text as a return to original mixed canonical bytes", () => {
    const source = createDocumentTextDraft("A\r\nB\nC");
    const editable = confirmDocumentLfConversion(source, true);
    const same = updateDocumentTextDraft(editable, projectDocumentText(source.content));
    expect(same.content).toBe("A\nB\nC");
    expect(documentTextDraftIsDirty(same)).toBe(true);
    expect(source.content).toBe("A\r\nB\nC");
  });
});

describe("LF selection, counts and validation", () => {
  it("uses canonical UTF-16 offsets directly for Chinese and emoji in LF editable drafts", () => {
    const draft = confirmDocumentLfConversion(createDocumentTextDraft(`中\r\n${emoji}B`), true);
    expect(draft.content).toBe(`中\n${emoji}B`);
    expect(documentTextSelection(draft, 2, 4)).toEqual({ start: 2, end: 4, text: emoji });
    expect(documentTextSelection(draft, 0, 1)).toEqual({ start: 0, end: 1, text: "中" });
    expect(documentTextSelection(draft, 1, 2)).toEqual({ start: 1, end: 2, text: "\n" });
    expect(documentTextSelection(draft, 0, 0)).toBeNull();
    expect(documentTextSelection(draft, draft.content.length, draft.content.length)).toBeNull();
  });

  it("selects the requested repeated paragraph without searching or relocating it", () => {
    const draft = createLfDocumentTextDraft("same\nsame\nsame\n");
    expect(documentTextSelection(draft, 5, 9)).toEqual({ start: 5, end: 9, text: "same" });
    expect(documentTextSelection(draft, 10, 14)).toEqual({ start: 10, end: 14, text: "same" });
  });

  it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER])("rejects invalid LF selection offsets: %j", (offset) => {
    fails(() => documentTextSelection(createLfDocumentTextDraft("a"), offset, 1), "invalid_offset");
  });

  it("rejects split surrogate boundaries, out-of-range ends and reversed selections", () => {
    const draft = createLfDocumentTextDraft(emoji);
    fails(() => documentTextSelection(draft, 0, 1), "invalid_offset");
    fails(() => documentTextSelection(draft, 1, 2), "invalid_offset");
    fails(() => documentTextSelection(draft, 0, 3), "invalid_offset");
    fails(() => documentTextSelection(draft, 2, 0), "invalid_range");
  });

  it("counts English tokens, displayed Unicode code points and actual canonical UTF-8 bytes", () => {
    const source = `Don't re-enter 2026 中文 ${emoji}\r\n`;
    expect(documentTextStats(source)).toEqual({ englishWords: 2, unicodeCharacters: 25, utf8Bytes: 33 });
    expect(documentTextStats(projectDocumentText(source))).toEqual({ englishWords: 2, unicodeCharacters: 25, utf8Bytes: 32 });
    expect(documentTextStats("it’s well-known 12 中文").englishWords).toBe(2);
    expect(documentTextStats("\u{1f468}\u200d\u{1f469}\u200d\u{1f467}\u200d\u{1f466}").unicodeCharacters).toBe(7);
    expect(documentTextStats("")).toEqual({ englishWords: 0, unicodeCharacters: 0, utf8Bytes: 0 });
  });

  it.each(["a", "中", emoji])("enforces the exact 262144-byte UTF-8 boundary for %j", (unit) => {
    const bytes = new TextEncoder().encode(unit).length;
    const exact = unit.repeat(Math.floor(DOCUMENT_CONTENT_BYTES / bytes)) + "x".repeat(DOCUMENT_CONTENT_BYTES % bytes);
    const draft = createLfDocumentTextDraft(exact);
    expect(documentTextStats(draft.content).utf8Bytes).toBe(DOCUMENT_CONTENT_BYTES);
    expect(lfDocumentContentError(exact)).toBeNull();
    expect(documentContentError(exact + "x")).toBe("content_too_large");
    fails(() => updateDocumentTextDraft(draft, exact + "x"), "content_too_large");
    fails(() => createDocumentTextDraft(exact + "x"), "content_too_large");
    expect(draft.content).toBe(exact);
  });

  it.each(["\ud800", "\udc00", "\ud800x", "x\udc00", "\ud800\ud800\udc00"])("rejects illegal Unicode before encoding or converting: %j", (value) => {
    expect(documentContentError(value)).toBe("invalid_unicode");
    fails(() => createDocumentTextDraft(value), "invalid_unicode");
    fails(() => updateDocumentTextDraft(createLfDocumentTextDraft(), value), "invalid_unicode");
    fails(() => projectDocumentText(value), "invalid_unicode");
  });

  it.each([null, undefined, 1, {}, []])("rejects non-text inputs: %j", (value) => {
    expect(documentContentError(value)).toBe("invalid_text");
    expect(lfDocumentContentError(value)).toBe("invalid_text");
  });

  it("retains BOM, combining marks, tabs, trailing whitespace and blank bodies", () => {
    const source = "\ufeffe\u0301\t \r\n\r\n";
    const converted = confirmDocumentLfConversion(createDocumentTextDraft(source), true);
    expect(converted.content).toBe("\ufeffe\u0301\t \n\n");
    expect(converted.content).not.toBe(converted.content.normalize("NFC"));
    expect(converted.originalCanonical).toBe(source);
    expect(updateDocumentTextDraft(converted, "").content).toBe("");
    expect(updateDocumentTextDraft(converted, " \t\n").content).toBe(" \t\n");
  });

  it("keeps validation errors free of source content and raw causes", () => {
    const privateText = "fictional-private-marker\0";
    expect(documentContentError(privateText)).toBe("nul_character");
    fails(() => createDocumentTextDraft(privateText), "nul_character");
    try { documentTextStats(privateText); } catch (error) {
      expect(error).toBeInstanceOf(DocumentTextError);
      expect(String(error)).not.toContain("fictional-private-marker");
      expect(error).not.toHaveProperty("cause");
      expect(error).not.toHaveProperty("originalCanonical");
    }
  });

  it("matches trimmed UTF-16 title limits without modifying body content", () => {
    for (const title of [" title ", "中".repeat(200), emoji.repeat(100)]) expect(documentTitleError(title)).toBeNull();
    for (const title of ["", " \t ", "x".repeat(201), emoji.repeat(100) + "x", "a\nb", "a\rb", "a\u2028b", "a\u2029b"]) {
      expect(documentTitleError(title)).toBe("invalid_title");
    }
    expect(documentTitleError("\ud800")).toBe("invalid_unicode");
    expect(documentTitleError("a\0b")).toBe("nul_character");
  });
});
