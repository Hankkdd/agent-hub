import { useState } from "react";
import type { Task, TaskEvent } from "@agent-hub/shared";
import { t, useLanguage } from "@/i18n";
import { client } from "@/lib/client";
import { Button } from "./ui/button";

export function FindingCard({ finding, events, task }: { finding: Extract<TaskEvent, { type: "finding_recorded" }>; events: TaskEvent[]; task: Task }) {
  useLanguage();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const result = events.filter((e) => e.type === "finding_export" && e.observationIds.includes(finding.id)).at(-1);
  const state = result?.type === "finding_export" ? result.state : task.options.findingExport ? "pending" : "unconfigured";
  const document = result?.type === "finding_export" ? result.document ?? finding.existingDocument : finding.existingDocument;
  const retry = async () => {
    setBusy(true); setError("");
    try { await client.retryFindingExport(task.id); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  };
  return <div className="rounded-lg border p-3 text-sm">
    <div className="font-medium">{t("finding.title")} · {finding.title}</div>
    <div className="text-xs text-muted-foreground">{finding.topic} · {t(`finding.${state}`)}</div>
    <p className="my-2 whitespace-pre-wrap">{finding.evidence}</p>
    <div className="text-xs text-muted-foreground">{t("finding.authority")}</div>
    {document && <div className="break-all font-mono text-xs">{document}</div>}
    {result?.type === "finding_export" && <>
      {result.commit && <div className="break-all font-mono text-xs">{result.commit}</div>}
      {result.reason && <p className="text-xs text-amber-700 dark:text-amber-400">{result.reason}</p>}
    </>}
    {["pending", "conflict"].includes(state) && <Button size="sm" variant="outline" className="mt-2" disabled={busy || task.status === "running" || task.status === "waiting_user"} onClick={() => void retry()}>{t("finding.retry")}</Button>}
    {error && <p className="text-xs text-red-600">{error}</p>}
  </div>;
}
