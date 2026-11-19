import { t, useLanguage } from "@/i18n";
import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { client } from "@/lib/client";
import { copyText } from "@/lib/copy";
import { cn } from "@/lib/utils";

interface Step {
  title: string;
  /** The command, to be run on the DEVICE (not on Agent Hub's machine). */
  command?: string;
  note?: string;
}

/**
 * How to let Agent Hub into a device, with this installation's public key already filled in. The
 * same steps, with placeholders, are in docs/device-setup.md.
 */
export function DeviceSetup() {
  useLanguage();
  const [os, setOs] = useState<"linux" | "windows">("linux");
  const [key, setKey] = useState<string | null>(null);
  useEffect(() => {
    void client.publicKey().then((k) => setKey(k?.publicKey ?? null));
  }, []);
  const pub = key ?? t("setup.loadingKey");

  const linux: Step[] = [
    { title: t("setup.createUser"), command: "sudo useradd -m -s /bin/bash agent" },
    { title: t("setup.sshDirectory"), command: "sudo install -d -m 700 -o agent -g agent /home/agent/.ssh" },
    { title: t("setup.installKey"), command: `echo '${pub}' | sudo tee /home/agent/.ssh/authorized_keys >/dev/null` },
    { title: t("setup.lockKey"), command: "sudo chown agent:agent /home/agent/.ssh/authorized_keys && sudo chmod 600 /home/agent/.ssh/authorized_keys" },
    {
      title: t("setup.folderAccess"),
      command: "sudo setfacl -R -m u:agent:rX,d:u:agent:rX /path/to/folder",
      note: t("setup.homeAccess"),
    },
    { title: t("setup.addHere"), note: t("setup.linuxDetails") },
  ];
  const windows: Step[] = [
    { title: t("setup.installSsh"), command: "Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0" },
    { title: t("setup.startSsh"), command: "Start-Service sshd; Set-Service -Name sshd -StartupType Automatic" },
    {
      title: t("setup.windowsShell"),
      command: 'New-ItemProperty -Path "HKLM:\\SOFTWARE\\OpenSSH" -Name DefaultShell -Value "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -PropertyType String -Force',
    },
    {
      title: t("setup.adminKey"),
      command: `Add-Content -Path C:\\ProgramData\\ssh\\administrators_authorized_keys -Value '${pub}'`,
    },
    {
      title: t("setup.adminPermissions"),
      command: 'icacls C:\\ProgramData\\ssh\\administrators_authorized_keys /inheritance:r /grant "Administrators:F" /grant "SYSTEM:F"',
      note: t("setup.regularKey"),
    },
    {
      title: t("setup.addHere"),
      note: t("setup.windowsDetails"),
    },
  ];

  return (
    <div className="space-y-3 rounded-lg border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1 text-sm font-medium">{t("setup.title")}</div>
        <div className="flex rounded-md border p-0.5 text-xs">
          {(["linux", "windows"] as const).map((o) => (
            <button key={o} onClick={() => setOs(o)} className={cn("rounded px-2 py-1", os === o && "bg-accent font-medium")}>
              {o === "linux" ? t("setup.linux") : t("setup.windows")}
            </button>
          ))}
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        {t("setup.runBefore")} <strong>{t("setup.runEmphasis")}</strong>{t("setup.runAfter")}
      </p>
      <ol className="space-y-3">
        {(os === "linux" ? linux : windows).map((s, i) => (
          <li key={i} className="text-sm">
            <div>
              <span className="text-muted-foreground">{i + 1}. </span>
              {s.title}
            </div>
            {s.command && <CommandLine text={s.command} />}
            {s.note && <div className="mt-1 text-xs text-muted-foreground">{s.note}</div>}
          </li>
        ))}
      </ol>
    </div>
  );
}

function CommandLine({ text }: { text: string }) {
  useLanguage();
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-1 flex items-start gap-1 rounded-md bg-muted px-2 py-1.5">
      <code className="min-w-0 flex-1 font-mono text-xs break-all whitespace-pre-wrap">{text}</code>
      <Button
        size="icon"
        variant="ghost"
        className="size-6 shrink-0"
        aria-label={t("setup.copyCommand")}
        onClick={() =>
          void copyText(text).then(
            () => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            },
            (err) => window.alert(String(err)),
          )
        }
      >
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </Button>
    </div>
  );
}
