import { History, MoreHorizontal, Undo2, ListChecks, WandSparkles } from "lucide-react";
import { SUGGESTION_SELECTION_BYTES } from "@agent-hub/shared";
import { t } from "@/i18n";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Textarea } from "./ui/textarea";
import { Button } from "./ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./ui/dropdown-menu";
import { documentTextStats } from "@/lib/document-text";
import { editorDirty, editorValidation, type EditorSession } from "@/lib/document-editor-state";
import { utf8Bytes } from "@/lib/document-suggestions";
import type { DocumentWorkspaceModel } from "@/lib/document-workspace-model";

export function validationMessage(code: string | null): string | null {
  switch (code) {
    case null: return null;
    case "composing": return t("documents.composing");
    case "invalid_title": return t("documents.invalid_title");
    case "invalid_unicode": return t("documents.invalid_unicode");
    case "nul_character": return t("documents.nul_character");
    case "content_too_large": return t("documents.content_too_large");
    case "lf_required": return t("documents.lf_required");
    default: return t("documents.invalid_input");
  }
}
/** Why a nonempty selection cannot start a suggestion, so the button never fails silently. */
export function suggestionGateKey(s: EditorSession): "suggestions.gateDirty" | "suggestions.gateLarge" | "suggestions.gateBusy" {
  if (editorDirty(s) || s.selection?.source === "draft") return "suggestions.gateDirty";
  if (s.selection && utf8Bytes(s.selection.text) > SUGGESTION_SELECTION_BYTES) return "suggestions.gateLarge";
  return "suggestions.gateBusy";
}
export function DocumentEditor({ session: s, model, active, pending, authorized, modal, pendingCount, onConvert, onDiscard, onHistory, onPrompt, onSuggestions }: {
  session: EditorSession; model: DocumentWorkspaceModel; active: boolean; pending: string | null; authorized: boolean;
  modal: boolean; pendingCount: string | null; onConvert: () => void; onDiscard: () => void; onHistory: () => void; onPrompt: () => void; onSuggestions: () => void;
}) {
  const validation = editorValidation(s), dirty = editorDirty(s);
  let stats: ReturnType<typeof documentTextStats> | null = null;
  try { stats = documentTextStats(s.rawInput); } catch { /* Invalid raw input remains visible and unsaveable. */ }
  const state = pending ? "saving" : s.phase === "conflict" ? "conflict" : s.phase === "error" ? "error" : dirty ? "dirty" : s.phase === "saved" ? "saved" : "clean";
  const draft = !!model.getSnapshot().suggestions.draft, canSuggest = model.canStartSuggestion() || draft;
  const canSave = authorized && !pending && !validation && s.phase !== "conflict" && (dirty || s.unknownOutcome);
  const fullStats = t("documents.stats", { words: stats?.englishWords ?? "—", characters: stats?.unicodeCharacters ?? "—", bytes: stats ? s.textBase.conversion === "required" ? new TextEncoder().encode(s.textBase.content).byteLength : stats.utf8Bytes : "—" });
  return <section className="document-editor flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-y-auto p-3 md:p-5" aria-label={t("documents.body")}
    onKeyDown={event => {
      if (!event.defaultPrevented && active && !modal && (event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "s") {
        event.preventDefault(); if (!event.nativeEvent.isComposing && !s.composing) void model.save();
      }
    }}
    onCompositionStart={() => model.composing(true)} onCompositionEnd={() => model.composing(false)}>
    <div className="flex shrink-0 items-center gap-2">
      <span role="status" aria-live="polite" className="min-w-0 flex-1 truncate text-sm text-muted-foreground">{t(`documents.${state}`)}</span>
      <Button size="sm" variant="outline" disabled={!canSuggest} onPointerDown={e => e.preventDefault()} onClick={onPrompt}
        aria-label={t(draft ? "suggestions.resume" : "suggestions.start")}>
        <WandSparkles /><span className="max-sm:sr-only">{t(draft ? "suggestions.resume" : "suggestions.start")}</span>
      </Button>
      <Button size="sm" onClick={() => void model.save()} disabled={!canSave}>{t("documents.save")}</Button>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button size="sm" variant="outline" className="relative" aria-label={t("documents.actions")}>
            <MoreHorizontal />
            {pendingCount && <span className="absolute -top-1.5 -right-1.5 rounded-full bg-primary px-1 text-[10px] leading-4 text-primary-foreground" aria-hidden>{pendingCount}</span>}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={onSuggestions}><ListChecks />{t("suggestions.title")}{pendingCount && <span className="ml-auto text-xs text-muted-foreground">{t("suggestions.pendingCount", { count: pendingCount })}</span>}</DropdownMenuItem>
          <DropdownMenuItem onSelect={onHistory}><History />{t("documents.history")}</DropdownMenuItem>
          <DropdownMenuItem disabled={!!pending || !dirty && !s.unknownOutcome} onSelect={onDiscard}><Undo2 />{t("documents.discard")}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
    {s.selection && !canSuggest && <div role="status" className="flex shrink-0 flex-wrap items-center gap-2 rounded border px-3 py-2 text-sm" data-suggestion-gate="">
      <span className="min-w-0 flex-1">{t(suggestionGateKey(s))}</span>
      {suggestionGateKey(s) === "suggestions.gateDirty" && canSave && <Button size="sm" variant="outline" onClick={() => void model.save()}>{t("documents.save")}</Button>}
    </div>}
    <div className="shrink-0 space-y-1"><Label htmlFor="document-title">{t("documents.titleLabel")}</Label>
      <Input id="document-title" value={s.title} disabled={pending === "restore" || model.editorLocked()} onChange={e => model.title(e.currentTarget.value)}
        onCompositionEnd={e => { model.title(e.currentTarget.value); model.composing(false); }} aria-invalid={!!validation && validation === "invalid_title"} />
    </div>
    {s.textBase.conversion === "required" && <div className="flex shrink-0 flex-wrap items-center gap-2 rounded border px-3 py-2 text-sm" data-document-convert="">
      <p className="min-w-0 flex-1">{t("documents.convertNote")}</p>
      <Button variant="outline" size="sm" disabled={!!pending} onClick={onConvert}>{t("documents.convert")}</Button></div>}
    {validation && <p role="alert" className="shrink-0 text-sm text-destructive">{validationMessage(validation)}</p>}
    <Label htmlFor="document-body" className="sr-only">{t("documents.body")}</Label>
    <Textarea id="document-body" value={s.rawInput} readOnly={s.textBase.conversion === "required" || pending === "restore" || model.editorLocked()}
      spellCheck={false} autoCorrect="off" autoCapitalize="off" aria-invalid={!!validation && validation !== "composing"}
      className="min-h-40 flex-1 resize-none overflow-y-auto [field-sizing:fixed] text-base! leading-7 md:text-base!"
      onChange={e => model.input(e.currentTarget.value)} onCompositionEnd={e => { model.input(e.currentTarget.value); model.composing(false); }}
      onSelect={e => model.select(e.currentTarget.selectionStart, e.currentTarget.selectionEnd)} />
    <footer className="shrink-0 text-xs text-muted-foreground">
      <p title={`${fullStats}\n${t("documents.statsHelp")}`} data-document-stats={fullStats}>{t("documents.statsShort", { characters: stats?.unicodeCharacters ?? "—" })}</p>
    </footer>
  </section>;
}
