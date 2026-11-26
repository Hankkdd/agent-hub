import { ClaudeLogin } from "./claude-login/login";
import { AntigravityLogin } from "./antigravity/login";
import { GoogleAccount } from "./google/auth";
import { HostStatus } from "./deploy/host-status";
import { Deployer } from "./deploy/deployer";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createApp } from "./app";
import { loadToken, startupMessages, tokenFile } from "./auth";
import { loadRemoteToken, remoteTokenFile } from "./remote";
import { ClaudeAdapter, type ClaudeAdapterOptions } from "./agents/claude";
import { availableGemini } from "./agents/gemini";
import { CodexAdapter } from "./agents/codex";
import { removeOrphans } from "./agents/codex-docker";
import { removeOrphans as removeClaudeOrphans } from "./agents/claude-docker";
import { Hosts } from "./tools/hosts";
import { E3Tools } from "./tools/e3";
import { ToolServer } from "./tools/mcp";
import { ensureAgentKey } from "./tools/agent-key";
import { execFileSync } from "node:child_process";
import { Hub } from "./core/hub";
import { Documents } from "./core/documents";
import { GitHubForge } from "./workspace/forge";
import { openDb } from "./db/index";
import { notifyDiscord } from "./notify/discord";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const env = (k: string, d: string) => process.env[k]?.trim() || d;
const config = {
  // Dev: the API stays on loopback and only the Vite server (which proxies /api) is exposed, so
  // AGENT_HUB_HOST is Vite's. In `start` this process serves the web app itself and takes it.
  host: env("AGENT_HUB_SERVE_WEB", "0") === "1" ? env("AGENT_HUB_HOST", "127.0.0.1") : "127.0.0.1",
  port: Number(env("AGENT_HUB_PORT", "8787")),
  dataDir: path.resolve(ROOT, env("AGENT_HUB_DATA", "data")),
  maxConcurrent: Number(env("AGENT_HUB_MAX_CONCURRENT", "4")),
  referenceDirs: (process.env.AGENT_HUB_REFERENCE_DIRS ?? "").split(path.delimiter).map((dir) => dir.trim()).filter(Boolean),
  claudeModel: process.env.AGENT_HUB_CLAUDE_MODEL?.trim() || undefined,
  // `auto`: a classifier allows or denies each tool call, and asks you in the web UI only when it
  // cannot decide. `bypassPermissions` runs everything unasked; `default` asks about most things.
  claudePermission: env("AGENT_HUB_CLAUDE_PERMISSION", "auto") as ClaudeAdapterOptions["permissionMode"],
  claudeSettings: env("AGENT_HUB_CLAUDE_SETTINGS", "user,project,local").split(",").filter(Boolean) as ClaudeAdapterOptions["settingSources"],
  codexModel: process.env.AGENT_HUB_CODEX_MODEL?.trim() || undefined,
  // docker: each Codex turn runs in a container seeing only the task's directory. host: Codex's own
  // sandbox, which stock Ubuntu 24.04 blocks (docs/design.md §7.2).
  codexRuntime: env("AGENT_HUB_CODEX_RUNTIME", "docker") as "docker" | "host",
  // Host until the container login exists (pnpm claude:login); docker is the safer boundary.
  claudeRuntime: env("AGENT_HUB_CLAUDE_RUNTIME", "host") as "docker" | "host",
  /** Agent Hub's tool server (ssh_exec). Bound to the docker bridge so Codex's containers can reach it. */
  toolsPort: Number(env("AGENT_HUB_TOOLS_PORT", "8788")),
  /** Serve the built web app from this server (production). In dev, Vite serves it and proxies /api. */
  serveWeb: env("AGENT_HUB_SERVE_WEB", "0") === "1",
  /** The user's e3sync binary; unset, agents get no E3 tools. */
  e3syncBin: process.env.AGENT_HUB_E3SYNC_BIN?.trim() || undefined,
  discordWebhook: process.env.AGENT_HUB_DISCORD_WEBHOOK?.trim() || undefined,
  discordMention: process.env.AGENT_HUB_DISCORD_MENTION?.trim() || undefined,
  publicUrl: process.env.AGENT_HUB_PUBLIC_URL?.trim() || undefined,
};

fs.mkdirSync(config.dataDir, { recursive: true });
const db = openDb(path.join(config.dataDir, "agent-hub.db"));
const agentKey = ensureAgentKey(config.dataDir);
const hosts = new Hosts(db, config.dataDir, agentKey.keyPath);
const tools = new ToolServer(hosts, config.e3syncBin ? new E3Tools(config.e3syncBin) : undefined);
// An agent in a container reaches the host at the bridge's gateway; one on the host can use it too.
// Without docker there is no container to serve, so loopback is enough.
const toolsHost = config.codexRuntime === "docker" || config.claudeRuntime === "docker" ? dockerGateway() : "127.0.0.1";
const toolsUrl = await tools.listen(toolsHost, config.toolsPort);
const deployer = new Deployer({
  enabled: process.env.AGENT_HUB_DEPLOY_ENABLED === "1", checkout: ROOT, dataDir: config.dataDir,
});
const antigravity = new AntigravityLogin({ dataDir: config.dataDir });
await antigravity.cleanup();
const google = new GoogleAccount({ dataDir: config.dataDir });
// Gemini is registered only for isolated chat; all coding and auxiliary choices exclude it.
const gemini = await availableGemini({ dataDir: config.dataDir });
const hub = new Hub({
  video: { google },
  hostStatus: new HostStatus({ deployer, dataDir: config.dataDir }),
  tools,
  forge: new GitHubForge(),
  db,
  dataDir: config.dataDir,
  maxConcurrent: config.maxConcurrent,
  referenceDirs: config.referenceDirs,
  agents: {
    ...(gemini ? { gemini } : {}),
    claude: new ClaudeAdapter({ model: config.claudeModel, permissionMode: config.claudePermission, settingSources: config.claudeSettings,
      runtime: config.claudeRuntime, claudeHome: path.join(config.dataDir, "claude-home"), cacheDir: path.join(config.dataDir, "cache") }),
    codex: new CodexAdapter({ model: config.codexModel, runtime: config.codexRuntime, codexHome: path.join(config.dataDir, "codex-home"), cacheDir: path.join(config.dataDir, "cache") }),
  },
});

const stopDiscord = notifyDiscord(hub, { webhook: config.discordWebhook, mention: config.discordMention, publicUrl: config.publicUrl });

if (config.codexRuntime === "docker") {
  fs.mkdirSync(path.join(config.dataDir, "codex-home"), { recursive: true });
  const orphans = await removeOrphans();
  if (orphans > 0) console.log(`removed ${orphans} Codex container(s) left by the last shutdown`);
}
if (config.claudeRuntime === "docker") {
  fs.mkdirSync(path.join(config.dataDir, "claude-home"), { recursive: true, mode: 0o700 });
  const orphans = await removeClaudeOrphans();
  if (orphans > 0) console.log(`removed ${orphans} Claude container(s) left by the last shutdown`);
}

const interrupted = hub.recoverInterrupted();
if (interrupted > 0) console.log(`marked ${interrupted} task(s) interrupted by the last shutdown`);

// GitHub has no push to us, so open pull requests are looked at: merged there means done here.
const PR_POLL_MS = Number(env("AGENT_HUB_PR_POLL_MS", "60000"));
void hub.pollPullRequests();
setInterval(() => void hub.pollPullRequests().catch((err) => console.warn("PR poll failed:", err)), PR_POLL_MS).unref();

const token = loadToken(config.dataDir);
const remoteToken = loadRemoteToken(config.dataDir, env("AGENT_HUB_REMOTE_API", "") === "1");
if (remoteToken) console.log(`remote API token enabled; it is in ${remoteTokenFile(config.dataDir)}`);
const claudeLogin = new ClaudeLogin({ dataDir: config.dataDir, claudeRuntime: config.claudeRuntime, onSuccess: async () => { await hub.refreshClaudeQuota(); } });
await claudeLogin.cleanup();
const app = createApp(hub, token, hosts, agentKey, deployer, { google, antigravity, claudeLogin, documents: new Documents(db), remoteToken });
if (config.serveWeb) {
  const dist = path.relative(process.cwd(), path.join(ROOT, "apps/web/dist"));
  app.use("/*", serveStatic({ root: dist }));
  app.get("/*", serveStatic({ path: path.join(dist, "index.html") }));
}

serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
  for (const line of startupMessages({ address: info.address, port: info.port, serveWeb: config.serveWeb, claudePermission: config.claudePermission,
    codexRuntime: config.codexRuntime, toolsUrl, tokenFile: tokenFile(config.dataDir) })) console.log(line);
});

// Stopping mid-turn is fine: the next boot marks those tasks interrupted instead of re-running them.
// Abort first, so no Claude Code subprocess is left running on its own. (A kill -9 cannot do this;
// that is the case the "may or may not have completed" list exists for.)
let stopping = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    if (stopping) process.exit(1); // second signal: give up waiting
    stopping = true;
    console.log(`${sig}: stopping running turns…`);
    void Promise.allSettled([hub.shutdown(), antigravity.shutdown(), claudeLogin.shutdown()]).finally(() => {
      stopDiscord?.();
      tools.close();
      process.exit(0);
    });
  });
}

/** The docker bridge's gateway address, which containers on it can reach. Falls back to the usual one. */
function dockerGateway(): string {
  try {
    return execFileSync("docker", ["network", "inspect", "bridge", "--format", "{{(index .IPAM.Config 0).Gateway}}"], { encoding: "utf8" }).trim() || "172.17.0.1";
  } catch {
    return "172.17.0.1";
  }
}
