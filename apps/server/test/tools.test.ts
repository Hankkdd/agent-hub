import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { FakeAdapter } from "../src/agents/fake";
import { Hub } from "../src/core/hub";
import { openDb, type Db } from "../src/db/index";
import { E3Tools } from "../src/tools/e3";
import { Hosts } from "../src/tools/hosts";
import { ToolServer } from "../src/tools/mcp";
import { formatResult, remoteCommand } from "../src/tools/ssh";
import { parseLocator, sshConfig } from "../src/tools/copy";
import type { Host } from "@agent-hub/shared";

let dir: string;
let db: Db;
let hosts: Hosts;
let tools: ToolServer;
let key: string;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-hub-tools-"));
  db = openDb(":memory:");
  hosts = new Hosts(db, dir);
  tools = new ToolServer(hosts);
  await tools.listen("127.0.0.1", 0);
  key = path.join(dir, "id_test");
  fs.writeFileSync(key, "not a real key\n");
});
afterEach(() => {
  tools.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function client(access: { url: string; token: string }): Promise<Client> {
  const c = new Client({ name: "test", version: "1" });
  await c.connect(new StreamableHTTPClientTransport(new URL(access.url), { requestInit: { headers: { Authorization: `Bearer ${access.token}` } } }));
  return c;
}
const text = (r: Awaited<ReturnType<Client["callTool"]>>) => (r.content as { type: string; text: string }[]).map((c) => c.text).join("\n");

describe("host registry", () => {
  it("validates what it stores", () => {
    expect(() => hosts.upsert("Bad Name", { address: "x", user: "u", keyPath: key })).toThrow(/name/);
    expect(() => hosts.upsert("nas", { user: "u", keyPath: key })).toThrow(/address/);
    expect(() => hosts.upsert("nas", { address: "10.0.0.5", user: "u", keyPath: path.join(dir, "missing") })).toThrow(/no key file/);
    const h = hosts.upsert("nas", { address: "10.0.0.5", user: "agent", keyPath: key, note: "Synology", prod: false });
    expect(h).toMatchObject({ name: "nas", port: 22 });
    // an update keeps what it does not mention
    expect(hosts.upsert("nas", { prod: true })).toMatchObject({ address: "10.0.0.5", user: "agent", note: "Synology", prod: true });
  });
});

describe("tool server", () => {
  it("refuses without a token, and a revoked token stops working", async () => {
    const res = await fetch(tools.issue("t", "s", dir)!.url, { method: "POST", body: "{}" });
    expect(res.status).toBe(401);

    const access = tools.issue("t", "s", dir)!;
    const c = await client(access);
    expect((await c.listTools()).tools.map((t) => t.name).sort()).toEqual(["copy_file", "list_hosts", "ssh_exec"]);
    tools.revoke(access.token);
    await expect(c.listTools()).rejects.toThrow();
  });

  it("lists hosts with production marked, and explains an unknown host instead of failing silently", async () => {
    hosts.upsert("nas", { address: "10.0.0.5", user: "agent", keyPath: key, note: "Synology, media" });
    hosts.upsert("web", { address: "10.0.0.9", user: "deploy", port: 2222, keyPath: key, prod: true });
    const c = await client(tools.issue("t", "s", dir)!);
    const listed = text(await c.callTool({ name: "list_hosts", arguments: {} }));
    expect(listed).toContain("- nas: agent@10.0.0.5 - Synology, media");
    expect(listed).toContain("- web [PRODUCTION]: deploy@10.0.0.9:2222");

    const r = await c.callTool({ name: "ssh_exec", arguments: { host: "nope", command: "uptime" } });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/no host named "nope". Registered: nas, web/);
  });
});

// Stands in for `e3sync mcp`: answers with what it received, so tests never touch E3.
const FAKE_E3SYNC = `#!/usr/bin/env node
const fs = require("node:fs");
const readline = require("node:readline");
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) return;
  if (method === "initialize") return send(id, { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } });
  const args = params.arguments;
  if (args.course_id === 999) {
    fs.writeFileSync(process.env.HOME + "/e3-hang.pid", String(process.pid));
    setInterval(() => {}, 1000);
    return;
  }
  if (args.course_id === 500) return send(id, { isError: true, content: [{ type: "text", text: "session expired" }] });
  send(id, { content: [{ type: "text", text: JSON.stringify({ tool: params.name, args, argv: process.argv.slice(2), env: Object.keys(process.env) }) }] });
});
`;

describe("E3 tools", () => {
  const E3_READ = ["e3_list_assignments", "e3_list_courses", "e3_list_materials"];
  let e3Tools: ToolServer;
  const savedHome = process.env.HOME;
  const names = async (c: Client) => (await c.listTools()).tools.map((t) => t.name).filter((n) => n.startsWith("e3_")).sort();

  beforeEach(async () => {
    const bin = path.join(dir, "e3sync");
    fs.writeFileSync(bin, FAKE_E3SYNC, { mode: 0o755 });
    process.env.HOME = dir;
    process.env.AGENT_HUB_TEST_SECRET = "do-not-pass";
    e3Tools = new ToolServer(hosts, new E3Tools(bin));
    await e3Tools.listen("127.0.0.1", 0);
  });
  afterEach(() => {
    e3Tools.close();
    process.env.HOME = savedHome;
    delete process.env.AGENT_HUB_TEST_SECRET;
  });

  it("offers nothing when no binary is configured", async () => {
    expect(await names(await client(tools.issue("t", "s", dir, undefined, undefined, { e3Download: true })!))).toEqual([]);
  });

  it("offers download only to a grant allowed to download", async () => {
    expect(await names(await client(e3Tools.issue("t", "s", dir)!))).toEqual(E3_READ);
    expect(await names(await client(e3Tools.issue("t", "s", dir, undefined, undefined, { e3Download: true })!))).toEqual(["e3_download_material", ...E3_READ]);
  });

  it("does not give a planning grant the download tool, even if asked to", async () => {
    const planning = {} as Parameters<ToolServer["issue"]>[3];
    expect(await names(await client(e3Tools.issue("t", "s", dir, planning, undefined, { e3Download: false })!))).toEqual(E3_READ);
  });

  it("forwards arguments to e3sync mcp and passes it none of the Hub's environment", async () => {
    const c = await client(e3Tools.issue("t", "s", dir, undefined, undefined, { e3Download: true })!);
    const r = await c.callTool({ name: "e3_download_material", arguments: { course_id: 7, path: "E3/a.pdf" } });
    expect(r.isError).toBeFalsy();
    const seen = JSON.parse(text(r)) as { tool: string; args: unknown; argv: string[]; env: string[] };
    expect(seen).toMatchObject({ tool: "download_material", args: { course_id: 7, path: "E3/a.pdf" }, argv: ["mcp"] });
    expect(seen.env).toContain("HOME");
    expect(seen.env).not.toContain("AGENT_HUB_TEST_SECRET");
  });

  it("rejects bad arguments before starting e3sync", async () => {
    const c = await client(e3Tools.issue("t", "s", dir)!);
    const r = await c.callTool({ name: "e3_list_materials", arguments: { course_id: "7; rm -rf /" } });
    expect(r.isError).toBe(true);
    expect(text(r)).not.toContain("list_materials\"");
  });

  it("reports a tool failure and a missing binary as failed calls", async () => {
    const c = await client(e3Tools.issue("t", "s", dir)!);
    const failed = await c.callTool({ name: "e3_list_materials", arguments: { course_id: 500 } });
    expect(failed.isError).toBe(true);
    expect(text(failed)).toBe("session expired");

    const missing = new ToolServer(hosts, new E3Tools(path.join(dir, "nope")));
    await missing.listen("127.0.0.1", 0);
    try {
      const m = await (await client(missing.issue("t", "s", dir)!)).callTool({ name: "e3_list_courses", arguments: {} });
      expect(m.isError).toBe(true);
      expect(text(m)).toMatch(/^e3sync: /);
    } finally {
      missing.close();
    }
  });

  it("stops e3sync when the turn ends", async () => {
    const access = e3Tools.issue("t", "s", dir)!;
    const pending = (await client(access)).callTool({ name: "e3_list_materials", arguments: { course_id: 999 } }).catch(() => null);
    const pidFile = path.join(dir, "e3-hang.pid");
    await expect.poll(() => fs.existsSync(pidFile), { timeout: 5000 }).toBe(true);
    const pid = Number(fs.readFileSync(pidFile, "utf8"));
    e3Tools.revoke(access.token);
    await pending;
    await expect.poll(() => {
      try { process.kill(pid, 0); return true; } catch { return false; }
    }, { timeout: 8000 }).toBe(false);
  }, 15000);
});

describe("hub and tools", () => {
  it("allows E3 downloads in chat", async () => {
    const issue = vi.spyOn(tools, "issue");
    const hub = new Hub({ db, dataDir: dir, maxConcurrent: 2, flushMs: 1, agents: { claude: new FakeAdapter() }, tools });
    const task = await hub.createTask({ title: "", workflow: "chat", agent: "claude", message: "hi" });
    await hub.settled(task.id);
    expect(issue.mock.calls[0]![5]).toEqual({ e3Download: true, devices: true });
  });

  it("gives each turn its own token and revokes it when the turn ends", async () => {
    const agent = new FakeAdapter();
    const hub = new Hub({ db, dataDir: dir, maxConcurrent: 2, flushMs: 1, agents: { claude: agent }, tools });
    const task = await hub.createTask({ title: "", workflow: "chat", agent: "claude", message: "hi" });
    await hub.settled(task.id);
    const access = agent.runs[0]!.mcp!;
    expect(access.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    const res = await fetch(access.url, { method: "POST", headers: { Authorization: `Bearer ${access.token}` }, body: "{}" });
    expect(res.status).toBe(401); // the turn is over
  });
});

describe("formatResult", () => {
  it("says how the command ended, including ssh's own failures and timeouts", () => {
    expect(formatResult({ exitCode: 0, stdout: "ok\n", stderr: "", durationMs: 1200, timedOut: false }, 120)).toBe("ok\n[exit 0, 1.2s]");
    expect(formatResult({ exitCode: 255, stdout: "", stderr: "Permission denied", durationMs: 300, timedOut: false }, 120)).toMatch(/Permission denied\n\[exit 255: ssh itself failed/);
    expect(formatResult({ exitCode: null, stdout: "partial", stderr: "", durationMs: 5000, timedOut: true }, 5)).toMatch(/timed out after 5s/);
  });
});

describe("remoteCommand", () => {
  it("switches Windows PowerShell to UTF-8 output and leaves sh alone", () => {
    const base = { name: "x", address: "a", user: "u", port: 22, keyPath: "/k", note: "", prod: false };
    expect(remoteCommand({ ...base, shell: "posix" }, "ls")).toBe("ls");
    // Quotes in the command are doubled inside the single-quoted Invoke-Expression argument.
    expect(remoteCommand({ ...base, shell: "powershell" }, "Get-Content 'a b.txt'")).toBe(
      `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $ProgressPreference='SilentlyContinue'; Invoke-Expression 'Get-Content ''a b.txt'''`,
    );
  });

  it("is stored with the device, posix unless said otherwise", () => {
    expect(hosts.upsert("pc", { address: "1.2.3.4", user: "u", keyPath: key, shell: "powershell" }).shell).toBe("powershell");
    expect(hosts.upsert("nas", { address: "1.2.3.5", user: "u", keyPath: key }).shell).toBe("posix");
    expect(() => hosts.upsert("bad", { address: "1.2.3.6", user: "u", keyPath: key, shell: "fish" as never })).toThrow(/shell/);
  });
});

describe("copy_file locators", () => {
  const H = (o: Partial<Host>): Host => ({ name: "nas", address: "10.0.0.5", user: "agent", port: 22, keyPath: "/k", note: "", prod: false, shell: "posix", ...o });
  const hostsList = [H({}), H({ name: "win", address: "100.1.2.3", user: "hank" })];
  const cwd = "/data/videos/t1";

  it("reads device paths, including Windows drives, and relative paths inside the task directory", () => {
    expect(parseLocator("nas:/srv/media/a.mkv", hostsList, cwd)).toMatchObject({ kind: "host", host: { name: "nas" }, path: "/srv/media/a.mkv" });
    expect(parseLocator("win:C:/Users/hank/Desktop/data.csv", hostsList, cwd)).toMatchObject({ kind: "host", host: { name: "win" }, path: "C:/Users/hank/Desktop/data.csv" });
    expect(parseLocator("out/report.md", hostsList, cwd)).toEqual({ kind: "local", path: "/data/videos/t1/out/report.md" });
    expect(parseLocator(".", hostsList, cwd)).toEqual({ kind: "local", path: cwd });
  });

  it("refuses anything that would reach the rest of this machine, and names the devices it knows", () => {
    expect(() => parseLocator("/etc/passwd", hostsList, cwd)).toThrow(/relative to the task's directory/);
    expect(() => parseLocator("../../token", hostsList, cwd)).toThrow(/leaves the task's directory/);
    expect(() => parseLocator("C:/Windows/x", hostsList, cwd)).toThrow(/not a device path/);
    expect(() => parseLocator("laptop:/tmp/x", hostsList, cwd)).toThrow(/no device named "laptop". Registered: nas, win/);
  });

  it("gives each device its own key, user and port in the scp config", () => {
    const cfg = sshConfig([H({ port: 2222, keyPath: "/keys/a" })], "/kh");
    expect(cfg).toContain("Host ah-nas\n  HostName 10.0.0.5\n  User agent\n  Port 2222\n  IdentityFile /keys/a");
    expect(cfg).toContain("BatchMode yes");
    expect(cfg).toContain("UserKnownHostsFile /kh");
  });
});
