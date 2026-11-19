import { execFile, execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk";

// Claude Code in the same kind of throwaway container as Codex (see bin/codex-docker and
// design.md §7.2): only the task directory is mounted, read-only for reviewers; the main .git is
// read-only, so commits stay the Hub's job; the container has its own login in claude-home and
// never sees the host's home, data directory or credentials. The SDK picks the Claude Code binary
// that matches it; we run that same binary, mounted read-only, so versions can never drift.

const exec = promisify(execFile);
export const LABEL = "agent-hub=claude";
const CONTAINER_HOME = "/claude-home";

export interface ContainerConfig {
  image: string;
  claudeHome: string;
  cacheDir?: string;
  uid?: string;
}
export interface TurnMounts {
  readOnly?: boolean;
  referenceDirs?: string[];
}
export interface DockerArgsInput extends ContainerConfig, TurnMounts {
  command: string;
  args: string[];
  cwd?: string;
  env: Record<string, string | undefined>;
  /** The worktree's shared .git when it lives outside cwd; resolved by the caller. */
  gitCommonDir?: string;
  /** A container name, for callers that must remove it after killing the docker client. */
  name?: string;
}

// The SDK hands the spawner the whole server environment, which carries the Hub's secrets. Only
// what Claude Code itself reads crosses into the container.
const PASSED_ENV = /^(ANTHROPIC_|CLAUDE_CODE_|CLAUDE_AGENT_SDK_|DEBUG(_|$))/;

export function dockerArgs(input: DockerArgsInput): string[] {
  const uid = input.uid ?? `${process.getuid!()}:${process.getgid!()}`;
  const mounts: string[] = [];
  const seen = new Set<string>();
  const mount = (dir: string, mode: "ro" | "rw") => {
    if (seen.has(dir)) return;
    seen.add(dir);
    // Same path inside and out, so paths in Claude's output mean the same thing on the host.
    mounts.push("-v", `${dir}:${dir}:${mode}`);
  };
  if (input.cwd) {
    mount(input.cwd, input.readOnly ? "ro" : "rw");
    mounts.push("-w", input.cwd);
  }
  if (input.gitCommonDir && !(input.cwd && input.gitCommonDir.startsWith(input.cwd + path.sep))) mount(input.gitCommonDir, "ro");
  for (const dir of input.referenceDirs ?? []) if (path.isAbsolute(dir)) mount(dir, "ro");
  if (path.isAbsolute(input.command)) mount(path.dirname(input.command), "ro");
  if (input.cacheDir) {
    mounts.push("-v", `${input.cacheDir}:/cache`, "-e", "npm_config_store_dir=/cache/pnpm-store",
      "-e", "GOMODCACHE=/cache/go-mod", "-e", "GOCACHE=/cache/go-build");
  }
  const env: string[] = [];
  for (const [name, value] of Object.entries(input.env)) {
    if (value !== undefined && PASSED_ENV.test(name) && name !== "CLAUDE_CONFIG_DIR") env.push("-e", `${name}=${value}`);
  }
  return [
    "run", "--rm", "-i", "--init", "--label", LABEL, ...(input.name ? ["--name", input.name] : []), "--user", uid,
    "-e", "HOME=/tmp", "-e", `CLAUDE_CONFIG_DIR=${CONTAINER_HOME}`, "-v", `${input.claudeHome}:${CONTAINER_HOME}`,
    ...mounts, ...env, input.image, input.command, ...input.args,
  ];
}

function gitCommonDir(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined;
  try {
    return execFileSync("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).trim() || undefined;
  } catch { return undefined; }
}

/** The SDK's spawnClaudeCodeProcess for one turn: Claude Code runs in a fresh container. */
export function spawnInDocker(config: ContainerConfig, turn: TurnMounts = {}): (options: SpawnOptions) => SpawnedProcess {
  return (options) => {
    if (config.cacheDir) {
      for (const dir of ["pnpm-store", "go-mod", "go-build"]) fs.mkdirSync(path.join(config.cacheDir, dir), { recursive: true });
    }
    const args = dockerArgs({ ...config, ...turn, command: options.command, args: options.args, cwd: options.cwd, env: options.env, gitCommonDir: gitCommonDir(options.cwd) });
    // signal is the SDK's forwarded abort: it fires after stdin EOF and a grace window. Killing the
    // docker client then forwards SIGTERM into the container (sig-proxy), and --rm removes it.
    const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"], signal: options.signal });
    child.stderr.resume();
    return child;
  };
}

/** Remove Claude containers a hard kill of the server left running. Safe at boot: none are ours yet. */
export async function removeOrphans(): Promise<number> {
  try {
    const { stdout } = await exec("docker", ["ps", "-aq", "--filter", `label=${LABEL}`]);
    const ids = stdout.split("\n").filter(Boolean);
    if (ids.length) await exec("docker", ["rm", "-f", ...ids]);
    return ids.length;
  } catch {
    return 0;
  }
}

/** The container's own Claude login lives here, apart from the host's ~/.claude. */
export function isLoggedIn(claudeHome: string): boolean {
  return fs.existsSync(path.join(claudeHome, ".credentials.json"));
}

/**
 * The Claude Code binary the installed SDK runs, for commands outside a query (login). The image is
 * glibc Debian, so the glibc build is the one that runs in it.
 */
export function claudeBinary(): string {
  const sdk = createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk");
  return createRequire(sdk).resolve(`@anthropic-ai/claude-agent-sdk-linux-${process.arch}/claude`);
}

/** The one command a human runs once, printed wherever the login is missing. */
export function loginCommand(): string {
  return "mise exec -- pnpm claude:login";
}

/**
 * A conversation started while Claude ran on the host lives in the host's config directory. Copy
 * it into claude-home once, so switching the runtime does not cut running tasks off from their
 * history. Session ids are UUIDs, so the file is found by name in any project directory; an
 * existing copy is never overwritten.
 */
export function carryOverSession(threadId: string | undefined, claudeHome: string, hostConfigDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude")): boolean {
  if (!threadId || !/^[0-9a-f-]{36}$/i.test(threadId)) return false;
  const file = `${threadId}.jsonl`;
  const hostProjects = path.join(hostConfigDir, "projects");
  const homeProjects = path.join(claudeHome, "projects");
  let dirs: string[];
  try { dirs = fs.readdirSync(hostProjects); } catch { return false; }
  for (const dir of dirs) {
    if (fs.existsSync(path.join(homeProjects, dir, file))) return false;
  }
  for (const dir of dirs) {
    const source = path.join(hostProjects, dir, file);
    if (!fs.existsSync(source)) continue;
    fs.mkdirSync(path.join(homeProjects, dir), { recursive: true });
    fs.copyFileSync(source, path.join(homeProjects, dir, file), fs.constants.COPYFILE_EXCL);
    return true;
  }
  return false;
}
