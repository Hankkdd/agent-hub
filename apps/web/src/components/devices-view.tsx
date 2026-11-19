import { PhoneBack } from "@/components/phone-back";
import { t, useLanguage } from "@/i18n";
import { useCallback, useEffect, useState } from "react";
import { Loader2, Plus, Server, Trash2 } from "lucide-react";
import type { Host, SshLogEntry } from "@agent-hub/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { client } from "@/lib/client";
import { cn } from "@/lib/utils";
import { DeviceSetup } from "@/components/device-setup";

// keyPath empty: the server fills in Agent Hub's own key.
const EMPTY: Host = { name: "", address: "", user: "", port: 22, keyPath: "", note: "", prod: false, shell: "posix" };

/**
 * The devices agents may reach with ssh_exec. Only these are reachable, and every command an agent
 * runs on one is in its log here (design.md §7.3).
 */
export function DevicesView({ onBack }: { onBack: () => void }) {
  useLanguage();
  const [hosts, setHosts] = useState<Host[] | null>(null);
  const [selected, setSelected] = useState<string | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const list = await client.hosts();
      setHosts(list);
      setSelected((cur) => cur ?? (list[0]?.name ?? "new"));
    } catch (err) {
      setError(String(err));
    }
  }, []);
  useEffect(() => void reload(), [reload]);

  const current = selected === "new" ? null : (hosts?.find((h) => h.name === selected) ?? null);

  return (
    <div className="devices-view flex h-full min-h-0 min-w-0 flex-col">
      <header className="flex items-center gap-3 border-b max-md:shrink-0 px-4 py-2.5 max-md:gap-2 max-md:px-2">
        <PhoneBack onBack={onBack} />
        <div className="min-w-0 flex-1">
          <h1 className="text-sm font-semibold">{t("app.devices")}</h1>
          <div className="text-xs text-muted-foreground max-md:truncate" title={t("devices.hint")}>{t("devices.hint")}</div>
        </div>
        <Button size="sm" variant="outline" onClick={() => setSelected("new")}>
          <Plus /> {t("devices.add")}
        </Button>
      </header>
      {error && <div className="border-b bg-red-500/5 px-4 py-2 text-xs text-red-600 dark:text-red-400">{error}</div>}
      <div className="flex min-h-0 flex-1 max-md:flex-col">
        <div className="w-60 shrink-0 overflow-y-auto border-r p-2 max-md:max-h-40 max-md:w-full max-md:border-r-0 max-md:border-b">
          {hosts === null ? (
            <div className="p-2 text-xs text-muted-foreground">{t("app.loading")}</div>
          ) : hosts.length === 0 ? (
            <div className="p-2 text-xs text-muted-foreground">{t("devices.empty")}</div>
          ) : (
            hosts.map((h) => (
              <button
                key={h.name}
                onClick={() => setSelected(h.name)}
                className={cn("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent", selected === h.name && "bg-accent")}
              >
                <Server className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{h.name}</span>
                  <span className="block truncate font-mono text-[11px] text-muted-foreground">
                    {h.user}@{h.address}
                  </span>
                </span>
                {h.shell === "powershell" && <Badge variant="outline" className="h-4 px-1 text-[10px]">{t("devices.windowsBadge")}</Badge>}
                {h.prod && <Badge variant="destructive" className="h-4 px-1 text-[10px]">{t("devices.prodBadge")}</Badge>}
              </button>
            ))
          )}
        </div>
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          {selected !== null && (
            <HostEditor
              key={selected}
              host={current}
              onSaved={async (name) => {
                await reload();
                setSelected(name);
              }}
              onDeleted={async () => {
                setSelected(null);
                await reload();
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function HostEditor(props: { host: Host | null; onSaved: (name: string) => Promise<void>; onDeleted: () => Promise<void> }) {
  useLanguage();
  const isNew = !props.host;
  const [form, setForm] = useState<Host>(props.host ?? EMPTY);
  const [busy, setBusy] = useState<"save" | "test" | "delete" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [test, setTest] = useState<{ ok: boolean; output: string } | null>(null);
  const [log, setLog] = useState<SshLogEntry[]>([]);

  const loadLog = useCallback(async () => {
    if (props.host) setLog(await client.hostLog(props.host.name).catch(() => []));
  }, [props.host]);
  useEffect(() => void loadLog(), [loadLog]);

  const set = <K extends keyof Host>(k: K, v: Host[K]) => setForm((f) => ({ ...f, [k]: v }));
  const run = async (kind: "save" | "test" | "delete", fn: () => Promise<void>) => {
    setBusy(kind);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mx-auto max-w-2xl space-y-5 p-4">
      {isNew && <DeviceSetup />}
      <div className="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
        <Field label={t("devices.name")}>
          <Input value={form.name} disabled={!isNew} onChange={(e) => set("name", e.target.value.toLowerCase())} placeholder={t("devices.namePlaceholder")} />
        </Field>
        <Field label={t("devices.address")}>
          <Input value={form.address} onChange={(e) => set("address", e.target.value)} placeholder={t("devices.addressPlaceholder")} />
        </Field>
        <Field label={t("devices.user")}>
          <Input value={form.user} onChange={(e) => set("user", e.target.value)} placeholder={t("devices.userPlaceholder")} />
        </Field>
        <Field label={t("devices.port")}>
          <Input type="number" value={form.port} onChange={(e) => set("port", Number(e.target.value))} />
        </Field>
        <Field label={t("devices.shell")} className="col-span-2 max-sm:col-span-1">
          <div className="flex gap-4 text-sm">
            {(
              [
                ["posix", t("devices.posix")],
                ["powershell", t("devices.powershell")],
              ] as const
            ).map(([v, l]) => (
              <label key={v} className="flex items-center gap-1.5">
                <input type="radio" name="shell" checked={form.shell === v} onChange={() => set("shell", v)} />
                {l}
              </label>
            ))}
          </div>
        </Field>
        <Field label={t("devices.privateKey")} className="col-span-2 max-sm:col-span-1">
          <Input value={form.keyPath} onChange={(e) => set("keyPath", e.target.value)} placeholder={t("devices.keyPlaceholder")} />
        </Field>
        <Field label={t("devices.note")} className="col-span-2 max-sm:col-span-1">
          <Textarea value={form.note} onChange={(e) => set("note", e.target.value)} rows={2} placeholder={t("devices.notePlaceholder")} />
        </Field>
        <label className="col-span-2 flex items-center gap-2 text-sm max-sm:col-span-1">
          <input type="checkbox" checked={form.prod} onChange={(e) => set("prod", e.target.checked)} />
          {t("devices.production")}
        </label>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={!!busy || !form.name}
          onClick={() =>
            void run("save", async () => {
              const saved = await client.saveHost(form.name, form);
              await props.onSaved(saved.name);
            })
          }
        >
          {busy === "save" && <Loader2 className="animate-spin" />} {isNew ? t("devices.add") : t("common.save")}
        </Button>
        {!isNew && (
          <>
            <Button
              size="sm"
              variant="outline"
              disabled={!!busy}
              onClick={() =>
                void run("test", async () => {
                  setTest(await client.testHost(form.name));
                  await loadLog();
                })
              }
            >
              {busy === "test" && <Loader2 className="animate-spin" />} {t("devices.testConnection")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={!!busy}
              onClick={() =>
                window.confirm(t("devices.removeConfirm", { name: form.name })) &&
                void run("delete", async () => {
                  await client.deleteHost(form.name);
                  await props.onDeleted();
                })
              }
            >
              <Trash2 /> {t("common.remove")}
            </Button>
          </>
        )}
      </div>
      {error && <div className="text-sm text-red-600 dark:text-red-400">{error}</div>}
      {test && (
        <pre className={cn("rounded-md border px-3 py-2 font-mono text-xs whitespace-pre-wrap", test.ok ? "border-emerald-500/40" : "border-red-500/50 bg-red-500/5")}>{test.output}</pre>
      )}
      {!isNew && (
        <div>
          <div className="mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">{t("devices.recentCommands", { count: log.length })}</div>
          {log.length === 0 ? (
            <div className="text-xs text-muted-foreground">{t("devices.noCommands")}</div>
          ) : (
            <ul className="divide-y rounded-md border text-xs">
              {log.map((l) => (
                <li key={l.id}>
                  <details>
                    <summary className="flex cursor-pointer items-center gap-2 px-3 py-1.5">
                      <span className={cn("w-8 shrink-0 font-mono", l.exitCode === 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400")}>
                        {l.exitCode ?? "?"}
                      </span>
                      <code className="min-w-0 flex-1 truncate">{l.command}</code>
                      <span className="shrink-0 text-muted-foreground">{t(l.taskId ? "devices.agent" : "devices.test")}</span>
                      <span className="shrink-0 text-muted-foreground">{new Date(l.startedAt).toLocaleString()}</span>
                    </summary>
                    <pre className="max-h-64 overflow-auto border-t px-3 py-2 font-mono whitespace-pre-wrap">{l.output}</pre>
                  </details>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function Field({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("grid gap-1.5", className)}>
      <Label>{label}</Label>
      {children}
    </div>
  );
}
