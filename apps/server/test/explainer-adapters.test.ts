import { expect, it, vi } from "vitest";
import { Codex } from "@openai/codex-sdk";
import { CodexAdapter } from "../src/agents/codex";

vi.mock("../src/agents/codex-docker", () => ({
  codexVersion: () => "0.162.1",
  imageTag: () => "codex:plain", ensureImage: vi.fn(async () => ({ built: false })),
  isLoggedIn: () => true, loginCommand: () => "login", WRAPPER: "/example/codex-docker",
}));

const startThread = vi.fn(() => ({ runStreamed: async () => ({ events: (async function* () { yield { type: "turn.completed" }; })() }) }));
vi.mock("@openai/codex-sdk", () => ({ Codex: vi.fn(class { startThread = startThread; }) }));

it("gives Codex MCP calls longer than its default timeout, for E3 downloads", async () => {
  vi.mocked(Codex).mockClear();
  const adapter = new CodexAdapter({ runtime: "host" });
  for await (const _event of adapter.run({ prompt: "Get the slides", cwd: "/example/repo", signal: new AbortController().signal, mcp: { url: "http://127.0.0.1:8788/mcp", token: "fixture-token" } })) { /* No CLI or model is called. */ }
  expect(vi.mocked(Codex).mock.calls[0]![0]).toMatchObject({ config: { mcp_servers: { agenthub: { tool_timeout_sec: 720 } } } });
});

it("configures Codex explanations read-only without MCP, shell, patch, or web tools", async () => {
  const adapter = new CodexAdapter({ runtime: "host" });
  for await (const _event of adapter.run({ prompt: "Explain the patch", cwd: "/example/repo", signal: new AbortController().signal, readOnly: true, toolsDisabled: true })) { /* No CLI or model is called. */ }
  expect(vi.mocked(Codex).mock.calls[0]![0]).toMatchObject({ config: { mcp_servers: {}, features: { shell_tool: false, apply_patch_freeform: false }, web_search: "disabled" } });
  expect(startThread).toHaveBeenCalledWith(expect.objectContaining({ sandboxMode: "read-only", approvalPolicy: "never" }));
});


it("sets the prepared image per Codex turn without leaking it to the default or another task", async () => {
  const adapter = new CodexAdapter({ runtime: "docker", codexHome: "/example/codex-home", cacheDir: "/example/cache" });
  vi.mocked(Codex).mockClear();
  for (const image of ["toolchain:go", undefined, "toolchain:python"]) {
    for await (const _event of adapter.run({ prompt: "Check tools", cwd: "/example/repo", image, signal: new AbortController().signal })) { /* No CLI or model is called. */ }
  }
  expect(vi.mocked(Codex).mock.calls.map((call) => call[0]!.env?.AGENT_HUB_CODEX_IMAGE)).toEqual(["toolchain:go", "codex:plain", "toolchain:python"]);
  expect(vi.mocked(Codex).mock.calls[0]![0]).toMatchObject({ codexPathOverride: "/example/codex-docker", env: { AGENT_HUB_CODEX_CACHE: "/example/cache" } });
});
