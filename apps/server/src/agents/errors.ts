import type { ProviderQuota } from "@agent-hub/shared";

const USAGE_LIMIT = /\b(session|usage|weekly|daily|monthly) limit\b|\bhit your\b[^.\n]*\blimit\b|\busage limit\b|\bquota\b/i;
const OVERLOADED = /\boverloaded|\brate[- ]?limit(ed)?\b|too many requests|\b429\b|\b529\b|\b503\b|service unavailable/i;
const AUTH = /\bunauthorized\b|\b401\b|\b403\b|\bforbidden\b|invalid (api )?key|authentication failed|not authenticated|failed to authenticate|\boauth\b[^.\n]*\bexpired\b|\bsession expired\b|could not be refreshed|\brefresh token\b|\/login\b|please (re-?)?(log ?in|authenticate)/i;

type ErrorKind = "usage_limit" | "overloaded" | "auth" | "other";

export function classifyAgentError(message: string, now = Date.now()): { kind: ErrorKind; resetsAt: string | null } {
  const kind = USAGE_LIMIT.test(message) ? "usage_limit" : OVERLOADED.test(message) ? "overloaded" : AUTH.test(message) ? "auth" : "other";
  if (kind !== "usage_limit") return { kind, resetsAt: null };
  const match = /\b(?:resets?\s+(?:at\s+)?|try again at\s+)(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i.exec(message);
  if (!match) return { kind, resetsAt: null };
  let hour = Number(match[1]);
  const minute = Number(match[2] ?? 0);
  const period = match[3]?.toLowerCase();
  if (minute > 59 || hour > (period ? 12 : 23) || (period && hour < 1)) return { kind, resetsAt: null };
  if (period) hour = hour % 12 + (period === "pm" ? 12 : 0);
  const reset = new Date(now);
  reset.setHours(hour, minute, 0, 0);
  if (reset.getTime() <= now) reset.setDate(reset.getDate() + 1);
  return { kind, resetsAt: reset.toISOString() };
}

export function limitResetsAt(quota: ProviderQuota | undefined, parsed: string | null, now = Date.now()): string | null {
  const resets = quota?.windows.flatMap(window => {
    const reset = window.resetsAt === null ? NaN : Date.parse(window.resetsAt);
    return window.remainingPercent !== null && window.remainingPercent <= 0 && reset > now ? [reset] : [];
  }) ?? [];
  return resets.length ? new Date(Math.max(...resets)).toISOString() : parsed;
}
