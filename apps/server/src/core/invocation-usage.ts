import { TOKEN_FIELDS, type InvocationUsage, type UsageObservation, type InvocationFinal, type UsageInterval, type UsageIntervalBound } from "@agent-hub/shared";
import { counter, dollars, emptyCounters, sumCounters } from "../agents/usage";
import { normalizeCodexAggregate } from "./codex-usage";

export function unknownUsage(unavailable = false): InvocationUsage {
  return { observation: null, previousObservation: null, models: [], counters: emptyCounters(), inputInclusiveCache: null,
    precision: "unknown", costUsd: null, costPrecision: "unknown", availability: unavailable ? "unavailable" : "unknown",
    partial: true, uncertainty: "missing_usage", baselineEventId: null };
}
export function normalizeInvocation(observation: UsageObservation | null, resumed: boolean,
  baseline: (InvocationFinal & { eventId: string }) | null, reset = false): InvocationUsage {
  if (observation?.source === "codex.turn.completed.usage") return normalizeCodexAggregate(observation, resumed, baseline);
  const result = unknownUsage();
  result.observation = observation;
  if (!observation) return result;
  result.availability = "recorded";
  const o = observation;
  if (o.scope !== "session_cumulative" && o.scope !== "call" && o.scope !== "turn") {
    result.uncertainty = "unproven_scope";
    return result;
  }
  const cumulative = o.scope === "session_cumulative";
  const prior = baseline?.usage.observation;
  // A reading is judged by its own completeness, not by how its invocation ended.
  const compatible = prior && trustedReading(baseline!) && comparable(prior, o);
  if (cumulative && resumed && !compatible) {
    result.uncertainty = prior ? "incompatible_baseline" : "missing_baseline";
    return result;
  }
  if (reset) { result.uncertainty = "counter_reset"; return result; }
  if (cumulative && resumed) result.baselineEventId = baseline!.eventId;
  let decreased = false;
  result.models = o.models.map(m => {
    const b = prior?.models.find(b => b.model === m.model && b.canonicalModel === m.canonicalModel && b.provider === m.provider);
    const counters = emptyCounters();
    for (const field of TOKEN_FIELDS) {
      const value = m.counters[field];
      const before = cumulative && resumed ? b?.counters[field] ?? null : 0;
      if (value !== null && before !== null) {
        if (value < before) decreased = true;
        else counters[field] = counter(value - before);
      }
      // A resumed thinking counter can include an unknown portion from older CLI history.
      if (resumed && o.reasoningSemantics === "included_in_output_partial" && field === "reasoningOutput") counters[field] = null;
    }
    return { ...m, counters };
  });
  const missingModel = cumulative && resumed && prior!.models.some(p =>
    !o.models.some(m => m.model === p.model && m.canonicalModel === p.canonicalModel && m.provider === p.provider));
  // Known model subtotals remain available, but an incomplete model set cannot establish call totals.
  result.counters = missingModel || o.truncated ? emptyCounters() : sumCounters(result.models);
  result.precision = cumulative ? "derived" : o.precision;
  const beforeCost = cumulative && resumed ? prior!.costUsd : 0;
  if (o.costUsd !== null && beforeCost !== null && o.costUsd < beforeCost) decreased = true;
  if (o.costUsd !== null && beforeCost !== null && o.costUsd >= beforeCost) result.costUsd = dollars(o.costUsd - beforeCost);
  result.costPrecision = result.costUsd === null ? "unknown" : o.costPrecision;
  if (o.inputSemantics === "inclusive_cache_subset") result.inputInclusiveCache = result.counters.input;
  if (o.inputSemantics === "fresh_separate_cache_buckets") {
    const { input, cachedInput, cacheWriteInput } = result.counters;
    if (input !== null && cachedInput !== null && cacheWriteInput !== null) result.inputInclusiveCache = counter(input + cachedInput + cacheWriteInput);
  }
  // Missing reasoning details do not imply missing output, but still warrant a partial label.
  result.partial = o.truncated || TOKEN_FIELDS.some(f => result.counters[f] === null) ||
    o.coverage !== "fixture" || result.costUsd === null;
  result.uncertainty = decreased ? "counter_reset" : result.partial ? "partial_fields" : "none";
  return result;
}

/** Both readings come from the same producer, thread and field semantics, so their counters can be subtracted. */
function comparable(prior: UsageObservation, o: UsageObservation): boolean {
  return prior.threadId === o.threadId && !!o.threadId && prior.source === o.source && prior.version === o.version &&
    prior.runtimeVersion === o.runtimeVersion && o.version !== "unknown" && o.models.every(m => m.model !== null) && prior.scope === o.scope &&
    prior.coverage === o.coverage && prior.inputSemantics === o.inputSemantics && prior.reasoningSemantics === o.reasoningSemantics && !prior.truncated;
}

/**
 * A complete cumulative reading that later calls may be measured from. A cancelled call can carry one (its
 * result arrived before the abort); a zeroed crash result, an ambiguous or truncated one cannot.
 */
export function trustedReading(final: Pick<InvocationFinal, "usage">): boolean {
  const o = final.usage.observation;
  return !!o && final.usage.uncertainty !== "unproven_scope" && completeReading(o);
}
function completeReading(o: UsageObservation): boolean {
  return o.source !== "codex.turn.completed.usage" && o.scope === "session_cumulative" && !!o.threadId && !!o.resultId && o.version !== "unknown" && !o.truncated &&
    o.models.length > 0 && o.models.every(m => m.model !== null) && hasReportedUsage(o) && !zeroObservation(o);
}

type Row = InvocationFinal & { eventId: string };
export type BaselineSearch =
  /** The newest earlier call carries a reading: measure this call against it. */
  | { kind: "adjacent"; baseline: Row }
  /** Calls without readings sit between this reading and `from`: the difference belongs to all of them. */
  | { kind: "span"; from: UsageIntervalBound; prior: UsageObservation | null; between: string[] }
  /** Nothing can be measured from; `baseline` is the evidence that existed but could not be used, if any. */
  | { kind: "unusable"; baseline: Row | null };

/**
 * Walk a thread's earlier calls, newest first, to the nearest trusted reading. Calls without one are
 * passed over only when they are from the same producer and contributed no counters of their own, so the
 * span they end up in is never also counted per call. A thread's first call starts its counters at zero.
 */
export function findBaseline(newestFirst: Row[], o: UsageObservation): BaselineSearch {
  const between: string[] = [];
  let evidence: Row | null = null;
  for (const row of newestFirst) {
    if (trustedReading(row)) {
      if (!between.length) return { kind: "adjacent", baseline: row };
      return { kind: "span", from: { eventId: row.eventId, callId: row.callId, resultId: row.usage.observation!.resultId, origin: "reading" },
        prior: row.usage.observation, between: between.reverse() };
    }
    const r = row.usage.observation;
    const sameProducer = row.producer.source === o.source && row.producer.version === o.version && row.producer.runtimeVersion === o.runtimeVersion &&
      (!r || (r.source === o.source && r.version === o.version && r.runtimeVersion === o.runtimeVersion));
    // Any per-call value, cost included, means the span would count it again: stop rather than guess a partial difference.
    const counted = row.usage.models.some(m => TOKEN_FIELDS.some(f => m.counters[f] !== null)) || row.usage.costUsd !== null || !!row.usage.interval;
    if (!sameProducer || counted) return { kind: "unusable", baseline: row };
    if (r) evidence ??= row;
    between.push(row.callId);
    if (!row.resumed) return { kind: "span", from: { eventId: row.eventId, callId: row.callId, resultId: null, origin: "thread_start" }, prior: null, between: between.reverse() };
  }
  return { kind: "unusable", baseline: evidence };
}

/**
 * Usage for a call whose reading closes a span over calls that left no reading. The call itself stays
 * unknown; the difference goes to `interval` only when both ends are comparable and nothing decreased.
 */
export function normalizeSpan(o: UsageObservation, search: Extract<BaselineSearch, { kind: "span" }>, callId: string, reset: boolean): InvocationUsage {
  if (o.source === "codex.turn.completed.usage") return normalizeCodexAggregate(o, true);
  const result = unknownUsage();
  result.observation = o;
  result.availability = "recorded";
  const fromZero = search.prior === null;
  if (!completeReading(o)) { result.uncertainty = "missing_baseline"; return result; }
  if (reset) { result.uncertainty = "counter_reset"; return result; }
  const prior = search.prior;
  if (prior && (!comparable(prior, o) || prior.models.some(p => !o.models.some(m => m.model === p.model && m.canonicalModel === p.canonicalModel && m.provider === p.provider)))) {
    result.uncertainty = "incompatible_baseline";
    return result;
  }
  if (prior && hasDecrease(prior, o)) { result.uncertainty = "counter_reset"; return result; }
  const models = o.models.map(m => {
    const b = prior?.models.find(b => b.model === m.model && b.canonicalModel === m.canonicalModel && b.provider === m.provider);
    const counters = emptyCounters();
    for (const field of TOKEN_FIELDS) {
      const value = m.counters[field], before = fromZero ? 0 : b?.counters[field] ?? null;
      if (value !== null && before !== null) counters[field] = counter(value - before);
      if (o.reasoningSemantics === "included_in_output_partial" && field === "reasoningOutput") counters[field] = null;
    }
    return { ...m, counters };
  });
  const counters = sumCounters(models);
  const beforeCost = fromZero ? 0 : prior!.costUsd;
  const costUsd = o.costUsd !== null && beforeCost !== null ? dollars(o.costUsd - beforeCost) : null;
  let inputInclusiveCache: number | null = null;
  if (o.inputSemantics === "inclusive_cache_subset") inputInclusiveCache = counters.input;
  if (o.inputSemantics === "fresh_separate_cache_buckets" && counters.input !== null && counters.cachedInput !== null && counters.cacheWriteInput !== null)
    inputInclusiveCache = counter(counters.input + counters.cachedInput + counters.cacheWriteInput);
  const partial = TOKEN_FIELDS.some(f => counters[f] === null) || o.coverage !== "fixture" || costUsd === null;
  const interval: UsageInterval = { kind: "unattributed", threadId: o.threadId!, from: search.from, toResultId: o.resultId,
    callIds: [...search.between, callId], models, counters, inputInclusiveCache, costUsd,
    costPrecision: costUsd === null ? "unknown" : o.costPrecision, precision: "derived", uncertainty: partial ? "partial_fields" : "none" };
  return { ...result, uncertainty: "unattributed_interval", interval };
}

export function hasDecrease(previous: UsageObservation, next: UsageObservation): boolean {
  return (previous.costUsd !== null && next.costUsd !== null && next.costUsd < previous.costUsd) || previous.models.some(p => {
    const n = next.models.find(n => n.model === p.model && n.canonicalModel === p.canonicalModel && n.provider === p.provider);
    return n && TOKEN_FIELDS.some(f => p.counters[f] !== null && n.counters[f] !== null && n.counters[f]! < p.counters[f]!);
  });
}
export function zeroObservation(o: UsageObservation): boolean {
  const values = o.models.flatMap(m => TOKEN_FIELDS.map(f => m.counters[f])).filter(v => v !== null);
  return (values.length > 0 || o.costUsd === 0) && values.every(v => v === 0) && (o.costUsd === null || o.costUsd === 0);
}

export function hasReportedUsage(o: UsageObservation): boolean {
  return o.costUsd !== null || o.models.some(m => TOKEN_FIELDS.some(f => m.counters[f] !== null));
}
