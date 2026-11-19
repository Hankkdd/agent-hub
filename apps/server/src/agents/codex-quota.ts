import { spawn, execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import type { QuotaReading } from "@agent-hub/shared";
import { isLoggedIn } from "./codex-docker";
import { normalizeCodex, object } from "./quota-normalize";

export interface QuotaCommand { command: string; args: string[]; container?: string }
export function quotaCommand(image: string | null, codexHome?: string): QuotaCommand {
  if (image) {
    const container = `agent-hub-quota-${randomUUID()}`;
    // Match the task wrapper's provider environment without mounting the host home or passing values in argv.
    const envs = Object.keys(process.env).filter(name => name !== "CODEX_HOME" &&
      (/^(CODEX_|OPENAI_)/.test(name) || name === "RUST_LOG")).flatMap(name => ["-e", name]);
    return { command: "docker", container, args: ["run", "--rm", "--pull=never", "-i", "--init", "--name", container,
      "--label", "agent-hub=codex", "--user", `${process.getuid!()}:${process.getgid!()}`,
      "-e", "HOME=/tmp", "-e", "CODEX_HOME=/codex-home", "-v", `${codexHome}:/codex-home`, ...envs, image, "codex", "app-server"] };
  }
  // Resolve the CLI belonging to this SDK, rather than a different version on PATH.
  const sdkRequire = createRequire(import.meta.resolve("@openai/codex-sdk"));
  const cli = path.join(path.dirname(sdkRequire.resolve("@openai/codex/package.json")), "bin/codex.js");
  return { command: process.execPath, args: [cli, "app-server"] };
}

class ProtocolFailure extends Error {
  constructor(readonly unavailable = false) { super("Quota protocol failed"); }
}

/** Bounded newline-delimited JSON RPC transport, with no raw output or errors escaping. */
export async function readCodexQuota(command: QuotaCommand, signal: AbortSignal): Promise<QuotaReading> {
  let child: ChildProcessWithoutNullStreams | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort = () => {};
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  let failure: Error | undefined;
  const fail = (err: Error) => {
    failure = err;
    for (const request of pending.values()) request.reject(err);
    pending.clear();
  };
  try {
    if (signal.aborted) return { status: "error", windows: [] };
    child = spawn(command.command, command.args, { stdio: "pipe", detached: process.platform !== "win32", cwd: "/tmp" });
    const proc = child;
    onAbort = () => fail(new ProtocolFailure());
    signal.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(onAbort, 20_000);
    proc.on("error", () => fail(new ProtocolFailure(true)));
    proc.on("exit", () => fail(new ProtocolFailure()));
    proc.stdin.on("error", () => fail(new ProtocolFailure()));
    let bytes = 0;
    let buffer = "";
    proc.stdout.setEncoding("utf8");
    const count = (chunk: string | Buffer) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 512 * 1024) { fail(new ProtocolFailure()); return false; }
      return !failure;
    };
    proc.stderr.on("data", count);
    proc.stdout.on("data", (chunk: string) => {
      if (!count(chunk)) return;
      buffer += chunk;
      let end: number;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try {
          const message = object(JSON.parse(line));
          const request = pending.get(message.id as number);
          if (!request) continue;
          pending.delete(message.id as number);
          if (message.error) request.reject(new ProtocolFailure(object(message.error).code === -32601));
          else request.resolve(message.result);
        } catch { fail(new ProtocolFailure()); }
      }
    });
    let id = 0;
    const send = (message: unknown) => proc.stdin.write(`${JSON.stringify(message)}\n`);
    const request = (method: string, params?: unknown) => new Promise<unknown>((resolve, reject) => {
      if (failure) { reject(failure); return; }
      const requestId = ++id;
      pending.set(requestId, { resolve, reject });
      send({ id: requestId, method, ...(params === undefined ? {} : { params }) });
    });
    await request("initialize", { clientInfo: { name: "agent_hub_quota", version: "1.0.0" } });
    send({ method: "initialized", params: {} });
    const info = object(await request("account/read", { refreshToken: false }));
    if (!info.account) return { status: "missing_login", windows: [] };
    if (object(info.account).type !== "chatgpt") return { status: "unavailable", windows: [] };
    return normalizeCodex(await request("account/rateLimits/read"));
  } catch (error) {
    return { status: error instanceof ProtocolFailure && error.unavailable ? "unavailable" : "error", windows: [] };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
    fail(new ProtocolFailure());
    if (child) {
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
      // The host npm launcher has a native child. Kill the isolated process group as well.
      try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch { /* Already exited. */ }
    }
    if (command.container) {
      await promisify(execFile)("docker", ["rm", "-f", command.container], { timeout: 3_000, maxBuffer: 16 * 1024 }).catch(() => {});
    }
  }
}
export async function codexQuota(image: string | null, home: string | undefined, signal: AbortSignal): Promise<QuotaReading> {
  if (image && (!home || !isLoggedIn(home))) return { status: "missing_login", windows: [] };
  try { return await readCodexQuota(quotaCommand(image, home), signal); }
  catch { return { status: "unavailable", windows: [] }; }
}
