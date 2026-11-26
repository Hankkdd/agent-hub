import { randomUUID } from "node:crypto";
import { claudeBinary } from "../agents/claude-docker";
import { ensureImage, imageTag } from "../agents/codex-docker";
import { TerminalDockerRuntime } from "../terminal-login/docker";
import { TERMINAL_SIZE } from "../terminal-login/terminal";

export const OWNER_LABEL = "io.agent-hub.claude-login.owner";
export function containerArgs(name: string, owner: string, home: string, uid: number, gid: number,
  command = ["auth", "login", "--claudeai"], binary = claudeBinary(), image = imageTag()): string[] {
  if (/[,\r\n]/.test(home + binary)) throw new Error("unsafe mount path");
  return ["create", "--name", name, "--label", `${OWNER_LABEL}=${owner}`, "--tty", "--interactive",
    "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--pids-limit=64", "--memory=1g", "--cpus=2",
    "--network=bridge", "--log-driver=none", "--user", `${uid}:${gid}`, "--env", "TERM=xterm-256color",
    "--env", `COLUMNS=${TERMINAL_SIZE.cols}`, "--env", `LINES=${TERMINAL_SIZE.rows}`,
    "--tmpfs", `/tmp:rw,noexec,nosuid,size=64m,uid=${uid},gid=${gid},mode=700`,
    "--mount", `type=bind,src=${home},dst=/claude-home`, "--env", "CLAUDE_CONFIG_DIR=/claude-home", "--env", "HOME=/tmp",
    "--mount", `type=bind,src=${binary},dst=${binary},readonly`, "--entrypoint", binary, image, ...command];
}
export class ClaudeDockerRuntime extends TerminalDockerRuntime {
  constructor() { super({ ownerLabel: OWNER_LABEL, args: containerArgs, prepare: async signal => {
    // Shared image builds can outlive this waiter; cancellation must never launch a late login.
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(5 * 60_000)]);
    await new Promise<void>((resolve, reject) => {
      const abort = () => reject(new Error("image preparation cancelled"));
      deadline.addEventListener("abort", abort, { once: true });
      if (deadline.aborted) { abort(); return; }
      void ensureImage(imageTag()).then(() => resolve(), reject).finally(() => deadline.removeEventListener("abort", abort));
    });
  } }); }
  async run(home: string, owner: string, command: string[]): Promise<{ stdout: string; exitCode: number }> {
    const signal = AbortSignal.timeout(30_000);
    const name = `agent-hub-claude-probe-${randomUUID()}`;
    try {
      await this.prepare(signal);
      const args = containerArgs(name, owner, home, process.getuid!(), process.getgid!(), command);
      for (const flag of ["--tty", "--interactive"]) args.splice(args.indexOf(flag), 1);
      await this.command(args, signal);
      const statusProbe = command.length === 3 && command.join(" ") === "auth status --json";
      let output: string;
      try { output = await this.command(["start", "--attach", name], signal, 30_000); }
      catch (error) {
        // execFile rejects non-zero exits too; status JSON remains authoritative, but transport
        // failures, deadlines and signals must still fail rather than accepting partial output.
        const failure = error as { code?: unknown; stdout?: unknown; killed?: boolean; signal?: unknown };
        if (!statusProbe || typeof failure.code !== "number" || typeof failure.stdout !== "string" ||
            failure.killed || failure.signal || signal.aborted) throw error;
        output = failure.stdout;
      }
      const exit = await this.wait(name, signal);
      if (exit !== 0 && !statusProbe) throw new Error("CLI command failed");
      return { stdout: output, exitCode: exit };
    } finally { await this.remove(name); }
  }
}
