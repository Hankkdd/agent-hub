import path from "node:path";
import { DOCKER_DIR, imageTag, type ImageSpec } from "../docker/images";

import { TERMINAL_SIZE } from "./terminal";

const IMAGE: ImageSpec = { name: "agent-hub-antigravity-prototype", version: "1.3.6",
  dockerfile: "antigravity-prototype.Dockerfile", files: ["antigravity-prototype/agent.md", "antigravity-prototype/settings.json"] };
export type { Attachment, ContainerRuntime } from "../terminal-login/docker";
import { TerminalDockerRuntime } from "../terminal-login/docker";
export const OWNER_LABEL = "io.agent-hub.antigravity-login.owner";
export function containerArgs(name: string, owner: string, home: string, uid: number, gid: number): string[] {
  // Docker's --mount value is CSV even though execFile itself never invokes a shell.
  if (home.includes(",")) throw new Error("unsafe mount path");
  return ["create", "--name", name, "--label", `${OWNER_LABEL}=${owner}`, "--tty", "--interactive",
    "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--pids-limit=64", "--memory=1g", "--cpus=2",
    "--network=bridge", "--log-driver=none", "--user", `${uid}:${gid}`, "--env", "TERM=xterm-256color",
    "--env", `COLUMNS=${TERMINAL_SIZE.cols}`, "--env", `LINES=${TERMINAL_SIZE.rows}`,
    "--tmpfs", `/tmp:rw,noexec,nosuid,size=64m,uid=${uid},gid=${gid},mode=700`,
    "--tmpfs", `/work:rw,noexec,nosuid,size=1m,uid=${uid},gid=${gid},mode=700`,
    "--mount", `type=bind,src=${home},dst=/home/prototype`, imageTag(IMAGE)];
}
export class DockerRuntime extends TerminalDockerRuntime {
  constructor(socketPath?: string) {
    super({ ownerLabel: OWNER_LABEL, args: containerArgs, prepare: async () => {} }, socketPath);
  }
  async prepare(signal: AbortSignal) {
    try { await this.command(["image", "inspect", imageTag(IMAGE)], signal); return; } catch { signal.throwIfAborted(); }
    await this.command(["build", "-t", imageTag(IMAGE), "-f", path.join(DOCKER_DIR, IMAGE.dockerfile), DOCKER_DIR], signal, 5 * 60_000);
  }
}

/** Chat reuses the login image and hardening, with exactly two bind mounts and no TTY. */
export function chatContainerArgs(name: string, owner: string, home: string, scratch: string, prompt: string, uid: number, gid: number): string[] {
  if (!path.isAbsolute(home) || !path.isAbsolute(scratch) || /[,\r\n]/.test(home + scratch)) throw new Error("unsafe mount path");
  const args = containerArgs(name, owner, home, uid, gid);
  // The root remains read-only: the proven CLI only needs its writable home, /tmp and /work.
  for (const flag of ["--tty", "--interactive"]) args.splice(args.indexOf(flag), 1);
  const work = args.findIndex(value => value.startsWith("/work:rw,"));
  args.splice(work - 1, 2);
  args.splice(args.length - 1, 0, "--mount", `type=bind,src=${scratch},dst=/work`);
  args.push("--agent", "hub-chat", "-p", prompt, "--output-format", "stream-json");
  return args;
}
