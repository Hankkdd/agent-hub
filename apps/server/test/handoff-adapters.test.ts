import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { Codex } from "@openai/codex-sdk";
import { ClaudeAdapter } from "../src/agents/claude";
import { CodexAdapter } from "../src/agents/codex";
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: vi.fn(async function* () {}) }));
const runStreamed = vi.fn(async () => ({ events: (async function* () { yield { type: "turn.completed" }; })() }));
const startThread = vi.fn(() => ({ runStreamed }));
vi.mock("@openai/codex-sdk", () => ({ Codex: vi.fn(class { startThread = startThread; }) }));
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); vi.clearAllMocks(); });
it("both SDK transports carry ordered actual historical/new images without provider thread reuse", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-sdk-")); roots.push(root);
  const history = path.join(root, "history.png"), fresh = path.join(root, "fresh.png");
  fs.writeFileSync(history, "historical bytes"); fs.writeFileSync(fresh, "new bytes");
  const input = { prompt: "Historical peer context\nActual request", cwd: root, images: [{ path: history, mime: "image/png" }, { path: fresh, mime: "image/png" }], signal: new AbortController().signal, readOnly: true };
  for await (const _ of new ClaudeAdapter({ permissionMode: "default", settingSources: [] }).run(input)) { /* Scripted SDK only. */ }
  const payload = vi.mocked(query).mock.calls[0]![0].prompt;
  if (typeof payload === "string") throw new Error("Images were dropped");
  const messages = [];
  for await (const message of payload) messages.push(message);
  expect(messages[0]!.message.content).toEqual([
    { type: "image", source: { type: "base64", media_type: "image/png", data: Buffer.from("historical bytes").toString("base64") } },
    { type: "image", source: { type: "base64", media_type: "image/png", data: Buffer.from("new bytes").toString("base64") } },
    { type: "text", text: input.prompt },
  ]);
  expect(vi.mocked(query).mock.calls[0]![0].options!.resume).toBeUndefined();
  for await (const _ of new CodexAdapter({ runtime: "host" }).run(input)) { /* Scripted SDK only. */ }
  expect(runStreamed).toHaveBeenCalledWith([{ type: "text", text: input.prompt }, { type: "local_image", path: history }, { type: "local_image", path: fresh }], expect.anything());
  expect(startThread).toHaveBeenCalledTimes(1); expect(Codex).toHaveBeenCalledTimes(1);
});
