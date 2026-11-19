import { useState } from "react";
import { TriangleAlert } from "lucide-react";
import type { Task, TaskEvent } from "@agent-hub/shared";
import { t, useLanguage } from "@/i18n";
import { client, label } from "@/lib/client";
import { Button } from "./ui/button";
import { quotaPauseText, statusLabel } from "./status";
import { SwitchAgentDialog } from "./switch-agent-dialog";

/** The agent hit a usage limit: the Hub continues by itself after the reset; these are the user's other options. */
export function QuotaPauseBanner({ task, events }: { task: Task; events: TaskEvent[] }) {
  useLanguage();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pause = task.options.quotaPause;
  const act = async (run: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try { await run(); } catch (err) { setError(err instanceof Error ? err.message : String(err)); } finally { setBusy(false); }
  };
  return (
    <div className="min-w-0 [overflow-wrap:anywhere] rounded-lg border border-amber-500/50 bg-amber-500/5 p-3 text-sm">
      <div className="flex items-center gap-2 font-medium">
        <TriangleAlert className="size-4 shrink-0 text-amber-500" /> {pause ? quotaPauseText(pause) : statusLabel(task.status)}
      </div>
      <div className="mt-1 text-xs text-muted-foreground">{t("quotaPause.hint")}</div>
      <div className="mt-3 flex flex-wrap gap-2 [&_button]:h-auto [&_button]:min-h-8 [&_button]:max-w-full [&_button]:whitespace-normal">
        <Button size="sm" disabled={busy} onClick={() => act(() => client.continueNow(task.id))}>{t("quotaPause.continueNow")}</Button>
        <SwitchAgentDialog task={task} events={events} triggerLabel={(target) => t("quotaPause.switchTo", { agent: label(target) })} />
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => act(() => client.stopWaiting(task.id))}>{t("quotaPause.stopWaiting")}</Button>
      </div>
      {error && <div className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</div>}
    </div>
  );
}
