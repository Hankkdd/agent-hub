import { ROOM_BRIEF_MAX, ROOM_QUOTE_BYTES, ROOM_EXCHANGE_TEXT, type RoomCreateInput, type RoomMessageInput, type RoomQuote, type RoomSelection } from "@agent-hub/shared";
import { Documents } from "./documents";
import { roomWorkflow } from "./workflows/room";
import { latestVideoAnalysis, type VideoAnalysisKind } from "@agent-hub/shared";
import { ANALYSIS_LIMITS, requestedAnalysis, runVideoAnalysis } from "./video-analysis";
import { validateIssueSelection, type IssueReference } from "@agent-hub/shared";
import { measuredRun, recoverInvocations, usagePage, usageSummary, HOST_INPUT_EVENT_WINDOW, HOST_INPUT_TEXT_LIMIT, type InvocationContext } from "./invocations";
import { readTaskLog, readTaskTestOutput, searchTaskLog } from "./task-log";
import type { VideoSourceOptions } from "../media/video";
import type { HostStatus } from "../deploy/host-status";
import { PlannerDispatch } from "./planner-dispatch";
import type { Outcome, TurnImages, WorkflowDeps } from "./workflows/types";
import { planWorkflow } from "./workflows/plan";
import { implementWorkflow } from "./workflows/implement";
import { reviewWorkflow, DEFAULT_MAX_ROUNDS } from "./workflows/review";
import { videoWorkflow, transcriptPath, URL_RE } from "./workflows/video";
import { IssueComments, initialCommentDraft, validateIssueSummary, normalizedCommentRepo } from "./issue-comments";
import { quotaRecovered } from "./quota-recovery";
import { withAgentFallback, configuredAgents } from "./agent-fallback";
import { captureHandoff, HANDOFF_EVENT_LIMIT, HANDOFF_SYSTEM, handoffFacts, handoffIdentity, validateHandoff, deliverHandoff, handoffPrefix } from "./handoff";
import { briefingAbortable } from "./briefing";
import { DiffExplanations } from "./diff-explanations";
import { ChangeBriefings } from "./change-briefings";
import { firstLine } from "./text";
import { geminiRecent } from "../agents/gemini";
import { classifyAgentError, limitResetsAt } from "../agents/errors";
import { QuotaService } from "./quota";
import { abandonPrUpdate, updatePr, lastPrUpdate, updateFinished, sameRevision, updateReportOutcome } from "./pr-update";
import { PullRequests } from "./pull-requests";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { and, asc, desc, eq, inArray, notInArray, max, sql } from "drizzle-orm";
import { activeMainSession, defaultAgent, defaultEffort, defaultModel, validateScopeEstimate, type InvocationEndReason } from "@agent-hub/shared";
import type {
  SwitchAgentInput,
  HandoffOperation,
  ChangeBriefing,
  ChangeBriefingResponse,
  AgentKind,
  HostInputComponents,
  DiffExplanationsResponse,
  EffortLevel,
  FileContents,
  ImageAttachment,
  ImageUpload,
  ModelCatalog,
  ModelChoice,
  FileDiff,
  NewTaskInput,
  RecoverAction,
  Session,
  StreamMessage,
  Task,
  TaskEvent,
  TaskEventPayload,
  PrConfirmation,
  PrRevision,
  PrUpdate,
  TaskOptions,
  TaskStatus,
  RepoSettings,
  Workspace,
} from "@agent-hub/shared";
import { schema, type Db } from "../db/index";
import type { AgentAdapter, AgentRunInput, PermissionDecision, PermissionRequest } from "../agents/types";
import { findingCatalogue, findingHash, findingIdentity, validateFinding } from "./findings";
import { exportFindings } from "./finding-export";
import { ProjectDocuments } from "./project-documents";
import type { FindingTools, PlanningTools, ToolServer } from "../tools/mcp";
import type { Forge } from "../workspace/forge";
import { AttachmentError, attachmentPath, attachmentsDir, saveImages, validateImages } from "./attachments";
import { abandonedUntrackedBlock, assertBaseBranchExists, baseBranchRef, createWorktree, removePlanCheckout, syncPlanCheckout, diffFiles, fileContents, git, isGitRepo, mergeWorktree, removeWorktree } from "../workspace/git";
import { resolveRulePacks } from "./rule-packs";
import { readRepoSettings, repoPath, validateTicket } from "./repo-settings";
import { ensureToolchainImage } from "../docker/toolchain";
import {
  SCOPE_GUIDANCE,
  SYSTEM_APPEND,
  continuePrompt,
} from "./prompts";

export { parseExplanations } from "./diff-explanations";
export { continuePrompt, reviewPrompt, findingsPrompt, parseReview, summaryPrompt } from "./prompts";

const { tasks, sessions, events, queuedMessages } = schema;

export class HubError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    message: string,
  ) {
    super(message);
  }
}

export interface HubOptions {
  video?: VideoSourceOptions;
  db: Db;
  agents: Partial<Record<AgentKind, AgentAdapter>>;
  /** Root for scratch directories and worktrees. */
  dataDir: string;
  /** How many turns may run at once across all tasks (design.md §7.1). */
  maxConcurrent: number;
  /** Throttle for streaming text to the DB and the browser. */
  flushMs?: number;
  /** Agent Hub's own tools (ssh) over MCP. Absent: agents get none. */
  tools?: ToolServer;
  hostStatus?: Pick<HostStatus, "status" | "serviceLog">;
  /** Where branches become pull requests (GitHub). Absent: only local merge is offered. */
  forge?: Forge;
  /** Readable reference repositories, exposed only to planning turns. */
  referenceDirs?: string[];
  /** Injectable clock, for the quota-pause timer. */
  now?: () => number;
  /** How often paused tasks are checked for a lifted usage limit. */
  quotaResumeMs?: number;
  /** Injectable image builder so workflow tests use fake agents without Docker. */
  ensureToolchainImage?: typeof ensureToolchainImage;
}

const AGENT_LABEL: Record<AgentKind, string> = { claude: "Claude", codex: "Codex", gemini: "Gemini" };

/**
 * The core: tasks, sessions and events in SQLite, a live stream of changes, the scheduler that runs
 * turns, and the workflows a turn runs (design.md §5.2). Every state change goes through here and is
 * broadcast as the whole record (StreamMessage), so a client can always rebuild its view by re-reading.
 */
export class Hub {
  readonly issueComments: IssueComments;
  private readonly pullRequests: PullRequests;
  private readonly plannerDispatch: PlannerDispatch;
  private readonly workflowDeps: WorkflowDeps;
  private readonly quotaService: QuotaService;
  private readonly db: Db;
  private readonly bus = new EventEmitter();
  /** Turns in flight, by task. */
  private readonly active = new Map<string, AbortController>();
  /** Why an active controller was aborted, when the Hub did it on purpose; timeouts leave no entry. */
  private readonly endReasons = new WeakMap<AbortSignal, InvocationEndReason>();
  /** Tasks with a turn ready to run but no free slot, oldest first. */
  private readonly waiting: string[] = [];
  /** Resolves when the task's current turn finishes; lets tests and shutdown wait. */
  private readonly turnDone = new Map<string, Promise<void>>();
  private readonly handoffs = new Map<string, { operation: HandoffOperation; ac: AbortController; done: Promise<Task> }>();
  private commitMessages: StreamMessage[] | undefined;
  private shuttingDown = false;
  private recovering = false;
  private quotaTimer: NodeJS.Timeout | undefined;
  private resumeRunning = false;
  // Replayed planner reports preserve their workflow, but cannot authorize external writes on boot.
  private readonly findingExports = new Map<string, { ac: AbortController; done: Promise<void> }>();
  private readonly startupReportTurns = new Set<string>();
  private readonly changeBriefings: ChangeBriefings;
  private readonly diffExplanations: DiffExplanations;
  /** Permission requests waiting for the user, by their `waiting_user` event id. */
  private readonly approvals = new Map<string, { taskId: string; resolve: (d: PermissionDecision) => void }>();
  /** What each running task is doing, restored after an approval pauses it. */
  private readonly activity = new Map<string, string>();
  private readonly modelCache = new Map<AgentKind, { models: ModelChoice[]; until: number }>();

  constructor(private readonly opts: HubOptions) {
    this.db = opts.db;
    this.issueComments = new IssueComments({ task: (id) => this.getTask(id), events: (id) => this.events(id),
      append: (id, payload) => this.append(id, null, payload), forge: opts.forge });
    this.diffExplanations = new DiffExplanations({
      db: this.db,
      agents: opts.agents,
      measuredRun: (adapter, input, context) => this.measuredRun(adapter, input, context),
      quota: (force = false) => this.quotaService.read(force).catch(() => undefined),
      getTask: (id) => this.getTask(id),
      events: (id) => this.events(id),
      append: (id, sessionId, payload) => this.append(id, sessionId, payload),
      patch: (id, fields) => this.patch(id, fields),
      publishTask: (id) => this.publishTask(id),
      setSessionStatus: (id, status) => this.setSessionStatus(id, status),
      idleWorkspace: (task) => this.idleWorkspace(task),
      isBusy: (id) => this.isBusy(id),
      taskImage: (task, agent, sessionId) => this.taskImage(task, agent, sessionId),
      shuttingDown: () => this.shuttingDown,
    });
    this.changeBriefings = new ChangeBriefings({
      agents: opts.agents,
      measuredRun: (adapter, input, context) => this.measuredRun(adapter, input, context),
      quota: (force = false) => this.quotaService.read(force).catch(() => undefined),
      active: this.active,
      turnDone: this.turnDone,
      getTask: (id) => this.getTask(id),
      taskExists: (id) => !!this.db.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, id)).get(),
      events: (id) => this.events(id),
      append: (id, sessionId, payload) => this.append(id, sessionId, payload),
      idleWorkspace: (task) => this.idleWorkspace(task),
      taskImage: (task, agent, sessionId) => this.taskImage(task, agent, sessionId),
      nextWaiting: () => this.waiting.shift(),
      kick: (id) => this.kick(id),
      hasQueued: (id) => this.hasQueued(id),
      shuttingDown: () => this.shuttingDown,
    });
    this.pullRequests = new PullRequests({
      conflictReport: (task, seq) => this.plannerDispatch.deliverReport(task, seq, "conflict"),
      forge: opts.forge,
      agents: opts.agents,
      quota: (force = false) => this.quotaService.read(force).catch(() => undefined),
      writerSession: (task, agent) => this.writerSession(task, agent),
      active: this.active,
      turnDone: this.turnDone,
      activity: this.activity,
      getTask: (id) => this.getTask(id),
      listTasks: () => this.listTasks(),
      events: (id) => this.events(id),
      append: (id, sessionId, payload) => this.append(id, sessionId, payload),
      updateWorkspace: (id, fields) => this.updateWorkspace(id, fields),
      idleWorkspace: (task) => this.idleWorkspace(task),
      closeWorkspace: (task, state, reason) => this.closeWorkspace(task, state, reason),
      setStatus: (id, status, activity) => this.setStatus(id, status, activity),
      isBusy: (id) => this.isBusy(id),
      hasQueued: (id) => this.hasQueued(id),
      kick: (id) => this.kick(id),
      nextWaiting: () => this.waiting.shift(),
      shuttingDown: () => this.shuttingDown,
      ensureBriefing: (id, ac) => this.ensureBriefing(id, ac),
      currentBriefing: (id, generationId) => this.changeBriefings.currentBriefing(id, generationId),
      requests: (id) => this.requests(id),
      streamAgent: (task, session, prompt, ac, o) => this.streamAgent(task, session, prompt, ac, o),
    });
    this.workflowDeps = {
      video: opts.video,
      dataDir: opts.dataDir,
      referenceDirs: opts.referenceDirs,
      forge: opts.forge,
      streamAgent: (task, session, prompt, ac, o) => this.streamAgent(task, session, prompt, ac, o),
      session: (task, role) => this.session(task, role),
      append: (id, sessionId, payload) => this.append(id, sessionId, payload),
      patch: (id, fields) => this.patch(id, fields),
      setRunning: (id, activity) => this.setRunning(id, activity),
      publishTask: (id) => this.publishTask(id),
      updateTitle: (id, title) => this.db.update(tasks).set({ title }).where(eq(tasks.id, id)).run(),
      diff: (id) => this.diff(id),
      requests: (id) => this.requests(id),
      listTasks: () => this.listTasks(),
      getTask: (id) => this.getTask(id),
      events: (id) => this.events(id),
      previousProjectBootstrap: (taskId, sessionId, beforeSeq) => {
        try {
          // Oversized serialized events can fail bounded JSON parsing; that means unknown, not a turn failure.
          const payload = sql`substr(${events.payload}, 1, ${HOST_INPUT_TEXT_LIMIT})`;
          const row = this.db.select({ id: events.id, output: sql<unknown>`json_extract(${payload}, '$.output')` }).from(events)
            .where(and(eq(events.taskId, taskId), eq(events.sessionId, sessionId), eq(events.type, "tool_call"),
              sql`${events.seq} < ${beforeSeq} AND ${events.seq} >= ${beforeSeq - HOST_INPUT_EVENT_WINDOW}`,
              sql`json_extract(${payload}, '$.name') = 'project_docs_bootstrap'`))
            .orderBy(desc(events.seq)).limit(1).get();
          return row && typeof row.output === "string" ? { eventId: row.id, output: row.output } : undefined;
        } catch { return undefined; }
      },
    };
    this.plannerDispatch = new PlannerDispatch({
      forge: opts.forge,
      getTask: (id) => this.getTask(id),
      listTasks: () => this.listTasks(),
      events: (id) => this.events(id),
      append: (id, sessionId, payload) => this.append(id, sessionId, payload),
      proposalEvent: (taskId, eventId) => {
        const row = this.db.select().from(events)
          .where(and(eq(events.id, eventId), eq(events.taskId, taskId))).get();
        return row ? toEvent(row) : null;
      },
      hasQueuedEvent: (id) => !!this.db.select().from(queuedMessages).where(eq(queuedMessages.eventId, id)).get(),
      insertQueuedMessage: (message) => this.db.insert(queuedMessages).values(message).run(),
      transaction: (action) => this.db.transaction(action),
      createTask: (input, validate) => this.createTask(input, validate),
      sendMessage: (id, text) => this.sendMessage(id, text),
      repoSettings: (repoPath) => this.repoSettings(repoPath),
      isBusy: (id) => this.isBusy(id),
      kick: (id) => this.kick(id),
      recovering: () => this.recovering,
      readyForPr: (task) => this.readyForPr(task),
      idleWorkspace: (task) => this.idleWorkspace(task),
      preparePrDraft: (id) => this.preparePrDraft(id),
      openPr: (id, confirmation) => this.openPr(id, confirmation),
      updatePr: (id, revision, plan) => this.updatePr(id, revision, plan),
      abandonPrUpdate: (id, plan) => this.abandonPrUpdate(id, plan),
      findingHistory: () => this.findingHistory(),
    });
    this.quotaService = new QuotaService(opts.agents, opts.now);
    this.bus.setMaxListeners(0);
  }

  /** Presentation metadata only: no activity, workspace or workflow transitions. */
  setPinned(taskId: string, pinned: boolean): Task {
    if (typeof pinned !== "boolean") throw new HubError(400, "pinned must be a boolean");
    const event = this.db.transaction(() => {
      const task = this.getTask(taskId);
      if (!!task.options.pinnedAt === pinned) return null;
      // Serialize allocation with the mutation, including same-millisecond requests and clock rollback.
      const latest = this.db.select({ value: sql<string | null>`max(json_extract(${tasks.options}, '$.pinnedAt'))` }).from(tasks).get()?.value;
      const pinnedAt = pinned ? new Date(Math.max(Date.now(), latest ? Date.parse(latest) + 1 : 0)).toISOString() : null;
      const options = { ...task.options };
      if (pinnedAt) options.pinnedAt = pinnedAt;
      else delete options.pinnedAt;
      const last = this.db.select({ seq: max(events.seq) }).from(events).where(eq(events.taskId, taskId)).get();
      const row = { id: randomUUID(), taskId, sessionId: null, seq: (last?.seq ?? 0) + 1,
        type: "pin_changed", payload: { pinnedAt }, createdAt: new Date().toISOString() };
      this.db.insert(events).values(row).run();
      this.db.update(tasks).set({ options }).where(eq(tasks.id, taskId)).run();
      return toEvent(row);
    }, { behavior: "immediate" });
    // Subscribers must only see committed events and the matching projection.
    if (event) {
      this.emit({ type: "event", event });
      this.publishTask(taskId);
    }
    return this.getTask(taskId);
  }

  quota(force = false) { return this.quotaService.read(force); }

  // ---------- reads ----------

  listTasks(): Task[] {
    return this.db
      .select()
      .from(tasks)
      .all()
      .map((row) => this.toTask(row))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  getTask(id: string): Task {
    const row = this.db.select().from(tasks).where(eq(tasks.id, id)).get();
    if (!row) throw new HubError(404, `no task ${id}`);
    return this.toTask(row);
  }

  events(taskId: string): TaskEvent[] {
    this.getTask(taskId);
    return this.db.select().from(events).where(eq(events.taskId, taskId)).orderBy(asc(events.seq)).all().map(toEvent);
  }

  /**
   * What each agent offers, for the model picker. Asked live (the lists change as models ship), cached
   * for an hour; an agent that cannot answer gives an empty list, retried after a minute.
   */
  async models(): Promise<ModelCatalog> {
    const now = Date.now();
    // The empty Gemini entry signals chat availability; it offers no model selection.
    const out = {} as ModelCatalog;
    await Promise.all(
      (Object.keys(this.opts.agents) as AgentKind[]).map(async (kind) => {
        const hit = this.modelCache.get(kind);
        if (hit && hit.until > now) return void (out[kind] = hit.models);
        try {
          const models = (await this.opts.agents[kind]!.listModels?.()) ?? [];
          this.modelCache.set(kind, { models, until: now + 60 * 60_000 });
          out[kind] = models;
        } catch (err) {
          console.warn(`listing ${kind} models failed:`, err instanceof Error ? err.message : err);
          this.modelCache.set(kind, { models: hit?.models ?? [], until: now + 60_000 });
          out[kind] = hit?.models ?? [];
        }
      }),
    );
    return out;
  }

  async diff(taskId: string): Promise<FileDiff[]> {
    const ws = this.getTask(taskId).workspace;
    if (!ws) return [];
    const update = lastPrUpdate(this.events(taskId));
    // Reading integration progress must not turn unknown leftovers into index entries before abandonment.
    const files = await diffFiles(ws, !!update && (update.owned || !updateFinished(update) ||
      (update.stage === "abandoned" && !!update.retainedUntracked?.total)));
    if (ws.state !== "active" || !fs.existsSync(ws.worktreePath)) return files;
    const rows = (await git(ws.worktreePath, ["diff", "--numstat", "-z", ws.baseSha])).stdout.split("\0");
    const result: FileDiff[] = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!;
      if (!row) continue;
      const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(row);
      if (!match) continue;
      let file = match[3]!;
      if (!file) { i++; file = rows[++i]!; } // -z rename records carry old and new paths separately
      const binary = match[1] === "-" || match[2] === "-";
      result.push({ path: file, status: files.find((f) => f.path === file)?.status ?? "modified", additions: binary ? 0 : Number(match[1]), deletions: binary ? 0 : Number(match[2]), ...(binary ? { binary: true } : {}) });
    }
    return result;
  }

  async diffFile(taskId: string, file: string): Promise<FileContents> {
    const ws = this.getTask(taskId).workspace;
    if (!ws || ws.state !== "active") throw new HubError(409, "this task has no active worktree");
    return fileContents(ws, file);
  }

  async explanations(taskId: string): Promise<DiffExplanationsResponse> {
    return this.diffExplanations.explanations(taskId);
  }

  regenerateExplanations(taskId: string): void {
    return this.diffExplanations.regenerateExplanations(taskId);
  }

  async briefing(taskId: string): Promise<ChangeBriefingResponse> {
    return this.changeBriefings.briefing(taskId);
  }

  generateBriefing(taskId: string, rewrite = false): Promise<ChangeBriefing> {
    return this.changeBriefings.generateBriefing(taskId, rewrite);
  }

  /** Kept on the Hub because tests intercept briefing failures at the PR boundary. */
  private ensureBriefing(taskId: string, ac: AbortController, rewrite = false): Promise<ChangeBriefing> {
    return this.changeBriefings.ensureBriefing(taskId, ac, rewrite);
  }

  subscribe(listener: (m: StreamMessage) => void): () => void {
    this.bus.on("message", listener);
    return () => this.bus.off("message", listener);
  }

  // ---------- commands ----------

  async repoSettings(repository: string): Promise<RepoSettings | null> {
    if (!repository.trim()) throw new HubError(400, "path is required");
    let dir = repoPath(repository.trim());
    if (fs.existsSync(dir) && await isGitRepo(dir)) dir = (await git(dir, ["rev-parse", "--show-toplevel"])).stdout.trim();
    try { return readRepoSettings(this.opts.dataDir, dir); }
    catch (err) { throw new HubError(400, err instanceof Error ? err.message : String(err)); }
  }

  async createRoom(input: RoomCreateInput): Promise<Task> {
    if (!input || typeof input.documentId !== "string") throw new HubError(400, "documentId is required");
    const document = new Documents(this.db).get(input.documentId);
    const brief = this.roomBrief(input.brief === undefined ? "" : input.brief);
    const members = ["claude", "codex"] as const;
    for (const member of members) {
      if (!this.opts.agents[member]) throw new HubError(400, `${member} is not connected`);
      const model = input[member === "claude" ? "claudeModel" : "codexModel"];
      if (model !== undefined && typeof model !== "string") throw new HubError(400, "Invalid room model");
    }
    const id = randomUUID(), now = new Date().toISOString();
    const cwd = path.join(this.opts.dataDir, "scratch", id);
    fs.mkdirSync(cwd, { recursive: true });
    this.db.transaction(() => {
      this.db.insert(tasks).values({ id, title: `Room: ${document.currentRevision.title}`, workflow: "room", status: "idle", cwd,
        options: { room: { documentId: document.id, brief }, noDevices: true }, createdAt: now, updatedAt: now }).run();
      for (const agent of members) this.db.insert(sessions).values({ id: randomUUID(), taskId: id, agent, role: "main",
        model: input[agent === "claude" ? "claudeModel" : "codexModel"]?.trim() || defaultModel("room") || null,
        effort: defaultEffort("room"), sdkThreadId: null, status: "idle" }).run();
    });
    this.publishTask(id);
    return this.getTask(id);
  }

  newestRoom(documentId: string): Task | null {
    const row = this.db.select().from(tasks).where(eq(tasks.workflow, "room"))
      .orderBy(desc(tasks.createdAt), sql`rowid DESC`).all().find(row => (row.options as TaskOptions).room?.documentId === documentId);
    return row ? this.toTask(row) : null;
  }

  private roomBrief(brief: unknown): string {
    if (typeof brief !== "string" || brief.length > ROOM_BRIEF_MAX) throw new HubError(400, "Invalid room brief");
    return brief;
  }

  updateRoomBrief(taskId: string, brief: unknown): Task {
    const task = this.getTask(taskId);
    if (task.workflow !== "room" || !task.options.room) throw new HubError(409, "Task is not a room");
    this.db.update(tasks).set({ options: { ...task.options, room: { ...task.options.room, brief: this.roomBrief(brief) } } }).where(eq(tasks.id, taskId)).run();
    this.touch(taskId);
    this.publishTask(taskId);
    return this.getTask(taskId);
  }

  exchangeRoom(taskId: string): void {
    if (this.getTask(taskId).workflow !== "room") throw new HubError(409, "Task is not a room");
    this.sendMessage(taskId, ROOM_EXCHANGE_TEXT, undefined, { exchange: true });
  }

  async createTask(input: NewTaskInput, validate?: () => void): Promise<Task> {
    try { validateIssueSelection(input.issue, input.issueCompletion); }
    catch (err) { throw new HubError(400, String(err)); }
    const sourceProposal = input.fromProposal ? this.plannerDispatch.unstartedProposal(input.fromProposal) : undefined;
    let scopeEstimate;
    try { scopeEstimate = validateScopeEstimate(input.scopeEstimate === undefined ? sourceProposal?.scopeEstimate : input.scopeEstimate); }
    catch (err) { throw new HubError(400, err instanceof Error ? err.message : String(err)); }
    const message = input.message.trim();
    if (!message && !input.images?.length) throw new HubError(400, "message is empty");
    // Checked before anything is created, so a bad picture leaves no empty task behind.
    try {
      validateImages(input.images);
    } catch (err) {
      throw new HubError(400, err instanceof AttachmentError ? err.message : String(err));
    }
    const wf = input.workflow;
    const agent = input.agent ?? defaultAgent(wf, wf === "review" ? "author" : "main");
    const reviewer = input.reviewer ?? defaultAgent(wf, "reviewer");
    let outputSchema: TaskOptions["outputSchema"];
    if (input.outputSchema !== undefined) {
      if (wf !== "chat") throw new HubError(400, "outputSchema is only supported for chat tasks");
      if (agent !== "codex" && agent !== "claude") throw new HubError(400, "outputSchema is not supported for Gemini; use Codex or Claude");
      const schema = input.outputSchema;
      if (schema === null || typeof schema !== "object" || Array.isArray(schema) || ![Object.prototype, null].includes(Object.getPrototypeOf(schema)))
        throw new HubError(400, "outputSchema must be a plain JSON object");
      try {
        const json = JSON.stringify(schema);
        if (Buffer.byteLength(json, "utf8") > 32 * 1024) throw new Error("outputSchema exceeds 32 KB");
        outputSchema = JSON.parse(json) as Record<string, unknown>;
      } catch (err) { throw new HubError(400, err instanceof Error ? err.message : "outputSchema must be JSON serializable"); }
    }
    // Gemini has no MCP/workspace access and is never an author, reviewer or auxiliary writer.
    if ((agent === "gemini" && wf !== "chat") || input.reviewer === "gemini")
      throw new HubError(400, "Gemini supports chat only; it cannot run plan, implement, review or video tasks");
    if (agent === "gemini" && input.images?.length) throw new HubError(400, "Gemini chat does not support images yet");
    const reviewerModel = reviewer === defaultAgent(wf, "reviewer") ? defaultModel(wf, "reviewer") : undefined;
    const main = { agent, model: input.model?.trim() || null, effort: input.effort ?? defaultEffort(wf, wf === "review" ? "author" : "main") };
    const roles: { agent: AgentKind; role: Session["role"]; model: string | null; effort: EffortLevel }[] =
      wf === "chat" || wf === "plan" || wf === "implement" || wf === "video"
        ? [{ ...main, role: "main" }]
        : wf === "review"
          ? [
              { ...main, role: "author" },
              {
                // Explicit agent choices take precedence over shared defaults.
                agent: reviewer,
                role: "reviewer",
                model: input.reviewerModel === undefined ? reviewerModel ?? null : input.reviewerModel.trim() || null,
                effort: input.reviewerEffort ?? defaultEffort(wf, "reviewer"),
              },
            ]
          : [];
    if (roles.length === 0) throw new HubError(400, `The ${input.workflow} workflow is not available yet.`);
    for (const r of roles) if (!this.opts.agents[r.agent]) throw new HubError(400, `${AGENT_LABEL[r.agent] ?? r.agent} is not connected.`);

    const selectedNumber = input.issue === undefined ? sourceProposal?.issue?.number : input.issue;
    let selectedIssue: IssueReference | undefined;
    const selectionRepo = input.repoPath?.trim() ? expandHome(input.repoPath.trim()) : undefined;
    let selectedRepo: string | null | undefined;
    if (sourceProposal && selectedNumber != null && (!selectionRepo || !this.getTask(sourceProposal.taskId).cwd || fs.realpathSync(selectionRepo) !== fs.realpathSync(this.getTask(sourceProposal.taskId).cwd!)))
      throw new HubError(400, "A proposal must start in its planning repository");
    if (selectedNumber != null) {
      if (!["plan", "implement", "review"].includes(wf) || !selectionRepo || !this.opts.forge)
        throw new HubError(400, "Issue selection requires a repository and host Forge access");
      selectedRepo = await this.opts.forge.repoOf(selectionRepo);
      if (!selectedRepo) throw new HubError(400, "This repository has no GitHub remote (origin)");
      try {
        const issue = await this.opts.forge.readIssue(selectedRepo, selectedNumber);
        selectedIssue = { number: issue.number, url: issue.url };
      } catch (err) { throw new HubError(400, err instanceof Error ? err.message : String(err)); }
    }
    const id = randomUUID();
    let cwd: string;
    let workspace: Workspace | null = null;
    let planCheckout: TaskOptions["planCheckout"];
    const dir = input.repoPath?.trim() ? expandHome(input.repoPath.trim()) : null;
    if (dir && (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory())) throw new HubError(400, `not a directory: ${dir}`);
    let configured = dir && (wf === "plan" || wf === "implement" || wf === "review") ? await this.repoSettings(dir) : null;
    let appliedRules: TaskOptions["appliedRules"];
    if (configured?.rules) {
      try { appliedRules = resolveRulePacks(this.opts.dataDir, dir!, configured.rules); }
      catch (err) { throw new HubError(400, err instanceof Error ? err.message : String(err)); }
    }
    const findingExport = configured?.documentsDir && configured.findings ? { documentsDir: configured.documentsDir, owner: configured.findings.owner } : undefined;
    if (configured && wf !== "plan") {
      const { documentsDir: _documentsDir, findings: _findings, ...codingSettings } = configured;
      configured = Object.keys(codingSettings).length ? codingSettings : null;
    }
    const chatToolchain = dir && wf === "chat" ? (await this.repoSettings(dir))?.toolchain : undefined;
    let ticket: string | undefined;
    try { ticket = validateTicket(wf === "plan" && configured?.ticket ? { ...configured, ticket: { ...configured.ticket, required: false } } : configured, input.ticket); }
    catch (err) { throw new HubError(400, err instanceof Error ? err.message : String(err)); }

    if (input.workflow === "chat") {
      cwd = dir ?? path.join(this.opts.dataDir, "scratch", id);
      fs.mkdirSync(cwd, { recursive: true });
    } else if (input.workflow === "video") {
      if (!URL_RE.test(message)) throw new HubError(400, "paste the video's URL in the message");
      cwd = path.join(this.opts.dataDir, "videos", id); // transcript.md lands here, and the agent works here
      fs.mkdirSync(cwd, { recursive: true });
    } else {
      if (!dir) throw new HubError(400, "this workflow needs a repository");
      if (!(await isGitRepo(dir))) throw new HubError(400, `not a git repository: ${dir}`);
      if (wf === "plan") {
        cwd = (await git(dir, ["rev-parse", "--show-toplevel"])).stdout.trim();
        try {
          const ref = input.base?.trim() ? await baseBranchRef(cwd, input.base) : configured?.base;
          if (input.base?.trim()) await assertBaseBranchExists(cwd, ref!);
          if (ref) planCheckout = { path: (await syncPlanCheckout(cwd, this.opts.dataDir, id, ref)).path, ref };
        } catch (err) {
          throw new HubError(400, err instanceof Error ? err.message : String(err));
        }
      } else {
        try {
          const base = input.base?.trim() ? await baseBranchRef(dir, input.base) : configured?.base;
          if (input.base?.trim()) await assertBaseBranchExists(dir, base!);
          workspace = { id: randomUUID(), ...(await createWorktree(dir, this.opts.dataDir, id, base)) };
          workspace.github = (await this.opts.forge?.repoOf(workspace.repoPath)) ?? null;
        } catch (err) {
          throw new HubError(400, err instanceof Error ? err.message : String(err));
        }
        cwd = workspace.worktreePath;
      }
    }

    const options: TaskOptions = {};
    if (wf === "plan" || wf === "implement" || wf === "review") {
      options.findingProject = fs.realpathSync((await git(workspace?.repoPath ?? cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).stdout.trim());
      if (findingExport) options.findingExport = findingExport;
      if (scopeEstimate) options.scopeEstimate = scopeEstimate;
    }
    if (planCheckout) options.planCheckout = planCheckout;
    if (appliedRules) options.appliedRules = appliedRules;
    if (outputSchema !== undefined) options.outputSchema = outputSchema;
    if (configured) options.repoSettings = configured;
    else if (chatToolchain) options.repoSettings = { toolchain: chatToolchain };
    if (ticket) {
      options.ticket = ticket;
      if (configured?.ticket?.url) options.ticketUrl = configured.ticket.url.replaceAll("{ticket}", encodeURIComponent(ticket));
    }
    if (input.transcriptOnly !== undefined && typeof input.transcriptOnly !== "boolean") throw new HubError(400, "transcriptOnly must be a boolean");
    if (input.transcriptOnly && wf !== "video") throw new HubError(400, "transcriptOnly is only for video tasks");
    if (input.transcriptOnly) options.transcriptOnly = true;
    if (input.noDevices !== undefined && typeof input.noDevices !== "boolean") throw new HubError(400, "noDevices must be a boolean");
    if (input.noDevices) options.noDevices = true;
    if (input.workflow === "review") options.maxRounds = clampRounds(input.maxRounds);
    if (wf === "implement" || wf === "review") {
      const command = input.testCommand ?? configured?.testCommand;
      if (command?.trim()) options.testCommand = command.trim();
    }

    const now = new Date().toISOString();
    let proposal: Extract<TaskEvent, { type: "task_proposal" }> | undefined;
    try {
      if (selectedIssue && await this.opts.forge!.repoOf(selectionRepo!) !== selectedRepo)
        throw new HubError(409, "Repository changed while validating the issue; retry creation");
      // Recheck after the final await; concurrent submissions may have consumed the proposal.
      proposal = input.fromProposal ? this.plannerDispatch.unstartedProposal(input.fromProposal) : undefined;
      validate?.();
      if (proposal && (wf === "implement" || wf === "review")) options.reportsTo = proposal.taskId;
      if (selectedIssue) {
        if (wf === "plan") options.planningIssue = selectedIssue;
        else {
          options.issue = selectedIssue;
          const inherited = input.issue === undefined || input.issue === proposal?.issue?.number;
          options.issueCompletion = input.issueCompletion ?? (inherited && proposal?.issue ? proposal.issueCompletion : "partial");
        }
      }
    } catch (err) {
      if (workspace) await removeWorktree(workspace, true);
      throw err;
    }
    const creationMessages: StreamMessage[] = [];
    this.commitMessages = creationMessages;
    try {
      this.db.transaction(() => {
        this.db
          .insert(tasks)
          .values({ id, title: input.title.trim() || firstLine(message) || "Picture", workflow: input.workflow, status: "idle", activity: null, cwd, workspace, options, createdAt: now, updatedAt: now })
          .run();
        if (options.planningIssue) this.append(id, null, { type: "planning_issue", issue: options.planningIssue });
        for (const r of roles) this.db.insert(sessions).values({ id: randomUUID(), taskId: id, agent: r.agent, role: r.role, model: r.model, effort: r.effort, sdkThreadId: null, status: "idle" }).run();
        if (proposal) {
          const { id: eventId, taskId, sessionId, seq, createdAt, type, ...payload } = proposal;
          this.db.update(events).set({ payload: { ...payload, startedTaskId: id } }).where(eq(events.id, eventId)).run();
          this.touch(taskId);
          this.append(taskId, null, { type: "task_started", task: id, title: input.title.trim() || firstLine(message) });
        }
      });
    } finally { this.commitMessages = undefined; }
    for (const message of creationMessages) this.emit(message);
    if (proposal) this.emit({ type: "event", event: { ...proposal, startedTaskId: id } });
    this.publishTask(id);
    this.sendMessage(id, message, input.images);
    return this.getTask(id);
  }

  private readyForPr(task: Task, checkEnd = true): boolean {
    const history = this.events(task.id);
    const end = history.filter((e) => e.type === "task_end").at(-1);
    if (checkEnd && end?.type === "task_end" && end.outcome !== "ready") return false;
    const request = history.filter((e) => e.type === "user_message").at(-1)?.seq ?? 0;
    const review = history.filter((e) => e.type === "review_result" && e.seq > request).at(-1);
    const test = history.filter((e) => e.type === "test_result" && e.seq > request).at(-1);
    const committed = history.filter((e) => e.type === "diff_snapshot" && e.seq > request).at(-1);
    const completion = task.workflow === "review"
      ? review?.type === "review_result" && review.verdict === "approve" ? review : undefined
      : task.workflow === "implement" ? committed : undefined;
    return !!completion && (!task.options.testCommand ||
      (test?.type === "test_result" && test.seq > completion.seq && test.exitCode === 0));
  }

  /**
   * A message from the user. While a turn runs (or waits for a slot) it is queued and becomes part
   * of the next turn's input; otherwise it starts a turn now. Never two turns on one thread at once.
   */
  sendMessage(taskId: string, text: string, uploads?: ImageUpload[], room: Omit<RoomMessageInput, "text"> & { exchange?: boolean } = {}): void {
    const task = this.getTask(taskId);
    if (task.workflow !== "room" && (room.replyTo !== undefined || room.selection !== undefined || room.exchange !== undefined))
      throw new HubError(400, "Room fields require a room task");
    let quote: RoomQuote | undefined;
    let selection: RoomSelection | undefined;
    if (room.replyTo !== undefined) {
      const reply = room.replyTo;
      if (!reply || typeof reply.eventId !== "string" || (reply.part !== undefined && (typeof reply.part !== "string" || !reply.part.length))) throw new HubError(400, "Invalid quote");
      const event = this.events(taskId).find(e => e.id === reply.eventId);
      if (!event || (event.type !== "user_message" && event.type !== "agent_text")) throw new HubError(400, "Quote must reference a message in this room");
      const author = event.type === "user_message" ? "user" : task.sessions.find(s => s.id === event.sessionId)?.agent;
      if (author !== "user" && author !== "claude" && author !== "codex") throw new HubError(400, "Invalid quote author");
      let text = "";
      for (const scalar of reply.part ?? event.text) {
        if (Buffer.byteLength(text + scalar, "utf8") > ROOM_QUOTE_BYTES) break;
        text += scalar;
      }
      quote = { eventId: event.id, author, text, part: reply.part !== undefined };
    }
    if (room.selection !== undefined) selection = new Documents(this.db).validateSelection(task.options.room!.documentId, room.selection);
    if (activeMainSession(task)?.agent === "gemini" && uploads?.length) throw new HubError(400, "Gemini chat does not support images yet");
    const update = lastPrUpdate(this.events(taskId));
    if (update && (update.owned || !updateFinished(update))) throw new HubError(409, "Retained PR update must be retried or safely abandoned explicitly before ordinary task turns");
    this.assertNoAbandonedLeftovers(taskId);
    const msg = text.trim();
    if (!msg && !uploads?.length) throw new HubError(400, "message is empty");
    if (task.workspace && task.workspace.state !== "active") throw new HubError(409, `this task's worktree was ${task.workspace.state}; start a new task to keep working`);
    if (task.status === "done") this.setStatus(taskId, "idle", null);
    let images: ImageAttachment[];
    try {
      images = saveImages(this.opts.dataDir, taskId, uploads);
    } catch (err) {
      throw new HubError(400, err instanceof AttachmentError ? err.message : String(err));
    }
    // A paused task holds its messages like a busy one: they run when the pause lifts.
    const busy = this.isBusy(taskId) || task.status === "paused";
    this.db.transaction(() => {
      for (const ask of this.events(taskId).filter((e) => e.type === "ask" && !e.answer && !e.superseded)) {
        this.patch(ask.id, { answer: msg || "(see the attached picture)" });
      }
      const ev = this.append(taskId, null, { type: "user_message", text: msg, images: images.length ? images : undefined, queued: busy || undefined, quote, selection, exchange: room.exchange });
      this.db.insert(queuedMessages).values({ id: randomUUID(), taskId, eventId: ev.id, text: msg, images, createdAt: ev.createdAt }).run();
    });
    if (!busy) this.kick(taskId);
  }

  /** Explicit typed dispatch; ordinary messages never select an analysis profile. */
  analyzeVideo(taskId: string, kind: VideoAnalysisKind): void {
    if (kind !== "assignment-spec") throw new HubError(400, "Invalid video analysis kind");
    const task = this.getTask(taskId);
    if (task.workflow !== "video") throw new HubError(400, "Analysis requires a Video task");
    if (!transcriptPath(task)) throw new HubError(409, "A transcript is required before analysis");
    if (this.shuttingDown || this.isBusy(taskId) || this.hasQueued(taskId) || ["running", "waiting_user", "paused"].includes(task.status))
      throw new HubError(409, "Stop or finish the active turn, queued input or pause before analysis");
    if (this.active.size >= this.opts.maxConcurrent) throw new HubError(409, "All execution slots are busy; retry when a slot is free");
    const session = task.sessions.find(s => s.role === "main");
    const adapter = session && this.opts.agents[session.agent];
    if (!session || !adapter || session.agent === "gemini") throw new HubError(409, "Video analysis backend is unavailable");
    const initial = requestedAnalysis();
    const ac = new AbortController();
    this.active.set(taskId, ac);
    this.append(taskId, null, { type: "video_analysis", analysis: initial });
    this.setRunning(taskId, "Analyzing Assignment Spec");
    const done = Promise.resolve().then(async () => {
      const timeout = setTimeout(() => ac.abort(), ANALYSIS_LIMITS.runtimeMs);
      try {
        await runVideoAnalysis(task.cwd!, initial, {
          signal: ac.signal,
          persist: analysis => { this.append(taskId, null, { type: "video_analysis", analysis }); },
          generate: (prompt, systemPrompt) => briefingAbortable((async () => {
            let text = "", complete = false;
            for await (const e of this.measuredRun(adapter, { prompt, systemPrompt, cwd: task.cwd!, model: session.model ?? undefined,
              effort: session.effort ?? undefined, readOnly: true, toolsDisabled: true, signal: ac.signal },
              { taskId, sessionId: null, workflow: "video", provider: session.agent, role: "auxiliary", purpose: "workflow", operationId: initial.operationId,
                endReason: () => this.endReasons.get(ac.signal) ?? null })) {
              ac.signal.throwIfAborted();
              if (e.type === "text_delta") text += e.text;
              if (text.length > ANALYSIS_LIMITS.outputCharacters) throw new Error("Analysis output limit exceeded");
              if (e.type === "tool_start") throw new Error("Analysis attempted a disabled tool");
              if (e.type === "done") { if (!e.ok) throw new Error(e.error ?? "Analysis model call failed"); complete = true; }
            }
            if (!complete) throw new Error("Analysis model call ended without success");
            return text;
          })(), ac.signal),
        });
      } finally {
        clearTimeout(timeout);
        // Close any outstanding provider work after malformed output, a limit or an early exit.
        ac.abort();
        this.setStatus(taskId, "idle", null);
      }
    }).catch(err => {
      const previous = latestVideoAnalysis(this.events(taskId)) ?? initial;
      this.append(taskId, null, { type: "video_analysis", analysis: { ...previous, status: "incomplete", reason: String(err) } });
    }).finally(() => {
      this.active.delete(taskId); this.turnDone.delete(taskId); this.activity.delete(taskId);
      const next = this.waiting.shift(); if (next) this.kick(next);
      if (!this.shuttingDown && !this.endReasons.has(ac.signal) && this.hasQueued(taskId)) this.kick(taskId);
    });
    this.turnDone.set(taskId, done);
  }

  /** Auxiliary calls reserve a normal concurrency slot without running a workflow. */
  switchAgent(taskId: string, input: SwitchAgentInput): Promise<Task> {
    if (!input || Object.keys(input).length !== 2 ||
      !["codex", "claude", "gemini"].includes(input.target) || typeof input.expectedSessionId !== "string" ||
      !input.expectedSessionId || input.expectedSessionId.length > 128)
      throw new HubError(400, "Expected target and expectedSessionId");
    const task = this.getTask(taskId);
    // Handoff summaries stay on the two general-purpose adapters in this chat-only step.
    if (input.target === "gemini" || activeMainSession(task)?.agent === "gemini")
      throw new HubError(400, "Gemini supports direct chat only; agent handoff is unavailable");
    if (!["chat", "plan"].includes(task.workflow)) throw new HubError(409, "Only chat and plan support handoff");
    const running = this.handoffs.get(taskId);
    if (running) {
      if (running.operation.sourceSessionId === input.expectedSessionId && running.operation.target === input.target) return running.done;
      throw new HubError(409, "Conflicting handoff is already preparing");
    }
    const source = activeMainSession(task);
    const history = this.handoffHistory(taskId);
    const completed = history.find((e) => e.type === "handoff_completed" && e.sourceSessionId === input.expectedSessionId && e.target === input.target && e.targetSessionId === source?.id);
    if (completed) return Promise.resolve(task);
    if (!source || source.id !== input.expectedSessionId) throw new HubError(409, "Active session changed; reload before switching");
    if (source.agent === input.target) throw new HubError(409, "Destination must be the other backend");
    if (!this.opts.agents[input.target] || !this.opts.agents[source.agent]) throw new HubError(409, "Source or destination backend is unavailable");
    if (this.shuttingDown || this.isBusy(taskId) || (task.status !== "paused" && this.hasQueued(taskId)) || task.status === "waiting_user" || task.status === "running" ||
      (source.status === "running" && task.status !== "interrupted") || history.some((e) => e.type === "waiting_user" && !e.answer) ||
      this.findingExports.has(taskId) || this.diffExplanations.busy(taskId) || this.changeBriefings.busy(taskId) || this.pullRequests.busy(taskId))
      throw new HubError(409, "Stop or finish the active turn, queued input, permission or auxiliary operation first");
    if (this.active.size >= this.opts.maxConcurrent) throw new HubError(409, "All execution slots are busy; retry when a slot is free");
    let captured: ReturnType<typeof captureHandoff>;
    try { captured = captureHandoff(task, history, this.opts.dataDir, this.handoffChildren(taskId)); }
    catch (err) { throw new HubError(409, err instanceof Error ? err.message : String(err)); }
    const operation: HandoffOperation = { operationId: randomUUID(), sourceSessionId: source.id, sourceBackend: source.agent,
      target: input.target, sourceFrom: captured.material.sourceFrom, sourceTo: captured.material.sourceTo, sourceIdentity: captured.material.sourceIdentity };
    const ac = new AbortController();
    this.active.set(taskId, ac);
    this.append(taskId, source.id, { type: "handoff_started", ...operation });
    let resumeQueued = true;
    const done = Promise.resolve().then(async () => {
      const timeout = setTimeout(() => ac.abort(), 120000);
      try {
        // The source agent writes the summary unless its quota is exhausted: switching away from an agent
        // that has run out is the main reason to switch, so the other agent writes it then.
        const generate = (agent: AgentKind) => async () => {
          let text = "", complete = false;
          const own = agent === source.agent;
          for await (const e of this.measuredRun(this.opts.agents[agent]!, { prompt: captured.input, systemPrompt: HANDOFF_SYSTEM,
            cwd: task.cwd!, model: own ? source.model ?? undefined : undefined, effort: own ? source.effort ?? undefined : undefined,
            readOnly: true, toolsDisabled: true, signal: ac.signal }, { taskId, sessionId: null, workflow: task.workflow, provider: agent, role: "auxiliary", purpose: "handoff_summary", operationId: operation.operationId,
            endReason: () => this.endReasons.get(ac.signal) ?? null })) {
            if (ac.signal.aborted) throw new Error("Handoff interrupted or timed out");
            if (e.type === "text_delta") text += e.text;
            if (text.length > 12000) throw new Error("Handoff summary exceeds 12000 characters");
            if (e.type === "tool_start") throw new Error("Summary attempted a disabled tool");
            if (e.type === "done") { if (!e.ok) throw new Error(e.error ?? "Summary failed"); complete = true; }
          }
          if (!complete) throw new Error("Summary ended without a successful result");
          return validateHandoff(text, history);
        };
        const summary = (await withAgentFallback(source.agent, configuredAgents(this.opts.agents), { quota: (force) => this.quota(force) }, ac.signal,
          ({ agent }) => briefingAbortable(generate(agent)(), ac.signal))).value;
        const latest = this.getTask(taskId);
        if (ac.signal.aborted || this.shuttingDown || activeMainSession(latest)?.id !== source.id ||
          handoffIdentity(latest, this.handoffHistory(taskId), this.handoffChildren(taskId)) !== operation.sourceIdentity || (task.status !== "paused" && this.hasQueued(taskId)))
          throw new Error("Handoff source changed or was interrupted; original session retained. Retry explicitly.");
        const targetSessionId = randomUUID();
        let linked!: TaskEvent;
        const messages: StreamMessage[] = [];
        this.commitMessages = messages;
        try {
          this.db.transaction(() => {
            this.db.insert(sessions).values({ id: targetSessionId, taskId, agent: input.target, role: "main",
              model: defaultModel(task.workflow) ?? null, effort: defaultEffort(task.workflow), sdkThreadId: null, status: "idle" }).run();
            linked = this.append(taskId, targetSessionId, { type: "handoff_completed", ...operation, targetSessionId, material: { ...captured.material, summary } });
            const { quotaPause: _paused, ...options } = latest.options;
            this.db.update(tasks).set({ options: { ...options, activeMainSessionId: targetSessionId, mainHandoffId: linked.id } }).where(eq(tasks.id, taskId)).run();
            // The new agent has its own quota: leave the pause, and the finally block runs what was queued.
            if (latest.status === "paused") {
              this.append(taskId, null, { type: "status_change", from: "paused", to: "idle", reason: `switched to ${AGENT_LABEL[input.target]}` });
              this.setStatus(taskId, "idle", null);
            }
          });
        } finally { this.commitMessages = undefined; }
        for (const message of messages) this.emit(message);
        this.publishTask(taskId);
        return this.getTask(taskId);
      } catch (err) {
        const interrupted = ac.signal.aborted || this.shuttingDown;
        const error = interrupted ? "Handoff interrupted or timed out; original session retained" : err instanceof Error ? err.message : String(err);
        resumeQueued = !interrupted;
        ac.abort();
        if (this.db.select().from(tasks).where(eq(tasks.id, taskId)).get())
          this.append(taskId, source.id, { type: "handoff_failed", ...operation, error, interrupted });
        throw new HubError(409, error);
      } finally { clearTimeout(timeout); }
    }).finally(() => {
      this.handoffs.delete(taskId); this.active.delete(taskId);
      const next = this.waiting.shift(); if (next) this.kick(next);
      if (!this.shuttingDown && resumeQueued && this.hasQueued(taskId)) this.kick(taskId);
    });
    this.handoffs.set(taskId, { operation, ac, done });
    return done;
  }

  private handoffChildren(taskId: string): Task[] {
    return this.listTasks().filter((t) => t.options.reportsTo === taskId);
  }

  private handoffHistory(taskId: string, limit = HANDOFF_EVENT_LIMIT): TaskEvent[] {
    const rows = this.db.select().from(events).where(and(eq(events.taskId, taskId), notInArray(events.type, ["invocation_started", "invocation_finished"]))).orderBy(asc(events.seq)).limit(limit + 1).all();
    if (rows.length > limit) throw new HubError(409, `Handoff exceeds ${limit}-event scan budget`);
    return rows.map(toEvent);
  }

  stop(taskId: string): void {
    this.getTask(taskId);
    this.findingExports.get(taskId)?.ac.abort();
    this.changeBriefings.abort(taskId);
    const i = this.waiting.indexOf(taskId);
    if (i >= 0) {
      this.waiting.splice(i, 1);
      this.append(taskId, null, { type: "status_change", from: "running", to: "idle", reason: "stopped by you before it started" });
      this.setStatus(taskId, "idle", null);
      const task = this.getTask(taskId);
      if (task.options.reportsTo) {
        const end = this.append(taskId, null, { type: "task_end", outcome: "interrupted" });
        this.plannerDispatch.deliverReport(task, end.seq, "interrupted");
      }
      return;
    }
    this.abortActive(this.active.get(taskId), "user_stop");
  }

  /**
   * Remove a task and its history. Its worktree and branch go too (the user's repo is untouched), and
   * so does any directory Agent Hub made for it, but never a directory the user pointed a chat at.
   * The ssh audit log keeps its rows: it is the record of what ran, whatever happened to the task.
   */
  async deleteTask(taskId: string): Promise<void> {
    const task = this.getTask(taskId);
    if (this.isBusy(taskId)) throw new HubError(409, "the task is still running; stop it first");
    if (task.workspace?.state === "active") await removeWorktree(task.workspace, true);
    if (task.options.planCheckout) await removePlanCheckout(task.cwd!, task.options.planCheckout.path);
    const ours = ["scratch", "videos"].map((d) => path.join(this.opts.dataDir, d) + path.sep);
    if (task.workflow !== "plan" && task.cwd && ours.some((root) => task.cwd!.startsWith(root))) fs.rmSync(task.cwd, { recursive: true, force: true });
    fs.rmSync(attachmentsDir(this.opts.dataDir, taskId), { recursive: true, force: true });
    this.diffExplanations.abort(taskId);
    this.db.delete(events).where(and(eq(events.taskId, taskId), notInArray(events.type, ["finding_recorded", "finding_export", "finding_batch"]))).run();
    this.db.delete(queuedMessages).where(eq(queuedMessages.taskId, taskId)).run();
    this.db.delete(sessions).where(eq(sessions.taskId, taskId)).run();
    this.db.delete(tasks).where(eq(tasks.id, taskId)).run();
    this.emit({ type: "task_deleted", taskId });
  }

  /** Merge the task's branch into the branch it came from, in the user's repo. */
  async merge(taskId: string): Promise<void> {
    const task = this.getTask(taskId);
    const ws = this.idleWorkspace(task);
    // Once a pull request exists, GitHub decides; a local merge would bypass the review there.
    if (ws.pr?.state === "open") throw new HubError(409, `this task has an open pull request (#${ws.pr.number}); merge it on GitHub`);
    try {
      await mergeWorktree(ws, task.title);
    } catch (err) {
      throw new HubError(409, err instanceof Error ? err.message : String(err));
    }
    this.closeWorkspace(task, "merged", `merged into ${ws.baseRef}`);
  }

  /** Throw the task's worktree and branch away. */
  async discard(taskId: string): Promise<void> {
    const task = this.getTask(taskId);
    const ws = this.idleWorkspace(task);
    if (ws.pr?.state === "open" && ws.github && this.opts.forge) await this.opts.forge.close(ws.github, ws.pr.number);
    await removeWorktree(ws, true);
    this.closeWorkspace(task, "discarded", ws.pr?.state === "open" ? `discarded the worktree and closed PR #${ws.pr.number}` : "discarded the worktree");
  }

  /** Explicit user action; reserves a normal scheduler slot and uses the same Stop controller. */
  updatePr(taskId: string, revision: PrRevision, planId?: string): PrUpdate {
    const task = this.getTask(taskId);
    if (task.options.reportsTo && task.options.reportsTo !== planId) throw new HubError(409, "Approve this update in the originating planning conversation");
    this.assertNoAbandonedLeftovers(taskId);
    if (!revision || typeof revision.head !== "string" || typeof revision.target !== "string" ||
      !/^[a-f0-9]{40}$/.test(revision.headSha) || !/^[a-f0-9]{40}$/.test(revision.targetSha) || typeof revision.crossRepository !== "boolean")
      throw new HubError(400, "Expected an observed PR source and target revision");
    const ws = this.idleWorkspace(task);
    const retained = lastPrUpdate(this.events(taskId));
    if (!["implement", "review"].includes(task.workflow) || !["idle", "failed", "interrupted"].includes(task.status) ||
      this.shuttingDown || this.hasQueued(taskId) || this.pullRequests.busy(taskId) || this.changeBriefings.busy(taskId) || this.diffExplanations.busy(taskId))
      throw new HubError(409, "Finish the active work before updating the PR");
    if (!this.opts.forge?.inspectPullRequest || !ws.github || ws.pr?.state !== "open") throw new HubError(409, "An open PR with revision inspection is required");
    if (retained?.owned && (retained.pr.repo !== ws.github || retained.pr.number !== ws.pr.number ||
      (!sameRevision(retained.revision, revision) && !(retained.publication && retained.resultSha === revision.headSha && sameRevision({ ...retained.revision, headSha: retained.resultSha }, revision)))))
      throw new HubError(409, "Retained update belongs to different PR revisions; user intervention is required");
    if (this.active.size >= this.opts.maxConcurrent) throw new HubError(409, "All execution slots are busy; retry when a slot is free");
    const intent: PrUpdate = { id: randomUUID(), revision, pr: { repo: ws.github, number: ws.pr.number }, stage: "intent", owned: retained?.owned,
      previousBase: retained?.owned ? retained.previousBase : { baseSha: ws.baseSha, prBase: ws.prBase },
      mergeUntracked: retained?.owned ? retained.mergeUntracked : undefined,
      ...(retained?.owned ? { preSha: retained.preSha, resultSha: retained.resultSha, conflicted: retained.conflicted, publication: retained.publication, tests: retained.tests, reviewedSha: retained.reviewedSha, validatedSha: retained.validatedSha, validationOperationId: retained.validationOperationId ?? retained.id } : {}) };
    return this.startPrOperation(task, intent, async (ac) => {
      // Implement-only tasks also need a read-only reviewer, selected by the existing defaults.
      if (!task.sessions.some(s => s.role === "reviewer")) {
        const configured = task.options.repoSettings?.agents?.reviewer;
        const agent = configured?.agent ?? defaultAgent("review", "reviewer");
        const session = { id: randomUUID(), taskId, role: "reviewer" as const, agent,
          model: configured?.model ?? (agent === defaultAgent("review", "reviewer") ? defaultModel("review", "reviewer") ?? null : null),
          effort: configured?.effort ?? defaultEffort("review", "reviewer"), status: "idle" as const };
        this.db.insert(sessions).values(session).run();
        this.publishTask(taskId);
      }
      return updatePr({ ...this.workflowDeps, updateWorkspace: (id, fields) => this.updateWorkspace(id, fields) }, this.getTask(taskId), intent, ac);
    });
  }

  /** Explicitly drop only a retained, unpublished integration; the PR stays on the remote. */
  abandonPrUpdate(taskId: string, planId?: string): PrUpdate {
    const task = this.getTask(taskId);
    if (task.options.reportsTo && task.options.reportsTo !== planId) throw new HubError(409, "Approve abandonment in the originating planning conversation");
    const ws = this.idleWorkspace(task);
    const retained = lastPrUpdate(this.events(taskId));
    if (!retained?.owned || !["failed", "interrupted"].includes(retained.stage) || retained.publication ||
      !retained.preSha || retained.preSha !== retained.revision.headSha || !retained.previousBase)
      throw new HubError(409, "Only an unpublished retained update with a saved baseline can be abandoned; reconcile uncertain publication through an explicit update retry");
    if (!["idle", "failed", "interrupted"].includes(task.status) || this.shuttingDown || this.hasQueued(taskId) ||
      this.pullRequests.busy(taskId) || this.changeBriefings.busy(taskId) || this.diffExplanations.busy(taskId))
      throw new HubError(409, "Finish the active work before abandoning the update");
    if (!this.opts.forge?.inspectPullRequest || !ws.github || !ws.pr || ws.pr.number !== retained.pr.number || ws.github !== retained.pr.repo)
      throw new HubError(409, "The original PR identity is required");
    if (this.active.size >= this.opts.maxConcurrent) throw new HubError(409, "All execution slots are busy; retry when a slot is free");
    const intent: PrUpdate = { ...retained, id: randomUUID(), action: "abandon", stage: "abandoning", stoppedAt: undefined, error: undefined };
    return this.startPrOperation(task, intent, (ac) => abandonPrUpdate({ ...this.workflowDeps,
      updateWorkspace: (id, fields) => this.updateWorkspace(id, fields) }, task, intent, ac));
  }

  /** Reserve synchronously; guard the entire body and keep completion in the scheduler's tracked promise. */
  private startPrOperation(task: Task, intent: PrUpdate, run: (ac: AbortController) => Promise<PrUpdate>): PrUpdate {
    const taskId = task.id;
    const ac = new AbortController();
    this.active.set(taskId, ac);
    try { this.append(taskId, null, { type: "pr_update", update: intent }); }
    catch (error) { this.active.delete(taskId); throw error; }
    const done = Promise.resolve().then(async () => {
      let result: PrUpdate;
      try {
        if (ac.signal.aborted) throw new Error("PR operation interrupted before it started");
        this.setRunning(taskId, intent.action === "abandon" ? "Abandoning retained PR update" : "Updating existing PR");
        result = await run(ac);
      } catch (error) {
        const current = lastPrUpdate(this.events(taskId)) ?? intent;
        result = { ...current, stoppedAt: current.stage, stage: ac.signal.aborted ? "interrupted" : "failed",
          error: error instanceof Error ? error.message : String(error) };
        this.append(taskId, null, { type: "pr_update", update: result });
      }
      this.setStatus(taskId, "idle", result.error ?? (result.stage === "abandoned" ? "Retained PR update abandoned; existing PR unchanged"
        : result.stage === "noop" ? "PR already includes the target revision" : "Existing PR updated"));
      const event = this.events(taskId).filter(e => e.type === "pr_update").at(-1)!;
      this.plannerDispatch.deliverReport(this.getTask(taskId), event.seq, updateReportOutcome(result));
    }).finally(() => {
      this.active.delete(taskId);
      this.turnDone.delete(taskId);
      this.activity.delete(taskId);
      const next = this.waiting.shift();
      if (next) this.kick(next);
    });
    this.turnDone.set(taskId, done.then(() => {}, () => {}));
    return intent;
  }

  /**
   * Push the task's branch and open a pull request: from here on GitHub is where it is reviewed and
   * merged. A user action (a button), never something a workflow does on its own.
   */
  openPr(taskId: string, confirmation?: PrConfirmation): Promise<{ number: number; url: string }> {
    return this.pullRequests.openPr(taskId, confirmation);
  }

  preparePrDraft(taskId: string): Promise<Extract<TaskEvent, { type: "pr_draft" }>> {
    return this.pullRequests.preparePrDraft(taskId);
  }

  editPrDraft(taskId: string, confirmation: PrConfirmation): Promise<Extract<TaskEvent, { type: "pr_draft" }>> {
    return this.pullRequests.editPrDraft(taskId, confirmation);
  }

  /**
   * The open pull requests, as GitHub sees them now. Merged: the task is done and its worktree goes.
   * Closed unmerged: the user is told and the worktree stays. Called on a timer by main.ts.
   */
  pollPullRequests(): Promise<void> {
    return this.pullRequests.pollPullRequests();
  }

  /** Kept on the Hub because tests reach it by name; the text lives with the PR flow. */
  private prBody(task: Task): string {
    return this.pullRequests.prBody(task);
  }

  private updateWorkspace(taskId: string, fields: Partial<Workspace>): void {
    const ws = this.getTask(taskId).workspace;
    if (!ws) return;
    this.db.update(tasks).set({ workspace: { ...ws, ...fields } }).where(eq(tasks.id, taskId)).run();
    this.publishTask(taskId);
  }

  /**
   * Boot: a turn that was running when the server went down is not retried automatically, because it
   * may already have done part of something with side effects (design.md §8). Mark it and let the
   * user decide.
   */
  recoverInterrupted(): number {
    recoverInvocations({ db: this.db, quota: this.quotaService, append: (id, sessionId, payload) => this.append(id, sessionId, payload) });
    this.recovering = true;
    const stuck = this.db.select().from(tasks).where(inArray(tasks.status, ["running", "waiting_user"])).all();
    for (const t of stuck) {
      // A question nobody can answer any more: the turn that asked it is gone.
      for (const e of this.events(t.id)) if (e.type === "waiting_user" && !e.answer) this.patch(e.id, { answer: "Expired (server restarted)" });
      this.append(t.id, null, { type: "status_change", from: t.status as TaskStatus, to: "interrupted", reason: "the server stopped while this turn was running" });
      this.setStatus(t.id, "interrupted", "Interrupted by server restart");
    }
    for (const task of this.listTasks()) {
      this.issueComments.recover(task.id);
      const analysis = latestVideoAnalysis(this.events(task.id));
      if (analysis && ["requested", "running"].includes(analysis.status)) this.append(task.id, null, { type: "video_analysis", analysis: {
        ...analysis, status: "incomplete", reason: "Analysis interrupted by server restart; partial evidence retained. Select the action again to retry explicitly."
      } });
      const update = lastPrUpdate(this.events(task.id));
      if (update && !updateFinished(update)) this.append(task.id, null, { type: "pr_update", update: { ...update, stoppedAt: update.stage, stage: "interrupted", error: `Server restarted during ${update.stage}; progress retained. Retry explicitly; publication may need reconciliation.` } });
      const handoffHistory = this.events(task.id);
      for (const started of handoffHistory.filter((e) => e.type === "handoff_started")) {
        if (started.type === "handoff_started" && !handoffHistory.some((e) => (e.type === "handoff_completed" || e.type === "handoff_failed") && e.operationId === started.operationId))
          this.append(task.id, started.sourceSessionId, { operationId: started.operationId, sourceSessionId: started.sourceSessionId, sourceBackend: started.sourceBackend, target: started.target, sourceFrom: started.sourceFrom, sourceTo: started.sourceTo, sourceIdentity: started.sourceIdentity, type: "handoff_failed", error: "Handoff interrupted by server restart; retry explicitly", interrupted: true });
      }
      const lastBriefing = this.events(task.id).filter((e) => e.type.startsWith("briefing_")).at(-1);
      if (lastBriefing?.type === "briefing_started") this.append(task.id, null, { type: "briefing_failed", generationId: lastBriefing.generationId, error: "Briefing generation interrupted by server restart", interrupted: true });
      const last = this.events(task.id).filter((e) => e.type === "diff_explanations" || e.type === "diff_explanations_started").at(-1);
      if (last?.type === "diff_explanations_started") {
        this.db.update(sessions).set({ status: "failed" }).where(and(eq(sessions.taskId, task.id), eq(sessions.role, "explainer"), eq(sessions.status, "running"))).run();
        this.append(task.id, null, { type: "diff_explanations", sha: last.sha ?? "", hunks: [], items: [], error: "Explanation generation interrupted by server restart" });
      }
    }
    for (const task of this.listTasks()) {
      if (!task.options.reportsTo) continue;
      const history = this.events(task.id);
      // A permission pause and the later turn end are distinct end states; recover both if needed.
      for (const event of history) {
        if (event.type === "pr_conflict" && event.state === "conflicting") this.plannerDispatch.deliverReport(task, event.seq, "conflict");
        else if (event.type === "pr_update" && updateFinished(event.update)) this.plannerDispatch.deliverReport(task, event.seq, updateReportOutcome(event.update));
        else if (event.type === "task_end") this.plannerDispatch.deliverReport(task, event.seq, event.outcome);
        else if (event.type === "waiting_user") this.plannerDispatch.deliverReport(task, event.seq, "needs_user");
        else if (event.type === "status_change" && event.to === "interrupted") this.plannerDispatch.deliverReport(task, event.seq, "interrupted");
      }
    }
    this.recovering = false;
    this.startQuotaTimer();
    for (const plan of this.listTasks().filter((t) => t.workflow === "plan")) {
      for (const e of this.events(plan.id)) if (e.type === "task_report" && !e.report.handled) this.plannerDispatch.queueReport(plan, e);
      if (this.events(plan.id).some((e) => e.type === "task_report" && !e.report.handled) && this.hasQueued(plan.id)) {
        this.startupReportTurns.add(plan.id);
        this.kick(plan.id);
      }
    }
    return stuck.length;
  }

  /** The user's answer to a `waiting_user` request (Allow / Deny on a tool call). */
  answer(taskId: string, eventId: string, answer: string): void {
    const pending = this.approvals.get(eventId);
    if (!pending || pending.taskId !== taskId) throw new HubError(409, "that request is no longer waiting for an answer");
    this.approvals.delete(eventId);
    this.patch(eventId, { answer });
    if (![...this.approvals.values()].some((a) => a.taskId === taskId)) this.setStatus(taskId, "running", this.activity.get(taskId) ?? "Running");
    pending.resolve(answer === "Allow" ? { allow: true } : { allow: false, message: "The user denied this tool call. Ask them what to do instead, or take another approach." });
  }

  recover(taskId: string, action: RecoverAction): void {
    const task = this.getTask(taskId);
    if (this.handoffs.has(taskId)) throw new HubError(409, "Stop the handoff before continuing or restarting");
    if (task.status !== "interrupted") throw new HubError(409, "task is not interrupted");
    if (action === "end") {
      this.append(taskId, null, { type: "status_change", from: "interrupted", to: "done", reason: "ended by you" });
      this.setStatus(taskId, "done", null);
      return;
    }
    this.assertNoAbandonedLeftovers(taskId);
    if (lastPrUpdate(this.events(taskId))?.owned) throw new HubError(409, "Retained PR update requires explicit retry or abandonment approval; ordinary recovery cannot continue it");
    if (action === "restart") {
      // Use a post-handoff request so restarting never replays a retired provider's original work.
      const handoff = task.options.mainHandoffId ? this.events(taskId).find((e) => e.id === task.options.mainHandoffId) : undefined;
      const first = handoff ? this.events(taskId).filter((e) => e.type === "user_message" && e.seq > handoff.seq).at(-1) : this.events(taskId).find((e) => e.type === "user_message");
      if ((!first || first.type !== "user_message") && !handoff) throw new HubError(409, "no original request to restart from");
      for (const s of task.sessions.filter((s) => !["chat", "plan"].includes(task.workflow) || s.id === activeMainSession(task)?.id)) this.db.update(sessions).set({ sdkThreadId: null }).where(eq(sessions.id, s.id)).run();
      this.append(taskId, null, { type: "status_change", from: "interrupted", to: "idle", reason: "restarting in a new conversation" });
      this.setStatus(taskId, "idle", null);
      this.sendMessage(taskId, first?.type === "user_message" ? first.text : continuePrompt(this.events(taskId)));
      return;
    }
    this.append(taskId, null, { type: "status_change", from: "interrupted", to: "idle", reason: "continuing the same conversation" });
    this.setStatus(taskId, "idle", null);
    this.sendMessage(taskId, continuePrompt(this.events(taskId)));
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  /** The agent ran out of quota mid-turn: persist the pause boundary instead of failing it. */
  private pause(taskId: string, limit: NonNullable<Outcome["limit"]>): void {
    const task = this.getTask(taskId);
    const since = new Date(this.now()).toISOString();
    this.db.update(tasks).set({ options: { ...task.options, quotaPause: { agent: limit.agent, resetsAt: limit.resetsAt, since } } }).where(eq(tasks.id, taskId)).run();
    this.append(taskId, null, { type: "status_change", from: "running", to: "paused",
      reason: `${AGENT_LABEL[limit.agent]} usage limit reached; ${limit.resetsAt ? `resets around ${limit.resetsAt}` : "reset time unknown"}` });
    this.setStatus(taskId, "paused", `Waiting for ${AGENT_LABEL[limit.agent]} quota`);
  }

  /** Leave `paused` and carry on in the same conversation, as `recover(…, "continue")` does. */
  private resume(taskId: string, reason: string): void {
    const task = this.getTask(taskId);
    if (task.status !== "paused") throw new HubError(409, "task is not waiting for quota");
    if (this.handoffs.has(taskId)) throw new HubError(409, "Stop the handoff before continuing");
    const { quotaPause: _paused, ...options } = task.options;
    this.db.transaction(() => {
      this.db.update(tasks).set({ options }).where(eq(tasks.id, taskId)).run();
      this.append(taskId, null, { type: "status_change", from: "paused", to: "idle", reason });
      this.setStatus(taskId, "idle", null);
    });
    if (this.hasQueued(taskId)) this.kick(taskId);
    else this.sendMessage(taskId, continuePrompt(this.events(taskId)));
  }

  /** The user knows the quota is back. */
  continueNow(taskId: string): void {
    this.resume(taskId, "continuing now, as you asked");
  }

  /** Give up waiting: nothing runs until the next message. */
  stopWaiting(taskId: string): void {
    const task = this.getTask(taskId);
    if (task.status !== "paused") throw new HubError(409, "task is not waiting for quota");
    if (this.handoffs.has(taskId)) throw new HubError(409, "Stop the handoff first");
    const { quotaPause: _paused, ...options } = task.options;
    this.db.transaction(() => {
      this.db.update(tasks).set({ options }).where(eq(tasks.id, taskId)).run();
      this.append(taskId, null, { type: "status_change", from: "paused", to: "idle", reason: "stopped waiting for quota" });
      this.setStatus(taskId, "idle", null);
    });
  }

  private startQuotaTimer(): void {
    if (this.quotaTimer || this.shuttingDown) return;
    this.quotaTimer = setInterval(() => void this.resumeDue().catch((err) => console.warn("quota resume failed:", err)), this.opts.quotaResumeMs ?? 60_000);
    this.quotaTimer.unref();
    void this.resumeDue().catch((err) => console.warn("quota resume failed:", err));
  }

  /** Retry reset-due pauses, or resume early only with positive post-pause quota evidence. */
  async resumeDue(): Promise<void> {
    if (this.shuttingDown) return;
    const paused = this.listTasks().filter((t) => t.status === "paused" && t.options.quotaPause);
    if (!paused.length) return;
    // Reset times permit one retry independently of quota evidence. Do not let a slow
    // account read delay that opportunity or make a past reset look like usable quota.
    const pending = [];
    for (const task of paused) {
      const pause = task.options.quotaPause!;
      if (pause.resetsAt !== null && Date.parse(pause.resetsAt) <= this.now()) {
        try { this.resume(task.id, "Quota reset estimate reached; retrying"); } catch { /* a handoff may own this task */ }
      } else if (quotaRecovered(this.quotaService.peek(pause.agent), pause.since, this.now())) {
        try { this.resume(task.id, "Quota is back; continuing"); } catch { /* a handoff may own this task */ }
      } else {
        const history = this.events(task.id);
        pending.push({ task, statusId: history.findLast(e => e.type === "status_change")?.id,
          handoffId: history.findLast(e => e.type === "handoff_started")?.id });
      }
    }
    if (!pending.length || this.resumeRunning) return;
    this.resumeRunning = true;
    try {
      // Ordinary reads share browser refreshes, in-flight requests, freshness and backoff.
      const quota = await this.quota().catch(() => undefined);
      if (this.shuttingDown) return;
      for (const { task, statusId, handoffId } of pending) {
        try {
          const latest = this.getTask(task.id);
          const pause = task.options.quotaPause!;
          const current = latest.options.quotaPause;
          const history = this.events(task.id);
          if (latest.status !== "paused" || !current || this.handoffs.has(task.id) ||
            current.since !== pause.since || current.agent !== pause.agent || current.resetsAt !== pause.resetsAt ||
            history.findLast(e => e.type === "status_change")?.id !== statusId ||
            history.findLast(e => e.type === "handoff_started")?.id !== handoffId) continue;
          if (quotaRecovered(quota?.[pause.agent], pause.since, this.now())) this.resume(task.id, "Quota is back; continuing");
        } catch { /* deleted or changed meanwhile: leave it to the next tick */ }
      }
    } finally {
      this.resumeRunning = false;
    }
  }

  /**
   * Stop every turn because the server is going down, NOT because the user asked. Aborting is what
   * makes the SDK end its agent subprocess (otherwise it outlives us and keeps working with nobody
   * listening). The tasks are left `running` on purpose: the next boot marks them interrupted, which
   * is the truth, rather than "stopped by you", which is not.
   */
  async shutdown(timeoutMs = 5_000): Promise<void> {
    this.shuttingDown = true;
    clearInterval(this.quotaTimer);
    this.waiting.length = 0;
    for (const ac of this.active.values()) this.abortActive(ac, "shutdown");
    this.diffExplanations.abortAll();
    for (const job of this.findingExports.values()) job.ac.abort();
    const all = Promise.all([this.quotaService.shutdown(), ...this.turnDone.values(), ...[...this.handoffs.values()].map((job) => job.done.catch(() => {})), ...[...this.findingExports.values()].map((job) => job.done), ...this.diffExplanations.pending()]);
    await Promise.race([all, new Promise((r) => setTimeout(r, timeoutMs))]);
  }

  /** Wait for the task's current turn (if any) to finish. */
  async settled(taskId: string): Promise<void> {
    if (this.handoffs.has(taskId)) await this.handoffs.get(taskId)!.done.catch(() => {});
    while (this.turnDone.has(taskId)) await this.turnDone.get(taskId);
    await this.diffExplanations.settled(taskId);
  }

  isBusy(taskId: string): boolean {
    return this.active.has(taskId) || this.waiting.includes(taskId);
  }

  // ---------- scheduling ----------

  private assertNoAbandonedLeftovers(taskId: string): void {
    const update = lastPrUpdate(this.events(taskId));
    const reason = abandonedUntrackedBlock(this.getTask(taskId).workspace, update);
    if (reason) throw new HubError(409, reason);
  }

  private kick(taskId: string): void {
    if (this.shuttingDown || this.isBusy(taskId) || lastPrUpdate(this.events(taskId))?.owned || this.db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, taskId)).get()?.status === "paused") return;
    this.assertNoAbandonedLeftovers(taskId);
    if (this.active.size >= this.opts.maxConcurrent) {
      this.waiting.push(taskId);
      this.setStatus(taskId, "running", `Waiting for a free slot (${this.active.size} running)`);
      return;
    }
    const ac = new AbortController();
    this.active.set(taskId, ac);
    const done = this.runTurn(taskId, ac)
      .catch((err) => console.error(`turn for ${taskId} crashed:`, err))
      .finally(() => {
        this.active.delete(taskId);
        this.turnDone.delete(taskId);
        this.activity.delete(taskId);
        // The freed slot goes to a task that was already waiting for one first; then, if more
        // messages arrived during this turn, they become this task's next turn (queued behind
        // others if there is no slot). A stopped turn does not continue on its own.
        const next = this.waiting.shift();
        if (next) this.kick(next);
        if (!ac.signal.aborted && this.hasQueued(taskId)) this.kick(taskId);
      });
    this.turnDone.set(taskId, done);
  }

  private hasQueued(taskId: string): boolean {
    return !!this.db.select({ id: queuedMessages.id }).from(queuedMessages).where(eq(queuedMessages.taskId, taskId)).limit(1).get();
  }

  /** Rooms consume one message per round; other workflows combine queued inputs and pictures. */
  private takeQueued(taskId: string): { text: string; images: { path: string; mime: string }[]; reports: string[]; messageId?: string } {
    let rows = this.db.select({ message: queuedMessages }).from(queuedMessages).innerJoin(events, eq(events.id, queuedMessages.eventId))
      .where(eq(queuedMessages.taskId, taskId)).orderBy(asc(events.seq)).all().map(row => row.message);
    if (this.getTask(taskId).workflow === "room") rows = rows.slice(0, 1);
    const reports: string[] = [];
    // Consuming a report and recording delivery are atomic: failed or aborted planner turns must
    // never replay it on restart and spend the shared quota again.
    this.db.transaction(() => {
      for (const r of rows) {
        const event = this.db.select().from(events).where(eq(events.id, r.eventId)).get();
        const delivered = event ? toEvent(event) : undefined;
        if (delivered?.type === "task_report") reports.push(delivered.id);
        this.db.delete(queuedMessages).where(eq(queuedMessages.id, r.id)).run();
        this.patch(r.eventId, delivered?.type === "task_report"
          ? { report: { ...delivered.report, handled: true } }
          : { queued: undefined });
      }
    });
    const images = rows.flatMap((r) =>
      ((r.images as ImageAttachment[] | null) ?? []).flatMap((a) => {
        const p = attachmentPath(this.opts.dataDir, taskId, a.file);
        return p ? [{ path: p, mime: a.mime }] : [];
      }),
    );
    // A picture sent alone still needs a sentence for the model to answer to.
    const text = rows.map((r) => r.text).filter(Boolean).join("\n\n") || (images.length ? "(see the attached picture)" : "");
    return { text, images, reports, messageId: rows[0]?.eventId };
  }

  /** Where a stored picture is, for serving it back to the browser. */
  attachment(taskId: string, file: string): string | null {
    this.getTask(taskId);
    return attachmentPath(this.opts.dataDir, taskId, file);
  }

  /** One turn: the queued input, through the task's workflow. Only this method writes the end status. */
  private async runTurn(taskId: string, ac: AbortController): Promise<void> {
    if (lastPrUpdate(this.events(taskId))?.owned) return;
    const allowFindingExport = !this.startupReportTurns.delete(taskId);
    let recent: AgentRunInput["recent"];
    if (activeMainSession(this.getTask(taskId))?.agent === "gemini") {
      // Exclude queued inputs by identity: the prior reply may arrive after they were queued.
      const before = this.events(taskId);
      const queuedIds = new Set(this.db.select({ eventId: queuedMessages.eventId }).from(queuedMessages).where(eq(queuedMessages.taskId, taskId)).all().map(r => r.eventId));
      recent = geminiRecent(before.filter(e => !queuedIds.has(e.id)));
    }
    const { text: prompt, images, reports, messageId } = this.takeQueued(taskId);
    if (!prompt) return;
    const task = this.getTask(taskId);
    const turnStartSeq = this.events(taskId).at(-1)?.seq ?? 0;
    let outcome: Outcome;
    try {
      this.assertNoAbandonedLeftovers(taskId);
      outcome =
        task.workflow === "room"
          ? await roomWorkflow(this.workflowDeps, new Documents(this.db), task, this.events(taskId).find(e => e.id === messageId) as Extract<TaskEvent, { type: "user_message" }>, ac)
          : task.workflow === "review"
          ? await reviewWorkflow(this.workflowDeps, task, prompt, ac, images)
          : task.workflow === "implement"
            ? await implementWorkflow(this.workflowDeps, task, prompt, ac, images)
            : task.workflow === "video"
              ? await videoWorkflow(this.workflowDeps, task, prompt, ac)
              : task.workflow === "plan"
                ? await planWorkflow(this.workflowDeps, task, prompt, ac, images)
                : await this.streamAgent(task, this.session(task, "main"), prompt, ac, { systemPrompt: SYSTEM_APPEND, images, recent, ...(task.options.outputSchema !== undefined ? { outputSchema: task.options.outputSchema } : {}) });
    } catch (err) {
      // Infrastructure failure (git, the filesystem), not the agent's: record it like a failed turn.
      const error = err instanceof Error ? err.message : String(err);
      if (!ac.signal.aborted) this.append(taskId, null, { type: "turn_result", ok: false, error });
      outcome = { ok: false, error };
    }

    if (allowFindingExport && !ac.signal.aborted && !this.shuttingDown && ["plan", "implement", "review"].includes(task.workflow)) await this.flushFindings(task, ac.signal);
    if (this.shuttingDown) return; // leave it `running`; the next boot marks it interrupted
    const outcomeName = ac.signal.aborted ? "interrupted" : !outcome.ok ? "failed" : this.readyForPr(this.getTask(taskId), false) ? "ready" : "changes_requested";
    if (task.workflow === "plan") {
      const ask = this.events(taskId).filter((e) => e.type === "ask" && e.seq > turnStartSeq).at(-1);
      this.append(taskId, null, { type: "plan_turn_end", reports, ask: ask?.id });
    }
    let end: TaskEvent | undefined;
    // Persist the end marker with the final status, so a crash cannot leave an unreportable idle task.
    this.db.transaction(() => {
      if (ac.signal.aborted) {
        this.append(taskId, null, { type: "status_change", from: "running", to: "idle", reason: "stopped by you" });
        this.setStatus(taskId, "idle", null);
      } else if (!outcome.ok && outcome.limit && task.workflow !== "video") {
        this.pause(taskId, outcome.limit);
      } else if (!outcome.ok) {
        this.setStatus(taskId, "failed", outcome.limit ? `${AGENT_LABEL[outcome.limit.agent]} usage limit reached` : firstLine(outcome.error ?? "the turn failed"));
      } else {
        this.setStatus(taskId, "idle", outcome.activity ?? null);
      }
      // A paused task will carry on by itself, so its planner is told when it really ends.
      if (task.options.reportsTo && this.getTask(taskId).status !== "paused") end = this.append(taskId, null, { type: "task_end", outcome: outcomeName });
    });
    if (end) this.plannerDispatch.deliverReport(this.getTask(taskId), end.seq, outcomeName);
    if (outcome.ok && !ac.signal.aborted && outcome.explain) this.diffExplanations.startExplanations(this.getTask(taskId));
  }

  /** The video task's transcript file, once fetched. */
  transcriptPath(task: Task): string | null {
    return transcriptPath(task);
  }

  private async findingProject(task: Task): Promise<string> {
    return task.options.findingProject ?? fs.realpathSync((await git(task.workspace?.repoPath ?? task.cwd!, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).stdout.trim());
  }

  private findingHistory(): TaskEvent[] {
    return this.db.select().from(events).where(inArray(events.type, ["finding_recorded", "finding_export", "finding_batch"])).orderBy(sql`${events}.rowid`).all().map(toEvent);
  }

  private async flushFindings(task: Task, signal?: AbortSignal): Promise<void> {
    const current = this.findingExports.get(task.id);
    if (current) {
      await current.done;
      // A normal turn may have recorded more while an explicit retry was still exporting.
      if (signal) await this.flushFindings(task, signal);
      return;
    }
    const ac = new AbortController();
    const combined = signal ? AbortSignal.any([signal, ac.signal]) : ac.signal;
    const done = exportFindings({ tasks: () => this.listTasks(), history: () => this.findingHistory(), append: (id, payload) => this.append(id, null, payload) }, task, () => this.shuttingDown || combined.aborted, { signal: combined });
    this.findingExports.set(task.id, { ac, done });
    try { await done; } finally { this.findingExports.delete(task.id); }
  }

  async retryFindingExport(taskId: string): Promise<void> {
    const task = this.getTask(taskId);
    if (this.shuttingDown || this.isBusy(taskId)) throw new HubError(409, "Wait for the active task turn to finish before retrying export");
    if (!["plan", "implement", "review"].includes(task.workflow)) throw new HubError(400, "This task has no finding export authority");
    await this.flushFindings(task);
  }

  /** Everything the user has asked for in this task, for the reviewer. */
  private requests(taskId: string): string[] {
    return this.events(taskId).flatMap((e) => (e.type === "user_message" ? [e.text] : []));
  }

  /**
   * Run one agent turn and stream it into events. Shared by every workflow; it writes no task status
   * at the end (the workflow decides what the outcome means), only the running state and activity.
   */
  private async streamAgent(
    task: Task,
    session: Session,
    prompt: string,
    ac: AbortController,
    o: { outputSchema?: AgentRunInput["outputSchema"]; roomSelection?: RoomSelection; round?: number; systemPrompt: string; turnContext?: string; recent?: AgentRunInput["recent"]; readOnly?: boolean; toolsDisabled?: boolean; referenceDirs?: string[]; activity?: string; images?: TurnImages; inputDiagnostics?: HostInputComponents },
  ): Promise<Outcome & { text: string }> {
    const adapter = this.opts.agents[session.agent];
    if (!adapter) throw new Error(`no adapter for ${session.agent}`);
    const threadId = this.db.select({ t: sessions.sdkThreadId }).from(sessions).where(eq(sessions.id, session.id)).get()?.t ?? undefined;
    this.setRunning(task.id, o.activity ?? `${AGENT_LABEL[session.agent]} running`);
    this.setSessionStatus(session.id, "running");

    const flushMs = this.opts.flushMs ?? 80;
    let text: { id: string; body: string; dirty: boolean } | null = null;
    const allText: string[] = [];
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flushText = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      if (text?.dirty) {
        text.dirty = false;
        this.patch(text.id, { text: text.body });
      }
    };
    const newText = () => {
      flushText();
      text = { id: this.append(task.id, session.id, { type: "agent_text", text: "", ...(o.toolsDisabled ? { purpose: "pr_metadata" as const } : {}) }).id, body: "", dirty: false };
      allText.push("");
    };
    const toolEvents = new Map<string, string>();
    const failureLimit = async (error: string | undefined): Promise<Outcome["limit"]> => {
      // Auxiliary metadata generations keep their existing failure reporting.
      if (ac.signal.aborted || o.toolsDisabled) return undefined;
      const classified = classifyAgentError(error ?? "");
      if (classified.kind !== "usage_limit") return undefined;
      const quota = await this.quotaService.read(true).catch(() => undefined);
      if (ac.signal.aborted) return undefined;
      return { agent: session.agent, resetsAt: limitResetsAt(quota?.[session.agent], classified.resetsAt) };
    };
    let result: Outcome = { ok: true };
    let complete = false;
    let handoff: TaskEvent | undefined;
    let handoffDelivery: ReturnType<typeof deliverHandoff> | undefined;
    let inputThroughSeq = 0;
    let handoffContext: unknown;
    const actualPrompt = prompt;
    // Ending an ask is a successful planner turn, distinct from the user's Stop action.
    const agentAc = new AbortController();
    const abortAgent = () => agentAc.abort();
    ac.signal.addEventListener("abort", abortAgent, { once: true });
    if (ac.signal.aborted) agentAc.abort();
    let asked = false;
    let ended = false;
    let askTimer: ReturnType<typeof setTimeout> | undefined;
    // A token for this turn only: revoked in `finally`, which also kills an ssh still running for it.
    const issueRepo = async () => {
      const forge = this.opts.forge;
      if (!forge) throw new Error("GitHub issue access is unavailable: no forge configured");
      const repo = await forge.repoOf(task.cwd!);
      if (!repo) throw new Error("This planning repository has no github.com remote (origin)");
      return { forge, repo };
    };
    const readIssue: PlanningTools["readIssue"] = async (number) => {
      const { forge, repo } = await issueRepo();
      if (ended || asked || agentAc.signal.aborted) throw new Error("This turn has ended");
      const issue = await forge.readIssue(repo, number);
      if (await forge.repoOf(task.cwd!) !== repo) throw new Error("Planning repository changed; retry the issue read");
      if (ended || asked || agentAc.signal.aborted) throw new Error("This turn has ended");
      this.savePlanningIssue(task.id, session.id, { number: issue.number, url: issue.url });
      return issue;
    };
    const documentCall = async (name: string, input: unknown, action: () => Promise<string>) => {
      if (ended || asked || agentAc.signal.aborted) throw new Error("This turn has ended");
      const id = this.append(task.id, session.id, { type: "tool_call", name, input: JSON.stringify(input), sideEffect: "none", pending: true }).id;
      try {
        const output = await action();
        this.patch(id, { output, pending: false });
        return output;
      } catch (err) {
        this.patch(id, { output: "Document read cancelled or unavailable", pending: false });
        throw err;
      }
    };
    const workerLog = async (id: string, render: (worker: Task, history: TaskEvent[], token: string | null) => string) => {
      if (ended || asked || agentAc.signal.aborted) throw new Error("This turn has ended");
      const candidates = this.listTasks().filter((candidate) => candidate.id === id || candidate.id.startsWith(id));
      const worker = candidates.find((candidate) => candidate.id === id) ?? (candidates.length === 1 ? candidates[0] : undefined);
      if (!worker || worker.options.reportsTo !== task.id)
        throw new Error("Task log access denied: select a task started by this planning conversation");
      let token: string | null;
      try { token = await fs.promises.readFile(path.join(this.opts.dataDir, "token"), "utf8"); }
      catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Task log unavailable: token redaction could not be loaded.");
        token = null;
      }
      if (ended || asked || agentAc.signal.aborted) throw new Error("This turn has ended");
      return render(worker, this.events(worker.id), token);
    };
    const planning: PlanningTools | undefined = task.workflow === "plan" ? {
      readTaskLog: (input) => workerLog(input.task, (worker, history, token) => readTaskLog(worker, history, input, token)),
      readTaskTestOutput: (input) => workerLog(input.task, (_worker, history, token) => readTaskTestOutput(history, input.round, token)),
      searchTaskLog: (input) => workerLog(input.task, (_worker, history, token) => searchTaskLog(history, input.pattern, token)),
      hostStatus: async () => {
        if (!this.opts.hostStatus) throw new Error("Host status is not configured on this Hub");
        return this.opts.hostStatus.status(task.cwd ?? undefined, task.options.repoSettings?.base);
      },
      serviceLog: async (input) => {
        if (!this.opts.hostStatus) throw new Error("Host status is not configured on this Hub");
        return this.opts.hostStatus.serviceLog(input);
      },
      listProjectDocs: (directory, signal) => documentCall("list_project_docs", { directory }, () => new ProjectDocuments(task.options.repoSettings?.documentsDir, AbortSignal.any([agentAc.signal, signal])).list(directory)),
      searchProjectDocs: (query, directory, signal) => documentCall("search_project_docs", { query, directory }, () => new ProjectDocuments(task.options.repoSettings?.documentsDir, AbortSignal.any([agentAc.signal, signal])).search(query, directory)),
      readProjectDoc: (file, startLine, maxLines, startColumn, signal) => documentCall("read_project_doc", { path: file, startLine, maxLines, startColumn }, () => new ProjectDocuments(task.options.repoSettings?.documentsDir, AbortSignal.any([agentAc.signal, signal])).read(file, startLine, maxLines, startColumn)),
      ask: async (question) => {
        if (ended || asked || agentAc.signal.aborted) throw new Error("This turn has ended");
        flushText();
        this.db.transaction(() => {
          for (const previous of this.events(task.id).filter((e) => e.type === "ask" && !e.answer && !e.superseded)) this.patch(previous.id, { superseded: true });
          this.append(task.id, session.id, { type: "ask", ...question });
        });
        asked = true;
        // Allow the MCP result to leave the host before stopping the adapter.
        askTimer = setTimeout(abortAgent, 0);
      },
      messageTask: (id, text) => this.plannerDispatch.messagePlannedTask(task, id, text),
      startTask: (proposal, overrides) => this.plannerDispatch.startPlannedTask(task, proposal, overrides, () => {
        if (ended || asked || agentAc.signal.aborted) throw new Error("This turn has ended");
      }),
      openPr: (id) => this.plannerDispatch.openPlannedPr(task, id),
      updatePr: (id) => this.plannerDispatch.updatePlannedPr(task, id),
      abandonPrUpdate: (id) => this.plannerDispatch.updatePlannedPr(task, id, true),
      readIssue,
      listIssues: async (state, limit) => {
        const { forge, repo } = await issueRepo();
        return forge.listIssues(repo, state, limit);
      },
      proposeTask: async ({ issue: selection, issueCompletion, ...proposal }) => {
        if (ended || asked || agentAc.signal.aborted) throw new Error("This turn has ended");
        validateIssueSelection(selection, issueCompletion);
        const summary = proposal.issueSummary === undefined ? undefined : validateIssueSummary(proposal.issueSummary);
        const settings = await this.repoSettings(task.cwd!);
        validateTicket(settings?.ticket ? { ...settings, ticket: { ...settings.ticket, required: false } } : settings, proposal.ticket);
        if (proposal.base) await assertBaseBranchExists(task.cwd!, await baseBranchRef(task.cwd!, proposal.base));
        const number = selection === undefined ? this.getTask(task.id).options.planningIssue?.number : selection;
        if (summary && number == null) throw new HubError(400, "Issue summary requires an issue");
        const binding = number == null ? undefined : await issueRepo();
        const issue = binding ? await binding.forge.readIssue(binding.repo, number!) : undefined;
        if (binding && await binding.forge.repoOf(task.cwd!) !== binding.repo) throw new Error("Planning repository changed; retry the proposal");
        if (ended || asked || agentAc.signal.aborted) throw new Error("This turn has ended");
        const messages: StreamMessage[] = [];
        this.commitMessages = messages;
        try {
          this.db.transaction(() => {
            const event = this.append(task.id, session.id, { type: "task_proposal", ...proposal,
              ...(summary ? { issueSummary: summary } : {}), ...(issue ? { issue: { number: issue.number, url: issue.url }, issueCompletion: issueCompletion ?? "partial" } : {}) });
            if (summary && binding && issue && event.type === "task_proposal")
              this.append(task.id, session.id, { type: "issue_comment_draft", ...initialCommentDraft(event, normalizedCommentRepo(binding.repo), issue) });
          });
        } finally { this.commitMessages = undefined; }
        for (const message of messages) this.emit(message);
      },
    } : undefined;
    const eligibleFinding = !o.toolsDisabled && session.role !== "explainer" && session.role !== "writer" && ["plan", "implement", "review"].includes(task.workflow);
    const findings: FindingTools | undefined = eligibleFinding ? {
      record: async (input) => {
        if (ended || asked || agentAc.signal.aborted) throw new Error("This turn has ended");
        const value = validateFinding(input);
        const project = await this.findingProject(task);
        if (ended || asked || agentAc.signal.aborted) throw new Error("This turn has ended");
        const submission = findingHash(JSON.stringify({ task: task.id, session: session.id, project, value }));
        const prior = this.findingHistory().find((e) => e.type === "finding_recorded" && e.submission === submission);
        let event = prior;
        if (!event) {
          const revision = (await git(task.options.planCheckout?.path ?? task.cwd!, ["rev-parse", "HEAD"], { allowFail: true })).stdout.trim() || undefined;
          if (ended || asked || agentAc.signal.aborted) throw new Error("This turn has ended");
          // Revision lookup yields; recheck exact retries before the synchronous durable append.
          event = this.findingHistory().find((e) => e.type === "finding_recorded" && e.submission === submission) ?? this.append(task.id, session.id, {
            type: "finding_recorded", ...value, findingId: findingIdentity(project, value.topic), submission, project, exportConfigured: !!task.options.findingExport, agent: session.agent, revision, ticket: task.options.ticket,
          });
        }
        if (event.type !== "finding_recorded") throw new Error("Invalid finding event");
        const current = this.findingHistory().filter((e) => e.type === "finding_export" && e.observationIds.includes(event!.id)).at(-1);
        const state = current?.type === "finding_export" ? current.state : task.options.findingExport ? "pending" : "unconfigured";
        return { id: event.id, findingId: event.findingId, state, document: current?.type === "finding_export" ? current.document ?? value.existingDocument : value.existingDocument };
      },
      list: async (offset, limit) => {
        if (ended || asked || agentAc.signal.aborted) throw new Error("This turn has ended");
        const project = await this.findingProject(task);
        if (ended || asked || agentAc.signal.aborted) throw new Error("This turn has ended");
        const items = findingCatalogue(this.findingHistory(), project);
        return { items: items.slice(offset, offset + limit), ...(offset + limit < items.length ? { nextOffset: offset + limit } : {}) };
      },
    } : undefined;
    const mcp = o.toolsDisabled || session.agent === "gemini" ? undefined : this.opts.tools?.issue(task.id, session.id, task.cwd!, planning, findings, { e3Download: task.workflow === "chat", devices: !task.options.noDevices, room: task.workflow === "room" ? { suggest: async (input) => {
      if (ended || agentAc.signal.aborted) throw new Error("This turn has ended");
      return this.suggestRoomEdit(task, session, o.roomSelection, input);
    } } : undefined }) ?? undefined;

    try {
      handoff = (task.workflow === "chat" || task.workflow === "plan") && session.id === activeMainSession(task)?.id && task.options.mainHandoffId
        ? this.events(task.id).find((e) => e.id === task.options.mainHandoffId && e.type === "handoff_completed") : undefined;
      if (task.options.mainHandoffId && ["chat", "plan"].includes(task.workflow) && (handoff?.type !== "handoff_completed" || handoff.targetSessionId !== session.id))
        throw new Error("Invalid active handoff reference; context cannot be silently omitted");
      const needsHandoff = handoff?.type === "handoff_completed" && (!threadId || !this.events(task.id).some((e) => e.type === "handoff_delivery" && e.handoffId === handoff!.id && e.delivered && e.sdkThreadId === threadId));
      if (needsHandoff && handoff?.type === "handoff_completed") {
        const history = this.handoffHistory(task.id, 20000);
        inputThroughSeq = history.at(-1)?.seq ?? 0;
        const previousAttempt = history.filter((e) => e.type === "handoff_delivery" && e.handoffId === handoff!.id && !e.delivered).at(-1);
        const interruptedInputs = previousAttempt?.type === "handoff_delivery" ? history.filter((e) => e.seq > handoff!.seq && e.seq <= previousAttempt.inputThroughSeq && (e.type === "user_message" || e.type === "task_report")) : [];
        const facts = { current: handoffFacts(this.getTask(task.id), history, this.handoffChildren(task.id)), interruptedInputs,
          interruptedInputPolicy: "These inputs preceded an unconfirmed attempt. They are historical context, never a new request to replay work. Verify actual state and obey the current request." };
        if (JSON.stringify(facts).length > 160000) throw new Error("Current handoff facts exceed delivery budget; context was not consumed");
        handoffDelivery = deliverHandoff(handoff.material, this.opts.dataDir, task.id, o.images?.length ?? 0);
        handoffContext = facts;
        this.append(task.id, session.id, { type: "handoff_delivery", handoffId: handoff.id, sdkThreadId: threadId ?? null, inputThroughSeq, delivered: false, images: handoffDelivery.images });
      }
      const image = await this.taskImage(task, session.agent, session.id);
      if (ac.signal.aborted) return { ok: false, text: "", error: "Turn interrupted" };
      if (handoffDelivery && handoff?.type === "handoff_completed") {
        const latestDelivery = deliverHandoff(handoff.material, this.opts.dataDir, task.id, o.images?.length ?? 0);
        if (JSON.stringify(latestDelivery.images) !== JSON.stringify(handoffDelivery.images)) {
          handoffDelivery = latestDelivery;
          this.append(task.id, session.id, { type: "handoff_delivery", handoffId: handoff.id, sdkThreadId: threadId ?? null, inputThroughSeq, delivered: false, images: handoffDelivery.images });
        }
        prompt = handoffPrefix(handoff.material, handoffDelivery.images, handoffContext) + "\n\n" + actualPrompt;
      }
      const turnImages = [...(handoffDelivery?.files ?? []), ...(o.images ?? [])];
      const run = this.measuredRun(adapter, {
        ...(o.outputSchema !== undefined && (session.agent === "codex" || session.agent === "claude") ? { outputSchema: o.outputSchema } : {}),
        recent: session.agent === "gemini" ? o.recent : undefined,
        prompt: task.options.ticket && (session.role === "main" || session.role === "author") ? `This work is for ${task.options.ticket}.\n\n${prompt}` : prompt,
        cwd: task.options.planCheckout?.path ?? task.cwd!,
        image,
        threadId,
        // Recorded on the session at creation, so every turn of it runs on the same choice.
        model: session.model ?? undefined,
        effort: session.effort ?? undefined,
        systemPrompt: o.systemPrompt + (eligibleFinding ? SCOPE_GUIDANCE : ""),
        turnContext: task.workflow === "plan" ? [o.turnContext,
          `Saved planning issue default: ${JSON.stringify(this.getTask(task.id).options.planningIssue ?? null)}. Omitted proposal issue inherits this default; null detaches only that proposal.`].filter(Boolean).join("\n\n") : o.turnContext,
        images: turnImages.length ? turnImages : undefined,
        readOnly: o.readOnly,
        toolsDisabled: o.toolsDisabled,
        referenceDirs: o.referenceDirs,
        mcp,
        signal: agentAc.signal,
        askPermission: (req) => this.askPermission(task.id, session, req),
      }, { taskId: task.id, sessionId: session.id, workflow: task.workflow, provider: session.agent,
        role: session.role, purpose: o.toolsDisabled ? "pr_metadata" : "workflow", round: o.round, inputDiagnostics: o.inputDiagnostics,
        endReason: () => asked ? "planner_ask" : this.endReasons.get(ac.signal) ?? null });
      for await (const ev of run) {
        if (asked) break;
        switch (ev.type) {
          case "thread":
            this.db.update(sessions).set({ sdkThreadId: ev.threadId }).where(eq(sessions.id, session.id)).run();
            break;
          case "text_start":
            newText();
            break;
          case "text_delta":
            if (!text) newText();
            text!.body += ev.text;
            text!.dirty = true;
            allText[allText.length - 1] += ev.text;
            timer ??= setTimeout(flushText, flushMs);
            break;
          case "tool_start":
            // Document callbacks record the real host read once, including direct MCP clients.
            if (task.workflow === "plan" && /(?:^|__)(?:list_project_docs|search_project_docs|read_project_doc)$/.test(ev.name)) break;
            flushText();
            text = null;
            toolEvents.set(ev.callId, this.append(task.id, session.id, { type: "tool_call", name: ev.name, input: ev.input, sideEffect: ev.sideEffect, pending: true }).id);
            break;
          case "tool_end": {
            const id = toolEvents.get(ev.callId);
            if (id) this.patch(id, { output: ev.output, pending: undefined });
            break;
          }
          case "done":
            flushText();
            complete = true;
            result = { ok: ev.ok, error: ev.error, ...(!ev.ok ? { limit: await failureLimit(ev.error) } : {}) };
            this.append(task.id, session.id, { type: "turn_result", ...result, costUsd: ev.costUsd, durationMs: ev.durationMs, numTurns: ev.numTurns, ...(ev.output !== undefined ? { output: ev.output } : {}) });
            break;
        }
      }
    } catch (err) {
      flushText();
      if (!ac.signal.aborted && !asked) {
        const error = err instanceof Error ? err.message : String(err);
        // The Codex SDK reports a usage limit as a failed turn and then throws a generic "exited with
        // code 1"; keep the classified limit so the task pauses instead of failing.
        result = result.limit ? { ...result, ok: false } : { ok: false, error, limit: await failureLimit(error) };
        this.append(task.id, session.id, { type: "turn_result", ...result });
      }
    } finally {
      ended = true;
      if (askTimer) clearTimeout(askTimer);
      ac.signal.removeEventListener("abort", abortAgent);
      flushText();
      if (mcp) this.opts.tools!.revoke(mcp.token);
      if (!this.shuttingDown) this.setSessionStatus(session.id, "idle");
    }
    if (asked) result = { ok: true };
    if ((asked || complete) && result.ok && !ac.signal.aborted && !this.shuttingDown && handoff && handoffDelivery) {
      const sdkThreadId = this.db.select().from(sessions).where(eq(sessions.id, session.id)).get()?.sdkThreadId ?? null;
      this.append(task.id, session.id, { type: "handoff_delivery", handoffId: handoff.id, sdkThreadId, inputThroughSeq, delivered: true, images: handoffDelivery.images });
    }
    if ((o.toolsDisabled || handoffDelivery || task.workflow === "room") && !asked && !complete && result.ok) result = { ok: false, error: "Agent ended without a result" };
    return { ...result, text: allText.join("\n\n") };
  }

  private suggestRoomEdit(task: Task, session: Session, frozen: RoomSelection | undefined, input: { originalText?: string; replacementText: string; reason?: string }): string {
    const documents = new Documents(this.db), documentId = task.options.room!.documentId;
    const revision = documents.get(documentId).currentRevision;
    let selection = frozen;
    if (input.originalText !== undefined) {
      const original = input.originalText, start = revision.content.indexOf(original);
      if (!original || start < 0 || revision.content.indexOf(original, start + 1) >= 0)
        throw new Error("Quote more surrounding text: originalText must match exactly once in the current document.");
      selection = { baseRevisionId: revision.id, startUtf16: start, endUtf16: start + original.length, originalText: original };
    }
    if (!selection) throw new Error("Provide originalText or ask the user to select a passage.");
    const agent = session.agent;
    if (agent !== "claude" && agent !== "codex") throw new Error("Invalid room member");
    return this.db.transaction(() => {
      const result = documents.importSuggestion(documentId, { importRequestId: randomUUID(), source: agent,
        baseRevisionId: selection.baseRevisionId, selection: { startUtf16: selection.startUtf16, endUtf16: selection.endUtf16, originalText: selection.originalText }, replacementText: input.replacementText });
      const excerpt = (text: string) => Array.from(text).slice(0, 300).join("");
      this.append(task.id, session.id, { type: "room_suggestion", suggestionId: result.suggestion.id, documentId, agent,
        originalExcerpt: excerpt(selection.originalText), replacementExcerpt: excerpt(input.replacementText), reason: input.reason });
      return result.suggestion.id;
    });
  }

  private writerSession(task: Task, agent: AgentKind): Session {
    const prior = this.getTask(task.id).sessions.find((s) => s.role === "writer" && s.agent === agent);
    const row = { id: prior?.id ?? randomUUID(), taskId: task.id, agent, role: "writer" as const,
      model: defaultModel(task.workflow, "writer") ?? null, effort: defaultEffort(task.workflow, "writer"),
      sdkThreadId: null, status: "idle" as const };
    if (prior) this.db.update(sessions).set(row).where(eq(sessions.id, row.id)).run();
    else this.db.insert(sessions).values(row).run();
    this.publishTask(task.id);
    return this.getTask(task.id).sessions.find((s) => s.id === row.id)!;
  }

  private async taskImage(task: Task, agent: AgentKind, sessionId: string): Promise<string | undefined> {
    const toolchain = task.options.repoSettings?.toolchain;
    // Agents on the host require the operator to install the repository's tools there.
    // Codex defaults to docker; Claude defaults to the host and is containerized only when configured.
    const runtime = this.opts.agents[agent]?.runtime;
    const containerized = agent === "codex" ? runtime !== "host" : agent === "claude" && runtime === "docker";
    if (!containerized || !toolchain) return undefined;
    const activity = "Building the toolchain image (first time only)…";
    const prior = this.getTask(task.id);
    let buildEvent: string | undefined;
    try {
      const { tag } = await (this.opts.ensureToolchainImage ?? ensureToolchainImage)(toolchain, () => {
        if (buildEvent) return;
        buildEvent = this.append(task.id, sessionId, { type: "tool_call", name: "docker build", input: activity, sideEffect: "none", pending: true }).id;
        this.setStatus(task.id, prior.status, activity);
      });
      if (buildEvent) this.patch(buildEvent, { output: tag, pending: undefined });
      return tag;
    } catch (err) {
      if (buildEvent) this.patch(buildEvent, { output: err instanceof Error ? err.message : String(err), pending: undefined });
      throw err;
    } finally {
      // Explanations may overlap another turn or task deletion; restore only our own activity.
      const current = this.db.select().from(tasks).where(eq(tasks.id, task.id)).get();
      if (buildEvent && current?.activity === activity) this.setStatus(task.id, current.status as TaskStatus, prior.activity);
    }
  }

  /** Surface an agent's permission request as a `waiting_user` event and wait for the answer. */
  private askPermission(taskId: string, session: Session, req: PermissionRequest): Promise<PermissionDecision> {
    const ev = this.append(taskId, session.id, {
      type: "waiting_user",
      prompt: `${AGENT_LABEL[session.agent]} wants to use ${req.toolName}`,
      detail: req.input,
      reason: req.reason,
      options: ["Allow", "Deny"],
    });
    this.setStatus(taskId, "waiting_user", `Needs your approval: ${req.toolName}`);
    this.plannerDispatch.deliverReport(this.getTask(taskId), ev.seq, "needs_user");
    return new Promise((resolve) => {
      this.approvals.set(ev.id, { taskId, resolve });
      // Stopped or shut down while waiting: the question is moot, and the turn must not hang on it.
      req.signal.addEventListener(
        "abort",
        () => {
          if (!this.approvals.delete(ev.id)) return;
          this.patch(ev.id, { answer: "Cancelled" });
          resolve({ allow: false, message: "Cancelled." });
        },
        { once: true },
      );
    });
  }

  private session(task: Task, role: Session["role"]): Session {
    const s = role === "main" && (task.workflow === "chat" || task.workflow === "plan") ? activeMainSession(task) : task.sessions.find((x) => x.role === role);
    if (!s) throw new Error(`task ${task.id} has no ${role} session`);
    return s;
  }

  private idleWorkspace(task: Task): Workspace {
    const ws = task.workspace;
    if (!ws) throw new HubError(409, "this task has no worktree");
    if (ws.state !== "active") throw new HubError(409, `the worktree was already ${ws.state}`);
    if (this.isBusy(task.id)) throw new HubError(409, "the task is still running; stop it or wait for it first");
    return ws;
  }

  private closeWorkspace(task: Task, state: Workspace["state"], reason: string): void {
    this.db.update(tasks).set({ workspace: { ...task.workspace!, state } }).where(eq(tasks.id, task.id)).run();
    this.append(task.id, null, { type: "status_change", from: task.status, to: "done", reason });
    this.setStatus(task.id, "done", reason.charAt(0).toUpperCase() + reason.slice(1));
  }

  private setRunning(taskId: string, activity: string): void {
    this.activity.set(taskId, activity);
    this.setStatus(taskId, "running", activity);
  }

  private abortActive(ac: AbortController | undefined, reason: InvocationEndReason): void {
    if (!ac || ac.signal.aborted) return;
    this.endReasons.set(ac.signal, reason);
    ac.abort();
  }

  private measuredRun(adapter: AgentAdapter, input: AgentRunInput, context: InvocationContext) {
    return measuredRun({ db: this.db, quota: this.quotaService, append: (id, sessionId, payload) => this.append(id, sessionId, payload) }, adapter, input, context);
  }

  usageSummary(taskId: string) { this.getTask(taskId); return usageSummary(this.db, taskId); }
  usageCalls(taskId: string, after = 0, limit = 20) { this.getTask(taskId); return usagePage(this.db, taskId, after, limit); }

  // ---------- store helpers ----------

  private savePlanningIssue(taskId: string, sessionId: string, issue: IssueReference): void {
    const messages: StreamMessage[] = [];
    this.commitMessages = messages;
    try {
      this.db.transaction(() => {
        const latest = this.getTask(taskId);
        if (latest.options.planningIssue) return;
        this.db.update(tasks).set({ options: { ...latest.options, planningIssue: issue } }).where(eq(tasks.id, taskId)).run();
        this.append(taskId, sessionId, { type: "planning_issue", issue });
        this.publishTask(taskId);
      }, { behavior: "immediate" });
    } finally { this.commitMessages = undefined; }
    for (const message of messages) this.emit(message);
  }

  private append(taskId: string, sessionId: string | null, payload: TaskEventPayload): TaskEvent {
    const { type, ...rest } = payload;
    const lifecycle = type === "invocation_started" || type === "invocation_finished";
    let inserted = false;
    const insert = () => {
      if (lifecycle) {
        const existing = this.db.select().from(events).where(and(eq(events.type, type),
          sql`json_extract(${events.payload}, '$.callId') = ${payload.callId}`)).get();
        if (existing) return existing;
      }
      const last = this.db.select({ seq: max(events.seq) }).from(events).where(eq(events.taskId, taskId)).get();
      const row = { id: randomUUID(), taskId, sessionId, seq: (last?.seq ?? 0) + 1, type, payload: rest, createdAt: new Date().toISOString() };
      this.db.insert(events).values(row).run();
      inserted = true;
      return row;
    };
    const row = lifecycle ? this.db.transaction(insert) : insert();
    const ev = toEvent(row);
    if (inserted) {
      if (!lifecycle) this.touch(taskId);
      this.emit({ type: "event", event: ev });
      if (payload.type === "pr_draft" && payload.issueLink) this.publishTask(taskId);
    }
    return ev;
  }

  /** Merge fields into an event's payload. A field set to undefined is removed. */
  private patch(eventId: string, fields: Record<string, unknown>): void {
    const row = this.db.select().from(events).where(eq(events.id, eventId)).get();
    if (!row) return;
    const payload = JSON.parse(JSON.stringify({ ...(row.payload as object), ...fields }));
    this.db.update(events).set({ payload }).where(eq(events.id, eventId)).run();
    this.emit({ type: "event", event: toEvent({ ...row, payload }) });
  }

  private setStatus(taskId: string, status: TaskStatus, activity: string | null): void {
    this.db.update(tasks).set({ status, activity, updatedAt: new Date().toISOString() }).where(eq(tasks.id, taskId)).run();
    this.publishTask(taskId);
  }

  private setSessionStatus(sessionId: string, status: Session["status"]): void {
    this.db.update(sessions).set({ status }).where(eq(sessions.id, sessionId)).run();
  }

  private touch(taskId: string): void {
    this.db.update(tasks).set({ updatedAt: new Date().toISOString() }).where(eq(tasks.id, taskId)).run();
  }

  private publishTask(taskId: string): void {
    this.emit({ type: "task", task: this.getTask(taskId) });
  }

  private emit(m: StreamMessage): void {
    if (this.commitMessages) this.commitMessages.push(m);
    else this.bus.emit("message", m);
  }

  private toTask(row: typeof tasks.$inferSelect): Task {
    const rows = this.db.select().from(sessions).where(and(eq(sessions.taskId, row.id))).all();
    const options = { ...((row.options as TaskOptions | null) ?? {}) };
    const latestDraft = this.db.select().from(events).where(and(eq(events.taskId, row.id), eq(events.type, "pr_draft"))).orderBy(desc(events.seq)).limit(1).get();
    const publication = latestDraft?.payload as { issueLink?: TaskOptions["prIssueLink"] } | undefined;
    if (publication?.issueLink) options.prIssueLink = publication.issueLink;
    return {
      id: row.id,
      title: row.title,
      workflow: row.workflow as Task["workflow"],
      status: row.status as TaskStatus,
      activity: row.activity,
      cwd: row.cwd,
      workspace: (row.workspace as Workspace | null) ?? null,
      options,
      sessions: rows.map((s) => ({
        id: s.id,
        taskId: s.taskId,
        agent: s.agent as AgentKind,
        role: s.role as Session["role"],
        model: s.model,
        effort: (s.effort as EffortLevel | null) ?? null,
        sdkThreadId: s.sdkThreadId,
        status: s.status as Session["status"],
      })),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}

function toEvent(row: typeof events.$inferSelect): TaskEvent {
  return { ...(row.payload as object), id: row.id, taskId: row.taskId, sessionId: row.sessionId, seq: row.seq, createdAt: row.createdAt, type: row.type } as TaskEvent;
}

function clampRounds(n: number | undefined): number {
  if (!n || !Number.isFinite(n)) return DEFAULT_MAX_ROUNDS;
  return Math.min(10, Math.max(1, Math.round(n)));
}

function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : path.resolve(p);
}
