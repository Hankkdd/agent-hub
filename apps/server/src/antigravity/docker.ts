import { execFile } from "node:child_process";
import { promisify } from "node:util";
import http from "node:http";
import type { Duplex } from "node:stream";
import path from "node:path";
import { DOCKER_DIR, imageTag, type ImageSpec } from "../docker/images";

import { TERMINAL_SIZE } from "./terminal";

const exec = promisify(execFile);
const IMAGE: ImageSpec = { name: "agent-hub-antigravity-prototype", version: "1.3.6",
  dockerfile: "antigravity-prototype.Dockerfile", files: ["antigravity-prototype/agent.md", "antigravity-prototype/settings.json"] };
export interface Attachment { write(text: string): void; close(): void }
export interface ContainerRuntime {
  reachable(): Promise<boolean>;
  prepare(signal: AbortSignal): Promise<void>;
  create(name: string, owner: string, home: string, signal: AbortSignal): Promise<void>;
  attach(name: string, output: (data: Buffer) => void, lost: () => void): Promise<Attachment>;
  start(name: string, signal: AbortSignal): Promise<void>;
  wait(name: string, signal: AbortSignal): Promise<number>;
  remove(name: string): Promise<void>;
  cleanup(owner: string): Promise<void>;
}
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
export class DockerRuntime implements ContainerRuntime {
  constructor(private socketPath = "/var/run/docker.sock") {}
  protected dockerArgs(args: string[]): string[] {
    // Pin all subprocesses to the same Engine as attach, regardless of the host's Docker context.
    return ["--host", `unix://${this.socketPath}`, ...args];
  }
  protected async command(args: string[], signal?: AbortSignal, timeout = 15_000): Promise<string> {
    const result = await exec("docker", this.dockerArgs(args),
      { signal, timeout, maxBuffer: 1024 * 1024 });
    return result.stdout.trim();
  }
  async reachable() { try { await this.command(["info", "--format", "{{.Architecture}}"]); return true; } catch { return false; } }
  async prepare(signal: AbortSignal) {
    try { await this.command(["image", "inspect", imageTag(IMAGE)], signal); return; } catch { signal.throwIfAborted(); }
    await this.command(["build", "-t", imageTag(IMAGE), "-f", path.join(DOCKER_DIR, IMAGE.dockerfile), DOCKER_DIR], signal, 5 * 60_000);
  }
  async create(name: string, owner: string, home: string, signal: AbortSignal) {
    await this.command(containerArgs(name, owner, home, process.getuid!(), process.getgid!()), signal);
  }
  async attach(name: string, output: (data: Buffer) => void, lost: () => void): Promise<Attachment> {
    return new Promise((resolve, reject) => {
      const req = http.request({ socketPath: this.socketPath, method: "POST",
        path: `/containers/${encodeURIComponent(name)}/attach?stream=1&stdin=1&stdout=1&stderr=1`,
        headers: { Connection: "Upgrade", Upgrade: "tcp" } });
      req.setTimeout(15_000, () => req.destroy(new Error("attach timeout")));
      req.on("error", reject);
      req.on("response", response => { response.resume(); reject(new Error("attach rejected")); });
      req.on("upgrade", (_response, socket: Duplex, head: Buffer) => {
        req.setTimeout(0);
        socket.on("data", output);
        socket.on("error", lost);
        socket.on("end", lost);
        if (head.length) output(head);
        resolve({ write: text => { if (socket.destroyed || socket.writableLength > 16 * 1024) throw new Error("attach unavailable"); socket.write(text); }, close: () => socket.destroy() });
      });
      req.end();
    });
  }
  async start(name: string, signal: AbortSignal) {
    await this.command(["start", name], signal);
    // resize uses the Engine API and requires no controlling host terminal.
    await new Promise<void>((resolve, reject) => {
      const req = http.request({ socketPath: this.socketPath, method: "POST", signal,
        path: `/containers/${encodeURIComponent(name)}/resize?h=${TERMINAL_SIZE.rows}&w=${TERMINAL_SIZE.cols}` }, response => {
        response.resume();
        response.on("end", () => response.statusCode === 200 ? resolve() : reject(new Error("resize failed")));
      });
      req.setTimeout(15_000, () => req.destroy(new Error("resize timeout")));
      req.on("error", reject); req.end();
    });
  }
  async wait(name: string, signal: AbortSignal) {
    const value = await this.command(["wait", name], signal, 10 * 60_000);
    if (!/^\d+$/.test(value)) throw new Error("invalid exit code");
    return Number(value);
  }
  async remove(name: string) { await this.command(["rm", "--force", name]); }
  async cleanup(owner: string) {
    const ids = await this.command(["ps", "-aq", "--filter", `label=${OWNER_LABEL}=${owner}`]);
    for (const id of ids.split(/\s+/).filter(Boolean)) {
      if (!/^[a-f0-9]{12,64}$/.test(id)) throw new Error("invalid container id");
      await this.remove(id);
    }
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
