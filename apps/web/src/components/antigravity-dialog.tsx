import { useEffect, useState } from "react";
import type { AntigravityKey, AntigravityStatus } from "@agent-hub/shared";
import { client } from "@/lib/client";
import { t, useLanguage } from "@/i18n";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";

const keys: AntigravityKey[] = ["enter", "up", "down", "left", "right", "tab", "escape", "space", "backspace"];
export function AntigravityDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  useLanguage();
  const [status, setStatus] = useState<AntigravityStatus | null>(null);
  const [code, setCode] = useState("");
  const [submit, setSubmit] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [now, setNow] = useState(Date.now());
  const state = status?.session.state;
  const active = state === "preparing-image" || state === "running" || state === "stopping";
  useEffect(() => {
    if (!open) { setCode(""); setConfirm(false); return; }
    let cancelled = false;
    setError(false);
    void client.antigravityStatus().then(value => { if (!cancelled) setStatus(value); }, () => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, [open]);
  useEffect(() => {
    if (!open || !active) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    let refreshPresence = true;
    const poll = async () => {
      try {
        const session = await client.antigravitySession();
        if (!cancelled) {
          setNow(Date.now());
          const ended = !["preparing-image", "running", "stopping"].includes(session.state);
          if (refreshPresence || ended) {
            const status = await client.antigravityStatus();
            if (!cancelled) setStatus(status);
            refreshPresence = false;
            if (ended) return;
          } else setStatus(previous => previous ? { ...previous, session } : previous);
        }
      } catch { if (!cancelled) setError(true); }
      if (!cancelled) timer = setTimeout(() => void poll(), 1000);
    };
    timer = setTimeout(() => void poll(), 1000);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [open, active]);
  const act = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setError(false);
    try { await action(); } catch { setError(true); } finally { setBusy(false); }
  };
  const send = () => act(async () => {
    const text = code;
    setCode("");
    await client.antigravityInput({ text, submit });
  });
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-4xl">
      <DialogHeader>
        <DialogTitle>{t("antigravity.title")}</DialogTitle>
        <DialogDescription>{t("antigravity.warning")}</DialogDescription>
      </DialogHeader>
      {!status ? <p>{t("antigravity.loading")}</p> : <div className="space-y-3 text-sm">
        <p>{status.available ? t("antigravity.available") : t(`antigravity.${status.reason ?? "docker-unavailable"}`)}</p>
        <p>{t(`antigravity.credentials.${status.credentials}`)}</p>
        <p role="status">{t(`antigravity.state.${status.session.state}`)}</p>
        {state === "failed" && status.session.failedStage && <p role="alert">{t(`antigravity.failedStage.${status.session.failedStage}`)}</p>}
        {status.session.exitCode !== undefined && <p>{t("antigravity.exitCode", { code: status.session.exitCode })}</p>}
        <div className="flex flex-wrap gap-2">
          <Button disabled={!status.available || active || busy} onClick={() => void act(async () => {
            const session = await client.antigravityStart();
            setNow(Date.now()); setStatus({ ...status, session });
          })}>{t("antigravity.start")}</Button>
          <Button disabled={!active || busy} onClick={() => void act(async () => {
            const session = await client.antigravityCancel(); setStatus({ ...status, session }); setCode("");
          })}>{t("antigravity.cancel")}</Button>
          <Button disabled={active || busy} variant="outline" onClick={() => setConfirm(true)}>{t("antigravity.logout")}</Button>
        </div>
        {confirm && <div>
          <p>{t("antigravity.confirmLogout")}</p>
          <Button disabled={active || busy} variant="destructive" onClick={() => void act(async () => {
            setStatus(await client.antigravityLogout()); setConfirm(false);
          })}>{t("antigravity.logout")}</Button>
          <Button variant="ghost" onClick={() => setConfirm(false)}>{t("common.cancel")}</Button>
        </div>}
        {status.session.startedAt !== null && <>
          {active && <p>{t("antigravity.remaining", { seconds: Math.max(0, Math.ceil(((status.session.expiresAt ?? now) - now) / 1000)) })}</p>}
          <pre aria-label={t("antigravity.screen")} className="max-h-96 overflow-x-auto overflow-y-auto whitespace-pre font-mono text-xs bg-muted p-3">{status.session.screen.join("\n")}</pre>
          <div className="flex flex-wrap gap-2">{status.session.links.filter(link => link.startsWith("https://")).map((link, i) => <Button asChild variant="outline" key={link}>
            <a href={link} target="_blank" rel="noopener noreferrer">{t("antigravity.openLink", { number: i + 1 })}</a>
          </Button>)}</div>
        </>}
        {active && <>
          <div className="flex flex-wrap gap-2">{keys.map(key => <Button key={key} variant="outline" disabled={busy || state !== "running"} onClick={() => void act(async () => { await client.antigravityInput({ key }); })}>{t(`antigravity.key.${key}`)}</Button>)}</div>
          <form className="space-y-2" onSubmit={event => { event.preventDefault(); if (code && state === "running") void send(); }}>
            <Input aria-label={t("antigravity.code")} type="password" value={code} maxLength={512} autoComplete="off" spellCheck={false} onChange={event => setCode(event.target.value)} />
            <label className="flex gap-2 items-center"><input type="checkbox" checked={submit} onChange={event => setSubmit(event.target.checked)} />{t("antigravity.submit")}</label>
            <Button type="submit" disabled={busy || !code || state !== "running"}>{t("antigravity.send")}</Button>
          </form>
        </>}
      </div>}
      {error && <p role="alert">{t("antigravity.requestFailed")}</p>}
    </DialogContent>
  </Dialog>;
}
