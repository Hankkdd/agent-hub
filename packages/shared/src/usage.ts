import type { AgentKind, EffortLevel, QuotaStatus, QuotaWindow, SessionRole, WorkflowId } from "./index";

export const TOKEN_FIELDS = ["input", "output", "cachedInput", "cacheWriteInput", "reasoningOutput"] as const;
export type TokenField = typeof TOKEN_FIELDS[number];
export type TokenCounters = Record<TokenField, number | null>;
export type UsageScope = "call" | "turn" | "session_cumulative" | "unknown";
export type UsagePrecision = "reported" | "derived" | "estimated" | "unknown";
export interface UsageModel {
  model: string | null;
  canonicalModel: string | null;
  provider: string | null;
  counters: TokenCounters;
}
export interface ThreadUsageAggregate {
  /** The producer did not report a model breakdown. Never fill this from requestedModel. */
  model: null;
  counters: TokenCounters;
}
export interface CodexUsageProvenance {
  threadMode: "start" | "resume" | "unknown";
  threadBinding: "matched" | "missing" | "conflict";
  /** Package metadata is a declaration, not a binary version measurement. */
  runtimeVerification: "unverified" | "verified";
}
export type CodexAccountingBlocker = "legacy_observation" | "producer_unverified" | "runtime_unverified" |
  "thread_unbound" | "counter_origin_unproven" | "counter_epoch_unproven" | "writers_untracked" |
  "incomplete_snapshot" | "zero_snapshot" | "multiple_snapshots" | "counter_decrease";
/** Only numeric allowlisted observations; never SDK envelopes. */
export interface UsageObservation {
  source: "claude.result.modelUsage" | "codex.turn.completed.usage" | "fake";
  version: string;
  runtimeVersion: string | null;
  scope: UsageScope;
  precision: UsagePrecision;
  coverage: "query_pipeline_excluding_helpers" | "producer_reported_unknown" | "fixture";
  inputSemantics: "fresh_separate_cache_buckets" | "inclusive_cache_subset" | "unknown";
  reasoningSemantics: "included_in_output_partial" | "unknown";
  threadId: string | null;
  resultId: string | null;
  models: UsageModel[];
  /** Absent on legacy events. A thread total is never a model subtotal or an additive call value. */
  threadAggregate?: ThreadUsageAggregate;
  codex?: CodexUsageProvenance;
  /** Hub-local identity; resultId remains reserved for the provider's own identifier. */
  localObservation?: { callId: string; sequence: number };
  truncated: boolean;
  costUsd: number | null;
  costPrecision: "estimated" | "reported" | "unknown";
  mainLoop: TokenCounters | null;
}
export interface InvocationQuota {
  status: QuotaStatus;
  sampledAt: string | null;
  stale: boolean;
  windows: QuotaWindow[];
}
export type InvocationPurpose = "workflow" | "pr_metadata" | "change_briefing" | "diff_explanation" | "handoff_summary";
export type HostInputComparison = "unknown" | "same" | "changed";
export interface HostInputComponents {
  projectBootstrap?: {
    eventId: string | null;
    previousEventId: string | null;
    returnedUtf8Bytes: number | null;
    embeddedJsonUtf8Bytes: number | null;
    /** Equality of the supplied result, not proof that the complete document is unchanged. */
    comparison: HostInputComparison;
  };
  review?: {
    requestsCount: number | null;
    requestsUtf8Bytes: number | null;
    suppliedDiffUtf8Bytes: number | null;
    requestsComparison: HostInputComparison;
    suppliedDiffComparison: HostInputComparison;
    diffCoverage: "supplied_bounded_text";
  };
}
/** Host string observations only; components overlap prompt and must not be added to it. */
export interface HostInputDiagnostics {
  version: 1;
  coverage: "host_text_fields";
  limits: { textUtf16CodeUnits: number; requests: number; lookbackEvents: number };
  promptUtf8Bytes: number | null;
  /** A Host candidate, including on Codex resume; never a claim about bytes transmitted. */
  systemPromptCandidateUtf8Bytes: number | null;
  turnContextUtf8Bytes: number | null;
  components?: HostInputComponents;
}
export interface InvocationStart {
  callId: string;
  taskId: string;
  sessionId: string | null;
  workflow: WorkflowId;
  provider: AgentKind;
  role: SessionRole | "auxiliary";
  purpose: InvocationPurpose;
  round: number | null;
  operationId: string | null;
  requestedModel: string | null;
  effort: EffortLevel | null;
  producer: { source: string; version: string | null; runtimeVersion: string | null };
  startedAt: string;
  resumed: boolean;
  quotaBefore: InvocationQuota;
  /** Absent on legacy events. Independent of provider usage and native session context. */
  hostInput?: HostInputDiagnostics;
}
export interface InvocationUsage {
  observation: UsageObservation | null;
  /** Preserves a useful observation when a later error carries synthetic zero counters. */
  previousObservation: UsageObservation | null;
  models: UsageModel[];
  counters: TokenCounters;
  /** Derived comparable input: includes cache exactly once, unlike raw provider input. */
  inputInclusiveCache: number | null;
  precision: UsagePrecision;
  costUsd: number | null;
  costPrecision: "estimated" | "reported" | "unknown";
  availability: "recorded" | "unknown" | "unavailable";
  partial: boolean;
  uncertainty: "none" | "missing_usage" | "unproven_scope" | "missing_baseline" | "counter_reset" | "incompatible_baseline" | "partial_fields" | "unattributed_interval";
  baselineEventId: string | null;
  /** Absent on legacy/model-based records. Diagnostics do not authorize measurement. */
  accountingBlockers?: CodexAccountingBlocker[];
  /** Absent on older events. Set when this call's reading closes a span that cannot be split per call. */
  interval?: UsageInterval;
}
/** A point a cumulative interval is measured from: a trusted reading, or the start of the thread. */
export interface UsageIntervalBound { eventId: string; callId: string; resultId: string | null; origin: "reading" | "thread_start" }
/**
 * Usage between two trusted cumulative readings of one thread, spanning calls whose own readings are
 * missing. It belongs to the span, never to the call whose event carries it. Consecutive intervals and
 * per-call deltas cover disjoint pairs of consecutive trusted readings, so nothing is counted twice.
 */
export interface UsageInterval {
  kind: "unattributed";
  threadId: string;
  /** The earlier bound; the later bound is the reading on the event that carries the interval. */
  from: UsageIntervalBound;
  toResultId: string | null;
  /** Every invocation the span covers, oldest first, ending with the carrying call. */
  callIds: string[];
  models: UsageModel[];
  /** Null where a field is unknown or not comparable; never estimated. */
  counters: TokenCounters;
  inputInclusiveCache: number | null;
  costUsd: number | null;
  costPrecision: "estimated" | "reported" | "unknown";
  precision: "derived";
  uncertainty: "none" | "partial_fields";
}
/** Why a turn ended early, independent of how the provider call itself terminated. */
export type InvocationEndReason = "planner_ask" | "user_stop" | "shutdown";
export interface InvocationFinal extends InvocationStart {
  endedAt: string;
  status: "success" | "failure" | "cancelled" | "usage_limit" | "interrupted";
  failure: "provider" | "exception" | "abort" | "consumer_exit" | "restart" | "usage_limit" | null;
  threadId: string | null;
  usage: InvocationUsage;
  quotaAfter: InvocationQuota;
  /** Absent on older events and on calls that ran to their own end. */
  endReason?: InvocationEndReason | null;
}
export interface UsageCall extends InvocationFinal { eventId: string; seq: number; startedEventId: string | null }
export interface TaskUsageSummary {
  recorded: boolean;
  coverage: "instrumented_activity_only";
  calls: number;
  activeCalls: number;
  incompleteCalls: number;
  unknownCalls: number;
  unavailableCalls: number;
  partial: boolean;
  /** Raw input semantics differ: compare inputInclusiveCache instead. */
  counters: TokenCounters;
  inputInclusiveCache: number | null;
  costUsd: number | null;
  costPrecision: "estimated" | "reported" | "unknown";
  /** Usage known only per span, never per call; kept apart from `counters`. Their sum is the measured total. */
  unattributed: { intervals: number; counters: TokenCounters; inputInclusiveCache: number | null; costUsd: number | null };
}
export interface TaskUsagePage { calls: UsageCall[]; nextCursor: number | null }
