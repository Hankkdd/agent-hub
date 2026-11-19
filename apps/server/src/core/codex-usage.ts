import { TOKEN_FIELDS, type CodexAccountingBlocker, type InvocationFinal, type InvocationUsage, type UsageObservation } from "@agent-hub/shared";
import { counter, emptyCounters } from "../agents/usage";

/**
 * Independent of Claude's model/result-ID baseline contract. SDK 0.162.1 supplies a snapshot,
 * not proof of its origin, counter epoch or exclusive ownership of thread writes. No numeric
 * accounting is enabled here, even if a caller changes scope or supplies a verified binary version.
 */
export function normalizeCodexAggregate(o: UsageObservation, resumed: boolean,
  prior: InvocationFinal | null = null, multipleSnapshots = false): InvocationUsage {
  const blockers: CodexAccountingBlocker[] = [];
  const counters = o.threadAggregate?.counters;
  if (!counters || !o.codex) blockers.push("legacy_observation");
  if (o.version !== "0.162.1" || o.runtimeVersion !== "0.162.1") blockers.push("producer_unverified");
  if (o.codex?.runtimeVerification !== "verified") blockers.push("runtime_unverified");
  if (!o.threadId || o.codex?.threadBinding !== "matched" || o.codex.threadMode !== (resumed ? "resume" : "start")) blockers.push("thread_unbound");
  if (!counters || o.truncated || TOKEN_FIELDS.some(f => counter(counters[f]) === null)) blockers.push("incomplete_snapshot");
  if (counters && TOKEN_FIELDS.every(f => counters[f] === 0)) blockers.push("zero_snapshot");
  if (multipleSnapshots) blockers.push("multiple_snapshots");
  // A decrease is diagnostic only. Even nondecreasing endpoints cannot exclude a hidden reset.
  const before = prior?.usage.observation;
  if (before?.source === o.source && before.version === o.version && before.runtimeVersion === o.runtimeVersion &&
      before.threadId === o.threadId && !!o.threadId && before.threadAggregate && counters &&
      TOKEN_FIELDS.some(f => before.threadAggregate!.counters[f] !== null && counters[f] !== null && counters[f]! < before.threadAggregate!.counters[f]!)) {
    blockers.push("counter_decrease");
  }
  blockers.push(resumed ? "counter_epoch_unproven" : "counter_origin_unproven", "writers_untracked");
  return { observation: o, previousObservation: null, models: [], counters: emptyCounters(), inputInclusiveCache: null,
    precision: "unknown", costUsd: null, costPrecision: "unknown", availability: "recorded", partial: true,
    uncertainty: "unproven_scope", baselineEventId: null, accountingBlockers: blockers };
}
