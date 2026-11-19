import { useEffect } from "react";
import { t, useLanguage } from "@/i18n";
import type { Task, TaskEvent } from "@agent-hub/shared";

/** The raw event log: what actually happened, in seq order. Useful for debugging a workflow. */
export function EventsTab({ task, events, sourceEvent }: { task: Task; events: TaskEvent[]; sourceEvent?: string }) {
  useLanguage();
  useEffect(() => { if (sourceEvent) document.getElementById(`event-${sourceEvent}`)?.scrollIntoView({ block: "center" }); }, [sourceEvent]);
  const sessionName = (id: string | null) => {
    const s = task.sessions.find((x) => x.id === id);
    return s ? `${s.agent}/${s.role}` : t("events.system");
  };
  return (
    <div className="overflow-x-auto p-4">
      <table className="w-full text-xs">
        <thead className="text-left text-muted-foreground">
          <tr className="border-b">
            <th className="py-1.5 pr-3 font-medium">{t("events.seq")}</th>
            <th className="py-1.5 pr-3 font-medium">{t("events.time")}</th>
            <th className="py-1.5 pr-3 font-medium">{t("events.session")}</th>
            <th className="py-1.5 pr-3 font-medium">{t("events.type")}</th>
            <th className="py-1.5 font-medium">{t("events.payload")}</th>
          </tr>
        </thead>
        <tbody className="font-mono">
          {events.map((e) => (
            <tr id={`event-${e.id}`} key={e.id} className={`border-b align-top last:border-0 ${e.id === sourceEvent ? "bg-muted" : ""}`}>
              <td className="py-1.5 pr-3 text-muted-foreground">{e.seq}</td>
              <td className="py-1.5 pr-3 whitespace-nowrap text-muted-foreground">{new Date(e.createdAt).toLocaleTimeString()}</td>
              <td className="py-1.5 pr-3 whitespace-nowrap">{sessionName(e.sessionId)}</td>
              <td className="py-1.5 pr-3 whitespace-nowrap">{e.type}</td>
              <td className="max-w-md truncate py-1.5 text-muted-foreground">{e.type === "invocation_started" || e.type === "invocation_finished" ? <details><summary>{e.callId}</summary><pre className="max-w-md whitespace-pre-wrap break-all">{summarize(e)}</pre></details> : summarize(e)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function summarize(e: TaskEvent): string {
  const { id: _id, taskId: _t, sessionId: _s, seq: _q, createdAt: _c, type: _y, ...rest } = e;
  return JSON.stringify(rest);
}
