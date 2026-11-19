import { IssueLinkFields, IssueLinkLabel } from "./issue-link";
import { NewTaskDialog } from "./new-task-dialog";
import { managedIssueBlock, updateManagedIssue } from "@agent-hub/shared";
import { fallbackText, usageLimitText } from "./status";
import { IssueCommentCard } from "./issue-comment-card";
import { activeMainSession } from "@agent-hub/shared";
import { HandoffCard, HandoffImages } from "./handoff-card";
import { ChangeBriefingCard } from "./change-briefing";
import { t, useLanguage } from "@/i18n";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronRight, Loader2, TriangleAlert } from "lucide-react";
import type { RecoverAction, Task, TaskEvent } from "@agent-hub/shared";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Markdown, splitBriefingAppendix } from "@/components/markdown";
import { client, label } from "@/lib/client";
import { roleLabel } from "@/components/status";
import { cn } from "@/lib/utils";
import { FindingCard } from "./finding-card";
import { ScopeEstimate } from "./scope-estimate";
import { AskCard } from "@/components/ask-card";

export interface RoomTranscriptActions {
  onReply?: (event: Extract<TaskEvent, { type: "user_message" | "agent_text" }>, part?: string) => void;
  renderSuggestion?: (event: Extract<TaskEvent, { type: "room_suggestion" }>) => ReactNode;
}
interface ProposalActions extends RoomTranscriptActions {
  onSelectTask: (id: string) => void;
}

/** The conversation view: one row per event, in seq order. */
export function ChatTab({ task, events, ...actions }: { task: Task; events: TaskEvent[] } & ProposalActions) {
  useLanguage();
  const end = useRef<HTMLDivElement>(null);
  const last = events[events.length - 1];
  const latestDraft = events.filter((e) => e.type === "pr_draft").at(-1);
  const latestSnapshot = events.filter((e) => e.type === "diff_snapshot").at(-1);
  // Follow the stream: scroll when a new event arrives or the last one grows.
  // Braces matter: newer Chrome returns a Promise from scrollIntoView, and an effect must return
  // nothing or a cleanup function. Returning it crashed the whole tree on unmount.
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [events.length, last?.type === "agent_text" ? last.text.length : 0]);

  return (
    <div className="transcript mx-auto flex min-w-0 w-full max-w-3xl flex-col gap-3 px-4 py-4">
      {events.some((e) => e.type.startsWith("briefing_")) && <ChangeBriefingCard task={task} events={events} />}
      {task.status === "interrupted" && <InterruptedBanner taskId={task.id} events={events} />}
      {events.filter((e) => !(e.type === "handoff_started" && events.some((r) => (r.type === "handoff_completed" || r.type === "handoff_failed") && r.operationId === e.operationId)) &&
        !(e.type === "handoff_delivery" && events.some((r) => r.type === "handoff_delivery" && r.handoffId === e.handoffId && r.seq > e.seq))).map((e) => (
        e.type === "issue_comment_draft" || e.type === "issue_comment_outcome" ? null : e.type === "task_proposal" ? <div key={e.id}><ProposalCard event={e} task={task} {...actions} /><IssueCommentCard taskId={task.id} proposalId={e.id} events={events} /></div> : e.type === "finding_recorded" ? <FindingCard key={e.id} finding={e} events={events} task={task} /> : e.type === "pr_draft"
          ? <PrDraftCard key={e.id} event={e} task={task} latest={latestDraft?.id === e.id} stale={(!e.briefingId && e.briefingError === undefined) || (latestSnapshot?.seq ?? 0) > e.seq || events.some((b) => b.type.startsWith("briefing_") && b.seq > e.seq)} />
          : <EventRow key={e.id} event={e} task={task} {...actions} />
      ))}
      {task.status === "running" && <Working task={task} since={last?.createdAt} />}
      <div ref={end} />
    </div>
  );
}

/**
 * A running turn can go a minute or more between events while the model reasons, and a transcript that
 * does not move looks stuck. This line says who is working and how long since the last sign of life;
 * the counter restarts with every event, so a growing number is the hint to look closer.
 */
function Working({ task, since }: { task: Task; since?: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const session = ["chat", "plan"].includes(task.workflow) ? activeMainSession(task) : task.sessions.find((s) => s.status === "running");
  const start = since ? Date.parse(since) : NaN;
  const seconds = Number.isNaN(start) ? null : Math.max(0, Math.floor((now - start) / 1000));
  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
      <Loader2 className="size-4 animate-spin" />
      <span>{t("chat.working", { agent: session ? label(session.agent) : t("chat.agent") })}</span>
      {seconds !== null && seconds >= 3 && <span className="tabular-nums">· {t("chat.workingFor", { seconds: String(seconds) })}</span>}
    </div>
  );
}

export function agentOf(task: Task, sessionId: string | null) {
  const s = task.sessions.find((x) => x.id === sessionId);
  return s ? { name: label(s.agent), role: s.role, agent: s.agent, retired: s.role === "main" && !!task.options.activeMainSessionId && s.id !== activeMainSession(task)?.id } : null;
}

/** The turn is still in flight: running, or paused on a question to the user. */
const inFlight = (task: Task) => task.status === "running" || task.status === "waiting_user";

function EventRow({ event: e, task, ...actions }: { event: TaskEvent; task: Task } & ProposalActions) {
  useLanguage();
  switch (e.type) {
    case "handoff_started":
    case "handoff_completed":
    case "handoff_failed":
      return <HandoffCard event={e} />;
    case "handoff_delivery":
      return <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">{t("handoff.delivery", { count: e.images.filter((i) => !i.reason).length, omitted: e.images.filter((i) => i.reason).length })}{!e.delivered && ` · ${t("handoff.unconfirmed")}`}</summary><HandoffImages images={e.images} /></details>;
    case "pr_conflict":
      return <div className="rounded-md border p-3 text-xs">{t(`prConflict.${e.state}`)} · {e.revision.target} ({e.revision.targetSha.slice(0, 8)})</div>;
    case "pr_update":
      return <details className="rounded-md border p-3 text-xs"><summary>{t(`prUpdate.${e.update.stage}`)}{e.update.stoppedAt && ` · ${t(`prUpdate.${e.update.stoppedAt}`)}`} · {e.update.revision.target}{e.update.tests && ` · ${t(`prUpdate.tests.${e.update.tests}`)}`}{e.update.publication === "uncertain" && ` · ${t("prUpdate.uncertain")}`}</summary><pre className="overflow-auto whitespace-pre-wrap">{JSON.stringify(e.update, null, 2)}</pre></details>;
    case "pr_update_authorized":
      return <div className="text-xs text-muted-foreground">{t(e.action === "abandon" ? "prUpdate.abandoning" : "prUpdate.intent")}</div>;
    case "invocation_started":
    case "invocation_finished":
    case "finding_recorded":
    case "finding_export":
    case "finding_batch":
      return null;
    case "ask":
      return <>{e.context && <Markdown>{e.context}</Markdown>}{(e.answer || e.superseded) && <AskCard event={e} />}</>;
    case "task_message_sent":
      return <div className="rounded-md border px-3 py-2 text-xs text-muted-foreground">{t("planner.sentTo")} <a href={`?task=${encodeURIComponent(e.task)}`} className="text-primary underline" onClick={(event) => { event.preventDefault(); actions.onSelectTask(e.task); }}>{e.title}</a></div>;
    case "task_proposal":
      return <ProposalCard event={e} task={task} {...actions} />;
    case "task_started":
    case "task_report": {
      const id = e.type === "task_started" ? e.task : e.report.taskId;
      const title = e.type === "task_started" ? e.title : e.report.title;
      const pr = e.type === "task_report" ? e.report.pr : undefined;
      return <div className="rounded-lg border p-3 text-sm">
        <div className="mb-1 font-semibold">{e.type === "task_started" ? t("report.started") : t(`report.${e.report.outcome}`)}</div>
        <a href={`?task=${encodeURIComponent(id)}`} className="text-primary underline" onClick={(event) => { event.preventDefault(); actions.onSelectTask(id); }}>{title}</a>
        {e.type === "task_report" && <>
          {e.report.conflict && <div className="mt-1 break-words text-xs">{t("diff.updateTarget", { target: e.report.conflict.target })} · {e.report.conflict.targetSha.slice(0, 8)}</div>}
          {e.report.prUpdate && <div className="mt-1 break-words text-xs">{t(`prUpdate.${e.report.prUpdate.stage}`)}{e.report.prUpdate.stoppedAt && ` · ${t(`prUpdate.${e.report.prUpdate.stoppedAt}`)}`} · {e.report.prUpdate.revision.target}
            {e.report.prUpdate.tests && ` · ${t(`prUpdate.tests.${e.report.prUpdate.tests}`)}`}
            {e.report.prUpdate.resultSha && ` · ${e.report.prUpdate.resultSha.slice(0, 8)}`}
            {e.report.prUpdate.publication === "uncertain" && ` · ${t("prUpdate.uncertain")}`}
            {!!e.report.prUpdate.retainedUntracked?.total && <div>
              {t("prUpdate.leftovers", { count: e.report.prUpdate.retainedUntracked.total })}
              <ul className="list-disc pl-5">{e.report.prUpdate.retainedUntracked.paths.map(file => <li key={file} className="break-all font-mono">{file}</li>)}</ul>
              {e.report.prUpdate.retainedUntracked.total > e.report.prUpdate.retainedUntracked.paths.length && t("prUpdate.leftoversTruncated", { count: e.report.prUpdate.retainedUntracked.total - e.report.prUpdate.retainedUntracked.paths.length })}
            </div>}
            {e.report.prUpdate.error && ` · ${e.report.prUpdate.error}`}
          </div>}
          <ScopeEstimate estimate={e.report.scopeEstimate} {...e.report} />
          {e.report.recordedFindings?.map((f) => <div key={f.findingId} className="mt-1 text-xs">{t("finding.title")} · {f.title} · {t(`finding.${f.state}`)}{f.document ? ` · ${f.document}` : ""}{f.reason ? ` · ${f.reason}` : ""}</div>)}
        </>}
        {pr && <a href={pr.url} target="_blank" rel="noreferrer" className="ml-3 text-primary underline">PR #{pr.number}</a>}
      </div>;
    }
    case "room_suggestion": return actions.renderSuggestion?.(e) ?? null;
    case "user_message":
      if (e.exchange) return <div className="text-center text-xs text-muted-foreground">{t("room.exchangeLine")}</div>;
      return (
        <Replyable event={e} onReply={actions.onReply}>
        <div className={cn("ml-auto max-w-[85%] rounded-lg bg-primary px-3 py-2 text-sm whitespace-pre-wrap text-primary-foreground", e.queued && "opacity-60")}>
          {e.quote && <button type="button" className="mb-2 block w-full border-l-2 pl-2 text-left text-xs opacity-80"
            onClick={() => document.getElementById(`room-event-${e.quote!.eventId}`)?.scrollIntoView({ block: "center" })}>
            <strong>{e.quote.author === "user" ? t("room.you") : e.quote.author === "codex" ? t("room.gpt") : t("agent.claude")}</strong>
            <span className="block truncate">{e.quote.text.split("\n")[0]}</span></button>}
          {e.selection && <blockquote className="mb-2 max-h-40 overflow-y-auto border-l-2 pl-2 text-xs"><strong>{t("suggestions.selected")}</strong><p>{e.selection.originalText}</p></blockquote>}
          {e.images && e.images.length > 0 && (
            <div className={cn("flex flex-wrap gap-1.5", e.text && "mb-2")}>
              {e.images.map((img) => {
                const src = `/api/tasks/${task.id}/attachments/${img.file}`;
                return (
                  <a key={img.file} href={src} target="_blank" rel="noreferrer">
                    <img src={src} alt={t("chat.attachedPicture")} className="max-h-40 max-w-56 rounded-md object-cover" />
                  </a>
                );
              })}
            </div>
          )}
          {e.text}
          {e.queued && <div className="mt-1 text-[11px] opacity-80">{t(task.status === "paused" && task.options.quotaPause ? "chat.queuedQuota" : "chat.queued")}</div>}
        </div></Replyable>
      );
    case "agent_text": {
      // An empty block is only worth a spinner while the turn is still running.
      if (!e.text && !inFlight(task)) return null;
      const a = agentOf(task, e.sessionId);
      if (task.workflow === "room" && e.text === "(pass)") return <div className="text-xs text-muted-foreground">{t("room.passed", { agent: a?.agent === "codex" ? t("room.gpt") : a?.name ?? t("chat.agent") })}</div>;
      return (
        <Replyable event={e} onReply={actions.onReply}>
        <div className="max-w-[92%]">
          <AgentLabel name={task.workflow === "room" && a?.agent === "codex" ? t("room.gpt") : a?.name} role={a?.role} agent={a?.agent} retired={a?.retired} />
          {e.text ? <Markdown>{e.text}</Markdown> : <Loader2 className="size-4 animate-spin text-muted-foreground" />}
        </div></Replyable>
      );
    }
    case "tool_call":
      return <ToolRow event={e} live={inFlight(task)} />;
    case "status_change":
      return (
        <div className="text-center text-xs text-muted-foreground">
          {e.from} → {e.to}
          {e.reason ? ` · ${e.reason}` : ""}
        </div>
      );
    case "briefing_started":
    case "briefing_completed":
    case "briefing_failed":
      return null;
    case "diff_explanations_started":
      return null;
    case "diff_explanations":
      return <div className="text-xs text-muted-foreground">{e.error ? t("chat.explanationsFailed", { reason: e.error }) : t("chat.explanations", { count: e.items.length })}</div>;
    case "diff_snapshot":
      return (
        <div className="rounded-md border px-3 py-2 text-xs text-muted-foreground">
          {t("chat.diffSummary", { round: e.round, count: e.filesChanged })} <span className="text-emerald-600 dark:text-emerald-400">+{e.additions}</span> /{" "}
          <span className="text-red-600 dark:text-red-400">−{e.deletions}</span>
          <ScopeEstimate estimate={task.options.scopeEstimate} {...e} />
        </div>
      );
    case "review_result": {
      const a = agentOf(task, e.sessionId);
      return (
        <div className="rounded-lg border">
          <div className="flex items-center gap-2 border-b px-3 py-2 text-sm">
            <span className="font-medium">
              {t("review.round", { round: e.round, agent: a?.name ?? "" })}
            </span>
            <Badge variant={e.verdict === "approve" ? "default" : "destructive"}>{e.verdict === "approve" ? t("review.approved") : t("review.changes")}</Badge>
          </div>
          <ul className="divide-y">
            {e.findings.map((f, i) => (
              <li key={i} className="flex gap-2 px-3 py-2 text-sm">
                <Badge variant="outline" className={cn("h-5 shrink-0", f.severity === "high" && "border-red-500/50 text-red-600 dark:text-red-400")}>
                  {t(`severity.${f.severity}`)}
                </Badge>
                {f.rule && <Badge variant="outline" className="h-5 shrink-0" title={t("review.rule")}>{f.rule}</Badge>}
                <span className="min-w-0">
                  <code className="text-xs text-muted-foreground">{f.location}</code>
                  <span className="block">{f.message}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      );
    }
    case "pr_opened":
      return (
        <a
          href={e.url}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-2 rounded-md border border-emerald-500/40 px-3 py-2 text-sm hover:bg-accent"
        >
          <span className="font-medium">{t("chat.prOpened", { number: e.number })}</span>
          <span className="truncate text-xs text-muted-foreground">{e.url}</span>
        </a>
      );
    case "test_result": {
      const passed = e.exitCode === 0;
      return (
        <details className={cn("rounded-md border text-sm", passed ? "border-emerald-500/40" : "border-red-500/50 bg-red-500/5")} open={!passed}>
          <summary className="cursor-pointer px-3 py-2">
            <span className={cn("font-medium", passed ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400")}>
              {t("chat.tests", { result: t(passed ? "tests.passed" : "tests.failed") })}
            </span>
            <span className="text-muted-foreground">
              {" "}
              {t("chat.testRound", { round: e.round })} <code className="text-xs">{e.command}</code>
              {!passed && t("chat.testExit", { code: e.exitCode ?? t("tests.timeout") })}
            </span>
          </summary>
          <pre className="max-h-80 overflow-auto border-t px-3 py-2 font-mono text-xs whitespace-pre-wrap">{e.output || t("common.noOutput")}</pre>
        </details>
      );
    }
    case "turn_result": {
      const output = e.output !== undefined ? <pre className="overflow-auto rounded-md border p-3 font-mono text-xs"><code>{JSON.stringify(e.output, null, 2)}</code></pre> : null;
      if (e.ok) return output;
      return (
        <>
          {output}
          <div className="rounded-md border border-red-500/50 bg-red-500/5 px-3 py-2 text-sm">
            <div className="font-medium text-red-600 dark:text-red-400">{e.limit ? usageLimitText(e.limit) : t("chat.turnFailed")}</div>
            <pre className={cn("mt-1 font-mono text-xs whitespace-pre-wrap", e.limit && "text-muted-foreground")}>{e.error ?? t("common.unknownError")}</pre>
            <div className="mt-1 text-xs text-muted-foreground">{t("chat.retryHint")}</div>
          </div>
        </>
      );
    }
    case "waiting_user":
      return <WaitingUserCard event={e} task={task} />;
  }
}

function PrDraftCard({ event: e, task, latest, stale }: { event: Extract<TaskEvent, { type: "pr_draft" }>; task: Task; latest: boolean; stale: boolean }) {
  useLanguage();
  const savedLink = e.issueLink ?? { issue: task.options.issue ?? null, issueCompletion: task.options.issueCompletion };
  const [values, setValues] = useState({ branch: e.branch, commitMessage: e.commitMessage, title: e.title, body: e.body,
    issue: savedLink.issue?.number ?? null, issueCompletion: savedLink.issueCompletion });
  const [editing, setEditing] = useState(false);
  const [editValues, setEditValues] = useState(values);
  const initialManagedIssue = e.managedIssue ?? (!e.issueLink && savedLink.issue ? `\n\n${savedLink.issueCompletion === "partial" ? "Refs" : "Closes"} #${savedLink.issue.number}` : undefined);
  const [editManagedIssue, setEditManagedIssue] = useState(initialManagedIssue);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const available = latest && task.workspace?.state === "active" && task.workspace.pr?.state !== "open" && !inFlight(task);
  const act = async (prepare: boolean) => {
    setBusy(true);
    setError(null);
    try {
      if (prepare) await client.preparePrDraft(task.id);
      else {
        const pr = await client.openPr(task.id, { draftId: e.id, ...values });
        window.open(pr.url, "_blank", "noreferrer");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setBusy(false); }
  };
  return <div className="rounded-lg border border-amber-500/50 bg-amber-500/5 p-3 text-sm">
    <div className="mb-2 font-semibold">{t("prDraft.heading")}{e.by === "user" && <span className="ml-2 text-xs text-muted-foreground">{t("prDraft.edited")}</span>}</div>
    {e.fallbackFrom && <p className="mb-2 text-xs text-muted-foreground">{fallbackText(e)}</p>}
    <div className="mb-2"><IssueLinkLabel issue={savedLink.issue} completion={savedLink.issueCompletion} /></div>
    <div className="mb-2">{t("prDraft.branch")} <code className="break-all">{values.branch}</code></div>
    {values.commitMessage !== undefined && <div className="mb-2">{t("prDraft.commit")}<pre className="whitespace-pre-wrap break-words">{values.commitMessage}</pre></div>}
    <div className="mb-2">{t("prDraft.title")} <span className="font-semibold">{values.title}</span></div>
    {values.body.length > 1200 ? <details><summary className="cursor-pointer">{t("prDraft.body")}</summary><Markdown>{values.body}</Markdown></details> : <Markdown>{values.body}</Markdown>}
    {e.briefingError !== undefined && <div className="mt-2 text-amber-600 dark:text-amber-400" role="alert">{t("prDraft.briefingError", { reason: e.briefingError })}</div>}
    {latest && stale && <div className="mt-2 text-muted-foreground">{t("prDraft.stale")}</div>}
    {available && <div className="mt-3 flex gap-2">
      {stale ? <Button size="sm" disabled={busy} onClick={() => void act(true)}>{t("prDraft.again")}</Button> : <>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => { setEditValues(values); setEditManagedIssue(initialManagedIssue); setEditing(true); }}>{t("prDraft.edit")}</Button>
        <Button size="sm" disabled={busy} onClick={() => void act(false)}>{busy && <Loader2 className="animate-spin" />}{t("prDraft.confirm")}</Button>
      </>}
    </div>}
    {error && <div className="mt-2 text-destructive" role="alert">{error}</div>}
    <Dialog open={editing} onOpenChange={setEditing}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader><DialogTitle>{t("prDraft.edit")}</DialogTitle></DialogHeader>
        <label className="space-y-1">{t("prDraft.branch")}<Input value={editValues.branch} readOnly={e.published} onChange={(event) => setEditValues({ ...editValues, branch: event.target.value })} /></label>
        {!e.published && <label className="space-y-1">{t("prDraft.commit")}<Textarea value={editValues.commitMessage ?? ""} onChange={(event) => setEditValues({ ...editValues, commitMessage: event.target.value })} /></label>}
        <label className="space-y-1">{t("prDraft.title")}<Input value={editValues.title} onChange={(event) => setEditValues({ ...editValues, title: event.target.value })} /></label>
        <IssueLinkFields issue={String(editValues.issue ?? "")} completion={editValues.issueCompletion ?? (editValues.issue ? "complete" : "partial")} onChange={(number, mode) => {
          const issue = number ? Number(number) : null;
          if (issue !== null && (!Number.isSafeInteger(issue) || issue <= 0)) return;
          const link = { issue: issue === null ? null : { number: issue, url: "" }, issueCompletion: mode };
          try {
            const main = splitBriefingAppendix(editValues.body)?.main ?? editValues.body;
            const body = updateManagedIssue(main, editManagedIssue, managedIssueBlock(link)) + editValues.body.slice(main.length);
            setEditValues({ ...editValues, issue, issueCompletion: mode, body }); setEditManagedIssue(managedIssueBlock(link)); setError(null);
          } catch { setError(t("issueLink.conflict")); }
        }} />
        <label className="space-y-1">{t("prDraft.body")}<Textarea className="min-h-64" value={splitBriefingAppendix(editValues.body)?.main ?? editValues.body} onChange={(event) => { const main = splitBriefingAppendix(editValues.body)?.main; setEditValues({ ...editValues, body: event.target.value + (main !== undefined ? editValues.body.slice(main.length) : "") }); }} /></label>
        <DialogFooter><Button disabled={busy} onClick={() => {
          setBusy(true);
          let body = editValues.body;
          if (editValues.issue === null && initialManagedIssue && !initialManagedIssue.includes("<!-- agent-hub:issue -->")) {
            // An unmarked legacy line cannot prove its own removal. Submit its exact suffix for
            // the host to remove, after the editor has checked it before applying the selection.
            const main = splitBriefingAppendix(body)?.main ?? body;
            body = main + initialManagedIssue + body.slice(main.length);
          }
          void client.editPrDraft(task.id, { draftId: e.id, ...editValues, body }).then(() => { setValues(editValues); setEditing(false); }, (err: unknown) => setError(String(err))).finally(() => setBusy(false));
        }}>{t("prDraft.save")}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </div>;
}

function ProposalCard({ event: e, task, onSelectTask }: { event: Extract<TaskEvent, { type: "task_proposal" }>; task: Task } & ProposalActions) {
  useLanguage();
  const [starting, setStarting] = useState(false);
  const prefill = useMemo(() => ({ title: e.title, message: e.spec, repoPath: task.cwd ?? undefined,
    testCommand: e.testCommand, ticket: e.ticket, base: e.base ?? task.options.planCheckout?.ref, scopeEstimate: e.scopeEstimate, issue: e.issue?.number ?? null, issueCompletion: e.issueCompletion,
    fromProposal: { taskId: task.id, eventId: e.id } }),
    [e.id, e.title, e.spec, e.testCommand, e.ticket, e.base, task.options.planCheckout?.ref, e.scopeEstimate?.maxFiles, e.scopeEstimate?.maxChangedLines, e.issue?.number, e.issueCompletion, task.id, task.cwd]);
  return (
    <div className="rounded-lg border border-amber-500/50 bg-amber-500/5 p-3 text-sm">
      <div className="mb-2 font-semibold">{e.title}</div>
      <div className="mb-2 text-xs text-muted-foreground">{t("proposal.issue")} <IssueLinkLabel issue={e.issue} completion={e.issueCompletion} /></div>
      {e.spec.length > 1200 ? (
        <details>
          <summary className="mb-2 cursor-pointer text-muted-foreground">{t("proposal.spec")}</summary>
          <Markdown>{e.spec}</Markdown>
        </details>
      ) : <Markdown>{e.spec}</Markdown>}
      {e.ticket && <div className="mt-2 text-xs text-muted-foreground">{t("newTask.ticket")} {e.ticket}</div>}
      {e.knownRisks?.length ? <div className="mt-2 text-xs" data-proposal-risks=""><div className="font-medium">{t("proposal.knownRisks")}</div>
        <ul className="ml-4 list-disc space-y-1">{e.knownRisks.map((risk, i) => <li key={i}>{risk}</li>)}</ul></div> : null}
      {e.base && <div className="mt-2 text-xs text-muted-foreground">{t("proposal.base")} <code>{e.base}</code></div>}
      {e.testCommand && <div className="mt-2 text-xs text-muted-foreground">{t("proposal.testCommand")} <code>{e.testCommand}</code></div>}
      {!e.startedTaskId && <>
        <Button size="sm" variant="outline" className="mt-3" onClick={() => setStarting(true)}>{t("issueLink.start")}</Button>
        <NewTaskDialog open={starting} onOpenChange={setStarting} prefill={prefill} onCreate={async input => { const worker = await client.createTask(input); onSelectTask(worker.id); }} />
      </>}
      {e.startedTaskId && <div className="mt-3">
        <a href={`?task=${encodeURIComponent(e.startedTaskId)}`} className="font-medium text-primary underline" onClick={(event) => { event.preventDefault(); onSelectTask(e.startedTaskId!); }}>
          {t("proposal.started")}
        </a>
      </div>}
    </div>
  );
}

/** A question for the user, e.g. approving a tool call that `auto` mode escalated. */
function WaitingUserCard({ event: e, task }: { event: Extract<TaskEvent, { type: "waiting_user" }>; task: Task }) {
  useLanguage();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = !e.answer && task.status === "waiting_user";
  const choose = async (answer: string) => {
    setBusy(true);
    setError(null);
    try {
      await client.answer(task.id, e.id, answer);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={cn("rounded-lg border px-3 py-2 text-sm", open ? "border-amber-500/60 bg-amber-500/5" : "opacity-80")}>
      <div className="font-medium">{e.prompt}</div>
      {e.detail && <pre className="mt-1.5 overflow-x-auto rounded bg-muted px-2 py-1.5 font-mono text-xs whitespace-pre-wrap">{e.detail}</pre>}
      {e.reason && <div className="mt-1.5 text-xs text-muted-foreground">{e.reason}</div>}
      {open ? (
        <div className="mt-2 flex flex-wrap gap-2">
          {e.options.map((o) => (
            <Button key={o} size="sm" variant={o === "Allow" ? "default" : "outline"} disabled={busy} onClick={() => void choose(o)}>
              {o}
            </Button>
          ))}
        </div>
      ) : (
        <div className="mt-1.5 text-xs text-muted-foreground">{e.answer ? t("chat.answer", { answer: e.answer }) : t("chat.noLongerWaiting")}</div>
      )}
      {error && <div className="mt-1.5 text-xs text-red-600 dark:text-red-400">{error}</div>}
    </div>
  );
}

export function AgentLabel({ name, role, agent, retired }: { name?: string; role?: string; agent?: string; retired?: boolean }) {
  useLanguage();
  return (
    <div className="mb-1 flex items-center gap-1.5 text-xs font-medium">
      <span className={cn("size-1.5 rounded-full", agent === "codex" ? "bg-violet-500" : "bg-orange-500")} />
      {name ?? t("role.agent")}
      {retired && <span className="text-muted-foreground">· {t("handoff.retired")}</span>}
      {role && role !== "main" && <span className="font-normal text-muted-foreground">· {role === "author" || role === "reviewer" || role === "explainer" || role === "writer" ? roleLabel(role) : role}</span>}
    </div>
  );
}

const EFFECT_STYLE = {
  ssh: "border-red-500/40 text-red-600 dark:text-red-400",
  git: "border-sky-500/40 text-sky-600 dark:text-sky-400",
  shell: "border-amber-500/40 text-amber-600 dark:text-amber-400",
} as const;

function ToolRow({ event: e, live }: { event: Extract<TaskEvent, { type: "tool_call" }>; live: boolean }) {
  useLanguage();
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-md border bg-muted/30 text-xs">
      <button className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left" onClick={() => setOpen(!open)}>
        <ChevronRight className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")} />
        <span className="font-medium">{e.name}</span>
        <code className="min-w-0 flex-1 truncate text-muted-foreground">{e.input}</code>
        {e.sideEffect !== "none" && (
          <Badge variant="outline" className={cn("h-4 px-1.5 text-[10px]", EFFECT_STYLE[e.sideEffect])}>
            {e.sideEffect}
          </Badge>
        )}
        {e.pending &&
          (live ? (
            <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
          ) : (
            // The run ended while this call was in flight: it may or may not have completed.
            <Badge variant="outline" className="h-4 border-orange-500/50 px-1.5 text-[10px] text-orange-600 dark:text-orange-400">
              {t("common.unknown")}
            </Badge>
          ))}
      </button>
      {open && (
        <pre className="overflow-x-auto border-t px-3 py-2 font-mono whitespace-pre-wrap">
          <span className="text-muted-foreground">$ {e.input}</span>
          {"\n"}
          {e.output ?? (e.pending ? (live ? t("chat.toolRunning") : t("chat.noRecordedOutput")) : t("common.noOutput"))}
        </pre>
      )}
    </div>
  );
}

/**
 * design.md §8: an interrupted run is never retried automatically. Show which side-effecting calls
 * may already have happened, so the decision (continue / restart / end) is an informed one.
 */
function InterruptedBanner({ taskId, events }: { taskId: string; events: TaskEvent[] }) {
  useLanguage();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = async (action: RecoverAction) => {
    setBusy(true);
    setError(null);
    try {
      await client.recover(taskId, action);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const risky = events.filter((e): e is Extract<TaskEvent, { type: "tool_call" }> => e.type === "tool_call" && e.sideEffect !== "none").slice(-3);
  const unfinished = risky.filter((e) => e.pending);
  return (
    <div className="rounded-lg border border-orange-500/50 bg-orange-500/5 p-3 text-sm">
      <div className="flex items-center gap-2 font-medium">
        <TriangleAlert className="size-4 text-orange-500" /> {t("chat.interrupted")}
      </div>
      {unfinished.length > 0 && (
        <div className="mt-2 text-xs">
          <div className="text-muted-foreground">{t("chat.maybeCompleted")}</div>
          {unfinished.map((e) => (
            <code key={e.id} className="mt-1 block">
              [{e.sideEffect}] {e.input}
            </code>
          ))}
        </div>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" disabled={busy} onClick={() => act("continue")} title={t("chat.continueHint")}>
          {t("chat.continue")}
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => act("restart")} title={t("chat.restartHint")}>
          {t("chat.restart")}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => act("end")}>
          {t("chat.endTask")}
        </Button>
      </div>
      {error && <div className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</div>}
    </div>
  );
}

function Replyable({ event, onReply, children }: { event: Extract<TaskEvent, { type: "user_message" | "agent_text" }>; onReply?: RoomTranscriptActions["onReply"]; children: ReactNode }) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [pressed, setPressed] = useState(false);
  const part = useRef<string | undefined>(undefined);
  const capture = (element: HTMLElement) => {
    const selection = window.getSelection();
    part.current = selection && !selection.isCollapsed && selection.anchorNode && selection.focusNode && element.contains(selection.anchorNode) && element.contains(selection.focusNode) ? selection.toString() : undefined;
  };
  const clear = () => { if (timer.current) clearTimeout(timer.current); };
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  if (!onReply) return children;
  return <div id={`room-event-${event.id}`} className="group relative"
    onPointerDown={e => { capture(e.currentTarget); if (e.pointerType === "touch") timer.current = setTimeout(() => setPressed(true), 500); }}
    onPointerUp={clear} onPointerCancel={clear} onPointerMove={clear}>
    <div onMouseUp={e => capture(e.currentTarget)}>{children}</div>
    <Button size="sm" variant="ghost" className={cn("text-xs opacity-0 group-hover:opacity-100 focus:opacity-100", pressed && "opacity-100")}
      onMouseDown={e => e.preventDefault()} onClick={() => onReply(event, part.current)}>{t("room.reply")}</Button>
  </div>;
}
