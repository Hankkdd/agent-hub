import type { QuotaReading, QuotaWindow } from "@agent-hub/shared";

export function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function remaining(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(100, 100 - value)) : null;
}
function timestamp(value: unknown, seconds = false): string | null {
  const ms = seconds ? (typeof value === "number" && Number.isFinite(value) && value > 0 ? value * 1000 : NaN)
    : (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) ? Date.parse(value) : NaN);
  return Number.isFinite(ms) && Math.abs(ms) <= 8.64e15 ? new Date(ms).toISOString() : null;
}
function label(value: unknown, fallback: string): string {
  return typeof value === "string" && /^[\w .()-]{1,80}$/.test(value) ? value : fallback;
}
function reading(windows: QuotaWindow[]): QuotaReading {
  return { status: windows.some(w => w.remainingPercent !== null) ? "ok" : "unknown", windows };
}
export function normalizeClaude(value: unknown): QuotaReading {
  const source = object(value);
  if (source.rate_limits_available === false) return { status: "unavailable", windows: [] };
  const limits = object(source.rate_limits);
  const windows: QuotaWindow[] = [];
  for (const [key, duration, bucket] of [
    ["five_hour", 300, "Claude"], ["seven_day", 10080, "Claude"],
    ["seven_day_opus", 10080, "Opus"], ["seven_day_sonnet", 10080, "Sonnet"],
  ] as const) {
    if (!limits[key] || typeof limits[key] !== "object") continue;
    const window = object(limits[key]);
    windows.push({ id: key, bucket, durationMins: duration, remainingPercent: remaining(window.utilization), resetsAt: timestamp(window.resets_at) });
  }
  if (Array.isArray(limits.model_scoped)) for (const [i, raw] of limits.model_scoped.entries()) {
    const window = object(raw);
    const bucket = label(window.display_name, `Model ${i + 1}`);
    if (windows.some(w => w.bucket.toLowerCase() === bucket.toLowerCase() && w.durationMins === 10080)) continue;
    windows.push({ id: `model-${i}`, bucket, durationMins: 10080, remainingPercent: remaining(window.utilization), resetsAt: timestamp(window.resets_at) });
  }
  return reading(windows);
}
export function normalizeCodex(value: unknown): QuotaReading {
  const source = object(value);
  const buckets = new Map(Object.entries(object(source.rateLimitsByLimitId)));
  const legacy = object(source.rateLimits);
  if (Object.keys(legacy).length) {
    const id = typeof legacy.limitId === "string" ? legacy.limitId : "codex";
    // A map entry is authoritative; old single-bucket responses sometimes omit limitId.
    const duplicate = [...buckets.values()].some(v => {
      const bucket = object(v);
      return bucket.limitId === id || (typeof legacy.limitId !== "string" &&
        JSON.stringify(bucket.primary ?? null) === JSON.stringify(legacy.primary ?? null) &&
        JSON.stringify(bucket.secondary ?? null) === JSON.stringify(legacy.secondary ?? null));
    });
    if (!buckets.has(id) && !duplicate) buckets.set(id, legacy);
  }
  const windows: QuotaWindow[] = [];
  for (const [id, raw] of buckets) {
    const bucket = object(raw);
    for (const slot of ["primary", "secondary"]) {
      if (!bucket[slot] || typeof bucket[slot] !== "object") continue;
      const window = object(bucket[slot]);
      const duration = window.windowDurationMins;
      windows.push({ id: `${label(id, "bucket")}-${slot}`, bucket: label(bucket.limitName, label(id, "Codex")),
        durationMins: typeof duration === "number" && Number.isFinite(duration) && duration > 0 ? duration : null,
        remainingPercent: remaining(window.usedPercent), resetsAt: timestamp(window.resetsAt, true) });
    }
  }
  return reading(windows);
}
