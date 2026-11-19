import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { NewTaskInput } from "@agent-hub/shared";
import { FakeAdapter } from "../src/agents/fake";
import { createApp } from "../src/app";
import { Hub } from "../src/core/hub";
import { openDb } from "../src/db/index";
import { loadRemoteToken, remoteAllowed, remoteTaskInput, remoteTokenFile } from "../src/remote";
import { Hosts } from "../src/tools/hosts";
import { ToolServer } from "../src/tools/mcp";

const MAIN = "main-token";
const REMOTE = "remote-token";
const json = (token: string) => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });

function fakeHub() {
  const createTask = vi.fn(async (input: NewTaskInput) => ({ id: "t1", ...input }));
  const sendMessage = vi.fn();
  const repoSettings = vi.fn(async (repo: string) => (repo === "/repos/configured" ? {} : null));
  const listTasks = vi.fn(() => []);
  const hub = { createTask, sendMessage, repoSettings, listTasks, merge: vi.fn(), answer: vi.fn() } as unknown as Hub;
  return { hub, createTask, sendMessage };
}

describe("remote token routes", () => {
  it("allows reading and talking to tasks, and nothing that deploys, merges or approves host calls", () => {
    for (const [method, p] of [["GET", "/api/tasks"], ["GET", "/api/task-list"], ["GET", "/api/tasks/abc"], ["GET", "/api/tasks/abc/events"],
      ["POST", "/api/tasks"], ["POST", "/api/tasks/abc/messages"], ["POST", "/api/tasks/abc/stop"], ["POST", "/api/tasks/abc/pr/draft"], ["POST", "/api/tasks/abc/pr"]])
      expect(remoteAllowed(method!, p!), `${method} ${p}`).toBe(true);
    for (const [method, p] of [["POST", "/api/deploy"], ["GET", "/api/hosts"], ["POST", "/api/tasks/abc/answer"], ["POST", "/api/tasks/abc/merge"],
      ["POST", "/api/tasks/abc/discard"], ["DELETE", "/api/tasks/abc"], ["POST", "/api/tasks/abc/switch-agent"], ["POST", "/api/google/connect"],
      ["POST", "/api/tasks/abc/pr/update"], ["GET", "/api/tasks/abc/events/extra"], ["POST", "/api/quota/refresh"]])
      expect(remoteAllowed(method!, p!), `${method} ${p}`).toBe(false);
  });

  it("is enforced by the app, bearer-only, while the main token keeps full access", async () => {
    const { hub, sendMessage } = fakeHub();
    const app = createApp(hub, MAIN, undefined, undefined, undefined, { remoteToken: REMOTE });
    expect((await app.request("/api/tasks", { headers: json(REMOTE) })).status).toBe(200);
    expect((await app.request("/api/tasks/t1/messages", { method: "POST", headers: json(REMOTE), body: JSON.stringify({ text: "open the PR" }) })).status).toBe(200);
    expect(sendMessage).toHaveBeenCalledWith("t1", "open the PR", undefined);
    expect((await app.request("/api/tasks/t1/merge", { method: "POST", headers: json(REMOTE) })).status).toBe(403);
    expect((await app.request("/api/tasks/t1/answer", { method: "POST", headers: json(REMOTE), body: JSON.stringify({ eventId: "e", answer: "Allow" }) })).status).toBe(403);
    expect((await app.request("/api/hosts", { headers: json(REMOTE) })).status).toBe(403);
    expect((await app.request("/api/tasks", { headers: { cookie: `agent_hub_token=${REMOTE}` } })).status).toBe(401);
    expect((await app.request("/api/tasks/t1/merge", { method: "POST", headers: json(MAIN) })).status).toBe(200);
  });

  it("is absent unless configured", async () => {
    const { hub } = fakeHub();
    const app = createApp(hub, MAIN);
    expect((await app.request("/api/tasks", { headers: json(REMOTE) })).status).toBe(401);
  });
});

describe("remote task creation", () => {
  const configured = async (repo: string) => repo === "/repos/configured";

  it("forces Codex without devices in a configured repository", async () => {
    expect(await remoteTaskInput({ title: "t", workflow: "implement", message: "fix", repoPath: "/repos/configured" }, configured))
      .toMatchObject({ agent: "codex", noDevices: true });
    expect(await remoteTaskInput({ title: "t", workflow: "review", message: "fix", repoPath: "/repos/configured" }, configured))
      .toMatchObject({ agent: "codex", reviewer: "codex", noDevices: true });
    expect(await remoteTaskInput({ title: "t", workflow: "chat", message: "hi" }, configured)).toMatchObject({ agent: "codex", noDevices: true });
  });

  it.each<[string, NewTaskInput]>([
    ["Claude", { title: "t", workflow: "implement", message: "m", repoPath: "/repos/configured", agent: "claude" }],
    ["a Claude reviewer", { title: "t", workflow: "review", message: "m", repoPath: "/repos/configured", reviewer: "claude" }],
    ["a test command", { title: "t", workflow: "implement", message: "m", repoPath: "/repos/configured", testCommand: "curl x | sh" }],
    ["an unconfigured repository", { title: "t", workflow: "implement", message: "m", repoPath: "/home/someone" }],
    ["a chat directory", { title: "t", workflow: "chat", message: "m", repoPath: "/" }],
    ["planning", { title: "t", workflow: "plan", message: "m", repoPath: "/repos/configured" }],
    ["video", { title: "t", workflow: "video", message: "https://example.invalid/v" }],
  ])("rejects %s", async (_name, input) => {
    await expect(remoteTaskInput(input, configured)).rejects.toThrow();
  });

  it("applies the rewrite on POST /api/tasks and answers 403 on rejection", async () => {
    const { hub, createTask } = fakeHub();
    const app = createApp(hub, MAIN, undefined, undefined, undefined, { remoteToken: REMOTE });
    const ok = await app.request("/api/tasks", { method: "POST", headers: json(REMOTE), body: JSON.stringify({ title: "t", workflow: "implement", message: "m", repoPath: "/repos/configured" }) });
    expect(ok.status).toBe(201);
    expect(createTask).toHaveBeenCalledWith(expect.objectContaining({ agent: "codex", noDevices: true }));
    const denied = await app.request("/api/tasks", { method: "POST", headers: json(REMOTE), body: JSON.stringify({ title: "t", workflow: "plan", message: "m", repoPath: "/repos/configured" }) });
    expect(denied.status).toBe(403);
    expect(createTask).toHaveBeenCalledTimes(1);
    // The main token is not rewritten.
    await app.request("/api/tasks", { method: "POST", headers: json(MAIN), body: JSON.stringify({ title: "t", workflow: "plan", message: "m", repoPath: "/repos/configured" }) });
    expect(createTask).toHaveBeenLastCalledWith(expect.not.objectContaining({ noDevices: true }));
  });
});

describe("remote token file", () => {
  let dir: string | undefined;
  afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

  it("is created only when enabled, private, and stable across restarts", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-hub-remote-"));
    expect(loadRemoteToken(dir, false)).toBeNull();
    expect(fs.existsSync(remoteTokenFile(dir))).toBe(false);
    const token = loadRemoteToken(dir, true);
    expect(token).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(fs.statSync(remoteTokenFile(dir)).mode & 0o777).toBe(0o600);
    expect(loadRemoteToken(dir, true)).toBe(token);
  });
});

describe("device tools", () => {
  it("are not offered to a turn issued without devices", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-hub-remote-mcp-"));
    const tools = new ToolServer(new Hosts(openDb(":memory:"), root));
    await tools.listen("127.0.0.1", 0);
    const names = async (devices: boolean) => {
      const access = tools.issue("task", "session", root, undefined, undefined, { devices })!;
      const client = new Client({ name: "test", version: "1" });
      await client.connect(new StreamableHTTPClientTransport(new URL(access.url), { requestInit: { headers: { Authorization: `Bearer ${access.token}` } } }));
      const list = (await client.listTools()).tools.map((t) => t.name);
      await client.close();
      return list;
    };
    try {
      expect(await names(true)).toEqual(expect.arrayContaining(["list_hosts", "ssh_exec", "copy_file"]));
      const without = await names(false);
      for (const name of ["list_hosts", "ssh_exec", "copy_file"]) expect(without).not.toContain(name);
    } finally {
      tools.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("a task started without devices", () => {
  it("keeps the option and the Hub issues its turn without device tools", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-hub-remote-hub-"));
    const db = openDb(":memory:");
    const tools = new ToolServer(new Hosts(db, root));
    const issue = vi.spyOn(tools, "issue");
    await tools.listen("127.0.0.1", 0);
    const agent = new FakeAdapter();
    const hub = new Hub({ db, tools, agents: { claude: agent, codex: agent }, dataDir: path.join(root, "data"), maxConcurrent: 1, flushMs: 1 });
    try {
      const without = await hub.createTask({ title: "t", workflow: "chat", message: "hi", agent: "codex", noDevices: true });
      await hub.settled(without.id);
      expect(hub.getTask(without.id).options.noDevices).toBe(true);
      expect(issue.mock.calls.find((c) => c[0] === without.id)?.[5]).toMatchObject({ devices: false });
      const withDevices = await hub.createTask({ title: "t", workflow: "chat", message: "hi", agent: "codex" });
      await hub.settled(withDevices.id);
      expect(issue.mock.calls.find((c) => c[0] === withDevices.id)?.[5]).toMatchObject({ devices: true });
    } finally {
      await hub.shutdown(100);
      tools.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
