import { useEffect, useRef, useState } from "react";
import type { DeployCommit, DeployStatus, Task } from "@agent-hub/shared";
import { client } from "@/lib/client";
import { t, useLanguage } from "@/i18n";
import type { TranslationKey } from "@/i18n/en";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";

export function deployDisabledReason(status: DeployStatus | null, tasks: Pick<Task, "status">[], busy: boolean): TranslationKey | null {
  if (busy || status?.deploying) return "deploy.running";
  if (!status) return "deploy.loading";
  if (!status.enabled) return `deploy.${status.disabledReason ?? "not_enabled"}`;
  if (status.dirty) return "deploy.dirty";
  if (tasks.some((task) => task.status === "running" || task.status === "waiting_user")) return "deploy.tasks";
  if (!status.target || !status.pending.length) return "deploy.empty";
  return null;
}

function Commit({ commit }: { commit: DeployCommit | null }) {
  return commit ? <span className="break-words"><code>{commit.sha.slice(0, 8)}</code> {commit.subject}</span> : <span>{t("deploy.unknown")}</span>;
}

export function DeployDialog({ open, onOpenChange, tasks }: {
  open: boolean; onOpenChange: (open: boolean) => void; tasks: Task[];
}) {
  useLanguage();
  const [status, setStatus] = useState<DeployStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [watching, setWatching] = useState<{ sha: string; requestedAt: string } | null>(null);
  const submitting = useRef(false);
  const completed = watching && status?.last?.sha === watching.sha && status.last.requestedAt === watching.requestedAt && status.last.outcome !== "running";

  useEffect(() => {
    if (!open || completed) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await client.deployStatus();
        if (!cancelled) { setStatus(next); setRefreshFailed(false); }
      } catch { if (!cancelled) setRefreshFailed(true); }
      // Keep retrying through connection failures during the service restart.
      if (!cancelled) timer = setTimeout(() => void poll(), 3000);
    };
    void poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [open, completed]);

  const waiting = !!watching && !completed;
  const reason = deployDisabledReason(status, tasks, busy || waiting);
  const confirm = async () => {
    if (reason || !status?.target || submitting.current) return;
    submitting.current = true;
    setBusy(true); setError(null); setWatching(null);
    try {
      const next = await client.deploy(status.target.sha);
      setStatus(next);
      if (next.last) setWatching({ sha: next.last.sha, requestedAt: next.last.requestedAt });
    }
    catch (err) {
      setError(t("deploy.requestFailed", { error: err instanceof Error ? err.message : String(err) }));
      setWatching(null);
    } finally { submitting.current = false; setBusy(false); }
  };

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="max-h-[90dvh] overflow-y-auto">
      <DialogHeader>
        <DialogTitle>{t("deploy.title")}</DialogTitle>
        <DialogDescription>{t("deploy.description")}</DialogDescription>
      </DialogHeader>
      {status && <div className="min-w-0 space-y-4 text-sm">
        <div><h3 className="font-medium">{t("deploy.current")}</h3><Commit commit={status.current} /></div>
        <div><h3 className="font-medium">{t("deploy.target")}</h3><Commit commit={status.target} /></div>
        <div><h3 className="font-medium">{t("deploy.pending")}</h3>
          <ul className="max-h-40 space-y-1 overflow-y-auto">{status.pending.map((commit) => <li key={commit.sha}><Commit commit={commit} /></li>)}</ul>
        </div>
        {status.fetchError && <p role="alert">{t("deploy.fetchError", { error: status.fetchError })}</p>}
        <div aria-live="polite"><h3 className="font-medium">{t("deploy.last")}</h3>
          {status.last ? <>
            <p>{t(`deploy.${status.last.outcome}`)} <code>{status.last.sha.slice(0, 8)}</code></p>
            {status.last.outcome === "succeeded" && <Commit commit={status.current} />}
            {status.last.outcome === "failed" && <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-2 text-xs">{status.last.log || status.last.result || t("deploy.unknown")}</pre>}
          </> : <p>{t("deploy.none")}</p>}
        </div>
        {status.history && <div className="break-words text-xs text-muted-foreground">{t("deploy.history")}: {status.history}</div>}
      </div>}
      {refreshFailed && <p role="status" className="text-sm text-muted-foreground">{t("deploy.refreshError")}</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {reason && <p role="status" className="text-sm">{t(reason)}</p>}
      <Button disabled={!!reason || refreshFailed} onClick={() => void confirm()}>{t("deploy.confirm")}</Button>
      {completed && <Button variant="outline" onClick={() => { setWatching(null); setStatus(null); }}>{t("deploy.refresh")}</Button>}
    </DialogContent>
  </Dialog>;
}
