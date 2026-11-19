import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NewTaskInput } from "@agent-hub/shared";
import { FakeAdapter, type FakeStep } from "../src/agents/fake";
import type { AgentRunInput } from "../src/agents/types";
import { Hub } from "../src/core/hub";
import { readRepoSettings } from "../src/core/repo-settings";
import { openDb } from "../src/db/index";
import type { ensureToolchainImage } from "../src/docker/toolchain";

let root: string;
let repo: string;
let dataDir: string;
let hubs: Hub[];
const activity = "Building the toolchain image (first time only)…";
const reply = (text: string): FakeStep[] => [{ type: "text_delta", text }, { type: "done", ok: true }];
const script = (input: AgentRunInput): FakeStep[] => input.toolsDisabled
  ? reply(JSON.stringify({ hunks: [...input.prompt.matchAll(/^Hunk id: (.+)$/gm)].map((m) => ({ id: JSON.parse(m[1]!), explanation: "Updated the file." })) }))
  : input.readOnly ? reply("VERDICT: approve\nFINDINGS: none")
    : [{ type: "write", path: "feature.txt", content: "feature\n" }, ...reply("Implemented.")];

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-hub-toolchain-"));
  repo = path.join(root, "repo"); dataDir = path.join(root, "data");
  fs.mkdirSync(repo); fs.mkdirSync(dataDir);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Test"); git("config", "user.email", "test@example.invalid");
  fs.writeFileSync(path.join(repo, "README.md"), "base\n");
  git("add", "."); git("commit", "-qm", "fixture");
  vi.stubEnv("AGENT_HUB_EXPLAIN_AGENT", "codex");
  hubs = [];
});
afterEach(async () => {
  await Promise.all(hubs.map((hub) => hub.shutdown(100)));
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

function configure(toolchain: unknown) {
  fs.writeFileSync(path.join(dataDir, "repos.json"), JSON.stringify({ [repo]: { toolchain } }));
}
function makeHub(builder = vi.fn<typeof ensureToolchainImage>(async (tools) => ({ tag: `toolchain:go-${tools.go}`, built: false })), codex = new FakeAdapter(script)) {
  const claude = new FakeAdapter(script);
  const hub = new Hub({ db: openDb(":memory:"), dataDir, agents: { claude, codex }, maxConcurrent: 4, flushMs: 1, ensureToolchainImage: builder });
  hubs.push(hub);
  return { hub, codex, claude, builder };
}
const input = (extra: Partial<NewTaskInput> = {}): NewTaskInput => ({ title: "Toolchain", workflow: "plan", agent: "codex", repoPath: repo, message: "Build it", ...extra });

describe("task toolchains", () => {
  it("selects the saved toolchain for author, reviewer, explainer and resumed turns, and new settings for new plans", async () => {
    configure({ go: "1.26.5" });
    const { hub, codex } = makeHub();
    const task = await hub.createTask(input({ workflow: "review", reviewer: "codex" }));
    await hub.settled(task.id);
    expect(hub.getTask(task.id).status).toBe("idle");
    expect(codex.runs).toHaveLength(3);
    expect(codex.runs.map((run) => [run.readOnly, run.toolsDisabled])).toEqual([[undefined, undefined], [true, undefined], [true, true]]);
    expect(codex.runs.every((run) => run.image === "toolchain:go-1.26.5")).toBe(true);
    configure({ go: "1.26.4" });
    hub.sendMessage(task.id, "Continue"); await hub.settled(task.id);
    expect(codex.runs.at(-1)!.image).toBe("toolchain:go-1.26.5");
    const plan = await hub.createTask(input()); await hub.settled(plan.id);
    expect(codex.runs.at(-1)!).toMatchObject({ image: "toolchain:go-1.26.4", readOnly: true });
  });

  it("leaves unconfigured Codex tasks on the plain image", async () => {
    const { hub, codex, builder } = makeHub();
    const task = await hub.createTask(input()); await hub.settled(task.id);
    expect(codex.runs[0]!.image).toBeUndefined();
    expect(builder).not.toHaveBeenCalled();
  });

  it("keeps Claude and host-runtime Codex on the host", async () => {
    configure({ go: "1.26.5" });
    const hostCodex = Object.assign(new FakeAdapter(script), { runtime: "host" as const });
    const { hub, claude, builder } = makeHub(undefined, hostCodex);
    const first = await hub.createTask(input({ agent: "claude" })); await hub.settled(first.id);
    const second = await hub.createTask(input()); await hub.settled(second.id);
    expect(builder).not.toHaveBeenCalled();
    expect(claude.runs[0]!.image).toBeUndefined();
    expect(hostCodex.runs[0]!.image).toBeUndefined();
  });

  it("gives docker-runtime Claude the same toolchain image as Codex", async () => {
    configure({ go: "1.26.5" });
    const { hub, claude, builder } = makeHub();
    Object.assign(claude, { runtime: "docker" as const });
    const task = await hub.createTask(input({ agent: "claude" })); await hub.settled(task.id);
    expect(builder).toHaveBeenCalledWith({ go: "1.26.5" }, expect.any(Function));
    expect(claude.runs[0]!.image).toBe("toolchain:go-1.26.5");
  });

  it("uses the toolchain for repository chats without applying ticket requirements", async () => {
    configure({ go: "1.26.5" });
    fs.writeFileSync(path.join(dataDir, "repos.json"), JSON.stringify({ [repo]: { toolchain: { go: "1.26.5" }, ticket: { required: true, pattern: "^T-[0-9]+$" } } }));
    const { hub, codex } = makeHub();
    const task = await hub.createTask(input({ workflow: "chat" })); await hub.settled(task.id);
    expect(codex.runs[0]!.image).toBe("toolchain:go-1.26.5");
    expect(task.options.repoSettings).toEqual({ toolchain: { go: "1.26.5" } });
  });

  it("shows and persists build activity before running, then reuses the image in a second task", async () => {
    configure({ go: "1.26.5" });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let built = false;
    const builder = vi.fn<typeof ensureToolchainImage>(async (_tools, onBuild) => {
      if (!built) { onBuild?.(); await gate; built = true; }
      return { tag: "toolchain:cached", built: false };
    });
    const { hub, codex } = makeHub(builder);
    const task = await hub.createTask(input());
    await vi.waitFor(() => expect(hub.getTask(task.id).activity).toBe(activity));
    expect(codex.runs).toHaveLength(0);
    expect(hub.events(task.id)).toContainEqual(expect.objectContaining({ type: "tool_call", input: activity, pending: true }));
    release(); await hub.settled(task.id);
    expect(hub.getTask(task.id).activity).not.toBe(activity);
    expect(hub.events(task.id)).toContainEqual(expect.objectContaining({ type: "tool_call", input: activity, output: "toolchain:cached" }));
    const second = await hub.createTask(input()); await hub.settled(second.id);
    expect(codex.runs.map((run) => run.image)).toEqual(["toolchain:cached", "toolchain:cached"]);
    expect(hub.events(second.id).some((event) => event.type === "tool_call" && event.input === activity)).toBe(false);
  });

  it("reports build failures without starting an agent", async () => {
    configure({ go: "1.26.5" });
    const builder = vi.fn<typeof ensureToolchainImage>(async (_tools, onBuild) => { onBuild?.(); throw new Error("toolchain build failed"); });
    const { hub, codex } = makeHub(builder);
    const task = await hub.createTask(input()); await hub.settled(task.id);
    expect(hub.getTask(task.id).status).toBe("failed");
    expect(codex.runs).toHaveLength(0);
    expect(hub.events(task.id)).toContainEqual(expect.objectContaining({ type: "turn_result", ok: false, error: "toolchain build failed" }));
  });
});

describe("toolchain settings validation", () => {
  it.each([null, [], "go@1.26.5", { "": "1.26.5" }, { "-go": "1.26.5" }, { "go;echo": "1.26.5" }, { "asdf:go": "1.26.5" }, { go: "" }, { go: 1265 }, { go: "-latest" }, { go: "1.26.5;echo" }, { go: "$(id)" }, { go: "1.26.5\n" }, { go: "../version" }, { go: "1.26.5 other@1" }])("rejects invalid toolchain entries (%j) before creating a task", async (toolchain) => {
    configure(toolchain);
    expect(() => readRepoSettings(dataDir, repo)).toThrow(/toolchain/);
    const { hub } = makeHub();
    await expect(hub.createTask(input())).rejects.toThrow(/Invalid repos.json:.*toolchain/);
    expect(hub.listTasks()).toHaveLength(0);
  });

  it("accepts simple mise tools and empty toolchains", () => {
    configure({ go: "1.26.5", python: "3.13.0-rc.1", "some_tool-name": "v1.2+build" });
    expect(readRepoSettings(dataDir, repo)?.toolchain).toEqual({ go: "1.26.5", python: "3.13.0-rc.1", "some_tool-name": "v1.2+build" });
    configure({});
    expect(readRepoSettings(dataDir, repo)?.toolchain).toEqual({});
  });
});
