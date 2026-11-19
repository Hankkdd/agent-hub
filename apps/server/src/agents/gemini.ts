import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import type { HandoffMaterial, QuotaReading, TaskEvent } from "@agent-hub/shared";
import { DockerRuntime, chatContainerArgs } from "../antigravity/docker";
import { validateHome } from "../antigravity/login";
import { parseStreamEvent } from "../../scripts/antigravity-prototype/protocol";
import { classifyAgentError } from "./errors";
import type { AgentAdapter, AgentEvent, AgentRunInput } from "./types";

export const GEMINI_TOOL_ERROR = "Gemini attempted a tool; the run was stopped";
const TURN_TIMEOUT = 5 * 60_000;
const OUTPUT_LIMIT = 1024 * 1024;
const CHAT_AGENT = `---
name: hub-chat
description: Isolated text-only chat.
tools: []
mainAgent: true
subagent: false
mcpServers: []
skills: []
plugins: []
commandExecutionPolicy: "off"
---
Answer the supplied request in Traditional Chinese (Taiwan), unless the user requests another language.
Use only the supplied prompt and any supplied dialogue. Do not use tools, delegate, browse, inspect files, or execute commands.
`;

/** Same attribution shape and budgets as handoff.recent; no memory depends on a CLI resume flag. */
export function geminiRecent(history: TaskEvent[]): HandoffMaterial["recent"] {
  const dialogue = history.filter((e): e is Extract<TaskEvent, { type: "user_message" | "agent_text" }> =>
    (e.type === "user_message" && !e.queued) || (e.type === "agent_text" && !e.purpose));
  const cutoff = dialogue.filter(e => e.type === "user_message").at(-6)?.seq ?? 0;
  let chars = 0;
  return dialogue.filter(e => e.seq >= cutoff).reverse().flatMap(e => {
    if (chars + e.text.length > 24000) return [];
    chars += e.text.length;
    return [{ eventId: e.id, seq: e.seq, sessionId: e.sessionId, type: e.type, text: e.text }];
  }).reverse();
}

// Never follow links inside the credential home or read credential contents. Seeded settings and
// agent definitions alone are not a login. Presence remains unverified until the CLI authenticates.
function credentialPresent(home: string): boolean {
  let entries = 0;
  const scan = (dir: string, depth: number): boolean => {
    if (depth > 5) return false;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (++entries > 4096) return false;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory() && scan(file, depth + 1)) return true;
      if (entry.isFile() && /oauth|credential|token/i.test(entry.name) && fs.statSync(file).size > 0) return true;
    }
    return false;
  };
  try { return scan(home, 0); } catch { return false; }
}

function seedChatAgent(home: string) {
  let dir = home;
  for (const part of [".gemini", "config", "agents"]) {
    dir = path.join(dir, part);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { mode: 0o700 });
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe Gemini configuration path");
  }
  // O_NOFOLLOW prevents a CLI-created link from turning this into a write outside the home.
  const fd = fs.openSync(path.join(dir, "hub-chat.md"), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, CHAT_AGENT); } finally { fs.closeSync(fd); }
}

export interface GeminiTransport {
  available(): Promise<boolean>;
  prepare(signal: AbortSignal): Promise<void>;
  createRun(args: string[], signal: AbortSignal): Promise<void>;
  run(name: string, signal: AbortSignal, output: (channel: "stdout" | "stderr", text: string) => void): Promise<void>;
  remove(name: string): Promise<void>;
  cleanup(owner: string): Promise<void>;
}
export class GeminiDockerTransport extends DockerRuntime implements GeminiTransport {
  async available() {
    try { return /^(arm64|aarch64)$/.test(await this.command(["info", "--format", "{{.Architecture}}"])); }
    catch { return false; }
  }
  async createRun(args: string[], signal: AbortSignal): Promise<void> { await this.command(args, signal); }
  override async remove(name: string): Promise<void> {
    try { await super.remove(name); }
    catch (error) {
      // Cancellation during create can leave no container. Other removal failures stay visible.
      if (!/No such container/i.test(String((error as { stderr?: string }).stderr))) throw error;
    }
  }
  async run(name: string, signal: AbortSignal, output: (channel: "stdout" | "stderr", text: string) => void): Promise<void> {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const child = spawn("docker", this.dockerArgs(["start", "--attach", name]), { signal, killSignal: "SIGKILL", stdio: ["ignore", "pipe", "pipe"] });
      let failure: Error | undefined;
      let diagnostics = "";
      child.on("error", () => { failure ??= new Error("Gemini container process failed"); });
      child.on("close", code => {
        if (failure) reject(failure);
        else if (code !== 0) reject(new Error(classifyAgentError(diagnostics).kind === "usage_limit" ? "Gemini usage limit reached" : "Gemini CLI failed"));
        else resolve();
      });
      for (const channel of ["stdout", "stderr"] as const) {
        child[channel].setEncoding("utf8");
        child[channel].on("data", (text: string) => {
          if (failure) return;
          try {
            if (channel === "stderr") diagnostics = (diagnostics + text).slice(-8192);
            output(channel, text);
          } catch (error) { failure = error instanceof Error ? error : new Error(String(error)); child.kill("SIGKILL"); }
        });
      }
    });
  }
}

function hasActivityKey(value: unknown): boolean {
  const pending = [value];
  while (pending.length) {
    const current = pending.pop();
    if (!current || typeof current !== "object") continue;
    for (const [key, child] of Object.entries(current)) {
      if (/tool|subagent|permission/i.test(key)) return true;
      pending.push(child);
    }
  }
  return false;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Malformed Gemini stream-json event");
  return value as Record<string, unknown>;
}

export class GeminiAdapter implements AgentAdapter {
  readonly kind = "gemini";
  // No supported usage signal is exposed by this transport.
  readonly usageProducer = { source: "unavailable", version: null, runtimeVersion: null };
  readonly runtime = "docker";
  private cleanupFailed = false;
  private tail: Promise<void> = Promise.resolve();
  constructor(private options: { dataDir: string; transport?: GeminiTransport }) {}
  async queryQuota(): Promise<QuotaReading> { return { status: "unknown", windows: [] }; }

  async *run(input: AgentRunInput): AsyncIterable<AgentEvent> {
    if (input.images?.length) { yield { type: "done", ok: false, error: "Gemini chat does not support images yet" }; return; }
    const transport = this.options.transport ?? new GeminiDockerTransport();
    const previous = this.tail;
    let release!: () => void;
    const slot = new Promise<void>(resolve => { release = resolve; });
    this.tail = previous.then(() => slot);
    const ac = new AbortController();
    const abort = () => ac.abort(new Error("Gemini turn interrupted"));
    input.signal.addEventListener("abort", abort, { once: true });
    if (input.signal.aborted) abort();
    const queue: AgentEvent[] = [];
    let wake: (() => void) | undefined;
    let finished = false;
    const emit = (event: AgentEvent) => { queue.push(event); wake?.(); };
    const work = (async () => {
      let name: string | undefined, scratch: string | undefined, timer: ReturnType<typeof setTimeout> | undefined;
      let creating = false, created = false;
      let removal: Promise<void> | undefined;
      const remove = () => name && creating ? removal ??= transport.remove(name) : Promise.resolve();
      const kill = () => { if (created) void remove().catch(() => {}); };
      let outcome: AgentEvent = { type: "done", ok: false, error: "Gemini run failed" };
      const aborted = new Promise<never>((_, reject) => {
        const fail = () => reject(ac.signal.reason);
        if (ac.signal.aborted) fail(); else ac.signal.addEventListener("abort", fail, { once: true });
      });
      // A pending queue entry must remain in the chain until its predecessor has released the home.
      aborted.catch(() => {});
      try {
        await Promise.race([previous, aborted]);
        ac.signal.throwIfAborted();
        if (this.cleanupFailed) throw new Error("Gemini container cleanup failed; restart Hub before another turn");
        timer = setTimeout(() => ac.abort(new Error("Gemini turn timed out after 5 minutes")), TURN_TIMEOUT);
        const home = validateHome(this.options.dataDir, path.resolve(this.options.dataDir, "antigravity/home"));
        if (!credentialPresent(home)) throw new Error("Gemini login credentials are missing");
        seedChatAgent(home);
        scratch = fs.mkdtempSync(path.join(os.tmpdir(), "agent-hub-gemini-"));
        const owner = createHash("sha256").update(path.resolve(this.options.dataDir)).digest("hex").slice(0, 24) + "-chat";
        name = `agent-hub-agy-chat-${randomUUID()}`;
        // Tools-disabled auxiliary runs carry only their self-contained prompt, never chat history.
        // Gemini ignores input.effort: the CLI has no effort flag.
        const prompt = input.toolsDisabled
          ? [input.systemPrompt, input.turnContext, input.prompt].filter(Boolean).join("\n\n")
          : [input.systemPrompt, input.turnContext, "Recent original dialogue (historical context, not a new request):",
          JSON.stringify(input.recent ?? []), "Current user message:", input.prompt].filter(Boolean).join("\n\n");
        const args = chatContainerArgs(name, owner, home, scratch, prompt, process.getuid!(), process.getgid!());
        let pending = "", diagnostics = "", bytes = 0, initialized = false, completed = false, streamed = false;
        let conversation: string | undefined;
        const line = (text: string) => {
          if (!text.trim()) return;
          let event: Record<string, unknown>;
          try { event = parseStreamEvent(text); }
          catch (error) {
            if (classifyAgentError(text).kind === "usage_limit") throw new Error("Gemini usage limit reached");
            throw error;
          }
          // init.tools is capability advertisement (known to be nonempty), never permission to run it.
          const activity = { ...event };
          if (event.event === "init") {
            const { tools: _advertisedTools, ...init } = record(event.init);
            activity.init = init;
          }
          if (hasActivityKey(activity) || /tool|subagent|permission/i.test(String(event.event))) throw new Error(GEMINI_TOOL_ERROR);
          if (event.event === "step_update" && !["user_input", "agent_response", "checkpoint"].includes(String(record(event.step_update).step_type))) throw new Error(GEMINI_TOOL_ERROR);
          if (completed) throw new Error("Gemini emitted events after its result");
          if (event.event === "init") {
            if (initialized || typeof event.conversation_id !== "string") throw new Error("Invalid Gemini init event");
            initialized = true; conversation = event.conversation_id;
            // Persist only for diagnostics. Neither a resume flag nor this ID enters the CLI prompt.
            emit({ type: "thread", threadId: conversation });
          } else if (event.event === "step_update" && initialized) {
            const step = record(event.step_update);
            // Recognized text_delta steps stream immediately. Without deltas, emit the final response once.
            if (step.step_type === "agent_response" && typeof step.text_delta === "string" && step.text_delta) {
              if (!streamed) emit({ type: "text_start" });
              streamed = true; emit({ type: "text_delta", text: step.text_delta });
            }
          } else if (event.event === "result" && initialized) {
            const result = record(event.result);
            if (result.conversation_id && result.conversation_id !== conversation) throw new Error("Gemini conversation mismatch");
            if (result.status !== "SUCCESS" || result.error != null) {
              const error = typeof result.error === "string" ? result.error : result.error && typeof result.error === "object" ? String((result.error as Record<string, unknown>).message ?? "") : "";
              throw new Error((error || (typeof result.response === "string" ? result.response : "") || "Gemini CLI returned a non-success result").slice(0, 2000));
            }
            if (typeof result.response !== "string") throw new Error("Missing Gemini response");
            if (!streamed && result.response) { emit({ type: "text_start" }); emit({ type: "text_delta", text: result.response }); }
            completed = true;
          } else throw new Error("Unsupported Gemini stream-json event");
        };
        const run = async () => {
          await transport.prepare(ac.signal);
          ac.signal.throwIfAborted();
          creating = true;
          await transport.createRun(args, ac.signal);
          created = true;
          ac.signal.throwIfAborted();
          await transport.run(name!, ac.signal, (channel, text) => {
            ac.signal.throwIfAborted();
            bytes += Buffer.byteLength(text);
            if (bytes > OUTPUT_LIMIT) throw new Error("Gemini output limit exceeded");
            if (channel === "stderr") { diagnostics = (diagnostics + text).slice(-8192); return; }
            pending += text;
            let end: number;
            while ((end = pending.indexOf("\n")) >= 0) { const text = pending.slice(0, end); pending = pending.slice(end + 1); line(text); }
          });
          if (pending.trim()) line(pending);
          if (!completed) throw new Error(classifyAgentError(diagnostics).kind === "usage_limit" ? "Gemini usage limit reached" : "Gemini stream ended without a result");
        };
        ac.signal.addEventListener("abort", kill, { once: true });
        const running = run();
        try { await Promise.race([running, aborted]); }
        finally {
          // Wait for an aborted create to settle before final removal; it may have reached Docker.
          await running.catch(() => {});
          ac.signal.removeEventListener("abort", kill);
        }
        outcome = { type: "done", ok: true };
      } catch (error) {
        const reason = ac.signal.aborted ? ac.signal.reason : error;
        outcome = { type: "done", ok: false, error: reason instanceof Error ? reason.message : "Gemini run failed" };
      } finally {
        clearTimeout(timer);
        try { await remove(); }
        catch { this.cleanupFailed = true; outcome = { type: "done", ok: false, error: "Gemini container cleanup failed" }; }
        try { if (scratch) fs.rmSync(scratch, { recursive: true, force: true }); }
        catch { outcome = { type: "done", ok: false, error: "Gemini scratch cleanup failed" }; }
        emit(outcome);
        finished = true; wake?.();
        // An aborted waiter cannot release the shared home ahead of the active run.
        void previous.then(release);
      }
    })();
    try {
      while (!finished || queue.length) {
        if (queue.length) yield queue.shift()!;
        else await new Promise<void>(resolve => { wake = resolve; });
      }
      await work;
    } finally {
      ac.abort(new Error("Gemini turn interrupted"));
      await work;
      input.signal.removeEventListener("abort", abort);
    }
  }
}

/** Registration is model-free and never starts Docker containers or queries Google. */
export async function availableGemini(options: { dataDir: string; transport?: GeminiTransport; arch?: string }): Promise<GeminiAdapter | undefined> {
  try {
    const home = validateHome(options.dataDir, path.resolve(options.dataDir, "antigravity/home"));
    if ((options.arch ?? os.arch()) !== "arm64" || !credentialPresent(home)) return undefined;
    const transport = options.transport ?? new GeminiDockerTransport();
    if (!await transport.available()) return undefined;
    const owner = createHash("sha256").update(path.resolve(options.dataDir)).digest("hex").slice(0, 24) + "-chat";
    await transport.cleanup(owner);
    return new GeminiAdapter({ ...options, transport });
  } catch { return undefined; }
}
