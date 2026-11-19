import { t } from "@/i18n";
import type { DocumentWorkspaceModel, DocumentWorkspaceState } from "@/lib/document-workspace-model";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "./ui/dialog";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
import type { DocumentRevision } from "@agent-hub/shared";

export function DocumentHistory({ state: s, model, onRestore }: { state: DocumentWorkspaceState; model: DocumentWorkspaceModel; onRestore: (revision: DocumentRevision) => void }) {
  return <Dialog open={s.historyOpen} onOpenChange={open => { if (!open) model.closeHistory(); }}>
    <DialogContent className="flex h-[90dvh] max-h-dvh min-w-0 flex-col overflow-hidden max-md:h-dvh max-md:max-w-full! max-md:rounded-none md:max-w-3xl!">
      <DialogHeader><DialogTitle>{t("documents.history")}</DialogTitle><DialogDescription>{t("documents.preview")}</DialogDescription></DialogHeader>
      <div className="flex min-h-0 flex-1 gap-3 max-md:flex-col">
        <div className="w-48 shrink-0 space-y-2 overflow-y-auto max-md:max-h-40 max-md:w-full">
          {s.revisions.map(r => <Button key={r.id} variant={s.preview?.id === r.id ? "secondary" : "ghost"} className="h-auto w-full flex-col items-start text-left" onClick={() => void model.preview(r.id)}>
            <span className="max-w-full truncate">r{r.revisionNumber} · {r.title}</span><time className="text-xs">{r.createdAt}</time>
          </Button>)}
          {s.historyLoading ? <p>{t("documents.loading")}</p> : s.revisions.length === 0 ? <p>{t("documents.noHistory")}</p> : null}
          {s.nextBefore !== null && <Button variant="outline" disabled={s.historyLoading} onClick={() => void model.history(true)}>{t("documents.more")}</Button>}
          {s.historyError && <div role="alert"><p>{t("documents.failed", { status: s.historyError.status })}</p><Button onClick={() => void model.history()}>{t("documents.refresh")}</Button></div>}
        </div>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
          {s.previewLoading ? <p>{t("documents.loading")}</p> : s.preview && <>
            <h2 className="break-words font-semibold">r{s.preview.revisionNumber} · {s.preview.title}</h2>
            {s.preview.restoredFromRevisionId && <p className="break-all text-xs">{t("documents.restoredFrom", { id: s.preview.restoredFromRevisionId })}</p>}
            <Textarea aria-label={t("documents.preview")} readOnly value={s.preview.content} className="min-h-32 flex-1 resize-none overflow-y-auto [field-sizing:fixed]" />
            <Button disabled={!s.authorized || !!s.pending || !!s.editor?.composing} onClick={() => { const r = s.preview!; model.closeHistory(); onRestore(r); }}>{t("documents.restore")}</Button>
          </>}
        </div>
      </div>
    </DialogContent>
  </Dialog>;
}
