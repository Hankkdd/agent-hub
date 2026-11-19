import { query } from "@anthropic-ai/claude-agent-sdk";
import { expect, it, vi } from "vitest";
import { ClaudeAdapter } from "../src/agents/claude";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: vi.fn(async function* () {}) }));

it("allows Claude to call both issue tools over the per-turn MCP connection", async () => {
  const adapter = new ClaudeAdapter({ permissionMode: "default", settingSources: [] });
  for await (const _event of adapter.run({
    prompt: "Plan issue #7", cwd: "/example/repo", systemPrompt: "Planning", readOnly: true,
    signal: new AbortController().signal, mcp: { url: "http://127.0.0.1:8788/mcp", token: "fixture-token" },
  })) { /* The mocked SDK sends no events. */ }
  const options = vi.mocked(query).mock.calls[0]![0].options!;
  expect(options.allowedTools).toEqual(expect.arrayContaining(["mcp__agenthub__record_finding", "mcp__agenthub__list_findings", "mcp__agenthub__list_issues", "mcp__agenthub__read_issue", "mcp__agenthub__list_project_docs", "mcp__agenthub__search_project_docs", "mcp__agenthub__read_project_doc", "mcp__agenthub__propose_task", "mcp__agenthub__start_task", "mcp__agenthub__open_pr", "mcp__agenthub__ask", "mcp__agenthub__message_task"]));
  expect(options.mcpServers).toEqual({ agenthub: { type: "http", url: "http://127.0.0.1:8788/mcp", headers: { Authorization: "Bearer fixture-token" } } });
});

it("lets Claude call the E3 tools without a permission prompt", async () => {
  vi.mocked(query).mockClear();
  const adapter = new ClaudeAdapter({ permissionMode: "default", settingSources: [] });
  for await (const _event of adapter.run({
    prompt: "List my assignments", cwd: "/example/repo",
    signal: new AbortController().signal, mcp: { url: "http://127.0.0.1:8788/mcp", token: "fixture-token" },
  })) { /* The mocked SDK sends no events. */ }
  expect(vi.mocked(query).mock.calls[0]![0].options!.allowedTools).toEqual(expect.arrayContaining([
    "mcp__agenthub__e3_list_assignments", "mcp__agenthub__e3_list_courses", "mcp__agenthub__e3_list_materials", "mcp__agenthub__e3_download_material",
  ]));
});

it("disables all Claude tools and inherited settings for an explainer", async () => {
  vi.mocked(query).mockClear();
  const adapter = new ClaudeAdapter({ permissionMode: "bypassPermissions", settingSources: ["user", "project", "local"] });
  for await (const _event of adapter.run({ prompt: "Explain the patch", cwd: "/example/repo", signal: new AbortController().signal, readOnly: true, toolsDisabled: true })) { /* No model is called. */ }
  expect(vi.mocked(query).mock.calls[0]![0].options).toMatchObject({ tools: [], mcpServers: {}, strictMcpConfig: true, settingSources: [], permissionMode: "dontAsk", allowDangerouslySkipPermissions: false });
});
