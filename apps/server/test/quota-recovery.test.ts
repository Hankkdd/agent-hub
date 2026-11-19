import { describe, expect, it } from "vitest";
import type { ProviderQuota } from "@agent-hub/shared";
import { quotaRecovered } from "../src/core/quota-recovery";

const now = Date.parse("2026-10-17T12:00:00Z");
const since = new Date(now - 1_000).toISOString();
const usable = (provider: "claude" | "codex" = "claude"): ProviderQuota => ({
  provider, status: "ok", stale: false, updatedAt: new Date(now).toISOString(),
  nextRefreshAt: new Date(now + 300_000).toISOString(), manualRefreshAt: new Date(now + 10_000).toISOString(),
  windows: [{ id: "main", bucket: "Main", durationMins: null, remainingPercent: 50, resetsAt: null }],
});

describe.each(["claude", "codex"] as const)("%s positive quota recovery", provider => {
  it("accepts only a usable sample strictly after this pause and at or before now", () => {
    expect(quotaRecovered(usable(provider), since, now)).toBe(true);
    expect(quotaRecovered(undefined, since, now)).toBe(false);
    expect(quotaRecovered(usable(provider), "invalid", now)).toBe(false);
    expect(quotaRecovered(usable(provider), new Date(now).toISOString(), now)).toBe(false);
    expect(quotaRecovered(usable(provider), new Date(now + 1).toISOString(), now)).toBe(false);
  });
  it.each([null, "", "invalid", new Date(now - 2_000).toISOString(), since, new Date(now + 1).toISOString()])("rejects timestamp %s", updatedAt => {
    expect(quotaRecovered({ ...usable(provider), updatedAt }, since, now)).toBe(false);
  });
  it.each(["unknown", "error", "unavailable", "missing_login"] as const)("rejects status %s", status => {
    expect(quotaRecovered({ ...usable(provider), status }, since, now)).toBe(false);
  });
  it("rejects stale and empty samples", () => {
    expect(quotaRecovered({ ...usable(provider), stale: true }, since, now)).toBe(false);
    expect(quotaRecovered({ ...usable(provider), windows: [] }, since, now)).toBe(false);
  });
  it.each([null, NaN, Infinity, -Infinity, -1, 0, 101])("rejects mixed windows containing %s even after a reset", remainingPercent => {
    const quota = usable(provider);
    quota.windows.push({ ...quota.windows[0]!, remainingPercent, resetsAt: new Date(now - 10_000).toISOString() });
    expect(quotaRecovered(quota, since, now)).toBe(false);
  });
  it("accepts every reported positive window within the normalized range", () => {
    const quota = usable(provider);
    quota.windows.push({ ...quota.windows[0]!, remainingPercent: 100 }, { ...quota.windows[0]!, remainingPercent: 0.01 });
    expect(quotaRecovered(quota, since, now)).toBe(true);
  });
});
