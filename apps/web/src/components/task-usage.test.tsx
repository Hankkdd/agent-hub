import { afterEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { TaskUsageSummary, UsageCall, UsageInterval } from "@agent-hub/shared";
import { setLanguage, t } from "@/i18n";
import type { TranslationKey } from "@/i18n/en";
import { TaskUsage, UsageCollapsedSummary, UsageTable, UsageCallDetails, usageNumber } from "./task-usage";
vi.mock("@/i18n", async original => ({ ...await original<object>(), useLanguage: () => "en" }));
vi.mock("@/lib/client", () => ({ client: {}, useConnection: () => "live" }));
afterEach(() => setLanguage("zh-TW"));
const counters = { input: null, output: null, cachedInput: null, cacheWriteInput: null, reasoningOutput: null };
const summary: TaskUsageSummary = { recorded: false, coverage: "instrumented_activity_only", calls: 0, activeCalls: 0, incompleteCalls: 0,
  unknownCalls: 0, unavailableCalls: 0, partial: false, counters, inputInclusiveCache: null, costUsd: null, costPrecision: "unknown",
  unattributed: { intervals: 0, counters, inputInclusiveCache: null, costUsd: null } };

function collapsed(value?: TaskUsageSummary, error = false) {
  const html = renderToStaticMarkup(<details><UsageCollapsedSummary summary={value} error={error} /><div>Expanded content</div></details>);
  expect(html).not.toMatch(/<details[^>]*\bopen\b/);
  const row = html.match(/<summary\b[^>]*>([\s\S]*?)<\/summary>/)?.[1];
  expect(row).toBeDefined();
  expect(row).not.toContain("Expanded content");
  expect(row).not.toMatch(/<(button|a)\b/);
  return row!;
}
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");
/** Cell texts of the first table row whose text includes `label`; an unknown cell reads as its hover reason. */
function row(html: string, label: string) {
  const tr = html.match(/<tr\b[\s\S]*?<\/tr>/g)?.find(r => text(r).includes(label));
  expect(tr).toBeDefined();
  return [...tr!.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/g)].map(([, cell = ""]) => {
    const missing = cell.match(/aria-label="([^"]*)"/);
    return missing?.[1] ?? text(cell).trim();
  });
}
it.each(["en", "zh-TW"] as const)("puts known subtotals and unreported calls inside the collapsed summary in %s", language => {
  setLanguage(language);
  const row = collapsed({ ...summary, recorded: true, calls: 3, unknownCalls: 1, partial: true,
    inputInclusiveCache: 170, counters: { ...counters, input: 9999, output: 20, cachedInput: 30, cacheWriteInput: 40 } });
  expect(row).toContain(t("usage.calls", { calls: 3 }));
  expect(row).toContain(t("usage.unreportedCalls", { unknown: 1 }));
  for (const [key, value] of [["col.input", 170], ["output", 20], ["cachedInput", 30], ["cacheWriteInput", 40]] as const) {
    expect(row).toContain(`${t(`usage.${key}`)} ${value}`);
  }
  expect(row).not.toContain("9999");
  expect(row).not.toContain(t("usage.provenance"));
  expect(row).toContain("flex-wrap");
});
it.each(["en", "zh-TW"] as const)("says plainly when nothing was reported and keeps measured zero in the collapsed summary in %s", language => {
  setLanguage(language);
  const unknown = { ...summary, recorded: true, calls: 2, unknownCalls: 2, partial: true };
  const none = collapsed(unknown);
  expect(none).toContain(t("usage.calls", { calls: 2 }));
  expect(none).toContain(t("usage.noTokens"));
  expect(none).not.toContain(t("usage.unknown"));
  expect(none).not.toContain(t("usage.output"));
  expect(collapsed({ ...unknown, unavailableCalls: 2 })).toContain(t("usage.noTokensUnavailable"));
  const active = collapsed({ ...unknown, unavailableCalls: 2, activeCalls: 1 });
  expect(active).toContain(t("usage.noTokens"));
  expect(active).toContain(t("usage.activeCalls", { active: 1 }));
  const zero = collapsed({ ...summary, recorded: true, calls: 1, inputInclusiveCache: 0,
    counters: { input: 0, output: 0, cachedInput: 0, cacheWriteInput: 0, reasoningOutput: 0 } });
  for (const key of ["col.input", "output", "cachedInput", "cacheWriteInput"] as const) expect(zero).toContain(`${t(`usage.${key}`)} 0`);
  expect(zero).not.toContain(t("usage.noTokens"));
  expect(zero).not.toContain(t("usage.unreportedCalls", { unknown: 0 }));
});
it.each(["en", "zh-TW"] as const)("keeps collapsed loading, not-recorded and error states free of invented totals in %s", language => {
  setLanguage(language);
  const loading = collapsed();
  const legacy = collapsed(summary);
  const failed = collapsed(undefined, true);
  expect(loading).toContain(t("usage.loading"));
  expect(legacy).toContain(t("usage.notRecorded"));
  expect(failed).toContain(t("usage.loadError"));
  expect(failed).not.toContain(t("usage.loading"));
  for (const row of [loading, legacy, failed]) {
    expect(row).not.toContain(t("usage.col.input"));
    expect(row).not.toContain(t("usage.calls", { calls: 0 }));
  }
  const stale = collapsed({ ...summary, recorded: true, calls: 1, inputInclusiveCache: 7 }, true);
  expect(stale).toContain(t("usage.loadError"));
  expect(stale).toContain(`${t("usage.col.input")} 7`);
  const task = renderToStaticMarkup(<TaskUsage taskId="task" events={[]} onSource={() => {}} />);
  expect(task.match(/<summary\b[^>]*>([\s\S]*?)<\/summary>/)?.[1]).toContain(t("usage.loading"));
});
const quota = { status: "unknown", sampledAt: null, stale: true, windows: [] } as const;
const baseCall: UsageCall = { callId: "call", taskId: "task", sessionId: null, workflow: "plan", provider: "codex", role: "main", purpose: "workflow",
  requestedModel: "requested-alias", effort: "medium", round: null, operationId: null, producer: { source: "unavailable", version: null, runtimeVersion: null },
  startedAt: "2026-10-17T00:00:00Z", endedAt: "2026-10-17T00:00:29Z", status: "cancelled", endReason: "planner_ask", failure: null, resumed: false, threadId: null,
  quotaBefore: { ...quota, windows: [] }, quotaAfter: { ...quota, windows: [] }, eventId: "event", seq: 18, startedEventId: "start",
  usage: { observation: null, previousObservation: null, models: [], counters, inputInclusiveCache: null, precision: "unknown", costUsd: null,
    costPrecision: "unknown", availability: "recorded", partial: true, uncertainty: "missing_usage", baselineEventId: null } };
it.each(["en", "zh-TW"] as const)("drops columns nobody reported and says why in %s", language => {
  setLanguage(language);
  const html = renderToStaticMarkup(<UsageTable summary={{ ...summary, recorded: true, calls: 1, unknownCalls: 1, partial: true }} calls={[baseCall]} onSource={() => {}} />);
  for (const key of ["usage.col.input", "usage.output", "usage.col.cost", "usage.total"] as const) expect(html).not.toContain(t(key));
  expect(html).toContain(t("usage.noTokensNote"));
  expect(html).not.toContain(t("usage.partialNote"));
  const cells = row(html, "requested-alias");
  expect(cells.join(" ")).toContain(t("usage.uncertainty.missing_usage"));
  expect(cells.join(" ")).toContain(t("usage.endReason.planner_ask"));
  expect(cells[0]).toContain(t("usage.seconds", { seconds: 29 }));
  // Details stay closed until asked for.
  expect(html).not.toContain(t("usage.provenance"));
  expect(html).toContain(t("usage.details"));
});
it.each(["en", "zh-TW"] as const)("distinguishes legacy, zero, unknown and partial subtotals in the table in %s", language => {
  setLanguage(language);
  const legacy = renderToStaticMarkup(<UsageTable summary={summary} onSource={() => {}} />);
  expect(legacy).toContain(t("usage.notRecorded"));
  expect(legacy).not.toContain(t("usage.col.input"));
  const partial = renderToStaticMarkup(<UsageTable summary={{ ...summary, recorded: true, calls: 2, unknownCalls: 1, incompleteCalls: 1, partial: true,
    counters: { ...counters, output: 0, cachedInput: 0 }, inputInclusiveCache: 0 }} onSource={() => {}} />);
  for (const key of ["usage.partialNote", "usage.coverage"] as const) expect(partial).toContain(t(key));
  const heading = row(partial, t("usage.col.time"));
  const total = row(partial, t("usage.total"));
  expect(heading).toEqual([t("usage.col.time"), t("usage.col.call"), t("usage.col.model"), t("usage.col.status"), t("usage.col.input"), t("usage.output"), t("usage.cachedInput"), ""]);
  expect(total.slice(1)).toEqual(["0", "0", "0", ""]);
  expect(usageNumber(0)).toBe("0"); expect(usageNumber(null)).toBe(t("usage.unknown")); expect(usageNumber(null, true)).toBe(t("usage.unavailable"));
});
it.each(["en", "zh-TW"] as const)("shows unknown and unavailable cells as dashes with the reason on hover in %s", language => {
  setLanguage(language);
  const known = { ...baseCall, callId: "known", requestedModel: "known-model", usage: { ...baseCall.usage, counters: { ...counters, output: 12 }, uncertainty: "none" as const } };
  const missing = { ...baseCall, callId: "missing", requestedModel: "missing-model", usage: { ...baseCall.usage, availability: "unavailable" as const } };
  const html = renderToStaticMarkup(<UsageTable summary={{ ...summary, recorded: true, calls: 2, unknownCalls: 1, partial: true, counters: { ...counters, output: 12 } }}
    calls={[known, baseCall, missing]} onSource={() => {}} />);
  expect(row(html, "known-model")[4]).toBe("12");
  expect(row(html, "requested-alias")[4]).toBe(t("usage.unknown"));
  expect(row(html, "missing-model")[4]).toBe(t("usage.unavailable"));
  expect(row(html, "known-model").join(" ")).not.toContain(t("usage.uncertainty.none"));
});
it.each(["en", "zh-TW"] as const)("shows requested versus reported model, provenance, quota and source-event trace in %s", language => {
  setLanguage(language);
  const quota = { status: "unknown", sampledAt: null, stale: true, windows: [] } as const;
  const call: UsageCall = { callId: "call", taskId: "task", sessionId: null, workflow: "review", provider: "gemini", role: "auxiliary", purpose: "change_briefing",
    requestedModel: "requested-alias", effort: "low", round: null, operationId: null, producer: { source: "unavailable", version: null, runtimeVersion: null },
    startedAt: "2026-10-17T00:00:00Z", endedAt: "2026-10-17T00:00:01Z", status: "success", failure: null, resumed: false, threadId: null,
    quotaBefore: { ...quota, windows: [] }, quotaAfter: { ...quota, windows: [] }, eventId: "event", seq: 2, startedEventId: "start",
    usage: { observation: null, previousObservation: null, models: [], counters, inputInclusiveCache: null, precision: "unknown", costUsd: null,
      costPrecision: "unknown", availability: "unavailable", partial: true, uncertainty: "missing_usage", baselineEventId: null } };
  const html = renderToStaticMarkup(<UsageCallDetails call={call} onSource={() => {}} />);
  for (const key of ["usage.requested", "usage.reportedModel", "usage.unavailable", "usage.provenance", "usage.quotaReference", "usage.usd"] as const) expect(html).toContain(t(key));
  expect(html).toContain("requested-alias"); expect(html).toContain(t("usage.source", { seq: 2 }));
});
it.each(["en", "zh-TW"] as const)("shows a call's known model subtotal, marked, when another model left it unknown in %s", language => {
  setLanguage(language);
  const mixed = { ...baseCall, requestedModel: "mixed", usage: { ...baseCall.usage, uncertainty: "partial_fields" as const,
    observation: { inputSemantics: "fresh_separate_cache_buckets", models: [] } as unknown as UsageCall["usage"]["observation"],
    models: [{ model: "a", canonicalModel: null, provider: null, counters }, { model: "b", canonicalModel: null, provider: null,
      counters: { ...counters, input: 4, output: 774, cachedInput: 197865, cacheWriteInput: 41041 } }] } };
  const html = renderToStaticMarkup(<UsageTable summary={{ ...summary, recorded: true, calls: 1, unknownCalls: 1, partial: true,
    inputInclusiveCache: 238910, counters: { ...counters, input: 4, output: 774, cachedInput: 197865, cacheWriteInput: 41041 } }} calls={[mixed]} onSource={() => {}} />);
  const cells = row(html, "mixed");
  expect(cells.slice(4, 8)).toEqual([`${(238910).toLocaleString()} +`, "774 +", `${(197865).toLocaleString()} +`, `${(41041).toLocaleString()} +`]);
  expect(html).toContain(t("usage.partialCell"));
  // A call with no model numbers at all stays a dash.
  expect(row(renderToStaticMarkup(<UsageTable summary={{ ...summary, recorded: true, calls: 1, counters: { ...counters, output: 1 } }} calls={[baseCall]} onSource={() => {}} />), "requested-alias")[4])
    .toBe(t("usage.unknown"));
});
const withSpans: TaskUsageSummary = { ...summary, recorded: true, calls: 3, unknownCalls: 2, incompleteCalls: 1, partial: true,
  counters: { ...counters, output: 5517, cachedInput: 423824, cacheWriteInput: null }, inputInclusiveCache: null, costUsd: 1.73,
  unattributed: { intervals: 1, counters: { ...counters, output: 19669, cachedInput: 1881770, cacheWriteInput: 55826 }, inputInclusiveCache: 1937624, costUsd: 1.22 } };
it.each(["en", "zh-TW"] as const)("tells a collapsed reader that cross-call spans exist in %s", language => {
  setLanguage(language);
  const row = collapsed(withSpans);
  expect(row).toContain(t("usage.unattributedCompact", { intervals: 1 }));
  expect(row).toContain(t("usage.unreportedCalls", { unknown: 2 }));
  expect(row).toContain(`${t("usage.output")} ${(5517).toLocaleString()}`); // Per-call value, not silently merged with the span.
  expect(collapsed({ ...withSpans, unattributed: { ...withSpans.unattributed, intervals: 0 } })).not.toContain(t("usage.unattributedCompact", { intervals: 0 }));
});
it.each(["en", "zh-TW"] as const)("separates per-call, span and observed totals, keeping unknown sides unknown in %s", language => {
  setLanguage(language);
  const html = renderToStaticMarkup(<UsageTable summary={withSpans} onSource={() => {}} />);
  const columns = row(html, t("usage.col.time"));
  const perCall = row(html, t("usage.perCallTotal"));
  const span = row(html, t("usage.unattributed", { intervals: 1 }));
  const total = row(html, t("usage.observedTotal"));
  // The label cell spans the four descriptive columns, so value cells shift left by three.
  const value = (cells: string[], key: TranslationKey) => cells[columns.indexOf(t(key)) - 3];
  expect(value(perCall, "usage.output")).toBe((5517).toLocaleString());
  expect(value(span, "usage.output")).toBe((19669).toLocaleString());
  expect(value(total, "usage.output")).toBe((5517 + 19669).toLocaleString()); // Both sides known: added.
  expect(value(total, "usage.col.cost")).toBe((1.73 + 1.22).toLocaleString());
  // Per-call cache write and inclusive input are unknown, so their totals are unknown rather than the span alone.
  expect(value(total, "usage.cacheWriteInput")).toBe(t("usage.unknown"));
  expect(value(total, "usage.col.input")).toBe(t("usage.unknown"));
  const plain = renderToStaticMarkup(<UsageTable summary={{ ...withSpans, unattributed: { ...withSpans.unattributed, intervals: 0 } }} onSource={() => {}} />);
  expect(plain).not.toContain(t("usage.observedTotal"));
  expect(plain).not.toContain(t("usage.perCallTotal"));
  expect(plain).toContain(t("usage.total"));
});
it.each(["en", "zh-TW"] as const)("shows a span's cost and inclusive input in call details, unknown when missing, in %s", language => {
  setLanguage(language);
  const quota = { status: "unknown", sampledAt: null, stale: true, windows: [] } as const;
  const interval: UsageInterval = { kind: "unattributed", threadId: "t", from: { eventId: "start-event", callId: "a", resultId: "r1", origin: "reading" }, toResultId: "r3",
    callIds: ["b", "c"], models: [], counters: { ...counters, output: 19669 }, inputInclusiveCache: 1937624, costUsd: 1.22, costPrecision: "estimated",
    precision: "derived", uncertainty: "partial_fields" };
  const call: UsageCall = { callId: "c", taskId: "task", sessionId: null, workflow: "plan", provider: "claude", role: "main", purpose: "workflow",
    requestedModel: null, effort: null, round: null, operationId: null, producer: { source: "claude.result.modelUsage", version: "0.3.296", runtimeVersion: null },
    startedAt: "2026-10-17T00:00:00Z", endedAt: "2026-10-17T00:00:01Z", status: "success", failure: null, resumed: true, threadId: "t",
    quotaBefore: { ...quota, windows: [] }, quotaAfter: { ...quota, windows: [] }, eventId: "event", seq: 3, startedEventId: "start",
    usage: { observation: null, previousObservation: null, models: [], counters, inputInclusiveCache: null, precision: "unknown", costUsd: null,
      costPrecision: "unknown", availability: "recorded", partial: true, uncertainty: "unattributed_interval", baselineEventId: null, interval } };
  // Markup escapes the apostrophe in the English label.
  const heading = t("usage.interval", { calls: 2 }).replace(/'/g, "&#x27;");
  const html = renderToStaticMarkup(<UsageCallDetails call={call} onSource={() => {}} />);
  expect(html).toContain(heading);
  const span = html.slice(html.indexOf(heading));
  expect(span).toContain(`${t("usage.inclusive")}: ${(1937624).toLocaleString()}`);
  expect(span).toContain(`${t("usage.usd")}: ${(1.22).toLocaleString()} (${t("usage.estimated")})`);
  expect(html).toContain(t("usage.intervalStart"));
  const unknown = renderToStaticMarkup(<UsageCallDetails call={{ ...call, usage: { ...call.usage, interval: { ...interval, costUsd: null, costPrecision: "unknown", inputInclusiveCache: null } } }} onSource={() => {}} />);
  const unknownSpan = unknown.slice(unknown.indexOf(heading));
  expect(unknownSpan).toContain(`${t("usage.inclusive")}: ${t("usage.unknown")}`);
  expect(unknownSpan).toContain(`${t("usage.usd")}: ${t("usage.unknown")}`);
});

it.each(["en", "zh-TW"] as const)("shows Codex thread aggregate only as source observation and keeps legacy observations readable in %s", language => {
  setLanguage(language);
  const quota = { status: "unknown", sampledAt: null, stale: true, windows: [] } as const;
  const raw = { input: 100, output: 20, cachedInput: 30, cacheWriteInput: 10, reasoningOutput: 5 };
  const call: UsageCall = { callId: "codex-call", taskId: "task", sessionId: null, workflow: "chat", provider: "codex", role: "main", purpose: "workflow",
    requestedModel: "requested-alias", effort: null, round: null, operationId: null, producer: { source: "codex.turn.completed.usage", version: "0.162.1", runtimeVersion: "0.162.1" },
    startedAt: "2026-10-17T00:00:00Z", endedAt: "2026-10-17T00:00:01Z", status: "success", failure: null, resumed: false, threadId: "thread",
    quotaBefore: { ...quota, windows: [] }, quotaAfter: { ...quota, windows: [] }, eventId: "event", seq: 2, startedEventId: "start",
    usage: { observation: { source: "codex.turn.completed.usage", version: "0.162.1", runtimeVersion: "0.162.1", scope: "unknown", precision: "reported",
      coverage: "producer_reported_unknown", inputSemantics: "unknown", reasoningSemantics: "unknown", threadId: "thread", resultId: null,
      models: [], threadAggregate: { model: null, counters: raw }, codex: { threadMode: "start", threadBinding: "matched", runtimeVerification: "unverified" },
      truncated: false, costUsd: null, costPrecision: "unknown", mainLoop: null },
      previousObservation: null, models: [], counters, inputInclusiveCache: null, precision: "unknown", costUsd: null,
      costPrecision: "unknown", availability: "recorded", partial: true, uncertainty: "unproven_scope", baselineEventId: null } };
  const html = renderToStaticMarkup(<UsageCallDetails call={call} onSource={() => {}} />);
  const [accounting, provenance] = html.split("<details>");
  expect(accounting).toContain(`<dt class="text-muted-foreground">${t("usage.reportedModel")}</dt><dd>${t("usage.unknown")}</dd>`);
  expect(accounting).toContain(`<dt class="text-muted-foreground">${t("usage.output")}</dt><dd>${t("usage.unknown")}</dd>`);
  expect(accounting).not.toContain(`${t("usage.output")} 20`);
  expect(provenance).toContain(t("usage.threadAggregate"));
  expect(provenance).toContain(`${t("usage.output")} 20`);
  expect(provenance).toContain(t("usage.runtimeVerification.unverified"));
  const legacy = structuredClone(call);
  legacy.usage.observation!.models = [{ model: null, canonicalModel: null, provider: null, counters: raw }];
  delete legacy.usage.observation!.threadAggregate;
  delete legacy.usage.observation!.codex;
  const legacyHtml = renderToStaticMarkup(<UsageCallDetails call={legacy} onSource={() => {}} />);
  expect(legacyHtml).toContain(`${t("usage.output")} 20`);
  expect(legacyHtml).not.toContain(t("usage.threadAggregate"));
  expect(legacyHtml).not.toContain(t("usage.runtimeVerification.unverified"));
});

it("explains an unrecorded transcript-only task as making no model calls", () => {
  for (const language of ["en", "zh-TW"] as const) {
    setLanguage(language);
    const noModel = text(renderToStaticMarkup(<details><UsageCollapsedSummary summary={summary} noModel /></details>));
    expect(noModel).toContain(t("usage.noModelCalls")); expect(noModel).not.toContain(t("usage.notRecorded"));
    expect(text(renderToStaticMarkup(<UsageTable summary={summary} onSource={() => {}} noModel />))).toContain(t("usage.noModelCalls"));
    expect(text(renderToStaticMarkup(<details><UsageCollapsedSummary summary={summary} /></details>))).toContain(t("usage.notRecorded"));
  }
  setLanguage("zh-TW");
});
