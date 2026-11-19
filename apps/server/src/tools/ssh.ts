import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Host } from "@agent-hub/shared";

/**
 * The command line as the device's shell should get it. Windows PowerShell writes in the console's
 * code page (Big5 on a Traditional Chinese Windows), which reaches us as mojibake: every localized
 * error and every non-ASCII file name was unreadable to the agent. Switching the output to UTF-8 first
 * fixes that; hiding the progress stream keeps its control characters out of the output.
 */
export function remoteCommand(host: Host, command: string): string {
  if (host.shell !== "powershell") return command;
  // The command runs through Invoke-Expression, so it is PARSED only after the encoding is set. Given
  // inline, a syntax error (an agent writing sh syntax for Windows, say) fails before anything runs,
  // and its message came back in Big5 regardless.
  const quoted = `'${command.replace(/'/g, "''")}'`;
  return `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $ProgressPreference='SilentlyContinue'; Invoke-Expression ${quoted}`;
}

export interface SshResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export const DEFAULT_TIMEOUT_S = 120;
export const MAX_TIMEOUT_S = 600;

/**
 * Run one command on a registered host with the system `ssh`. Never interactive: BatchMode means a
 * missing key fails at once instead of waiting on a password prompt nobody will answer.
 *
 * Host keys go in Agent Hub's own known_hosts. First contact is trusted and recorded; a CHANGED key
 * is refused (StrictHostKeyChecking=accept-new), which is the man-in-the-middle case.
 */
export function sshExec(host: Host, command: string, opts: { knownHostsFile: string; timeoutS?: number; signal?: AbortSignal }): Promise<SshResult> {
  const timeoutS = Math.min(MAX_TIMEOUT_S, Math.max(1, opts.timeoutS ?? DEFAULT_TIMEOUT_S));
  fs.mkdirSync(path.dirname(opts.knownHostsFile), { recursive: true });
  const args = [
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", `UserKnownHostsFile=${opts.knownHostsFile}`,
    "-o", "ServerAliveInterval=15",
    "-o", "LogLevel=ERROR", // keeps "Permanently added ... to known hosts" out of the agent's output; real errors still print
    "-i", expandHome(host.keyPath),
    "-p", String(host.port),
    "-T",
    `${host.user}@${host.address}`,
    "--",
    remoteCommand(host, command),
  ];
  const started = Date.now();
  return new Promise((resolve) => {
    execFile("ssh", args, { timeout: timeoutS * 1000, maxBuffer: 16 * 1024 * 1024, signal: opts.signal }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { code?: number | string; killed?: boolean }) | null;
      resolve({
        exitCode: e ? (typeof e.code === "number" ? e.code : null) : 0,
        stdout: String(stdout ?? ""),
        stderr: String(stderr ?? "") || (e && typeof e.code !== "number" ? e.message : ""),
        durationMs: Date.now() - started,
        timedOut: !!e?.killed,
      });
    });
  });
}

/** What the agent (and the log) sees: output, then how it ended. Clipped so one call cannot flood a prompt. */
export function formatResult(r: SshResult, timeoutS: number, max = 12_000): string {
  let out = r.stdout + (r.stderr ? (r.stdout ? "\n" : "") + r.stderr : "");
  if (out.length > max) out = `${out.slice(0, max / 2)}\n… (${out.length - max} characters omitted) …\n${out.slice(-max / 2)}`;
  const end = r.timedOut
    ? `timed out after ${timeoutS}s and was killed (for long jobs, start them with nohup … & and check back)`
    : r.exitCode === 255
      ? "exit 255: ssh itself failed (unreachable, refused, wrong key or user, or a changed host key)"
      : `exit ${r.exitCode ?? "unknown"}`;
  return `${out.trimEnd()}\n[${end}, ${(r.durationMs / 1000).toFixed(1)}s]`.trimStart();
}

export function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p;
}
