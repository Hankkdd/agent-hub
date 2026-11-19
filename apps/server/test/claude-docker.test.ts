import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeAdapter } from "../src/agents/claude";
import { carryOverSession, dockerArgs, isLoggedIn, LABEL } from "../src/agents/claude-docker";
import type { AgentEvent, AgentRunInput } from "../src/agents/types";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: vi.fn(async function* () {}) }));
vi.mock("../src/agents/codex-docker", () => ({ imageTag: () => "agent-hub-codex:test", ensureImage: vi.fn(async () => ({ built: false })) }));

const base = { image: "agent-hub-codex:test", claudeHome: "/data/claude-home", uid: "1000:1000", command: "/sdk/bin/claude", args: ["--output-format", "stream-json"], env: {} };
const mounts = (args: string[]) => args.flatMap((arg, i) => args[i - 1] === "-v" ? [arg] : []);
const envs = (args: string[]) => args.flatMap((arg, i) => args[i - 1] === "-e" ? [arg] : []);

describe("dockerArgs", () => {
  it("mounts the task read-write at the same path, and the binary, shared .git and references read-only", () => {
    const args = dockerArgs({ ...base, cwd: "/work/task", gitCommonDir: "/repo/.git", referenceDirs: ["/refs/docs", "relative"], cacheDir: "/data/cache" });
    expect(args.slice(0, 9)).toEqual(["run", "--rm", "-i", "--init", "--label", LABEL, "--user", "1000:1000", "-e"]);
    expect(mounts(args)).toEqual([
      "/data/claude-home:/claude-home", "/work/task:/work/task:rw", "/repo/.git:/repo/.git:ro", "/refs/docs:/refs/docs:ro", "/sdk/bin:/sdk/bin:ro", "/data/cache:/cache",
    ]);
    expect(args[args.indexOf("-w") + 1]).toBe("/work/task");
    expect(envs(args)).toEqual(expect.arrayContaining(["HOME=/tmp", "CLAUDE_CONFIG_DIR=/claude-home", "GOCACHE=/cache/go-build"]));
    expect(args.slice(-4)).toEqual(["agent-hub-codex:test", "/sdk/bin/claude", "--output-format", "stream-json"]);
  });

  it("mounts the task read-only for read-only turns and skips a .git already inside it", () => {
    const args = dockerArgs({ ...base, cwd: "/repo", gitCommonDir: "/repo/.git", readOnly: true });
    expect(mounts(args)).toEqual(["/data/claude-home:/claude-home", "/repo:/repo:ro", "/sdk/bin:/sdk/bin:ro"]);
  });

  it("passes only Claude Code's own variables, never the server's secrets or config dir", () => {
    const args = dockerArgs({ ...base, env: {
      ANTHROPIC_MODEL: "m", CLAUDE_CODE_ENTRYPOINT: "sdk-ts", CLAUDE_AGENT_SDK_VERSION: "1", DEBUG_CLAUDE: "1",
      AGENT_HUB_TOKEN: "secret", AGENT_HUB_DISCORD_WEBHOOK: "secret", GITHUB_TOKEN: "secret", CLAUDE_CONFIG_DIR: "/home/user/.claude", PATH: "/usr/bin", UNSET: undefined,
    } });
    const passed = envs(args).filter((e) => !["HOME=/tmp", "CLAUDE_CONFIG_DIR=/claude-home"].includes(e));
    expect(passed).toEqual(["ANTHROPIC_MODEL=m", "CLAUDE_CODE_ENTRYPOINT=sdk-ts", "CLAUDE_AGENT_SDK_VERSION=1", "DEBUG_CLAUDE=1"]);
    expect(args.join(" ")).not.toContain("secret");
  });

  it("names the container only when asked", () => {
    expect(dockerArgs(base)).not.toContain("--name");
    const named = dockerArgs({ ...base, name: "agent-hub-claude-quota-1" });
    expect(named[named.indexOf("--name") + 1]).toBe("agent-hub-claude-quota-1");
  });
});

describe("container sessions", () => {
  let root: string, host: string, home: string;
  const id = "0b7e3c1a-1111-4222-8333-944445555666";
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-docker-"));
    host = path.join(root, "host-claude"); home = path.join(root, "claude-home");
    fs.mkdirSync(path.join(host, "projects", "-work-task"), { recursive: true });
    fs.writeFileSync(path.join(host, "projects", "-work-task", `${id}.jsonl`), "host history\n");
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("carries a host conversation into claude-home once and never overwrites it", () => {
    expect(carryOverSession(id, home, host)).toBe(true);
    const copy = path.join(home, "projects", "-work-task", `${id}.jsonl`);
    expect(fs.readFileSync(copy, "utf8")).toBe("host history\n");
    fs.writeFileSync(copy, "container history\n");
    expect(carryOverSession(id, home, host)).toBe(false);
    expect(fs.readFileSync(copy, "utf8")).toBe("container history\n");
  });

  it("ignores unknown, missing and malformed thread ids", () => {
    expect(carryOverSession(undefined, home, host)).toBe(false);
    expect(carryOverSession("../../etc/passwd", home, host)).toBe(false);
    expect(carryOverSession("0b7e3c1a-1111-4222-8333-000000000000", home, host)).toBe(false);
    expect(fs.existsSync(path.join(home, "projects"))).toBe(false);
  });

  it("reads the login from claude-home", () => {
    expect(isLoggedIn(home)).toBe(false);
    fs.mkdirSync(home); fs.writeFileSync(path.join(home, ".credentials.json"), "{}");
    expect(isLoggedIn(home)).toBe(true);
  });
});

describe("ClaudeAdapter runtime", () => {
  let home: string;
  beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), "claude-home-")); vi.mocked(query).mockClear(); });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));
  const input = (extra: Partial<AgentRunInput> = {}): AgentRunInput => ({ prompt: "hi", cwd: "/work/task", signal: new AbortController().signal, ...extra } as AgentRunInput);
  const drain = async (events: AsyncIterable<AgentEvent>) => { const out: AgentEvent[] = []; for await (const e of events) out.push(e); return out; };

  it("runs on the host by default, with no custom spawn", async () => {
    const adapter = new ClaudeAdapter({ permissionMode: "auto", settingSources: [] });
    expect(adapter.runtime).toBe("host");
    await drain(adapter.run(input()));
    expect(vi.mocked(query).mock.calls[0]![0].options!.spawnClaudeCodeProcess).toBeUndefined();
  });

  it("refuses with the login command before starting anything when the container is not logged in", async () => {
    const adapter = new ClaudeAdapter({ permissionMode: "auto", settingSources: [], runtime: "docker", claudeHome: home });
    const events = await drain(adapter.run(input()));
    expect(events).toEqual([{ type: "done", ok: false, error: expect.stringContaining("pnpm claude:login") }]);
    expect(query).not.toHaveBeenCalled();
    expect(await adapter.queryQuota(new AbortController().signal)).toEqual({ status: "missing_login", windows: [] });
    expect(await adapter.listModels()).toEqual([]);
  });

  it("spawns each turn in a container once logged in", async () => {
    fs.writeFileSync(path.join(home, ".credentials.json"), "{}");
    const adapter = new ClaudeAdapter({ permissionMode: "auto", settingSources: [], runtime: "docker", claudeHome: home });
    expect(adapter.runtime).toBe("docker");
    await drain(adapter.run(input({ readOnly: true, image: "toolchain:go", outputSchema: { type: "object" } })));
    expect(vi.mocked(query).mock.calls[0]![0].options!.spawnClaudeCodeProcess).toEqual(expect.any(Function));
    expect(vi.mocked(query).mock.calls[0]![0].options!.outputFormat).toEqual({ type: "json_schema", schema: { type: "object" } });
  });

  it("requires a claude-home for the docker runtime", () => {
    expect(() => new ClaudeAdapter({ permissionMode: "auto", settingSources: [], runtime: "docker" })).toThrow("claudeHome");
  });
});

it("preserves the SDK inline JSON schema argument through the Docker command", () => {
  const schema = JSON.stringify({ type: "object", properties: { answer: { type: "string" } } });
  expect(dockerArgs({ ...base, args: ["--json-schema", schema] }).slice(-2)).toEqual(["--json-schema", schema]);
});
