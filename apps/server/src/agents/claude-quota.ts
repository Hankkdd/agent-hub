import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { QuotaReading } from "@agent-hub/shared";
import { normalizeClaude } from "./quota-normalize";
import { dockerArgs, type ContainerConfig } from "./claude-docker";

/** Never iterate this query: the control API needs initialization, not a model turn. */
export async function claudeQuota(signal: AbortSignal, container?: ContainerConfig | null): Promise<QuotaReading> {
  const ac = new AbortController();
  let child: ChildProcessWithoutNullStreams | undefined;
  let q: ReturnType<typeof query> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort = () => {};
  // A SIGKILL of the docker client would leave the container running; a known name lets cleanup remove it.
  const name = container ? `agent-hub-claude-quota-${process.pid}-${Date.now().toString(36)}` : undefined;
  try {
    if (signal.aborted) return { status: "error", windows: [] };
    const cancelled = new Promise<never>((_, reject) => {
      onAbort = () => { ac.abort(); reject(new Error("Quota query cancelled")); };
      signal.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(onAbort, 20_000);
    });
    q = query({ prompt: "", options: { tools: [], settingSources: [], permissionMode: "dontAsk", abortController: ac, stderr: () => {}, cwd: "/tmp",
      spawnClaudeCodeProcess: options => {
        if (ac.signal.aborted) throw new Error("Quota query cancelled");
        child = container
          ? spawn("docker", dockerArgs({ ...container, name, command: options.command, args: options.args, env: options.env }), { stdio: "pipe", detached: process.platform !== "win32" })
          : spawn(options.command, options.args, { cwd: options.cwd, env: options.env, stdio: "pipe", detached: process.platform !== "win32" });
        let bytes = 0;
        const count = (chunk: Buffer | string) => { bytes += Buffer.byteLength(chunk); if (bytes > 512 * 1024) onAbort(); };
        child.stdout.on("data", count);
        child.stderr.on("data", count);
        // SDK handles process errors; stderr is deliberately discarded here.
        return child;
      } } });
    const method = q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
    if (typeof method !== "function") return { status: "unavailable", windows: [] };
    const account = await Promise.race([q.accountInfo(), cancelled]);
    if ((!account.apiProvider || account.apiProvider === "firstParty") && (!account.tokenSource || account.tokenSource === "none") && (!account.apiKeySource || account.apiKeySource === "none") && !account.subscriptionType) return { status: "missing_login", windows: [] };
    const usage = await Promise.race([method.call(q, { skipBehaviors: true }), cancelled]);
    return normalizeClaude(usage);
  } catch {
    // Provider errors can contain tokens. Neither return nor log them.
    return { status: "error", windows: [] };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
    ac.abort();
    try { q?.close(); } catch { /* Cleanup must not expose SDK errors. */ }
    if (child) {
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
      try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch { /* Already exited. */ }
    }
    if (name) spawn("docker", ["rm", "-f", name], { stdio: "ignore" }).on("error", () => {});
  }
}
