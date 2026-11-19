import { afterEach, expect, it, vi } from "vitest";
import { CodexAdapter } from "../src/agents/codex";
const runStreamed = vi.fn(async (_input: unknown) => ({ events: (async function* () { yield { type: "turn.completed" }; })() }));
const thread = () => ({ runStreamed });
vi.mock("@openai/codex-sdk", () => ({ Codex: vi.fn(class { startThread = thread; resumeThread = thread; }) }));
afterEach(() => { vi.clearAllMocks(); });

async function sent(input: { threadId?: string; systemPrompt?: string; turnContext?: string }): Promise<unknown> {
  for await (const _ of new CodexAdapter({ runtime: "host" }).run({ prompt: "Request", cwd: "/example/repo", signal: new AbortController().signal, readOnly: true, referenceDirs: ["/example/reference"], ...input })) { /* Scripted SDK only. */ }
  return runStreamed.mock.calls.at(-1)![0];
}

it("sends the instructions once per thread and the live context on every turn", async () => {
  expect(await sent({ systemPrompt: "Instructions", turnContext: "Other tasks: none." })).toBe("Instructions\n\nOther tasks: none.\n\n---\n\nRequest");
  expect(await sent({ threadId: "thread-1", systemPrompt: "Instructions", turnContext: "Other tasks: one." })).toBe("Other tasks: one.\n\n---\n\nRequest");
  expect(await sent({ threadId: "thread-1", systemPrompt: "Instructions" })).toBe("Request");
});
