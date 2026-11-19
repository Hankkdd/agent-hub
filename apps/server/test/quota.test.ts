import { afterEach, describe, expect, it, vi } from "vitest";
import type { QuotaReading, QuotaResponse } from "@agent-hub/shared";
import { normalizeClaude, normalizeCodex, remaining } from "../src/agents/quota-normalize";
import { FakeAdapter } from "../src/agents/fake";
import { QuotaService } from "../src/core/quota";
import { createApp } from "../src/app";
import { Hub } from "../src/core/hub";
import { openDb } from "../src/db";

const start = Date.parse("2026-10-14T10:00:00Z");
const reading = (reset = start + 600_000): QuotaReading => ({ status: "ok", windows: [
  { id: "five", bucket: "Main", durationMins: 300, remainingPercent: 25, resetsAt: new Date(reset).toISOString() },
] });
afterEach(() => vi.useRealTimers());

describe("provider normalization", () => {
  it("preserves zero, bounds percentages, and rejects missing or nonfinite utilization", () => {
    expect([0, 100, 120, -10, null, undefined, "20", NaN, Infinity].map(remaining)).toEqual([100, 0, 0, 100, null, null, null, null, null]);
    const result = normalizeClaude({ rate_limits: { five_hour: { utilization: 100, resets_at: "2026-10-14T12:00:00+02:00" }, seven_day: { utilization: null, resets_at: "invalid" } } });
    expect(result.windows[0]).toMatchObject({ remainingPercent: 0, durationMins: 300, resetsAt: "2026-10-14T10:00:00.000Z" });
    expect(result.windows[1]).toMatchObject({ remainingPercent: null, resetsAt: null });
    expect(normalizeClaude({ rate_limits_available: false })).toEqual({ status: "unavailable", windows: [] });
    expect(normalizeClaude({})).toEqual({ status: "unknown", windows: [] });
  });
  it("uses actual Codex durations and seconds, handles null slots, and deduplicates the legacy bucket", () => {
    const bucket = { limitId: "codex", primary: { usedPercent: 0, windowDurationMins: 15, resetsAt: start / 1000 }, secondary: null };
    const result = normalizeCodex({ rateLimits: bucket, rateLimitsByLimitId: { codex: bucket, reviews: { limitName: "Reviews", primary: null, secondary: { usedPercent: 100, windowDurationMins: 120, resetsAt: null } } } });
    expect(result.windows).toHaveLength(2);
    expect(result.windows[0]).toMatchObject({ remainingPercent: 100, durationMins: 15, resetsAt: new Date(start).toISOString() });
    expect(result.windows[1]).toMatchObject({ bucket: "Reviews", durationMins: 120, remainingPercent: 0, resetsAt: null });
    expect(normalizeCodex({ rateLimits: { primary: {}, secondary: null } }).windows[0]).toMatchObject({ remainingPercent: null, durationMins: null, resetsAt: null });
    expect(normalizeCodex({ rateLimits: null }).status).toBe("unknown");
    expect(normalizeCodex({ rateLimits: { primary: bucket.primary }, rateLimitsByLimitId: { custom: bucket } }).windows).toHaveLength(1);
  });
  it("keeps independent Claude buckets without duplicating compatible model entries", () => {
    const result = normalizeClaude({ rate_limits: { seven_day_opus: { utilization: 30 }, model_scoped: [{ display_name: "Opus", utilization: 30 }, { display_name: "Other", utilization: 50 }] } });
    expect(result.windows.map(w => w.bucket)).toEqual(["Opus", "Other"]);
  });
});

describe("shared live quota cache", () => {
  it("coalesces ordinary and manual concurrent queries across clients, with a manual cooldown", async () => {
    let now = start;
    let release!: (value: QuotaReading) => void;
    const agent = new FakeAdapter();
    agent.quotaScript = () => new Promise(r => { release = r; });
    const service = new QuotaService({ claude: agent }, () => now);
    const reads = [service.read(), service.read(), service.read(true), service.read(true)];
    expect(agent.quotaCalls).toBe(1);
    release(reading());
    expect((await Promise.all(reads))[0]!.claude.updatedAt).toBe(new Date(start).toISOString());
    await service.read(true);
    expect(agent.quotaCalls).toBe(1);
    now += 10_001;
    const manual = [service.read(true), service.read(true)];
    expect(agent.quotaCalls).toBe(2);
    release(reading());
    await Promise.all(manual);
    await service.read();
    expect(agent.quotaCalls).toBe(2);
    expect(agent.runs).toHaveLength(0);
  });
  it("retains successful data on independent failures, sanitizes errors, and backs off", async () => {
    let now = start;
    const claude = new FakeAdapter(), codex = new FakeAdapter();
    claude.quotaScript = async () => reading();
    codex.quotaScript = async () => { throw new Error("secret-token"); };
    const service = new QuotaService({ claude, codex }, () => now);
    let result = await service.read();
    expect(result.claude.status).toBe("ok");
    expect(result.codex.status).toBe("error");
    expect(JSON.stringify(result)).not.toContain("secret-token");
    for (let i = 0; i < 100; i++) await service.read();
    expect(codex.quotaCalls).toBe(1);
    now += 60_000;
    await service.read();
    expect(codex.quotaCalls).toBe(2);
    claude.quotaScript = async () => ({ status: "error", windows: [] });
    now = start + 300_000;
    result = await service.read();
    expect(result.claude).toMatchObject({ status: "error", stale: true, updatedAt: new Date(start).toISOString(), windows: reading().windows });
  });
  it("expires at reset without restoring quota or looping on repeated past resets", async () => {
    let now = start;
    const agent = new FakeAdapter();
    agent.quotaScript = async () => reading(start + 20_000);
    const service = new QuotaService({ claude: agent }, () => now);
    const first = await service.read();
    expect(first.claude.stale).toBe(false);
    expect(first.claude.nextRefreshAt).toBe(new Date(start + 20_000).toISOString());
    now += 20_000;
    const reset = await service.read();
    expect(reset.claude).toMatchObject({ stale: true, windows: reading(start + 20_000).windows });
    for (let i = 0; i < 50; i++) await service.read();
    expect(agent.quotaCalls).toBe(2);
    now += 300_000;
    agent.quotaScript = async () => ({ status: "error", windows: [] });
    await service.read();
    now += 1_000;
    await service.read();
    expect(agent.quotaCalls).toBe(3);
  });
  it("expires after five minutes and unknown readings stay unknown", async () => {
    let now = start;
    const agent = new FakeAdapter();
    const service = new QuotaService({ claude: agent }, () => now);
    expect((await service.read()).claude).toMatchObject({ status: "unknown", windows: [], stale: false });
    now += 299_999;
    await service.read();
    expect(agent.quotaCalls).toBe(1);
    now++;
    await service.read();
    expect(agent.quotaCalls).toBe(2);
  });
  it("aborts quota queries during server shutdown and does not restart them", async () => {
    const agent = new FakeAdapter();
    agent.quotaScript = signal => new Promise(resolve => signal.addEventListener("abort", () => resolve({ status: "error", windows: [] })));
    const service = new QuotaService({ claude: agent });
    const result = service.read();
    await service.shutdown();
    await result;
    await service.read(true);
    expect(agent.quotaCalls).toBe(1);
  });
});

it("authenticates both quota endpoints without adding task events", async () => {
  const db = openDb(":memory:");
  const agent = new FakeAdapter();
  agent.quotaScript = async () => reading();
  const hub = new Hub({ db, dataDir: "/tmp/quota-api-test", agents: { claude: agent }, maxConcurrent: 1 });
  const app = createApp(hub, "test-token");
  for (const [url, method] of [["/api/quota", "GET"], ["/api/quota/refresh", "POST"]]) {
    expect((await app.request(url!, { method })).status).toBe(401);
    const response = await app.request(url!, { method, headers: { Authorization: "Bearer test-token" } });
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(((await response.json()) as QuotaResponse).claude.status).toBe("ok");
  }
  expect(agent.quotaCalls).toBe(1);
  expect(hub.listTasks()).toEqual([]);
  await hub.shutdown();
});

it("usage instrumentation reads only bounded cached snapshots and preserves freshness/reset references", async () => {
  let now = start;
  const agent = new FakeAdapter();
  agent.quotaScript = async () => reading();
  const service = new QuotaService({ claude: agent }, () => now);
  expect(service.cached("claude")).toEqual({ status: "unknown", sampledAt: null, stale: true, windows: [] });
  expect(agent.quotaCalls).toBe(0);
  await service.read();
  const calls = agent.quotaCalls;
  const before = service.cached("claude");
  expect(before).toMatchObject({ status: "ok", stale: false, sampledAt: new Date(start).toISOString(), windows: [{ remainingPercent: 25, resetsAt: new Date(start + 600_000).toISOString() }] });
  now += 600_000;
  const after = service.cached("claude");
  expect(after.stale).toBe(true); expect(after.sampledAt).toBe(before.sampledAt);
  expect(agent.quotaCalls).toBe(calls);
  after.windows[0]!.remainingPercent = 0;
  expect(service.cached("claude").windows[0]!.remainingPercent).toBe(25);
  await service.shutdown();
});
