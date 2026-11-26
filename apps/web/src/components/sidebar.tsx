import { DeployDialog } from "./deploy-dialog";
import { useEffect, useRef, useState } from "react";
import { QuotaSummary } from "./quota-summary";
import type { QuotaState } from "./quota-scheduler";
import { ResizablePanel } from "@/components/resizable-panel";
import type { TranslationKey } from "@/i18n/en";
import { setLanguage, t, useLanguage } from "@/i18n";
import { ChevronDown, ChevronRight, Cloud, Languages, MessageSquarePlus, Plus, Rocket, Server, Sparkles, type LucideIcon } from "lucide-react";
import type { Task } from "@agent-hub/shared";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { SidebarTaskRow, type PinActionState } from "./sidebar-task-row";
import { client, useTaskSummaries, type Connection } from "@/lib/client";
import { cn } from "@/lib/utils";
import { COLLAPSED_STATES, DISPLAY_STATES, groupTasks, pinnedShortcuts, type TaskRow } from "@/lib/task-groups";

import { PROJECT_PREFERENCE, readProjectCollapse, SidebarProject, STATE_LABELS } from "./sidebar-project";

const CONNECTION: Record<Connection, { text: TranslationKey; dot: string }> = {
  connecting: { text: "connection.connecting", dot: "bg-muted-foreground/50" },
  live: { text: "connection.live", dot: "bg-emerald-500" },
  reconnecting: { text: "connection.reconnecting", dot: "bg-orange-500 animate-pulse" },
  unauthorized: { text: "connection.unauthorized", dot: "bg-red-500" },
};

export function Sidebar(props: {
  onGoogle?: () => void;
  claudeRuntime?: "host" | "docker" | null;
  onClaudeLogin?: () => void;
  onAntigravity?: () => void;
  quota: QuotaState;
  refreshQuota: () => unknown;
  tasks: Task[];
  selectedId: string | null;
  connection: Connection;
  onSelect: (id: string) => void;
  onNew: () => void;
  onNewChat: () => void;
  devicesOpen: boolean;
  onDevices: () => void;
  onDocuments?: () => void;
  documentsOpen?: boolean;
  documentsDirty?: boolean;
}) {
  const language = useLanguage();
  const [deployOpen, setDeployOpen] = useState(false);
  const summaries = useTaskSummaries();
  const projects = groupTasks(props.tasks, summaries);
  const shortcuts = pinnedShortcuts(projects);
  const [pinStates, setPinStates] = useState<Record<string, PinActionState>>({});
  const pinRequests = useRef(new Set<string>());
  const onPin = async (task: Task) => {
    if (pinRequests.current.has(task.id)) return;
    pinRequests.current.add(task.id);
    setPinStates((current) => ({ ...current, [task.id]: { pending: true } }));
    try {
      await client.setPinned(task.id, !task.options.pinnedAt);
      setPinStates((current) => ({ ...current, [task.id]: {} }));
    } catch {
      setPinStates((current) => ({ ...current, [task.id]: { error: true } }));
    } finally {
      pinRequests.current.delete(task.id);
    }
  };
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => {
    try { return readProjectCollapse(localStorage); }
    catch { return {}; }
  });
  const selectedProject = projects.find((p) => DISPLAY_STATES.some((s) => p.groups[s].some((r) => r.task.id === props.selectedId)))?.id;
  const revealed = useRef<string | null>(null);
  useEffect(() => {
    // A first deep link may resolve after the task list arrives. Stream updates do not reopen it.
    if (!props.selectedId || !selectedProject) { revealed.current = null; return; }
    const selection = `${props.selectedId}:${selectedProject}`;
    if (revealed.current === selection) return;
    revealed.current = selection;
    setCollapsed((current) => ({ ...current, [selectedProject]: false }));
  }, [props.selectedId, selectedProject]);
  useEffect(() => {
    try { localStorage.setItem(PROJECT_PREFERENCE, JSON.stringify(collapsed)); }
    catch { /* Browser preferences are optional. */ }
  }, [collapsed]);
  return (
    <ResizablePanel storageKey="agent-hub-sidebar-width" defaultWidth={288} minWidth={200} maxWidth={520} className="h-full">
      <aside className="flex h-full min-w-0 flex-col border-r bg-sidebar text-sidebar-foreground max-md:w-full max-md:border-r-0 max-md:border-b">
        <div className="flex items-center justify-between px-4 pt-4 pb-3 max-md:gap-2 md:flex-wrap md:gap-2">
          <div className="max-md:min-w-0">
            <div className="text-sm font-semibold">{t("app.name")}</div>
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className={cn("size-1.5 rounded-full max-md:shrink-0", CONNECTION[props.connection].dot)} />
              <span className="max-md:truncate">{t(CONNECTION[props.connection].text)}</span>
            </div>
          </div>
          <div className="flex gap-1.5 md:shrink-0 md:flex-wrap md:justify-end">
            <Button size="sm" onClick={props.onNewChat} title={t("sidebar.chatHint")}>
              <MessageSquarePlus /> {t("sidebar.chat")}
            </Button>
            <Button size="sm" variant="outline" onClick={props.onNew} title={t("sidebar.taskHint")}>
              <Plus /> {t("sidebar.task")}
            </Button>
          </div>
        </div>
        <Button variant={props.documentsOpen ? "secondary" : "ghost"} className="mx-2 mb-2 justify-start" onClick={props.onDocuments} aria-current={props.documentsOpen ? "page" : undefined}>{t("documents.title")}{props.documentsDirty ? " *" : ""}</Button>
        <QuotaSummary claudeRuntime={props.claudeRuntime} state={props.quota} refresh={props.refreshQuota} onClaudeLogin={props.onClaudeLogin} />
        <ScrollArea className="min-h-0 min-w-0 flex-1 [&_[data-slot=scroll-area-viewport]>div]:block!">
          {shortcuts.length > 0 && <section className="px-2 pb-3" aria-label={t("sidebar.pinned")}>
            <div className="px-2 py-2 text-sm font-semibold">{t("sidebar.pinned")}</div>
            {shortcuts.map((row) => <SidebarTaskRow key={row.task.id} {...row} selectedId={props.selectedId} onSelect={props.onSelect}
              onPin={onPin} pinState={pinStates[row.task.id]}
              context={[row.project.name ?? t("sidebar.other"), row.project.pathHint, row.parentTitle ? t("sidebar.pinParent", { parent: row.parentTitle }) : undefined].filter(Boolean).join(" · ")} />)}
          </section>}
          {projects.map((project) => <SidebarProject key={project.id} project={project} collapsed={!!collapsed[project.id]}
            onToggle={() => setCollapsed((current) => ({ ...current, [project.id]: !current[project.id] }))}>
            {DISPLAY_STATES.map((state) => <TaskGroup key={state} title={t(STATE_LABELS[state])} tasks={project.groups[state]} startCollapsed={COLLAPSED_STATES.includes(state)} selectedId={props.selectedId} onSelect={props.onSelect} onPin={onPin} pinStates={pinStates} />)}
          </SidebarProject>)}
        </ScrollArea>
        <div className="sidebar-footer grid grid-cols-5 gap-1 border-t p-1.5">
          <FooterButton icon={Server} label={t("footer.devices")} title={t("app.devices")} active={props.devicesOpen} onClick={props.onDevices} />
          <FooterButton icon={Cloud} label={t("footer.google")} title={t("google.title")} onClick={props.onGoogle} />
          <FooterButton icon={Sparkles} label={t("claudeLogin.title")} title={t("claudeLogin.title")} onClick={props.onClaudeLogin} />
          <FooterButton icon={Sparkles} label={t("footer.antigravity")} title={t("antigravity.title")} onClick={props.onAntigravity} />
          <FooterButton icon={Rocket} label={t("footer.deploy")} title={t("deploy.title")} onClick={() => setDeployOpen(true)} />
          <FooterButton icon={Languages} label={t(language === "zh-TW" ? "footer.languageEn" : "footer.languageZh")} title={t("language.toggle")}
            onClick={() => setLanguage(language === "zh-TW" ? "en" : "zh-TW")} />
        </div>
        <DeployDialog open={deployOpen} onOpenChange={setDeployOpen} tasks={props.tasks} />
      </aside>
    </ResizablePanel>
  );
}

/** One icon with a short caption: phones have no hover, so the icon alone would be a guess. */
export function FooterButton(props: { icon: LucideIcon; label: string; title: string; active?: boolean; onClick?: () => void }) {
  const Icon = props.icon;
  return (
    <button type="button" onClick={props.onClick} title={props.title} aria-label={props.title}
      className={cn("flex min-w-0 flex-col items-center justify-center gap-0.5 rounded-md px-1 py-1.5 text-[11px] leading-tight text-muted-foreground hover:bg-sidebar-accent hover:text-foreground",
        props.active && "bg-sidebar-accent text-foreground")}>
      <Icon className="size-4 shrink-0" aria-hidden="true" />
      <span className="w-full truncate text-center">{props.label}</span>
    </button>
  );
}

function TaskGroup(props: { title: string; tasks: TaskRow[]; selectedId: string | null; onSelect: (id: string) => void; onPin: (task: Task) => void; pinStates: Record<string, PinActionState>; startCollapsed?: boolean }) {
  useLanguage();
  // Opened automatically when the selected task is inside, so selecting it from a link never hides it.
  const holdsSelected = props.tasks.some((r) => r.task.id === props.selectedId);
  const [collapsed, setCollapsed] = useState(!!props.startCollapsed);
  if (props.tasks.length === 0) return null;
  const label = t("sidebar.stateCount", { state: props.title, count: props.tasks.filter((r) => r.depth === 0).length });
  const shut = collapsed && !holdsSelected;
  return (
    <div className="px-2 pb-3">
      {props.startCollapsed
        ? <button type="button" aria-expanded={!shut} onClick={() => setCollapsed(!shut)}
          className="flex w-full items-center gap-1 px-2 pb-1 text-left text-[11px] font-medium tracking-wide text-muted-foreground uppercase hover:text-foreground">
          {shut ? <ChevronRight aria-hidden="true" className="size-3" /> : <ChevronDown aria-hidden="true" className="size-3" />}{label}
        </button>
        : <div className="px-2 pb-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{label}</div>}
      {!shut && props.tasks.map((row) => <SidebarTaskRow key={row.task.id} {...row} selectedId={props.selectedId} onSelect={props.onSelect}
        onPin={props.onPin} pinState={props.pinStates[row.task.id]} />)}
    </div>
  );
}
