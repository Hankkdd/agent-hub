import { VideoAnalysisPanel } from "./video-analysis";
import { TaskUsage } from "./task-usage";
import { activeMainSession } from "@agent-hub/shared";
import { SwitchAgentDialog } from "./switch-agent-dialog";
import { t, useLanguage } from "@/i18n";
import { useRef, useState } from "react";
import type { Task } from "@agent-hub/shared";
import { FileDiff, FileText, List, MessagesSquare, MessageSquare, Trash2 } from "lucide-react";
import { PhoneBack } from "@/components/phone-back";
import { usePhone } from "@/lib/use-phone";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ChatTab } from "@/components/chat-tab";
import { QuotaPauseBanner } from "@/components/quota-pause-banner";
import { Composer } from "@/components/composer";
import { DiffTab } from "@/components/diff-tab";
import { EventsTab } from "@/components/events-tab";
import { StatusDot, activityLabel, quotaPauseText, statusLabel, workflowLabel, roleLabel, effortLabel } from "@/components/status";
import { client, label, useEvents, useTasks } from "@/lib/client";
import { AskCard } from "@/components/ask-card";

export function TaskView({ task, onSelectTask, onBack }: { onBack: () => void; task: Task; onSelectTask: (id: string) => void }) {
  useLanguage();
  const events = useEvents(task.id);
  const [tab, setTab] = useState("chat");
  const [sourceEvent, setSourceEvent] = useState<string>();
  const tasks = useTasks();
  const planner = tasks.find((t) => t.id === task.options.reportsTo);
  const composer = useRef<HTMLTextAreaElement>(null);
  const ask = events.find((e) => e.type === "ask" && !e.answer && !e.superseded);
  const plannerId = task.options.reportsTo;
  const plannerTitle = planner?.title ?? plannerId ?? "";
  const phone = usePhone();
  const activity = task.status === "paused" && task.options.quotaPause ? quotaPauseText(task.options.quotaPause) : activityLabel(task.activity) ?? statusLabel(task.status);
  const metadata = (
    <>
      <span>{task.workflow === "room" && <MessagesSquare className="mr-1 inline size-4" aria-hidden="true" />}{workflowLabel(task.workflow)}</span>
      {task.options.transcriptOnly && <Badge variant="outline" className="h-5 px-1.5 text-[11px]">{t("task.transcriptOnly")}</Badge>}
      {planner && <span>{t("task.reportsTo")} <a href={`?task=${encodeURIComponent(planner.id)}`} className="underline" onClick={(event) => { event.preventDefault(); onSelectTask(planner.id); }}>{planner.title}</a></span>}
      {task.options.ticket && (
        task.options.ticketUrl
          ? <a href={task.options.ticketUrl} target="_blank" rel="noreferrer" className="underline">{task.options.ticket}</a>
          : <span>{task.options.ticket}</span>
      )}
      {task.options.appliedRules?.map((pack) => (
        <Badge key={pack.tag} variant="outline" className="h-5 px-1.5 text-[11px]" title={t("task.appliedRule")}>
          {pack.tag} · {pack.sha256.slice(0, 7)}
        </Badge>
      ))}
      {task.sessions.filter((s) => !["chat", "plan"].includes(task.workflow) || s.id === activeMainSession(task)?.id).map((s) => (
        <Badge key={s.id} variant="secondary" className="h-5 px-1.5 text-[11px]" title={t("task.sessionTitle", { agent: label(s.agent), model: s.model ? ` (${s.model})` : "", effort: effortLabel(s.effort) })}>
          {label(s.agent)}
          {s.role !== "main" && ` · ${roleLabel(s.role)}`}
          <span className="text-muted-foreground">
            {" · "}
            {s.model ? `${s.model} · ` : ["chat", "plan"].includes(task.workflow) ? `${t("handoff.defaultModel")} · ` : ""}
            {effortLabel(s.effort)}
          </span>
        </Badge>
      ))}
    </>
  );
  const actions = (
    <>
      <SwitchAgentDialog task={task} events={events} />
      {task.workflow === "video" && (
        <Button size="sm" variant="outline" asChild>
          {/* Same origin, so the auth cookie goes along; the browser shows the Markdown as text. */}
          <a href={`/api/tasks/${task.id}/transcript`} target="_blank" rel="noreferrer">
            <FileText /> {t("task.transcript")}
          </a>
        </Button>
      )}
      <Button
        size="icon"
        variant="ghost"
        aria-label={t("task.delete")}
        title={task.status === "running" || task.status === "waiting_user" ? t("task.stopBeforeDelete") : t("task.delete")}
        disabled={task.status === "running" || task.status === "waiting_user"}
        onClick={() => {
          const note = task.workspace?.state === "active" ? t("task.deleteWorktree") : "";
          if (window.confirm(t("task.deleteConfirm", { title: task.title, note }))) void client.deleteTask(task.id).catch((err) => window.alert(String(err)));
        }}
      >
        <Trash2 />
      </Button>
    </>
  );
  const tabs = (
    <TabsList className={phone ? "shrink-0" : undefined}>
      <TabsTrigger value="chat" aria-label={t("sidebar.chat")} title={t("sidebar.chat")}>{phone ? <MessageSquare /> : t("sidebar.chat")}</TabsTrigger>
      <TabsTrigger value="diff" aria-label={t("task.diff")} title={t("task.diff")}>{phone ? <FileDiff /> : t("task.diff")}</TabsTrigger>
      <TabsTrigger value="events" aria-label={t("task.events")} title={t("task.events")}>{phone ? <List /> : t("task.events")}</TabsTrigger>
    </TabsList>
  );
  return (
    <Tabs value={tab} onValueChange={setTab} className="flex h-full min-h-0 min-w-0 flex-1 flex-col gap-0">
      {phone ? (
        <header className="min-w-0 shrink-0 border-b px-2 py-1">
          <div className="flex min-w-0 items-center gap-1">
            <PhoneBack onBack={onBack} />
            <h1 className="min-w-0 flex-1 truncate text-sm font-semibold" title={task.title}>{task.title}</h1>
            {tabs}
          </div>
          <div className="flex min-w-0 items-center gap-1.5 px-2 text-xs text-muted-foreground" title={activity}>
            <StatusDot status={task.status} />
            <span className="min-w-0 truncate">{activity}</span>
          </div>
          <details className="task-details min-w-0">
            <summary className="flex cursor-pointer items-center px-2 text-xs text-muted-foreground">{t("task.details")}</summary>
            <div className="flex flex-wrap items-center gap-1.5 px-2 pb-2 text-xs text-muted-foreground">{metadata}{actions}</div>
          </details>
        </header>
      ) : <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-2.5">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold" title={task.title}>{task.title}</h1>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <StatusDot status={task.status} />
            <span>{activity}</span>
            <span>·</span>
            {metadata}
          </div>
        </div>
        {actions}
        {tabs}
      </header>}
      <TaskUsage key={task.id} taskId={task.id} events={events} noModel={task.options.transcriptOnly && !events.some((e) => e.type === "invocation_started")}
        onSource={(id) => { setSourceEvent(id); setTab("events"); }} />
      {task.options.transcriptOnly && <p className="border-b bg-muted/40 px-4 py-2 text-xs text-muted-foreground">{t("task.transcriptOnlyNote")}</p>}
      <TabsContent value="chat" className="min-h-0 min-w-0 flex-1 overflow-y-auto max-md:overflow-x-hidden">
        {plannerId && <div className="border-b bg-muted/40 px-4 py-2 text-sm"><a href={`?task=${encodeURIComponent(plannerId)}`} className="text-primary underline" onClick={(event) => { event.preventDefault(); onSelectTask(plannerId); }}>{t("planner.managedBy", { title: plannerTitle })}</a></div>}
        {task.workflow === "video" && <VideoAnalysisPanel task={task} events={events} />}
        <ChatTab task={task} events={events} onSelectTask={onSelectTask} />
      </TabsContent>
      <TabsContent value="diff" className="min-h-0 min-w-0 flex-1 max-md:overflow-hidden">
        <DiffTab task={task} events={events} onShowChat={() => setTab("chat")} />
      </TabsContent>
      <TabsContent value="events" className="min-h-0 min-w-0 flex-1 overflow-y-auto max-md:overflow-x-hidden">
        <EventsTab task={task} events={events} sourceEvent={sourceEvent} />
      </TabsContent>
      {tab === "chat" && (task.status === "paused" || ask?.type === "ask") && (
        <div className="task-action-footer min-h-0 min-w-0 max-h-[min(40%,40dvh)] shrink-0 overflow-x-hidden overflow-y-auto border-t p-3">
          <div className="mx-auto flex min-w-0 max-w-3xl flex-col gap-3 [overflow-wrap:anywhere]">
            {task.status === "paused" && <QuotaPauseBanner key={task.id} task={task} events={events} />}
            {ask?.type === "ask" && <AskCard event={ask} onOther={() => composer.current?.focus()} />}
          </div>
        </div>
      )}
      <Composer
        inputRef={composer}
        placeholder={plannerId ? t("planner.replyThere", { title: plannerTitle }) : task.status === "paused" && task.options.quotaPause ? t("composer.quotaPlaceholder") : undefined}
        running={task.status === "running" || task.status === "waiting_user"}
        onSend={(t, images) => client.sendMessage(task.id, t, images)}
        onStop={() => client.stopTask(task.id)}
      />
    </Tabs>
  );
}
