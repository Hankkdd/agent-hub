import { effortLabel } from "./status";
import { useState } from "react";
import { activeMainSession, type Task, type TaskEvent } from "@agent-hub/shared";
import { client, label } from "@/lib/client";
import { t, useLanguage } from "@/i18n";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "./ui/dialog";

export function handoffControlState(task: Task, events: TaskEvent[]) {
  const current = activeMainSession(task);
  const last = events.filter((e) => ["handoff_started", "handoff_completed", "handoff_failed"].includes(e.type)).at(-1);
  // Gemini is direct chat only; handoff generation remains on Claude and Codex.
  return { current, eligible: current?.agent !== "gemini" && ["chat", "plan"].includes(task.workflow) && !!current,
    preparing: last?.type === "handoff_started",
    // A paused task holds queued messages by design; they move to the new agent.
    incompatible: task.status === "running" || task.status === "waiting_user" || events.some((e) => (e.type === "user_message" && e.queued && task.status !== "paused") || (e.type === "waiting_user" && !e.answer)) };
}

export function SwitchAgentDialog({ task, events, triggerLabel }: { task: Task; events: TaskEvent[]; triggerLabel?: (target: "claude" | "codex") => string }) {
  useLanguage();
  const [open, setOpen] = useState(false);
  const [expected, setExpected] = useState<string>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const { current, eligible, preparing, incompatible } = handoffControlState(task, events);
  if (!eligible || !current) return null;
  const target = current.agent === "codex" ? "claude" : "codex";
  const stale = expected !== current.id;
  return <>
    <Button size="sm" variant="outline" disabled={incompatible && !preparing} onClick={() => { setExpected(current.id); setOpen(true); setError(undefined); }}>{preparing ? t("handoff.preparing") : triggerLabel ? triggerLabel(target) : t("handoff.change")}</Button>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("handoff.change")}</DialogTitle>
          <DialogDescription>{label(current.agent)} ({current.model ?? t("handoff.defaultModel")} · {effortLabel(current.effort)}) → {label(target)}</DialogDescription>
        </DialogHeader>
        <p className="text-sm">{t("handoff.explanation")}</p>
        {(preparing || pending) && <p role="status">{t("handoff.preparing")}</p>}
        {stale && <p role="status">{t("handoff.changed")}</p>}
        {error && <p className="text-destructive" role="alert">{error}</p>}
        <DialogFooter>
          {preparing && <Button variant="outline" onClick={() => void client.stopTask(task.id).catch((e: unknown) => setError(String(e)))}>{t("handoff.cancel")}</Button>}
          <Button disabled={pending || preparing || incompatible || stale} onClick={() => {
            setPending(true); setError(undefined);
            void client.switchAgent(task.id, { target, expectedSessionId: current.id }).then(() => setOpen(false), (e: unknown) => setError(String(e))).finally(() => setPending(false));
          }}>{t("handoff.confirm")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}
