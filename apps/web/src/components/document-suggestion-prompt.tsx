import { useRef, useState } from "react";
import { t } from "@/i18n";
import { copyText } from "@/lib/copy";
import { cn } from "@/lib/utils";
import { instructionError, textLimitError, replacementError, utf8Bytes, INSTRUCTION_BYTES, PROMPT_BYTES } from "@/lib/document-suggestions";
import { SUGGESTION_REPLACEMENT_BYTES } from "@agent-hub/shared";
import type { DocumentWorkspaceModel, DocumentWorkspaceState } from "@/lib/document-workspace-model";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
import { Label } from "./ui/label";
import { validationMessage } from "./document-editor";

export function suggestionValidation(code: string | null): string | null {
  if (!code) return null;
  if (code === "instructions_required") return t("suggestions.instructionsRequired");
  if (code === "no_change") return t("suggestions.noChange");
  if (code === "delete_confirmation") return t("suggestions.deleteRequired");
  if (code === "content_too_large") return t("suggestions.tooLarge");
  return validationMessage(code);
}
/** Byte limits matter only near the edge; below that they are noise. */
function LimitNote({ text, max }: { text: string; max: number }) {
  const bytes = utf8Bytes(text);
  return bytes > max * 0.8 ? <p className="text-xs text-muted-foreground">{t("suggestions.limit", { bytes, max })}</p> : null;
}
type Step = 1 | 2 | 3;
export function DocumentSuggestionPrompt({ model, state }: { model: DocumentWorkspaceModel; state: DocumentWorkspaceState }) {
  const draft = state.suggestions.draft;
  const prompt = useRef<HTMLTextAreaElement>(null);
  const [discard, setDiscard] = useState(false);
  const [convert, setConvert] = useState(false);
  // Resuming lands on the furthest step the retained material supports.
  const [step, setStep] = useState<Step>(draft?.replacement ? 3 : draft?.prompt && !draft.promptStale ? 2 : 1);
  if (!draft) return null;
  const locked = state.suggestions.operation?.kind === "import";
  const instruction = instructionError(draft.instructions), promptError = textLimitError(draft.prompt, PROMPT_BYTES), candidate = replacementError(draft);
  const update = model.updateSuggestionDraft.bind(model);
  const next = () => {
    if (!draft.prompt || draft.promptStale) model.generatePrompt();
    const current = model.getSnapshot().suggestions.draft;
    if (current?.prompt && !current.promptStale) setStep(2);
  };
  const steps: Array<[Step, string]> = [[1, t("suggestions.step1")], [2, t("suggestions.step2")], [3, t("suggestions.step3")]];
  return <div className="flex min-h-0 flex-1 flex-col gap-3" data-suggestion-prompt="" data-suggestion-step={step}>
    <ol className="flex shrink-0 flex-wrap gap-x-4 gap-y-1 text-sm">
      {steps.map(([n, label]) => <li key={n} aria-current={n === step ? "step" : undefined} className={cn("flex items-center gap-1.5", n === step ? "font-semibold" : "text-muted-foreground")}>
        <span className={cn("flex size-5 items-center justify-center rounded-full border text-xs", n === step && "border-primary bg-primary text-primary-foreground")}>{n}</span>{label}
      </li>)}
    </ol>
    {!model.intentValid() && <p role="alert" className="text-sm text-destructive">{t("suggestions.staleIntent")}</p>}
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
      {step === 1 && <>
        <p className="text-sm font-medium">{t("suggestions.selected")}</p>
        <blockquote className="max-h-40 shrink-0 overflow-y-auto border-l-2 pl-3 text-sm whitespace-pre-wrap break-words text-muted-foreground" data-suggestion-original="">{draft.intent.originalText}</blockquote>
        <Label htmlFor="suggestion-instructions">{t("suggestions.instructions")}</Label>
        <Textarea id="suggestion-instructions" value={draft.instructions} disabled={locked} placeholder={t("suggestions.instructionsPlaceholder")}
          className="min-h-20 resize-y [field-sizing:fixed]" onChange={e => update({ instructions: e.currentTarget.value })} />
        <LimitNote text={draft.instructions} max={INSTRUCTION_BYTES} />
        {draft.instructions && instruction && <p role="alert" className="text-sm">{suggestionValidation(instruction)}</p>}
      </>}
      {step === 2 && <>
        <p className="text-sm">{t("suggestions.manualOnly")}</p>
        <div className="flex flex-wrap items-center gap-2">
          <Button disabled={!draft.prompt || !!promptError || draft.promptStale} onClick={async () => {
            if (draft.promptStale) return;
            try { await copyText(draft.prompt); model.copiedPrompt(draft, true); }
            catch { model.copiedPrompt(draft, false); }
          }}>{t("suggestions.copy")}</Button>
          {draft.copy !== "idle" && <span role={draft.copy === "failed" ? "alert" : "status"} className="text-sm">{t(draft.copy === "copied" ? "suggestions.copied" : "suggestions.copyFailed")}</span>}
        </div>
        {draft.promptStale && <div role="status" className="flex flex-wrap items-center gap-2 text-sm"><span>{t("suggestions.regenerate")}</span>
          <Button size="sm" variant="outline" disabled={locked || !!instruction} onClick={() => model.generatePrompt()}>{t("suggestions.generate")}</Button></div>}
        {promptError && <p role="alert" className="text-sm">{suggestionValidation(promptError)}</p>}
        <details className="rounded border p-2 text-sm" data-suggestion-prompt-details="">
          <summary className="cursor-pointer select-none">{t("suggestions.showPrompt")}</summary>
          <div className="mt-2 space-y-2">
            <Label htmlFor="suggestion-prompt" className="sr-only">{t("suggestions.prompt")}</Label>
            <Textarea ref={prompt} id="suggestion-prompt" value={draft.prompt} disabled={locked} className="min-h-40 resize-y [field-sizing:fixed]"
              spellCheck={false} onChange={e => update({ prompt: e.currentTarget.value })} />
            <LimitNote text={draft.prompt} max={PROMPT_BYTES} />
            <Button size="sm" variant="outline" onClick={() => { prompt.current?.focus(); prompt.current?.select(); }}>{t("suggestions.selectAll")}</Button>
            <label className="flex items-start gap-2 text-xs text-muted-foreground"><input type="checkbox" className="mt-0.5" checked={draft.advanced} disabled={locked}
              onChange={e => update({ advanced: e.currentTarget.checked })} />{t("suggestions.advanced")}</label>
          </div>
        </details>
      </>}
      {step === 3 && <>
        <Label htmlFor="suggestion-replacement">{t("suggestions.replacement")}</Label>
        <Textarea id="suggestion-replacement" value={draft.replacement} disabled={locked} readOnly={draft.replacement.includes("\r")} spellCheck={false} autoCorrect="off" autoCapitalize="off"
          className="min-h-40 resize-y [field-sizing:fixed]" onChange={e => update({ replacement: e.currentTarget.value, deleteConfirmed: false })}
          onPaste={e => {
            const pasted = e.clipboardData.getData("text/plain");
            if (!locked && !draft.replacement.includes("\r") && pasted.includes("\r")) {
              e.preventDefault(); const { selectionStart: start, selectionEnd: end } = e.currentTarget;
              update({ replacement: draft.replacement.slice(0, start) + pasted + draft.replacement.slice(end), deleteConfirmed: false });
            }
          }} onCompositionStart={() => update({ composing: true })}
          onCompositionEnd={e => update({ replacement: e.currentTarget.value, composing: false })} />
        {draft.replacement.includes("\r") && <div role="alert" className="space-y-2 rounded border p-2 text-sm"><p>{t("suggestions.candidateCr")}</p>
          {convert ? <><p>{t("suggestions.candidateConvertConfirm")}</p><Button size="sm" disabled={locked} onClick={() => { update({ replacement: draft.replacement.replace(/\r\n?/g, "\n") }); setConvert(false); }}>{t("documents.confirm")}</Button></>
            : <Button size="sm" variant="outline" disabled={locked} onClick={() => setConvert(true)}>{t("suggestions.candidateConvert")}</Button>}
        </div>}
        <LimitNote text={draft.replacement} max={SUGGESTION_REPLACEMENT_BYTES} />
        {draft.replacement && candidate && candidate !== "delete_confirmation" && <p role="alert" className="text-sm">{suggestionValidation(candidate)}</p>}
        {draft.replacement === "" && <label className="flex items-start gap-2 text-sm text-muted-foreground"><input type="checkbox" className="mt-1" checked={draft.deleteConfirmed} disabled={locked}
          onChange={e => update({ deleteConfirmed: e.currentTarget.checked })} />{t("suggestions.deleteConfirm")}</label>}
        <p className="text-xs text-muted-foreground" data-suggestion-retention="">{t("suggestions.retention")}</p>
      </>}
    </div>
    {discard && <div className="shrink-0 space-y-2 rounded border p-2 text-sm"><p>{t("suggestions.discardConfirm")}</p>
      <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" onClick={() => setDiscard(false)}>{t("documents.cancel")}</Button>
        <Button size="sm" disabled={!!state.pending || locked} onClick={() => model.discardSuggestionDraft(true)}>{t("suggestions.discard")}</Button></div>
    </div>}
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-t pt-3">
      {!discard && <Button variant="ghost" size="sm" disabled={!!state.pending || locked} onClick={() => setDiscard(true)}>{t("suggestions.discard")}</Button>}
      <span className="flex-1" />
      {step > 1 && <Button variant="outline" disabled={locked} onClick={() => setStep(step === 3 ? 2 : 1)}>{t("suggestions.back")}</Button>}
      {step === 1 && <Button disabled={locked || !!instruction} onClick={next}>{t("suggestions.next")}</Button>}
      {step === 2 && <Button disabled={locked} onClick={() => setStep(3)}>{t("suggestions.gotResult")}</Button>}
      {step === 3 && <Button disabled={!model.canImportSuggestion()} onClick={() => void model.importSuggestion()}>{t("suggestions.import")}</Button>}
    </div>
  </div>;
}
