import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Host } from "@agent-hub/shared";
import { expandHome } from "./ssh";

/** One end of a copy: a path on a registered device, or a path inside the task's own directory. */
export type Locator = { kind: "host"; host: Host; path: string } | { kind: "local"; path: string };

export class LocatorError extends Error {}

/**
 * `<host>:<path>` names a registered device (a Windows path keeps its drive: `win:C:/Users/x/a.csv`).
 * Anything else is RELATIVE to the task's working directory and must stay inside it: an absolute or
 * `..` path is refused, so this tool cannot reach the rest of the Agent Hub machine, which matters for
 * Codex, whose container is meant to see only that directory.
 */
export function parseLocator(spec: string, hosts: Host[], cwd: string): Locator {
  const s = spec.trim();
  const m = s.match(/^([a-z0-9][a-z0-9_-]{0,31}):(.+)$/);
  if (m) {
    const host = hosts.find((h) => h.name === m[1]);
    if (host) return { kind: "host", host, path: m[2]! };
    if (m[1]!.length > 1) throw new LocatorError(`no device named "${m[1]}". Registered: ${hosts.map((h) => h.name).join(", ") || "(none)"}`);
  }
  if (path.isAbsolute(s) || /^[A-Za-z]:/.test(s)) throw new LocatorError(`"${s}" is not a device path, and local paths must be relative to the task's directory`);
  const abs = path.resolve(cwd, s);
  if (abs !== cwd && !abs.startsWith(cwd + path.sep)) throw new LocatorError(`"${s}" leaves the task's directory`);
  return { kind: "local", path: abs };
}

/** An ssh config with one alias per device, so each end of the copy uses its own key, user and port. */
export function sshConfig(hosts: Host[], knownHostsFile: string): string {
  return hosts
    .map((h) =>
      [
        `Host ah-${h.name}`,
        `  HostName ${h.address}`,
        `  User ${h.user}`,
        `  Port ${h.port}`,
        `  IdentityFile ${expandHome(h.keyPath)}`,
        "  IdentitiesOnly yes",
        "  BatchMode yes",
        "  ConnectTimeout 10",
        "  StrictHostKeyChecking accept-new",
        `  UserKnownHostsFile ${knownHostsFile}`,
        "  LogLevel ERROR",
      ].join("\n"),
    )
    .join("\n\n");
}

export interface CopyResult {
  ok: boolean;
  output: string;
  durationMs: number;
  timedOut: boolean;
}

/**
 * Copy with scp. Device to device goes through this machine (`-3`), so the two devices need no trust
 * between them. `-r` covers files and directories alike; `-p` keeps times and modes.
 */
export async function copy(src: Locator, dst: Locator, o: { knownHostsFile: string; timeoutS: number; signal?: AbortSignal }): Promise<CopyResult> {
  const involved = [src, dst].flatMap((l) => (l.kind === "host" ? [l.host] : []));
  const dir = path.dirname(o.knownHostsFile);
  fs.mkdirSync(dir, { recursive: true });
  const cfg = path.join(dir, `scp-${randomUUID()}.conf`);
  fs.writeFileSync(cfg, sshConfig(involved, o.knownHostsFile), { mode: 0o600 });
  if (dst.kind === "local") fs.mkdirSync(path.dirname(dst.path), { recursive: true });
  const arg = (l: Locator) => (l.kind === "host" ? `ah-${l.host.name}:${l.path}` : l.path);
  const args = ["-F", cfg, "-r", "-p", ...(src.kind === "host" && dst.kind === "host" ? ["-3"] : []), arg(src), arg(dst)];
  const started = Date.now();
  try {
    return await new Promise((resolve) => {
      execFile("scp", args, { timeout: o.timeoutS * 1000, maxBuffer: 4 * 1024 * 1024, signal: o.signal }, (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { killed?: boolean }) | null;
        resolve({ ok: !e, output: `${stdout}${stderr}`.trim() || (e ? e.message : ""), durationMs: Date.now() - started, timedOut: !!e?.killed });
      });
    });
  } finally {
    fs.rmSync(cfg, { force: true });
  }
}

/** Bytes under a local path (a file or a whole directory), to say what arrived. */
export function localSize(p: string): number {
  const st = fs.statSync(p, { throwIfNoEntry: false });
  if (!st) return 0;
  if (!st.isDirectory()) return st.size;
  return fs.readdirSync(p).reduce((n, f) => n + localSize(path.join(p, f)), 0);
}
