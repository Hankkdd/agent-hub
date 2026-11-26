import { useEffect, useRef, useState } from "react";
import type { ClaudeLoginStatus, ProviderQuota, QuotaResponse, QuotaWindow } from "@agent-hub/shared";
import { t, useLanguage } from "@/i18n";
import { client } from "@/lib/client";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { quotaScheduler, type QuotaState } from "./quota-scheduler";
import { countdown, localTime, percentage, quotaStale, remainingShare, windowLabel } from "./quota-helpers";

export function useQuota(authenticated: boolean) {
  const [state, setState] = useState<QuotaState>({ data: null, loading: false, error: false, now: Date.now() });
  const [claudeRuntime, setClaudeRuntime] = useState<ClaudeLoginStatus["runtime"] | null>(null);
  const controller = useRef<ReturnType<typeof quotaScheduler> | null>(null);
  useEffect(() => {
    if (!authenticated) return;
    let cancelled = false;
    void client.claudeLoginStatus().then(status => { if (!cancelled) setClaudeRuntime(status.runtime); }, () => {});
    controller.current = quotaScheduler(document, force => client.quota(force), setState);
    return () => { cancelled = true; controller.current?.dispose(); controller.current = null; };
  }, [authenticated]);
  return { state, claudeRuntime, refresh: () => controller.current?.refresh(true) };
}
const LOW_PERCENT = 25;

function QuotaBar({ window: w, label, detail, now }: { window: QuotaWindow; label: string; detail: string; now: number }) {
  const share = remainingShare(w, now);
  return <span className="block">
    <span className="flex justify-between gap-2 text-muted-foreground"><span className="shrink-0">{label}</span><span className="truncate text-right">{detail}</span></span>
    <span className="mt-1 block h-1.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={share ?? undefined}>
      {share !== null && <span className={`block h-full rounded-full ${share < LOW_PERCENT ? "bg-amber-500" : "bg-emerald-500"}`} style={{ width: `${share}%` }} />}
    </span>
  </span>;
}
function status(provider: ProviderQuota | undefined, state: QuotaState): string {
  if (!provider) return t(state.error ? "quota.error" : "quota.loading");
  return t(`quota.${provider.status}`);
}
export function QuotaSummary({ state, refresh, onClaudeLogin, claudeRuntime }: { state: QuotaState; refresh: () => unknown; onClaudeLogin?: () => void; claudeRuntime?: ClaudeLoginStatus["runtime"] | null }) {
  const language = useLanguage();
  // Gemini is chat-only; only a connected adapter contributes a quota entry.
  const providers = ["claude", "codex", ...(state.data?.gemini ? ["gemini" as const] : [])] as const;
  const manualDue = Math.max(...Object.values(state.data ?? {}).map((p: QuotaResponse["claude"]) => Date.parse(p.manualRefreshAt)));
  return (
    <Dialog>
      <DialogTrigger asChild>
        <button className="mx-2 mb-2 shrink-0 rounded-md border p-2 text-left text-xs hover:bg-sidebar-accent focus-visible:outline-2 focus-visible:outline-ring" aria-label={t("quota.title")}>
          {providers.map(kind => {
            const provider = state.data?.[kind];
            return <span key={kind} className="block py-1">
              <span className="block font-semibold">{t(`agent.${kind}`)}</span>
              {provider?.windows.length ? <span className="mt-1 block space-y-1.5">
                {provider.windows.map(w => <QuotaBar key={w.id} window={w} now={state.now}
                  label={`${provider.windows.some(other => other.bucket !== w.bucket) ? `${w.bucket} · ` : ""}${windowLabel(w)}`}
                  detail={`${percentage(w, state.now)} · ${countdown(w.resetsAt, state.now, true)}`} />)}
              </span> : <span className="block">{status(provider, state)}</span>}
              {provider && (quotaStale(provider, state.now) || state.error) && <span className="block text-amber-600 dark:text-amber-400">{t("quota.stale")} · {localTime(provider.updatedAt, language)}</span>}
              {provider && (provider.status !== "ok" || state.error) && provider.windows.length > 0 && <span className="block text-muted-foreground">{state.error ? t("quota.error") : status(provider, state)}</span>}
            </span>;
          })}
        </button>
      </DialogTrigger>
      {claudeRuntime === "docker" && state.data?.claude.status === "missing_login" && <Button className="mx-2 mb-2" variant="link" onClick={onClaudeLogin}>{t("claudeLogin.title")}</Button>}
      <DialogContent className="max-h-[85dvh] overflow-y-auto">
        <DialogHeader><DialogTitle>{t("quota.title")}</DialogTitle><DialogDescription>{t("quota.description")}</DialogDescription></DialogHeader>
        <div aria-live="polite" className="space-y-4 text-sm">
          {providers.map(kind => {
            const provider = state.data?.[kind];
            return <section key={kind} className="space-y-2">
              <h3 className="font-semibold">{t(`agent.${kind}`)}</h3>
              {state.loading && <p>{t("quota.loading")}</p>}
              {(!provider || provider.status !== "ok") && <p>{status(provider, state)}</p>}
              {claudeRuntime === "docker" && kind === "claude" && provider?.status === "missing_login" && <Button variant="link" onClick={onClaudeLogin}>{t("claudeLogin.title")}</Button>}
              {provider && (quotaStale(provider, state.now) || state.error) && <p className="text-amber-600 dark:text-amber-400">{t("quota.stale")}</p>}
              {provider?.windows.map(w => <div key={w.id} className="rounded-md border p-3">
                <QuotaBar window={w} now={state.now} label={`${w.bucket} · ${windowLabel(w)}`} detail={percentage(w, state.now)} />
                <p className="mt-2 text-muted-foreground">{t("quota.nextReset")}: {localTime(w.resetsAt, language)}</p>
                <p className="text-muted-foreground">{countdown(w.resetsAt, state.now)}</p>
              </div>)}
              <p className="text-xs text-muted-foreground">{t("quota.updated")}: {localTime(provider?.updatedAt ?? null, language)}</p>
            </section>;
          })}
          {state.error && <p>{t("quota.error")}</p>}
        </div>
        <Button variant="outline" onClick={refresh} disabled={state.loading || state.now < manualDue}>{t("quota.refresh")}</Button>
        {state.now < manualDue && <p className="text-xs text-muted-foreground">{t("quota.cooldown")}</p>}
      </DialogContent>
    </Dialog>
  );
}
