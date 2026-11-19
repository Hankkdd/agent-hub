import type { ProviderQuota } from "@agent-hub/shared";

/** Only a complete, usable observation made after this pause can disprove its limit. */
export function quotaRecovered(quota: ProviderQuota | undefined, since: string, now: number): boolean {
  if (!quota || quota.status !== "ok" || quota.stale !== false || !quota.updatedAt) return false;
  const sampled = Date.parse(quota.updatedAt);
  const paused = Date.parse(since);
  return Number.isFinite(sampled) && Number.isFinite(paused) && sampled > paused && sampled <= now &&
    quota.windows.length > 0 && quota.windows.every(w => typeof w.remainingPercent === "number" &&
      Number.isFinite(w.remainingPercent) && w.remainingPercent > 0 && w.remainingPercent <= 100);
}
