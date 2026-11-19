import { beforeEach, expect, it, vi } from "vitest";
import type { DocumentDetail, ImportSuggestionInput, SuggestionDetail, SuggestionMetadata } from "@agent-hub/shared";
import { DocumentWorkspaceModel, type DocumentApi } from "./document-workspace-model";
import type { SuggestionApi } from "./document-suggestions";
import { editorDirty } from "./document-editor-state";

function doc(id = "A", content = "same\n中文😀\nsame", n = 1): DocumentDetail {
  return { id, createdAt: "now", updatedAt: "now", currentRevision: { id: `${id}-r${n}`, documentId: id, revisionNumber: n,
    contentFormat: "plain_text", title: `Fictional ${id}`, content, createdAt: "now", restoredFromRevisionId: null } };
}
function record(payload: ImportSuggestionInput, id = "S", documentId = "A"): SuggestionDetail {
  return { id, documentId, importRequestId: payload.importRequestId, source: "manual_import", baseRevisionId: payload.baseRevisionId, baseRevisionNumber: 1,
    selection: { startUtf16: payload.selection.startUtf16, endUtf16: payload.selection.endUtf16, originalSha256: "0".repeat(64) }, originalText: payload.selection.originalText,
    replacementText: payload.replacementText, originalUtf8Bytes: new TextEncoder().encode(payload.selection.originalText).length, replacementUtf8Bytes: new TextEncoder().encode(payload.replacementText).length,
    status: "pending", acceptedRevisionId: null, createdAt: "now", resolvedAt: null };
}
function meta(row: SuggestionDetail): SuggestionMetadata { const { originalText: _o, replacementText: _r, ...m } = row; return m; }
function deferred<T>() { let resolve!: (v: T) => void, reject!: (e: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
let api: { [K in keyof DocumentApi]: ReturnType<typeof vi.fn<DocumentApi[K]>> };
let suggestions: { [K in keyof SuggestionApi]: ReturnType<typeof vi.fn<SuggestionApi[K]>> };
let model: DocumentWorkspaceModel, documents: Map<string, DocumentDetail>, row: SuggestionDetail;
const editor = () => model.getSnapshot().editor!;
const state = () => model.getSnapshot().suggestions;
beforeEach(async () => {
  documents = new Map([["A", doc()], ["B", doc("B")]]);
  api = { createDocument: vi.fn(), listDocuments: vi.fn().mockResolvedValue({ documents: [], nextOffset: null }),
    getDocument: vi.fn(async id => documents.get(id)!), updateDocument: vi.fn(async (id, input) => ({ document: { ...doc(id, input.content, 2), currentRevision: { ...doc(id, input.content, 2).currentRevision, title: input.title } }, revisionCreated: true })),
    listDocumentRevisions: vi.fn().mockResolvedValue({ revisions: [], nextBeforeRevisionNumber: null }), getDocumentRevision: vi.fn(), restoreDocumentRevision: vi.fn() };
  suggestions = { importDocumentSuggestion: vi.fn(async (id, input) => ({ suggestion: row = record(input, "S", id), replayed: false })), listDocumentSuggestions: vi.fn().mockResolvedValue({ suggestions: [], nextOffset: null }),
    getDocumentSuggestion: vi.fn(async () => row), acceptDocumentSuggestion: vi.fn(), rejectDocumentSuggestion: vi.fn() };
  model = new DocumentWorkspaceModel(api, suggestions); await model.open("A");
});
function intent() { model.select(10, 14); expect(model.startSuggestion()).toBe(true); model.updateSuggestionDraft({ instructions: "Improve clarity", replacement: "new 中文😀" }); model.generatePrompt(); }
async function imported() { intent(); expect(await model.importSuggestion()).toBe(true); return row; }
function accepted(s = row, tip = doc("A", "same\n中文😀\nnew 中文😀", 2)) {
  const resolved = { ...s, status: "accepted" as const, acceptedRevisionId: "A-r2", resolvedAt: "later" };
  return { suggestion: meta(resolved), acceptedRevisionId: "A-r2", acceptedRevisionNumber: 2, replayed: false, document: tip };
}

it("freezes once before dialog blur, defaults to private prompt metadata and makes no HTTP writes during preview", () => {
  intent(); const target = state().draft!.intent;
  model.clearSelection(); model.updateSuggestionDraft({ prompt: "Pretend different IDs/ranges" }); model.generatePrompt();
  expect(state().draft!.intent).toBe(target); expect(state().draft!.prompt).not.toContain("A-r1");
  expect(model.intentValid()).toBe(true); expect(suggestions.importDocumentSuggestion).not.toHaveBeenCalled(); expect(api.updateDocument).not.toHaveBeenCalled();
  model.title("dirty title"); expect(model.intentValid()).toBe(false); expect(model.canImportSuggestion()).toBe(false);
});
it.each(["title", "body", "composing", "unknown", "conflict", "saving"])("gates Intent before %s is resolved and invalidates old draft versions", kind => {
  model.select(10, 14);
  if (kind === "title") model.title("changed"); if (kind === "body") model.input("changed"); if (kind === "composing") model.composing(true);
  if (kind === "unknown") editor().unknownOutcome = true; if (kind === "conflict") editor().phase = "conflict"; if (kind === "saving") editor().phase = "saving";
  expect(model.startSuggestion()).toBe(false); expect(suggestions.importDocumentSuggestion).not.toHaveBeenCalled();
});
it("preserves invalid raw candidate, composition, no-change and empty deletion until explicit valid input", () => {
  intent();
  for (const replacement of ["\0", "\ud800", "A\rB", "x".repeat(65537), "same", ""]) {
    model.updateSuggestionDraft({ replacement, deleteConfirmed: false }); expect(state().draft!.replacement).toBe(replacement); expect(model.canImportSuggestion()).toBe(false);
  }
  model.updateSuggestionDraft({ deleteConfirmed: true }); expect(model.canImportSuggestion()).toBe(true);
  model.updateSuggestionDraft({ composing: true }); expect(model.canImportSuggestion()).toBe(false);
  model.updateSuggestionDraft({ composing: false }); expect(model.canImportSuggestion()).toBe(true);
});
it("imports only on explicit action, using frozen target and source while leaving document unchanged", async () => {
  const before = editor().base; await imported();
  expect(suggestions.importDocumentSuggestion.mock.calls[0]![1]).toMatchObject({ source: "manual_import", baseRevisionId: "A-r1", selection: { startUtf16: 10, endUtf16: 14, originalText: "same" }, replacementText: "new 中文😀" });
  expect(state().draft).toBeNull(); expect(editor().base).toBe(before); expect(api.updateDocument).not.toHaveBeenCalled();
  expect(state().detail).toEqual(row);
});
it("keeps unknown import identity/payload independent of document changes and replays only that exact request", async () => {
  intent(); suggestions.importDocumentSuggestion.mockRejectedValueOnce({ status: 0 }); await model.importSuggestion();
  const op = state().operation!; expect(op.kind).toBe("import"); expect(op.phase).toBe("unknown");
  const payload = suggestions.importDocumentSuggestion.mock.calls[0]![1];
  model.updateSuggestionDraft({ replacement: "must not change unknown payload" }); expect(state().draft!.replacement).toBe(payload.replacementText);
  await model.checkSuggestionOutcome(); expect(state().operation).toEqual(op); // filter empty is not proof of failure
  await model.open("B", true); model.input("B saved"); await model.save(); expect(state().operation).toEqual(op);
  await model.list(); expect(state().operation).toEqual(op);
  await model.open("A", true); expect(await model.retrySuggestionWrite(false)).toBe(false);
  expect(await model.retrySuggestionWrite(true, op.id)).toBe(true);
  expect(suggestions.importDocumentSuggestion.mock.calls[1]![1]).toBe(payload); expect(state().operation).toBeNull();
  expect(editor().base.id).toBe("A");
});
it("resolves unknown Import with key filter plus exact detail without another POST", async () => {
  intent(); suggestions.importDocumentSuggestion.mockRejectedValueOnce({ status: 500 }); await model.importSuggestion();
  const payload = suggestions.importDocumentSuggestion.mock.calls[0]![1], saved = record(payload);
  suggestions.listDocumentSuggestions.mockResolvedValueOnce({ suggestions: [meta(saved)], nextOffset: null }); suggestions.getDocumentSuggestion.mockResolvedValueOnce(saved);
  await model.checkSuggestionOutcome(); expect(state().operation).toBeNull(); expect(state().detail).toEqual(saved);
  expect(suggestions.importDocumentSuggestion).toHaveBeenCalledTimes(1);
});
it("known 409 retains draft and invalidates the target; 401 retains memory; a failed unknown retry cannot clear uncertainty", async () => {
  intent(); suggestions.importDocumentSuggestion.mockRejectedValueOnce({ status: 409, code: "revision_conflict" }); await model.importSuggestion();
  expect(state().operation).toBeNull(); expect(state().draft).not.toBeNull(); expect(model.canImportSuggestion()).toBe(false);
  model.discardSuggestionDraft(true); intent(); suggestions.importDocumentSuggestion.mockRejectedValueOnce({ status: 0 }); await model.importSuggestion();
  const id = state().operation!.id;
  suggestions.importDocumentSuggestion.mockRejectedValueOnce({ status: 401 }); await model.retrySuggestionWrite(true, id);
  expect(state().operation).toMatchObject({ id, phase: "unknown" }); expect(state().draft).not.toBeNull(); expect(model.getSnapshot().authorized).toBe(false);
});
it("retains a known first Import 401 without clearing editor input or inventing an unknown outcome", async () => {
  intent(); const original = editor(); suggestions.importDocumentSuggestion.mockRejectedValueOnce({ status: 401 }); await model.importSuggestion();
  expect(editor()).toBe(original); expect(state().draft).not.toBeNull(); expect(state().operation).toBeNull(); expect(model.getSnapshot().authorized).toBe(false);
});
it("Accept is explicit and locks all editor/model writing entrypoints; acknowledgement replaces the exact confirmed snapshot", async () => {
  await imported(); const wait = deferred<ReturnType<typeof accepted>>(); suggestions.acceptDocumentSuggestion.mockReturnValueOnce(wait.promise);
  expect(await model.acceptSuggestion(false)).toBe(false); const pending = model.acceptSuggestion(true, row.id), original = editor();
  model.input("bad"); model.title("bad"); model.composing(true); model.convert(true); model.discard(true);
  expect(editor()).toBe(original); expect(await model.save()).toBe(false); expect(await model.restore(original.base.currentRevision, true)).toBe(false);
  expect(await model.acceptSuggestion(true)).toBe(false); expect(await model.open("B", true)).toBe(false);
  wait.resolve(accepted()); expect(await pending).toBe(true); expect(editor().base.currentRevision.id).toBe("A-r2"); expect(editor().selection).toBeNull();
  expect(state().receipt!.acceptedRevisionId).toBe("A-r2"); expect(api.updateDocument).not.toHaveBeenCalled(); expect(api.restoreDocumentRevision).not.toHaveBeenCalled();
});
it("shows the permanent old acceptance receipt while adopting a newer actual current tip on replay", async () => {
  await imported(); suggestions.acceptDocumentSuggestion.mockResolvedValueOnce({ ...accepted(row, doc("A", "later tip", 4)), replayed: true });
  await model.acceptSuggestion(true); expect(state().receipt!.acceptedRevisionId).toBe("A-r2"); expect(editor().base.currentRevision.id).toBe("A-r4"); expect(editor().rawInput).toBe("later tip");
});
it("unknown Accept stays locked after pending GET; an explicit retry uses exactly the original ID/base", async () => {
  await imported(); suggestions.acceptDocumentSuggestion.mockRejectedValueOnce({ status: 0 }); await model.acceptSuggestion(true);
  const op = state().operation!, before = editor(); await model.checkSuggestionOutcome(); expect(state().operation).toEqual(op); expect(model.editorLocked()).toBe(true);
  model.input("forbidden"); expect(editor()).toBe(before); expect(await model.save()).toBe(false);
  suggestions.acceptDocumentSuggestion.mockResolvedValueOnce({ ...accepted(), replayed: true }); await model.retrySuggestionWrite(true, op.id);
  expect(suggestions.acceptDocumentSuggestion.mock.calls.map(c => c.slice(0, 3))).toEqual([["A", "S", { expectedRevisionId: "A-r1" }], ["A", "S", { expectedRevisionId: "A-r1" }]]);
  expect(state().operation).toBeNull(); expect(editor().base.currentRevision.id).toBe("A-r2");
});
it("after accepted GET plus failed document refresh, only retries GET and never reposts Accept", async () => {
  await imported(); suggestions.acceptDocumentSuggestion.mockRejectedValueOnce({ status: 0 }); await model.acceptSuggestion(true);
  suggestions.getDocumentSuggestion.mockResolvedValue({ ...row, ...accepted().suggestion }); api.getDocument.mockRejectedValueOnce({ status: 0 });
  await model.checkSuggestionOutcome(); expect(state().operation?.phase).toBe("refresh"); expect(state().refreshFailed).toBe(true); expect(model.editorLocked()).toBe(true);
  api.getDocument.mockResolvedValueOnce(doc("A", "accepted", 2)); await model.retrySuggestionWrite(true);
  expect(suggestions.acceptDocumentSuggestion).toHaveBeenCalledTimes(1); expect(state().operation).toBeNull(); expect(editor().base.currentRevision.id).toBe("A-r2"); expect(state().checking).toBe(false);
});
it("Reject and repeated Reject never alter editor/history, and unknown Reject resolves by GET", async () => {
  await imported(); const before = editor();
  suggestions.rejectDocumentSuggestion.mockRejectedValueOnce({ status: 0 }); await model.rejectSuggestion(true);
  expect(editor()).toBe(before); suggestions.getDocumentSuggestion.mockResolvedValueOnce({ ...row, status: "rejected", resolvedAt: "later" });
  await model.checkSuggestionOutcome(); expect(state().operation).toBeNull(); expect(editor()).toBe(before);
  suggestions.rejectDocumentSuggestion.mockResolvedValueOnce({ suggestion: { ...meta(row), status: "rejected", resolvedAt: "later" }, replayed: true });
  await model.rejectSuggestion(true); expect(editor()).toBe(before); expect(api.getDocument).toHaveBeenCalledTimes(1); expect(api.updateDocument).not.toHaveBeenCalled();
});
it("stale suggestion/409 keeps the saved body and candidate; it never substitutes the newer expected ID", async () => {
  await imported(); suggestions.acceptDocumentSuggestion.mockRejectedValueOnce({ status: 409, code: "revision_conflict", currentRevisionId: "A-r99" });
  await model.acceptSuggestion(true); expect(editor().base.currentRevision.id).toBe("A-r1"); expect(state().detail!.replacementText).toBe(row.replacementText); expect(state().error?.status).toBe(409);
  expect(suggestions.acceptDocumentSuggestion).toHaveBeenCalledTimes(1);
  documents.set("A", doc("A", "changed", 3)); await model.open("A", true, true); await model.showSuggestions(); suggestions.getDocumentSuggestion.mockResolvedValue(row); await model.previewSuggestion(row.id);
  expect(model.canAcceptSuggestion()).toBe(false); expect(await model.acceptSuggestion(true)).toBe(false);
});
it.each(["success", "failure"])("ignores late detail/list %s after A to B and after reopening the same document", async outcome => {
  await imported(); const detail = deferred<SuggestionDetail>(), list = deferred<{ suggestions: SuggestionMetadata[]; nextOffset: null }>();
  suggestions.getDocumentSuggestion.mockReturnValueOnce(detail.promise); suggestions.listDocumentSuggestions.mockReturnValueOnce(list.promise);
  const a = model.previewSuggestion("S"), b = model.showSuggestions();
  await model.open("B", true); await model.open("A", true, true); const stable = editor();
  if (outcome === "success") { detail.resolve(row); list.resolve({ suggestions: [meta(row)], nextOffset: null }); }
  else { detail.reject({ status: 500 }); list.reject({ status: 500 }); }
  await a; await b; expect(editor()).toBe(stable); expect(state().detail).toBeNull(); expect(state().error).toBeNull(); expect(state().items).toEqual([]);
});
it.each(["success", "failure"])("ignores unknown reconciliation %s after session change, preserving the original operation", async outcome => {
  await imported(); suggestions.acceptDocumentSuggestion.mockRejectedValueOnce({ status: 0 }); await model.acceptSuggestion(true);
  const read = deferred<SuggestionDetail>(); suggestions.getDocumentSuggestion.mockReturnValueOnce(read.promise); const pending = model.checkSuggestionOutcome();
  const op = state().operation; await model.open("B", true); const before = editor();
  if (outcome === "success") read.resolve({ ...row, ...accepted().suggestion }); else read.reject({ status: 500 });
  await pending; expect(editor()).toBe(before); expect(state().error).toBeNull(); expect(state().operation).toEqual(op); expect(state().receipt).toBeNull();
});
it("deduplicates offset pages and loads original/replacement only through detail", async () => {
  await imported(); model.closeSuggestions(); const m = meta(row);
  suggestions.listDocumentSuggestions.mockResolvedValueOnce({ suggestions: [m], nextOffset: 1 }).mockResolvedValueOnce({ suggestions: [m], nextOffset: null });
  await model.showSuggestions(); await model.showSuggestions(true); expect(state().items).toHaveLength(1); expect(suggestions.getDocumentSuggestion).not.toHaveBeenCalled();
  await model.previewSuggestion(row.id); expect(suggestions.getDocumentSuggestion).toHaveBeenCalledWith("A", row.id, expect.any(AbortSignal));
});
it("keeps Create Unknown independent of Import Unknown and later unrelated saves", async () => {
  api.createDocument.mockRejectedValueOnce({ status: 500 }); await model.create("Other"); const unknown = model.getSnapshot().createUnknown; expect(unknown).not.toBeNull();
  intent(); suggestions.importDocumentSuggestion.mockRejectedValueOnce({ status: 0 }); await model.importSuggestion(); const op = state().operation;
  await model.open("B", true); model.input("B new"); await model.save(); expect(model.getSnapshot().createUnknown).toBe(unknown); expect(state().operation).toEqual(op);
});
it("preserves existing Save A/B and Restore mutex while Suggestion methods cannot start mid-write", async () => {
  model.input("A submitted"); const saved = deferred<{ document: DocumentDetail; revisionCreated: boolean }>(); api.updateDocument.mockReturnValueOnce(saved.promise);
  const saving = model.save(); model.input("B after submit"); expect(model.startSuggestion()).toBe(false); expect(await model.acceptSuggestion(true)).toBe(false); expect(await model.restore(editor().base.currentRevision, true)).toBe(false);
  saved.resolve({ document: doc("A", "A submitted", 2), revisionCreated: true }); await saving;
  expect(editor().rawInput).toBe("B after submit"); expect(editor().base.currentRevision.id).toBe("A-r2"); expect(editorDirty(editor())).toBe(true);
  model.discard(true); expect(editor().rawInput).toBe("A submitted");
});
it("requires explicit conversion plus Save and fresh selection for a CR canonical document", async () => {
  documents.set("A", doc("A", "A\r\n\rB")); await model.open("A", true, true); model.select(0, 1); expect(model.startSuggestion()).toBe(false);
  model.title("Title only"); await model.save(); expect(api.updateDocument.mock.calls[0]![1].content).toBe("A\r\n\rB");
  model.convert(true); model.select(0, 1); expect(model.startSuggestion()).toBe(false); expect(api.updateDocument).toHaveBeenCalledTimes(1);
  await model.save(); model.select(0, 1); expect(model.startSuggestion()).toBe(true);
});

it.each(["success", "failure"])("closing/reopening the review dialog invalidates a late %s even in the same session", async outcome => {
  await imported(); const read = deferred<SuggestionDetail>(); suggestions.getDocumentSuggestion.mockReturnValueOnce(read.promise);
  const pending = model.previewSuggestion(row.id); const signal = suggestions.getDocumentSuggestion.mock.calls.at(-1)![2]!;
  model.closeSuggestions(); expect(signal.aborted).toBe(true); await model.showSuggestions();
  if (outcome === "success") read.resolve(row); else read.reject({ status: 500 });
  await pending; expect(state().detail).toBeNull(); expect(state().error).toBeNull(); expect(state().detailLoading).toBe(false);
});
it("rejects malformed metadata without exposing it to rendering or touching the editor", async () => {
  const before = editor(); suggestions.listDocumentSuggestions.mockResolvedValueOnce({ suggestions: [{ id: "bad", documentId: "A", status: "unknown" } as unknown as SuggestionMetadata], nextOffset: null });
  await model.showSuggestions(); expect(state().items).toEqual([]); expect(state().error?.status).toBe(0); expect(editor()).toBe(before);
});

it("receipt recovery never overwrites a dirty draft when an unknown Reject reveals another tab's Accept", async () => {
  await imported(); suggestions.rejectDocumentSuggestion.mockRejectedValueOnce({ status: 0 }); await model.rejectSuggestion(true);
  model.input("Important local draft after Reject"); const before = editor();
  suggestions.getDocumentSuggestion.mockResolvedValueOnce({ ...row, ...accepted().suggestion }); await model.checkSuggestionOutcome();
  expect(editor()).toBe(before); expect(editor().rawInput).toBe("Important local draft after Reject"); expect(editor().base.currentRevision.id).toBe("A-r1");
  expect(state().receipt!.acceptedRevisionId).toBe("A-r2"); expect(state().operation).toBeNull(); expect(state().error?.code).toBe("draft_changed");
  expect(api.getDocument).toHaveBeenCalledTimes(1); expect(suggestions.acceptDocumentSuggestion).not.toHaveBeenCalled();
});

function delayedDisplayReads() {
  const detail = deferred<SuggestionDetail>(), list = deferred<{ suggestions: SuggestionMetadata[]; nextOffset: number | null }>();
  suggestions.getDocumentSuggestion.mockReturnValueOnce(detail.promise);
  suggestions.listDocumentSuggestions.mockReturnValueOnce(list.promise);
  const detailRead = model.previewSuggestion(row.id), listRead = model.showSuggestions();
  const detailSignal = suggestions.getDocumentSuggestion.mock.calls.at(-1)![2]!;
  const listSignal = suggestions.listDocumentSuggestions.mock.calls.at(-1)![2]!;
  return { detail, list, detailRead, listRead, detailSignal, listSignal };
}
function expectDisplayReadsInvalidated(reads: ReturnType<typeof delayedDisplayReads>) {
  expect(reads.detailSignal.aborted).toBe(true); expect(reads.listSignal.aborted).toBe(true);
  expect(state().detailLoading).toBe(false); expect(state().listLoading).toBe(false);
}
async function releaseOldPending(reads: ReturnType<typeof delayedDisplayReads>, pending: SuggestionDetail) {
  // These mocks deliberately ignore AbortSignal: generations must also reject late completions.
  reads.detail.resolve(pending); reads.list.resolve({ suggestions: [meta(pending)], nextOffset: null });
  await reads.detailRead; await reads.listRead;
}

it.each(["detail", "list"])("P1 A/B: an old Pending %s cannot undo a confirmed Reject or enable Accept", async kind => {
  await imported(); const pending = row, rejected = { ...pending, status: "rejected" as const, resolvedAt: "rejected-now" };
  const post = deferred<{ suggestion: SuggestionMetadata; replayed: boolean }>(); suggestions.rejectDocumentSuggestion.mockReturnValueOnce(post.promise);
  const rejecting = model.rejectSuggestion(true);
  const reads = delayedDisplayReads();
  post.resolve({ suggestion: meta(rejected), replayed: false }); expect(await rejecting).toBe(true);
  expectDisplayReadsInvalidated(reads);
  if (kind === "detail") { reads.detail.resolve(pending); await reads.detailRead; }
  else { reads.list.resolve({ suggestions: [meta(pending)], nextOffset: null }); await reads.listRead; }
  expect(state().detail!.status).toBe("rejected"); expect(state().items.find(s => s.id === pending.id)!.status).toBe("rejected");
  expect(model.canAcceptSuggestion()).toBe(false); expect(await model.acceptSuggestion(true)).toBe(false);
  await releaseOldPending(reads, pending); expect(suggestions.acceptDocumentSuggestion).not.toHaveBeenCalled();
});

it.each(["rejected", "accepted"] as const)("P1 C: unknown Reject recovery to %s invalidates old display reads and preserves a dirty draft", async status => {
  await imported(); const pending = row;
  suggestions.rejectDocumentSuggestion.mockRejectedValueOnce({ status: 0 }); await model.rejectSuggestion(true);
  model.input("Fictional dirty draft must survive receipt recovery"); const before = editor();
  const reads = delayedDisplayReads(), recovery = deferred<SuggestionDetail>(); suggestions.getDocumentSuggestion.mockReturnValueOnce(recovery.promise);
  const checking = model.checkSuggestionOutcome();
  const resolved = { ...pending, status, resolvedAt: "resolved-now", acceptedRevisionId: status === "accepted" ? "A-r2" : null };
  recovery.resolve(resolved); await checking;
  expectDisplayReadsInvalidated(reads); await releaseOldPending(reads, pending);
  expect(state().detail).toEqual(resolved); expect(state().items.find(s => s.id === pending.id)).toEqual(meta(resolved));
  expect(editor()).toBe(before); expect(editorDirty(editor())).toBe(true); expect(state().operation).toBeNull(); expect(model.canAcceptSuggestion()).toBe(false);
  if (status === "accepted") expect(state().receipt).toEqual(meta(resolved)); else expect(state().receipt).toBeNull();
  expect(api.getDocument).toHaveBeenCalledTimes(1); expect(suggestions.acceptDocumentSuggestion).not.toHaveBeenCalled();
});

it("P1 D: an unknown Accept receipt wins over old Pending list/detail before its document refresh finishes or fails", async () => {
  await imported(); const pending = row;
  suggestions.acceptDocumentSuggestion.mockRejectedValueOnce({ status: 0 }); await model.acceptSuggestion(true);
  const reads = delayedDisplayReads(), recovery = deferred<SuggestionDetail>(), refresh = deferred<DocumentDetail>();
  suggestions.getDocumentSuggestion.mockReturnValueOnce(recovery.promise); api.getDocument.mockReturnValueOnce(refresh.promise);
  const checking = model.checkSuggestionOutcome(), resolved = { ...pending, ...accepted().suggestion };
  recovery.resolve(resolved); await Promise.resolve();
  expect(state().operation?.phase).toBe("refresh"); expectDisplayReadsInvalidated(reads);
  await releaseOldPending(reads, pending);
  expect(state().detail).toEqual(resolved); expect(state().items.find(s => s.id === pending.id)).toEqual(meta(resolved));
  expect(state().receipt).toEqual(meta(resolved)); expect(model.canAcceptSuggestion()).toBe(false); expect(model.editorLocked()).toBe(true);
  refresh.reject({ status: 0 }); await checking;
  expect(state().refreshFailed).toBe(true); expect(state().receipt!.acceptedRevisionId).toBe("A-r2");
  expect(state().detail!.status).toBe("accepted"); expect(suggestions.acceptDocumentSuggestion).toHaveBeenCalledTimes(1);
});

it.each(["write", "recovery"])("P1 E: Import %s invalidates an older empty list/detail without hiding the new suggestion or blocking a later Refresh", async outcome => {
  intent(); const post = deferred<{ suggestion: SuggestionDetail; replayed: boolean }>(); suggestions.importDocumentSuggestion.mockReturnValueOnce(post.promise);
  const importing = model.importSuggestion(); row = record(suggestions.importDocumentSuggestion.mock.calls[0]![1]);
  if (outcome === "recovery") { post.reject({ status: 0 }); await importing; }
  const reads = delayedDisplayReads();
  if (outcome === "write") { post.resolve({ suggestion: row, replayed: false }); expect(await importing).toBe(true); }
  else {
    suggestions.listDocumentSuggestions.mockResolvedValueOnce({ suggestions: [meta(row)], nextOffset: null });
    suggestions.getDocumentSuggestion.mockResolvedValueOnce(row); await model.checkSuggestionOutcome();
  }
  expectDisplayReadsInvalidated(reads);
  reads.list.resolve({ suggestions: [], nextOffset: null }); reads.detail.resolve({ ...row, id: "older-detail" });
  await reads.listRead; await reads.detailRead;
  expect(state().items).toEqual([meta(row)]); expect(state().detail).toEqual(row);
  const newer = { ...row, id: "another-import", importRequestId: "another-stable-key" };
  suggestions.listDocumentSuggestions.mockResolvedValueOnce({ suggestions: [meta(newer), meta(row)], nextOffset: null });
  await model.showSuggestions(); expect(state().items).toEqual([meta(newer), meta(row)]); expect(state().listLoading).toBe(false);
  suggestions.getDocumentSuggestion.mockResolvedValueOnce(newer); await model.previewSuggestion(newer.id); expect(state().detail).toEqual(newer);
});

it("P1: invalidated GET failures/finalizers cannot change confirmed status, auth or the loading flags of a newer Refresh", async () => {
  await imported(); const pending = row, rejected = { ...pending, status: "rejected" as const, resolvedAt: "resolved-now" };
  const post = deferred<{ suggestion: SuggestionMetadata; replayed: boolean }>(); suggestions.rejectDocumentSuggestion.mockReturnValueOnce(post.promise);
  const rejecting = model.rejectSuggestion(true), reads = delayedDisplayReads(); post.resolve({ suggestion: meta(rejected), replayed: false }); await rejecting;
  expectDisplayReadsInvalidated(reads);
  const freshList = deferred<{ suggestions: SuggestionMetadata[]; nextOffset: null }>(), freshDetail = deferred<SuggestionDetail>();
  suggestions.listDocumentSuggestions.mockReturnValueOnce(freshList.promise); suggestions.getDocumentSuggestion.mockReturnValueOnce(freshDetail.promise);
  const refreshing = model.showSuggestions(), previewing = model.previewSuggestion(rejected.id);
  reads.list.reject({ status: 401 }); reads.detail.reject({ status: 500 }); await reads.listRead; await reads.detailRead;
  expect(state().listLoading).toBe(true); expect(state().detailLoading).toBe(true); expect(state().error).toBeNull(); expect(model.getSnapshot().authorized).toBe(true);
  expect(state().items).toEqual([meta(rejected)]);
  freshList.resolve({ suggestions: [meta(rejected)], nextOffset: null }); freshDetail.resolve(rejected); await refreshing; await previewing;
  expect(state().detail).toEqual(rejected); expect(state().listLoading).toBe(false); expect(state().detailLoading).toBe(false);
});

it("P1: confirmed Accept aborts earlier display reads while preserving its permanent receipt and newer current tip", async () => {
  await imported(); const pending = row, post = deferred<ReturnType<typeof accepted>>(); suggestions.acceptDocumentSuggestion.mockReturnValueOnce(post.promise);
  const accepting = model.acceptSuggestion(true), reads = delayedDisplayReads();
  post.resolve(accepted(row, doc("A", "Newer fictional tip", 4))); expect(await accepting).toBe(true);
  expectDisplayReadsInvalidated(reads); await releaseOldPending(reads, pending);
  expect(state().detail!.status).toBe("accepted"); expect(state().items[0]!.status).toBe("accepted"); expect(state().receipt!.acceptedRevisionId).toBe("A-r2");
  expect(editor().base.currentRevision.id).toBe("A-r4"); expect(model.canAcceptSuggestion()).toBe(false); expect(suggestions.acceptDocumentSuggestion).toHaveBeenCalledTimes(1);
});
it("pending badge counts only the open document and treats failures as unknown, not zero", async () => {
  const pending = meta(record({ importRequestId: "k".repeat(16), source: "manual_import", baseRevisionId: "A-r1", selection: { startUtf16: 0, endUtf16: 4, originalText: "same" }, replacementText: "x" }));
  suggestions.listDocumentSuggestions.mockResolvedValueOnce({ suggestions: [pending], nextOffset: 1 });
  await model.loadPendingCount();
  expect(suggestions.listDocumentSuggestions).toHaveBeenLastCalledWith("A", { limit: 100, status: "pending" });
  expect(model.getSnapshot().pendingSuggestions).toEqual({ documentId: "A", count: 1, more: true });
  const late = deferred<{ suggestions: SuggestionMetadata[]; nextOffset: number | null }>();
  suggestions.listDocumentSuggestions.mockReturnValueOnce(late.promise);
  const read = model.loadPendingCount(); await model.open("B"); late.resolve({ suggestions: [], nextOffset: null }); await read;
  expect(model.getSnapshot().pendingSuggestions?.documentId).toBe("A");
  suggestions.listDocumentSuggestions.mockRejectedValueOnce(Object.assign(new Error("denied"), { status: 401 }));
  await model.loadPendingCount();
  expect(model.getSnapshot().pendingSuggestions).toBeNull(); expect(model.getSnapshot().authorized).toBe(true); expect(model.getSnapshot().error).toBeNull();
});
