import type { RoomCreateInput, RoomMessageInput } from "@agent-hub/shared";
import type { SuggestionApi } from "./document-suggestions";
import type { ImportSuggestionInput, SuggestionImportResult, SuggestionList, SuggestionDetail, SuggestionAcceptResult, SuggestionRejectResult } from "@agent-hub/shared";
import type { CreateDocumentInput, UpdateDocumentInput, RestoreDocumentInput, DocumentDetail, DocumentList, DocumentRevisionList, DocumentRevision, DocumentWriteResult, DocumentErrorCode } from "@agent-hub/shared";
import type { TaskUsageSummary, TaskUsagePage } from "@agent-hub/shared";
import type { ClaudeLoginStatus, AntigravityStatus, AntigravitySession, AntigravityInput } from "@agent-hub/shared";
import type { GoogleStatus } from "@agent-hub/shared";
import type { DeployStatus } from "@agent-hub/shared";
import type { IssueCommentEdit, IssueCommentVersion } from "@agent-hub/shared";
import type { ChangeBriefingResponse, SwitchAgentInput } from "@agent-hub/shared";
import { t } from "@/i18n";
import { useSyncExternalStore } from "react";
import type { QuotaResponse, DiffExplanationsResponse, FileContents, FileDiff, Host, ImageUpload, ModelCatalog, NewTaskInput, PrConfirmation, RepoSettings, RecoverAction, SshLogEntry, StreamMessage, TaskListSummary, Task, TaskEvent } from "@agent-hub/shared";

/** Preserve ordinary Error messages while exposing optional machine-readable API failures. */
export class HttpError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
  }
}

function responseError(data: { error?: string; code?: unknown }, status: number): HttpError {
  return new HttpError(
    data.error ?? t("http.error", { status }),
    typeof data.code === "string" ? data.code : undefined,
  );
}

const documentCodes = new Set<DocumentErrorCode>(["invalid_input", "malformed_json", "invalid_document_id", "invalid_revision_id", "invalid_pagination", "unsupported_content_format", "document_not_found", "revision_not_found", "revision_conflict", "payload_too_large", "unsupported_media_type", "storage_busy", "storage_error", "documents_unavailable", "invalid_suggestion_id", "invalid_selection", "lf_required", "no_change", "suggestion_not_found", "selection_mismatch", "import_key_conflict", "suggestion_rejected", "suggestion_already_accepted"]);
export class DocumentHttpError extends HttpError {
  constructor(readonly status: number, code?: DocumentErrorCode, readonly currentRevisionId?: string, readonly retryAfterSeconds?: number) {
    super(`Document request failed (${status})`, code);
  }
}

export type Connection = "connecting" | "live" | "reconnecting" | "unauthorized";

/**
 * Everything the UI needs from the backend: commands go out as HTTP, changes come back on one SSE
 * stream. Components read through the synchronous getters below (via the hooks), and re-render when
 * anything changes.
 */
export interface HubClient extends SuggestionApi {
  createRoom(input: RoomCreateInput): Promise<Task>;
  findRoom(documentId: string): Promise<{ room: Task | null }>;
  sendRoomMessage(taskId: string, input: RoomMessageInput & { images?: ImageUpload[] }): Promise<void>;
  roomExchange(taskId: string): Promise<{ ok: true }>;
  setRoomBrief(taskId: string, brief: string): Promise<Task>;
  reconnect(): Promise<void>;
  createDocument(input: CreateDocumentInput): Promise<DocumentDetail>;
  listDocuments(query?: { limit?: number; offset?: number }, signal?: AbortSignal): Promise<DocumentList>;
  getDocument(id: string, signal?: AbortSignal): Promise<DocumentDetail>;
  updateDocument(id: string, input: UpdateDocumentInput): Promise<DocumentWriteResult>;
  listDocumentRevisions(id: string, query?: { limit?: number; beforeRevisionNumber?: number }, signal?: AbortSignal): Promise<DocumentRevisionList>;
  getDocumentRevision(id: string, revisionId: string, signal?: AbortSignal): Promise<DocumentRevision>;
  restoreDocumentRevision(id: string, revisionId: string, input: RestoreDocumentInput): Promise<DocumentWriteResult>;

  analyzeVideo(taskId: string, kind: import("@agent-hub/shared").VideoAnalysisKind): Promise<void>;
  claudeLoginStatus(refresh?: boolean): Promise<ClaudeLoginStatus>;
  claudeLoginSession(): Promise<AntigravitySession>;
  claudeLoginStart(): Promise<AntigravitySession>;
  claudeLoginCancel(): Promise<AntigravitySession>;
  claudeLoginLogout(): Promise<ClaudeLoginStatus>;
  claudeLoginInput(input: AntigravityInput): Promise<{ ok: boolean }>;
  antigravityStatus(): Promise<AntigravityStatus>;
  antigravitySession(): Promise<AntigravitySession>;
  antigravityStart(): Promise<AntigravitySession>;
  antigravityCancel(): Promise<AntigravitySession>;
  antigravityLogout(): Promise<AntigravityStatus>;
  antigravityInput(input: AntigravityInput): Promise<{ ok: boolean }>;
  googleStatus(): Promise<GoogleStatus>;
  googleConnect(capability: string): Promise<{ authUrl: string }>;
  googleComplete(url: string): Promise<GoogleStatus>;
  googleDisconnect(): Promise<GoogleStatus>;
  deployStatus(): Promise<DeployStatus>;
  deploy(sha: string): Promise<DeployStatus>;
  issueComment(taskId: string, action: "edit" | "confirm" | "reconcile", input: IssueCommentVersion | IssueCommentEdit): Promise<void>;
  switchAgent(taskId: string, input: SwitchAgentInput): Promise<void>;
  connection(): Connection;
  listTasks(): Task[];
  taskSummaries(): TaskListSummary[];
  events(taskId: string): TaskEvent[];
  /** Fetched on demand: a git diff is too heavy to push on every event. */
  diff(taskId: string): Promise<FileDiff[]>;
  diffFile(taskId: string, path: string): Promise<FileContents>;
  usageSummary(taskId: string): Promise<TaskUsageSummary>;
  usageCalls(taskId: string, after?: number): Promise<TaskUsagePage>;
  briefing(taskId: string): Promise<ChangeBriefingResponse>;
  generateBriefing(taskId: string, rewrite?: boolean): Promise<ChangeBriefingResponse>;
  editPrDraft(taskId: string, confirmation: PrConfirmation): Promise<Extract<TaskEvent, { type: "pr_draft" }>>;
  explanations(taskId: string): Promise<DiffExplanationsResponse>;
  retryFindingExport(taskId: string): Promise<void>;
  regenerateExplanations(taskId: string): Promise<void>;
  merge(taskId: string): Promise<void>;
  preparePrDraft(taskId: string): Promise<Extract<TaskEvent, { type: "pr_draft" }>>;
  abandonPrUpdate(taskId: string): Promise<import("@agent-hub/shared").PrUpdate>;
  updatePr(taskId: string, revision: import("@agent-hub/shared").PrRevision): Promise<import("@agent-hub/shared").PrUpdate>;
  openPr(taskId: string, confirmation?: PrConfirmation): Promise<{ number: number; url: string }>;
  setPinned(taskId: string, pinned: boolean): Promise<void>;
  deleteTask(taskId: string): Promise<void>;
  discard(taskId: string): Promise<void>;
  createTask(input: NewTaskInput): Promise<Task>;
  sendMessage(taskId: string, text: string, images?: ImageUpload[]): Promise<void>;
  stopTask(taskId: string): Promise<void>;
  recover(taskId: string, action: RecoverAction): Promise<void>;
  continueNow(taskId: string): Promise<void>;
  stopWaiting(taskId: string): Promise<void>;
  answer(taskId: string, eventId: string, answer: string): Promise<void>;
  /** Devices (design.md §7.3). Fetched on demand; they change only from the Devices page. */
  hosts(): Promise<Host[]>;
  saveHost(name: string, host: Partial<Host>): Promise<Host>;
  deleteHost(name: string): Promise<void>;
  testHost(name: string): Promise<{ ok: boolean; output: string }>;
  hostLog(name: string): Promise<SshLogEntry[]>;
  /** What each agent offers, for the model picker (the server caches it for an hour). */
  models(): Promise<ModelCatalog>;
  quota(force?: boolean): Promise<QuotaResponse>;
  repoSettings(path: string): Promise<RepoSettings | null>;
  /** Agent Hub's own SSH public key, for setting up a device. */
  publicKey(): Promise<{ keyPath: string; publicKey: string } | null>;
  subscribe(listener: () => void): () => void;
}

class HttpClient implements HubClient {
  async createRoom(input: RoomCreateInput): Promise<Task> {
    const task = await this.post<Task>("/api/rooms", input); this.upsertTask(task); return task;
  }
  findRoom(documentId: string): Promise<{ room: Task | null }> { return this.get(`/api/rooms?documentId=${encodeURIComponent(documentId)}`); }
  async sendRoomMessage(taskId: string, input: RoomMessageInput & { images?: ImageUpload[] }): Promise<void> { await this.post(`/api/tasks/${encodeURIComponent(taskId)}/messages`, input); }
  roomExchange(taskId: string): Promise<{ ok: true }> { return this.post(`/api/tasks/${encodeURIComponent(taskId)}/room/exchange`, {}); }
  async setRoomBrief(taskId: string, brief: string): Promise<Task> {
    const task = await this.documentRequest<Task>("PUT", `/api/tasks/${encodeURIComponent(taskId)}/room/brief`, { brief }); this.upsertTask(task); return task;
  }
  async reconnect(): Promise<void> { this.source?.close(); this.source = null; await this.start(); }
  createDocument(input: CreateDocumentInput): Promise<DocumentDetail> { return this.documentRequest("POST", "/api/documents", input); }
  listDocuments(query: { limit?: number; offset?: number } = {}, signal?: AbortSignal): Promise<DocumentList> {
    return this.documentRequest("GET", `/api/documents?limit=${query.limit ?? 50}&offset=${query.offset ?? 0}`, undefined, signal);
  }
  getDocument(id: string, signal?: AbortSignal): Promise<DocumentDetail> { return this.documentRequest("GET", `/api/documents/${encodeURIComponent(id)}`, undefined, signal); }
  updateDocument(id: string, input: UpdateDocumentInput): Promise<DocumentWriteResult> { return this.documentRequest("PUT", `/api/documents/${encodeURIComponent(id)}`, input); }
  listDocumentRevisions(id: string, query: { limit?: number; beforeRevisionNumber?: number } = {}, signal?: AbortSignal): Promise<DocumentRevisionList> {
    return this.documentRequest("GET", `/api/documents/${encodeURIComponent(id)}/revisions?limit=${query.limit ?? 50}${query.beforeRevisionNumber === undefined ? "" : `&beforeRevisionNumber=${query.beforeRevisionNumber}`}`, undefined, signal);
  }
  getDocumentRevision(id: string, revisionId: string, signal?: AbortSignal): Promise<DocumentRevision> { return this.documentRequest("GET", `/api/documents/${encodeURIComponent(id)}/revisions/${encodeURIComponent(revisionId)}`, undefined, signal); }
  restoreDocumentRevision(id: string, revisionId: string, input: RestoreDocumentInput): Promise<DocumentWriteResult> { return this.documentRequest("POST", `/api/documents/${encodeURIComponent(id)}/revisions/${encodeURIComponent(revisionId)}/restore`, input); }

  importDocumentSuggestion(id: string, input: ImportSuggestionInput): Promise<SuggestionImportResult> {
    return this.documentRequest("POST", `/api/documents/${encodeURIComponent(id)}/suggestions`, input);
  }
  listDocumentSuggestions(id: string, query: { limit?: number; offset?: number; status?: string; importRequestId?: string } = {}, signal?: AbortSignal): Promise<SuggestionList> {
    const params = new URLSearchParams({ limit: String(query.limit ?? 50), offset: String(query.offset ?? 0) });
    if (query.status !== undefined) params.set("status", query.status);
    if (query.importRequestId !== undefined) params.set("importRequestId", query.importRequestId);
    return this.documentRequest("GET", `/api/documents/${encodeURIComponent(id)}/suggestions?${params}`, undefined, signal);
  }
  getDocumentSuggestion(id: string, suggestionId: string, signal?: AbortSignal): Promise<SuggestionDetail> {
    return this.documentRequest("GET", `/api/documents/${encodeURIComponent(id)}/suggestions/${encodeURIComponent(suggestionId)}`, undefined, signal);
  }
  acceptDocumentSuggestion(id: string, suggestionId: string, input: { expectedRevisionId: string }): Promise<SuggestionAcceptResult> {
    return this.documentRequest("POST", `/api/documents/${encodeURIComponent(id)}/suggestions/${encodeURIComponent(suggestionId)}/accept`, input);
  }
  rejectDocumentSuggestion(id: string, suggestionId: string): Promise<SuggestionRejectResult> {
    return this.documentRequest("POST", `/api/documents/${encodeURIComponent(id)}/suggestions/${encodeURIComponent(suggestionId)}/reject`, {});
  }

  private async documentRequest<T>(method: string, url: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    if (encoded !== undefined && new TextEncoder().encode(encoded).byteLength > 2 * 1024 * 1024) throw new DocumentHttpError(413, "payload_too_large");
    let res: Response;
    try {
      res = await fetch(url, { method, cache: "no-store", credentials: "same-origin", signal,
        ...(encoded === undefined ? {} : { headers: { "content-type": "application/json" }, body: encoded }) });
    } catch {
      throw new DocumentHttpError(0);
    }
    if (res.status === 401) this.setConnection("unauthorized");
    let data: unknown;
    try { data = await res.json(); } catch { if (res.ok) throw new DocumentHttpError(0); }
    if (!res.ok) {
      const value = data && typeof data === "object" ? data as Record<string, unknown> : {};
      const code = typeof value.code === "string" && documentCodes.has(value.code as DocumentErrorCode) ? value.code as DocumentErrorCode : undefined;
      const revision = typeof value.currentRevisionId === "string" && /^[0-9a-f-]{36}$/i.test(value.currentRevisionId) ? value.currentRevisionId : undefined;
      const retry = res.headers.get("retry-after");
      throw new DocumentHttpError(res.status, code, revision, retry && /^\d{1,6}$/.test(retry) ? Number(retry) : undefined);
    }
    return data as T;
  }

  async analyzeVideo(taskId: string, kind: import("@agent-hub/shared").VideoAnalysisKind): Promise<void> { await this.post(`/api/tasks/${taskId}/video-analysis`, { kind }); }
  claudeLoginStatus(refresh = false): Promise<ClaudeLoginStatus> { return this.get(`/api/terminal-login/claude${refresh ? "?refresh=1" : ""}`); }
  claudeLoginSession(): Promise<AntigravitySession> { return this.get("/api/terminal-login/claude/login"); }
  claudeLoginStart(): Promise<AntigravitySession> { return this.post("/api/terminal-login/claude/login/start", {}); }
  claudeLoginCancel(): Promise<AntigravitySession> { return this.post("/api/terminal-login/claude/login/cancel", {}); }
  claudeLoginLogout(): Promise<ClaudeLoginStatus> { return this.post("/api/terminal-login/claude/logout", {}); }
  claudeLoginInput(input: AntigravityInput): Promise<{ ok: boolean }> { return this.post("/api/terminal-login/claude/login/input", input); }
  antigravityStatus(): Promise<AntigravityStatus> { return this.get("/api/antigravity"); }
  antigravitySession(): Promise<AntigravitySession> { return this.get("/api/antigravity/login"); }
  antigravityStart(): Promise<AntigravitySession> { return this.post("/api/antigravity/login/start", {}); }
  antigravityCancel(): Promise<AntigravitySession> { return this.post("/api/antigravity/login/cancel", {}); }
  antigravityLogout(): Promise<AntigravityStatus> { return this.post("/api/antigravity/logout", {}); }
  antigravityInput(input: AntigravityInput): Promise<{ ok: boolean }> { return this.post("/api/antigravity/login/input", input); }
  googleStatus(): Promise<GoogleStatus> { return this.get("/api/google"); }
  googleConnect(capability: string): Promise<{ authUrl: string }> { return this.post("/api/google/connect", { capability }); }
  googleComplete(url: string): Promise<GoogleStatus> { return this.post("/api/google/complete", { url }); }
  googleDisconnect(): Promise<GoogleStatus> { return this.send("DELETE", "/api/google"); }
  deployStatus(): Promise<DeployStatus> { return this.get("/api/deploy"); }
  deploy(sha: string): Promise<DeployStatus> { return this.post("/api/deploy", { sha }); }
  async issueComment(taskId: string, action: "edit" | "confirm" | "reconcile", input: IssueCommentVersion | IssueCommentEdit): Promise<void> {
    await this.post(`/api/tasks/${taskId}/issue-comment/${action}`, input);
  }
  async switchAgent(taskId: string, input: SwitchAgentInput): Promise<void> {
    // SSE/snapshot owns the projection; a late command response must not replace newer state.
    await this.post(`/api/tasks/${taskId}/switch-agent`, input);
  }
  async retryFindingExport(taskId: string): Promise<void> { await this.post(`/api/tasks/${taskId}/findings/retry`, {}); }
  quota(force = false): Promise<QuotaResponse> {
    return force ? this.post("/api/quota/refresh", {}) : this.get("/api/quota");
  }
  repoSettings(path: string): Promise<RepoSettings | null> {
    return this.get(`/api/repo-settings?path=${encodeURIComponent(path)}`);
  }
  private conn: Connection = "connecting";
  private summaries = new Map<string, TaskListSummary>();
  private tasks = new Map<string, Task>();
  /** Events of the tasks that have been opened; others are fetched on first view. */
  private eventsByTask = new Map<string, Map<string, TaskEvent>>();
  private listeners = new Set<() => void>();
  private version = 0;
  private cache = new Map<string, { v: number; value: unknown }>();
  private source: EventSource | null = null;
  private resyncMessages: StreamMessage[] | null = null;

  async start(): Promise<void> {
    // First visit with ?token= in the URL: trade it for the HttpOnly cookie, then
    // drop it from the address bar so it is not left in history or a screenshot.
    const url = new URL(location.href);
    const token = url.searchParams.get("token");
    if (token) {
      await fetch("/api/auth", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
      const currentUrl = new URL(location.href);
      currentUrl.searchParams.delete("token");
      // Phone navigation may have initialized while the authentication request was in flight.
      history.replaceState(history.state, "", currentUrl);
    }
    if (!(await this.resync())) return;
    this.openStream();
  }

  connection(): Connection {
    return this.conn;
  }

  listTasks(): Task[] {
    return this.memo("tasks", () => [...this.tasks.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
  }

  taskSummaries(): TaskListSummary[] {
    return this.memo("summaries", () => [...this.summaries.values()]);
  }

  events(taskId: string): TaskEvent[] {
    if (!this.eventsByTask.has(taskId)) void this.loadEvents(taskId);
    return this.memo(`events:${taskId}`, () => [...(this.eventsByTask.get(taskId)?.values() ?? [])].sort((a, b) => a.seq - b.seq));
  }

  async diff(taskId: string): Promise<FileDiff[]> {
    return this.get<FileDiff[]>(`/api/tasks/${taskId}/diff`);
  }

  async diffFile(taskId: string, path: string): Promise<FileContents> {
    return this.get<FileContents>(`/api/tasks/${taskId}/diff/file?path=${encodeURIComponent(path)}`);
  }

  usageSummary(taskId: string): Promise<TaskUsageSummary> { return this.get(`/api/tasks/${taskId}/usage`); }
  usageCalls(taskId: string, after = 0): Promise<TaskUsagePage> { return this.get(`/api/tasks/${taskId}/usage/calls?after=${after}&limit=20`); }
  briefing(taskId: string): Promise<ChangeBriefingResponse> { return this.get(`/api/tasks/${taskId}/briefing`); }
  generateBriefing(taskId: string, rewrite = false): Promise<ChangeBriefingResponse> { return this.post(`/api/tasks/${taskId}/briefing`, { rewrite }); }
  editPrDraft(taskId: string, confirmation: PrConfirmation): Promise<Extract<TaskEvent, { type: "pr_draft" }>> { return this.post(`/api/tasks/${taskId}/pr-draft/edit`, confirmation); }
  explanations(taskId: string): Promise<DiffExplanationsResponse> {
    return this.get(`/api/tasks/${taskId}/explanations`);
  }

  async regenerateExplanations(taskId: string): Promise<void> {
    await this.post(`/api/tasks/${taskId}/explanations`, {});
  }

  async merge(taskId: string): Promise<void> {
    await this.post(`/api/tasks/${taskId}/merge`, {});
  }

  preparePrDraft(taskId: string): Promise<Extract<TaskEvent, { type: "pr_draft" }>> {
    return this.post(`/api/tasks/${taskId}/pr/draft`, {});
  }

  abandonPrUpdate(taskId: string): Promise<import("@agent-hub/shared").PrUpdate> {
    return this.post(`/api/tasks/${taskId}/pr/abandon-update`, { confirmed: true });
  }

  updatePr(taskId: string, revision: import("@agent-hub/shared").PrRevision): Promise<import("@agent-hub/shared").PrUpdate> {
    return this.post(`/api/tasks/${taskId}/pr/update`, { confirmed: true, revision });
  }

  openPr(taskId: string, confirmation?: PrConfirmation): Promise<{ number: number; url: string }> {
    return this.post(`/api/tasks/${taskId}/pr`, confirmation ?? {});
  }

  async setPinned(taskId: string, pinned: boolean): Promise<void> {
    // The stream (and reconnect snapshot) owns task state. A delayed command response may
    // predate a lifecycle update, an opposite pin command on another device, or deletion.
    await this.post(`/api/tasks/${taskId}/pin`, { pinned });
  }

  async deleteTask(taskId: string): Promise<void> {
    await this.send("DELETE", `/api/tasks/${taskId}`);
  }

  async discard(taskId: string): Promise<void> {
    await this.post(`/api/tasks/${taskId}/discard`, {});
  }

  async createTask(input: NewTaskInput): Promise<Task> {
    const task = await this.post<Task>("/api/tasks", input);
    this.upsertTask(task);
    return task;
  }

  async sendMessage(taskId: string, text: string, images?: ImageUpload[]): Promise<void> {
    await this.post(`/api/tasks/${taskId}/messages`, { text, images: images?.length ? images : undefined });
  }

  async stopTask(taskId: string): Promise<void> {
    await this.post(`/api/tasks/${taskId}/stop`, {});
  }

  async recover(taskId: string, action: RecoverAction): Promise<void> {
    await this.post(`/api/tasks/${taskId}/recover`, { action });
  }

  async continueNow(taskId: string): Promise<void> {
    await this.post(`/api/tasks/${taskId}/continue-now`, {});
  }

  async stopWaiting(taskId: string): Promise<void> {
    await this.post(`/api/tasks/${taskId}/stop-waiting`, {});
  }

  async answer(taskId: string, eventId: string, answer: string): Promise<void> {
    await this.post(`/api/tasks/${taskId}/answer`, { eventId, answer });
  }

  hosts(): Promise<Host[]> {
    return this.get<Host[]>("/api/hosts");
  }

  saveHost(name: string, host: Partial<Host>): Promise<Host> {
    return this.send<Host>("PUT", `/api/hosts/${encodeURIComponent(name)}`, host);
  }

  async deleteHost(name: string): Promise<void> {
    await this.send("DELETE", `/api/hosts/${encodeURIComponent(name)}`);
  }

  testHost(name: string): Promise<{ ok: boolean; output: string }> {
    return this.post(`/api/hosts/${encodeURIComponent(name)}/test`, {});
  }

  hostLog(name: string): Promise<SshLogEntry[]> {
    return this.get<SshLogEntry[]>(`/api/hosts/${encodeURIComponent(name)}/log`);
  }

  private modelsPromise: Promise<ModelCatalog> | null = null;
  models(): Promise<ModelCatalog> {
    // Once per page load; a failure is not remembered, so the next dialog asks again.
    this.modelsPromise ??= this.get<ModelCatalog>("/api/models").catch((err) => {
      this.modelsPromise = null;
      throw err;
    });
    return this.modelsPromise;
  }

  publicKey(): Promise<{ keyPath: string; publicKey: string } | null> {
    return this.get("/api/ssh/public-key");
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // --- internals ---

  private openStream(): void {
    const es = new EventSource("/api/stream");
    this.source = es;
    // `open` fires on every (re)connect. Whatever happened while disconnected is re-read, which is
    // why each stream message only needs to be an upsert.
    es.onopen = () => {
      this.setConnection("live");
      void this.resync();
    };
    es.onerror = () => this.setConnection("reconnecting");
    es.onmessage = (e) => this.apply(JSON.parse(e.data) as StreamMessage);
  }

  private apply(m: StreamMessage): void {
    if (this.resyncMessages) { this.resyncMessages.push(m); return; }
    if (m.type === "task_summary") {
      if (!this.tasks.has(m.summary.taskId)) return;
      this.summaries.set(m.summary.taskId, m.summary);
      this.changed();
    } else if (m.type === "task") this.upsertTask(m.task);
    else if (m.type === "task_deleted") {
      this.tasks.delete(m.taskId);
      this.summaries.delete(m.taskId);
      this.eventsByTask.delete(m.taskId);
      this.changed();
    }
    else if (m.type === "event") {
      const map = this.eventsByTask.get(m.event.taskId);
      if (!map) return; // not opened yet; it is fetched whole when it is
      map.set(m.event.id, m.event);
      this.changed();
    }
  }

  /** Re-read the task list and every opened transcript. Returns false when not authorized. */
  private async resync(): Promise<boolean> {
    if (this.resyncMessages) return true;
    this.resyncMessages = [];
    try {
      const res = await fetch("/api/task-list");
      if (res.status === 401) {
        this.setConnection("unauthorized");
        this.source?.close();
        return false;
      }
      const { tasks: list, summaries } = (await res.json()) as { tasks: Task[]; summaries: TaskListSummary[] };
      this.summaries = new Map(summaries.map((s) => [s.taskId, s]));
      this.tasks = new Map(list.map((t) => [t.id, t]));
      this.changed();
    } finally {
      // The HTTP snapshot can predate messages received during repository discovery.
      const messages = this.resyncMessages;
      this.resyncMessages = null;
      for (const message of messages) this.apply(message);
    }
    await Promise.all([...this.eventsByTask.keys()].map((id) => this.loadEvents(id, true)));
    return true;
  }

  private async loadEvents(taskId: string, replace = false): Promise<void> {
    // Created before the request so stream messages arriving meanwhile are kept, not dropped.
    if (!this.eventsByTask.has(taskId)) this.eventsByTask.set(taskId, new Map());
    const initialMap = this.eventsByTask.get(taskId)!;
    const before = new Map(initialMap);
    const res = await fetch(`/api/tasks/${taskId}/events`);
    if (!res.ok) return;
    const list = (await res.json()) as TaskEvent[];
    const map = this.eventsByTask.get(taskId);
    if (map !== initialMap) return; // A deletion or replacement happened while the snapshot loaded.
    const streamed = [...map.values()].filter((event) => before.get(event.id) !== event);
    // Comment records are immutable and only removed with their task. A reconnect snapshot may
    // predate an event replayed just before this transcript request began.
    const commentRecords = [...map.values()].filter((event) => event.type === "issue_comment_draft" || event.type === "issue_comment_outcome" || (event.type === "task_proposal" && !list.some((item) => item.id === event.id)));
    if (replace) map.clear();
    for (const e of list) if (!map.has(e.id)) map.set(e.id, e);
    for (const e of commentRecords) map.set(e.id, e);
    for (const e of streamed) map.set(e.id, e);
    this.changed();
  }

  private upsertTask(task: Task): void {
    this.tasks.set(task.id, task);
    this.changed();
  }

  private async get<T>(url: string): Promise<T> {
    const res = await fetch(url);
    if (res.status === 401) this.setConnection("unauthorized");
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw responseError(data, res.status);
    return data as T;
  }

  private post<T = unknown>(url: string, body: unknown): Promise<T> {
    return this.send<T>("POST", url, body);
  }

  private async send<T = unknown>(method: string, url: string, body?: unknown): Promise<T> {
    const res = await fetch(url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (res.status === 401) this.setConnection("unauthorized");
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw responseError(data, res.status);
    return data as T;
  }

  private setConnection(c: Connection): void {
    if (this.conn === c) return;
    this.conn = c;
    this.changed();
  }

  private changed(): void {
    this.version++;
    for (const l of this.listeners) l();
  }

  private memo<T>(key: string, compute: () => T): T {
    const hit = this.cache.get(key);
    if (hit && hit.v === this.version) return hit.value as T;
    const value = compute();
    this.cache.set(key, { v: this.version, value });
    return value;
  }
}

export function label(agent: string | undefined): string {
  return t(agent === "gemini" ? "agent.gemini" : agent === "codex" ? "agent.codex" : agent === "claude" ? "agent.claude" : "role.agent");
}

const http = new HttpClient();
void http.start();
export const client: HubClient = http;

const subscribe = (l: () => void) => client.subscribe(l);
export const useTasks = () => useSyncExternalStore(subscribe, () => client.listTasks());
export const useEvents = (taskId: string) => useSyncExternalStore(subscribe, () => client.events(taskId));
export const useConnection = () => useSyncExternalStore(subscribe, () => client.connection());

export const useTaskSummaries = () => useSyncExternalStore(subscribe, () => client.taskSummaries());
