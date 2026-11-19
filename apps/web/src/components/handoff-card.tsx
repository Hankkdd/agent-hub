import type { HandoffImage, TaskEvent } from "@agent-hub/shared";
import { t, useLanguage } from "@/i18n";
import { label } from "@/lib/client";
import { Markdown } from "./markdown";

type HandoffEvent = Extract<TaskEvent, { type: "handoff_started" | "handoff_completed" | "handoff_failed" }>;
export function HandoffCard({ event: e }: { event: HandoffEvent }) {
  useLanguage();
  return <div className="rounded-md border px-3 py-2 text-sm">
    <div>{label(e.sourceBackend)} → {label(e.target)} · {t(e.type === "handoff_completed" ? "handoff.completed" : e.type === "handoff_failed" ? "handoff.failed" : "handoff.preparing")}</div>
    <div className="text-xs text-muted-foreground">{e.createdAt} · {t("handoff.range", { from: e.sourceFrom, to: e.sourceTo })}</div>
    {e.type === "handoff_failed" && <p role="alert">{e.error} · {t("handoff.retry")}</p>}
    {e.type === "handoff_completed" && <details>
      <summary className="cursor-pointer">{t("handoff.summary")}</summary>
      {(["goals", "decisions", "constraints", "completed", "pending", "uncertainty"] as const).map((k) => <div key={k}><strong>{t(k === "completed" ? "handoff.workCompleted" : `handoff.${k}`)}</strong><Markdown>{e.material.summary[k]}</Markdown></div>)}
      <p>{t("handoff.delivery", { count: e.material.images.filter((i) => !i.reason).length, omitted: e.material.images.filter((i) => i.reason).length })}</p>
      <p className="text-xs">{t("handoff.limitations")}</p>
      <p className="text-xs">{t("handoff.textOmissions", { count: e.material.recentOmissions.length })}</p>
      <HandoffImages images={e.material.images} />
    </details>}
  </div>;
}

export function HandoffImages({ images }: { images: HandoffImage[] }) {
  useLanguage();
  return <ul>{images.map((i, n) => <li key={n} className="break-all text-xs">#{i.seq} {i.attachment.file}: {i.reason ? t(`handoff.image.${i.reason}`) : t("handoff.image.selected")}</li>)}</ul>;
}
