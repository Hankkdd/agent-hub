import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import type { DocumentDetail, SuggestionDetail, Task, TaskEvent } from "@agent-hub/shared";
import { DocumentRoom, RoomPanel, RoomSuggestionCard } from "./document-room";
import { ChatTab } from "./chat-tab";
import { Composer } from "./composer";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
import { DocumentWorkspaceModel, type DocumentApi } from "@/lib/document-workspace-model";
import type { SuggestionApi } from "@/lib/document-suggestions";
import { t } from "@/i18n";

const h = vi.hoisted(() => ({ slots: [] as unknown[], cursor: 0, tasks: [] as Task[], events: [] as TaskEvent[],
  client: { findRoom: vi.fn(), createRoom: vi.fn(), models: vi.fn(), sendRoomMessage: vi.fn(), roomExchange: vi.fn(), setRoomBrief: vi.fn(), stopTask: vi.fn(), getDocumentSuggestion: vi.fn() } }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useEffect: () => {},
  useState: (initial: unknown) => { const i = h.cursor++; if (!(i in h.slots)) h.slots[i] = typeof initial === "function" ? initial() : initial;
    return [h.slots[i], (next: unknown) => { h.slots[i] = typeof next === "function" ? next(h.slots[i]) : next; }]; },
  useRef: (initial: unknown) => { const i = h.cursor++; if (!(i in h.slots)) h.slots[i] = { current: initial }; return h.slots[i]; },
}));
vi.mock("@/i18n", async original => ({ ...await original<object>(), useLanguage: () => "en" }));
vi.mock("@/lib/client", () => ({ client: h.client, useTasks: () => h.tasks, useEvents: () => h.events, label: (agent: string) => agent === "claude" ? "Claude" : "Codex" }));
const task = { id: "room", title: "Document room", workflow: "room", status: "idle", activity: null, options: { room: { documentId: "D", brief: "Ideas" } }, sessions: [{ id: "C", agent: "claude", role: "main" }, { id: "G", agent: "codex", role: "main" }], workspace: null, createdAt: "now", updatedAt: "now" } as Task;
const doc: DocumentDetail = { id: "D", createdAt: "now", updatedAt: "now", currentRevision: { id: "R1", documentId: "D", revisionNumber: 1, title: "Example", content: "original text", contentFormat: "plain_text", createdAt: "now", restoredFromRevisionId: null } };
const suggestion: SuggestionDetail = { id: "S", documentId: "D", source: "claude", importRequestId: "room_request_123456", baseRevisionId: "R1", baseRevisionNumber: 1, selection: { startUtf16: 0, endUtf16: 8, originalSha256: "0".repeat(64) }, originalText: "original", replacementText: "revised", originalUtf8Bytes: 8, replacementUtf8Bytes: 7, status: "pending", acceptedRevisionId: null, resolvedAt: null, createdAt: "now" };
const event = { type: "room_suggestion", id: "event", taskId: "room", sessionId: "C", seq: 1, createdAt: "now", documentId: "D", suggestionId: "S", agent: "claude", originalExcerpt: "original", replacementExcerpt: "revised", reason: "Clarity" } as const;
let model: DocumentWorkspaceModel;
let api: SuggestionApi;
function nodes(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (!isValidElement<{ children?: ReactNode }>(node)) return [];
  return [node as ReactElement<Record<string, unknown>>, ...Children.toArray(node.props.children).flatMap(nodes)];
}
function tree(render: () => ReactNode) { h.cursor = 0; return nodes(render()); }
function control(list: ReturnType<typeof nodes>, text: string) { return list.find(n => n.type === Button && n.props.children === text)!; }
async function click(node: ReactElement<Record<string, unknown>>) { await (node.props.onClick as () => Promise<void>)(); }
const room = () => DocumentRoom({ children: <textarea id="document-body" />, model, state: model.getSnapshot() });
const panel = (value = task) => RoomPanel({ task: value, model, state: model.getSnapshot(), draft: "", onDraft: vi.fn() });
const card = () => RoomSuggestionCard({ event, model, state: model.getSnapshot() });
beforeEach(async () => {
  h.slots = []; h.cursor = 0; h.tasks = []; h.events = []; Object.values(h.client).forEach(f => f.mockReset());
  h.client.models.mockResolvedValue({ claude: [{ id: "c-model", label: "Claude model" }], codex: [{ id: "g-model", label: "GPT model" }] });
  api = { getDocumentSuggestion: vi.fn().mockResolvedValue(suggestion), listDocumentSuggestions: vi.fn().mockResolvedValue({ suggestions: [], nextOffset: null }), importDocumentSuggestion: vi.fn(), acceptDocumentSuggestion: vi.fn(), rejectDocumentSuggestion: vi.fn() };
  model = new DocumentWorkspaceModel({ getDocument: vi.fn().mockResolvedValue(doc) } as unknown as DocumentApi, api); await model.open("D");
});
it("finds an existing room and creates a missing room with brief and member models", async () => {
  h.client.findRoom.mockResolvedValue({ room: task });
  await click(control(tree(room), t("room.discuss"))); expect(h.client.findRoom).toHaveBeenCalledWith("D");
  expect(tree(room).some(n => n.type === RoomPanel)).toBe(true); expect(h.client.createRoom).not.toHaveBeenCalled();
  h.slots = []; h.client.findRoom.mockResolvedValue({ room: null }); h.client.createRoom.mockResolvedValue(task);
  await click(control(tree(room), t("room.discuss")));
  let list = tree(room);
  const brief = list.find(n => n.type === Textarea)!;
  (brief.props.onChange as (e: unknown) => void)({ target: { value: "Explore ideas" } });
  for (const [i, field] of list.filter(n => n.type === "select").entries()) (field.props.onChange as (e: unknown) => void)({ target: { value: i === 0 ? "c-model" : "g-model" } });
  list = tree(room); await click(control(list, t("room.create")));
  expect(h.client.createRoom).toHaveBeenCalledWith({ documentId: "D", brief: "Explore ideas", claudeModel: "c-model", codexModel: "g-model" });
});
it("saves the bounded brief and allows one exchange only while idle", async () => {
  let list = tree(() => panel());
  await click(control(list, t("room.exchange"))); expect(h.client.roomExchange).toHaveBeenCalledWith("room");
  expect(control(tree(() => panel({ ...task, status: "running" })), t("room.exchange")).props.disabled).toBe(true);
  const field = list.find(n => n.type === Textarea)!; expect(field.props.maxLength).toBe(4000);
  (field.props.onChange as (e: unknown) => void)({ target: { value: "x".repeat(4001) } });
  expect(control(tree(() => panel()), t("documents.save")).props.disabled).toBe(true);
  (field.props.onChange as (e: unknown) => void)({ target: { value: "New brief" } }); h.client.setRoomBrief.mockResolvedValue({ ...task, options: { room: { documentId: "D", brief: "New brief" } } });
  await click(control(tree(() => panel()), t("documents.save"))); expect(h.client.setRoomBrief).toHaveBeenCalledWith("room", "New brief");
});
it("renders both member labels, pass and exchange as muted system lines and quoted bubbles", () => {
  const base = { taskId: "room", createdAt: "now", sessionId: "C", seq: 1 };
  const events: TaskEvent[] = [{ ...base, id: "a", type: "agent_text", text: "Claude idea" }, { ...base, id: "b", sessionId: "G", type: "agent_text", text: "GPT idea" }, { ...base, id: "p", sessionId: "G", type: "agent_text", text: "(pass)" }, { ...base, id: "x", type: "user_message", text: "Internal instruction", exchange: true }, { ...base, id: "q", type: "user_message", text: "Reply", quote: { eventId: "a", author: "claude", text: "Quoted idea", part: true } }];
  const html = renderToStaticMarkup(<ChatTab task={task} events={events} onSelectTask={() => {}} />);
  expect(html).toContain("Claude"); expect(html).toContain("GPT"); expect(html).toContain(t("room.passed", { agent: "GPT" })); expect(html).toContain(t("room.exchangeLine")); expect(html).not.toContain("Internal instruction"); expect(html).toContain("Quoted idea");
});
it.each(["selected phrase", undefined])("quotes a reply and sends the appropriate part (%s)", async part => {
  let list = tree(() => panel()); const transcript = list.find(n => n.type === ChatTab)!;
  (transcript.props.onReply as (e: unknown, p?: string) => void)({ id: "reply", type: "agent_text", sessionId: "G", text: "Whole message" }, part);
  list = tree(() => panel()); const composer = list.find(n => n.type === Composer)!;
  expect(renderToStaticMarkup(composer.props.quoteBar as ReactNode)).toContain(part ?? "Whole message");
  await (composer.props.onSend as (text: string, images: unknown[]) => Promise<void>)("Question", []);
  expect(h.client.sendRoomMessage).toHaveBeenCalledWith("room", { text: "Question", images: [], replyTo: { eventId: "reply", ...(part ? { part } : {}) } });
});
it("freezes document context before dialog blur, sends selection, and explains dirty selections", async () => {
  class TextareaElement { id = "document-body"; selectionStart = 0; selectionEnd = 8; }
  vi.stubGlobal("HTMLTextAreaElement", TextareaElement);
  h.client.findRoom.mockResolvedValue({ room: task });
  let list = tree(room); const target = new TextareaElement();
  (list.find(n => n.props.onContextMenu)!.props.onContextMenu as (e: unknown) => void)({ target, preventDefault: vi.fn() });
  await click(control(tree(room), t("room.revise"))); model.clearSelection();
  list = tree(room); const instructions = list.find(n => n.type === Textarea && n.props["aria-label"] === t("suggestions.instructions"))!;
  (instructions.props.onChange as (e: unknown) => void)({ target: { value: "Shorten" } });
  await click(control(tree(room), t("composer.send")));
  await vi.waitFor(() => expect(h.client.sendRoomMessage).toHaveBeenCalledWith("room", { text: "Shorten", selection: { baseRevisionId: "R1", startUtf16: 0, endUtf16: 8, originalText: "original" } }));
  model.input("unsaved text"); list = tree(room);
  (list.find(n => n.props.onContextMenu)!.props.onContextMenu as (e: unknown) => void)({ target, preventDefault: vi.fn() });
  expect(tree(room).some(n => n.props.children === t("suggestions.gateDirty"))).toBe(true); vi.unstubAllGlobals();
});
it("accepts agent suggestions through the workspace model and adopts the returned document", async () => {
  const next = { ...doc, currentRevision: { ...doc.currentRevision, id: "R2", revisionNumber: 2, content: "revised text" } };
  vi.mocked(api.acceptDocumentSuggestion).mockResolvedValue({ suggestion: { ...suggestion, status: "accepted", acceptedRevisionId: "R2", resolvedAt: "later" }, document: next, acceptedRevisionId: "R2", acceptedRevisionNumber: 2, replayed: false });
  await click(control(tree(card), t("suggestions.accept")));
  expect(api.acceptDocumentSuggestion).toHaveBeenCalledWith("D", "S", { expectedRevisionId: "R1" });
  await vi.waitFor(() => expect(model.getSnapshot().editor!.base).toEqual(next)); expect(tree(card).some(n => n.props.children === t("suggestions.accepted"))).toBe(true);
});
it("rejects through the existing client and shows stale feedback on conflict", async () => {
  vi.mocked(api.rejectDocumentSuggestion).mockResolvedValue({ suggestion: { ...suggestion, status: "rejected", resolvedAt: "later" }, replayed: false });
  await click(control(tree(card), t("suggestions.reject"))); await vi.waitFor(() => expect(model.getSnapshot().suggestions.detail?.status).toBe("rejected")); expect(api.rejectDocumentSuggestion).toHaveBeenCalledWith("D", "S");
  vi.mocked(api.acceptDocumentSuggestion).mockRejectedValue({ status: 409, code: "revision_conflict" });
  await click(control(tree(card), t("suggestions.accept")));
  await vi.waitFor(() => expect(tree(card).some(n => n.props.children === t("suggestions.stale"))).toBe(true)); expect(model.getSnapshot().editor!.base).toEqual(doc);
});
it.each(["Enter", "Tab", "click"])("inserts member mentions using %s and keeps Escape from sending", async mode => {
  const onSend = vi.fn();
  const compose = () => Composer({ room: true, running: false, onSend });
  let list = tree(compose); const field = list.find(n => n.type === Textarea)!;
  (field.props.onChange as (e: unknown) => void)({ target: { value: "Hello @", selectionStart: 7 } });
  list = tree(compose); expect(list.filter(n => n.props.role === "option")).toHaveLength(2);
  const key = (key: string) => (tree(compose).find(n => n.type === Textarea)!.props.onKeyDown as (e: unknown) => void)({ key, nativeEvent: { isComposing: false }, preventDefault: vi.fn() });
  if (mode === "click") await click(list.find(n => n.props.role === "option" && n.props.children === t("room.gpt"))!);
  else { key("ArrowDown"); key(mode); }
  expect(tree(compose).find(n => n.type === Textarea)!.props.value).toBe("Hello @gpt "); expect(onSend).not.toHaveBeenCalled();
  (field.props.onChange as (e: unknown) => void)({ target: { value: "@", selectionStart: 1 } }); key("Escape");
  expect(tree(compose).filter(n => n.props.role === "option")).toHaveLength(0);
  key("Enter"); expect(onSend).toHaveBeenCalledWith("@", []);
});
it("captures selection inside a transcript message before Reply takes focus", async () => {
  const onReply = vi.fn();
  const user: TaskEvent = { id: "U", type: "user_message", text: "Whole user message", taskId: "room", sessionId: null, createdAt: "now", seq: 1 };
  let list = tree(() => ChatTab({ task, events: [user], onSelectTask: vi.fn(), onReply }));
  const eventRow = list.find(n => n.props.event === user)!;
  const row = (eventRow.type as (props: unknown) => ReactNode)(eventRow.props);
  const wrapper = nodes(row).find(n => n.props.event === user)!;
  list = tree(() => (wrapper.type as (props: unknown) => ReactNode)(wrapper.props));
  vi.stubGlobal("window", { getSelection: () => ({ isCollapsed: false, anchorNode: {}, focusNode: {}, toString: () => "user message" }) });
  (list.find(n => n.props.onMouseUp)!.props.onMouseUp as (e: unknown) => void)({ currentTarget: { contains: () => true } });
  await click(control(list, t("room.reply"))); expect(onReply).toHaveBeenCalledWith(user, "user message"); vi.unstubAllGlobals();
});
it("opens a sidebar-selected room beside its document without creating another room", () => {
  const list = tree(() => DocumentRoom({ children: null, model, state: model.getSnapshot(), initialRoom: task }));
  expect(list.some(n => n.type === RoomPanel && n.props.task === task)).toBe(true);
  expect(h.client.findRoom).not.toHaveBeenCalled(); expect(h.client.createRoom).not.toHaveBeenCalled();
});
it("prefills document excerpts as Markdown quotes without a chat replyTo", async () => {
  class TextareaElement { id = "document-body"; selectionStart = 0; selectionEnd = 8; }
  vi.stubGlobal("HTMLTextAreaElement", TextareaElement); h.client.findRoom.mockResolvedValue({ room: task });
  let list = tree(room);
  (list.find(n => n.props.onContextMenu)!.props.onContextMenu as (e: unknown) => void)({ target: new TextareaElement(), preventDefault: vi.fn() });
  await click(control(tree(room), t("room.quote")));
  await vi.waitFor(() => expect(tree(room).some(n => n.type === RoomPanel)).toBe(true));
  list = tree(room); expect(list.find(n => n.type === RoomPanel)!.props.draft).toBe("> original\n\n");
  expect(h.client.sendRoomMessage).not.toHaveBeenCalled(); vi.unstubAllGlobals();
});
