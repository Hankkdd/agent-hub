import { DocumentRoom } from "./document-room";
import { ResizablePanel } from "./resizable-panel";
import { DocumentSuggestions, SuggestionOperationNotice } from "./document-suggestions";
import { useEffect, useState } from "react";
import { ArrowLeft, Plus, RefreshCw } from "lucide-react";
import type { DocumentRevision, Task } from "@agent-hub/shared";
import { t, useLanguage } from "@/i18n";
import { client } from "@/lib/client";
import { editorDirty } from "@/lib/document-editor-state";
import { documentTitleError } from "@/lib/document-text";
import type { DocumentFailure, DocumentWorkspaceModel, DocumentWorkspaceState } from "@/lib/document-workspace-model";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "./ui/dialog";
import { DocumentEditor, validationMessage } from "./document-editor";
import { DocumentHistory } from "./document-history";
import { cn } from "@/lib/utils";

type Action = { kind: "discard" | "new" | "latest" } | { kind: "open"; id: string } | { kind: "restore"; revision: DocumentRevision };
export function documentFailureMessage(error: DocumentFailure): string {
  if (error.code === "draft_changed") return t("documents.changed");
  if (error.unknownWrite) return t("documents.unknown");
  if (error.status === 0) return t("documents.readFailed");
  if (error.status === 401) return t("documents.auth");
  if (error.status === 409) return t("documents.conflict");
  if (error.status === 404) return t("documents.notFound");
  if (error.status === 413) return t("documents.content_too_large");
  if (error.status === 503 && error.code === "storage_busy") return t("documents.busy", { seconds: error.retryAfterSeconds ?? 1 });
  return t("documents.failed", { status: error.status });
}
export function DocumentCreateWarning({ onInspect, disabled }: { onInspect: () => void; disabled: boolean }) {
  return <div role="alert" data-document-create-unknown="" className="space-y-2 border-b p-3 text-sm">
    <p>{t("documents.createUnknown")}</p>
    <Button variant="outline" size="sm" disabled={disabled} onClick={onInspect}>{t("documents.inspectCreates")}</Button>
  </div>;
}
export function DocumentCreateForm({ title, onTitle, unknown, acknowledged, onAcknowledge, error, pending, authorized, onInspect, onCreate }: {
  title: string; onTitle: (title: string) => void; unknown: number | null; acknowledged: number | null;
  onAcknowledge: (version: number | null) => void; error: DocumentFailure | null; pending: boolean; authorized: boolean;
  onInspect: () => void; onCreate: (acknowledged?: number) => Promise<void>;
}) {
  const allowed = !pending && authorized && !documentTitleError(title) && (unknown === null || acknowledged === unknown);
  return <>
    <Input aria-label={t("documents.titleLabel")} value={title} onChange={e => onTitle(e.currentTarget.value)} disabled={pending} />
    {title && documentTitleError(title) && <p role="alert">{validationMessage(documentTitleError(title))}</p>}
    {unknown !== null && <>
      <DocumentCreateWarning onInspect={onInspect} disabled={pending} />
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1 shrink-0" disabled={pending}
        checked={acknowledged === unknown} onChange={e => onAcknowledge(e.currentTarget.checked ? unknown : null)} />{t("documents.createRisk")}</label>
    </>}
    {error && !error.unknownWrite && <p role="alert">{documentFailureMessage(error)}</p>}
    <Button disabled={!allowed} onClick={async () => { if (allowed) await onCreate(unknown === null ? undefined : acknowledged!); }}>{t("documents.new")}</Button>
  </>;
}
export function DocumentWorkspace({ model, state: s, active, documentId, onDocument, onBack, initialRoom }: {
  model: DocumentWorkspaceModel; state: DocumentWorkspaceState; active: boolean; documentId?: string;
  initialRoom?: Task; onDocument: (id?: string) => void; onBack: () => void;
}) {
  const language = useLanguage();
  const [confirm, setConfirm] = useState<Action | null>(null);
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [acknowledgedCreate, setAcknowledgedCreate] = useState<number | null>(null);
  const [remoteOpen, setRemoteOpen] = useState(false);
  const [authBusy, setAuthBusy] = useState(false);
  const [listCollapsed, setListCollapsed] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const openCreate = () => { setAcknowledgedCreate(null); setCreating(true); };
  const inspectCreates = () => { setAcknowledgedCreate(null); setCreating(false); setListOpen(true); void model.list(); };
  const modal = !!confirm || creating || remoteOpen || s.historyOpen || listOpen || s.suggestions.open !== null;
  useEffect(() => {
    if (active) void model.list();
    else { model.clearSelection(); model.closeHistory(); model.closeSuggestions(); setConfirm(null); setRemoteOpen(false); setListOpen(false); }
  }, [active, model]);
  useEffect(() => { if (!active || !documentId) model.clearSelection(); }, [active, documentId, model]);
  // Recount after any change that can add or resolve a suggestion: a new revision, an operation ending, the panel closing.
  const countKey = active && s.editor && !s.suggestions.operation && !s.suggestions.open ? `${s.editor.base.id}:${s.editor.base.currentRevision.id}` : null;
  useEffect(() => { if (countKey) void model.loadPendingCount(); }, [countKey, model]);
  const pendingBadge = s.pendingSuggestions && s.pendingSuggestions.documentId === s.editor?.base.id && s.pendingSuggestions.count > 0
    ? `${s.pendingSuggestions.count}${s.pendingSuggestions.more ? "+" : ""}` : null;
  useEffect(() => {
    if (!active || !documentId || documentId === model.getSnapshot().editor?.base.id) return;
    if (model.protectedDraft()) setConfirm({ kind: "open", id: documentId });
    else void model.open(documentId);
  }, [active, documentId, model]);
  useEffect(() => {
    if (!(creating && newTitle)) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [creating, newTitle]);
  const open = (id: string) => {
    if (id === s.editor?.base.id) { onDocument(id); setListOpen(false); return; }
    if (model.protectedDraft()) setConfirm({ kind: "open", id });
    else void model.open(id).then(ok => { if (ok) { onDocument(id); setListOpen(false); } });
  };
  const perform = async (action: Action) => {
    switch (action.kind) {
      case "discard": model.discard(true); break;
      case "new": openCreate(); break;
      case "open": if (await model.open(action.id, true)) { onDocument(action.id); setListOpen(false); } else return; break;
      case "latest": if (s.editor && !await model.open(s.editor.base.id, true, true)) return; setRemoteOpen(false); break;
      case "restore": if (!await model.restore(action.revision, true)) return; break;
    }
    setConfirm(null);
  };
  const needle = filter.trim().toLocaleLowerCase(language);
  const shown = needle ? s.documents.filter(d => d.title.toLocaleLowerCase(language).includes(needle)) : s.documents;
  const documents = <div className="flex min-h-0 w-full flex-1 flex-col gap-2 overflow-y-auto p-3">
    <div className="flex shrink-0 items-center gap-1">
      <Input aria-label={t("documents.filter")} placeholder={t("documents.filter")} title={t("documents.createdOrder")} value={filter} onChange={e => setFilter(e.currentTarget.value)} className="h-8" />
      <Button variant="ghost" size="icon" className="size-8 shrink-0" aria-label={t("documents.refresh")} title={t("documents.refresh")} disabled={s.listLoading} onClick={() => void model.list()}><RefreshCw /></Button>
    </div>
    {needle && s.nextOffset !== null && <p className="text-xs text-muted-foreground">{t("documents.filterPartial")}</p>}
    {needle && !shown.length && <p className="text-sm text-muted-foreground">{t("documents.noMatch")}</p>}
    {shown.map(d => <button key={d.id} className={cn("rounded border p-3 text-left hover:bg-accent", d.id === s.editor?.base.id && "bg-accent")}
      onClick={() => open(d.id)} disabled={!!s.pending}>
      <span className="block truncate font-medium">{d.title}{d.id === s.editor?.base.id && model.protectedDraft() ? " *" : ""}</span>
      <time className="block text-xs text-muted-foreground">{t("documents.updated", { time: new Date(d.updatedAt).toLocaleString(language) })}</time>
    </button>)}
    {s.listLoading ? <p role="status">{t("documents.loading")}</p> : !s.documents.length && !s.listError ? <p>{t("documents.empty")}</p> : null}
    {s.listError && <p role="alert">{documentFailureMessage(s.listError)}</p>}
    {s.nextOffset !== null && <Button variant="outline" disabled={s.listLoading} onClick={() => void model.list(true)}>{t("documents.more")}</Button>}
  </div>;
  return <div hidden={!active} className={cn("document-workspace min-h-0 min-w-0 flex-1 flex-col", active ? "flex" : "hidden")}
    onKeyDownCapture={e => {
      if (e.target instanceof HTMLElement && (e.target.closest('[role="dialog"]') || e.target.closest("[data-room-controls]"))) return;
      if (active && !modal && (e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "s") {
        e.preventDefault(); if (!e.nativeEvent.isComposing && !s.editor?.composing) void model.save();
      }
    }}>
    <header className="flex shrink-0 items-center gap-2 border-b p-3">
      <Button variant="ghost" size="sm" className="shrink-0" onClick={() => s.editor && documentId ? onDocument() : onBack()}>
        <ArrowLeft /><span className="max-sm:sr-only">{t(documentId && s.editor ? "documents.backToList" : "navigation.backToList")}</span></Button>
      <h1 className="min-w-0 flex-1 truncate font-semibold">{documentId && s.editor ? s.editor.base.currentRevision.title : t("documents.title")}</h1>
      <Button size="sm" variant="ghost" className="hidden lg:inline-flex" onClick={() => setListCollapsed(v => !v)}>{t("room.toggleList")}</Button>
      <Button className="hidden shrink-0 md:inline-flex lg:hidden" variant="outline" size="sm" onClick={() => setListOpen(true)}>{t("documents.title")}</Button>
      <Button size="sm" className="shrink-0" disabled={!!s.pending} onClick={() => model.protectedDraft() ? setConfirm({ kind: "new" }) : openCreate()}>
        <Plus /><span className="max-sm:sr-only">{t("documents.new")}</span></Button>
    </header>
    {!s.authorized && <div role="alert" className="border-b p-3 text-sm"><p>{t("documents.auth")}</p>
      <Button size="sm" disabled={authBusy} onClick={() => { setAuthBusy(true); void client.reconnect().catch(() => undefined).finally(() => setAuthBusy(false)); }}>{t("documents.recheck")}</Button></div>}
    {s.createUnknown !== null && <DocumentCreateWarning onInspect={inspectCreates} disabled={!!s.pending} />}
    {s.error && <div role="alert" className="border-b p-3 text-sm text-destructive">{documentFailureMessage(s.error)}</div>}
    {s.editor?.unknownOutcome && !s.error && <p role="alert" className="p-3 text-sm">{t("documents.unknown")}</p>}
    {!s.suggestions.open && <SuggestionOperationNotice state={s} model={model} onInspect={() => {
      const op = s.suggestions.operation; if (!op) return;
      if (s.editor?.base.id === op.documentId) void model.checkSuggestionOutcome(); else open(op.documentId);
    }} />}
    {s.suggestions.error && !s.suggestions.open && <p role="alert" className="p-3 text-sm">{t("suggestions.readOperationFailed")}</p>}
    {s.opening && <p role="status" className="p-2">{t("documents.loading")}</p>}
    {s.restoreRefreshFailed && <div role="alert" className="p-3 text-sm">{t("documents.restoreRefreshFailed")} <Button size="sm" disabled={!!s.pending || !!s.editor && editorDirty(s.editor)} onClick={() => void model.refreshAfterRestore()}>{t("documents.refresh")}</Button></div>}
    {(s.editor?.phase === "conflict" || s.editor?.unknownOutcome) && <div className="flex flex-wrap gap-2 p-3"><Button variant="outline" onClick={() => { setRemoteOpen(true); void model.loadRemote(); }}>{t("documents.remote")}</Button>
      <Button variant="outline" onClick={() => setConfirm({ kind: "latest" })}>{t("documents.loadLatest")}</Button></div>}
    <div className="flex min-h-0 min-w-0 flex-1">
      <ResizablePanel storageKey="document-list-width" defaultWidth={224} minWidth={160} maxWidth={400} className={cn("min-h-0 border-r", listCollapsed ? "hidden" : "lg:flex", documentId && s.editor ? "hidden" : "flex max-md:w-full md:hidden")}><aside className="flex min-h-0 w-full" aria-label={t("documents.title")}>{documents}</aside></ResizablePanel>
      <div className={cn("min-h-0 min-w-0 flex-1 flex-col", !documentId ? "hidden md:flex" : "flex")}>
        {s.editor ? <DocumentRoom key={s.editor.base.id} model={model} state={s} initialRoom={initialRoom?.options.room?.documentId === s.editor.base.id ? initialRoom : undefined}><DocumentEditor key={s.sessionKey} session={s.editor} model={model} active={active} pending={s.pending} authorized={s.authorized} modal={modal} pendingCount={pendingBadge}
          onPrompt={() => s.suggestions.draft ? model.resumeSuggestion() : model.startSuggestion()} onConvert={() => model.convert(true)} onSuggestions={() => void model.showSuggestions()} onDiscard={() => setConfirm({ kind: "discard" })} onHistory={() => void model.history()} /></DocumentRoom> : <p className="p-6 text-muted-foreground">{t("documents.pick")}</p>}
      </div>
    </div>
    <Dialog open={listOpen} onOpenChange={setListOpen}><DialogContent className="flex max-h-[85dvh] flex-col overflow-hidden"><DialogHeader><DialogTitle>{t("documents.title")}</DialogTitle><DialogDescription>{t("documents.createdOrder")}</DialogDescription></DialogHeader>{listOpen && documents}</DialogContent></Dialog>
    <DocumentSuggestions state={s} model={model} active={active} onInspectLatest={() => { model.closeSuggestions(); setRemoteOpen(true); void model.loadRemote(); }} onInspectOperation={() => {
      const op = s.suggestions.operation; if (!op) return;
      if (s.editor?.base.id === op.documentId) void model.checkSuggestionOutcome(); else open(op.documentId);
    }} />
    <DocumentHistory state={s} model={model} onRestore={revision => setConfirm({ kind: "restore", revision })} />
    <Dialog open={!!confirm} onOpenChange={open => { if (!open && !s.pending) { setConfirm(null); if (documentId && s.editor?.base.id !== documentId) onDocument(s.editor?.base.id); } }}>
      <DialogContent><DialogHeader><DialogTitle>{confirm?.kind === "restore" ? t("documents.restore") : t("documents.dirty")}</DialogTitle>
        <DialogDescription>{confirm?.kind === "restore" ? t("documents.restoreConfirm", { number: confirm.revision.revisionNumber }) : t("documents.dirtyConfirm")} {confirm?.kind === "restore" && s.editor && editorDirty(s.editor) ? t("documents.dirtyConfirm") : null}</DialogDescription></DialogHeader>
        {s.error && <p role="alert" className="text-sm text-destructive">{documentFailureMessage(s.error)}</p>}
        <DialogFooter><Button variant="outline" disabled={!!s.pending} onClick={() => { setConfirm(null); if (documentId && s.editor?.base.id !== documentId) onDocument(s.editor?.base.id); }}>{t("documents.cancel")}</Button>
          {confirm && !["discard", "latest"].includes(confirm.kind) && s.editor && editorDirty(s.editor) && <Button disabled={!!s.pending || !s.authorized || s.editor.phase === "conflict"} onClick={async () => {
            const action = confirm; if (await model.save() && !model.protectedDraft()) await perform(action);
          }}>{t("documents.saveContinue")}</Button>}
          <Button disabled={!!s.pending || !!s.editor?.composing} onClick={() => { if (confirm) void perform(confirm); }}>{confirm?.kind === "restore" ? t("documents.confirm") : t("documents.discardContinue")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    <Dialog open={creating} onOpenChange={open => { if (!s.pending) { setCreating(open); setAcknowledgedCreate(null); } }}><DialogContent className="max-h-[90dvh] overflow-y-auto"><DialogHeader><DialogTitle>{t("documents.new")}</DialogTitle><DialogDescription>{t("documents.localOnly")}</DialogDescription></DialogHeader>
      <DocumentCreateForm title={newTitle} onTitle={setNewTitle} unknown={s.createUnknown} acknowledged={acknowledgedCreate}
        onAcknowledge={setAcknowledgedCreate} error={s.createError} pending={!!s.pending} authorized={s.authorized} onInspect={inspectCreates}
        onCreate={async acknowledged => {
          setAcknowledgedCreate(null);
          const id = await model.create(newTitle, true, acknowledged);
          if (id) { setCreating(false); setNewTitle(""); onDocument(id); }
        }} />
    </DialogContent></Dialog>
    <Dialog open={remoteOpen} onOpenChange={setRemoteOpen}><DialogContent className="flex h-[85dvh] flex-col"><DialogHeader><DialogTitle>{t("documents.remoteTitle")}</DialogTitle><DialogDescription>{t("documents.conflict")}</DialogDescription></DialogHeader>
      {s.remote ? <><h2>r{s.remote.currentRevision.revisionNumber} · {s.remote.currentRevision.title}</h2><Textarea readOnly aria-label={t("documents.remoteTitle")} value={s.remote.currentRevision.content} className="min-h-0 flex-1 resize-none [field-sizing:fixed]" /></> : <p>{s.error ? documentFailureMessage(s.error) : t("documents.loading")}</p>}
      {!s.remote && s.error && <Button onClick={() => void model.loadRemote()}>{t("documents.refresh")}</Button>}
      <Button disabled={!!s.pending} onClick={() => setConfirm({ kind: "latest" })}>{t("documents.loadLatest")}</Button>
    </DialogContent></Dialog>
  </div>;
}
