import { describe, expect, it } from "vitest";
import type { ProviderQuota, QuotaWindow } from "@agent-hub/shared";
import { classifyAgentError, limitResetsAt } from "../src/agents/errors";

const now = new Date(2026, 9, 15, 8).getTime();
const local = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute).toISOString();

describe("agent errors", () => {
  it.each([
    ["You've hit your usage limit. Upgrade to Pro ... or try again at 9:41 PM.", "usage_limit", local(15, 21, 41)],
    ["You've hit your session limit · resets 11:50am (Asia/Taipei)", "usage_limit", local(15, 11, 50)],
    ["429 Too Many Requests", "overloaded", null],
    ["Failed to authenticate: OAuth session expired and could not be refreshed", "auth", null],
    ["Unexpected failure", "other", null],
    ["quota exceeded; resets at 9", "usage_limit", local(15, 9)],
    ["daily limit; reset 7am", "usage_limit", local(16, 7)],
    ["weekly limit reached", "usage_limit", null],
    ["quota exceeded; resets 12am", "usage_limit", local(16, 0)],
    ["quota exceeded; resets 12pm", "usage_limit", local(15, 12)],
    ["quota exceeded; resets 25:99", "usage_limit", null],
    ["429: usage limit; please /login", "usage_limit", null],
  ])("classifies %s", (message, kind, resetsAt) => {
    expect(classifyAgentError(message, now)).toEqual({ kind, resetsAt });
  });

  it("uses the latest future exhausted window, then the parsed time, then null", () => {
    const window = (remainingPercent: number | null, resetsAt: string | null): QuotaWindow => ({ id: "test", bucket: "Test", durationMins: null, remainingPercent, resetsAt });
    const quota: ProviderQuota = { provider: "codex", status: "ok", updatedAt: null, stale: false, nextRefreshAt: local(15, 9), manualRefreshAt: local(15, 9), windows: [
      window(0, local(15, 9)), window(-1, local(16, 10)), window(10, local(17, 10)), window(null, local(18, 10)), window(0, local(14, 10)), window(0, null),
    ] };
    expect(limitResetsAt(quota, local(15, 12), now)).toBe(local(16, 10));
    expect(limitResetsAt({ ...quota, windows: quota.windows.slice(2) }, local(15, 12), now)).toBe(local(15, 12));
    expect(limitResetsAt(undefined, local(15, 12), now)).toBe(local(15, 12));
    expect(limitResetsAt(undefined, null, now)).toBeNull();
  });
});
