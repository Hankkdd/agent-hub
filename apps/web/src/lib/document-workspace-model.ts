import type { ImportSuggestionInput, SuggestionDetail, SuggestionMetadata } from "@agent-hub/shared";
import { freezeSuggestionIntent, generateSuggestionPrompt, intentCurrent, replacementError, frozenImport, sameImport,
  checkedSuggestion, checkedSuggestionMetadata, suggestionApplicable, suggestionMetadata, type SuggestionApi, type SuggestionDraft } from "./document-suggestions";
import type { DocumentDetail, DocumentList, DocumentRevision, DocumentRevisionMetadata, DocumentRevisionList, DocumentWriteResult, CreateDocumentInput, UpdateDocumentInput, RestoreDocumentInput } from "@agent-hub/shared";
import { acknowledgeSave, createEditorSession, editorCandidate, editorConvert, editorDirty, editorInput, editorSelection, editorValidation, type EditorSession } from "./document-editor-state";
import { documentTitleError } from "./document-text";

export interface DocumentApi {
  createDocument(input: CreateDocumentInput): Promise<DocumentDetail>;
  listDocuments(query?: { limit?: number; offset?: number }, signal?: AbortSignal): Promise<DocumentList>;
  getDocument(id: string, signal?: AbortSignal): Promise<DocumentDetail>;
  updateDocument(id: string, input: UpdateDocumentInput): Promise<DocumentWriteResult>;
  listDocumentRevisions(id: string, query?: { limit?: number; beforeRevisionNumber?: number }, signal?: AbortSignal): Promise<DocumentRevisionList>;
  getDocumentRevision(id: string, revisionId: string, signal?: AbortSignal): Promise<DocumentRevision>;
  restoreDocumentRevision(id: string, revisionId: string, input: RestoreDocumentInput): Promise<DocumentWriteResult>;
}
export interface DocumentFailure { status: number; code?: string; retryAfterSeconds?: number; unknownWrite?: boolean }
function failure(error: unknown): DocumentFailure {
  const value = error && typeof error === "object" ? error as Record<string, unknown> : {};
  return { status: typeof value.status === "number" ? value.status : 0,
    code: typeof value.code === "string" && /^[a-z_]{1,60}$/.test(value.code) ? value.code : undefined,
    retryAfterSeconds: typeof value.retryAfterSeconds === "number" ? value.retryAfterSeconds : undefined };
}
export type SuggestionOperation = { id: number; documentId: string; phase: "pending" | "unknown" | "refresh"; receipt?: SuggestionMetadata } & (
  { kind: "import"; payload: ImportSuggestionInput } | { kind: "accept" | "reject"; suggestionId: string; baseRevisionId: string; row: SuggestionDetail });
export interface SuggestionWorkspaceState {
  open: "prompt" | "review" | null; draft: SuggestionDraft | null;
  items: SuggestionMetadata[]; nextOffset: number | null; listLoading: boolean; detailLoading: boolean;
  detail: SuggestionDetail | null; error: DocumentFailure | null;
  operation: SuggestionOperation | null; checking: boolean; refreshFailed: boolean;
  receipt: SuggestionMetadata | null; draftInvalid: boolean; conflictedId: string | null;
}
const emptySuggestions = (): SuggestionWorkspaceState => ({ open: null, draft: null, items: [], nextOffset: null,
  listLoading: false, detailLoading: false, detail: null, error: null, operation: null, checking: false, refreshFailed: false, receipt: null, draftInvalid: false, conflictedId: null });
export interface DocumentWorkspaceState {
  suggestions: SuggestionWorkspaceState;
  editor: EditorSession | null; sessionKey: number; pending: "save" | "restore" | "create" | "suggestion" | null; authorized: boolean;
  createError: DocumentFailure | null;
  // Unresolved create outcome; this version permits one explicitly acknowledged new attempt.
  createUnknown: number | null;
  documents: DocumentList["documents"]; nextOffset: number | null; listLoading: boolean; listError: DocumentFailure | null;
  opening: boolean; error: DocumentFailure | null; remote: DocumentDetail | null;
  historyOpen: boolean; revisions: DocumentRevisionMetadata[]; nextBefore: number | null;
  historyLoading: boolean; previewLoading: boolean; historyError: DocumentFailure | null; preview: DocumentRevision | null;
  restoreRefreshFailed: boolean;
  // Badge-only count for the open document; null when unknown, never a guessed zero.
  pendingSuggestions: { documentId: string; count: number; more: boolean } | null;
}
/** One UI-local session; the owner outlives view/auth rendering. No polling or background writes. */
export class DocumentWorkspaceModel {
  private value: DocumentWorkspaceState = { suggestions: emptySuggestions(), editor: null, sessionKey: 0, pending: null, authorized: true, createError: null, createUnknown: null, documents: [], nextOffset: null,
    listLoading: false, listError: null, opening: false, error: null, remote: null, historyOpen: false,
    revisions: [], nextBefore: null, historyLoading: false, previewLoading: false, historyError: null, preview: null, restoreRefreshFailed: false, pendingSuggestions: null };
  private listeners = new Set<() => void>();
  private openSequence = 0; private listSequence = 0; private historySequence = 0; private previewSequence = 0; private remoteSequence = 0;
  private openAbort?: AbortController;
  private createSequence = 0;
  private restoreRefreshSequence = 0;
  private suggestionListSequence = 0; private suggestionDetailSequence = 0; private suggestionCheckSequence = 0; private suggestionOperationSequence = 0; private suggestionPendingId: number | null = null; private pendingCountSequence = 0;
  private suggestionListAbort?: AbortController; private suggestionDetailAbort?: AbortController;
  constructor(private readonly api: DocumentApi, private readonly suggestionApi?: SuggestionApi) {}
  getSnapshot = () => this.value;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private patch(patch: Partial<DocumentWorkspaceState>) { this.value = { ...this.value, ...patch }; for (const listener of this.listeners) listener(); }
  private edit(change: (s: EditorSession) => EditorSession) { if (this.value.editor && this.value.pending !== "restore" && this.value.pending !== "create" && !this.editorLocked()) this.patch({ editor: change(this.value.editor) }); }
  editorLocked() { const op = this.value.suggestions.operation; return !!op && op.documentId === this.value.editor?.base.id && (op.kind === "accept" || op.phase === "refresh"); }
  hasSuggestionMaterial() { return !!this.value.suggestions.draft || !!this.value.suggestions.operation; }
  protectedDraft() { const id = this.value.editor?.base.id;
    return this.editorLocked() || !!id && (this.value.suggestions.draft?.intent.documentId === id || this.value.suggestions.operation?.documentId === id) || !!this.value.pending || !!this.value.editor && (editorDirty(this.value.editor) || this.value.editor.unknownOutcome || this.value.editor.composing); }
  setAuthorized(authorized: boolean) { if (authorized !== this.value.authorized) this.patch({ authorized }); }
  input(raw: string) { this.edit(s => editorInput(s, raw)); }
  title(title: string) { this.edit(s => ({ ...s, title, editVersion: s.editVersion + 1, selection: null })); }
  composing(composing: boolean) { this.edit(s => ({ ...s, composing, selection: null })); }
  clearSelection() { if (this.value.editor?.selection) this.edit(s => ({ ...s, selection: null })); }
  select(start: number, end: number) { this.edit(s => ({ ...s, selection: editorSelection(s, start, end) })); }
  convert(confirmed: boolean) { if (confirmed === true && !this.value.pending && !this.editorLocked()) this.edit(editorConvert); }
  discard(confirmed: boolean) {
    if (confirmed === true && !this.value.pending && !this.editorLocked() && this.value.editor) {
      this.resetSuggestionView(); this.patch({ sessionKey: this.value.sessionKey + 1, editor: { ...createEditorSession(this.value.editor.base), unknownOutcome: this.value.editor.unknownOutcome }, error: null, remote: null });
    }
  }
  private failWrite(error: unknown) {
    const parsed = failure(error);
    const safe = { ...parsed, unknownWrite: parsed.status === 0 || parsed.status >= 500 && parsed.status !== 503 };
    const detail = error && typeof error === "object" ? error as { currentRevisionId?: string } : {};
    this.patch({ error: safe, authorized: safe.status === 401 ? false : this.value.authorized,
      editor: this.value.editor ? { ...this.value.editor, phase: safe.status === 409 ? "conflict" : "error", selection: null,
        unknownOutcome: safe.unknownWrite, conflictRevisionId: detail.currentRevisionId } : null });
  }
  private remember(detail: DocumentDetail) {
    const r = detail.currentRevision;
    const summary = { id: detail.id, createdAt: detail.createdAt, title: r.title, contentFormat: r.contentFormat,
      currentRevisionId: r.id, revisionNumber: r.revisionNumber, updatedAt: detail.updatedAt };
    this.patch({ documents: this.value.documents.some(d => d.id === detail.id) ? this.value.documents.map(d => d.id === detail.id ? summary : d) : [summary, ...this.value.documents] });
  }
  async list(more = false) {
    if (this.value.listLoading || more && this.value.nextOffset === null) return;
    const seq = ++this.listSequence;
    this.patch({ listLoading: true, listError: null });
    try {
      const result = await this.api.listDocuments({ limit: 50, offset: more ? this.value.nextOffset! : 0 });
      if (seq !== this.listSequence) return;
      const unique = new Map((more ? this.value.documents : []).map(d => [d.id, d]));
      for (const item of result.documents) unique.set(item.id, item);
      this.patch({ documents: [...unique.values()], nextOffset: result.nextOffset });
    } catch (e) { if (seq === this.listSequence) this.patch({ listError: failure(e) }); }
    finally { if (seq === this.listSequence) this.patch({ listLoading: false }); }
  }
  async open(id: string, discard = false, reload = false): Promise<boolean> {
    if (this.value.pending || this.protectedDraft() && !discard) return false;
    if (!reload && this.value.editor?.base.id === id) return true;
    const seq = ++this.openSequence, previous = this.value.editor;
    this.openAbort?.abort(); const abort = this.openAbort = new AbortController();
    this.patch({ opening: true, error: null });
    try {
      const detail = await this.api.getDocument(id, abort.signal);
      if (seq !== this.openSequence) return false;
      if (this.value.editor !== previous && (this.value.editor?.editVersion !== previous?.editVersion || this.value.editor?.composing)) {
        this.patch({ error: { status: 0, code: "draft_changed" } }); return false;
      }
      if (this.value.pending) return false;
      const editor = createEditorSession(detail);
      if (detail.id !== id) throw new Error("Invalid document response");
      this.historySequence++; this.previewSequence++; this.remoteSequence++;
      this.resetSuggestionView(); this.patch({ sessionKey: this.value.sessionKey + 1, editor, remote: null, historyOpen: false, revisions: [], preview: null, historyLoading: false, previewLoading: false, historyError: null, nextBefore: null, restoreRefreshFailed: false }); return true;
    } catch (e) { if (seq === this.openSequence && !abort.signal.aborted) this.patch({ error: failure(e) }); return false; }
    finally { if (seq === this.openSequence) this.patch({ opening: false }); }
  }
  async create(title: string, discard = false, acknowledgedCreateUnknown?: number): Promise<string | null> {
    if (!this.value.authorized || this.value.pending || this.value.opening || this.protectedDraft() && !discard || documentTitleError(title)) return null;
    if (this.value.createUnknown !== null && acknowledgedCreateUnknown !== this.value.createUnknown) return null;
    const attempt = ++this.createSequence;
    this.openSequence++; this.openAbort?.abort();
    // Consume a risk acknowledgment even if this attempt later has a known failure.
    this.patch({ pending: "create", createError: null, ...(this.value.createUnknown !== null ? { createUnknown: attempt } : {}) });
    try {
      const detail = await this.api.createDocument({ title: title.trim(), contentFormat: "plain_text", content: "" });
      this.historySequence++; this.previewSequence++; this.remoteSequence++;
      const editor = createEditorSession(detail); this.resetSuggestionView(); this.patch({ sessionKey: this.value.sessionKey + 1, editor, error: null, remote: null, historyOpen: false, revisions: [], preview: null, historyLoading: false, previewLoading: false, historyError: null, nextBefore: null }); this.remember(detail); return detail.id;
    } catch (e) {
      const parsed = failure(e);
      const unknownWrite = parsed.status === 0 || parsed.status >= 500 && parsed.status !== 503;
      this.patch({ createError: { ...parsed, unknownWrite },
        authorized: parsed.status === 401 ? false : this.value.authorized,
        ...(unknownWrite ? { createUnknown: attempt } : {}) });
      return null;
    }
    finally { this.patch({ pending: null }); }
  }
  async save(): Promise<boolean> {
    const submitted = this.value.editor;
    if (!submitted || !this.value.authorized || this.value.pending || this.editorLocked() || submitted.phase === "conflict" || editorValidation(submitted)) return false;
    if (!editorDirty(submitted) && !submitted.unknownOutcome) return true;
    const snapshot = editorCandidate(submitted);
    this.patch({ pending: "save", error: null, editor: { ...submitted, phase: "saving", selection: null } });
    try {
      const result = await this.api.updateDocument(submitted.base.id, { ...snapshot, expectedRevisionId: submitted.base.currentRevision.id });
      const current = this.value.editor!;
      this.patch({ editor: acknowledgeSave(current, submitted, result.document) }); this.remember(result.document);
      if (this.value.historyOpen) void this.history(); return true;
    } catch (e) { this.failWrite(e); return false; }
    finally { this.patch({ pending: null }); }
  }
  async loadRemote() {
    const editor = this.value.editor; if (!editor || this.value.pending) return;
    const seq = ++this.remoteSequence, key = this.value.sessionKey;
    try {
      const remote = await this.api.getDocument(editor.base.id);
      createEditorSession(remote);
      if (seq === this.remoteSequence && key === this.value.sessionKey && this.value.editor?.base.id === editor.base.id && remote.id === editor.base.id) this.patch({ remote });
    } catch (e) { if (seq === this.remoteSequence && key === this.value.sessionKey && this.value.editor?.base.id === editor.base.id) this.patch({ error: failure(e) }); }
  }
  closeHistory() { this.patch({ historyOpen: false }); }
  async history(more = false) {
    const id = this.value.editor?.base.id; if (!id || more && this.value.nextBefore === null) return;
    this.clearSelection();
    const seq = ++this.historySequence, key = this.value.sessionKey;
    this.patch({ historyOpen: true, historyLoading: true, historyError: null });
    try {
      const page = await this.api.listDocumentRevisions(id, { limit: 50, ...(more ? { beforeRevisionNumber: this.value.nextBefore! } : {}) });
      if (seq !== this.historySequence || key !== this.value.sessionKey || id !== this.value.editor?.base.id) return;
      const items = new Map((more ? this.value.revisions : []).map(r => [r.id, r]));
      for (const r of page.revisions) items.set(r.id, r);
      this.patch({ revisions: [...items.values()], nextBefore: page.nextBeforeRevisionNumber });
    } catch (e) { if (seq === this.historySequence && key === this.value.sessionKey && id === this.value.editor?.base.id) this.patch({ historyError: failure(e) }); }
    finally { if (seq === this.historySequence && key === this.value.sessionKey && id === this.value.editor?.base.id) this.patch({ historyLoading: false }); }
  }
  async preview(revisionId: string) {
    const id = this.value.editor?.base.id; if (!id) return;
    const seq = ++this.previewSequence, key = this.value.sessionKey; this.patch({ previewLoading: true, preview: null, historyError: null });
    try {
      const revision = await this.api.getDocumentRevision(id, revisionId);
      if (seq === this.previewSequence && key === this.value.sessionKey && id === this.value.editor?.base.id) {
        if (revision.documentId !== id || revision.id !== revisionId) throw new Error("Invalid revision response");
        this.patch({ preview: revision });
      }
    } catch (e) { if (seq === this.previewSequence && key === this.value.sessionKey && id === this.value.editor?.base.id) this.patch({ historyError: failure(e) }); }
    finally { if (seq === this.previewSequence && key === this.value.sessionKey && id === this.value.editor?.base.id) this.patch({ previewLoading: false }); }
  }
  async refreshAfterRestore() {
    const editor = this.value.editor; if (!editor || editorDirty(editor) || editor.composing) return;
    const sequence = ++this.restoreRefreshSequence, sessionKey = this.value.sessionKey, openSequence = this.openSequence;
    const current = () => sequence === this.restoreRefreshSequence && sessionKey === this.value.sessionKey &&
      openSequence === this.openSequence && this.value.editor === editor;
    try {
      const detail = await this.api.getDocument(editor.base.id);
      if (!current()) return;
      if (detail.id !== editor.base.id) throw new Error("Invalid document response");
      this.patch({ editor: { ...createEditorSession(detail), phase: "saved" }, restoreRefreshFailed: false });
    } catch { if (current()) this.patch({ restoreRefreshFailed: true }); }
  }
  private patchSuggestions(patch: Partial<SuggestionWorkspaceState>) { this.patch({ suggestions: { ...this.value.suggestions, ...patch } }); }
  private invalidateSuggestionReads() {
    // Abort alone is insufficient: a transport may still deliver its earlier snapshot or failure.
    this.suggestionListSequence++; this.suggestionDetailSequence++;
    this.suggestionListAbort?.abort(); this.suggestionDetailAbort?.abort();
  }
  private resetSuggestionView() {
    this.invalidateSuggestionReads(); this.suggestionCheckSequence++;
    this.patchSuggestions({ open: null, items: [], nextOffset: null, listLoading: false, detailLoading: false, checking: false, detail: null, error: null, receipt: null, refreshFailed: false, conflictedId: null });
  }
  private suggestionScope() {
    const documentId = this.value.editor?.base.id, key = this.value.sessionKey, generation = this.openSequence;
    return { documentId, current: () => !!documentId && documentId === this.value.editor?.base.id && key === this.value.sessionKey && generation === this.openSequence };
  }
  canStartSuggestion() {
    const s = this.value;
    return !!this.suggestionApi && s.authorized && !s.pending && !s.opening && !s.suggestions.operation && !!s.editor && !!freezeSuggestionIntent(s.editor, s.sessionKey);
  }
  startSuggestion(): boolean {
    if (!this.canStartSuggestion() || this.value.suggestions.draft) return false;
    const intent = freezeSuggestionIntent(this.value.editor!, this.value.sessionKey)!;
    this.patchSuggestions({ open: "prompt", draft: { intent, instructions: "", prompt: "", replacement: "", advanced: false, composing: false, deleteConfirmed: false, copy: "idle" }, error: null, draftInvalid: false, conflictedId: null });
    return true;
  }
  resumeSuggestion() { if (this.value.suggestions.draft) this.patchSuggestions({ open: "prompt" }); }
  closeSuggestions() {
    this.invalidateSuggestionReads(); this.suggestionCheckSequence++;
    this.patchSuggestions({ open: null, listLoading: false, detailLoading: false, checking: false });
  }
  discardSuggestionDraft(confirmed: boolean) {
    if (confirmed && !this.value.pending && this.value.suggestions.operation?.kind !== "import") this.patchSuggestions({ draft: null, open: null, error: null });
  }
  updateSuggestionDraft(patch: Partial<Omit<SuggestionDraft, "intent" | "copy">>) {
    const draft = this.value.suggestions.draft;
    if (!draft || this.value.suggestions.operation?.kind === "import") return;
    this.patchSuggestions({ draft: { ...draft, ...patch, promptStale: draft.promptStale || patch.advanced !== undefined && patch.advanced !== draft.advanced || patch.instructions !== undefined && patch.instructions !== draft.instructions, copy: "idle" }, error: null });
  }
  generatePrompt() {
    const draft = this.value.suggestions.draft; if (!draft || this.value.suggestions.operation?.kind === "import") return;
    try { this.patchSuggestions({ draft: { ...draft, prompt: generateSuggestionPrompt(draft.intent, draft.instructions, draft.advanced), promptStale: false, copy: "idle" }, error: null }); }
    catch (error) { const code = error instanceof Error && ["content_too_large", "instructions_required", "invalid_unicode", "nul_character"].includes(error.message) ? error.message : "invalid_input"; this.patchSuggestions({ error: { status: 400, code } }); }
  }
  copiedPrompt(draft: SuggestionDraft, success: boolean) { if (this.value.suggestions.draft === draft && this.intentValid()) this.patchSuggestions({ draft: { ...draft, copy: success ? "copied" : "failed" } }); }
  intentValid() { const d = this.value.suggestions.draft; return !!d && !this.value.suggestions.draftInvalid && intentCurrent(d.intent, this.value.editor, this.value.sessionKey); }
  canImportSuggestion() {
    const d = this.value.suggestions.draft;
    return !!this.suggestionApi && !!d && this.intentValid() && !replacementError(d) && this.value.authorized && !this.value.pending && !this.value.opening && !this.value.suggestions.operation;
  }
  async importSuggestion() {
    if (!this.canImportSuggestion()) return false;
    const draft = this.value.suggestions.draft!;
    return this.runSuggestionWrite({ kind: "import", payload: frozenImport(draft), documentId: draft.intent.documentId, id: ++this.suggestionOperationSequence, phase: "pending" });
  }
  async showSuggestions(more = false) {
    if (!this.suggestionApi) return;
    const scope = this.suggestionScope(); if (!scope.documentId || more && this.value.suggestions.nextOffset === null) return;
    const sequence = ++this.suggestionListSequence, offset = more ? this.value.suggestions.nextOffset! : 0;
    this.suggestionListAbort?.abort(); const abort = this.suggestionListAbort = new AbortController();
    this.patchSuggestions({ open: "review", listLoading: true, error: null });
    try {
      const page = await this.suggestionApi.listDocumentSuggestions(scope.documentId, { limit: 50, offset }, abort.signal);
      if (!scope.current() || sequence !== this.suggestionListSequence) return;
      if (!Array.isArray(page.suggestions) || page.nextOffset !== null && (!Number.isSafeInteger(page.nextOffset) || page.nextOffset <= offset)) throw new Error("Invalid suggestion list");
      for (const row of page.suggestions) checkedSuggestionMetadata(row, scope.documentId);
      const items = new Map((more ? this.value.suggestions.items : []).map(s => [s.id, s]));
      for (const item of page.suggestions) items.set(item.id, item);
      this.patchSuggestions({ items: [...items.values()], nextOffset: page.nextOffset });
    } catch (e) { if (scope.current() && sequence === this.suggestionListSequence) this.suggestionReadFailure(e); }
    finally { if (scope.current() && sequence === this.suggestionListSequence) this.patchSuggestions({ listLoading: false }); }
  }
  async loadPendingCount() {
    if (!this.suggestionApi) return;
    const scope = this.suggestionScope(), documentId = scope.documentId; if (!documentId) return;
    const sequence = ++this.pendingCountSequence;
    try {
      const page = await this.suggestionApi.listDocumentSuggestions(documentId, { limit: 100, status: "pending" });
      if (!scope.current() || sequence !== this.pendingCountSequence) return;
      if (!Array.isArray(page.suggestions)) throw new Error("Invalid suggestion list");
      for (const row of page.suggestions) checkedSuggestionMetadata(row, documentId);
      this.patch({ pendingSuggestions: { documentId, count: page.suggestions.length, more: page.nextOffset !== null } });
    } catch {
      // The badge is advisory; a failed count must not raise a document error or change auth state.
      if (scope.current() && sequence === this.pendingCountSequence) this.patch({ pendingSuggestions: null });
    }
  }
  async previewSuggestion(id: string) {
    if (!this.suggestionApi) return;
    const scope = this.suggestionScope(); if (!scope.documentId) return;
    const sequence = ++this.suggestionDetailSequence;
    this.suggestionDetailAbort?.abort(); const abort = this.suggestionDetailAbort = new AbortController();
    this.patchSuggestions({ detail: null, detailLoading: true, error: null });
    try {
      const row = await this.suggestionApi.getDocumentSuggestion(scope.documentId, id, abort.signal);
      if (!scope.current() || sequence !== this.suggestionDetailSequence) return;
      this.rememberSuggestion(checkedSuggestion(row, scope.documentId, id));
    } catch (e) { if (scope.current() && sequence === this.suggestionDetailSequence) this.suggestionReadFailure(e); }
    finally { if (scope.current() && sequence === this.suggestionDetailSequence) this.patchSuggestions({ detailLoading: false }); }
  }
  canAcceptSuggestion() {
    const row = this.value.suggestions.detail;
    return !!this.suggestionApi && !!row && row.id !== this.value.suggestions.conflictedId && this.value.authorized && !this.value.pending && !this.value.opening && !this.value.suggestions.operation && suggestionApplicable(row, this.value.editor);
  }
  async acceptSuggestion(confirmed: boolean, expectedId?: string) {
    if (!confirmed || !this.canAcceptSuggestion() || expectedId !== undefined && expectedId !== this.value.suggestions.detail?.id) return false;
    const row = this.value.suggestions.detail!;
    return this.runSuggestionWrite({ kind: "accept", suggestionId: row.id, baseRevisionId: row.baseRevisionId, row, documentId: row.documentId, id: ++this.suggestionOperationSequence, phase: "pending" });
  }
  async rejectSuggestion(confirmed: boolean, expectedId?: string) {
    const row = this.value.suggestions.detail;
    if (!confirmed || !row || expectedId !== undefined && expectedId !== row.id || !this.suggestionApi || !this.value.authorized || this.value.pending || this.value.opening || this.value.suggestions.operation || row.status === "accepted" || row.documentId !== this.value.editor?.base.id) return false;
    return this.runSuggestionWrite({ kind: "reject", suggestionId: row.id, baseRevisionId: row.baseRevisionId, row, documentId: row.documentId, id: ++this.suggestionOperationSequence, phase: "pending" });
  }
  private suggestionReadFailure(error: unknown) {
    const parsed = failure(error); this.patchSuggestions({ error: parsed });
    if (parsed.status === 401) this.setAuthorized(false);
  }
  private rememberSuggestion(row: SuggestionDetail, confirmed = false) {
    // A validated write/reconciliation is newer than all outstanding display reads. Publish the
    // confirmed state and cleared loading flags together; later explicit reads get fresh generations.
    if (confirmed) this.invalidateSuggestionReads();
    const metadata = suggestionMetadata(row), items = this.value.suggestions.items;
    this.patchSuggestions({ ...(confirmed ? { listLoading: false, detailLoading: false } : {}), detail: row, items: items.some(s => s.id === row.id) ? items.map(s => s.id === row.id ? metadata : s) : [metadata, ...items],
      receipt: row.status === "accepted" ? metadata : this.value.suggestions.receipt });
  }
  private async runSuggestionWrite(operation: SuggestionOperation, retry = false): Promise<boolean> {
    const scope = this.suggestionScope();
    if (!this.suggestionApi || !scope.documentId || scope.documentId !== operation.documentId || !this.value.authorized || this.value.pending || this.value.opening) return false;
    if (retry && (this.value.suggestions.operation?.id !== operation.id || operation.phase !== "unknown")) return false;
    this.suggestionPendingId = operation.id;
    this.patch({ pending: "suggestion" }); this.patchSuggestions({ operation: { ...operation, phase: "pending" }, error: null });
    const current = () => scope.current() && this.value.suggestions.operation?.id === operation.id;
    try {
      if (operation.kind === "import") {
        const result = await this.suggestionApi.importDocumentSuggestion(operation.documentId, operation.payload);
        if (!current()) return false;
        const row = checkedSuggestion(result.suggestion, operation.documentId);
        if (!sameImport(row, operation.payload)) throw new Error("Invalid import response");
        this.rememberSuggestion(row, true); this.patchSuggestions({ operation: null, draft: null, open: "review" });
      } else if (operation.kind === "accept") {
        const result = await this.suggestionApi.acceptDocumentSuggestion(operation.documentId, operation.suggestionId, { expectedRevisionId: operation.baseRevisionId });
        if (!current()) return false;
        const row = operation.row;
        if (!row || result.suggestion.id !== operation.suggestionId || result.suggestion.documentId !== operation.documentId || result.suggestion.status !== "accepted" ||
          result.suggestion.baseRevisionId !== operation.baseRevisionId || !result.acceptedRevisionId || result.suggestion.acceptedRevisionId !== result.acceptedRevisionId || result.acceptedRevisionNumber < 1) throw new Error("Invalid acceptance receipt");
        const editor = createEditorSession(result.document);
        if (editor.base.id !== operation.documentId || editor.base.currentRevision.revisionNumber < result.acceptedRevisionNumber ||
          editor.base.currentRevision.revisionNumber === result.acceptedRevisionNumber && editor.base.currentRevision.id !== result.acceptedRevisionId) throw new Error("Invalid acceptance response");
        this.rememberSuggestion(checkedSuggestion({ ...result.suggestion, originalText: row.originalText, replacementText: row.replacementText }, operation.documentId, operation.suggestionId), true);
        this.patchSuggestions({ operation: null, refreshFailed: false, checking: false, listLoading: false, detailLoading: false });
        this.patch({ sessionKey: this.value.sessionKey + 1, editor: { ...editor, phase: "saved" }, remote: null, revisions: [], preview: null, nextBefore: null });
        this.remember(result.document); this.suggestionCheckSequence++;
      } else {
        const result = await this.suggestionApi.rejectDocumentSuggestion(operation.documentId, operation.suggestionId);
        if (!current()) return false;
        const row = operation.row;
        if (!row || result.suggestion.id !== operation.suggestionId || result.suggestion.documentId !== operation.documentId || result.suggestion.status !== "rejected") throw new Error("Invalid rejection response");
        this.rememberSuggestion(checkedSuggestion({ ...result.suggestion, originalText: row.originalText, replacementText: row.replacementText }, operation.documentId, operation.suggestionId), true); this.patchSuggestions({ operation: null });
      }
      return true;
    } catch (error) {
      if (current()) {
        const parsed = failure(error), unknown = retry || parsed.status === 0 || parsed.status >= 500 && !(parsed.status === 503 && ["storage_busy", "documents_unavailable"].includes(parsed.code ?? ""));
        this.patchSuggestions({ operation: unknown ? { ...operation, phase: "unknown" } : null, error: { ...parsed, unknownWrite: unknown }, ...(operation.kind === "import" && parsed.status === 409 ? { draftInvalid: true } : {}), ...(operation.kind !== "import" && parsed.status === 409 ? { conflictedId: operation.suggestionId } : {}) });
        if (parsed.status === 401) this.setAuthorized(false);
      }
      return false;
    } finally {
      // This global write slot belongs to the operation, even when its own Accept replaces the session.
      if (this.suggestionPendingId === operation.id) { this.suggestionPendingId = null; if (this.value.pending === "suggestion") this.patch({ pending: null }); }
    }
  }
  async retrySuggestionWrite(confirmed: boolean, expectedOperationId?: number) {
    const op = this.value.suggestions.operation;
    if (!confirmed || !op || expectedOperationId !== undefined && expectedOperationId !== op.id) return false;
    if (op.phase === "refresh") { await this.checkSuggestionOutcome(); return false; }
    return this.runSuggestionWrite(op, true);
  }
  async checkSuggestionOutcome() {
    const op = this.value.suggestions.operation, scope = this.suggestionScope();
    if (!op || op.phase === "pending" || !this.suggestionApi || this.value.pending || scope.documentId !== op.documentId) return;
    const sequence = ++this.suggestionCheckSequence;
    const current = () => scope.current() && sequence === this.suggestionCheckSequence && this.value.suggestions.operation?.id === op.id;
    this.patchSuggestions({ checking: true, error: null });
    try {
      if (op.phase !== "refresh") {
        let row: SuggestionDetail;
        if (op.kind === "import") {
          const page = await this.suggestionApi.listDocumentSuggestions(op.documentId, { limit: 1, offset: 0, importRequestId: op.payload.importRequestId });
          if (!current()) return;
          const found = page.suggestions.find(s => s.documentId === op.documentId && s.importRequestId === op.payload.importRequestId);
          if (!found) return; // Absence is not evidence of failure; retain the original operation.
          row = checkedSuggestion(await this.suggestionApi.getDocumentSuggestion(op.documentId, found.id), op.documentId, found.id);
          if (!current()) return;
          if (!sameImport(row, op.payload)) throw new Error("Invalid import receipt");
        } else {
          row = await this.suggestionApi.getDocumentSuggestion(op.documentId, op.suggestionId);
          if (!current()) return;
          checkedSuggestion(row, op.documentId, op.suggestionId);
        }
        this.rememberSuggestion(row, true);
        if (op.kind === "import") { this.patchSuggestions({ operation: null, draft: null, open: "review" }); return; }
        if (row.status === "pending") return; // The earlier POST may still commit.
        if (row.status === "rejected") { this.patchSuggestions({ operation: null }); return; }
        // A lost Reject can reveal another tab's Accept while this editor has a newer local draft.
        // The receipt resolves the operation, but it never authorizes replacing that draft.
        if (this.value.editor && (editorDirty(this.value.editor) || this.value.editor.composing || this.value.editor.unknownOutcome)) {
          this.patchSuggestions({ operation: null, error: { status: 409, code: "draft_changed" } }); return;
        }
        this.patchSuggestions({ operation: { ...op, phase: "refresh", receipt: suggestionMetadata(row) } });
      }
      const before = this.value.editor;
      const document = await this.api.getDocument(op.documentId);
      if (!current() || this.value.editor !== before) return;
      const editor = createEditorSession(document);
      const receipt = this.value.suggestions.operation?.receipt;
      if (document.id !== op.documentId || !receipt?.acceptedRevisionId || document.currentRevision.revisionNumber < receipt.baseRevisionNumber + 1 ||
        document.currentRevision.revisionNumber === receipt.baseRevisionNumber + 1 && document.currentRevision.id !== receipt.acceptedRevisionId) throw new Error("Invalid refreshed document");
      this.patchSuggestions({ operation: null, refreshFailed: false, checking: false, listLoading: false, detailLoading: false });
      this.patch({ sessionKey: this.value.sessionKey + 1, editor: { ...editor, phase: "saved" }, remote: null, revisions: [], preview: null, nextBefore: null }); this.remember(document);
    } catch (e) {
      if (current()) { this.suggestionReadFailure(e); this.patchSuggestions({ refreshFailed: this.value.suggestions.operation?.phase === "refresh" }); }
    } finally { if (scope.current() && sequence === this.suggestionCheckSequence) this.patchSuggestions({ checking: false }); }
  }

  async restore(source: DocumentRevision, confirmed: boolean): Promise<boolean> {
    const original = this.value.editor;
    if (confirmed !== true || !original || !this.value.authorized || this.value.pending || this.editorLocked() || original.composing || source.documentId !== original.base.id) return false;
    this.patch({ pending: "restore", error: null, restoreRefreshFailed: false, editor: { ...original, phase: "saving", selection: null } });
    try {
      const result = await this.api.restoreDocumentRevision(original.base.id, source.id, { expectedRevisionId: original.base.currentRevision.id });
      const editor = createEditorSession(result.document);
      if (editor.base.id !== original.base.id) throw new Error("Invalid document response");
      this.resetSuggestionView(); this.patch({ sessionKey: this.value.sessionKey + 1, editor: { ...editor, phase: "saved" }, remote: null, preview: null, revisions: [], nextBefore: null }); this.remember(result.document);
    } catch (e) { this.failWrite(e); this.patch({ pending: null }); return false; }
    // The write is already committed. A failed refresh must never be treated as a reason to POST again.
    await this.refreshAfterRestore();
    if (this.value.historyOpen) void this.history();
    this.patch({ pending: null }); return true;
  }
}
