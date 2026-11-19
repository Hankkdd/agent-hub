import type { TranslationKey } from "@/i18n/en";
import { t, useLanguage } from "@/i18n";
import type { AgentKind, SessionRole, TaskStatus, WorkflowId } from "@agent-hub/shared";
import { cn } from "@/lib/utils";

const STATUS: Record<TaskStatus, { label: TranslationKey; dot: string }> = {
  idle: { label: "status.idle", dot: "bg-muted-foreground/50" },
  running: { label: "status.running", dot: "bg-blue-500 animate-pulse" },
  waiting_user: { label: "status.waiting_user", dot: "bg-amber-500" },
  done: { label: "status.done", dot: "bg-emerald-500" },
  failed: { label: "status.failed", dot: "bg-red-500" },
  interrupted: { label: "status.interrupted", dot: "bg-orange-500" },
  paused: { label: "status.paused", dot: "bg-amber-500" },
};

export function StatusDot({ status, className }: { status: TaskStatus; className?: string }) {
  useLanguage();
  return <span className={cn("inline-block size-2 shrink-0 rounded-full", STATUS[status].dot, className)} aria-label={statusLabel(status)} />;
}

export function activityLabel(activity: string | null): string | null {
  return activity === "Building the toolchain image (first time only)…" ? t("activity.buildingToolchain") : activity;
}

export function statusLabel(status: TaskStatus): string {
  return t(STATUS[status].label);
}

const WORKFLOW_KEYS: Record<WorkflowId, TranslationKey> = {
  chat: "sidebar.chat",
  plan: "workflow.plan",
  implement: "workflow.implement",
  review: "workflow.review",
  video: "workflow.video",
  custom: "workflow.custom",
  room: "workflow.room",
};

export function workflowLabel(workflow: WorkflowId): string {
  return t(WORKFLOW_KEYS[workflow]);
}

export function roleLabel(role: SessionRole): string {
  return t(role === "writer" ? "role.writer" : role === "explainer" ? "role.explainer" : role === "author" ? "role.authorValue" : role === "reviewer" ? "role.reviewerValue" : "role.main");
}

export function effortLabel(effort?: string | null): string {
  const keys: Record<string, TranslationKey> = {
    minimal: "effort.minimal", low: "effort.low", medium: "effort.medium",
    high: "effort.high", xhigh: "effort.xhigh", max: "effort.max",
  };
  return effort ? (keys[effort] ? t(keys[effort]) : effort) : t("common.defaultEffort");
}

const agentName = (agent: AgentKind) => t(`agent.${agent}`);

export function fallbackText(value: { writtenBy?: AgentKind; fallbackFrom?: { agent: AgentKind } }): string | null {
  return value.fallbackFrom && value.writtenBy
    ? t("chat.fallbackWriter", { writer: agentName(value.writtenBy), agent: agentName(value.fallbackFrom.agent) }) : null;
}

export function usageLimitText(limit: { agent: AgentKind; resetsAt: string | null }): string {
  const reset = limit.resetsAt ? new Date(limit.resetsAt) : null;
  const time = reset && Number.isFinite(reset.getTime())
    ? `${reset.toDateString() !== new Date().toDateString() ? `${reset.getMonth() + 1}/${reset.getDate()} ` : ""}${new Intl.DateTimeFormat("zh-TW", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(reset)}` : null;
  return t(time ? "chat.usageLimitReset" : "chat.usageLimitUnknown", { agent: agentName(limit.agent), time: time ?? "" });
}

/** "Waiting for Codex quota, continues around 14:30"; the time is local. */
export function quotaPauseText(pause: { agent: AgentKind; resetsAt: string | null }): string {
  const reset = pause.resetsAt ? new Date(pause.resetsAt) : null;
  const time = reset && Number.isFinite(reset.getTime())
    ? `${reset.toDateString() !== new Date().toDateString() ? `${reset.getMonth() + 1}/${reset.getDate()} ` : ""}${new Intl.DateTimeFormat("zh-TW", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(reset)}` : t("quotaPause.timeUnknown");
  return t("quotaPause.waiting", { agent: agentName(pause.agent), time });
}
