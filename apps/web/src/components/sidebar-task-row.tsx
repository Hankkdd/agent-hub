import type { Task } from "@agent-hub/shared";
import { Pin, MessagesSquare } from "lucide-react";
import { t, useLanguage } from "@/i18n";
import { cn } from "@/lib/utils";
import type { TaskRow } from "@/lib/task-groups";
import { StatusDot, activityLabel, quotaPauseText, statusLabel } from "./status";
import { STATE_LABELS } from "./sidebar-project";

export interface PinActionState { pending?: boolean; error?: boolean }

export function SidebarTaskRow(props: TaskRow & {
  selectedId: string | null;
  onSelect: (id: string) => void;
  onPin: (task: Task) => void;
  pinState?: PinActionState;
  context?: string;
}) {
  useLanguage();
  const { task, state, depth, pinState } = props;
  const pinned = !!task.options.pinnedAt;
  const action = t(pinned ? "sidebar.unpinTask" : "sidebar.pinTask", { task: `${task.title} (${task.id})` });
  return <div style={{ paddingLeft: depth * 20 }} className="min-w-0">
    <div className={cn("flex min-w-0 items-start rounded-md hover:bg-sidebar-accent", props.selectedId === task.id && "bg-sidebar-accent")}>
      <button type="button" onClick={() => props.onSelect(task.id)} className="flex min-w-0 flex-1 items-start gap-2.5 rounded-md px-2 py-2 text-left">
        <StatusDot status={task.status === "failed" || task.status === "interrupted" || task.status === "paused" ? task.status : state === "running" ? "running" : state === "needsYou" ? "waiting_user" : state === "finished" ? "done" : "idle"} className="mt-1.5" />
        <span className="block min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="block min-w-0 truncate text-sm" title={task.title}>{task.workflow === "room" && <MessagesSquare aria-label={t("workflow.room")} className="mr-1 inline size-3" />}{task.title}</span>
            {task.options.transcriptOnly && <span className="shrink-0 rounded border px-1 text-[10px] leading-4 text-muted-foreground">{t("task.transcriptOnly")}</span>}
          </span>
          <span className="block truncate text-xs text-muted-foreground">{task.status === "paused" && task.options.quotaPause ? quotaPauseText(task.options.quotaPause) : task.status === "failed" || task.status === "interrupted" || task.status === "paused" ? statusLabel(task.status) : state === "running" && task.status === "running" ? activityLabel(task.activity) ?? t(STATE_LABELS[state]) : t(STATE_LABELS[state])}</span>
          {props.context && <span className="block truncate text-xs text-muted-foreground" title={props.context}>{props.context}</span>}
        </span>
      </button>
      <button type="button" aria-label={action} title={action} aria-pressed={pinned} aria-busy={!!pinState?.pending}
        disabled={!!pinState?.pending} onClick={() => props.onPin(task)}
        className={cn("flex min-h-11 w-9 shrink-0 items-center justify-center rounded-md hover:bg-sidebar-accent disabled:opacity-50", pinned ? "text-primary" : "text-muted-foreground")}>
        <Pin aria-hidden="true" className={cn("size-4", pinned && "fill-current", pinState?.pending && "animate-pulse")} />
      </button>
    </div>
    {pinState?.pending && <p role="status" className="px-2 text-xs text-muted-foreground">{t("sidebar.pinPending")}</p>}
    {pinState?.error && <p role="alert" className="px-2 text-xs text-destructive">{t("sidebar.pinError")}</p>}
  </div>;
}
