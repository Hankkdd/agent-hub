import { redactSecrets } from "../core/redact";
import fs from "node:fs/promises";
import path from "node:path";
import { type CommandRunner, type Deployer, run } from "./deployer";

const message = (err: unknown) => (err instanceof Error ? err.message : String(err)).split("\n")[0]!.slice(0, 500);

export class HostStatus {
  private readonly run: CommandRunner;
  private readonly now: () => number;
  private readonly fetches = new Map<string, { at: number; pending?: Promise<void>; error?: string }>();

  constructor(private readonly config: {
    deployer: Deployer; run?: CommandRunner; dataDir: string; now?: () => number;
  }) {
    this.run = config.run ?? run;
    this.now = config.now ?? Date.now;
  }

  private async read(name: string): Promise<string | null> {
    try { return await fs.readFile(path.join(this.config.dataDir, name), "utf8"); }
    catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return null; throw err; }
  }

  async status(repoPath: string | undefined, base: string | undefined): Promise<string> {
    const section = async (name: string, action: () => Promise<string>) => {
      try { return `${name}:\n${await action()}`; }
      catch (err) { return `${name}: unavailable: ${message(err)}`; }
    };
    const sections = await Promise.all([
      section("Production", async () => {
        const s = await this.config.deployer.status();
        const commit = (c: typeof s.current) => c ? `${c.sha.slice(0, 8)} ${c.subject}` : "unavailable";
        return [
          s.enabled ? "Deployment enabled" : `Deployment disabled: ${s.disabledReason ?? "unknown"}`,
          `Current: ${commit(s.current)}`, `origin/main: ${commit(s.target)}`,
          `Pending commits: ${s.pending.length}`, ...s.pending.slice(0, 10).map(commit),
          `Checkout: ${s.dirty ? "dirty" : "clean"}`,
          ...(s.fetchError ? [`Fetch error: ${s.fetchError}`] : []),
          s.last ? `Last button deploy: ${s.last.sha.slice(0, 8)} requested ${s.last.requestedAt}, ${s.last.outcome}` : "Last button deploy: none recorded",
          `Deploy running: ${s.deploying ? "yes" : "no"}`,
        ].join("\n");
      }),
      section("Deploy history", async () => (await this.read("deploy-history"))?.trim().split("\n").slice(-5).join("\n") || "none recorded"),
      section("Service", async () => {
        try {
          const output = await this.run("systemctl", ["--user", "show", "agent-hub-prod.service", "-p", "ActiveState", "-p", "SubState", "-p", "ActiveEnterTimestamp"]);
          const fields = Object.fromEntries(output.split("\n").map((line) => {
            const at = line.indexOf("="); return [line.slice(0, at), line.slice(at + 1)];
          }));
          return `agent-hub-prod: ${fields.ActiveState || "unknown"} (${fields.SubState || "unknown"}) since ${fields.ActiveEnterTimestamp || "unknown"}`;
        } catch (err) { return `systemctl unavailable: ${message(err)}`; }
      }),
      ...(repoPath ? [section("Planning repository", () => this.repository(repoPath, base))] : []),
    ]);
    return sections.join("\n\n");
  }

  private async repository(repoPath: string, base: string | undefined): Promise<string> {
    const git = (...args: string[]) => this.run("git", ["-C", repoPath, ...args]);
    let fetch = this.fetches.get(repoPath);
    if (!fetch || (!fetch.pending && this.now() - fetch.at >= 60_000)) {
      fetch = { at: this.now() };
      this.fetches.set(repoPath, fetch);
      const state = fetch;
      state.pending = git("fetch", "origin").then(() => { state.error = undefined; })
        .catch((err: unknown) => { state.error = message(err); }).finally(() => { state.pending = undefined; });
    }
    await fetch.pending;
    const lines = fetch.error ? [`Fetch error: ${fetch.error}`] : [];
    // Keep the fetch error visible even if a later repository read fails.
    try {
      const sha = await git("rev-parse", "HEAD");
      const subject = await git("log", "-1", "--format=%s", "HEAD");
      const branch = await git("rev-parse", "--abbrev-ref", "HEAD");
      lines.push(`HEAD: ${branch} ${sha.slice(0, 8)} ${subject}`);
      const ref = base || await git("symbolic-ref", "--short", "refs/remotes/origin/HEAD");
      lines.push(`Compare ref: ${ref}`);
      const counts = (await git("rev-list", "--left-right", "--count", `HEAD...${ref}`)).trim().match(/^(\d+)\s+(\d+)$/);
      if (!counts) throw new Error("Invalid ahead/behind counts");
      lines.push(`Ahead: ${counts[1]}, behind: ${counts[2]}`);
      const dirty = (await git("status", "--porcelain")).trim();
      lines.push(`Working tree: ${dirty ? `dirty (${dirty.split("\n").length} entries)` : "clean"}`);
    } catch (err) { lines.push(`Repository unavailable: ${message(err)}`); }
    return lines.join("\n");
  }

  async serviceLog(input: { unit: "prod" | "deploy"; lines?: number; grep?: string[] }): Promise<string> {
    let output: string;
    try {
      let unit = "agent-hub-prod.service";
      if (input.unit === "deploy") {
        let request: { sha?: unknown; requestedAt?: unknown } | null = null;
        try { request = JSON.parse(await this.read("deploy-request.json") ?? "null"); } catch { /* Invalid requests cannot select a unit. */ }
        if (!request || typeof request.sha !== "string" || !/^[0-9a-f]{40}$/.test(request.sha) ||
          typeof request.requestedAt !== "string" || !Number.isFinite(Date.parse(request.requestedAt))) {
          return "No valid latest deploy request recorded.";
        }
        unit = `agent-hub-deploy@${request.sha}.service`;
      }
      const lines = Number.isFinite(input.lines) ? Math.max(1, Math.min(300, Math.floor(input.lines!))) : 80;
      const terms = input.grep?.map((term) => term.toLowerCase()) ?? [];
      output = await this.run("journalctl", ["--user", "-u", unit, "-n", String(terms.length ? 2000 : lines), "--no-pager", "-o", "short-iso"]);
      output = output.split("\n").filter((line) => !terms.length || terms.some((term) => line.toLowerCase().includes(term))).slice(-lines).join("\n");
    } catch (err) { output = `Service log unavailable: ${message(err)}`; }

    // Fail closed if the token file cannot be read: returning raw logs could expose its contents.
    let token: string | null;
    try { token = await this.read("token"); }
    catch { return "Service log unavailable: token redaction could not be loaded."; }
    output = redactSecrets(output, token);
    const marker = "\n[truncated]";
    return output.length > 32_000 ? output.slice(0, 32_000 - marker.length) + marker : output;
  }
}
