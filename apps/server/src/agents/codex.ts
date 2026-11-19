import { codexUsage, packageVersion } from "./usage";
import { codexQuota } from "./codex-quota";
import { Codex, type ThreadItem, type ThreadOptions } from "@openai/codex-sdk";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { EFFORT_LEVELS, type EffortLevel, type ModelChoice } from "@agent-hub/shared";
import { classify } from "./claude";
import { ensureImage, imageTag, isLoggedIn, loginCommand, WRAPPER, codexVersion } from "./codex-docker";
import type { AgentAdapter, AgentEvent, AgentRunInput } from "./types";

export interface CodexAdapterOptions {
  model?: string;
  /**
   * `docker` (default): every turn runs the CLI in a container that sees only the task's directory
   * (bin/codex-docker), with its own login in `codexHome`. `host`: the CLI runs on this machine with
   * Codex's own bubblewrap sandbox, which needs unprivileged user namespaces (blocked by AppArmor on
   * stock Ubuntu 24.04, where every command then fails).
   */
  runtime?: "docker" | "host";
  /** docker: the container's CODEX_HOME (auth.json + its sessions), apart from the host's ~/.codex. */
  codexHome?: string;
  /** docker: a host directory for package caches shared across turns (see bin/codex-docker). */
  cacheDir?: string;
}

/**
 * Codex via its TypeScript SDK, which drives the Codex CLI and therefore uses its ChatGPT login.
 *
 * Two differences from Claude shape this file:
 *  - No permission callback. Approvals are set to `never` (there is no one to ask inside the SDK) and
 *    the SANDBOX is the safety boundary instead: an author may write only inside its worktree, a
 *    reviewer may not write at all.
 *  - No system-prompt option. The instructions ride at the head of a thread's first message.
 *
 * Text arrives per message (item.completed), not per token, so a Codex reply appears in chunks.
 */
// Codex gives up on an MCP call after 60 seconds by default, shorter than an E3 listing, an E3 download
// (e3.ts, 660 seconds) or a long ssh_exec can take.
const MCP_TOOL_TIMEOUT_S = 720;

export class CodexAdapter implements AgentAdapter {
  readonly kind = "codex";
  get usageProducer() { return { source: "codex.turn.completed.usage", version: packageVersion("@openai/codex-sdk"), runtimeVersion: this.runtime === "docker" ? codexVersion() : null }; }
  private readonly image: string | null;
  readonly runtime: "docker" | "host";

  constructor(private readonly opts: CodexAdapterOptions = {}) {
    this.runtime = opts.runtime ?? "docker";
    if (this.runtime === "docker") {
      if (!opts.codexHome) throw new Error("codexHome is required for the docker runtime");
      this.image = imageTag();
    } else {
      this.image = null;
    }
  }

  get defaultModel() { return this.opts.model; }

  queryQuota(signal: AbortSignal) { return codexQuota(this.image, this.opts.codexHome, signal); }

  /**
   * Codex's own model catalog (`codex debug models`, refreshed from the server with the container's
   * login). Only models it marks for listing; hidden ones are internal.
   */
  async listModels(): Promise<ModelChoice[]> {
    if (!this.image) return []; // host runtime: no catalog command wired; the picker offers the default only
    await ensureImage(this.image);
    const { stdout } = await promisify(execFile)(
      "docker",
      ["run", "--rm", "--user", `${process.getuid!()}:${process.getgid!()}`, "-e", "HOME=/tmp", "-e", "CODEX_HOME=/codex-home", "-v", `${this.opts.codexHome}:/codex-home`, this.image, "codex", "debug", "models"],
      { maxBuffer: 32 * 1024 * 1024, timeout: 60_000 },
    );
    const catalog = JSON.parse(stdout) as { models: CodexModel[] };
    return catalog.models
      .filter((m) => m.visibility === "list")
      .map((m) => {
        const levels = (m.supported_reasoning_levels ?? []).map((l) => (typeof l === "string" ? l : l.effort)).filter(isEffort);
        return {
          id: m.slug,
          label: m.display_name ?? m.slug,
          description: m.description,
          effortLevels: levels.length ? levels : undefined,
          defaultEffort: m.default_reasoning_level && isEffort(m.default_reasoning_level) ? m.default_reasoning_level : undefined,
        };
      });
  }

  /**
   * One Codex client per turn: the MCP endpoint and its token are per turn, and the SDK takes config
   * and env only at construction. Cheap: it is a few fields, not a process.
   */
  private client(mcp: AgentRunInput["mcp"], referenceDirs?: string[], toolsDisabled = false, image?: string): Codex {
    // `env` replaces the inherited environment entirely, so pass it through plus what the turn needs.
    const env: Record<string, string> = { ...(process.env as Record<string, string>) };
    if (this.image) Object.assign(env, { AGENT_HUB_CODEX_IMAGE: image ?? this.image, AGENT_HUB_CODEX_HOME: this.opts.codexHome! });
    if (this.image && this.opts.cacheDir) env.AGENT_HUB_CODEX_CACHE = this.opts.cacheDir;
    if (mcp) env.AGENT_HUB_MCP_TOKEN = mcp.token;
    // Clear any inherited value: only planning turns may mount reference repositories.
    delete env.AGENT_HUB_CODEX_REFERENCE_DIRS;
    if (referenceDirs?.length) env.AGENT_HUB_CODEX_REFERENCE_DIRS = referenceDirs.join(":");
    return new Codex({
      ...(this.image ? { codexPathOverride: WRAPPER } : {}),
      env,
      ...(toolsDisabled ? { config: { mcp_servers: {}, features: { shell_tool: false, apply_patch_freeform: false }, web_search: "disabled" } } : mcp ? { config: { mcp_servers: { agenthub: { url: mcp.url, bearer_token_env_var: "AGENT_HUB_MCP_TOKEN", tool_timeout_sec: MCP_TOOL_TIMEOUT_S } } } } : {}),
    });
  }

  async *run(input: AgentRunInput): AsyncIterable<AgentEvent> {
    if (this.image) {
      // Fail with a sentence a human can act on, not a CLI stack trace from inside a container.
      if (!isLoggedIn(this.opts.codexHome!)) {
        yield { type: "done", ok: false, error: `Codex runs in a container and is not logged in there yet. Run once on the server: ${loginCommand()}` };
        return;
      }
      const started = Date.now();
      // Task images have already been ensured by the Hub before reaching this turn.
      const { built } = input.image ? { built: false } : await ensureImage(this.image);
      if (built) {
        yield { type: "tool_start", callId: "image", name: "docker build", input: this.image, sideEffect: "none" };
        yield { type: "tool_end", callId: "image", output: `built the Codex image in ${Math.round((Date.now() - started) / 1000)}s (first use only)`, isError: false };
      }
    }
    const threadOptions: ThreadOptions = {
      model: input.model ?? this.opts.model,
      modelReasoningEffort: input.effort,
      workingDirectory: input.cwd,
      skipGitRepoCheck: true,
      // In docker, the wrapper turns this into a read-only or read-write mount of the task directory.
      sandboxMode: input.readOnly ? "read-only" : "workspace-write",
      approvalPolicy: "never",
    };
    const codex = this.client(input.toolsDisabled ? undefined : input.mcp, input.referenceDirs, input.toolsDisabled, input.image);
    const thread = input.threadId ? codex.resumeThread(input.threadId, threadOptions) : codex.startThread(threadOptions);
    // The fixed instructions ride once, at the head of the thread; a resumed turn repeats only the live context.
    const head = [input.threadId ? undefined : input.systemPrompt, input.turnContext].filter(Boolean).join("\n\n");
    const prompt = head ? `${head}\n\n---\n\n${input.prompt}` : input.prompt;

    // Codex reads pictures from disk (--image); in docker the wrapper mounts their folder read-only.
    const turnInput = input.images?.length ? [{ type: "text" as const, text: prompt }, ...input.images.map((i) => ({ type: "local_image" as const, path: i.path }))] : prompt;
    const run = runSignal(input.signal);
    try {
      const { events } = await thread.runStreamed(turnInput, { signal: run.signal, ...(input.outputSchema !== undefined ? { outputSchema: input.outputSchema } : {}) });
      const texts = new Map<string, string>(); // agent_message id -> text emitted so far
      const started = new Set<string>(); // tool-like items already announced
      let finalText: string | undefined;
      let observedThread: string | null = null;
      let threadConflict = false;

      for await (const ev of events) {
        if (ev.type === "thread.started") {
          const id = ev.thread_id;
          if (typeof id !== "string" || !id.trim().length || id.length > 200) {
            threadConflict = true;
            continue;
          }
          // Hub persists every yielded thread ID on the Session. Keep the first accepted ID
          // and stop forwarding thread events after any conflict in this SDK execution.
          if (threadConflict || (observedThread !== null && observedThread !== id) || (input.threadId && input.threadId !== id)) {
            threadConflict = true;
            continue;
          }
          observedThread = id;
          yield { type: "thread", threadId: ev.thread_id };
        } else if (ev.type === "item.started" || ev.type === "item.updated" || ev.type === "item.completed") {
          if (ev.type === "item.completed" && ev.item.type === "agent_message") finalText = ev.item.text;
          yield* this.item(ev.item, ev.type === "item.completed", texts, started);
        } else if (ev.type === "turn.completed") {
          let structured: { ok: boolean; output?: unknown; error?: string } = { ok: true };
          if (input.outputSchema !== undefined) {
            try {
              if (!finalText) throw new Error("missing final agent message");
              structured = { ok: true, output: JSON.parse(finalText) as unknown };
            } catch (err) {
              structured = { ok: false, error: `output did not match the requested schema: ${err instanceof Error ? err.message : String(err)}` };
            }
          }
          yield { type: "done", ...structured, usage: codexUsage(ev.usage, this.usageProducer.runtimeVersion, {
            mode: input.threadId ? "resume" : "start", id: observedThread,
            binding: threadConflict ? "conflict" : observedThread ? "matched" : "missing",
          }) };
        } else if (ev.type === "turn.failed") {
          yield { type: "done", ok: false, error: ev.error.message };
        } else if (ev.type === "error") {
          yield { type: "done", ok: false, error: ev.message };
        }
      }
    } finally {
      run.release();
    }
  }

  private *item(item: ThreadItem, completed: boolean, texts: Map<string, string>, started: Set<string>): Iterable<AgentEvent> {
    switch (item.type) {
      case "agent_message": {
        const prev = texts.get(item.id);
        if (prev === undefined) yield { type: "text_start" };
        const before = prev ?? "";
        // Updates carry the whole text so far; emit only what is new.
        const delta = item.text.startsWith(before) ? item.text.slice(before.length) : item.text;
        if (delta) yield { type: "text_delta", text: delta };
        texts.set(item.id, item.text);
        break;
      }
      case "command_execution": {
        const command = unwrapShell(item.command);
        if (!started.has(item.id)) {
          started.add(item.id);
          yield { type: "tool_start", callId: item.id, name: "shell", input: command, sideEffect: classify("Bash", { command }) };
        }
        if (completed) yield { type: "tool_end", callId: item.id, output: clip(item.aggregated_output), isError: item.status === "failed" || (item.exit_code ?? 0) !== 0 };
        break;
      }
      case "file_change": {
        if (!completed) break;
        const summary = item.changes.map((c) => `${c.kind} ${c.path}`).join(", ");
        yield { type: "tool_start", callId: item.id, name: "apply_patch", input: summary, sideEffect: "none" };
        yield { type: "tool_end", callId: item.id, output: item.status, isError: item.status === "failed" };
        break;
      }
      case "mcp_tool_call": {
        if (!started.has(item.id)) {
          started.add(item.id);
          const a = (item.arguments ?? {}) as { host?: unknown; command?: unknown; source?: unknown; destination?: unknown };
          const shown =
            typeof a.host === "string" && typeof a.command === "string"
              ? `${a.host}: ${a.command}`
              : typeof a.source === "string" && typeof a.destination === "string"
                ? `${a.source} -> ${a.destination}`
                : JSON.stringify(item.arguments);
          const remote = item.tool.endsWith("ssh_exec") || item.tool.endsWith("copy_file");
          yield { type: "tool_start", callId: item.id, name: item.tool, input: shown, sideEffect: remote ? "ssh" : "none" };
        }
        if (completed) {
          const text = item.result?.content?.map((c) => ("text" in c ? c.text : `[${c.type}]`)).join("\n");
          yield { type: "tool_end", callId: item.id, output: item.error?.message ?? clip(text || "completed"), isError: item.status === "failed" };
        }
        break;
      }
      case "web_search": {
        if (!completed) break;
        yield { type: "tool_start", callId: item.id, name: "web_search", input: item.query, sideEffect: "none" };
        yield { type: "tool_end", callId: item.id, output: "", isError: false };
        break;
      }
      // reasoning summaries and the todo list stay out of the transcript; errors end the turn via turn.failed
      default:
        break;
    }
  }
}

/** Codex runs commands as `bash -lc '<cmd>'`; show and classify the command itself. */
export function unwrapShell(command: string): string {
  const m = command.match(/^(?:\/\S*\/)?(?:bash|sh|zsh)\s+-l?c\s+(['"])([\s\S]*)\1$/);
  return m ? m[2]! : command;
}

function clip(s: string, max = 8_000): string {
  return s.length > max ? `${s.slice(0, max)}\n… (${s.length - max} more characters)` : s;
}

interface CodexModel {
  slug: string;
  display_name?: string;
  description?: string;
  visibility?: string;
  default_reasoning_level?: string;
  supported_reasoning_levels?: (string | { effort: string })[];
}

const isEffort = (e: string): e is EffortLevel => (EFFORT_LEVELS as readonly string[]).includes(e);

/**
 * A signal for one Codex run that stops following the caller's signal once the run ends. When a turn
 * ends, the SDK calls removeAllListeners() on its child process, which also drops the hook Node uses
 * to detach the abort signal from that child. If the caller aborts its controller afterwards (the Hub
 * does after a failed briefing), Node kills the finished child and emits an "error" nobody listens
 * to, which crashed the whole server.
 */
export function runSignal(parent?: AbortSignal): { signal: AbortSignal; release: () => void } {
  const ac = new AbortController();
  if (!parent) return { signal: ac.signal, release: () => {} };
  if (parent.aborted) {
    ac.abort(parent.reason);
    return { signal: ac.signal, release: () => {} };
  }
  const forward = () => ac.abort(parent.reason);
  parent.addEventListener("abort", forward, { once: true });
  return { signal: ac.signal, release: () => parent.removeEventListener("abort", forward) };
}
