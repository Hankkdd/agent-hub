import type { UsageObservation } from "@agent-hub/shared";
import type { EffortLevel, ModelChoice, SideEffect, QuotaReading, HandoffMaterial } from "@agent-hub/shared";

/**
 * design.md §5.1. Everything above this layer is SDK-agnostic: a workflow sees only these events,
 * so swapping or adding a model touches one adapter file.
 */
export interface AgentAdapter {
  kind: string;
  readonly defaultModel?: string;
  readonly usageProducer?: { source: string; version: string | null; runtimeVersion: string | null };
  /** Host adapters require repository toolchains to be installed on the host. */
  readonly runtime?: "docker" | "host";
  queryQuota(signal: AbortSignal): Promise<QuotaReading>;
  run(input: AgentRunInput): AsyncIterable<AgentEvent>;
  /** The models this agent offers right now, asked of the agent itself. */
  listModels?(): Promise<ModelChoice[]>;
}

export interface AgentRunInput {
  outputSchema?: Record<string, unknown>;
  prompt: string;
  /** Bounded persisted dialogue for chat adapters that cannot resume a CLI session. */
  recent?: HandoffMaterial["recent"];
  cwd: string;
  /** Prepared container image for this task; absent uses the adapter default. */
  image?: string;
  /** Resume this conversation; absent starts a new one. */
  threadId?: string;
  systemPrompt?: string;
  /**
   * Live context for every turn, new or resumed (the planner's list of other tasks). Codex has no
   * system-prompt option and keeps systemPrompt in the thread's first message, so only this part is
   * repeated on a resumed thread.
   */
  turnContext?: string;
  signal: AbortSignal;
  /** Pictures for this turn, as files on this machine (Codex reads the path; Claude gets the bytes). */
  images?: { path: string; mime: string }[];
  /** null/undefined: the adapter's configured default. */
  model?: string;
  effort?: EffortLevel;
  /** Agent Hub's own tools (list_hosts, ssh_exec) for this turn: an MCP endpoint and its per-turn token. */
  mcp?: { url: string; token: string };
  /** A reviewer or planner: it may read and run things, but must not edit files. */
  readOnly?: boolean;
  /** Prompt-only explanation: disable tools and inherited MCP/settings. */
  toolsDisabled?: boolean;
  /** Planning only: reference repositories readable alongside the working directory. */
  referenceDirs?: string[];
  /** Ask the user to allow a tool call the agent's own permission check could not decide. */
  askPermission?: (req: PermissionRequest) => Promise<PermissionDecision>;
}

export interface PermissionRequest {
  toolName: string;
  /** One readable line, e.g. the command. */
  input: string;
  reason?: string;
  signal: AbortSignal;
}

export interface PermissionDecision {
  allow: boolean;
  message?: string;
}

export type AgentEvent =
  /** The conversation id. Emitted as early as possible so an interrupted run is still resumable. */
  | { type: "thread"; threadId: string }
  /** A new block of prose starts; following `text_delta`s append to it. */
  | { type: "text_start" }
  | { type: "text_delta"; text: string }
  | { type: "tool_start"; callId: string; name: string; input: string; sideEffect: SideEffect }
  | { type: "tool_end"; callId: string; output: string; isError: boolean }
  | { type: "done"; output?: unknown; ok: boolean; error?: string; costUsd?: number; durationMs?: number; numTurns?: number; usage?: UsageObservation };
