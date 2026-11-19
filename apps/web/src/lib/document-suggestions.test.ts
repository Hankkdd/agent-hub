import { expect, it } from "vitest";
import { createEditorSession, editorSelection, editorInput } from "./document-editor-state";
import { boundedContext, freezeSuggestionIntent, intentCurrent, generateSuggestionPrompt, textLimitError,
  instructionError, replacementError, frozenImport, newImportRequestId, utf8Bytes, type SuggestionDraft } from "./document-suggestions";

const session = (text = "before 中文😀 passage after") => createEditorSession({ id: "internal-document", createdAt: "now", updatedAt: "now", currentRevision: {
  id: "internal-revision", documentId: "internal-document", revisionNumber: 7, title: "Fictional", contentFormat: "plain_text", content: text, createdAt: "now", restoredFromRevisionId: null,
} });
function selected(text = "before 中文😀 passage after", start = 7, end = 11) {
  const s = session(text); s.selection = editorSelection(s, start, end); return s;
}
function draft(replacement = "candidate"): SuggestionDraft { return { intent: freezeSuggestionIntent(selected(), 4)!, instructions: "Clarify", prompt: "", replacement, advanced: false, composing: false, deleteConfirmed: false, copy: "idle" }; }

it("freezes exact saved UTF-16 selection, retains scalar boundaries and never relocates repeated text", () => {
  const s = selected("same\n中文😀\nsame", 10, 14), intent = freezeSuggestionIntent(s, 4)!;
  expect(intent.originalText).toBe("same"); expect(intent.startUtf16).toBe(10); expect(Object.isFrozen(intent)).toBe(true);
  s.selection = null; expect(intentCurrent(intent, s, 4)).toBe(true); // Dialog blur cannot redefine the frozen range.
  expect(intentCurrent(intent, editorInput(s, s.rawInput.replace("same", "other")), 4)).toBe(false);
  expect(intentCurrent(intent, s, 5)).toBe(false);
});
it.each(["dirty", "title", "conflict", "unknown", "composing", "half_pair", "empty", "CRLF", "CR", "mixed"])("rejects non-saved or invalid selection: %s", kind => {
  let s = selected("A😀B", 1, 3);
  if (kind === "dirty") s = editorInput(s, "changed");
  if (kind === "title") s.title = "New title";
  if (kind === "conflict") s.phase = "conflict";
  if (kind === "unknown") s.unknownOutcome = true;
  if (kind === "composing") s.composing = true;
  if (kind === "half_pair") s.selection = { ...s.selection!, end: 2, text: "\ud83d" };
  if (kind === "empty") s.selection = editorSelection(s, 1, 1);
  if (["CRLF", "CR", "mixed"].includes(kind)) s = selected(kind === "CRLF" ? "A\r\nB" : kind === "CR" ? "A\rB" : "A\r\n\rB", 0, 1);
  expect(freezeSuggestionIntent(s, 4)).toBeNull();
});
it("bounds selection and contexts by UTF-8 bytes without splitting astral characters or normalizing text", () => {
  const text = "😀".repeat(1000) + "e\u0301中" + "😀".repeat(1000);
  const intent = freezeSuggestionIntent(selected(text, 2000, 2003), 4)!;
  expect(intent.originalText).toBe("e\u0301中");
  expect(utf8Bytes(intent.contextBefore)).toBe(2048); expect(utf8Bytes(intent.contextAfter)).toBe(2048);
  expect(intent.beforeTruncated && intent.afterTruncated).toBe(true);
  expect(boundedContext("A😀B", 4, "before")).toBe("B"); expect(boundedContext("A😀B", 5, "before")).toBe("😀B");
  const max = "😀".repeat(4096);
  expect(freezeSuggestionIntent(selected(max, 0, max.length), 0)).not.toBeNull();
  expect(freezeSuggestionIntent(selected(max + "x", 0, max.length + 1), 0)).toBeNull();
});
it("produces editable external data with human revision info and excludes internal IDs/offsets unless opted in", () => {
  const d = draft(), before = JSON.stringify(d.intent);
  const text = generateSuggestionPrompt(d.intent, "Improve 中文 clarity");
  expect(text).toContain('"savedVersion": "r7"'); expect(text).toContain(d.intent.originalText);
  expect(text).not.toContain("internal-document"); expect(text).not.toContain("internal-revision"); expect(text).not.toContain("utf16_code_units");
  expect(generateSuggestionPrompt(d.intent, "Improve", true)).toContain("internal-document");
  d.prompt = text.replace("r7", "r999"); expect(JSON.stringify(d.intent)).toBe(before);
});
it("enforces instruction 4 KiB and final prompt 64 KiB including serialized escaping", () => {
  expect(instructionError("中".repeat(1365) + "x")).toBeNull(); expect(instructionError("中".repeat(1365) + "xx")).toBe("content_too_large");
  expect(textLimitError("x".repeat(65536), 65536)).toBeNull(); expect(textLimitError("x".repeat(65537), 65536)).toBe("content_too_large");
  expect(() => generateSuggestionPrompt(draft().intent, " ")).toThrow("instructions_required");
  expect(() => generateSuggestionPrompt(draft().intent, "x".repeat(4097))).toThrow("content_too_large");
  const controls = "\u0001".repeat(16384), i = freezeSuggestionIntent(selected(controls, 0, controls.length), 1)!;
  expect(() => generateSuggestionPrompt(i, "Improve")).toThrow("content_too_large"); // Selection is never silently shortened.
});
it.each(["\0", "\ud800", "\udfff", "A\r\nB", "x".repeat(65537)])("retains invalid candidate as raw data and blocks import: length %i", text => {
  const d = draft(text); expect(replacementError(d)).not.toBeNull(); expect(d.replacement).toBe(text);
});
it("requires explicit empty deletion, blocks no-change/composition and freezes a stable request independently of preview edits", () => {
  const d = draft(""); expect(replacementError(d)).toBe("delete_confirmation"); d.deleteConfirmed = true; expect(replacementError(d)).toBeNull();
  d.replacement = d.intent.originalText; expect(replacementError(d)).toBe("no_change"); d.composing = true; expect(replacementError(d)).toBe("composing");
  d.composing = false; d.replacement = "候選😀\n "; const payload = frozenImport(d);
  d.replacement = "later edit"; expect(payload.replacementText).toBe("候選😀\n "); expect(Object.isFrozen(payload.selection)).toBe(true);
  for (let i = 0; i < 10; i++) expect(newImportRequestId()).toMatch(/^[A-Za-z0-9_-]{16,96}$/);
});
