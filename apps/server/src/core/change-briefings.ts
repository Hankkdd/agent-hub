import type { MeasuredRun } from "./invocations";
import { withAgentFallback, configuredAgents, AuxiliaryUsageLimit, type FallbackDeps } from "./agent-fallback";
import { randomUUID } from "node:crypto";
import { EFFORT_LEVELS } from "@agent-hub/shared";
import type {
  AgentKind, ChangeBriefing, ChangeBriefingResponse, EffortLevel, Task, TaskEvent, TaskEventPayload, Workspace,
} from "@agent-hub/shared";
import type { AgentAdapter } from "../agents/types";
import {
  briefingContextIdentity, briefingAbortable, captureBriefing, validateBriefing, renderBriefing, BRIEFING_SYSTEM,
} from "./briefing";
import { HubError } from "./hub";
import { firstLine } from "./text";

const BRIEFING_DEADLINE_MS = 300_000;

/** The callbacks and shared scheduler state needed for change briefings. */
export interface ChangeBriefingDeps extends FallbackDeps {
  agents: Partial<Record<AgentKind, AgentAdapter>>;
  measuredRun: MeasuredRun;
  active: Map<string, AbortController>;
  turnDone: Map<string, Promise<void>>;
  getTask(id: string): Task;
  taskExists(taskId: string): boolean;
  events(taskId: string): TaskEvent[];
  append(taskId: string, sessionId: string | null, payload: TaskEventPayload): TaskEvent;
  idleWorkspace(task: Task): Workspace;
  taskImage(task: Task, agent: AgentKind, sessionId: string): Promise<string | undefined>;
  nextWaiting(): string | undefined;
  kick(taskId: string): void;
  hasQueued(taskId: string): boolean;
  shuttingDown(): boolean;
}

export class ChangeBriefings {
  private readonly briefingJobs = new Map<string, { ac: AbortController; done: Promise<ChangeBriefing> }>();

  constructor(private readonly deps: ChangeBriefingDeps) {}

  busy(taskId: string): boolean {
    return this.briefingJobs.has(taskId);
  }

  abort(taskId: string): void {
    this.briefingJobs.get(taskId)?.ac.abort();
  }

  async briefing(taskId: string): Promise<ChangeBriefingResponse> {
    const task = this.deps.getTask(taskId);
    const initial = this.deps.events(taskId);
    let identity: string | undefined;
    let error: string | undefined;
    if (initial.some((e) => e.type === "briefing_completed") && task.workspace?.state === "active") {
      try {
        const captured = await captureBriefing(task, initial);
        if (briefingContextIdentity(this.deps.getTask(taskId), this.deps.events(taskId)) === captured.source.contextId) identity = captured.source.identity;
      } catch (err) { error = err instanceof Error ? err.message : String(err); }
    }
    // Reads await Git; another generation or follow-up may have arrived during the projection.
    const history = this.deps.events(taskId);
    const completed = history.filter((e) => e.type === "briefing_completed").at(-1);
    const latest = history.filter((e) => e.type.startsWith("briefing_")).at(-1);
    if (latest?.type === "briefing_failed") error = latest.error;
    return { briefing: completed ?? null, state: latest?.type === "briefing_started" ? "generating" : latest?.type === "briefing_failed" ? "failed" : completed ? completed.source.identity === identity ? "current" : "stale" : "empty", error };
  }

  /** Explicit auxiliary action: no coding round, finding export or change to readiness. */
  generateBriefing(taskId: string, rewrite = false): Promise<ChangeBriefing> {
    const existing = this.briefingJobs.get(taskId);
    if (existing) return existing.done;
    const task = this.deps.getTask(taskId);
    this.deps.idleWorkspace(task);
    const ac = new AbortController();
    this.deps.active.set(taskId, ac);
    const done = this.ensureBriefing(taskId, ac, rewrite).finally(() => {
      this.deps.active.delete(taskId);
      this.deps.turnDone.delete(taskId);
      const next = this.deps.nextWaiting();
      if (next && !this.deps.shuttingDown()) this.deps.kick(next);
      if (!this.deps.shuttingDown() && this.deps.hasQueued(taskId)) this.deps.kick(taskId);
    });
    this.deps.turnDone.set(taskId, done.then(() => {}, () => {}));
    return done;
  }

  ensureBriefing(taskId: string, ac: AbortController, rewrite = false): Promise<ChangeBriefing> {
    const existing = this.briefingJobs.get(taskId);
    if (existing) return existing.done;
    const generationId = randomUUID();
    const done = this.runBriefing(taskId, generationId, ac, rewrite).finally(() => this.briefingJobs.delete(taskId));
    this.briefingJobs.set(taskId, { ac, done });
    return done;
  }

  private async runBriefing(taskId: string, generationId: string, ac: AbortController, rewrite: boolean): Promise<ChangeBriefing> {
    let started = false;
    let limit: AuxiliaryUsageLimit["limit"] | undefined;
    let timedOut = false;
    const timeout = setTimeout(() => {
      if (ac.signal.aborted) return;
      timedOut = true;
      ac.abort();
    }, BRIEFING_DEADLINE_MS);
    try {
      const task = this.deps.getTask(taskId);
      if (!["implement", "review"].includes(task.workflow)) throw new Error("Briefings are only available for implementation PRs");
      const captured = await captureBriefing(task, this.deps.events(taskId), ac.signal);
      const history = this.deps.events(taskId);
      if (briefingContextIdentity(this.deps.getTask(taskId), history) !== captured.source.contextId) throw new Error("Briefing inputs changed during capture");
      const previous = history.filter((e) => e.type === "briefing_completed").at(-1);
      const last = history.filter((e) => e.type.startsWith("briefing_")).at(-1);
      if (!rewrite && last?.type === "briefing_completed" && previous?.source.identity === captured.source.identity && !ac.signal.aborted) return previous;
      if (ac.signal.aborted || this.deps.shuttingDown()) throw new Error("Briefing generation interrupted");
      this.deps.append(taskId, null, { type: "briefing_started", generationId, source: captured.source });
      started = true;
      const author = task.sessions.find((s) => s.role === "author" || s.role === "main")!;
      const effort = (process.env.AGENT_HUB_BRIEFING_EFFORT ?? "low") as EffortLevel;
      if (!(EFFORT_LEVELS as readonly string[]).includes(effort)) throw new Error("Invalid briefing effort configuration: AGENT_HUB_BRIEFING_EFFORT");
      const generated = await withAgentFallback(author.agent, configuredAgents(this.deps.agents), this.deps, ac.signal, async ({ agent }) => {
        const adapter = this.deps.agents[agent];
        if (!adapter) throw new Error("Author adapter unavailable");
        const image = await briefingAbortable(this.deps.taskImage(task, agent, author.id), ac.signal);
        const collect = async () => {
          let text = "";
          let complete = false;
          for await (const e of this.deps.measuredRun(adapter, { prompt: JSON.stringify(captured), systemPrompt: BRIEFING_SYSTEM,
            cwd: task.workspace!.worktreePath, signal: ac.signal, readOnly: true, toolsDisabled: true,
            model: agent === author.agent ? author.model ?? undefined : undefined, effort, image }, { taskId, sessionId: null, workflow: task.workflow, provider: agent, role: "auxiliary", purpose: "change_briefing", operationId: generationId })) {
            if (ac.signal.aborted) throw new Error("Briefing generation interrupted");
            if (e.type === "text_delta") {
              text += e.text;
              if (Buffer.byteLength(text) > 48_000) throw new Error("Briefing output exceeds 48000 bytes");
            } else if (e.type === "done") {
              if (!e.ok) throw new Error(e.error || "Briefing generation failed");
              complete = true;
            } else if (e.type === "tool_start") throw new Error("Briefing adapter attempted tool use");
          }
          if (!complete) throw new Error("Briefing ended without a complete result");
          return text;
        };
        return briefingAbortable(collect(), ac.signal);
      });
      const raw = generated.value;
      const content = await validateBriefing(raw, captured, task.workspace!.worktreePath);
      const current = await captureBriefing(this.deps.getTask(taskId), this.deps.events(taskId), ac.signal);
      if (briefingContextIdentity(this.deps.getTask(taskId), this.deps.events(taskId)) !== captured.source.contextId || current.source.identity !== captured.source.identity || ac.signal.aborted || this.deps.shuttingDown()) throw new Error("Briefing source changed or generation interrupted; prepare again explicitly");
      const briefing: ChangeBriefing = { writtenBy: generated.agent, fallbackFrom: generated.fallbackFrom, generationId, source: captured.source, content, markdown: renderBriefing(content, captured.source) };
      this.deps.append(taskId, null, { type: "briefing_completed", ...briefing });
      return briefing;
    } catch (err) {
      const interrupted = ac.signal.aborted;
      if (!interrupted && err instanceof AuxiliaryUsageLimit) limit = err.limit;
      const error = timedOut ? `Briefing generation timed out after ${BRIEFING_DEADLINE_MS / 60_000} minutes`
        : interrupted ? "Briefing generation interrupted" : firstLine(err instanceof Error ? err.message : String(err)).slice(0, 1000);
      ac.abort();
      if (this.deps.taskExists(taskId)) {
        if (!started) this.deps.append(taskId, null, { type: "briefing_started", generationId });
        this.deps.append(taskId, null, { type: "briefing_failed", generationId, error, interrupted, limit });
      }
      throw new HubError(409, error);
    } finally { clearTimeout(timeout); }
  }

  async currentBriefing(taskId: string, generationId?: string): Promise<ChangeBriefing> {
    const result = await this.briefing(taskId);
    if (result.state !== "current" || !result.briefing || (generationId && result.briefing.generationId !== generationId)) throw new HubError(409, "A current briefing and fresh PR draft are required; prepare again");
    return result.briefing;
  }
}
