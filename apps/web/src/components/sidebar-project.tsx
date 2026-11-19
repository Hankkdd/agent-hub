import type { ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { t, useLanguage } from "@/i18n";
import type { TranslationKey } from "@/i18n/en";
import { DISPLAY_STATES, type DisplayState, type ProjectGroup } from "@/lib/task-groups";

export const STATE_LABELS: Record<DisplayState, TranslationKey> = {
  needsYou: "sidebar.needsYou", running: "sidebar.running", standby: "sidebar.standby",
  prAwaitingMerge: "sidebar.prAwaitingMerge", finished: "sidebar.finished", apiTranscripts: "sidebar.apiTranscripts",
};
export const PROJECT_PREFERENCE = "agent-hub-project-collapse";
export function readProjectCollapse(storage: Pick<Storage, "getItem">): Record<string, boolean> {
  try {
    const value: unknown = JSON.parse(storage.getItem(PROJECT_PREFERENCE) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(([, collapsed]) => typeof collapsed === "boolean"));
  } catch { return {}; }
}

export function SidebarProject(props: { project: ProjectGroup; collapsed: boolean; onToggle: () => void; children: ReactNode }) {
  useLanguage();
  const { project, collapsed } = props;
  const name = project.name ?? t("sidebar.other");
  const counts = DISPLAY_STATES.map((state) => ({ state, count: project.groups[state].filter((r) => r.depth === 0).length })).filter((s) => s.count > 0);
  const countSummary = counts.map(({ state, count }) => t("sidebar.stateCount", { state: t(STATE_LABELS[state]), count })).join(" · ");
  return <section>
    <button type="button" aria-expanded={!collapsed}
      aria-label={t(collapsed ? "sidebar.expandProject" : "sidebar.collapseProject", { project: project.pathHint ? `${name} (${project.pathHint})` : name, summary: countSummary })}
      onClick={props.onToggle}
      className="flex w-full min-w-0 items-start gap-1 px-3 py-2 text-left hover:bg-sidebar-accent">
      {collapsed ? <ChevronRight className="mt-0.5 size-4 shrink-0" /> : <ChevronDown className="mt-0.5 size-4 shrink-0" />}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold" title={project.id}>{name}</span>
        {project.pathHint && <span className="block truncate text-xs text-muted-foreground" title={project.pathHint}>{project.pathHint}</span>}
        <span className="block text-[11px] text-muted-foreground">{countSummary}</span>
      </span>
    </button>
    {!collapsed && props.children}
  </section>;
}
