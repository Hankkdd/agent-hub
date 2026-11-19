import { beforeEach, expect, it, vi } from "vitest";
import type { ThreadEvent } from "@openai/codex-sdk";
import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { CodexAdapter } from "../src/agents/codex";
import { ClaudeAdapter } from "../src/agents/claude";
import type { AgentEvent } from "../src/agents/types";

let events: ThreadEvent[] = [];
const runStreamed = vi.fn(async (_input: unknown, _options: unknown) => ({ events: (async function* () { yield* events; })() }));
vi.mock("@openai/codex-sdk", () => ({ Codex: vi.fn(class {
  startThread() { return { runStreamed }; }
  resumeThread() { return { runStreamed }; }
}) }));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: vi.fn() }));
const schema = { type: "object" };
const input = { prompt: "judge", cwd: "/example/repo", signal: new AbortController().signal };
const collect = async (source: AsyncIterable<AgentEvent>) => { const result: AgentEvent[] = []; for await (const event of source) result.push(event); return result; };
const message = (text: string, id = "final"): ThreadEvent => ({ type: "item.completed", item: { id, type: "agent_message", text } });
const completed: ThreadEvent = { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, cache_write_input_tokens: 0, reasoning_output_tokens: 0 } };
beforeEach(() => { vi.clearAllMocks(); events = []; });
it("passes the Codex schema and parses the last completed agent message, preserving raw text", async () => {
  events = [message("earlier", "first"), message('{"answer":'), { type: "item.updated", item: { id: "final", type: "agent_message", text: '{"answer":42}' } }, message('{"answer":42}'), completed];
  const result = await collect(new CodexAdapter({ runtime: "host" }).run({ ...input, outputSchema: schema }));
  expect(runStreamed.mock.calls[0]![1]).toMatchObject({ outputSchema: schema });
  expect(result.at(-1)).toMatchObject({ type: "done", ok: true, output: { answer: 42 } });
  expect(result.filter(e => e.type === "text_delta").map(e => e.text).join("")).toBe('earlier{"answer":42}');
});
it.each([undefined, "", "not JSON"])("fails Codex structured output for missing/invalid text: %s", async text => {
  events = [...(text === undefined ? [] : [message(text)]), completed];
  const result = await collect(new CodexAdapter({ runtime: "host" }).run({ ...input, outputSchema: schema }));
  expect(result.at(-1)).toMatchObject({ type: "done", ok: false, error: expect.stringMatching(/^output did not match the requested schema: /) });
  if (text) expect(result).toContainEqual({ type: "text_delta", text });
});
it("ignores incomplete final messages and leaves ordinary Codex turns unchanged", async () => {
  events = [{ type: "item.updated", item: { id: "partial", type: "agent_message", text: "{}" } }, completed];
  expect((await collect(new CodexAdapter({ runtime: "host" }).run({ ...input, outputSchema: schema }))).at(-1)).toMatchObject({ ok: false });
  events = [message("ordinary prose"), completed];
  const result = await collect(new CodexAdapter({ runtime: "host" }).run(input));
  expect(result.at(-1)).toMatchObject({ ok: true });
  expect(result.at(-1)).not.toHaveProperty("output");
  expect(runStreamed.mock.calls.at(-1)![1]).not.toHaveProperty("outputSchema");
});
it.each([
  { subtype: "success", structured_output: { answer: 42 }, ok: true },
  { subtype: "success", ok: false },
  { subtype: "error_max_structured_output_retries", ok: false },
])("maps Claude structured output: %j", async ({ ok, ...fixture }) => {
  vi.mocked(query).mockReturnValue((async function* () {
    yield { type: "result", is_error: false, result: "raw", total_cost_usd: 0, duration_ms: 1, num_turns: 1, ...fixture } as SDKMessage;
  })() as ReturnType<typeof query>);
  const result = await collect(new ClaudeAdapter({ permissionMode: "auto", settingSources: [] }).run({ ...input, outputSchema: schema }));
  expect(vi.mocked(query).mock.calls[0]![0].options!.outputFormat).toEqual({ type: "json_schema", schema });
  expect(result.at(-1)).toMatchObject({ type: "done", ok });
  if (ok) expect(result.at(-1)).toHaveProperty("output", { answer: 42 });
  else expect(result.at(-1)).toHaveProperty("error", expect.any(String));
});
