/**
 * One continuous-deployment pass for the production host, run by agent-hub-auto-deploy.timer
 * (docs/runbook/deploy.md). Deploys origin/main once its CI passed and the Hub is idle, and mirrors
 * deploy outcomes to GitHub deployments. Needs AGENT_HUB_DATA (the server's data directory) and a
 * non-interactive `gh` login on the host.
 */
import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { autoDeployOnce, githubRepo, type AutoDeployState } from "../src/deploy/auto-deploy";

const exec = promisify(execFile);

// Same address rule as scripts/deploy.sh: a wildcard bind is reachable on loopback.
function hubOrigin(): string {
  let host = process.env.AGENT_HUB_HOST || "127.0.0.1";
  if (host === "0.0.0.0" || host === "::" || host === "[::]") host = "127.0.0.1";
  if (host.includes(":") && !host.startsWith("[")) host = `[${host}]`;
  return `http://${host}:${process.env.AGENT_HUB_PORT || "8787"}`;
}

function gh(args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("gh", args, { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, GH_PROMPT_DISABLED: "1" } });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr.trim() || `gh exited with ${code}`)));
    child.stdin.end(input ?? "");
  });
}

async function main(): Promise<void> {
  const data = process.env.AGENT_HUB_DATA;
  if (!data || !path.isAbsolute(data)) throw new Error("Set AGENT_HUB_DATA to the server's absolute data directory");
  const token = (await fs.readFile(path.join(data, "token"), "utf8")).trim();
  const statePath = path.join(data, "auto-deploy.json");
  const repo = githubRepo((await exec("git", ["remote", "get-url", "origin"], { encoding: "utf8" })).stdout);
  const origin = hubOrigin();

  const result = await autoDeployOnce({
    async hub(method, body) {
      const response = await fetch(`${origin}/api/deploy`, {
        method, signal: AbortSignal.timeout(60_000),
        headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      return { status: response.status, body: await response.json().catch(() => null) };
    },
    async github(method, route, body) {
      const args = ["api", "-X", method, `repos/${repo}/${route}`, "-H", "Accept: application/vnd.github+json"];
      const output = await gh(body ? [...args, "--input", "-"] : args, body ? JSON.stringify(body) : undefined);
      return JSON.parse(output);
    },
    async readState() {
      try { return JSON.parse(await fs.readFile(statePath, "utf8")) as AutoDeployState; }
      catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return {}; throw err; }
    },
    async writeState(state) {
      await fs.writeFile(`${statePath}.tmp`, JSON.stringify(state) + "\n", { mode: 0o600 });
      await fs.rename(`${statePath}.tmp`, statePath);
    },
    log: (line) => console.log(line),
    requiredChecks: (process.env.AGENT_HUB_AUTO_DEPLOY_CHECKS ?? "check").split(",").map((name) => name.trim()).filter(Boolean),
  });
  console.log(`auto-deploy: ${result}`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
