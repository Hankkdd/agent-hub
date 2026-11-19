import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import type { SuggestionMetadata } from "@agent-hub/shared";
import { t, useLanguage } from "@/i18n";
import { cn } from "@/lib/utils";
import type { DocumentFailure, DocumentWorkspaceModel, DocumentWorkspaceState } from "@/lib/document-workspace-model";
import { suggestionApplicable } from "@/lib/document-suggestions";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";
import { DocumentSuggestionPrompt, suggestionValidation } from "./document-suggestion-prompt";
import { DocumentSuggestionDiff } from "./document-suggestion-diff";

export function suggestionFailure(error: DocumentFailure): string {
  if (error.status === 401) return t("documents.auth");
  if (error.status === 409) return t("suggestions.conflict");
  if (error.unknownWrite) return t("suggestions.unknown");
  if (error.status === 0) return t("documents.readFailed");
  if (["instructions_required", "content_too_large", "no_change", "delete_confirmation", "nul_character", "invalid_unicode", "lf_required"].includes(error.code ?? "")) return suggestionValidation(error.code!)!;
  if (error.status === 503) return t("documents.busy", { seconds: error.retryAfterSeconds ?? 1 });
  return t("documents.failed", { status: error.status });
}
export function SuggestionOperationNotice({ model, state, onInspect }: { model: DocumentWorkspaceModel; state: DocumentWorkspaceState; onInspect: () => void }) {
  const op = state.suggestions.operation;
  const [retry, setRetry] = useState<number | null>(null);
  useEffect(() => setRetry(null), [op?.id, op?.phase]);
  if (!op || op.phase === "pending") return null;
  const own = op.documentId === state.editor?.base.id;
  return <div role="alert" data-suggestion-unknown="" className="space-y-2 rounded border p-3 text-sm">
    <p className="break-all">{t(op.phase === "refresh" ? "suggestions.refreshFailed" : "suggestions.unknown")}</p>
    <p className="break-all">{t("suggestions.operationDocument", { document: op.documentId })}</p>
    <Button variant="outline" size="sm" disabled={!!state.pending || state.suggestions.checking} onClick={onInspect}>{t(own ? "suggestions.checkOutcome" : "suggestions.openOutcome")}</Button>
    {own && op.phase === "unknown" && <>
      <label className="flex items-start gap-2"><input type="checkbox" checked={retry === op.id} onChange={e => setRetry(e.currentTarget.checked ? op.id : null)} />{t("suggestions.retryConfirm")}</label>
      <Button variant="outline" size="sm" disabled={retry !== op.id || !!state.pending || state.suggestions.checking || !state.authorized}
        onClick={() => { setRetry(null); void model.retrySuggestionWrite(true, op.id); }}>{t("suggestions.retry")}</Button>
    </>}
    {state.suggestions.checking && <p role="status">{t("documents.loading")}</p>}
  </div>;
}
function SuggestionRow({ item, selected, language, onOpen }: { item: SuggestionMetadata; selected: boolean; language: string; onOpen: () => void }) {
  return <button className={cn("flex w-full flex-wrap items-center gap-x-2 rounded border p-2 text-left text-sm hover:bg-accent", selected && "bg-accent")} data-suggestion-id={item.id} onClick={onOpen}>
    <span className={cn("rounded-full border px-2 text-xs", item.status === "pending" && "border-primary")}>{t(`suggestions.${item.status}`)}</span>
    <time className="text-muted-foreground">{new Date(item.createdAt).toLocaleString(language)}</time>
    <span className="text-xs text-muted-foreground">{t("suggestions.basedOn", { number: item.baseRevisionNumber })}</span>
  </button>;
}
export function DocumentSuggestions({ model, state: s, active, onInspectOperation, onInspectLatest }: { model: DocumentWorkspaceModel; state: DocumentWorkspaceState; active: boolean; onInspectOperation: () => void; onInspectLatest: () => void }) {
  const language = useLanguage();
  const view = s.suggestions, row = view.detail;
  const [confirm, setConfirm] = useState<{ kind: "accept" | "reject"; id: string } | null>(null);
  useEffect(() => setConfirm(null), [row?.id, view.open]);
  const pendingItems = view.items.filter(item => item.status === "pending"), resolved = view.items.filter(item => item.status !== "pending");
  // Opening the panel shows the first pending suggestion instead of an empty detail pane.
  const firstPending = view.open === "review" && !row && !view.error && !view.detailLoading && !view.listLoading ? pendingItems[0]?.id : undefined;
  useEffect(() => { if (active && firstPending) void model.previewSuggestion(firstPending); }, [active, firstPending, model]);
  const stale = row?.status === "pending" && (!suggestionApplicable(row, s.editor) || view.conflictedId === row.id);
  return <Dialog open={active && view.open !== null} onOpenChange={open => { if (!open) { setConfirm(null); model.closeSuggestions(); } }}>
    <DialogContent className={cn("flex max-h-[92dvh] min-w-0 flex-col overflow-hidden max-md:h-dvh max-md:max-h-dvh max-md:max-w-full! max-md:rounded-none", view.open === "prompt" ? "sm:max-w-2xl" : "h-[92dvh] sm:max-w-5xl")} onKeyDownCapture={e => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); e.stopPropagation(); }
    }}>
      <DialogHeader><DialogTitle>{t(view.open === "prompt" ? "suggestions.promptTitle" : "suggestions.title")}</DialogTitle>
        <DialogDescription>{t(view.open === "prompt" ? "suggestions.promptDescription" : "suggestions.reviewDescription")}</DialogDescription></DialogHeader>
      {view.error && <p role="alert" className="shrink-0 text-sm text-destructive">{suggestionFailure(view.error)}</p>}
      <SuggestionOperationNotice model={model} state={s} onInspect={onInspectOperation} />
      {view.open === "prompt" ? <DocumentSuggestionPrompt model={model} state={s} /> : <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-x-hidden overflow-y-auto" data-suggestion-review="">
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="ghost" size="sm" aria-label={t("documents.refresh")} title={t("documents.refresh")} disabled={view.listLoading} onClick={() => void model.showSuggestions()}><RefreshCw /></Button>
          {view.draft && <Button variant="outline" size="sm" onClick={() => model.resumeSuggestion()}>{t("suggestions.resume")}</Button>}</div>
        {view.items.length === 0 && !view.listLoading && <p className="text-sm text-muted-foreground">{t("suggestions.empty")}</p>}
        <div className="max-h-40 shrink-0 space-y-1 overflow-y-auto">
          {view.items.length > 0 && !pendingItems.length && <p className="text-sm text-muted-foreground">{t("suggestions.noPending")}</p>}
          {pendingItems.map(item => <SuggestionRow key={item.id} item={item} selected={row?.id === item.id} language={language} onOpen={() => void model.previewSuggestion(item.id)} />)}
          {resolved.length > 0 && <details className="text-sm"><summary className="cursor-pointer py-1 text-muted-foreground select-none">{t("suggestions.resolved", { count: resolved.length })}</summary>
            <div className="space-y-1">{resolved.map(item => <SuggestionRow key={item.id} item={item} selected={row?.id === item.id} language={language} onOpen={() => void model.previewSuggestion(item.id)} />)}</div>
          </details>}
        </div>
        {view.nextOffset !== null && <Button variant="outline" disabled={view.listLoading} onClick={() => void model.showSuggestions(true)}>{t("documents.more")}</Button>}
        {(view.listLoading || view.detailLoading) && <p role="status">{t("documents.loading")}</p>}
        {row && <div className="space-y-3" data-suggestion-detail={row.id}>
          <p className="text-sm"><span className="font-medium">{t(`suggestions.${row.status}`)}</span> · {t("suggestions.basedOn", { number: row.baseRevisionNumber })} · {t("suggestions.lastRead", { number: s.editor?.base.currentRevision.revisionNumber ?? "?" })}</p>
          {row.acceptedRevisionId && <p className="rounded border p-2 text-sm" data-suggestion-receipt="">{t("suggestions.receipt", { number: row.baseRevisionNumber + 1 })}</p>}
          {stale && <div role="alert" className="flex flex-wrap items-center gap-2 rounded border p-2 text-sm"><span className="min-w-0 flex-1">{t("suggestions.stale")}</span>
            <Button size="sm" variant="outline" disabled={!!s.pending || model.editorLocked()} onClick={onInspectLatest}>{t("documents.remote")}</Button></div>}
          <DocumentSuggestionDiff key={row.id} original={row.originalText} replacement={row.replacementText} />
          {confirm && confirm.id === row.id ? <div className="space-y-2 rounded border p-2" data-suggestion-confirm="">
            <p>{t(confirm.kind === "accept" ? row.replacementText === "" ? "suggestions.acceptDeleteConfirm" : "suggestions.acceptConfirm" : "suggestions.rejectConfirm")}</p>
            <div className="flex flex-wrap gap-2"><Button variant="outline" onClick={() => setConfirm(null)}>{t("documents.cancel")}</Button>
              <Button disabled={!!s.pending || !!view.operation || !s.authorized || confirm.kind === "accept" && !model.canAcceptSuggestion()} onClick={async () => {
                const target = confirm; setConfirm(null);
                if (target.kind === "accept") await model.acceptSuggestion(true, target.id); else await model.rejectSuggestion(true, target.id);
              }}>{t(confirm.kind === "accept" ? "suggestions.confirmAccept" : "suggestions.confirmReject")}</Button></div>
          </div> : <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={!!s.pending || !!view.operation || row.status === "accepted" || !s.authorized} onClick={() => setConfirm({ kind: "reject", id: row.id })}>{t("suggestions.reject")}</Button>
            <Button disabled={!model.canAcceptSuggestion()} onClick={() => setConfirm({ kind: "accept", id: row.id })}>{t("suggestions.accept")}</Button></div>}
        </div>}
      </div>}
    </DialogContent>
  </Dialog>;
}
