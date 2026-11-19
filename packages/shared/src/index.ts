export * from "./document-suggestions";
import type { VideoAnalysis } from "./video-analysis";
export * from "./video-analysis";
export type * from "./documents";
export * from "./issue-link";
export * from "./usage";
export * from "./room";
import type { RoomOptions, RoomQuote, RoomSelection, RoomSuggestionEvent } from "./room";
import type { InvocationStart, InvocationFinal } from "./usage";
import type { TaskListSummary } from "./task-list";
export type { TaskListSummary } from "./task-list";
// Types shared by the web UI and the server. The shapes follow docs/design.md §4 and §6.
export { PR_NOTE_ZH_TW } from "./pr-note.zh-TW";

export type WorkflowId = "chat" | "plan" | "implement" | "review" | "video" | "custom" | "room";
export type AgentKind = "claude" | "codex" | "gemini";
export type SessionRole = "main" | "author" | "reviewer" | "explainer" | "writer";

/** How hard the model thinks. Claude's `effort` and Codex's `modelReasoningEffort` both take these names. */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

/** A model an agent offers, for the model picker. Listed live from each agent, never hard-coded. */
export interface ModelChoice {
  /** What is passed back as the session's model. */
  id: string;
  label: string;
  description?: string;
  /** The effort levels this model accepts (in our vocabulary); absent: no effort choice. */
  effortLevels?: EffortLevel[];
  defaultEffort?: EffortLevel;
}

// Gemini is chat-only and has no model selection; presence of its empty entry signals availability.
export type ModelCatalog = Record<"claude" | "codex", ModelChoice[]> & { gemini?: ModelChoice[] };

// Gemini is direct chat only and is never a workflow or auxiliary default.
// Codex writes and Claude reviews to balance coding throughput and Claude weekly quota.
export function defaultAgent(workflow: WorkflowId, role: SessionRole = "main"): AgentKind {
  if (role === "explainer" || role === "writer") return "codex";
  if (workflow === "chat" || workflow === "plan" || workflow === "video") return "codex";
  if (workflow === "implement" || workflow === "review") return role === "reviewer" ? "claude" : "codex";
  return role === "reviewer" ? "codex" : "claude";
}

// Medium effort avoids high effort token costs: coding has similar first-round approval rates, and
// planning threads are long, so high effort there multiplied every turn.
export function defaultEffort(workflow: WorkflowId, role: SessionRole = "main"): EffortLevel {
  if (role === "explainer" || role === "writer" || workflow === "chat") return "low";
  if (workflow === "video") return "medium"; // a summary is worth a little more thought than a chat reply
  if (workflow === "implement" || workflow === "review" || workflow === "plan") return "medium";
  return role === "reviewer" ? "medium" : "high";
}

// Sonnet preserves Claude weekly quota; repositories can opt into a stronger reviewer.
export function defaultModel(workflow: WorkflowId, role: SessionRole = "main"): string | undefined {
  return (workflow === "implement" || workflow === "review") && role === "reviewer" ? "sonnet" : undefined;
}

export interface RepoAgentDefaults {
  agent?: AgentKind;
  model?: string;
  effort?: EffortLevel;
}

export type TaskStatus = "idle" | "running" | "waiting_user" | "done" | "failed" | "interrupted" | "paused";
export type SessionStatus = "idle" | "running" | "done" | "failed";

export const CHANGE_TYPES = ["feat", "fix", "docs", "refactor", "ci", "test", "chore"] as const;
export type ChangeType = (typeof CHANGE_TYPES)[number];

export interface AppliedRule {
  tag: string;
  sha256: string;
  roles: ("author" | "reviewer" | "planner")[];
  text: string;
}

export interface RepoSettings {
  rules?: Record<string, Record<string, string>>;
  documentsDir?: string;
  findings?: { owner: string };
  agents?: { author?: RepoAgentDefaults; reviewer?: RepoAgentDefaults };
  /** mise tools preinstalled in a derived Codex container image. Host agents need them on the host. */
  toolchain?: Record<string, string>;
  base?: string;
  ticket?: { required: boolean; pattern: string; url?: string };
  branch?: string;
  commit?: string;
  prTitle?: string;
  prLanguage?: "en" | "zh-TW";
  prTemplate?: string;
  testCommand?: string;
}

export interface PrDraft {
  type: ChangeType;
  summary: string;
  slug: string;
  body: string;
}

/** Immutable GitHub revisions observed together; branch names alone cannot authorize an update. */
export interface PrRevision {
  head: string;
  headSha: string;
  target: string;
  targetSha: string;
  crossRepository: boolean;
}

export interface PrUpdate {
  id: string;
  revision: PrRevision;
  pr: { repo: string; number: number };
  stage: "intent" | "fetched" | "merging" | "resolving" | "merged" | "validated" | "publishing" | "succeeded" | "noop" | "failed" | "interrupted" | "abandoning" | "abandoned";
  action?: "abandon";
  previousBase?: { baseSha: string; prBase?: string };
  mergeUntracked?: { path: string; hash: string }[];
  /** Bounded abandonment leftovers; total includes paths omitted from the displayed prefix. */
  retainedUntracked?: { paths: string[]; total: number };
  stoppedAt?: PrUpdate["stage"];
  preSha?: string;
  resultSha?: string;
  conflicted?: boolean;
  /** Blocks ordinary snapshots until this owned integration is published or explicitly abandoned. */
  owned?: boolean;
  tests?: "passed" | "failed" | "none";
  reviewedSha?: string;
  validatedSha?: string;
  /** Reconciliation may cite the original publication evidence without a second push. */
  validationOperationId?: string;
  publication?: "published" | "uncertain";
  error?: string;
}

export interface Workspace {
  id: string;
  /** The user's repository the worktree was made from. */
  repoPath: string;
  worktreePath: string;
  /** The task's own branch, e.g. agent-hub/1a2b3c4d. */
  branch: string;
  /** The branch the worktree started from and merges back into. */
  baseRef: string;
  /** Forge target when baseRef is a configured remote-tracking ref. */
  prBase?: string;
  /** Diff baseline: initially the starting commit; explicit PR updates advance it to the fetched target. */
  baseSha: string;
  state: "active" | "merged" | "discarded";
  /** "owner/name" when the repository is on GitHub, so the branch can become a pull request. */
  github?: string | null;
  /** Published name; the local worktree branch stays private to the Hub. */
  remoteBranch?: string;
  /** Prepared before pushing, so retries never rewrite published commits. */
  prDraft?: PrDraft;
  /** The pull request, once opened. From then on GitHub is the source of truth: merges happen there. */
  pr?: { number: number; url: string; state: "open" | "merged" | "closed"; revision?: PrRevision } | null;
}

/** Per-task knobs for the worktree workflows. */
export type IssueCompletion = "partial" | "complete";

export interface IssueLink {
  issue: IssueReference | null;
  issueCompletion?: IssueCompletion;
}

export interface TaskOptions {
  /** Chat-only final answer schema, captured at creation. */
  outputSchema?: Record<string, unknown>;
  /** Room only (room.ts). */
  room?: RoomOptions;
  /** The agent gets no device tools (list_hosts, ssh_exec, copy_file). Set for tasks started with the remote token. */
  noDevices?: boolean;
  /** Video only: stop once the transcript is fetched, for a caller that reads the transcript itself. */
  transcriptOnly?: boolean;
  /** A plan's read-only worktree at its base, so a spec is written against what the worker starts from. */
  planCheckout?: { path: string; ref: string };
  /** Publication override; the original source association remains available for briefing provenance. */
  prIssueLink?: IssueLink;
  /** First validated planning association, retained across restart and handoff. */
  planningIssue?: IssueReference;
  issueCompletion?: IssueCompletion;
  /** Server-owned shortcut position; absent means unpinned. */
  pinnedAt?: string;
  /** Set while the task is `paused`: the agent hit a usage limit and the Hub continues after the reset. */
  quotaPause?: { agent: AgentKind; resetsAt: string | null; since: string };
  activeMainSessionId?: string;
  mainHandoffId?: string;
  scopeEstimate?: ScopeEstimate;
  findingProject?: string;
  findingExport?: { documentsDir: string; owner: string };
  /** Settings captured at task creation; later edits apply to new tasks only. */
  repoSettings?: RepoSettings;
  appliedRules?: AppliedRule[];
  /** Durable link to the planning conversation that dispatched this task. */
  reportsTo?: string;
  ticket?: string;
  ticketUrl?: string;
  /** The issue linked by the stored planning proposal. */
  issue?: IssueReference;
  /** review: author/reviewer rounds before stopping for the user. */
  maxRounds?: number;
  /** Run in the worktree after the reviewer approves; a failure goes back to the author. */
  testCommand?: string;
}

export interface Session {
  id: string;
  taskId: string;
  agent: AgentKind;
  role: SessionRole;
  /** null: the agent's default model. */
  model: string | null;
  effort: EffortLevel | null;
  sdkThreadId: string | null;
  status: SessionStatus;
}

export interface Task {
  id: string;
  title: string;
  workflow: WorkflowId;
  status: TaskStatus;
  /** One-line description of what is happening right now, e.g. "Codex reviewing (round 2/3)". */
  activity: string | null;
  /** Where the agent runs. A worktree task's cwd is its worktree; a chat task's is the directory it was given, or a scratch dir. */
  cwd: string | null;
  workspace: Workspace | null;
  options: TaskOptions;
  sessions: Session[];
  createdAt: string;
  updatedAt: string;
}

/** A present invalid selector deliberately has no legacy fallback. */
export function activeMainSession(task: Task): Session | undefined {
  if (task.options.activeMainSessionId !== undefined)
    return task.sessions.find((s) => s.id === task.options.activeMainSessionId && s.role === "main");
  const main = task.sessions.filter((s) => s.role === "main");
  return main.length === 1 ? main[0] : undefined;
}

export interface SwitchAgentInput { target: AgentKind; expectedSessionId: string }
export interface HandoffSummary {
  goals: string; decisions: string; constraints: string; completed: string;
  pending: string; uncertainty: string; references: number[];
}
export interface HandoffImage {
  eventId: string; seq: number; attachment: ImageAttachment;
  reason?: "older" | "excess" | "budget" | "unavailable" | "current_input_priority";
}
export interface HandoffMaterial {
  sourceFrom: number; sourceTo: number; sourceIdentity: string;
  summary: HandoffSummary;
  recent: { eventId: string; seq: number; sessionId: string | null; type: "user_message" | "agent_text"; text: string }[];
  recentOmissions: { seq: number; reason: "older" | "oversized" | "budget" }[];
  images: HandoffImage[];
}
export interface HandoffOperation {
  operationId: string; sourceSessionId: string; sourceBackend: AgentKind; target: AgentKind;
  sourceFrom: number; sourceTo: number; sourceIdentity: string;
}

/** A tool call that may have changed something outside the agent (see design.md §8). */
export type SideEffect = "none" | "ssh" | "git" | "shell";

export interface ReviewFinding {
  rule?: string;
  severity: "high" | "medium" | "low";
  location: string; // "path/to/file.ts:42"
  message: string;
}

/** An issue validated on the host and persisted with a proposal or task. */
export interface IssueReference {
  number: number;
  url: string;
}

/** Public summary supplied in the existing planning turn; semantic agreement requires human preview. */
export interface IssueRequirementSummary {
  problem: string;
  behavior: string[];
  acceptanceCriteria: string[];
  outOfScope: string[];
}

export interface IssueCommentDraft {
  draftId: string;
  revision: number;
  proposalId: string;
  sourceIdentity: string;
  sourceReference: string;
  repo: string;
  issue: IssueReference & { title: string };
  operationId: string;
  content: string;
  /** Exact confirmation snapshot, including the protected source footer and hidden marker. */
  body: string;
  bodyIdentity: string;
}
export interface IssueCommentVersion { draftId: string; revision: number }
export interface IssueCommentEdit extends IssueCommentVersion { content: string }
export type IssueCommentState = "preparing" | "publishing" | "published" | "failed" | "uncertain";
export interface IssueCommentOutcome extends IssueCommentVersion {
  operationId: string;
  bodyIdentity: string;
  repo: string;
  issueNumber: number;
  state: IssueCommentState;
  comment?: { id: number; url: string };
  error?: string;
}

/** A self-contained implementation prompt agreed on in a planning conversation. */
export interface TaskProposal {
  /** Risks the plan knowingly leaves open, with their effect and when to handle them. Not sent to the worker. */
  knownRisks?: string[];
  /** Branch on origin the worker starts from and targets, for a change stacked on unmerged work. */
  base?: string;
  issueCompletion?: IssueCompletion;
  issueSummary?: IssueRequirementSummary;
  scopeEstimate?: ScopeEstimate;
  title: string;
  spec: string;
  testCommand?: string;
  issue?: IssueReference;
  startedTaskId?: string;
  ticket?: string;
}

export interface PlannerAsk {
  question: string;
  context?: string;
  options?: { label: string; detail: string }[];
  recommended?: string;
  items?: { text: string; severity?: "high" | "medium" | "low"; suggestion?: string }[];
}

export interface DiffHunk {
  id: string;
  path: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  patch: string;
}

export interface DiffExplanation {
  writtenBy?: AgentKind;
  fallbackFrom?: { agent: AgentKind; resetsAt: string | null };
  limit?: { agent: AgentKind; resetsAt: string | null };
  sha: string;
  items: { id: string; path: string; explanation: string }[];
  /** Ranges from the explained commit, retained even when HEAD moves. */
  hunks: Omit<DiffHunk, "patch">[];
  skipped?: number;
  error?: string;
}

export interface DiffExplanationsResponse {
  event: (TaskEvent & { type: "diff_explanations" }) | null;
  headSha: string | null;
  dirty: boolean;
  stale: boolean;
  generating: boolean;
}

/** Versioned explanatory material; never a coding verdict or publication authorization. */
export interface ChangeBriefingSource {
  baseSha: string;
  headSha: string;
  baseTree: string;
  headTree: string;
  contextId: string;
  identity: string;
  guides: { path: string; revision: string }[];
  generatedFiles?: string[];
}
export type ChangeBriefingTourStop = {
  path: string;
  revision: "base" | "head";
  supporting: boolean;
  explanation: string;
} & (
  | { kind?: "symbol"; symbol: string; line: number }
  | { kind: "file"; symbol?: never; line?: never }
);
export interface ChangeBriefingContent {
  problem: string;
  before: string;
  after: string;
  diagram: string;
  tour: ChangeBriefingTourStop[];
  rationale: string;
  alternatives: string;
  risks: string;
  questions: { question: string; answer: string }[];
  uncertainty: string;
  references: { section: "rationale" | "alternatives" | "risks" | "questions"; kind: "source" | "inference" | "unknown"; source: string }[];
}
export interface ChangeBriefing {
  writtenBy?: AgentKind;
  fallbackFrom?: { agent: AgentKind; resetsAt: string | null };
  generationId: string;
  source: ChangeBriefingSource;
  content: ChangeBriefingContent;
  markdown: string;
}
export interface ChangeBriefingResponse {
  briefing: ChangeBriefing | null;
  state: "empty" | "generating" | "current" | "stale" | "failed";
  error?: string;
}

export interface TaskReport {
  scopeEstimate?: ScopeEstimate;
  scopeOverrun?: boolean;
  binaryFiles?: number;
  recordedFindings?: FindingSummary[];
  taskId: string;
  title: string;
  outcome: "ready" | "changes_requested" | "failed" | "interrupted" | "needs_user" | "conflict" | "updated" | "update_failed" | "update_interrupted" | "update_abandoned";
  prUpdate?: PrUpdate;
  conflict?: PrRevision;
  /** Source event sequence: deduplicates reports across updates and restarts. */
  finalSeq: number;
  rounds: number;
  lastVerdict: "approve" | "changes" | null;
  findings: ReviewFinding[];
  test: "passed" | "failed" | "none";
  filesChanged: number;
  additions: number;
  deletions: number;
  branch: string;
  pr?: { number: number; url: string };
  handled?: boolean;
}

export interface PrConfirmation {
  /** Omission retains the saved draft; null explicitly detaches. */
  issue?: number | null;
  issueCompletion?: IssueCompletion;
  draftId: string;
  branch: string;
  commitMessage?: string;
  title: string;
  body: string;
}

export interface TaskPinRequest { pinned: boolean }

export type TaskEventPayload =
  | { type: "video_analysis"; analysis: VideoAnalysis }
  | { type: "planning_issue"; issue: IssueReference }
  | ({ type: "invocation_started" } & InvocationStart)
  | ({ type: "invocation_finished" } & InvocationFinal)
  | ({ type: "issue_comment_draft" } & IssueCommentDraft)
  | ({ type: "issue_comment_outcome" } & IssueCommentOutcome)
  | ({ type: "handoff_started" } & HandoffOperation)
  | ({ type: "handoff_completed"; targetSessionId: string; material: HandoffMaterial } & HandoffOperation)
  | ({ type: "handoff_failed"; error: string; interrupted: boolean } & HandoffOperation)
  | { type: "handoff_delivery"; handoffId: string; sdkThreadId: string | null; inputThroughSeq: number; delivered: boolean; images: HandoffImage[] }

  | { type: "pin_changed"; pinnedAt: string | null }
  | { type: "briefing_started"; generationId: string; source?: ChangeBriefingSource }
  | ({ type: "briefing_completed" } & ChangeBriefing)
  | { type: "briefing_failed"; generationId: string; error: string; interrupted: boolean; limit?: { agent: AgentKind; resetsAt: string | null } }
  | ({ type: "finding_recorded" } & FindingObservation)
  | ({ type: "finding_export" } & FindingExport)
  | { type: "finding_batch"; batch: FindingBatch }
  | ({ type: "ask"; answer?: string; superseded?: boolean } & PlannerAsk)
  | { type: "task_message_sent"; task: string; title: string; text: string }
  /** Notification boundary: reports notify only if their planner turn did not ask. */
  | { type: "plan_turn_end"; reports: string[]; ask?: string }
  | {
      type: "pr_draft";
      issueLink?: IssueLink;
      /** Exact host-owned block, including its separator; never match arbitrary references. */
      managedIssue?: string;
      writtenBy?: AgentKind;
      fallbackFrom?: { agent: AgentKind; resetsAt: string | null };
      /** Agent-generated values, or the edited values confirmed by the user. */
      by: "agent" | "user";
      briefingId?: string;
      briefingError?: string;
      mainBody?: string;
      changeType: ChangeType;
      branch: string;
      /** Absent when the remote branch is already published and cannot be rewritten. */
      commitMessage?: string;
      title: string;
      /** Complete text exactly as it will be posted. */
      body: string;
      /** Published branch and commit are fixed; only title and body apply. */
      published?: boolean;
    }
  | ({ type: "diff_explanations" } & DiffExplanation)
  | { type: "diff_explanations_started"; sha?: string }
  | ({ type: "task_proposal" } & TaskProposal)
  /** taskId on the event envelope identifies the plan; task/report.taskId identifies the worker. */
  | { type: "task_started"; task: string; title: string }
  | { type: "task_report"; report: TaskReport; /** Durable hidden input, including the agreed spec. */ prompt?: string }
  | { type: "task_end"; outcome: TaskReport["outcome"] }
  | {
      type: "user_message";
      text: string;
      /** Pictures sent with the message; served at /api/tasks/:id/attachments/:file. */
      images?: ImageAttachment[];
      /** Sent while a turn was running; delivered as the next turn's input (design.md §7.1). */
      queued?: boolean;
      /** Room only: the quoted message, the frozen document selection, and whether this is a respond-to-each-other turn. */
      quote?: RoomQuote;
      selection?: RoomSelection;
      exchange?: boolean;
    }
  | { type: "agent_text"; text: string; purpose?: "pr_metadata" }
  | ({ type: "room_suggestion" } & RoomSuggestionEvent)
  | {
      type: "tool_call";
      name: string;
      input: string;
      output?: string;
      sideEffect: SideEffect;
      /** Still running when the event was recorded. */
      pending?: boolean;
    }
  | { type: "status_change"; from: TaskStatus; to: TaskStatus; reason?: string }
  | { type: "review_result"; operationId?: string; sha?: string; round: number; verdict: "approve" | "changes"; findings: ReviewFinding[] }
  | { type: "pr_conflict"; revision: PrRevision; state: "conflicting" | "resolved" | "changed" }
  | { type: "pr_update_authorized"; task: string; action?: "abandon"; operationId?: string }
  | { type: "pr_update"; update: PrUpdate }
  | { type: "diff_snapshot"; round: number; filesChanged: number; additions: number; deletions: number; binaryFiles?: number }
  | {
      /** The agent needs a decision from the user, e.g. approving a tool call `auto` mode could not judge. */
      type: "waiting_user";
      prompt: string;
      /** What exactly is being asked about, e.g. the command line. */
      detail?: string;
      /** Why it was escalated, when the agent says. */
      reason?: string;
      options: string[];
      /** Set once answered, or when the request was cancelled. */
      answer?: string;
    }
  | { type: "turn_result"; output?: unknown; ok: boolean; error?: string; limit?: { agent: AgentKind; resetsAt: string | null }; costUsd?: number; durationMs?: number; numTurns?: number }
  | { type: "test_result"; operationId?: string; sha?: string; round: number; command: string; exitCode: number | null; output: string }
  | { type: "pr_opened"; number: number; url: string; task?: string };

export type TaskEvent = {
  id: string;
  taskId: string;
  sessionId: string | null;
  /** Per-task order. Display order is seq only, never timestamps. */
  seq: number;
  createdAt: string;
} & TaskEventPayload;

export interface FileDiff {
  binary?: boolean;
  path: string;
  status: "added" | "modified" | "deleted";
  additions: number;
  deletions: number;
}

/** Both sides of one file, for a side-by-side diff. Binary files come back as a placeholder. */
export interface FileContents {
  path: string;
  original: string;
  modified: string;
  binary: boolean;
}

/** How to proceed with an interrupted task (design.md §8). */
export type RecoverAction = "continue" | "restart" | "end";

/** One message on the SSE stream. Each carries the whole record, so applying it twice is harmless. */
export type StreamMessage = { type: "task_summary"; summary: TaskListSummary } | { type: "hello" } | { type: "task"; task: Task } | { type: "event"; event: TaskEvent } | { type: "task_deleted"; taskId: string };

/** A picture attached to a message, as stored. */
export interface ImageAttachment {
  /** The stored file name, e.g. "3f2a…​.png". */
  file: string;
  mime: string;
  size: number;
}

/** A picture as uploaded: base64 data, at most MAX_IMAGE_BYTES decoded. */
export interface ImageUpload {
  mime: string;
  data: string;
}

export const IMAGE_MIME = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGES_PER_MESSAGE = 6;

export interface NewTaskInput {
  outputSchema?: Record<string, unknown>;
  /** Omission inherits a proposal; null explicitly detaches. Plans may be seeded with a validated number. */
  issue?: number | null;
  issueCompletion?: IssueCompletion;
  /** null explicitly clears a proposal estimate; omitted inherits it. */
  scopeEstimate?: ScopeEstimate | null;
  ticket?: string;
  /** plan/implement/review: branch on origin to start from and target. Omitted: the repository's configured base. */
  base?: string;
  title: string;
  workflow: WorkflowId;
  /** Omitted: defaultAgent(workflow). */
  agent?: AgentKind;
  /** Omitted: the agent's default model. */
  model?: string;
  /** Omitted: defaultEffort(workflow). */
  effort?: EffortLevel;
  /** The reviewer for the `review` workflow. */
  reviewer?: AgentKind;
  /** Omitted: defaultModel(workflow, "reviewer") for the default agent. Empty: the agent's default model. */
  reviewerModel?: string;
  reviewerEffort?: EffortLevel;
  maxRounds?: number;
  testCommand?: string;
  /** implement/review: a worktree repo. plan: a required read-only repo. chat: an optional directory. */
  repoPath?: string;
  /** The planning proposal this task starts. Each proposal can start only one task. */
  fromProposal?: { taskId: string; eventId: string };
  message: string;
  images?: ImageUpload[];
  /** Start the task without device tools. Forced on for the remote token. */
  noDevices?: boolean;
  /** video: fetch the transcript and stop, without the agent's summary. Rejected for other workflows. */
  transcriptOnly?: boolean;
}

/** A device agents may reach with `ssh_exec` (design.md §7.3). Only registered hosts are reachable. */
export interface Host {
  /** What agents and the UI call it, e.g. "nas". Unique. */
  name: string;
  address: string;
  user: string;
  port: number;
  /** Private key on the Agent Hub machine. It never enters a container. */
  keyPath: string;
  /** Told to the agent: what this device is and anything it should know. */
  note: string;
  /** Production: shown loudly, and the agent is told to be careful. */
  prod: boolean;
  /** What runs a command on the device: sh/bash (Linux, macOS) or Windows PowerShell. */
  shell: HostShell;
}

export type HostShell = "posix" | "powershell";

/** One `ssh_exec` call, kept for the audit trail. */
export interface SshLogEntry {
  id: string;
  taskId: string | null;
  host: string;
  command: string;
  exitCode: number | null;
  output: string;
  startedAt: string;
  durationMs: number;
}

/** Live subscription readings, independent of task tokens and API billing. Times are ISO UTC. */
export interface QuotaWindow {
  id: string;
  bucket: string;
  durationMins: number | null;
  remainingPercent: number | null;
  resetsAt: string | null;
}
export type QuotaStatus = "ok" | "unknown" | "unavailable" | "missing_login" | "error";
export interface QuotaReading {
  status: QuotaStatus;
  windows: QuotaWindow[];
}
export interface ProviderQuota extends QuotaReading {
  provider: AgentKind;
  updatedAt: string | null;
  stale: boolean;
  /** Earliest ordinary query, including freshness, reset expiry and failure backoff. */
  nextRefreshAt: string;
  manualRefreshAt: string;
}
// Gemini appears only when the isolated chat adapter is registered.
export type QuotaResponse = Record<"claude" | "codex", ProviderQuota> & { gemini?: ProviderQuota };

/** Estimates are advisory and never authorize a wider scope. */
export interface ScopeEstimate { maxFiles?: number; maxChangedLines?: number }
export function validateScopeEstimate(value: unknown): ScopeEstimate | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid scopeEstimate");
  const obj = value as Record<string, unknown>;
  if (Object.keys(obj).some((k) => !["maxFiles", "maxChangedLines"].includes(k))) throw new Error("Invalid scopeEstimate field");
  for (const v of Object.values(obj)) if (v !== undefined && (!Number.isSafeInteger(v) || (v as number) <= 0)) throw new Error("Scope estimates must be positive safe integers");
  return Object.values(obj).some((v) => v !== undefined) ? obj as ScopeEstimate : undefined;
}
export function scopeExceeded(estimate: ScopeEstimate | undefined, diff: { filesChanged: number; additions: number; deletions: number }): boolean {
  return !!estimate && ((estimate.maxFiles !== undefined && diff.filesChanged > estimate.maxFiles) ||
    (estimate.maxChangedLines !== undefined && diff.additions + diff.deletions > estimate.maxChangedLines));
}
export interface FindingInput {
  topic: string;
  title: string;
  evidence: string;
  locations?: string[];
  followUp?: string;
  existingDocument?: string;
}
export type FindingExportState = "pending" | "unconfigured" | "exported" | "referenced" | "conflict";
export interface FindingObservation extends FindingInput {
  findingId: string;
  submission: string;
  exportConfigured?: boolean;
  project: string;
  agent: AgentKind;
  revision?: string;
  ticket?: string;
}
export interface FindingExport {
  documentRepository?: string;
  observationIds: string[];
  findingId: string;
  state: FindingExportState;
  reason?: string;
  document?: string;
  hash?: string;
  commit?: string;
  batchId?: string;
}
export interface FindingSummary {
  findingId: string; topic: string; title: string; document?: string; state: FindingExportState; reason?: string;
}
/** Write-ahead journal, persisted before touching the documentation repository. */
export interface FindingBatch {
  id: string;
  root: string;
  head: string;
  branch: string;
  files: { path: string; findingId: string; observationIds: string[]; beforeHash?: string; hash: string; content: string }[];
}

export interface DeployCommit { sha: string; subject: string }
export interface DeployStatus {
  enabled: boolean;
  disabledReason?: "not_enabled" | "not_git_checkout" | "unit_not_installed";
  current: DeployCommit | null;
  target: DeployCommit | null;
  pending: DeployCommit[];
  dirty: boolean;
  fetchError?: string;
  deploying: boolean;
  history: string | null;
  last: {
    sha: string;
    requestedAt: string;
    outcome: "running" | "succeeded" | "failed";
    result?: string;
    exitStatus?: string;
    finishedAt?: string;
    log?: string;
  } | null;
}

/** Public Google connection projection. Credentials never leave the server. */
export interface GoogleStatus {
  storageError: boolean;
  configured: boolean;
  mode: "callback" | "paste" | null;
  configError: string | null;
  account: { email: string; capabilities: string[]; needsReauthorization: boolean } | null;
}

export type GoogleErrorCode =
  | "not_configured"
  | "not_connected"
  | "missing_capability"
  | "reauthorize"
  | "expired_state"
  | "denied"
  | "failed"
  | "invalid_url"
  | "wrong_mode"
  | "unknown_capability"
  | "storage_error";

export type AntigravityKey = "enter" | "up" | "down" | "left" | "right" | "tab" | "escape" | "space" | "backspace";
export type AntigravityInput = { key: AntigravityKey } | { text: string; submit?: boolean };
export interface AntigravitySession {
  failedStage?: "availability" | "cleanup" | "prepare" | "create" | "attach" | "start" | "wait" | "remove";
  state: "idle" | "preparing-image" | "running" | "stopping" | "exited" | "cancelled" | "expired" | "failed";
  screen: string[];
  links: string[];
  exitCode?: number;
  startedAt: number | null;
  expiresAt: number | null;
}
export interface AntigravityStatus {
  available: boolean;
  reason?: "docker-unavailable" | "unsupported-arch";
  session: AntigravitySession;
  credentials: "absent" | "present-unverified";
}
