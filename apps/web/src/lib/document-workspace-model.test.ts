import { beforeEach, expect, it, vi } from "vitest";
import type { DocumentDetail, DocumentRevision, DocumentWriteResult } from "@agent-hub/shared";
import { DocumentWorkspaceModel, type DocumentApi } from "./document-workspace-model";
import { editorCandidate, editorDirty, editorValidation } from "./document-editor-state";

function detail(content = "Fictional SOP\n中文😀", number = 1, id = "document"): DocumentDetail {
  return { id, createdAt: "2026-10-20T00:00:00Z", updatedAt: "2026-10-20T00:00:00Z", currentRevision: {
    id: `r${number}`, documentId: id, revisionNumber: number, title: "Fictional SOP", contentFormat: "plain_text", content,
    createdAt: "2026-10-20T00:00:00Z", restoredFromRevisionId: null,
  } };
}
function deferred<T>() { let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
let api: { [K in keyof DocumentApi]: ReturnType<typeof vi.fn<DocumentApi[K]>> }, model: DocumentWorkspaceModel;
beforeEach(() => {
  api = { createDocument: vi.fn(), listDocuments: vi.fn().mockResolvedValue({ documents: [], nextOffset: null }), getDocument: vi.fn().mockResolvedValue(detail()),
    updateDocument: vi.fn(), listDocumentRevisions: vi.fn().mockResolvedValue({ revisions: [], nextBeforeRevisionNumber: null }),
    getDocumentRevision: vi.fn(), restoreDocumentRevision: vi.fn() };
  model = new DocumentWorkspaceModel(api);
});
const session = () => model.getSnapshot().editor!;

it("creates an empty LF document and pages metadata without touching tasks or models", async () => {
  api.createDocument.mockResolvedValue(detail(""));
  expect(await model.create(" Fictional SOP ")).toBe("document");
  expect(api.createDocument).toHaveBeenCalledWith({ title: "Fictional SOP", contentFormat: "plain_text", content: "" });
  await model.list(); expect(api.listDocuments).toHaveBeenCalledWith({ limit: 50, offset: 0 });
  api.listDocuments.mockResolvedValue({ documents: [], nextOffset: 50 }); await model.list(); await model.list(true);
  expect(api.listDocuments).toHaveBeenLastCalledWith({ limit: 50, offset: 50 });
});

it("title-only saves preserve canonical CR and confirmation only changes the local draft", async () => {
  const base = detail("A\r\n\rB", 5); api.getDocument.mockResolvedValue(base); await model.open("document");
  expect(session().rawInput).toBe("A\n\nB"); expect(editorDirty(session())).toBe(false);
  model.input("blocked"); expect(editorCandidate(session()).content).toBe(base.currentRevision.content);
  model.title("New title"); const next = detail(base.currentRevision.content, 6); next.currentRevision.title = "New title";
  api.updateDocument.mockResolvedValue({ document: next, revisionCreated: true }); await model.save();
  expect(api.updateDocument.mock.calls[0]![1].content).toBe("A\r\n\rB");
  model.convert(false); expect(session().textBase.conversion).toBe("required");
  model.convert(true); expect(session().rawInput).toBe("A\n\nB"); expect(editorDirty(session())).toBe(true);
  expect(api.updateDocument).toHaveBeenCalledTimes(1); expect(base.currentRevision.content).toBe("A\r\n\rB");
  model.discard(true); expect(editorCandidate(session()).content).toBe("A\r\n\rB");
});

it("rebases r5 non-LF -> r6(A) while retaining B and discards to r6, using a deferred save", async () => {
  api.getDocument.mockResolvedValue(detail("old\r\ntext", 5)); await model.open("document"); model.convert(true); model.input("A");
  const pending = deferred<DocumentWriteResult>(); api.updateDocument.mockReturnValueOnce(pending.promise);
  const saving = model.save(); model.input("B");
  expect(await model.save()).toBe(false); expect(api.updateDocument).toHaveBeenCalledTimes(1);
  pending.resolve({ document: detail("A", 6), revisionCreated: true }); expect(await saving).toBe(true);
  expect(session().base.currentRevision.id).toBe("r6"); expect(session().rawInput).toBe("B"); expect(editorDirty(session())).toBe(true);
  expect(session().textBase.conversion).toBe("not_required");
  api.updateDocument.mockResolvedValueOnce({ document: detail("B", 7), revisionCreated: true });
  await model.save(); expect(api.updateDocument.mock.calls[1]![1].expectedRevisionId).toBe("r6");
  // Repeat the deferred race to assert discard specifically uses the acknowledged A snapshot.
  api.getDocument.mockResolvedValue(detail("old\r\ntext", 5)); await model.open("document", true, true); model.convert(true); model.input("A");
  const second = deferred<DocumentWriteResult>(); api.updateDocument.mockReturnValueOnce(second.promise);
  const again = model.save(); model.input("B"); second.resolve({ document: detail("A", 6), revisionCreated: true }); await again;
  model.discard(true); expect(session().rawInput).toBe("A"); expect(session().base.currentRevision.id).toBe("r6");
  expect(session().textBase.conversion).toBe("not_required"); expect(editorDirty(session())).toBe(false);
});

it.each([["\ud800", "invalid_unicode"], ["x\u0000y", "nul_character"], ["x".repeat(262145), "content_too_large"], ["a\rb", "lf_required"]])("keeps invalid input and refuses save", async (raw, code) => {
  await model.open("document"); model.input(raw); expect(session().rawInput).toBe(raw);
  expect(editorDirty(session())).toBe(true); expect(editorValidation(session())).toBe(code);
  expect(await model.save()).toBe(false); expect(api.updateDocument).not.toHaveBeenCalled();
  model.input("Corrected 中文😀"); expect(editorValidation(session())).toBeNull();
});

it("blocks save during IME, preserves cancellation/undo values, and validates after composition", async () => {
  await model.open("document"); const initial = session().rawInput;
  model.composing(true); model.input("\ud800"); expect(editorValidation(session())).toBe("composing");
  expect(await model.save()).toBe(false); model.input("中文😀"); model.composing(false);
  expect(session().rawInput).toBe("中文😀"); expect(editorValidation(session())).toBeNull();
  model.composing(true); model.input(initial); model.composing(false); expect(editorDirty(session())).toBe(false);
  model.input("edited"); model.input(initial); expect(editorDirty(session())).toBe(false);
});

it.each([401, 409, 0, 500, 503])("preserves drafts on %i with no automatic retry", async status => {
  await model.open("document"); model.input("Unsaved 中文");
  api.updateDocument.mockRejectedValue({ status, code: "revision_conflict", message: "never expose content" });
  expect(await model.save()).toBe(false); expect(session().rawInput).toBe("Unsaved 中文");
  expect(session().phase).toBe(status === 409 ? "conflict" : "error"); expect(api.updateDocument).toHaveBeenCalledTimes(1);
  if (status === 401) { expect(model.getSnapshot().authorized).toBe(false); model.setAuthorized(true); expect(session().rawInput).toBe("Unsaved 中文"); }
  if (status === 409) { expect(await model.save()).toBe(false); api.getDocument.mockResolvedValue(detail("Remote", 2)); await model.loadRemote(); expect(session().rawInput).toBe("Unsaved 中文"); expect(session().base.currentRevision.id).toBe("r1"); }
  if (status === 0 || status === 500) expect(session().unknownOutcome).toBe(true);
  expect(model.getSnapshot().error).not.toHaveProperty("message");
});

it("ignores a late document GET after typing, and out-of-order open responses", async () => {
  await model.open("document"); const late = deferred<DocumentDetail>(); api.getDocument.mockReturnValueOnce(late.promise);
  const opening = model.open("other"); model.input("New local input"); late.resolve(detail("Other", 1, "other"));
  expect(await opening).toBe(false); expect(session().rawInput).toBe("New local input");
  model.discard(true); const older = deferred<DocumentDetail>(); api.getDocument.mockReturnValueOnce(older.promise).mockResolvedValueOnce(detail("Newest", 1, "newest"));
  const first = model.open("other"); await model.open("newest"); older.resolve(detail("Old", 1, "other")); await first;
  expect(session().base.id).toBe("newest");
});

it("requires confirmation, serializes restore with save and never reposts after committed restore/GET failure", async () => {
  await model.open("document"); const source: DocumentRevision = detail("Historical\r\nbody").currentRevision;
  expect(await model.restore(source, false)).toBe(false); expect(api.restoreDocumentRevision).not.toHaveBeenCalled();
  model.input("draft"); const pending = deferred<DocumentWriteResult>(); api.restoreDocumentRevision.mockReturnValue(pending.promise);
  const restoring = model.restore(source, true); expect(await model.save()).toBe(false); expect(await model.restore(source, true)).toBe(false);
  model.input("must not overwrite restore"); expect(session().rawInput).toBe("draft");
  const result = detail(source.content, 2); result.currentRevision.restoredFromRevisionId = source.id;
  api.getDocument.mockRejectedValue({ status: 503 }); pending.resolve({ document: result, revisionCreated: true });
  expect(await restoring).toBe(true); expect(model.getSnapshot().restoreRefreshFailed).toBe(true);
  expect(session().base.currentRevision.id).toBe("r2"); expect(session().textBase.conversion).toBe("required");
  await model.refreshAfterRestore(); expect(api.restoreDocumentRevision).toHaveBeenCalledTimes(1);
  expect(api.restoreDocumentRevision).toHaveBeenCalledWith("document", source.id, { expectedRevisionId: "r1" });
});

it("save and restore never overlap, and unknown writes protect navigation/discard", async () => {
  await model.open("document"); model.input("Save"); const pending = deferred<DocumentWriteResult>(); api.updateDocument.mockReturnValue(pending.promise);
  const saving = model.save(); expect(await model.restore(detail().currentRevision, true)).toBe(false);
  expect(await model.open("other", true)).toBe(false); model.discard(true); expect(session().rawInput).toBe("Save");
  pending.reject(new Error("network")); await saving; model.discard(true);
  expect(model.protectedDraft()).toBe(true); expect(await model.open("other")).toBe(false);
});

it("binds UTF-16 selection to a saved revision or explicit local draft, invalidating edits", async () => {
  api.getDocument.mockResolvedValue(detail("A😀中文")); await model.open("document"); model.select(1, 3);
  expect(session().selection).toMatchObject({ text: "😀", start: 1, end: 3, revisionId: "r1", source: "saved" });
  model.select(1, 2); expect(session().selection).toBeNull(); model.input("A😀中文!"); model.select(1, 3);
  expect(session().selection).toMatchObject({ revisionId: null, baseRevisionId: "r1", source: "draft", draftVersion: 1 });
  model.title("Changed"); expect(session().selection).toBeNull(); model.select(1, 3); await model.history(); expect(session().selection).toBeNull();
  model.select(1, 3); model.clearSelection(); expect(session().selection).toBeNull();
});

it("pages revision metadata and rejects another document's preview/restore", async () => {
  await model.open("document"); api.listDocumentRevisions.mockResolvedValue({ revisions: [], nextBeforeRevisionNumber: 50 });
  await model.history(); await model.history(true); expect(api.listDocumentRevisions).toHaveBeenLastCalledWith("document", { limit: 50, beforeRevisionNumber: 50 });
  api.getDocumentRevision.mockResolvedValue(detail("Wrong", 1, "other").currentRevision); await model.preview("r1"); expect(model.getSnapshot().preview).toBeNull();
  expect(await model.restore(detail("Wrong", 1, "other").currentRevision, true)).toBe(false);
});

it("retains invalid input and IME state received after submitting a valid save", async () => {
  await model.open("document"); model.input("A"); const pending = deferred<DocumentWriteResult>(); api.updateDocument.mockReturnValue(pending.promise);
  const saving = model.save(); model.composing(true); model.input("\ud800");
  pending.resolve({ document: detail("A", 2), revisionCreated: true }); await saving;
  expect(session().rawInput).toBe("\ud800"); expect(session().composing).toBe(true); expect(editorDirty(session())).toBe(true);
  model.composing(false); expect(editorValidation(session())).toBe("invalid_unicode"); expect(await model.save()).toBe(false);
  model.discard(true); expect(session().rawInput).toBe("A");
});

it("ignores superseded revision previews and clears in-flight preview state when switching documents", async () => {
  await model.open("document"); const late = deferred<DocumentRevision>();
  api.getDocumentRevision.mockReturnValueOnce(late.promise).mockResolvedValueOnce(detail("new preview", 2).currentRevision);
  const first = model.preview("r1"); await model.preview("r2"); late.resolve(detail("old preview").currentRevision); await first;
  expect(model.getSnapshot().preview?.id).toBe("r2");
  const old = deferred<DocumentRevision>(); api.getDocumentRevision.mockReturnValueOnce(old.promise); const reading = model.preview("r1");
  api.getDocument.mockResolvedValue(detail("Other", 1, "other")); await model.open("other");
  expect(model.getSnapshot().previewLoading).toBe(false); old.resolve(detail().currentRevision); await reading;
  expect(model.getSnapshot().preview).toBeNull();
});

it("keeps the native editing session through save but replaces it on document switch/discard/restore", async () => {
  await model.open("document"); const key = model.getSnapshot().sessionKey; model.input("A");
  api.updateDocument.mockResolvedValue({ document: detail("A", 2), revisionCreated: true }); await model.save();
  expect(model.getSnapshot().sessionKey).toBe(key);
  model.input("B"); model.discard(true); expect(model.getSnapshot().sessionKey).toBeGreaterThan(key);
  const afterDiscard = model.getSnapshot().sessionKey;
  api.restoreDocumentRevision.mockResolvedValue({ document: detail("Old", 3), revisionCreated: true }); api.getDocument.mockResolvedValue(detail("Old", 3));
  await model.restore(detail("Old").currentRevision, true); expect(model.getSnapshot().sessionKey).toBeGreaterThan(afterDiscard);
});

it.each([0, 500])("unknown create status %i preserves the previous session and never repeats POST", async status => {
  await model.open("document"); model.input("Retained old draft");
  const before = session();
  api.createDocument.mockRejectedValue(status === 0 ? new Error("network") : { status });
  expect(await model.create("Fictional new", true)).toBeNull();
  expect(session()).toBe(before); expect(session().unknownOutcome).toBe(false);
  expect(model.getSnapshot().createUnknown).not.toBeNull();
  expect(model.getSnapshot().createError).toMatchObject({ status, unknownWrite: true });
  expect(await model.create("Fictional new", true)).toBeNull();
  expect(api.createDocument).toHaveBeenCalledTimes(1);
});

it("failed destination GET and failed restore both retain the original dirty session", async () => {
  await model.open("document"); model.input("Retain me");
  api.getDocument.mockRejectedValue({ status: 404 }); expect(await model.open("missing", true)).toBe(false);
  expect(session().rawInput).toBe("Retain me");
  api.restoreDocumentRevision.mockRejectedValue({ status: 409 });
  expect(await model.restore(detail("old").currentRevision, true)).toBe(false);
  expect(session().rawInput).toBe("Retain me"); expect(session().base.currentRevision.id).toBe("r1");
});

it("does not POST a clean save or allow simultaneous creates", async () => {
  await model.open("document"); expect(await model.save()).toBe(true); expect(api.updateDocument).not.toHaveBeenCalled();
  const pending = deferred<DocumentDetail>(); api.createDocument.mockReturnValue(pending.promise);
  const creating = model.create("Fictional new"); expect(await model.create("Duplicate")).toBeNull();
  model.input("blocked while replacing session"); expect(session().rawInput).toBe(detail().currentRevision.content);
  pending.resolve(detail("", 1, "new")); await creating; expect(api.createDocument).toHaveBeenCalledTimes(1);
});

it("retains create uncertainty without an editor, after list inspection and after saving another document", async () => {
  api.createDocument.mockRejectedValue(new Error("network")); await model.create("Fictional new");
  const unknown = model.getSnapshot().createUnknown;
  expect(unknown).not.toBeNull(); expect(model.getSnapshot().editor).toBeNull();
  await model.list(); expect(model.getSnapshot().documents).toEqual([]);
  expect(model.getSnapshot().createUnknown).toBe(unknown);
  expect(await model.create("Fictional new")).toBeNull(); expect(api.createDocument).toHaveBeenCalledTimes(1);
  api.getDocument.mockResolvedValue(detail("Other body", 1, "other")); await model.open("other"); model.input("Saved other body");
  api.updateDocument.mockResolvedValue({ document: detail("Saved other body", 2, "other"), revisionCreated: true });
  expect(await model.save()).toBe(true); expect(session().unknownOutcome).toBe(false);
  expect(model.getSnapshot().createUnknown).toBe(unknown);
  model.discard(true); expect(model.getSnapshot().createUnknown).toBe(unknown);
});

it.each([400, 401, 503])("keeps confirmed create failure %i separate from editor and unknown creation", async status => {
  await model.open("document"); model.input("Keep draft"); const before = session();
  api.createDocument.mockRejectedValue({ status }); await model.create("Fictional new", true);
  expect(session()).toBe(before); expect(model.getSnapshot().error).toBeNull();
  expect(model.getSnapshot().createUnknown).toBeNull();
  expect(model.getSnapshot().createError).toMatchObject({ status, unknownWrite: false });
  if (status === 401) expect(model.getSnapshot().authorized).toBe(false);
  model.setAuthorized(true); api.createDocument.mockResolvedValue(detail("", 1, "new"));
  expect(await model.create("Fictional new", true)).toBe("new");
});

it("requires a fresh explicit create-risk acknowledgment for every subsequent POST", async () => {
  api.createDocument.mockRejectedValue(new Error("network")); await model.create("Fictional new");
  const first = model.getSnapshot().createUnknown!;
  expect(await model.create("Fictional new", true, first + 1)).toBeNull(); expect(api.createDocument).toHaveBeenCalledTimes(1);
  api.createDocument.mockRejectedValueOnce({ status: 400 }); await model.create("Fictional new", true, first);
  const second = model.getSnapshot().createUnknown!;
  expect(second).not.toBe(first); expect(model.getSnapshot().createError).toMatchObject({ status: 400, unknownWrite: false });
  expect(await model.create("Fictional new", true, first)).toBeNull(); expect(api.createDocument).toHaveBeenCalledTimes(2);
  api.createDocument.mockResolvedValueOnce(detail("", 1, "new"));
  expect(await model.create("Fictional new", true, second)).toBe("new");
  expect(model.getSnapshot().createUnknown).not.toBeNull(); expect(session().unknownOutcome).toBe(false);
  expect(await model.create("Fictional new", true, second)).toBeNull(); expect(api.createDocument).toHaveBeenCalledTimes(3);
});

it("a known create failure cannot clear an existing document's unknown update outcome", async () => {
  await model.open("document"); model.input("Dirty"); api.updateDocument.mockRejectedValue(new Error("network")); await model.save();
  const before = session(), writeError = model.getSnapshot().error;
  api.createDocument.mockRejectedValue({ status: 400 }); await model.create("Fictional new", true);
  expect(session()).toBe(before); expect(session().unknownOutcome).toBe(true); expect(model.getSnapshot().error).toBe(writeError);
  expect(model.getSnapshot().createUnknown).toBeNull();
});

it.each(["failure", "success"] as const)("ignores a late restore refresh %s from A after switching to B", async outcome => {
  await model.open("document"); const late = deferred<DocumentDetail>(); api.getDocument.mockReturnValueOnce(late.promise);
  const refreshing = model.refreshAfterRestore();
  api.getDocument.mockResolvedValueOnce(detail("B", 1, "other")); await model.open("other"); const current = session();
  if (outcome === "failure") late.reject({ status: 503 }); else late.resolve(detail("Old A", 9));
  await refreshing;
  expect(session()).toBe(current); expect(session().base.id).toBe("other"); expect(model.getSnapshot().restoreRefreshFailed).toBe(false);
});

it("ignores restore refresh results after reopening the same document in a new session", async () => {
  await model.open("document"); const late = deferred<DocumentDetail>(); api.getDocument.mockReturnValueOnce(late.promise);
  const refreshing = model.refreshAfterRestore();
  api.getDocument.mockResolvedValueOnce(detail("New session", 2)); await model.open("document", true, true);
  late.reject(new Error("late failure")); await refreshing;
  expect(session().rawInput).toBe("New session"); expect(model.getSnapshot().restoreRefreshFailed).toBe(false);
});

it("only the newest restore refresh request may report failure", async () => {
  await model.open("document"); const first = deferred<DocumentDetail>(), second = deferred<DocumentDetail>();
  api.getDocument.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const old = model.refreshAfterRestore(), latest = model.refreshAfterRestore();
  first.reject(new Error("old")); await old; expect(model.getSnapshot().restoreRefreshFailed).toBe(false);
  second.reject(new Error("current")); await latest; expect(model.getSnapshot().restoreRefreshFailed).toBe(true);
});

it("an older successful restore refresh cannot clear the latest failure", async () => {
  await model.open("document"); const first = deferred<DocumentDetail>(), second = deferred<DocumentDetail>();
  api.getDocument.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const old = model.refreshAfterRestore(), latest = model.refreshAfterRestore();
  second.reject(new Error("current")); await latest; const current = session();
  first.resolve(detail("Stale", 9)); await old;
  expect(session()).toBe(current); expect(model.getSnapshot().restoreRefreshFailed).toBe(true);
});
