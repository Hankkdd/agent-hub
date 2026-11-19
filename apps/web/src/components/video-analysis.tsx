import { latestVideoAnalysis, type Task, type TaskEvent, type VideoAnalysis } from "@agent-hub/shared";
import { t, useLanguage } from "@/i18n";
import { client } from "@/lib/client";
import { Button } from "./ui/button";
import { useState } from "react";

function timestamp(seconds: number): string {
  const n = Math.floor(seconds);
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}`;
}
export function VideoAnalysisResult({ analysis: a }: { analysis: VideoAnalysis }) {
  useLanguage();
  const c = a.coverage;
  return <div className="space-y-3 text-sm [overflow-wrap:anywhere]" data-analysis-status={a.status}>
    <p className="font-medium">{t("videoAnalysis.action")} · {t(`videoAnalysis.status.${a.status}`)}</p>
    <p>{a.source ? t(`videoAnalysis.precision.${a.source.precision}`) : t("videoAnalysis.precision.unknown")}</p>
    <p>{t("videoAnalysis.coverage", { units: c.processedUnits, total: c.totalUnits, chunks: c.processedChunks, allChunks: c.totalChunks, chars: c.processedCharacters, allChars: c.totalCharacters })}</p>
    <p className="text-xs text-muted-foreground">{t("videoAnalysis.limits", { input: a.limits.inputCharacters, chunk: a.limits.chunkCharacters, calls: a.limits.chunks, output: a.limits.outputCharacters, items: a.limits.items, minutes: a.limits.runtimeMs / 60000 })}</p>
    <p className="text-amber-700 dark:text-amber-400">{t("videoAnalysis.warning")}</p>
    {a.reason && <p role="status">{t("videoAnalysis.failure", { reason: a.reason })}</p>}
    {a.status === "incomplete" && <p>{t("videoAnalysis.partial")}</p>}
    {a.status === "complete" && !a.items.length && <p>{t("videoAnalysis.empty")}</p>}
    <dl>{(["deadline", "submission", "output_format"] as const).map(key => <div key={key} className="flex flex-wrap gap-x-2"><dt>{t(`videoAnalysis.detail.${key}`)}</dt><dd>{t(`videoAnalysis.missing.${a.missing[key]}`)}</dd></div>)}</dl>
    {(["required", "prohibited", "suggested", "uncertain"] as const).map(category => <section key={category} className="space-y-2">
      <h3 className="font-semibold">{t(`videoAnalysis.category.${category}`)} ({a.items.filter(i => i.category === category).length})</h3>
      {a.items.filter(i => i.category === category).map(item => <article key={item.id} className="space-y-2 rounded border p-3" id={item.id}>
        <p>{item.content}</p>
        <p className="text-xs font-medium">{t(`videoAnalysis.review.${item.review}`)}</p>
        {item.variants.length > 0 && <details><summary>{t("videoAnalysis.variants")}</summary><ul>{item.variants.map(v => <li key={v}>{v}</li>)}</ul></details>}
        {item.conflicts.length > 0 && <p className="text-xs">{t("videoAnalysis.conflicts", { ids: item.conflicts.join(", ") })}</p>}
        {item.evidence.map((e, index) => <blockquote key={`${e.unitId}-${index}`} className="border-l-2 pl-3">
          {e.url ? <a className="underline" href={e.url} target="_blank" rel="noreferrer">{timestamp(e.start)}</a> : <span>{timestamp(e.start)}</span>}
          <p className="whitespace-pre-wrap">{e.excerpt}</p>
          <p className="text-xs text-muted-foreground">{e.unitId}</p>
        </blockquote>)}
      </article>)}
    </section>)}
  </div>;
}
export function VideoAnalysisPanel({ task, events }: { task: Task; events: TaskEvent[] }) {
  useLanguage();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const analysis = latestVideoAnalysis(events);
  const busy = pending || ["running", "waiting_user", "paused"].includes(task.status);
  return <details className="mx-auto my-3 w-full min-w-0 max-w-3xl rounded border p-3" open={analysis ? true : undefined}>
    <summary className="cursor-pointer font-medium">{t("videoAnalysis.action")}</summary>
    <div className="mt-3 space-y-3">
      <p className="text-sm">{t("videoAnalysis.intro")}</p>
      <Button size="sm" variant="outline" disabled={busy} onClick={() => {
        setPending(true); setError("");
        void client.analyzeVideo(task.id, "assignment-spec").catch(e => setError(String(e))).finally(() => setPending(false));
      }}>{t("videoAnalysis.action")}</Button>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {analysis && <VideoAnalysisResult analysis={analysis} />}
    </div>
  </details>;
}
