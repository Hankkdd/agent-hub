import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { DeployStatus, Task } from "@agent-hub/shared";
import { HubError } from "../core/hub";

export type CommandRunner = (file: string, args: string[]) => Promise<string>;
const exec = promisify(execFile);
export const run: CommandRunner = async (file, args) => (await exec(file, args, {
  encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
  env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
})).stdout.trim();
const SHA = /^[0-9a-f]{40}$/;
// Match TimeoutStartSec=30min in deploy/agent-hub-deploy@.service.
const DEPLOY_TIMEOUT_MS = 30 * 60_000;
type DeployRequest = { sha: string; requestedAt: string };
const message = (err: unknown) => err instanceof Error ? err.message : String(err);

export class Deployer {
  private accepted = false;
  private starting = false;
  private unitRunning = false;
  private fetchedAt = -Infinity;
  private fetching?: Promise<void>;
  private fetchError?: string;
  private readonly run: CommandRunner;
  private readonly now: () => number;

  constructor(private readonly config: {
    enabled: boolean; checkout: string; dataDir: string;
    run?: CommandRunner; now?: () => number;
  }) {
    this.run = config.run ?? run;
    this.now = config.now ?? Date.now;
  }

  get deploying(): boolean { return this.accepted || this.starting || this.unitRunning; }
  async refreshDeploying(): Promise<boolean> {
    if (this.accepted || this.starting) return true;
    if (!this.config.enabled) return false;
    const request = await this.readRequest();
    if (!request || this.now() - Date.parse(request.requestedAt) > DEPLOY_TIMEOUT_MS) {
      this.unitRunning = false;
      return this.deploying;
    }
    await this.last(request);
    return this.deploying;
  }
  private async writeRequest(contents: string): Promise<void> {
    const destination = path.join(this.config.dataDir, "deploy-request.json");
    await fs.writeFile(`${destination}.tmp`, contents);
    await fs.rename(`${destination}.tmp`, destination);
  }
  private git(...args: string[]) { return this.run("git", ["-C", this.config.checkout, ...args]); }
  private async read(name: string): Promise<string | null> {
    try { return await fs.readFile(path.join(this.config.dataDir, name), "utf8"); }
    catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return null; throw err; }
  }
  private async fetch(): Promise<void> {
    if (this.fetching) return this.fetching;
    if (this.now() - this.fetchedAt < 60_000) return;
    this.fetchedAt = this.now();
    this.fetching = this.git("fetch", "origin").then(() => { this.fetchError = undefined; })
      .catch((err: unknown) => { this.fetchError = message(err); }).finally(() => { this.fetching = undefined; });
    return this.fetching;
  }

  private async readRequest(): Promise<DeployRequest | null> {
    const raw = await this.read("deploy-request.json");
    if (raw === null) return null;
    try {
      const request: unknown = JSON.parse(raw);
      if (!request || typeof request !== "object" ||
        !("sha" in request) || typeof request.sha !== "string" || !SHA.test(request.sha) ||
        !("requestedAt" in request) || typeof request.requestedAt !== "string" || !Number.isFinite(Date.parse(request.requestedAt))) {
        throw new Error("Invalid deploy request");
      }
      return { sha: request.sha, requestedAt: request.requestedAt };
    } catch {
      console.warn("Ignoring invalid deploy-request.json");
      return null;
    }
  }

  private async last(request: DeployRequest | null = null): Promise<DeployStatus["last"]> {
    request ??= await this.readRequest();
    if (!request) { this.unitRunning = false; return null; }
    const unit = `agent-hub-deploy@${request.sha}.service`;
    const output = await this.run("systemctl", ["--user", "show", unit, "-p", "ActiveState", "-p", "Result", "-p", "ExecMainStatus", "-p", "ExecMainExitTimestamp"]);
    const fields = Object.fromEntries(output.split("\n").map((line) => {
      const at = line.indexOf("="); return [line.slice(0, at), line.slice(at + 1)];
    }));
    this.unitRunning = fields.ActiveState === "activating" || fields.ActiveState === "active";
    // A previous run of the same SHA must not look like completion of a newly accepted request.
    const exitedAt = Date.parse(fields.ExecMainExitTimestamp ?? "");
    const stale = !Number.isFinite(exitedAt) || exitedAt < Math.floor(Date.parse(request.requestedAt) / 1000) * 1000;
    const succeeded = fields.ActiveState === "inactive" && fields.Result === "success" && fields.ExecMainStatus === "0";
    const outcome = this.unitRunning || (this.accepted && succeeded && stale) ? "running" : succeeded ? "succeeded" : "failed";
    const log = outcome === "failed" ? await this.run("journalctl", ["--user", "-u", unit, "-n", "50", "--no-pager", "-o", "cat"]) : undefined;
    return { ...request, outcome, result: fields.Result, exitStatus: fields.ExecMainStatus,
      finishedAt: fields.ExecMainExitTimestamp || undefined, log };
  }

  async status(): Promise<DeployStatus> {
    const status: DeployStatus = {
      enabled: this.config.enabled, current: null, target: null, pending: [], dirty: false,
      last: null, history: (await this.read("deploy-history"))?.trim().split("\n").at(-1) || null,
      deploying: this.deploying,
    };
    if (!this.config.enabled) status.disabledReason = "not_enabled";
    try {
      const sha = await this.git("rev-parse", "HEAD");
      status.current = { sha, subject: await this.git("log", "-1", "--format=%s", "HEAD") };
      status.dirty = !!(await this.git("status", "--porcelain", "--untracked-files=all"));
    } catch {
      status.enabled = false;
      status.disabledReason ??= "not_git_checkout";
      return status;
    }
    if (this.config.enabled) {
      try { await this.run("systemctl", ["--user", "cat", "agent-hub-deploy@.service"]); }
      catch { status.enabled = false; status.disabledReason = "unit_not_installed"; }
    }
    await this.fetch();
    status.fetchError = this.fetchError;
    try {
      const sha = await this.git("rev-parse", "origin/main");
      status.target = { sha, subject: await this.git("log", "-1", "--format=%s", "origin/main") };
      const log = await this.git("log", "-30", "--format=%H %s", "HEAD..origin/main");
      status.pending = log ? log.split("\n").map((line) => ({ sha: line.slice(0, 40), subject: line.slice(41) })) : [];
    } catch (err) { status.fetchError ??= message(err); }
    if (this.config.enabled && status.enabled) status.last = await this.last();
    status.deploying = this.deploying;
    return status;
  }

  async start(sha: unknown, tasks: Pick<Task, "status">[]): Promise<DeployStatus> {
    if (typeof sha !== "string" || !SHA.test(sha)) throw new HubError(400, "Expected a full 40-character lowercase commit SHA");
    if (this.deploying) throw new HubError(409, "Deploying; the Hub will restart shortly");
    // Reserve before awaiting status so concurrent requests cannot both pass the checks.
    this.starting = true;
    try {
      const status = await this.status();
      if (!status.enabled) throw new HubError(409, `Deploy disabled: ${status.disabledReason}`);
      if (this.unitRunning) throw new HubError(409, "Deploying; the Hub will restart shortly");
      if (status.dirty) throw new HubError(409, "Production checkout is dirty");
      if (tasks.some((task) => task.status === "running" || task.status === "waiting_user")) throw new HubError(409, "Finish running and waiting tasks before deploying");
      if (sha !== status.target?.sha) throw new HubError(409, "origin/main moved; review again");
      const previous = await this.read("deploy-request.json");
      const requestPath = path.join(this.config.dataDir, "deploy-request.json");
      const request = { sha, requestedAt: new Date(this.now()).toISOString() };
      await this.writeRequest(JSON.stringify(request) + "\n");
      try {
        await this.run("systemctl", ["--user", "start", "--no-block", `agent-hub-deploy@${sha}.service`]);
      } catch (err) {
        if (previous === null) await fs.unlink(requestPath); else await this.writeRequest(previous);
        throw new HubError(409, `Could not start deploy: ${message(err)}`);
      }
      this.accepted = true;
      return { ...status, deploying: true, last: { ...request, outcome: "running" } };
    } finally { this.starting = false; }
  }
}
