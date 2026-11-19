import { claudeUsage, packageVersion } from "./usage";
import { claudeQuota } from "./claude-quota";
import fs from "node:fs";
import { query, type Options, type PermissionMode, type SDKUserMessage, type SettingSource } from "@anthropic-ai/claude-agent-sdk";
import { EFFORT_LEVELS, type EffortLevel, type ModelChoice, type SideEffect } from "@agent-hub/shared";

const isEffort = (e: string): e is EffortLevel => (EFFORT_LEVELS as readonly string[]).includes(e);
import type { AgentAdapter, AgentEvent, AgentRunInput } from "./types";
import { ensureImage, imageTag } from "./codex-docker";
import { carryOverSession, isLoggedIn, loginCommand, spawnInDocker, type ContainerConfig } from "./claude-docker";

export interface ClaudeAdapterOptions {
  model?: string;
  permissionMode: PermissionMode;
  /** Which Claude Code settings files apply (CLAUDE.md, MCP servers, hooks). */
  settingSources: SettingSource[];
  /** "docker" runs each turn in a container (claude-docker.ts); "host" runs Claude Code directly. */
  runtime?: "docker" | "host";
  /** The container's own Claude login and conversations; required for the docker runtime. */
  claudeHome?: string;
  /** Package caches shared across turns, as for Codex. */
  cacheDir?: string;
}

/**
 * Claude via the Agent SDK, which drives the Claude Code CLI and therefore uses its login. Claude
 * Code's own tools (Bash, Read, Edit, ...) do the work; this adapter only translates its stream.
 */
export class ClaudeAdapter implements AgentAdapter {
  readonly kind = "claude";
  readonly usageProducer = { source: "claude.result.modelUsage", version: packageVersion("@anthropic-ai/claude-agent-sdk"), runtimeVersion: packageVersion("@anthropic-ai/claude-agent-sdk", "claudeCodeVersion") };
  // On the host, repos.json toolchains must be installed there by the operator; in docker the Hub
  // builds the same toolchain image Codex uses.
  readonly runtime: "docker" | "host";
  /** Claude reuses the Codex image: same tools for both agents, and Claude Code itself is mounted in. */
  private readonly image: string | null;
  constructor(private readonly opts: ClaudeAdapterOptions) {
    this.runtime = opts.runtime ?? "host";
    if (this.runtime === "docker" && !opts.claudeHome) throw new Error("claudeHome is required for the docker runtime");
    this.image = this.runtime === "docker" ? imageTag() : null;
  }

  private container(image?: string): ContainerConfig | null {
    return this.image ? { image: image ?? this.image, claudeHome: this.opts.claudeHome!, cacheDir: this.opts.cacheDir } : null;
  }

  /** Control-only queries (models, quota) read the same login the turns use. */
  private spawnOption(): Pick<Options, "spawnClaudeCodeProcess"> {
    const container = this.container();
    return container ? { spawnClaudeCodeProcess: spawnInDocker(container) } : {};
  }

  get defaultModel() { return this.opts.model; }

  async queryQuota(signal: AbortSignal) {
    if (this.image) {
      if (!isLoggedIn(this.opts.claudeHome!)) return { status: "missing_login" as const, windows: [] };
      await ensureImage(this.image);
    }
    return claudeQuota(signal, this.container());
  }

  /**
   * Asked of Claude Code itself: a query that is created but never iterated (so no prompt runs) can
   * still answer supportedModels(), and is then aborted.
   */
  async listModels(): Promise<ModelChoice[]> {
    if (this.image) {
      if (!isLoggedIn(this.opts.claudeHome!)) return [];
      await ensureImage(this.image);
    }
    const ac = new AbortController();
    const q = query({ prompt: "", options: { tools: [], settingSources: [], permissionMode: "dontAsk", abortController: ac, ...this.spawnOption() } });
    try {
      const models = await q.supportedModels();
      return models.map((m) => ({
        id: m.value,
        label: m.displayName,
        description: m.description,
        effortLevels: m.supportsEffort === false ? undefined : (m.supportedEffortLevels?.filter(isEffort) ?? undefined),
      }));
    } finally {
      ac.abort();
    }
  }

  async *run(input: AgentRunInput): AsyncIterable<AgentEvent> {
    const container = this.container(input.image);
    if (container) {
      // Fail with a sentence a human can act on, not a CLI error from inside a container.
      if (!isLoggedIn(container.claudeHome)) {
        yield { type: "done", ok: false, error: `Claude runs in a container and is not logged in there yet. Run once on the server: ${loginCommand()}` };
        return;
      }
      const started = Date.now();
      // Task images have already been ensured by the Hub before reaching this turn.
      const { built } = input.image ? { built: false } : await ensureImage(container.image);
      if (built) {
        yield { type: "tool_start", callId: "image", name: "docker build", input: container.image, sideEffect: "none" };
        yield { type: "tool_end", callId: "image", output: `built the agent image in ${Math.round((Date.now() - started) / 1000)}s (first use only)`, isError: false };
      }
      carryOverSession(input.threadId, container.claudeHome);
    }
    const abortController = new AbortController();
    const onAbort = () => abortController.abort();
    input.signal.addEventListener("abort", onAbort, { once: true });

    const options: Options = {
      ...(input.outputSchema !== undefined ? { outputFormat: { type: "json_schema" as const, schema: input.outputSchema } } : {}),
      cwd: input.cwd,
      additionalDirectories: input.referenceDirs,
      resume: input.threadId,
      model: input.model ?? this.opts.model,
      effort: input.effort,
      abortController,
      includePartialMessages: true,
      permissionMode: this.opts.permissionMode,
      allowDangerouslySkipPermissions: this.opts.permissionMode === "bypassPermissions",
      settingSources: this.opts.settingSources,
      disallowedTools: input.readOnly ? ["Edit", "Write", "MultiEdit", "NotebookEdit"] : undefined,
      // In a container, a read-only turn also gets a read-only mount, so Bash cannot write either.
      ...(container ? { spawnClaudeCodeProcess: spawnInDocker(container, { readOnly: input.readOnly, referenceDirs: input.referenceDirs }) } : {}),
      ...(input.mcp
        ? {
            mcpServers: { agenthub: { type: "http" as const, url: input.mcp.url, headers: { Authorization: `Bearer ${input.mcp.token}` } } },
            // The user chose ssh without confirmations (design.md §7.3): these never go to the classifier.
            allowedTools: ["mcp__agenthub__suggest_document_edit", "mcp__agenthub__record_finding", "mcp__agenthub__list_findings", "mcp__agenthub__list_hosts", "mcp__agenthub__ssh_exec", "mcp__agenthub__copy_file", "mcp__agenthub__e3_list_assignments", "mcp__agenthub__e3_list_courses", "mcp__agenthub__e3_list_materials", "mcp__agenthub__e3_download_material", "mcp__agenthub__propose_task", "mcp__agenthub__start_task", "mcp__agenthub__open_pr", "mcp__agenthub__update_pr", "mcp__agenthub__abandon_pr_update", "mcp__agenthub__list_issues", "mcp__agenthub__read_issue", "mcp__agenthub__list_project_docs", "mcp__agenthub__search_project_docs", "mcp__agenthub__read_project_doc", "mcp__agenthub__ask", "mcp__agenthub__message_task"],
          }
        : {}),
      systemPrompt: { type: "preset", preset: "claude_code", append: [input.systemPrompt, input.turnContext].filter(Boolean).join("\n\n") || undefined },
      // In `auto` mode a classifier decides each call and only asks here when it cannot. Without this
      // hook, those calls would just be denied and the agent left stuck with no one told why.
      canUseTool: input.askPermission
        ? async (toolName, toolInput, { signal, decisionReason }) => {
            const d = await input.askPermission!({ toolName, input: summarizeInput(toolName, toolInput), reason: decisionReason, signal });
            return d.allow ? { behavior: "allow", updatedInput: toolInput } : { behavior: "deny", message: d.message ?? "The user denied this tool call." };
          }
        : undefined,
      ...(input.toolsDisabled ? {
        tools: [], mcpServers: {}, strictMcpConfig: true, settingSources: [],
        permissionMode: "dontAsk" as const, allowDangerouslySkipPermissions: false,
        canUseTool: async () => ({ behavior: "deny" as const, message: "Tools are disabled for explanations." }),
      } : {}),
    };

    let threadSent = false;
    try {
      for await (const msg of query({ prompt: promptWithImages(input), options })) {
        if (!threadSent && "session_id" in msg && msg.session_id) {
          threadSent = true;
          yield { type: "thread", threadId: msg.session_id };
        }
        // Sub-agent traffic (Claude's Task tool) would interleave with the main thread; leave it out.
        if ("parent_tool_use_id" in msg && msg.parent_tool_use_id) continue;

        if (msg.type === "stream_event") {
          const ev = msg.event;
          if (ev.type === "content_block_start" && ev.content_block.type === "text") yield { type: "text_start" };
          else if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") yield { type: "text_delta", text: ev.delta.text };
        } else if (msg.type === "assistant") {
          // Text already arrived through stream events; complete messages are read for tool calls only.
          for (const block of msg.message.content) {
            if (block.type === "tool_use") {
              yield { type: "tool_start", callId: block.id, name: block.name, input: summarizeInput(block.name, block.input), sideEffect: classify(block.name, block.input) };
            }
          }
        } else if (msg.type === "user") {
          const content = msg.message.content;
          if (typeof content === "string") continue;
          for (const block of content) {
            if (block.type === "tool_result") {
              yield { type: "tool_end", callId: block.tool_use_id, output: resultText(block.content), isError: !!block.is_error };
            }
          }
        } else if (msg.type === "result") {
          if (msg.subtype === "success") {
            const missingOutput = input.outputSchema !== undefined && msg.structured_output === undefined;
            yield { type: "done", ok: !msg.is_error && !missingOutput, error: msg.is_error ? msg.result : missingOutput ? "output did not match the requested schema: missing structured output" : undefined,
              ...(input.outputSchema !== undefined && !msg.is_error && !missingOutput ? { output: msg.structured_output } : {}), costUsd: msg.total_cost_usd, durationMs: msg.duration_ms, numTurns: msg.num_turns, usage: claudeUsage(msg) };
          } else {
            yield { type: "done", ok: false, error: ("errors" in msg && Array.isArray(msg.errors) ? msg.errors.join("; ") : msg.subtype) || msg.subtype, costUsd: msg.total_cost_usd, durationMs: msg.duration_ms, numTurns: msg.num_turns, usage: claudeUsage(msg) };
          }
        }
      }
    } finally {
      input.signal.removeEventListener("abort", onAbort);
    }
  }
}

type Json = Record<string, unknown>;

/**
 * Pictures make the prompt a structured user message (the SDK's streaming-input form) with the image
 * bytes ahead of the text; without pictures it stays a plain string.
 */
function promptWithImages(input: AgentRunInput): string | AsyncIterable<SDKUserMessage> {
  if (!input.images?.length) return input.prompt;
  const content = [
    ...input.images.map((img) => ({
      type: "image" as const,
      source: { type: "base64" as const, media_type: img.mime as "image/png" | "image/jpeg" | "image/gif" | "image/webp", data: fs.readFileSync(img.path).toString("base64") },
    })),
    { type: "text" as const, text: input.prompt },
  ];
  return (async function* () {
    yield { type: "user" as const, message: { role: "user" as const, content }, parent_tool_use_id: null };
  })();
}

/** One line a human can read in the transcript, instead of the raw JSON input. */
export function summarizeInput(name: string, input: unknown): string {
  const i = (input ?? {}) as Json;
  const pick = (k: string) => (typeof i[k] === "string" ? (i[k] as string) : undefined);
  if (pick("host") && pick("command")) return `${pick("host")}: ${pick("command")}`; // ssh_exec
  if (pick("source") && pick("destination")) return `${pick("source")} -> ${pick("destination")}`; // copy_file
  return pick("command") ?? pick("file_path") ?? pick("pattern") ?? pick("url") ?? pick("query") ?? pick("description") ?? JSON.stringify(input);
}

/** design.md §8: which calls may have changed something an interrupted run cannot take back. */
export function classify(name: string, input: unknown): SideEffect {
  if (name === "Bash") {
    const cmd = String((input as Json | undefined)?.command ?? "").trim();
    if (/^git\s+(commit|push|merge|rebase|reset|checkout|switch|tag|cherry-pick|stash|branch\s+-[dD])\b/.test(cmd)) return "git";
    if (/^ssh\b/.test(cmd)) return "ssh";
    return "shell";
  }
  if (name.endsWith("ssh_exec") || name.endsWith("copy_file")) return "ssh";
  return "none";
}

const MAX_OUTPUT = 8_000;

function resultText(content: unknown): string {
  let text: string;
  if (typeof content === "string") text = content;
  else if (Array.isArray(content)) text = content.map((c) => (c && typeof c === "object" && "text" in c ? String(c.text) : `[${(c as Json)?.type ?? "?"}]`)).join("\n");
  else text = "";
  return text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n… (${text.length - MAX_OUTPUT} more characters)` : text;
}
