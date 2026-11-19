import { Fragment, useEffect, useState, type ReactNode } from "react";
import { TOKEN_FIELDS, type TaskEvent, type TaskUsagePage, type TaskUsageSummary, type TokenCounters, type UsageCall } from "@agent-hub/shared";
import { client, useConnection } from "@/lib/client";
import { getLanguage, t, useLanguage } from "@/i18n";
import { Button } from "./ui/button";

export function usageNumber(value: number | null, unavailable = false): string {
  return value === null ? t(unavailable ? "usage.unavailable" : "usage.unknown") : value.toLocaleString();
}
/** Spans only add to per-call values when both sides are known; otherwise the total stays unknown, never zero-filled. */
const plus = (a: number | null, b: number | null) => a === null || b === null ? null : a + b;
const spans = (summary: TaskUsageSummary) => summary.unattributed?.intervals ?? 0;

/** The columns a reader compares across calls. Raw input and reasoning have provider-specific meaning, so they stay in the details. */
const COLUMNS = ["inputInclusiveCache", "output", "cachedInput", "cacheWriteInput", "costUsd"] as const;
type Column = typeof COLUMNS[number];
type Values = { counters: TokenCounters; inputInclusiveCache: number | null; costUsd: number | null };
const columnValue = (v: Values, c: Column) => c === "inputInclusiveCache" || c === "costUsd" ? v[c] : v.counters[c];
const columnLabel = (c: Column) => t(c === "inputInclusiveCache" ? "usage.col.input" : c === "costUsd" ? "usage.col.cost" : `usage.${c}`);
const columnTitle = (c: Column) => t(c === "inputInclusiveCache" ? "usage.inclusive" : c === "costUsd" ? "usage.usd" : `usage.${c}`);

/** A missing number is a dash with the reason on hover, so a row of unknowns does not read as a wall of words. */
function Cell({ value, unavailable = false, partial = false }: { value: number | null; unavailable?: boolean; partial?: boolean }) {
  if (value === null) return <span className="text-muted-foreground" title={usageNumber(null, unavailable)} aria-label={usageNumber(null, unavailable)}>—</span>;
  return partial
    ? <span title={t("usage.partialCell")}>{value.toLocaleString()}<span className="text-muted-foreground">+</span></span>
    : <>{value.toLocaleString()}</>;
}
const knownSum = (values: (number | null)[]) => {
  const known = values.filter((v): v is number => v !== null);
  return known.length ? known.reduce((a, b) => a + b, 0) : null;
};
/**
 * A call's own value is null when any of its models lacks the field, yet the task total still counts the models that
 * did report (see usageSummary on the server). Showing that known part, marked, keeps the rows adding up to the total.
 */
function callValue(call: UsageCall, c: Column): { value: number | null; partial: boolean } {
  const exact = columnValue(call.usage, c);
  if (exact !== null || c === "costUsd") return { value: exact, partial: false };
  const semantics = call.usage.observation?.inputSemantics;
  const value = knownSum(call.usage.models.map(({ counters: m }) => {
    if (c !== "inputInclusiveCache") return m[c];
    if (semantics === "inclusive_cache_subset") return m.input;
    if (semantics === "fresh_separate_cache_buckets" && m.input !== null && m.cachedInput !== null && m.cacheWriteInput !== null) return m.input + m.cachedInput + m.cacheWriteInput;
    return null;
  }));
  return { value, partial: value !== null };
}
function allUnavailable(summary: TaskUsageSummary) {
  return summary.calls > 0 && summary.unavailableCalls === summary.calls && summary.activeCalls === 0;
}

/** Transcript-only video tasks never call a model, so "not recorded" would read as a gap. */
const notRecordedKey = (noModel?: boolean) => noModel ? "usage.noModelCalls" as const : "usage.notRecorded" as const;

export function UsageCollapsedSummary({ summary, error = false, noModel }: { summary?: TaskUsageSummary; error?: boolean; noModel?: boolean }) {
  const known = summary?.recorded ? COLUMNS.filter(c => c !== "costUsd" && columnValue(summary, c) !== null) : [];
  return <summary className="cursor-pointer break-words">
    <span className="inline-flex max-w-full flex-wrap items-baseline gap-x-3 gap-y-1 align-top">
      <span className="font-medium">{t("usage.title")}</span>
      {summary ? summary.recorded ? <>
        <span>{t("usage.calls", { calls: summary.calls })}</span>
        {summary.activeCalls > 0 && <span>{t("usage.activeCalls", { active: summary.activeCalls })}</span>}
        {known.length === 0
          ? <span className="text-muted-foreground">{t(allUnavailable(summary) ? "usage.noTokensUnavailable" : "usage.noTokens")}</span>
          : <>
            {known.map(c => <span key={c} title={columnTitle(c)}>{columnLabel(c)} {columnValue(summary, c)!.toLocaleString()}</span>)}
            {summary.unknownCalls > 0 && <span className="text-muted-foreground">{t("usage.unreportedCalls", { unknown: summary.unknownCalls })}</span>}
          </>}
        {spans(summary) > 0 && <span>{t("usage.unattributedCompact", { intervals: spans(summary) })}</span>}
      </> : <span>{t(notRecordedKey(noModel))}</span> : !error && <span>{t("usage.loading")}</span>}
      {error && <span>{t("usage.loadError")}</span>}
    </span>
  </summary>;
}

function clock(iso: string) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleTimeString(getLanguage(), { hour12: false });
}
function duration(from: string, to: string) {
  const ms = new Date(to).getTime() - new Date(from).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? t("usage.seconds", { seconds }) : t("usage.minutes", { minutes: Math.floor(seconds / 60), seconds: seconds % 60 });
}
function modelOf(call: UsageCall) {
  const reported = call.usage.observation?.models.map(m => m.model).filter((m): m is string => !!m) ?? [];
  if (reported.length) return <>{reported.join(", ")}</>;
  return call.requestedModel ? <span className="text-muted-foreground" title={t("usage.requested")}>{call.requestedModel}</span> : <>—</>;
}

function CallRow({ call, columns, onSource }: { call: UsageCall; columns: readonly Column[]; onSource: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const took = duration(call.startedAt, call.endedAt);
  const unavailable = call.usage.availability === "unavailable";
  return <>
    <tr className="border-t align-top">
      <td className="py-1 pr-3 whitespace-nowrap" title={`${call.startedAt} → ${call.endedAt}`}>
        {clock(call.startedAt)}{took && <span className="block text-muted-foreground">{took}</span>}
      </td>
      <td className="py-1 pr-3">
        {call.provider} · {t(`usage.role.${call.role}`)}
        <span className="block text-muted-foreground">{t(`usage.purpose.${call.purpose}`)}{call.round !== null && ` · ${t("usage.round", { round: call.round })}`}</span>
      </td>
      <td className="py-1 pr-3">{modelOf(call)}</td>
      <td className="py-1 pr-3">
        {t(`usage.status.${call.status}`)}{call.endReason && ` · ${t(`usage.endReason.${call.endReason}`)}`}
        {call.usage.uncertainty !== "none" && <span className="block text-muted-foreground">{t(`usage.uncertainty.${call.usage.uncertainty}`)}</span>}
      </td>
      {columns.map(c => <td key={c} className="py-1 pr-3 text-right tabular-nums"><Cell {...callValue(call, c)} unavailable={unavailable} /></td>)}
      <td className="py-1 text-right">
        <Button variant="link" size="sm" className="h-auto p-0 text-xs" aria-expanded={open} onClick={() => setOpen(!open)}>
          {t(open ? "usage.hideDetails" : "usage.details")}
        </Button>
      </td>
    </tr>
    {open && <tr><td colSpan={columns.length + 5} className="pb-2"><UsageCallDetails call={call} onSource={onSource} /></td></tr>}
  </>;
}

function TotalRow({ label, values, columns, note }: { label: string; values: Values; columns: readonly Column[]; note?: string }) {
  return <tr className="border-t font-medium">
    <td colSpan={4} className="py-1 pr-3">{label}{note && <span className="block font-normal text-muted-foreground">{note}</span>}</td>
    {columns.map(c => <td key={c} className="py-1 pr-3 text-right tabular-nums"><Cell value={columnValue(values, c)} /></td>)}
    <td />
  </tr>;
}

export function UsageTable({ summary, calls, onSource, noModel }: { summary: TaskUsageSummary; calls?: UsageCall[]; onSource: (id: string) => void; noModel?: boolean }) {
  if (!summary.recorded) return <p>{t(notRecordedKey(noModel))}</p>;
  const hasSpans = spans(summary) > 0;
  const observed: Values = {
    counters: Object.fromEntries(TOKEN_FIELDS.map(f => [f, plus(summary.counters[f], summary.unattributed.counters[f])])) as TokenCounters,
    inputInclusiveCache: plus(summary.inputInclusiveCache, summary.unattributed.inputInclusiveCache),
    costUsd: plus(summary.costUsd, summary.unattributed.costUsd),
  };
  const sources: Values[] = [summary, ...(hasSpans ? [summary.unattributed] : [])];
  // A column nobody reported a number for says nothing, so it is dropped; the note below says why the table is short.
  const columns = COLUMNS.filter(c => sources.some(v => columnValue(v, c) !== null) || (calls ?? []).some(call => callValue(call, c).value !== null));
  return <div className="space-y-2">
    <div className="overflow-x-auto">
      <table className="w-full min-w-[40rem] border-collapse text-left">
        <thead className="text-muted-foreground">
          <tr>
            <th className="pr-3 font-normal">{t("usage.col.time")}</th>
            <th className="pr-3 font-normal">{t("usage.col.call")}</th>
            <th className="pr-3 font-normal">{t("usage.col.model")}</th>
            <th className="pr-3 font-normal">{t("usage.col.status")}</th>
            {columns.map(c => <th key={c} className="pr-3 text-right font-normal" title={columnTitle(c)}>{columnLabel(c)}</th>)}
            <th />
          </tr>
        </thead>
        <tbody>
          {calls?.map(call => <CallRow key={call.callId} call={call} columns={columns} onSource={onSource} />)}
          {columns.length > 0 && <>
            <TotalRow label={t(hasSpans ? "usage.perCallTotal" : "usage.total")} values={summary} columns={columns} />
            {hasSpans && <>
              <TotalRow label={t("usage.unattributed", { intervals: summary.unattributed.intervals })} values={summary.unattributed} columns={columns} />
              <TotalRow label={t("usage.observedTotal")} values={observed} columns={columns} />
            </>}
          </>}
        </tbody>
      </table>
    </div>
    <ul className="space-y-0.5 text-muted-foreground">
      {columns.length === 0 && <li>{t(allUnavailable(summary) ? "usage.noTokensUnavailableNote" : "usage.noTokensNote")}</li>}
      {columns.length > 0 && summary.partial && <li>{t("usage.partialNote")}</li>}
      {summary.activeCalls > 0 && <li>{t("usage.activeCalls", { active: summary.activeCalls })}</li>}
      <li>{t("usage.coverage")}</li>
    </ul>
  </div>;
}

/** Everything a reader needs to audit one call; hidden behind the row so the table stays scannable. */
export function UsageCallDetails({ call, onSource }: { call: UsageCall; onSource: (id: string) => void }) {
  const o = call.usage.observation;
  const line = (label: string, value: ReactNode) => <><dt className="text-muted-foreground">{label}</dt><dd>{value}</dd></>;
  return <div className="space-y-2 rounded border bg-muted/30 p-2 break-words">
    <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5">
      {line(t("usage.requested"), call.requestedModel ?? t("usage.default"))}
      {line(t("usage.effort"), call.effort ?? t("usage.unknown"))}
      {line(t("usage.reportedModel"), o?.models.map(m => m.model ?? t("usage.unknown")).join(", ") || t("usage.unknown"))}
      {line(t("usage.col.time"), `${call.startedAt} → ${call.endedAt}`)}
      {line(t("usage.accuracy"), <>{call.usage.partial && `${t("usage.partial")} · `}{t(`usage.${call.usage.precision}`)} · {t(`usage.uncertainty.${call.usage.uncertainty}`)}</>)}
      {TOKEN_FIELDS.map(f => <Fragment key={f}>{line(t(`usage.${f}`), usageNumber(call.usage.counters[f], call.usage.availability === "unavailable"))}</Fragment>)}
      {line(t("usage.usd"), <>{usageNumber(call.usage.costUsd)} ({t(`usage.${call.usage.costPrecision}`)})</>)}
    </dl>
    {call.usage.interval && <div>
      <p>{t("usage.interval", { calls: call.usage.interval.callIds.length })}</p>
      <div className="flex flex-wrap gap-x-3">
        <span>{t("usage.inclusive")}: {usageNumber(call.usage.interval.inputInclusiveCache)}</span>
        {TOKEN_FIELDS.map(f => <span key={f}>{t(`usage.${f}`)}: {usageNumber(call.usage.interval!.counters[f])}</span>)}
        <span>{t("usage.usd")}: {usageNumber(call.usage.interval.costUsd)} ({t(`usage.${call.usage.interval.costPrecision}`)})</span>
      </div>
    </div>}
    <details>
      <summary className="cursor-pointer">{t("usage.provenance")}</summary>
      <p>{call.producer.source} · SDK {call.producer.version ?? t("usage.unknown")} · {t("usage.runtime")}: {call.producer.runtimeVersion ?? t("usage.unknown")}</p>
      {o && <>
        <p>{t(`usage.scope.${o.scope}`)} · {t(`usage.coverage.${o.coverage}`)} · {t(`usage.inputSemantics.${o.inputSemantics}`)} · {t(`usage.reasoning.${o.reasoningSemantics}`)}</p>
        {o.codex && <p>{t(`usage.runtimeVerification.${o.codex.runtimeVerification}`)}</p>}
        <p>{t("usage.modelDeltas")}</p>
        {call.usage.models.map((m, i) => <p key={`delta-${i}`}>{m.model ?? t("usage.unknown")}: {TOKEN_FIELDS.map(f => `${t(`usage.${f}`)} ${usageNumber(m.counters[f])}`).join(" · ")}</p>)}
        <p>{t("usage.observation")}</p>
        {o.threadAggregate && <p>{t("usage.threadAggregate")}: {TOKEN_FIELDS.map(f => `${t(`usage.${f}`)} ${usageNumber(o.threadAggregate!.counters[f])}`).join(" · ")}</p>}
        {o.models.map((m, i) => <p key={i}>{m.model ?? t("usage.unknown")} {m.canonicalModel ? `(${m.canonicalModel})` : ""}: {TOKEN_FIELDS.map(f => `${t(`usage.${f}`)} ${usageNumber(m.counters[f])}`).join(" · ")}</p>)}
        <p>{t("usage.usd")}: {usageNumber(o.costUsd)} ({t(`usage.${o.costPrecision}`)})</p>
      </>}
      <p>{t("usage.quotaReference")}</p>
      {[call.quotaBefore, call.quotaAfter].map((q, i) => <p key={i}>{t(i ? "usage.after" : "usage.before")}: {q.sampledAt ?? t("usage.unknown")} · {q.stale ? t("usage.stale") : t("usage.cached")} · {t(`usage.quota.${q.status}`)} {q.windows.map(w => `${w.bucket}: ${usageNumber(w.remainingPercent)}% (${w.resetsAt ?? t("usage.unknown")})`).join(" · ")}</p>)}
    </details>
    <div className="flex flex-wrap gap-x-3">
      <Button variant="link" size="sm" className="h-auto p-0 text-xs" onClick={() => onSource(call.eventId)}>{t("usage.source", { seq: call.seq })}</Button>
      {call.usage.baselineEventId && <Button variant="link" size="sm" className="h-auto p-0 text-xs" onClick={() => onSource(call.usage.baselineEventId!)}>{t("usage.baseline")}</Button>}
      {call.usage.interval && <Button variant="link" size="sm" className="h-auto p-0 text-xs" onClick={() => onSource(call.usage.interval!.from.eventId)}>{t("usage.intervalStart")}</Button>}
    </div>
  </div>;
}

export function TaskUsage({ taskId, events, onSource, noModel }: { taskId: string; events: TaskEvent[]; onSource: (id: string) => void; noModel?: boolean }) {
  useLanguage();
  const connection = useConnection();
  const revision = events.slice().reverse().find(e => e.type === "invocation_started" || e.type === "invocation_finished")?.id;
  const [summary, setSummary] = useState<TaskUsageSummary>();
  const [page, setPage] = useState<TaskUsagePage>();
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [error, setError] = useState(false);
  useEffect(() => {
    let active = true;
    void client.usageSummary(taskId).then(s => { if (active) { setSummary(s); setError(false); } }, () => { if (active) setError(true); });
    return () => { active = false; };
  }, [taskId, revision, connection, open]);
  useEffect(() => {
    if (!open) return;
    let active = true;
    setPage(undefined);
    void client.usageCalls(taskId, cursor).then(p => { if (active) { setPage(p); setError(false); } }, () => { if (active) setError(true); });
    return () => { active = false; };
  }, [taskId, cursor, open, revision, connection]);
  return <details className="max-h-[45dvh] shrink-0 overflow-y-auto border-b px-4 py-2 text-xs" onToggle={e => setOpen(e.currentTarget.open)}>
    <UsageCollapsedSummary summary={summary} error={error} noModel={noModel} />
    <div className="space-y-2 pt-2">
      {error && <p role="alert">{t("usage.error")}</p>}
      {open && !page && <p>{t("usage.loading")}</p>}
      {summary && <UsageTable summary={summary} calls={page?.calls} onSource={onSource} noModel={noModel} />}
      {open && <div className="flex gap-2">
        {cursor > 0 && <Button size="sm" variant="outline" onClick={() => setCursor(0)}>{t("usage.first")}</Button>}
        {page?.nextCursor !== null && page?.nextCursor !== undefined && <Button size="sm" variant="outline" onClick={() => setCursor(page.nextCursor!)}>{t("usage.next")}</Button>}
      </div>}
    </div>
  </details>;
}
