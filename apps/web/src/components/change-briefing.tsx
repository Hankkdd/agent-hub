import { fallbackText, usageLimitText } from "./status";
import { useEffect, useState } from "react";
import type { ChangeBriefingResponse, Task, TaskEvent } from "@agent-hub/shared";
import { client } from "@/lib/client";
import { t, useLanguage } from "@/i18n";
import { Button } from "./ui/button";
import { Markdown } from "./markdown";

/** Durable projection remains readable on old tasks even after their worktree is removed. */
export function projectBriefing(events: TaskEvent[]): ChangeBriefingResponse {
  const briefing = events.filter((e) => e.type === "briefing_completed").at(-1) ?? null;
  const last = events.filter((e) => e.type.startsWith("briefing_")).at(-1);
  return { briefing, state: last?.type === "briefing_started" ? "generating" : last?.type === "briefing_failed" ? "failed" : briefing ? "stale" : "empty", error: last?.type === "briefing_failed" ? last.error : undefined };
}
export function ChangeBriefingCard({ task, events, refreshKey }: { task: Task; events: TaskEvent[]; refreshKey?: number }) {
  useLanguage();
  const [state, setState] = useState(() => projectBriefing(events));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const last = events.filter((e) => e.type.startsWith("briefing_") || e.type === "diff_snapshot" || e.type === "user_message").at(-1)?.seq;
  useEffect(() => {
    let live = true;
    setState(projectBriefing(events));
    void client.briefing(task.id).then((value) => { if (live) { setState(value); setError(undefined); } }, (err: unknown) => { if (live) setError(String(err)); });
    return () => { live = false; };
  // Event bodies stream independently; only source/version boundaries need another read.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.id, task.status, task.workspace, last, refreshKey]);
  const generate = async () => {
    setBusy(true); setError(undefined);
    try { setState(await client.generateBriefing(task.id, true)); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  };
  const failure = events.filter((e) => e.type.startsWith("briefing_")).at(-1);
  const blocked = busy || state.state === "generating" || task.status === "running" || task.status === "waiting_user" || task.workspace?.state !== "active";
  return <section aria-label={t("briefing.title")} className="min-w-0 shrink-0 border-b p-3 text-xs">
    <div className="flex flex-wrap items-center gap-2">
      <strong>{t("briefing.title")}</strong><span role="status">{t(`briefing.${busy ? "generating" : state.state}`)}</span>
      {state.state === "generating" && <Button variant="ghost" size="sm" onClick={() => void client.stopTask(task.id).catch((err: unknown) => setError(String(err)))}>{t("composer.stop")}</Button>}
      {task.workspace?.state === "active" && <Button variant="ghost" size="sm" disabled={blocked} onClick={() => void generate()}>{t(state.briefing ? "briefing.rewrite" : "briefing.retry")}</Button>}
    </div>
    {(error || state.error) && <p role="alert" className="break-words text-destructive">{error || state.error}</p>}
    {failure?.type === "briefing_failed" && failure.limit && <p className="text-destructive">{usageLimitText(failure.limit)}</p>}
    {state.briefing && <>
      {state.briefing.fallbackFrom && <p className="text-muted-foreground">{fallbackText(state.briefing)}</p>}
      <p className="break-all font-mono">{state.briefing.source.baseSha.slice(0, 8)} → {state.briefing.source.headSha.slice(0, 8)} · {state.briefing.generationId.slice(0, 8)}</p>
      <details><summary className="cursor-pointer">{t("briefing.read")}</summary>
        <div className="max-h-[45dvh] min-w-0 overflow-auto py-2"><Markdown>{state.briefing.markdown}</Markdown>
          <p>{t("briefing.guides")}: {state.briefing.source.guides.map((g) => `${g.path}@${g.revision.slice(0, 8)}`).join(", ") || t("briefing.standard")}</p>
        </div>
      </details>
    </>}
  </section>;
}
