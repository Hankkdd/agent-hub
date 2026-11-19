import type { QuotaReading } from "@agent-hub/shared";
import fs from "node:fs";
import path from "node:path";
import type { AgentAdapter, AgentEvent, AgentRunInput, PermissionDecision } from "./types";

/** A script step: an event to yield, or a permission question to put to the user first. */
export type FakeStep = AgentEvent | { type: "ask"; toolName: string; input: string } | { type: "write"; path: string; content: string };

/**
 * A scripted agent for tests: no model, no quota. Each run records its input and plays a script,
 * which may wait on a gate so a test can act while the turn is still "running".
 */
export class FakeAdapter implements AgentAdapter {
  readonly kind = "fake";
  readonly usageProducer = { source: "fake", version: "fixture", runtimeVersion: "fixture" };
  quotaCalls = 0;
  quotaScript: (signal: AbortSignal, call: number) => Promise<QuotaReading> = async () => ({ status: "unknown", windows: [] });
  queryQuota(signal: AbortSignal): Promise<QuotaReading> {
    return this.quotaScript(signal, ++this.quotaCalls);
  }
  readonly runs: AgentRunInput[] = [];
  /** The answers `ask` steps got, in order. */
  readonly decisions: PermissionDecision[] = [];
  /** When set, a run blocks after event number `after` until `release()` is called. */
  private gate: { promise: Promise<void>; open: () => void; after: number } | null = null;

  constructor(private readonly script: (input: AgentRunInput, n: number) => FakeStep[] = defaultScript) {}

  hold(after = 0): void {
    let open!: () => void;
    const promise = new Promise<void>((r) => (open = r));
    this.gate = { promise, open, after };
  }

  release(): void {
    this.gate?.open();
    this.gate = null;
  }

  async *run(input: AgentRunInput): AsyncIterable<AgentEvent> {
    const n = this.runs.push(input);
    const events = this.script(input, n);
    for (const [i, ev] of events.entries()) {
      if (input.signal.aborted) throw new DOMException("aborted", "AbortError");
      if (ev.type === "write") {
        // Stands in for an agent editing a file in its working directory.
        const file = path.join(input.cwd, ev.path);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, ev.content);
        continue;
      }
      if (ev.type === "ask") {
        if (!input.askPermission) throw new Error("script asks, but the run has no askPermission");
        this.decisions.push(await input.askPermission({ toolName: ev.toolName, input: ev.input, signal: input.signal }));
        if (input.signal.aborted) throw new DOMException("aborted", "AbortError");
        continue;
      }
      yield ev;
      if (this.gate && i === this.gate.after) {
        const gate = this.gate.promise;
        await Promise.race([gate, new Promise((_, reject) => input.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true }))]);
      }
    }
  }
}

function defaultScript(input: AgentRunInput, n: number): AgentEvent[] {
  return [
    { type: "thread", threadId: input.threadId ?? `thread-${n}` },
    { type: "text_start" },
    { type: "text_delta", text: `echo: ${input.prompt}` },
    { type: "done", ok: true, costUsd: 0, durationMs: 1, numTurns: 1 },
  ];
}
