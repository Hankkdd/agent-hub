import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { MiddlewareHandler } from "hono";
import type { NewTaskInput } from "@agent-hub/shared";
import { tokenMatches } from "./auth";

/**
 * A second, narrower token for a chat bot that relays the operator's replies (for example from Discord)
 * while they are away from the web app. The main token can deploy, run commands on registered devices
 * and approve Claude's host tool calls; a bot holding it would be one prompt injection away from all of
 * that. This one can read tasks, talk to them, stop them, open PRs, and start Codex tasks without devices.
 *
 * Opt-in: the file is created only when AGENT_HUB_REMOTE_API=1, so a Hub that never asked for it has no
 * second credential to leak.
 */
export const remoteTokenFile = (dataDir: string) => path.join(dataDir, "remote-token");

export function loadRemoteToken(dataDir: string, enabled: boolean): string | null {
  if (!enabled) return null;
  const file = remoteTokenFile(dataDir);
  if (fs.existsSync(file)) return fs.readFileSync(file, "utf8").trim() || null;
  const token = randomBytes(24).toString("base64url");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file, `${token}\n`, { mode: 0o600 });
  return token;
}

/** Bearer-only: the web app's cookie is always the main token. */
export function isRemoteRequest(remoteToken: string | null, authorization: string | undefined): boolean {
  if (!remoteToken) return false;
  return tokenMatches(remoteToken, authorization?.replace(/^Bearer\s+/i, ""));
}

const ID = "[^/]+";
/**
 * Everything the remote token may call, by method and exact path shape. Anything else is 403, so a
 * route added later is closed to the bot until someone decides otherwise here.
 *
 * Deliberately absent: /answer (approves Claude's tool calls on the host), merge, discard, delete,
 * recover, switch-agent, deploy, hosts, Google, Antigravity, documents, quota refresh.
 */
const ALLOWED: { method: string; path: RegExp }[] = [
  { method: "GET", path: /^\/api\/task-list$/ },
  { method: "GET", path: /^\/api\/tasks$/ },
  { method: "GET", path: new RegExp(`^/api/tasks/${ID}$`) },
  { method: "GET", path: new RegExp(`^/api/tasks/${ID}/(?:events|briefing|usage)$`) },
  { method: "GET", path: /^\/api\/quota$/ },
  { method: "GET", path: /^\/api\/models$/ },
  { method: "POST", path: /^\/api\/tasks$/ },
  { method: "POST", path: new RegExp(`^/api/tasks/${ID}/(?:messages|stop|pr|pr/draft)$`) },
];

export function remoteAllowed(method: string, p: string): boolean {
  return ALLOWED.some((r) => r.method === method && r.path.test(p));
}

export const REMOTE_WORKFLOWS = ["chat", "implement", "review"] as const;

/**
 * Rewrites a task the bot asks for into one the remote scope permits, or explains why not.
 *
 * - Codex only: Claude runs on the host under a permission classifier whose undecided calls are approved
 *   in the web app, which the bot cannot reach; Codex runs in its container.
 * - No devices: an agent turn would otherwise get ssh_exec and copy_file.
 * - No custom test command: test commands run on the host. The repository's configured one still applies.
 * - Chat gets a scratch directory; implement/review only in repositories configured in repos.json.
 * - No planning: a plan starts further tasks through its own tools, outside these rules.
 */
export async function remoteTaskInput(input: NewTaskInput, configured: (repo: string) => Promise<boolean>): Promise<NewTaskInput> {
  if (!input || typeof input !== "object") throw new RemoteRejection("expected a task");
  if (!(REMOTE_WORKFLOWS as readonly string[]).includes(input.workflow))
    throw new RemoteRejection(`the remote token can start ${REMOTE_WORKFLOWS.join(", ")} tasks`);
  if (input.agent !== undefined && input.agent !== "codex") throw new RemoteRejection("the remote token starts Codex tasks only");
  if (input.reviewer !== undefined && input.reviewer !== "codex") throw new RemoteRejection("the remote token uses Codex as reviewer");
  if (input.testCommand !== undefined) throw new RemoteRejection("the remote token cannot set a test command");
  if (input.fromProposal !== undefined) throw new RemoteRejection("the remote token cannot start planning proposals");
  if (input.workflow === "chat") {
    if (input.repoPath) throw new RemoteRejection("remote chat tasks run in a scratch directory");
  } else if (!input.repoPath || !(await configured(input.repoPath))) {
    throw new RemoteRejection("the remote token works only in repositories configured in repos.json");
  }
  const out: NewTaskInput = { ...input, agent: "codex", noDevices: true };
  if (input.workflow === "review") out.reviewer = "codex";
  return out;
}

export class RemoteRejection extends Error {}

/** Placed after the main-token check; the remote token is accepted only for the allowed routes. */
export function remoteScope(remoteToken: string | null): MiddlewareHandler {
  return async (c, next) => {
    if (isRemoteRequest(remoteToken, c.req.header("authorization")) && !remoteAllowed(c.req.method, c.req.path))
      return c.json({ error: "not allowed for the remote token" }, 403);
    await next();
  };
}
