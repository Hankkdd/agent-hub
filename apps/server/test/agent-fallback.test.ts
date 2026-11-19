import { expect, it, vi } from "vitest";
import type { ProviderQuota, QuotaResponse } from "@agent-hub/shared";
import { chooseAgent, exhausted, withAgentFallback } from "../src/core/agent-fallback";

const now = Date.parse("2030-01-01T00:00:00Z");
const reset = new Date(now + 60_000).toISOString();
const provider = (remainingPercent: number | null, resetsAt: string | null = reset) => ({ windows: [{ remainingPercent, resetsAt }] }) as ProviderQuota;
const quotas = (claude = provider(100), codex = provider(100)) => ({ claude, codex }) as QuotaResponse;
it("requires an empty window with a future reset and returns the latest reset", () => {
  expect(exhausted(undefined, now)).toBeNull();
  for (const quota of [provider(1), provider(null), provider(0, null), provider(0, "invalid"), provider(0, new Date(now).toISOString())]) expect(exhausted(quota, now)).toBeNull();
  expect(exhausted(provider(0), now)).toEqual({ resetsAt: reset });
  expect(exhausted(provider(-1), now)).toEqual({ resetsAt: reset });
  expect(exhausted({ windows: [...provider(0).windows, ...provider(0, new Date(now + 120_000).toISOString()).windows] } as ProviderQuota, now)).toEqual({ resetsAt: new Date(now + 120_000).toISOString() });
});
it("switches only when the primary is exhausted and the other configured agent is not", () => {
  expect(chooseAgent("claude", ["claude", "codex"], quotas(provider(0)), now)).toEqual({ agent: "codex", fallbackFrom: { agent: "claude", resetsAt: reset } });
  expect(chooseAgent("claude", ["claude", "codex"], quotas(provider(0), provider(0)), now)).toEqual({ agent: "claude" });
  expect(chooseAgent("claude", ["claude"], quotas(provider(0)), now)).toEqual({ agent: "claude" });
  expect(chooseAgent("claude", ["claude", "codex"], undefined, now)).toEqual({ agent: "claude" });
});
it("refreshes once after a usage failure and uses the fresh reset for the only retry", async () => {
  const fresh = new Date(Date.now() + 60_000).toISOString();
  const quota = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValue(quotas(provider(0, fresh)));
  const run = vi.fn().mockRejectedValueOnce(new Error("usage limit")).mockResolvedValue("ok");
  await expect(withAgentFallback("claude", ["claude", "codex"], { quota }, new AbortController().signal, run)).resolves.toEqual({ value: "ok", agent: "codex", fallbackFrom: { agent: "claude", resetsAt: fresh } });
  expect(quota.mock.calls).toEqual([[], [true]]);
  expect(run).toHaveBeenCalledTimes(2);
});
it.each(["ordinary error", "overloaded", "authentication failed", "usage limit timeout", "usage limit timed out"])("does not retry %s", async (message) => {
  const quota = vi.fn().mockResolvedValue(undefined);
  const run = vi.fn().mockRejectedValue(new Error(message));
  await expect(withAgentFallback("claude", ["claude", "codex"], { quota }, new AbortController().signal, run)).rejects.toThrow(message);
  expect(run).toHaveBeenCalledTimes(1); expect(quota).toHaveBeenCalledTimes(1);
});
it("never retries an abort or a quota failure after falling back", async () => {
  const ac = new AbortController();
  const run = vi.fn(async () => { ac.abort(); throw new Error("usage limit"); });
  await expect(withAgentFallback("claude", ["claude", "codex"], { quota: async () => undefined }, ac.signal, run)).rejects.toThrow("usage limit");
  expect(run).toHaveBeenCalledTimes(1);
  const failed = vi.fn().mockRejectedValue(new Error("usage limit"));
  const quota = vi.fn().mockResolvedValue(quotas(provider(0, new Date(Date.now() + 60_000).toISOString())));
  await expect(withAgentFallback("claude", ["claude", "codex"], { quota }, new AbortController().signal, failed)).rejects.toMatchObject({ limit: { agent: "codex" } });
  expect(failed).toHaveBeenCalledTimes(1); expect(quota.mock.calls).toEqual([[], [true]]);
});
