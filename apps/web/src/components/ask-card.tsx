import { useState } from "react";
import type { TaskEvent } from "@agent-hub/shared";
import { t, useLanguage } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { client } from "@/lib/client";
import { cn } from "@/lib/utils";

export function AskCard({ event, onOther }: { event: Extract<TaskEvent, { type: "ask" }>; onOther?: () => void }) {
  useLanguage();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = !event.answer && !event.superseded;
  const choose = async (label: string) => {
    setBusy(true);
    setError(null);
    try { await client.sendMessage(event.taskId, label); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  };
  return <div className={cn("rounded-lg border p-3 text-sm", open ? "border-amber-500/60 bg-amber-500/5" : "opacity-80")}>
    <div className="font-semibold">{event.question}</div>
    {event.items && event.items.length > 0 && <ol className="mt-2 divide-y">
      {event.items.map((item, index) => <li key={index} className="flex items-start gap-2 py-1.5">
        <span className="shrink-0 text-xs text-muted-foreground">{index + 1}.</span>
        {item.severity && <Badge variant="outline" className={cn("shrink-0", item.severity === "high" && "border-red-500/50 text-destructive")}>{t(`severity.${item.severity}`)}</Badge>}
        <span className="min-w-0 break-words">{item.text}{item.suggestion && <span className="mt-0.5 block text-xs text-muted-foreground">{item.suggestion}</span>}</span>
      </li>)}
    </ol>}
    {open ? <div className="mt-3 flex flex-col gap-2">
      {event.options?.map((option) => <Button key={option.label} variant={option.label === event.recommended ? "default" : "outline"} disabled={busy} className="h-auto justify-start whitespace-normal px-3 py-2 text-left" onClick={() => void choose(option.label)}>
        <span className="min-w-0"><span className="block">{option.label}{option.label === event.recommended && <span className="ml-2 text-xs opacity-80">{t("ask.recommended")}</span>}</span><span className="mt-0.5 block text-xs font-normal opacity-80">{option.detail}</span></span>
      </Button>)}
      <Button variant="ghost" size="sm" className="self-start" onClick={onOther}>{t(event.options?.length ? "ask.other" : "ask.typeAnswer")}</Button>
    </div> : <div className="mt-2 text-xs text-muted-foreground">{event.answer ? t("chat.answer", { answer: event.answer }) : t("ask.superseded")}</div>}
    {error && <div className="mt-2 text-destructive" role="alert">{error}</div>}
  </div>;
}
