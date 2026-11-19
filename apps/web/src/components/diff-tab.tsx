import { fallbackText, usageLimitText } from "./status";
import { ChangeBriefingCard } from "./change-briefing";
import { usePhone } from "@/lib/use-phone";
import { ResizablePanel } from "@/components/resizable-panel";
import { t, useLanguage } from "@/i18n";
import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { ExternalLink, GitMerge, GitPullRequest, Loader2, MessageSquareText, RefreshCw, Trash2 } from "lucide-react";
import type { DiffExplanationsResponse, FileContents, FileDiff, Task, TaskEvent } from "@agent-hub/shared";
import { Button } from "@/components/ui/button";
import { client } from "@/lib/client";
import { cn } from "@/lib/utils";

import { ScopeEstimate } from "./scope-estimate";

const MonacoDiff = lazy(() => import("@/components/monaco-diff"));

/** The task's worktree against the commit it started from, with the merge / discard decision. */
export function DiffTab({ task, events, onShowChat }: { task: Task; events: TaskEvent[]; onShowChat: () => void }) {
  useLanguage();
  const ws = task.workspace;
  const [files, setFiles] = useState<FileDiff[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [contents, setContents] = useState<FileContents | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"merge" | "discard" | "pr" | "update" | "abandon" | null>(null);
  const [explanations, setExplanations] = useState<DiffExplanationsResponse | null>(null);
  const [revision, setRevision] = useState(0);
  const [requesting, setRequesting] = useState(false);
  const dark = useDarkMode();
  const phone = usePhone();
  const [startedOperation, setStartedOperation] = useState<{ id: string; afterSeq: number } | null>(null);
  const latestUpdateEvent = events.filter(e => e.type === "pr_update").at(-1);
  const latestUpdate = latestUpdateEvent?.update;
  const terminal = latestUpdate && ["succeeded", "noop", "failed", "interrupted", "abandoned"].includes(latestUpdate.stage);
  useEffect(() => {
    if (startedOperation && terminal && latestUpdateEvent!.seq > startedOperation.afterSeq) setStartedOperation(null);
  }, [startedOperation, terminal, latestUpdateEvent]);

  // Re-read when a round is committed or the task changes state (not on every streamed token).
  const explanationSeq = events.filter((e) => e.type === "diff_explanations" || e.type === "diff_explanations_started").at(-1)?.seq;
  const snapshots = events.filter((e) => e.type === "diff_snapshot").length;
  const refresh = useCallback(async () => {
    if (!ws || ws.state !== "active") return;
    try {
      const [list, explained] = await Promise.all([client.diff(task.id), client.explanations(task.id)]);
      setExplanations(explained);
      setFiles(list);
      setRevision((n) => n + 1);
      setSelected((cur) => (cur && list.some((f) => f.path === cur) ? cur : (list[0]?.path ?? null)));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [task.id, ws]);
  useEffect(() => {
    void refresh();
  }, [refresh, snapshots, task.status, explanationSeq]);

  useEffect(() => {
    setContents(null);
    if (!selected || ws?.state !== "active") return; // after a merge or discard there is nothing to read
    let live = true;
    Promise.all([client.diffFile(task.id, selected), client.explanations(task.id)]).then(
      ([c, explained]) => { if (live) { setContents(c); setExplanations(explained); } },
      (err) => live && setError(String(err)),
    );
    return () => {
      live = false;
    };
  }, [task.id, selected, snapshots, revision, task.status, ws?.state]);

  if (!ws) return <Empty>{t("diff.noWorktree")}</Empty>;
  if (ws.state !== "active") return <Empty>{ws.state === "merged" ? t("diff.merged", { baseRef: ws.baseRef }) : t("diff.discarded")}</Empty>;

  const running = task.status === "running" || task.status === "waiting_user" ||
    !!(startedOperation && (latestUpdate?.id !== startedOperation.id || !terminal));
  const generating = requesting || explanations?.generating || task.sessions.some((s) => s.role === "explainer" && s.status === "running");
  const explained = explanations?.event;
  const regenerate = async () => {
    setRequesting(true);
    setError(null);
    try {
      await client.regenerateExplanations(task.id);
      setExplanations(await client.explanations(task.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setRequesting(false); }
  };
  const prOpen = ws.pr?.state === "open";
  const act = async (kind: "merge" | "discard" | "pr") => {
    const question =
      kind === "merge"
        ? t("diff.mergeConfirm", { branch: ws.branch, baseRef: ws.baseRef, repoPath: ws.repoPath })
        : kind === "pr"
          ? t("diff.prConfirm", { branch: ws.branch, github: ws.github ?? "", baseRef: ws.baseRef })
          : t("diff.discardConfirm", { branch: ws.branch, prNote: prOpen ? t("diff.closePrNote", { number: ws.pr!.number }) : "" });
    if (!(kind === "pr" && task.options.repoSettings) && !window.confirm(question)) return;
    setBusy(kind);
    setError(null);
    try {
      if (kind === "pr") {
        if (task.options.repoSettings) {
          await client.preparePrDraft(task.id);
          onShowChat();
        } else {
          const pr = await client.openPr(task.id);
          window.open(pr.url, "_blank", "noreferrer");
        }
      } else await (kind === "merge" ? client.merge(task.id) : client.discard(task.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };
  const update = async () => {
    if (!ws.pr?.revision || !window.confirm(t("diff.updateConfirm", { target: ws.pr.revision.target, number: ws.pr.number }))) return;
    setBusy("update");
    setError(null);
    try {
      const result = await client.updatePr(task.id, ws.pr.revision);
      if (result.error) setError(result.error);
      else setStartedOperation({ id: result.id, afterSeq: events.at(-1)?.seq ?? 0 });
      await refresh();
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(null); }
  };
  const abandonable = latestUpdate?.owned && ["failed", "interrupted"].includes(latestUpdate.stage) && !latestUpdate.publication &&
    !!latestUpdate.previousBase && !!latestUpdate.preSha && latestUpdate.preSha === latestUpdate.revision.headSha;
  const abandon = async () => {
    if (!abandonable || !window.confirm(t("diff.abandonUpdateConfirm"))) return;
    setBusy("abandon"); setError(null);
    try {
      const result = await client.abandonPrUpdate(task.id);
      setStartedOperation({ id: result.id, afterSeq: events.at(-1)?.seq ?? 0 });
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(null); }
  };
  const additions = files?.reduce((n, f) => n + f.additions, 0) ?? 0;
  const deletions = files?.reduce((n, f) => n + f.deletions, 0) ?? 0;
  const explanationNote = [
    generating ? t("diff.explainGenerating") : explained?.error ? t("diff.explainFailed", { reason: explained.error }) : explained ? t("diff.explainHint") : t("diff.explainEmpty"),
    explanations?.stale ? t("diff.explainStale") : null,
    explained?.skipped ? t("diff.explainSkipped", { count: explained.skipped }) : null,
  ].filter(Boolean).join(" · ");

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      {["implement", "review"].includes(task.workflow) && <ChangeBriefingCard task={task} events={events} refreshKey={revision} />}
      {(prOpen || latestUpdate) && <div className="shrink-0 border-b px-3 py-2 text-xs break-words">
        {t("diff.updateTarget", { target: ws.pr?.revision?.target ?? t("diff.targetUnknown") })}
        {task.options.reportsTo && <a className="ml-2 text-primary underline" href={`?task=${encodeURIComponent(task.options.reportsTo)}`}>{t("diff.updateInPlan")}</a>}
        {!!latestUpdate?.retainedUntracked?.total && <div className="mt-2 max-h-40 overflow-auto" role="status">
          <p>{t("prUpdate.leftovers", { count: latestUpdate.retainedUntracked.total })}</p>
          <ul className="list-disc pl-5">{latestUpdate.retainedUntracked.paths.map(file => <li key={file} className="break-all font-mono">{file}</li>)}</ul>
          {latestUpdate.retainedUntracked.total > latestUpdate.retainedUntracked.paths.length && <p>{t("prUpdate.leftoversTruncated", { count: latestUpdate.retainedUntracked.total - latestUpdate.retainedUntracked.paths.length })}</p>}
        </div>}
        {latestUpdate && <div>{t(`prUpdate.${latestUpdate.stage}`)}{latestUpdate.stoppedAt && ` · ${t(`prUpdate.${latestUpdate.stoppedAt}`)}`}{latestUpdate.tests && ` · ${t(`prUpdate.tests.${latestUpdate.tests}`)}`}{latestUpdate.publication === "uncertain" && ` · ${t("prUpdate.uncertain")}`}{latestUpdate.error && ` · ${latestUpdate.error}`}</div>}
      </div>}
      {files && <div className="shrink-0 border-b px-3 py-2 text-muted-foreground"><ScopeEstimate estimate={task.options.scopeEstimate} filesChanged={files.length} additions={additions} deletions={deletions} binaryFiles={files.filter((f) => f.binary).length} /></div>}
      <div className="diff-toolbar flex flex-wrap max-md:shrink-0 items-center gap-2 border-b px-3 py-2">
        <div className="min-w-0 flex-1 text-xs text-muted-foreground max-md:hidden">
          <span className="font-mono">
            {ws.branch} ← {ws.prBase ?? ws.baseRef}
          </span>
          {files && (
            <>
              {" · "}
              {t("diff.files", { count: files.length })} <span className="text-emerald-600 dark:text-emerald-400">+{additions}</span> /{" "}
              <span className="text-red-600 dark:text-red-400">−{deletions}</span>
            </>
          )}
          {running && t("diff.running")}
        </div>
        <Button size="sm" variant="ghost" onClick={() => void refresh()} aria-label={t("diff.refresh")} title={t("diff.refresh")}>
          <RefreshCw />
        </Button>
        <Button size="sm" variant="outline" title={t("diff.discard")} aria-label={t("diff.discard")} disabled={running || !!busy} onClick={() => void act("discard")}>
          {busy === "discard" ? <Loader2 className="animate-spin" /> : <Trash2 />} <span className="max-[380px]:hidden">{t("diff.discard")}</span>
        </Button>
        {ws.pr && (
          <Button size="sm" variant={prOpen ? "default" : "outline"} title={t("diff.prLabel", { number: ws.pr.number, state: t(`pr.${ws.pr.state}`) })} aria-label={t("diff.prLabel", { number: ws.pr.number, state: t(`pr.${ws.pr.state}`) })} asChild>
            <a href={ws.pr.url} target="_blank" rel="noreferrer">
              <ExternalLink /> <span className="max-md:hidden">{t("diff.prLabel", { number: ws.pr.number, state: t(`pr.${ws.pr.state}`) })}</span>
            </a>
          </Button>
        )}
        {prOpen && <Button size="sm" variant="outline" disabled={running || !!busy || !ws.pr?.revision || !!task.options.reportsTo} onClick={() => void update()}>
          {busy === "update" ? <Loader2 className="animate-spin" /> : <GitMerge />}{t("diff.updatePr")}
        </Button>}
        {abandonable && <Button size="sm" variant="outline" disabled={running || !!busy || !!task.options.reportsTo} onClick={() => void abandon()}>
          {busy === "abandon" ? <Loader2 className="animate-spin" /> : <Trash2 />}{t("diff.abandonUpdate")}
        </Button>}
        {ws.github && !prOpen && (
          <Button size="sm" title={t(task.options.repoSettings ? "prDraft.prepare" : "diff.openPr")} aria-label={t(task.options.repoSettings ? "prDraft.prepare" : "diff.openPr")} disabled={running || !!busy || !files?.length} onClick={() => void act("pr")}>
            {busy === "pr" ? <Loader2 className="animate-spin" /> : <GitPullRequest />} {t(task.options.repoSettings ? "prDraft.prepare" : "diff.openPr")}
          </Button>
        )}
        {!prOpen && (
          <Button size="sm" variant={ws.github ? "outline" : "default"} title={ws.github ? t("diff.mergeLocally") : t("diff.mergeInto", { baseRef: ws.baseRef })} aria-label={ws.github ? t("diff.mergeLocally") : t("diff.mergeInto", { baseRef: ws.baseRef })} disabled={running || !!busy || !files?.length} onClick={() => void act("merge")}>
            {busy === "merge" ? <Loader2 className="animate-spin" /> : <GitMerge />} <span className="max-md:hidden">{ws.github ? t("diff.mergeLocally") : t("diff.mergeInto", { baseRef: ws.baseRef })}</span>
          </Button>
        )}
        {phone && <Button size="sm" variant="ghost" title={t("diff.explainGenerate")} aria-label={t("diff.explainGenerate")} disabled={running || !!generating} onClick={() => void regenerate()}>{generating ? <Loader2 className="animate-spin" /> : <MessageSquareText />}</Button>}
      </div>
      {phone ? (
        <div className="flex min-w-0 shrink-0 items-center gap-2 border-b px-3 py-1 text-xs text-muted-foreground">
          {generating && <Loader2 className="size-3 shrink-0 animate-spin" />}
          <div className="min-w-0 flex-1">
            <span className="block truncate" title={explanationNote}>{explanationNote}</span>
            {explained?.fallbackFrom && <p className="text-muted-foreground">{fallbackText(explained)}</p>}
            {explained?.limit && <p className="text-destructive">{usageLimitText(explained.limit)}</p>}
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2 text-xs text-muted-foreground">
          {generating ? <><Loader2 className="size-3 animate-spin" />{t("diff.explainGenerating")}</> :
            explained?.error ? t("diff.explainFailed", { reason: explained.error }) :
            explained ? t("diff.explainHint") : t("diff.explainEmpty")}
          {explanations?.stale && <span className="rounded bg-amber-500/15 px-2 py-1 text-amber-700 dark:text-amber-400">{t("diff.explainStale")}</span>}
          {!!explained?.skipped && <span>{t("diff.explainSkipped", { count: explained.skipped })}</span>}
          <Button size="sm" variant="ghost" disabled={running || !!generating} onClick={() => void regenerate()}>{t("diff.explainGenerate")}</Button>
          {explained?.fallbackFrom && <p className="w-full text-muted-foreground">{fallbackText(explained)}</p>}
          {explained?.limit && <p className="w-full text-destructive">{usageLimitText(explained.limit)}</p>}
        </div>
      )}
      {error && <div className="border-b bg-red-500/5 max-md:shrink-0 max-md:max-h-16 max-md:overflow-y-auto max-md:[overflow-wrap:anywhere] px-3 py-2 text-xs text-red-600 dark:text-red-400">{error}</div>}
      {files === null ? (
        <Empty>{t("app.loading")}</Empty>
      ) : files.length === 0 ? (
        <Empty>{t("diff.noChanges")}</Empty>
      ) : (
        <div className="flex min-h-0 min-w-0 flex-1 max-md:flex-col">
          <div className="min-w-0 shrink-0 border-b px-3 py-1 md:hidden">
            <select className="w-full min-w-0 rounded-md border bg-background px-2 text-xs" aria-label={t("diff.selectFile")} value={selected ?? ""} onChange={(event) => setSelected(event.target.value)}>
              {files.map((file) => <option key={file.path} value={file.path}>{file.path} (+{file.additions} −{file.deletions})</option>)}
            </select>
          </div>
          {/* Keep room for the editor when both panels are widened on a small desktop. */}
          <ResizablePanel storageKey="agent-hub-diff-files-width" defaultWidth={256} minWidth={160} maxWidth={600} className="hidden min-h-0 md:block md:max-w-[calc(100%-128px)]">
            <div className="h-full overflow-y-auto border-r p-2 max-md:max-h-40 max-md:border-r-0 max-md:border-b">
              {files.map((f) => (
                <button
                  key={f.path}
                  onClick={() => setSelected(f.path)}
                  className={cn("flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs hover:bg-accent", f.path === selected && "bg-accent")}
                >
                  <span className={cn("w-3 font-mono", f.status === "added" ? "text-emerald-500" : f.status === "deleted" ? "text-red-500" : "text-amber-500")}>
                    {f.status[0]!.toUpperCase()}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono">{f.path}</span>
                  <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                    {f.binary ? t("diff.binary") : `+${f.additions} −${f.deletions}`}
                  </span>
                </button>
              ))}
            </div>
          </ResizablePanel>
          <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
            {!contents ? (
              <Empty>{t("app.loading")}</Empty>
            ) : contents.binary ? (
              <Empty>{t("diff.binary")}</Empty>
            ) : (
              <Suspense fallback={<Empty>{t("diff.loadingEditor")}</Empty>}>
                <MonacoDiff file={contents} dark={dark} taskId={task.id} explanations={explained ?? null} stale={explanations?.stale ?? false} />
              </Suspense>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full items-center justify-center p-8 text-center text-sm text-muted-foreground">{children}</div>;
}

function useDarkMode(): boolean {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  useEffect(() => {
    const obs = new MutationObserver(() => setDark(document.documentElement.classList.contains("dark")));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => obs.disconnect();
  }, []);
  return dark;
}
