import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { DOCKER_DIR, imageTag, type ImageSpec } from "../src/docker/images";
import { ContainerCleanupError, docker, ownedContainer, type Docker } from "./antigravity-prototype/process";
import { PrototypeError, SYNTHETIC_PROMPT, verifyProtocol } from "./antigravity-prototype/protocol";
import { readLedger, writeLedger } from "./antigravity-prototype/ledger";

export const VERSION = "1.3.6";
export const IMAGE: ImageSpec = { name: "agent-hub-antigravity-prototype", version: VERSION,
  dockerfile: "antigravity-prototype.Dockerfile", files: ["antigravity-prototype/agent.md", "antigravity-prototype/settings.json"] };
const LABEL = "io.agent-hub.antigravity-prototype";

export function verifyCliHelp(output: { stdout: string; stderr: string }): void {
  // Go flag help may use stderr even when --help succeeds; model diagnostics remain strict.
  const help = `${output.stdout}\n${output.stderr}`;
  if (["--agent", "--output-format", "--print"].some(flag => !help.includes(flag))) throw new PrototypeError("UNSUPPORTED_CLI_FLAGS");
}

async function privateDirectory(dir: string): Promise<void> {
  // Reject symlinks in every existing component, rather than following an account/config alias.
  const absolute = path.resolve(dir);
  const parts = absolute.split(path.sep).filter(Boolean);
  let cursor = path.parse(absolute).root;
  for (const part of parts) {
    cursor = path.join(cursor, part);
    try {
      const stat = await fs.lstat(cursor);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new PrototypeError("UNSAFE_STATE_PATH");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await fs.mkdir(cursor, { mode: 0o700 });
    }
  }
  await fs.chmod(absolute, 0o700);
}
async function verifyPrivateState(dir: string, budget = { entries: 0 }): Promise<void> {
  for (const name of await fs.readdir(dir)) {
    if (++budget.entries > 1024) throw new PrototypeError("STATE_LIMIT");
    const target = path.join(dir, name);
    const stat = await fs.lstat(target);
    if (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || stat.isSymbolicLink() ||
        (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1))) throw new PrototypeError("UNSAFE_AUTH_STATE");
    if (stat.isDirectory()) await verifyPrivateState(target, budget);
  }
}
export async function prepareState(dataRoot: string) {
  const state = path.resolve(dataRoot, "antigravity-prototype");
  await privateDirectory(state);
  for (const dir of ["auth", "config", "auth/config", "auth/antigravity-cli"]) await privateDirectory(path.join(state, dir));
  const placeholder = await fs.open(path.join(state, "auth/antigravity-cli/settings.json"), "ax", 0o600).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return undefined;
  });
  await placeholder?.close();
  await verifyPrivateState(path.join(state, "auth"));
  // Configuration is disposable and must not accumulate provider-created or previous-run capabilities.
  await fs.rm(path.join(state, "config"), { recursive: true });
  await privateDirectory(path.join(state, "config/agents"));
  // Only runner-owned configuration is mounted. Never reuse provider-generated settings or agents.
  for (const [source, destination] of [["agent.md", "config/agents/hub-prototype.md"], ["settings.json", "settings.json"], ["settings.json", "config/config.json"]]) {
    const target = path.join(state, destination!);
    try { if (!(await fs.lstat(target)).isFile()) throw new PrototypeError("UNSAFE_STATE_PATH"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await fs.rm(target, { force: true });
    if (destination === "config/config.json") await fs.writeFile(target, "{}\n", { mode: 0o600 });
    else await fs.copyFile(path.join(DOCKER_DIR, "antigravity-prototype", source!), target);
    await fs.chmod(target, 0o600);
  }
  return state;
}
// The login panel seeded this protobuf-JSON path with legacy settings. Repair only an exact
// repository-owned seed, leaving CLI-created/account-specific configurations untouched.
export async function repairSeededConfig(home: string) {
  const directory = path.join(home, ".gemini/config");
  const expected = path.resolve(home);
  try {
    if (await fs.realpath(directory) !== path.join(expected, ".gemini/config")) throw new PrototypeError("UNSAFE_STATE_PATH");
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  let handle;
  try { handle = await fs.open(path.join(directory, "config.json"), constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || stat.size > 65536) throw new PrototypeError("UNSAFE_STATE_PATH");
    const seeded = await fs.readFile(path.join(DOCKER_DIR, "antigravity-prototype/settings.json"));
    if (!(await handle.readFile()).equals(seeded)) return;
    await handle.truncate(0);
    await handle.write(Buffer.from("{}\n"), 0, 3, 0);
    await handle.sync();
  } finally { await handle.close(); }
}
export function containerArgs(state: string, tag: string, owner: string, network = "none"): string[] {
  if (!process.getuid || process.getuid() === 0) throw new PrototypeError("NON_ROOT_REQUIRED");
  if (state.includes(",")) throw new PrototypeError("UNSAFE_STATE_PATH");
  const uid = process.getuid(), gid = process.getgid!();
  return ["--label", `${LABEL}=true`, "--label", `${LABEL}.owner=${owner}`, "--user", `${uid}:${gid}`,
    "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--pids-limit=64", "--memory=1g", "--cpus=2",
    "--network", network, "--log-driver=none", "--tmpfs", `/tmp:rw,noexec,nosuid,size=64m,uid=${uid},gid=${gid},mode=700`,
    "--tmpfs", `/home/prototype:rw,nosuid,size=64m,uid=${uid},gid=${gid},mode=700`,
    "--tmpfs", `/work:rw,noexec,nosuid,size=1m,uid=${uid},gid=${gid},mode=700`,
    "--mount", `type=bind,src=${state}/auth,dst=/home/prototype/.gemini`,
    "--mount", `type=bind,src=${state}/config,dst=/home/prototype/.gemini/config,readonly`,
    "--mount", `type=bind,src=${state}/settings.json,dst=/home/prototype/.gemini/antigravity-cli/settings.json,readonly`,
    "--env", "HOME=/home/prototype", "--env", "AGY_CLI_DISABLE_AUTO_UPDATE=true", "--env", "GEMINI_FORCE_FILE_STORAGE=true",
    "--entrypoint", "/bin/sleep", tag, "infinity"];
}
export async function selectImage(signal: AbortSignal, transport: Docker = docker, architecture = os.arch()): Promise<string> {
  if (architecture !== "arm64") throw new PrototypeError("UNSUPPORTED_ARCHITECTURE");
  const info = await transport(["info", "--format", "{{.Architecture}}"], { signal, timeoutMs: 10_000 });
  if (!["aarch64", "arm64"].includes(info.stdout.trim())) throw new PrototypeError("UNSUPPORTED_DAEMON_ARCHITECTURE");
  const tag = imageTag(IMAGE);
  try { await transport(["image", "inspect", tag], { signal }); }
  catch {
    if (signal.aborted) throw new PrototypeError("CANCELLED");
    await transport(["build", "--platform", "linux/arm64", "--tag", tag, "--file", path.join(DOCKER_DIR, IMAGE.dockerfile), DOCKER_DIR],
      { signal, timeoutMs: 600_000, maxBytes: 4 * 1024 * 1024 });
  }
  return tag;
}
export async function cleanupOwned(transport: Docker, owner: string) {
  const found = await transport(["ps", "-aq", "--filter", `label=${LABEL}=true`, "--filter", `label=${LABEL}.owner=${owner}`], { timeoutMs: 10_000 });
  const ids = found.stdout.trim().split(/\s+/).filter(Boolean);
  if (ids.some(id => !/^[a-f0-9]{12,64}$/.test(id))) throw new PrototypeError("INVALID_CONTAINER_ID");
  for (const id of ids) await transport(["rm", "--force", id], { timeoutMs: 10_000 });
  return ids.length;
}
export async function liveRequests(transport: Docker, state: string, name: string, command: "live-initial" | "live-restart", runnerId: string, signal?: AbortSignal, report: (evidence: unknown) => void = evidence => console.log(JSON.stringify(evidence))) {
  const ledger = await readLedger(state);
  if (command === "live-initial" && ledger.attempts !== 0) throw new PrototypeError("INITIAL_ALREADY_ATTEMPTED");
  if (command === "live-restart" && (ledger.attempts !== 2 || ledger.completed !== 2 || !ledger.initialRunner || ledger.initialRunner === runnerId)) throw new PrototypeError("INITIAL_NOT_VERIFIED");
  const count = command === "live-initial" ? 2 : 1;
  for (let index = 0; index < count; index++) {
    if (ledger.attempts >= 3) throw new PrototypeError("REQUEST_BUDGET_EXHAUSTED");
    ledger.attempts++;
    ledger.initialRunner ??= runnerId;
    await writeLedger(state, ledger);
    const result = await transport(["exec", name, "/bin/sh", "-c", 'umask 077; exec agy "$@"', "prototype", "--agent", "hub-prototype", "-p", SYNTHETIC_PROMPT, "--output-format", "stream-json"], { signal, timeoutMs: 60_000 });
    const evidence = verifyProtocol(result.stdout, result.stderr);
    ledger.completed++;
    await writeLedger(state, ledger);
    report({ evidence: "live-subscription-experiment", request: ledger.attempts,
      combination: command === "live-restart" ? "new-runner-recreated-container" : index === 0 ? "initial-container" : "fresh-cli-same-container",
      ...evidence, refresh: "NOT_VERIFIED", language: "CJK_PRESENT_TAIWAN_REVIEW_REQUIRED" });
  }
}

export async function main(args = process.argv.slice(2)) {
  const command = args[0] ?? "offline";
  if (args.length > 1 || !["offline", "image-check", "login-prepare", "live-initial", "live-restart", "cleanup"].includes(command)) throw new PrototypeError("INVALID_COMMAND");
  if (command === "offline") {
    const fixture = [{ event: "init", conversation_id: "fixture", init: { agent: "hub-prototype", cwd: "/work", tools: [] } },
      { event: "result", result: { conversation_id: "fixture", status: "SUCCESS", response: JSON.stringify({ hunks: [{ id: "synthetic-1", explanation: "\u589e\u52a0\u91cd\u8a66\u6b21\u6578\u3002" }] }) } }];
    console.log(JSON.stringify({ evidence: "offline-fixture", ...verifyProtocol(fixture.map(e => JSON.stringify(e)).join("\n")) }));
    return;
  }
  const controller = new AbortController();
  const cancel = () => controller.abort();
  const temporary = command === "image-check" ? path.join(os.tmpdir(), `hub-agy-prototype-image-check-${process.getuid?.()}`) : undefined;
  const dataRoot = temporary ?? process.env.AGENT_HUB_ANTIGRAVITY_PROTOTYPE_DATA ?? process.env.AGENT_HUB_DATA;
  if (!dataRoot) throw new PrototypeError("EXPLICIT_DATA_ROOT_REQUIRED");
  const state = path.resolve(dataRoot, "antigravity-prototype");
  await privateDirectory(state);
  const owner = createHash("sha256").update(state).digest("hex").slice(0, 24);
  const lockPath = path.join(state, "runner.lock");
  let locked = false;
  process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
  try {
    try { await fs.mkdir(lockPath, { mode: 0o700 }); locked = true; }
    catch {
      if (command !== "cleanup" && command !== "image-check") throw new PrototypeError("STATE_LOCKED");
      let pid: number;
      try { pid = Number(await fs.readFile(path.join(lockPath, "pid"), "utf8")); } catch { throw new PrototypeError("STATE_LOCKED"); }
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new PrototypeError("STATE_LOCKED");
      try { process.kill(pid, 0); throw new PrototypeError("STATE_LOCKED"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      await fs.rm(lockPath, { recursive: true });
      await fs.mkdir(lockPath, { mode: 0o700 }); locked = true;
    }
    await fs.writeFile(path.join(lockPath, "pid"), String(process.pid), { mode: 0o600, flag: "wx" });
    await prepareState(dataRoot);
    if (command === "login-prepare") {
      console.log(JSON.stringify({ evidence: "preparation-only", login: "BLOCKED", reason: "NO_SECURE_HUB_BROWSER_CODE_INPUT", modelRequests: 0 }));
      process.exitCode = 2;
      return;
    }
    await cleanupOwned(docker, owner);
    if (command === "cleanup") { console.log("PASS prototype-owned container cleanup"); return; }
    const tag = await selectImage(controller.signal);
    const name = `hub-agy-prototype-${randomUUID()}`;
    const network = command === "image-check" ? "none" : "bridge";
    const runnerId = randomUUID();
    await ownedContainer(docker, name, containerArgs(state, tag, owner, network), async () => {
      const version = await docker(["exec", name, "agy", "--version"], { signal: controller.signal });
      if (version.stderr.trim() || !/^(?:(?:Antigravity CLI |agy )?v?)1\.3\.6\s*$/.test(version.stdout.trim())) throw new PrototypeError("UNSUPPORTED_VERSION");
      if (command === "image-check") {
        const help = await docker(["exec", name, "agy", "--help"], { signal: controller.signal });
        verifyCliHelp(help);
        // This fixed shell has no user-supplied arguments and runs only inside the owned container.
        const check = await docker(["exec", name, "/bin/sh", "-c", 'test "$(id -u)" != 0 && test -z "$(ls -A /work)" && test ! -S /var/run/docker.sock && test "$AGY_CLI_DISABLE_AUTO_UPDATE" = true && test "$GEMINI_FORCE_FILE_STORAGE" = true']);
        if (check.stderr.trim()) throw new PrototypeError("TRANSPORT_DIAGNOSTIC");
        console.log(JSON.stringify({ evidence: "real-container-without-model", version: VERSION, architecture: "arm64", transport: "PASS", authentication: "NOT_RUN", strictIsolation: "UNVERIFIED" }));
        return;
      }
      await liveRequests(docker, state, name, command as "live-initial" | "live-restart", runnerId, controller.signal);
    }, controller.signal);
  } finally {
    if (locked) await fs.rm(lockPath, { recursive: true });
    process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel);
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(JSON.stringify({ status: "FAIL_OR_BLOCKED", code: error instanceof PrototypeError ? error.code : "LOCAL_PREREQUISITE_FAILED",
      ...(error instanceof ContainerCleanupError ? { primaryCode: error.primaryCode, cleanupCode: error.cleanupCode } : {}) }));
    process.exitCode = 1;
  });
}
