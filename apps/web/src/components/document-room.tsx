import { useEffect, useRef, useState, type ReactNode } from "react";
import { ROOM_BRIEF_MAX, ROOM_QUOTE_BYTES, type ModelCatalog, type RoomMessageInput, type RoomQuote, type RoomSelection, type Task, type TaskEvent, type SuggestionDetail } from "@agent-hub/shared";
import { X } from "lucide-react";
import { t, useLanguage } from "@/i18n";
import { client, useEvents, useTasks } from "@/lib/client";
import { boundedContext, checkedSuggestion, freezeSuggestionIntent, intentCurrent, savedEditor } from "@/lib/document-suggestions";
import type { DocumentWorkspaceModel, DocumentWorkspaceState } from "@/lib/document-workspace-model";
import { suggestionGateKey } from "./document-editor";
import { ChatTab, AgentLabel } from "./chat-tab";
import { Composer } from "./composer";
import { ResizablePanel } from "./resizable-panel";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "./ui/dialog";
import { cn } from "@/lib/utils";

export function DocumentRoom({ children, model, state, initialRoom }: { children: ReactNode; model: DocumentWorkspaceModel; state: DocumentWorkspaceState; initialRoom?: Task }) {
  useLanguage();
  const documentId = state.editor!.base.id;
  const [room, setRoom] = useState<Task | null>(initialRoom ?? null);
  const current = initialRoom ?? room;
  const [closedRoomId, setClosedRoomId] = useState<string | null>(null);
  const [tabState, setTabState] = useState<{ roomId?: string; value: "editor" | "room" }>({ roomId: initialRoom?.id, value: initialRoom ? "room" : "editor" });
  const tab = initialRoom && tabState.roomId !== initialRoom.id ? "room" : tabState.value;
  const setTab = (value: "editor" | "room") => setTabState({ roomId: initialRoom?.id, value });
  const setClosed = (closed: boolean) => setClosedRoomId(closed ? current?.id ?? null : null);
  const [creating, setCreating] = useState(false);
  const [models, setModels] = useState<ModelCatalog>({ claude: [], codex: [] });
  const [brief, setBrief] = useState("");
  const [claudeModel, setClaudeModel] = useState("");
  const [codexModel, setCodexModel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [context, setContext] = useState<{ intent: ReturnType<typeof freezeSuggestionIntent>; reason: string } | null>(null);
  const [instructions, setInstructions] = useState("");
  const [request, setRequest] = useState<ReturnType<typeof freezeSuggestionIntent>>(null);
  const [draft, setDraft] = useState("");
  const pending = useRef<RoomMessageInput | null>(null);
  const visible = !!current && current.id !== closedRoomId;
  const send = async (taskId: string, message: RoomMessageInput) => {
    const s = model.getSnapshot(), selection = message.selection;
    if (selection && (!savedEditor(s.editor) || s.pending || s.suggestions.operation || s.editor.base.id !== documentId || s.editor.base.currentRevision.id !== selection.baseRevisionId || s.editor.rawInput.slice(selection.startUtf16, selection.endUtf16) !== selection.originalText)) throw new Error(t("suggestions.staleIntent"));
    await client.sendRoomMessage(taskId, message);
  };
  const open = async (message?: RoomMessageInput) => {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const found = current ?? (await client.findRoom(documentId)).room;
      if (found) {
        setRoom(found); setClosed(false); setTab("room");
        if (message) await send(found.id, message);
      } else {
        pending.current = message ?? null; setCreating(true);
        setModels(await client.models());
      }
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  return <div className="flex min-h-0 min-w-0 flex-1 flex-col">
    <div className="flex shrink-0 flex-wrap gap-2 border-b p-2">
      <Button size="sm" variant="outline" disabled={busy} onClick={() => void open()}>{t("room.discuss")}</Button>
      {visible && <><Button size="sm" variant="ghost" className="md:hidden" onClick={() => setTab("editor")}>{t("documents.body")}</Button>
        <Button size="sm" variant="ghost" className="md:hidden" onClick={() => setTab("room")}>{t("workflow.room")}</Button>
        <Button size="sm" variant="ghost" onClick={() => { setClosed(true); setTab("editor"); }}>{t("room.close")}</Button></>}
    </div>
    {error && <p role="alert" className="p-2 text-sm text-destructive">{error}</p>}
    <div className="flex min-h-0 min-w-0 flex-1">
      <div className={cn("min-h-0 min-w-0 flex-1 flex-col md:flex", visible && tab === "room" ? "hidden" : "flex")}
        onContextMenu={e => {
          if (!(e.target instanceof HTMLTextAreaElement) || e.target.id !== "document-body") return;
          e.preventDefault();
          model.select(e.target.selectionStart, e.target.selectionEnd);
          const s = model.getSnapshot();
          const intent = model.canStartSuggestion() && s.editor ? freezeSuggestionIntent(s.editor, s.sessionKey) : null;
          setContext({ intent, reason: s.editor ? t(suggestionGateKey(s.editor)) : t("suggestions.gateBusy") });
        }}>{children}</div>
      {visible && <ResizablePanel side="left" storageKey="room-panel-width" defaultWidth={440} minWidth={280} maxWidth={800}
        className={cn("min-h-0 flex-col border-l max-md:w-full md:flex", tab === "editor" ? "hidden" : "flex")}>
        <RoomPanel key={current.id} task={current} model={model} state={state} draft={draft} onDraft={setDraft} />
      </ResizablePanel>}
    </div>
    <Dialog open={creating} onOpenChange={v => { if (!busy) { setCreating(v); if (!v) pending.current = null; } }}><DialogContent><DialogHeader>
      <DialogTitle>{t("room.discuss")}</DialogTitle><DialogDescription>{t("room.createDescription")}</DialogDescription></DialogHeader>
      <label>{t("room.brief")}<Textarea value={brief} maxLength={ROOM_BRIEF_MAX} onChange={e => setBrief(e.target.value)} /></label>
      {(["claude", "codex"] as const).map(agent => <label key={agent}>{agent === "claude" ? t("agent.claude") : t("room.gpt")}
        <select className="ml-2 rounded border bg-background p-2" aria-label={agent === "claude" ? t("room.claudeModel") : t("room.gptModel")} value={agent === "claude" ? claudeModel : codexModel}
          onChange={e => agent === "claude" ? setClaudeModel(e.target.value) : setCodexModel(e.target.value)}>
          <option value="">{t("handoff.defaultModel")}</option>{models[agent].map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
        </select></label>)}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <Button disabled={busy || brief.length > ROOM_BRIEF_MAX} onClick={async () => {
        setBusy(true); setError(null);
        try {
          const task = await client.createRoom({ documentId, brief, claudeModel: claudeModel || undefined, codexModel: codexModel || undefined });
          setRoom(task); setCreating(false); setClosed(false); setTab("room");
          const message = pending.current; pending.current = null;
          if (message) await send(task.id, message);
        } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
      }}>{t("room.create")}</Button>
    </DialogContent></Dialog>
    <Dialog open={!!context} onOpenChange={v => { if (!v) setContext(null); }}><DialogContent><DialogHeader><DialogTitle>{t("room.documentContext")}</DialogTitle></DialogHeader>
      {context?.intent ? <><Button onClick={() => { setRequest(context.intent); setInstructions(""); setContext(null); }}>{t("room.revise")}</Button>
        <Button variant="outline" onClick={() => { setDraft(value => `${value}${value ? "\n\n" : ""}${context.intent!.originalText.split("\n").map(line => `> ${line}`).join("\n")}\n\n`); setContext(null); void open(); }}>{t("room.quote")}</Button></> : <p role="status">{context?.reason}</p>}
    </DialogContent></Dialog>
    <Dialog open={!!request} onOpenChange={v => { if (!v) setRequest(null); }}><DialogContent><DialogHeader><DialogTitle>{t("room.revise")}</DialogTitle></DialogHeader>
      <Textarea aria-label={t("suggestions.instructions")} value={instructions} onChange={e => setInstructions(e.target.value)} />
      {request && !intentCurrent(request, state.editor, state.sessionKey) && <p role="alert">{t("suggestions.staleIntent")}</p>}
      <Button disabled={busy || !instructions.trim() || !request || !intentCurrent(request, state.editor, state.sessionKey)} onClick={() => {
        if (!request || !intentCurrent(request, model.getSnapshot().editor, model.getSnapshot().sessionKey)) return;
        const selection: RoomSelection = { baseRevisionId: request.baseRevisionId, startUtf16: request.startUtf16, endUtf16: request.endUtf16, originalText: request.originalText };
        setRequest(null); void open({ text: instructions, selection });
      }}>{t("composer.send")}</Button>
    </DialogContent></Dialog>
  </div>;
}

export function RoomPanel({ task: initial, model, state, draft, onDraft }: { task: Task; model: DocumentWorkspaceModel; state: DocumentWorkspaceState; draft: string; onDraft: (value: string) => void }) {
  useLanguage();
  const tasks = useTasks();
  const task = tasks.find(t => t.id === initial.id) ?? initial;
  const events = useEvents(task.id);
  const [brief, setBrief] = useState(task.options.room?.brief ?? "");
  const [savedTask, setSavedTask] = useState<Task | null>(null);
  const [quote, setQuote] = useState<RoomQuote | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = async (action: () => Promise<unknown>) => { setBusy(true); setError(null); try { await action(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); } };
  const running = task.status === "running" || task.status === "waiting_user";
  return <section className="flex min-h-0 flex-1 flex-col" data-room-controls="" aria-label={t("workflow.room")}>
    <header className="shrink-0 space-y-2 border-b p-3">
      <label className="text-sm">{t("room.brief")}<Textarea aria-label={t("room.brief")} maxLength={ROOM_BRIEF_MAX} value={brief} onChange={e => setBrief(e.target.value)} /></label>
      <div className="flex flex-wrap gap-2"><Button size="sm" disabled={busy || brief.length > ROOM_BRIEF_MAX || brief === ((savedTask ?? task).options.room?.brief ?? "")} onClick={() => void act(async () => { setSavedTask(await client.setRoomBrief(task.id, brief)); })}>{t("documents.save")}</Button>
        <Button size="sm" variant="outline" disabled={busy || running} onClick={() => void act(() => client.roomExchange(task.id))}>{t("room.exchange")}</Button>
        <Button size="sm" variant="outline" disabled={!running || busy} onClick={() => void act(() => client.stopTask(task.id))}>{t("composer.stop")}</Button></div>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </header>
    <div className="min-h-0 flex-1 overflow-y-auto"><ChatTab task={task} events={events} onSelectTask={() => {}}
      onReply={(event, part) => {
        const session = task.sessions.find(s => s.id === event.sessionId);
        setQuote({ eventId: event.id, author: event.type === "user_message" ? "user" : session?.agent === "claude" ? "claude" : "codex", text: boundedContext(part || event.text, ROOM_QUOTE_BYTES, "after"), part: !!part });
      }} renderSuggestion={event => <RoomSuggestionCard event={event} model={model} state={state} />} /></div>
    <Composer room running={running} draft={draft} onDraft={onDraft}
      quoteBar={quote && <div className="mb-2 flex items-center gap-2 border-l-2 pl-2 text-xs"><div className="min-w-0 flex-1"><strong>{quote.author === "user" ? t("room.you") : quote.author === "codex" ? t("room.gpt") : t("agent.claude")}</strong><p className="truncate">{quote.text.split("\n")[0]}</p></div><Button size="sm" variant="ghost" aria-label={t("room.cancelQuote")} onClick={() => setQuote(null)}><X className="size-3" /></Button></div>}
      onSend={async (text, images) => { await client.sendRoomMessage(task.id, { text, images, ...(quote ? { replyTo: { eventId: quote.eventId, ...(quote.part ? { part: quote.text } : {}) } } : {}) }); setQuote(null); }} />
  </section>;
}

export function RoomSuggestionCard({ event, model, state }: { event: Extract<TaskEvent, { type: "room_suggestion" }>; model: DocumentWorkspaceModel; state: DocumentWorkspaceState }) {
  const view = state.suggestions;
  const [loaded, setLoaded] = useState<SuggestionDetail | null>(null);
  useEffect(() => {
    let current = true;
    void client.getDocumentSuggestion(event.documentId, event.suggestionId).then(row => { if (current) setLoaded(checkedSuggestion(row, event.documentId, event.suggestionId)); }).catch(() => undefined);
    return () => { current = false; };
  }, [event.documentId, event.suggestionId]);
  const row = view.detail?.id === event.suggestionId ? view.detail : view.items.find(s => s.id === event.suggestionId) ?? loaded;
  const [busy, setBusy] = useState(false);
  const resolve = async (accept: boolean) => {
    setBusy(true);
    try { await model.previewSuggestion(event.suggestionId); if (accept) await model.acceptSuggestion(true, event.suggestionId); else await model.rejectSuggestion(true, event.suggestionId); }
    finally { setBusy(false); }
  };
  const stale = view.conflictedId === event.suggestionId || row?.status === "pending" && row.baseRevisionId !== state.editor?.base.currentRevision.id;
  const disabled = busy || !!state.pending || !!view.operation || !state.authorized || row?.status === "accepted" || row?.status === "rejected";
  return <article className="space-y-2 rounded border p-3 text-sm">
    <AgentLabel name={event.agent === "codex" ? t("room.gpt") : t("agent.claude")} agent={event.agent} />
    {event.reason && <p>{event.reason}</p>}
    <div><strong>{t("room.before")}</strong><pre className="whitespace-pre-wrap break-words">{event.originalExcerpt}</pre></div>
    <div><strong>{t("room.after")}</strong><pre className="whitespace-pre-wrap break-words">{event.replacementExcerpt}</pre></div>
    {row && <p>{t(row.status === "pending" ? "suggestions.pending" : row.status === "accepted" ? "suggestions.accepted" : "suggestions.rejected")}</p>}
    {stale && <p role="alert">{t("suggestions.stale")}</p>}
    <div className="flex flex-wrap gap-2"><Button size="sm" disabled={disabled || model.protectedDraft() || stale} onClick={() => void resolve(true)}>{t("suggestions.accept")}</Button>
      <Button size="sm" variant="outline" disabled={disabled} onClick={() => void resolve(false)}>{t("suggestions.reject")}</Button>
      <Button size="sm" variant="ghost" onClick={() => { void model.showSuggestions(); void model.previewSuggestion(event.suggestionId); }}>{t("room.diff")}</Button></div>
  </article>;
}
