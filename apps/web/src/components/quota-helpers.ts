import type { ProviderQuota, QuotaWindow } from "@agent-hub/shared";
import { t, type Language } from "@/i18n";

export function windowLabel(window: QuotaWindow): string {
  const mins = window.durationMins;
  if (mins === null) return t("quota.windowUnknown");
  if (mins % 1440 === 0) return t("quota.days", { n: mins / 1440 });
  if (mins % 60 === 0) return t("quota.hours", { n: mins / 60 });
  return t("quota.minutes", { n: mins });
}
export function awaiting(window: QuotaWindow, now: number): boolean {
  return window.resetsAt !== null && Date.parse(window.resetsAt) <= now;
}
export function quotaStale(provider: ProviderQuota, now: number): boolean {
  return provider.stale || (provider.updatedAt !== null && now >= Date.parse(provider.updatedAt) + 300_000) || provider.windows.some(w => awaiting(w, now));
}
export function percentage(window: QuotaWindow, now: number): string {
  if (awaiting(window, now)) return t("quota.awaiting");
  return window.remainingPercent === null ? t("quota.unknown") : t("quota.remaining", { n: Math.round(window.remainingPercent) });
}
export function localTime(value: string | null, language: Language): string {
  return value && Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat(language, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : t("quota.unknown");
}
/** `compact` keeps the two largest units, for the narrow sidebar. */
export function countdown(value: string | null, now: number, compact = false): string {
  if (!value || !Number.isFinite(Date.parse(value))) return t("quota.resetUnknown");
  const mins = Math.ceil((Date.parse(value) - now) / 60_000);
  if (mins <= 0) return t("quota.awaiting");
  const days = Math.floor(mins / 1440), hours = Math.floor((mins % 1440) / 60), minutes = mins % 60;
  const parts = [days && t("quota.days", { n: days }), hours && t("quota.hours", { n: hours }), minutes && t("quota.minutes", { n: minutes })].filter(Boolean);
  return t("quota.resetsIn", { time: (compact ? parts.slice(0, 2) : parts).join(" ") });
}
/** Share of the window still available, 0-100, or null when unknown or past its reset. */
export function remainingShare(window: QuotaWindow, now: number): number | null {
  if (awaiting(window, now) || window.remainingPercent === null) return null;
  return Math.min(100, Math.max(0, window.remainingPercent));
}
