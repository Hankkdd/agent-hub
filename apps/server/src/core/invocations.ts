import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, gt, sql } from "drizzle-orm";
import { TOKEN_FIELDS, type AgentKind, type InvocationEndReason, type InvocationStart, type InvocationFinal, type TaskEvent,
  type TaskEventPayload, type TaskUsagePage, type TaskUsageSummary, type UsageCall, type UsageObservation,
  type HostInputComparison, type HostInputComponents, type HostInputDiagnostics } from "@agent-hub/shared";
import type { AgentAdapter, AgentEvent, AgentRunInput } from "../agents/types";
import { counter, emptyCounters } from "../agents/usage";
import { schema, type Db } from "../db/index";
import { classifyAgentError } from "../agents/errors";
import { findBaseline, normalizeInvocation, normalizeSpan, unknownUsage, hasDecrease, zeroObservation, hasReportedUsage } from "./invocation-usage";
import { normalizeCodexAggregate } from "./codex-usage";
import type { QuotaService } from "./quota";

const { events, tasks } = schema;
export const HOST_INPUT_TEXT_LIMIT = 256_000;
export const HOST_INPUT_REQUEST_LIMIT = 128;
export const HOST_INPUT_EVENT_WINDOW = 128;

/** Oversized or unmeasurable strings stay unknown; diagnostics never truncate the actual input. */
export function hostTextBytes(text: string | undefined): number | null {
  try { return typeof text === "string" && text.length <= HOST_INPUT_TEXT_LIMIT ? Buffer.byteLength(text, "utf8") : null; }
  catch { return null; }
}

const compare = (current: string | null, previous: string | null | undefined): HostInputComparison =>
  current === null || previous == null ? "unknown" : current === previous ? "same" : "changed";

export function bootstrapInputDiagnostics(output: string, embedded: string, eventId: string,
  previous?: { eventId: string; output: string }): HostInputComponents["projectBootstrap"] {
  const bytes = hostTextBytes(output);
  const previousBytes = hostTextBytes(previous?.output);
  return { eventId, previousEventId: previous?.eventId ?? null, returnedUtf8Bytes: bytes,
    embeddedJsonUtf8Bytes: hostTextBytes(embedded),
    comparison: bytes === null || previousBytes === null ? "unknown" : output === previous!.output ? "same" : "changed" };
}

/** Only this loop-local value holds fingerprints. It is never passed to an adapter or persisted. */
export interface ReviewInputBasis { sessionId: string; requests: string | null; diff: string | null }
export function reviewInputDiagnostics(sessionId: string, requests: string[], diff: string, previous?: ReviewInputBasis): {
  metadata: NonNullable<HostInputComponents["review"]>; basis: ReviewInputBasis;
} {
  let requestsBytes: number | null = null, requestsHash: string | null = null, diffHash: string | null = null;
  const diffBytes = hostTextBytes(diff);
  try {
    if (requests.length <= HOST_INPUT_REQUEST_LIMIT) {
      let units = 0, bytes = 0;
      const hash = createHash("sha256");
      for (const request of requests) {
        units += request.length;
        const size = hostTextBytes(request);
        if (units > HOST_INPUT_TEXT_LIMIT || size === null) throw new Error("Input diagnostics budget exceeded");
        bytes += size;
        // Length framing distinguishes request boundaries without serializing another prompt copy.
        hash.update(`${size}:`).update(request);
      }
      requestsHash = hash.digest("hex"); requestsBytes = bytes;
    }
  } catch { /* A request diagnostic failure must not discard an independently comparable diff. */
    requestsBytes = null; requestsHash = null;
  }
  try {
    if (diffBytes !== null) diffHash = createHash("sha256").update(diff).digest("hex");
  } catch { /* Diff observation failure must not discard request diagnostics or affect review. */
    diffHash = null;
  }
  const prior = previous?.sessionId === sessionId ? previous : undefined;
  return { metadata: { requestsCount: requests.length, requestsUtf8Bytes: requestsBytes, suppliedDiffUtf8Bytes: diffBytes,
    requestsComparison: compare(requestsHash, prior?.requests), suppliedDiffComparison: compare(diffHash, prior?.diff),
    diffCoverage: "supplied_bounded_text" }, basis: { sessionId, requests: requestsHash, diff: diffHash } };
}

function hostInputDiagnostics(input: AgentRunInput, components?: HostInputComponents): HostInputDiagnostics {
  const result: HostInputDiagnostics = { version: 1, coverage: "host_text_fields",
    limits: { textUtf16CodeUnits: HOST_INPUT_TEXT_LIMIT, requests: HOST_INPUT_REQUEST_LIMIT, lookbackEvents: HOST_INPUT_EVENT_WINDOW },
    promptUtf8Bytes: null, systemPromptCandidateUtf8Bytes: null, turnContextUtf8Bytes: null };
  const size = (value: number | null) => Number.isSafeInteger(value) && value! >= 0 && value! <= HOST_INPUT_TEXT_LIMIT * 3 ? value : null;
  const comparison = (value: HostInputComparison) => ["unknown", "same", "changed"].includes(value) ? value : "unknown";
  const eventId = (value: string | null) => typeof value === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value) ? value : null;
  try {
    result.promptUtf8Bytes = hostTextBytes(input.prompt);
    result.systemPromptCandidateUtf8Bytes = hostTextBytes(input.systemPrompt);
    result.turnContextUtf8Bytes = hostTextBytes(input.turnContext);
    // Explicit allowlist: never spread caller metadata, prompt text, hashes or credentials into events.
    if (components?.projectBootstrap) {
      const p = components.projectBootstrap;
      result.components = { projectBootstrap: { eventId: eventId(p.eventId), previousEventId: eventId(p.previousEventId),
        returnedUtf8Bytes: size(p.returnedUtf8Bytes), embeddedJsonUtf8Bytes: size(p.embeddedJsonUtf8Bytes), comparison: comparison(p.comparison) } };
    }
    if (components?.review) {
      const r = components.review;
      result.components = { ...result.components, review: { requestsCount: size(r.requestsCount), requestsUtf8Bytes: size(r.requestsUtf8Bytes),
        suppliedDiffUtf8Bytes: size(r.suppliedDiffUtf8Bytes), requestsComparison: comparison(r.requestsComparison),
        suppliedDiffComparison: comparison(r.suppliedDiffComparison), diffCoverage: "supplied_bounded_text" } };
    }
  } catch { /* Partial/unknown diagnostics are preferable to changing the invocation outcome. */ }
  return result;
}

export interface InvocationContext {
  taskId: string; sessionId: string | null; workflow: InvocationStart["workflow"]; provider: AgentKind;
  role: InvocationStart["role"]; purpose: InvocationStart["purpose"]; round?: number; operationId?: string;
  /** Read when the signal aborts: why the turn ended, if the caller knows. Not persisted on the start event. */
  endReason?: () => InvocationEndReason | null;
  inputDiagnostics?: HostInputComponents;
}
/** How far back a resumed call looks for a reading before giving up as missing. */
const BASELINE_SCAN = 50;
export interface InvocationDeps {
  db: Db;
  quota: QuotaService;
  append(taskId: string, sessionId: string | null, payload: TaskEventPayload): TaskEvent;
}
export type MeasuredRun = (adapter: AgentAdapter, input: AgentRunInput, context: InvocationContext) => AsyncIterable<AgentEvent>;

/** A lazy boundary: a record exists exactly when the provider iterable is actually consumed. */
export async function* measuredRun(deps: InvocationDeps, adapter: AgentAdapter, input: AgentRunInput, { endReason: readEndReason, inputDiagnostics, ...context }: InvocationContext): AsyncIterable<AgentEvent> {
  const start: InvocationStart = { ...context, round: context.round ?? null, operationId: context.operationId ?? null, callId: randomUUID(), requestedModel: input.model ?? adapter.defaultModel ?? null,
    effort: input.effort ?? null, producer: adapter.usageProducer ?? { source: "unavailable", version: null, runtimeVersion: null },
    startedAt: new Date().toISOString(), resumed: !!input.threadId, quotaBefore: deps.quota.cached(context.provider),
    hostInput: hostInputDiagnostics(input, inputDiagnostics) };
  deps.append(context.taskId, context.sessionId, { type: "invocation_started", ...start });
  const earlier = input.threadId ? deps.db.select().from(events).where(and(eq(events.taskId, context.taskId), eq(events.type, "invocation_finished"),
      sql`json_extract(${events.payload}, '$.threadId') = ${input.threadId}`,
      sql`json_extract(${events.payload}, '$.provider') = ${context.provider}`,
      sql`json_extract(${events.payload}, '$.sessionId') IS ${context.sessionId}`)).orderBy(desc(events.seq)).limit(BASELINE_SCAN).all()
    .map(row => ({ ...row.payload as InvocationFinal, eventId: row.id })) : [];
  let threadId = input.threadId ?? null;
  let observation: UsageObservation | null = null, previousObservation: UsageObservation | null = null;
  const resultIds = new Set<string>();
  let ambiguousResults = false;
  let codexSnapshots = 0;
  let reset = false, closed = false, done: Extract<AgentEvent, { type: "done" }> | undefined;
  let failure: InvocationFinal["failure"] = "consumer_exit";
  const finish = (status?: InvocationFinal["status"]) => {
    if (closed) return;
    closed = true;
    if (!deps.db.select({ id: tasks.id }).from(tasks).where(eq(tasks.id, context.taskId)).get()) return;
    const codex = observation?.source === "codex.turn.completed.usage";
    const search = observation && !codex && input.threadId && observation.scope === "session_cumulative" ? findBaseline(earlier, observation) : null;
    const usage = !observation ? unknownUsage(context.provider === "gemini")
      : codex ? normalizeCodexAggregate(observation, !!input.threadId, earlier[0] ?? null, codexSnapshots > 1)
      : search?.kind === "span" ? normalizeSpan(observation, search, start.callId, reset)
      : normalizeInvocation(observation, !!input.threadId, search ? search.baseline : earlier[0] ?? null, reset);
    if (ambiguousResults) {
      Object.assign(usage, unknownUsage(), { observation, availability: observation ? "recorded" : "unknown", uncertainty: "unproven_scope" });
      delete usage.interval;
    }
    usage.previousObservation = previousObservation;
    // The provider call is still cancelled after an ask; only the business reason says it was no failure.
    // An ask can also end consumption before its deferred abort lands: the reason holds either way.
    const reason = readEndReason?.() ?? null;
    const endReason = input.signal.aborted || (!done && reason === "planner_ask") ? reason : null;
    const terminal = status ?? (endReason === "planner_ask" ? "cancelled" : failure === "exception" ? "failure" : input.signal.aborted ? "cancelled" : done ? done.ok ? "success" : failure === "usage_limit" ? "usage_limit" : "failure" : "interrupted");
    deps.append(context.taskId, context.sessionId, { type: "invocation_finished", ...start, endedAt: new Date().toISOString(),
      status: terminal, failure: endReason === "planner_ask" ? null : input.signal.aborted ? "abort" : terminal === "success" ? null : failure, threadId, usage,
      quotaAfter: deps.quota.cached(context.provider), ...(endReason ? { endReason } : {}) });
  };
  // Auxiliary timeout wrappers can abandon a pending next(); close on abort without waiting for an SDK.
  const onAbort = () => finish("cancelled");
  input.signal.addEventListener("abort", onAbort, { once: true });
  if (input.signal.aborted) onAbort();
  try {
    for await (const event of adapter.run(input)) {
      if (event.type === "thread") threadId = event.threadId;
      if (event.type === "done") {
        done = event;
        failure = !event.ok && classifyAgentError(event.error ?? "").kind === "usage_limit" ? "usage_limit" : "provider";
        if (!closed && event.usage) {
          const next = event.usage.source === "codex.turn.completed.usage"
            ? { ...event.usage, localObservation: { callId: start.callId, sequence: ++codexSnapshots } } : event.usage;
          if (next.source === "codex.turn.completed.usage") {
            // No provider result ID exists. Preserve successive local observations; never add
            // snapshots or deduplicate distinct calls merely because their numeric values match.
            const failedZero = !event.ok && next.threadAggregate && TOKEN_FIELDS.every(f => next.threadAggregate!.counters[f] === 0);
            if (observation && failedZero) {
              // A synthetic failure must not erase earlier evidence; retain it for diagnostics.
              previousObservation = next;
            } else {
              if (observation) previousObservation = observation;
              observation = next;
            }
            yield event;
            continue;
          }
          const identity = next.resultId ? JSON.stringify([next.source, next.version, next.threadId, next.resultId]) : null;
          if (identity && resultIds.has(identity)) { yield event; continue; }
          if (identity) {
            if (resultIds.size === 128) {
              // Bounded deduplication cannot prove completeness after its identity budget is exceeded.
              ambiguousResults = true;
              resultIds.delete(resultIds.values().next().value!);
            }
            resultIds.add(identity);
          }
          if (next.threadId) threadId = next.threadId;
          // Cumulative repeated results replace, never add; zeroed startup/crash results cannot erase evidence.
          if (!event.ok && (zeroObservation(next) || (observation && !hasReportedUsage(next)))) {
            if (observation) previousObservation = next;
            else { observation = next; reset = true; }
          }
          else {
            if (observation && next.scope === "session_cumulative" && hasDecrease(observation, next)) reset = true;
            if (observation && observation.resultId !== next.resultId) previousObservation = observation;
            observation = next;
          }
        }
      }
      yield event;
    }
    failure = done ? failure : "consumer_exit";
  } catch (error) {
    if (!done || done.ok) failure = "exception";
    throw error;
  } finally {
    input.signal.removeEventListener("abort", onAbort);
    finish();
  }
}

export function recoverInvocations(deps: InvocationDeps): void {
  const unfinished = deps.db.select().from(events).where(and(eq(events.type, "invocation_started"), sql`NOT EXISTS (
    SELECT 1 FROM events AS final WHERE final.type = 'invocation_finished'
    AND json_extract(final.payload, '$.callId') = json_extract(${events.payload}, '$.callId'))`)).all();
  for (const row of unfinished) {
    const start = row.payload as InvocationStart;
    deps.append(row.taskId, row.sessionId, { type: "invocation_finished", ...start, endedAt: new Date().toISOString(),
      status: "interrupted", failure: "restart", threadId: null, usage: unknownUsage(start.provider === "gemini"), quotaAfter: deps.quota.cached(start.provider) });
  }
}

export function usagePage(db: Db, taskId: string, after = 0, limit = 20): TaskUsagePage {
  const rows = db.select().from(events).where(and(eq(events.taskId, taskId), eq(events.type, "invocation_finished"), gt(events.seq, after)))
    .orderBy(asc(events.seq)).limit(limit + 1).all();
  const calls: UsageCall[] = rows.slice(0, limit).map(row => {
    const payload = row.payload as InvocationFinal;
    const start = db.select({ id: events.id }).from(events).where(and(eq(events.type, "invocation_started"),
      sql`json_extract(${events.payload}, '$.callId') = ${payload.callId}`)).get();
    return { ...payload, eventId: row.id, seq: row.seq, startedEventId: start?.id ?? null };
  });
  return { calls, nextCursor: rows.length > limit ? calls.at(-1)!.seq : null };
}
export function usageSummary(db: Db, taskId: string): TaskUsageSummary {
  const rows = db.select({ type: events.type, payload: events.payload }).from(events)
    .where(and(eq(events.taskId, taskId), sql`${events.type} IN ('invocation_started', 'invocation_finished')`)).all();
  const finals = rows.filter(r => r.type === "invocation_finished").map(r => r.payload as InvocationFinal);
  const summary: TaskUsageSummary = { recorded: rows.length > 0, coverage: "instrumented_activity_only", calls: finals.length,
    activeCalls: rows.filter(r => r.type === "invocation_started").length - finals.length,
    incompleteCalls: finals.filter(r => r.status !== "success").length, unknownCalls: finals.filter(r => r.usage.availability === "unknown" || r.usage.counters.input === null || r.usage.counters.output === null).length,
    unavailableCalls: finals.filter(r => r.usage.availability === "unavailable").length, partial: false, counters: emptyCounters(),
    inputInclusiveCache: null, costUsd: null, costPrecision: "unknown",
    unattributed: { intervals: 0, counters: emptyCounters(), inputInclusiveCache: null, costUsd: null } };
  const knownSum = (values: (number | null)[]) => {
    const known = values.filter((v): v is number => v !== null);
    return known.length ? counter(known.reduce((a, b) => a + b, 0)) : null;
  };
  for (const f of TOKEN_FIELDS) summary.counters[f] = knownSum(finals.flatMap(r => r.usage.models.map(m => m.counters[f])));
  // Raw input is only displayed when its bucket semantics are uniform across contributors.
  const semantics = new Set(finals.filter(r => r.usage.models.some(m => m.counters.input !== null)).map(r => r.usage.observation?.inputSemantics));
  if (semantics.size > 1) summary.counters.input = null;
  summary.inputInclusiveCache = knownSum(finals.flatMap(r => r.usage.models.map(m => {
    if (r.usage.observation?.inputSemantics === "inclusive_cache_subset") return m.counters.input;
    if (r.usage.observation?.inputSemantics === "fresh_separate_cache_buckets") {
      const { input, cachedInput, cacheWriteInput } = m.counters;
      if (input !== null && cachedInput !== null && cacheWriteInput !== null) return counter(input + cachedInput + cacheWriteInput);
    }
    return null;
  })));
  const costs = finals.map(r => r.usage.costUsd).filter((v): v is number => v !== null);
  const cost = costs.reduce((a, b) => a + b, 0);
  summary.costUsd = costs.length && Number.isFinite(cost) && cost <= Number.MAX_SAFE_INTEGER ? cost : null;
  summary.costPrecision = summary.costUsd === null ? "unknown" : finals.some(r => r.usage.costPrecision === "estimated") ? "estimated" : "reported";
  summary.partial = summary.activeCalls > 0 || finals.some(r => r.status !== "success" || r.usage.partial);
  // Spans are disjoint from per-call deltas by construction; they are reported beside them, never inside.
  const intervals = finals.flatMap(r => r.usage.interval ? [r.usage.interval] : []);
  summary.unattributed.intervals = intervals.length;
  // An interval's own total is already null when any of its models lacks the field; only whole spans add up.
  for (const f of TOKEN_FIELDS) summary.unattributed.counters[f] = knownSum(intervals.map(i => i.counters[f]));
  const spanSemantics = finals.filter(r => r.usage.interval?.counters.input != null).map(r => r.usage.observation?.inputSemantics);
  if (new Set([...semantics, ...spanSemantics]).size > 1) summary.unattributed.counters.input = null;
  summary.unattributed.inputInclusiveCache = knownSum(intervals.map(i => i.inputInclusiveCache));
  const spanCosts = intervals.map(i => i.costUsd).filter((v): v is number => v !== null);
  const spanCost = spanCosts.reduce((a, b) => a + b, 0);
  summary.unattributed.costUsd = spanCosts.length && Number.isFinite(spanCost) && spanCost <= Number.MAX_SAFE_INTEGER ? spanCost : null;
  return summary;
}
