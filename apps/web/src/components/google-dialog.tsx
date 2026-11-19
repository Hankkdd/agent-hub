import { useEffect, useState } from "react";
import type { GoogleErrorCode, GoogleStatus } from "@agent-hub/shared";
import { client } from "@/lib/client";
import { t, useLanguage } from "@/i18n";
import type { TranslationKey } from "@/i18n/en";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";

export const GOOGLE_RESULTS = ["connected", "denied", "expired_state", "failed"] as const;
export type GoogleResult = typeof GOOGLE_RESULTS[number];

const ERROR_MESSAGES = {
  not_configured: "google.error.not_configured",
  not_connected: "google.error.not_connected",
  missing_capability: "google.error.missing_capability",
  reauthorize: "google.error.reauthorize",
  expired_state: "google.error.expired_state",
  denied: "google.error.denied",
  failed: "google.error.failed",
  invalid_url: "google.error.invalid_url",
  wrong_mode: "google.error.wrong_mode",
  unknown_capability: "google.error.unknown_capability",
  storage_error: "google.error.storage_error",
} satisfies Record<GoogleErrorCode, TranslationKey>;

/** Only known codes select local messages; server and transport text must never be rendered. */
export function googleErrorMessage(error: unknown): TranslationKey {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    if (Object.hasOwn(ERROR_MESSAGES, error.code)) return ERROR_MESSAGES[error.code as GoogleErrorCode];
  }
  return "google.requestFailed";
}

export function GoogleDialog({ open, onOpenChange, result }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  result?: GoogleResult;
}) {
  useLanguage();
  const [status, setStatus] = useState<GoogleStatus | null>(null);
  const [url, setUrl] = useState("");
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [error, setError] = useState<TranslationKey | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  useEffect(() => {
    if (!open) {
      setUrl("");
      setAuthUrl(null);
      setConfirmDisconnect(false);
      return;
    }
    let cancelled = false;
    const refresh = () => {
      void client.googleStatus().then((s) => {
        if (!cancelled) setStatus(s);
      }, (err) => {
        if (!cancelled) setError(googleErrorMessage(err));
      });
    };
    refresh();
    window.addEventListener("focus", refresh);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", refresh);
    };
  }, [open]);

  const act = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(googleErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="max-h-[90dvh] overflow-y-auto">
      <DialogHeader>
        <DialogTitle>{t("google.title")}</DialogTitle>
        <DialogDescription>{t("google.description")}</DialogDescription>
      </DialogHeader>
      {result && <p role="status">{t(`google.${result}`)}</p>}
      {!status ? <p>{t("google.loading")}</p> : <div className="space-y-3 text-sm">
        {!status.configured && <p>{t("google.notConfigured")} {t("google.configHelp")}</p>}
        {status.storageError && <p role="alert">{t("google.error.storage_error")}</p>}
        {status.mode && <p>{t("google.mode", { mode: t(`google.${status.mode}`) })}</p>}
        {status.account ? <>
          <p>{t("google.email", { email: status.account.email })}</p>
          <p>{t("google.capabilities", {
            capabilities: status.account.capabilities.join(", ") || t("google.none"),
          })}</p>
          {status.account.needsReauthorization && <p>{t("google.reauthorize")}</p>}
        </> : <p>{t("google.notConnected")}</p>}
        <Button disabled={!status.configured || status.storageError || busy} onClick={() => void act(async () => {
          const result = await client.googleConnect("drive.read");
          setAuthUrl(result.authUrl);
          window.open(result.authUrl, "_blank", "noopener,noreferrer");
        })}>{t("google.connect")}</Button>
        {authUrl && <p>
          <a className="underline" href={authUrl} target="_blank" rel="noopener noreferrer">
            {t("google.openConsent")}
          </a>
        </p>}
        {status.mode === "paste" && <div className="space-y-2">
          <p>{t("google.pasteHelp")}</p>
          <Textarea
            aria-label={t("google.pasteLabel")}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
          <Button disabled={busy || status.storageError || !url.trim()} onClick={() => void act(async () => {
            const pasted = url;
            setUrl("");
            setStatus(await client.googleComplete(pasted));
            setAuthUrl(null);
          })}>{t("google.complete")}</Button>
        </div>}
        {(status.account || status.storageError) && (confirmDisconnect ? <div className="space-y-2">
          <p>{t("google.confirmDisconnect")}</p>
          <Button disabled={busy} variant="destructive" onClick={() => void act(async () => {
            setStatus(await client.googleDisconnect());
            setConfirmDisconnect(false);
            setAuthUrl(null);
          })}>{t("google.disconnect")}</Button>
          <Button variant="ghost" onClick={() => setConfirmDisconnect(false)}>{t("common.cancel")}</Button>
        </div> : <Button variant="outline" disabled={busy} onClick={() => setConfirmDisconnect(true)}>
          {t("google.disconnect")}
        </Button>)}
      </div>}
      {error && <p role="alert">{t(error)}</p>}
    </DialogContent>
  </Dialog>;
}

/** Advisory UI check only; the server performs authoritative parsing and authorization. */
export function containsDriveUrl(text: string): boolean {
  return (text.match(/https?:\/\/\S+/g) ?? []).some((value) => {
    try {
      const u = new URL(value);
      if (
        u.protocol !== "https:" || u.hostname !== "drive.google.com" ||
        u.username || u.password || value.split("/")[2]?.includes("@") ||
        u.port || /%|\\/.test(value.split("?")[0]!) ||
        value.split("?")[0]!.split("/").some((p) => p === "." || p === "..")
      ) {
        return false;
      }
      const id = /^\/file\/d\/([A-Za-z0-9_-]{10,200})(?:\/(view|preview|edit))?$/.exec(u.pathname)?.[1] ??
        (["/open", "/uc"].includes(u.pathname) ? u.searchParams.get("id") : null);
      const key = u.searchParams.get("resourcekey");
      return !!id && /^[A-Za-z0-9_-]{10,200}$/.test(id) && (key === null || /^[A-Za-z0-9_-]{10,200}$/.test(key));
    } catch {
      return false;
    }
  });
}
