import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ProviderQuota, QuotaResponse, QuotaWindow } from "@agent-hub/shared";
import { quotaScheduler, type QuotaState } from "./quota-scheduler";
import { awaiting, countdown, localTime, percentage, quotaStale, remainingShare, windowLabel } from "./quota-helpers";
import { setLanguage } from "@/i18n";

const start = Date.parse("2026-10-14T10:00:00Z");
const window: QuotaWindow = { id: "main", bucket: "Main", durationMins: 300, remainingPercent: 0, resetsAt: new Date(start + 600_000).toISOString() };
function response(next = start + 300_000): QuotaResponse {
  const provider: ProviderQuota = { provider: "claude", status: "ok", windows: [window], updatedAt: new Date(start).toISOString(), stale: false,
    nextRefreshAt: new Date(next).toISOString(), manualRefreshAt: new Date(start + 10_000).toISOString() };
  return { claude: provider, codex: { ...provider, provider: "codex" } };
}
class Visibility {
  visibilityState = "visible";
  listeners = new Set<() => void>();
  addEventListener(_type: string, listener: () => void) { this.listeners.add(listener); }
  removeEventListener(_type: string, listener: () => void) { this.listeners.delete(listener); }
  set(value: string) { this.visibilityState = value; this.listeners.forEach(fn => fn()); }
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(start); setLanguage("en"); });
afterEach(() => { vi.useRealTimers(); setLanguage("zh-TW"); });
it("queries on initialization, polls every five minutes, pauses hidden, and resumes only when due", async () => {
  const doc = new Visibility();
  const query = vi.fn(async () => response(Date.now() + 300_000));
  const controller = quotaScheduler(doc, query, () => {});
  await vi.advanceTimersByTimeAsync(0);
  expect(query).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(300_000);
  expect(query).toHaveBeenCalledTimes(2);
  doc.set("hidden");
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(600_000);
  expect(query).toHaveBeenCalledTimes(2);
  doc.set("visible");
  await vi.advanceTimersByTimeAsync(0);
  expect(query).toHaveBeenCalledTimes(3);
  doc.set("hidden"); doc.set("visible");
  await vi.advanceTimersByTimeAsync(0);
  expect(query).toHaveBeenCalledTimes(3);
  controller.dispose();
  expect(doc.listeners.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});
it("refreshes at the reset boundary, honors server backoff, and never infers full quota", async () => {
  const doc = new Visibility();
  let state!: QuotaState;
  const query = vi.fn(async () => {
    const result = response(Date.now() + 300_000);
    for (const p of Object.values(result)) p.windows = [{ ...window, resetsAt: new Date(start + 20_000).toISOString() }];
    if (Date.now() < start + 20_000) for (const p of Object.values(result)) p.nextRefreshAt = new Date(start + 20_000).toISOString();
    return result;
  });
  const controller = quotaScheduler(doc, query, s => { state = s; });
  await vi.advanceTimersByTimeAsync(20_000);
  expect(query).toHaveBeenCalledTimes(2);
  expect(percentage(state.data!.claude.windows[0]!, state.now)).toBe("Awaiting update");
  await vi.advanceTimersByTimeAsync(100_000);
  expect(query).toHaveBeenCalledTimes(2);
  controller.dispose();
});
it("manual refresh bypasses due time, coalesces active requests, and ignores late responses on cleanup", async () => {
  const doc = new Visibility();
  let resolve!: (data: QuotaResponse) => void;
  const query = vi.fn(() => new Promise<QuotaResponse>(r => { resolve = r; }));
  const update = vi.fn();
  const controller = quotaScheduler(doc, query, update);
  const initial = controller.refresh(true);
  expect(query).toHaveBeenCalledTimes(1);
  resolve(response()); await initial;
  const manual = controller.refresh(true);
  expect(query).toHaveBeenLastCalledWith(true);
  controller.dispose();
  const updates = update.mock.calls.length;
  resolve(response()); await manual;
  expect(update.mock.calls.length).toBe(updates);
  expect(vi.getTimerCount()).toBe(0);
});
it("bounds network retries with no successful reading and retains prior successful data on errors", async () => {
  const doc = new Visibility();
  const query = vi.fn(async () => { throw new Error("transport"); });
  const states: QuotaState[] = [];
  const controller = quotaScheduler(doc, query, s => states.push(s));
  await vi.advanceTimersByTimeAsync(59_999);
  expect(query).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(query).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(120_000);
  expect(query).toHaveBeenCalledTimes(3);
  query.mockImplementationOnce(async () => response() as never);
  await controller.refresh(true);
  await controller.refresh(true);
  expect(states.at(-1)).toMatchObject({ error: true, loading: false, data: response() });
  controller.dispose();
});
it("formats zero, unknown, actual durations, countdowns, local timezone, and expiry", () => {
  expect(percentage(window, start)).toBe("0% remaining");
  expect(percentage({ ...window, remainingPercent: null }, start)).toBe("Unknown");
  expect(windowLabel(window)).toBe("5h");
  expect(windowLabel({ ...window, durationMins: 10080 })).toBe("7d");
  expect(windowLabel({ ...window, durationMins: 15 })).toBe("15m");
  expect(windowLabel({ ...window, durationMins: null })).toBe("Unknown window");
  expect(countdown(window.resetsAt, start)).toBe("Resets in 10m");
  expect(countdown(null, start)).toBe("Reset unknown");
  expect(awaiting(window, start + 600_000)).toBe(true);
  expect(percentage(window, start + 600_000)).toBe("Awaiting update");
  expect(localTime(window.resetsAt, "en")).toBe(new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(window.resetsAt!)));
  expect(quotaStale(response().claude, start + 300_000)).toBe(true);
  setLanguage("zh-TW");
  expect(percentage(window, start)).toBe("剩餘 0%");
  expect(windowLabel(window)).toBe("5 小時");
});

it("compact countdowns keep the two largest units and bars clamp the remaining share", () => {
  setLanguage("en");
  const now = Date.parse("2026-01-01T00:00:00Z");
  const resetsAt = new Date(now + ((2 * 24 + 3) * 60 + 4) * 60_000).toISOString();
  expect(countdown(resetsAt, now)).toBe("Resets in 2d 3h 4m");
  expect(countdown(resetsAt, now, true)).toBe("Resets in 2d 3h");
  const window = { id: "w", bucket: "Claude", durationMins: 300, remainingPercent: 120, resetsAt };
  expect(remainingShare(window, now)).toBe(100);
  expect(remainingShare({ ...window, remainingPercent: null }, now)).toBeNull();
  expect(remainingShare(window, Date.parse(resetsAt))).toBeNull();
});
