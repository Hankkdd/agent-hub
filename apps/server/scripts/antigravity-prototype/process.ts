import { spawn } from "node:child_process";
import { PrototypeError } from "./protocol";

export interface ProcessOptions { signal?: AbortSignal; timeoutMs?: number; maxBytes?: number; onOutput?: (chunk: string) => void }
export function runProcess(command: string, args: string[], options: ProcessOptions = {}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) { reject(new PrototypeError("CANCELLED")); return; }
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: "C.UTF-8" } });
    let stdout = "", stderr = "", bytes = 0;
    let failure: string | undefined;
    let settled = false;
    const stop = (code: string) => { failure ??= code; child.kill("SIGKILL"); };
    const abort = () => stop("CANCELLED");
    const timer = setTimeout(() => stop("TIMEOUT"), options.timeoutMs ?? 60_000);
    options.signal?.addEventListener("abort", abort, { once: true });
    const finish = (code: number | null, signal: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      if (failure || code !== 0 || signal) reject(new PrototypeError(failure ?? "PROCESS_FAILED"));
      else resolve({ stdout, stderr });
    };
    child.on("error", () => { failure = "PROCESS_UNAVAILABLE"; finish(null, null); });
    child.on("close", finish);
    const collect = (chunk: Buffer, channel: "stdout" | "stderr") => {
      bytes += chunk.length;
      if (bytes > (options.maxBytes ?? 64 * 1024)) { stop("OUTPUT_LIMIT"); return; }
      options.onOutput?.(chunk.toString("utf8"));
      if (channel === "stdout") stdout += chunk.toString("utf8"); else stderr += chunk.toString("utf8");
    };
    // Decode at stream boundaries, including CJK split across OS chunks.
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => collect(Buffer.from(chunk), "stdout"));
    child.stderr.on("data", (chunk: string) => collect(Buffer.from(chunk), "stderr"));
  });
}
export type Docker = (args: string[], options?: ProcessOptions) => Promise<{ stdout: string; stderr: string }>;
export const docker: Docker = (args, options) => runProcess("docker", args, options);
export class ContainerCleanupError extends PrototypeError {
  readonly primaryCode: string;
  readonly cleanupCode: string;
  override readonly cause: AggregateError;
  constructor(primary: unknown, cleanup: unknown) {
    super("CONTAINER_CLEANUP_FAILED");
    this.primaryCode = primary instanceof PrototypeError ? primary.code : "LOCAL_PREREQUISITE_FAILED";
    this.cleanupCode = cleanup instanceof PrototypeError ? cleanup.code : "LOCAL_PREREQUISITE_FAILED";
    this.cause = new AggregateError([primary, cleanup]);
  }
}
export async function ownedContainer<T>(docker: Docker, name: string, args: string[], body: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  let failed = false;
  let primary: unknown;
  try {
    await docker(["run", "--detach", "--name", name, ...args], { signal });
    return await body();
  } catch (error) {
    failed = true;
    primary = error;
    throw error;
  } finally {
    // Cancellation must not cancel cleanup. Failure is surfaced so an orphan is never called cleaned.
    try { await docker(["rm", "--force", name], { timeoutMs: 10_000 }); }
    catch (cleanup) {
      if (failed) throw new ContainerCleanupError(primary, cleanup);
      throw cleanup;
    }
  }
}
