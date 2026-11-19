import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";

export const COOKIE = "agent_hub_token";

/**
 * The one secret: a random token in `<dataDir>/token`, created on first boot. The server can run
 * agents that execute shell commands, so anything that can reach the port must prove it has read
 * that file. The browser trades it for an HttpOnly cookie once (POST /api/auth).
 */
export const tokenFile = (dataDir: string) => path.join(dataDir, "token");

export function loadToken(dataDir: string): string {
  const file = tokenFile(dataDir);
  if (fs.existsSync(file)) return fs.readFileSync(file, "utf8").trim();
  const token = randomBytes(24).toString("base64url");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file, `${token}\n`, { mode: 0o600 });
  return token;
}

/**
 * What the server logs when it starts listening. It names the token file, never the token: stdout ends
 * up in the systemd journal, where anyone reading logs could otherwise sign in.
 */
export function startupMessages(o: { address: string; port: number; serveWeb: boolean; claudePermission: string;
  codexRuntime: string; toolsUrl: string; tokenFile: string }): string[] {
  const lines = [`agent-hub server on http://${o.address}:${o.port}  (claude permission: ${o.claudePermission}, codex runtime: ${o.codexRuntime}, tools: ${o.toolsUrl})`];
  const signIn = `sign in once with ?token=<token>; the token is in ${o.tokenFile}`;
  lines.push(o.serveWeb ? `open: http://${o.address}:${o.port}/  (${signIn})` : `web app: ${signIn}`);
  return lines;
}

export function tokenMatches(expected: string, given: string | undefined | null): boolean {
  if (!given) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Accepts the cookie or an `Authorization: Bearer` header (for curl and scripts). The optional remote
 * token is bearer-only and is narrowed to its routes by `remoteScope` (remote.ts).
 */
export function requireToken(token: string, remoteToken: string | null = null): MiddlewareHandler {
  return async (c, next) => {
    const bearer = c.req.header("authorization")?.replace(/^Bearer\s+/i, "");
    if (tokenMatches(token, getCookie(c, COOKIE)) || tokenMatches(token, bearer)) return next();
    if (remoteToken && tokenMatches(remoteToken, bearer)) return next();
    return c.json({ error: "unauthorized" }, 401);
  };
}
