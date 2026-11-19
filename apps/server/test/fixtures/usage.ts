import type { UsageObservation } from "@agent-hub/shared";
// Contract fixture, not a capture of private prompts or a claim of live-provider verification.
// Claude 0.3.296 sdk.d.ts: ModelUsage and SDKResultMessage modelUsage/total_cost_usd comments.
// Codex 0.162.1 dist/index.d.ts: Usage. Resume/aggregation implementation is unverified.
export const claudeResult = (input = 100, overrides: Record<string, unknown> = {}) => ({
  type: "result", subtype: "success", is_error: false, result: "ok", session_id: "sdk-session", uuid: `result-${input}`,
  total_cost_usd: input / 1000, duration_ms: 1, num_turns: 1,
  usage: { input_tokens: input, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40 },
  modelUsage: {
    "reported-model": { inputTokens: input, outputTokens: 20, cacheReadInputTokens: 30, cacheCreationInputTokens: 40,
      thinkingTokens: 5, costUSD: input / 1000, canonicalModel: "canonical-model", provider: "firstParty" },
  }, ...overrides,
});
export const codexResult = { input_tokens: 100, cached_input_tokens: 30, output_tokens: 20 };

// Synthetic thread snapshots for Experiment 002-B, never captured provider traffic. The pinned
// rust-v0.162.1 exec/src/event_processor_with_jsonl_output.rs:118-128 copies ThreadTokenUsage.total
// into turn.completed.usage; its SDK event has no result ID or reported model. These fixtures do
// not grant that producer a trusted scope in Hub. Cache and reasoning are input/output subsets.
export const codexCumulativeReadings = {
  first: { input_tokens: 100, cached_input_tokens: 30, cache_write_input_tokens: 10, output_tokens: 20, reasoning_output_tokens: 5 },
  resumed: { input_tokens: 160, cached_input_tokens: 50, cache_write_input_tokens: 15, output_tokens: 32, reasoning_output_tokens: 8 },
  afterGap: { input_tokens: 200, cached_input_tokens: 70, cache_write_input_tokens: 20, output_tokens: 40, reasoning_output_tokens: 10 },
  reset: { input_tokens: 30, cached_input_tokens: 6, cache_write_input_tokens: 2, output_tokens: 8, reasoning_output_tokens: 1 },
  // The CLI also emits these zeros when it never received a usage update: not a proven zero bill.
  defaultZero: { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 },
} as const;

export const fakeUsage: UsageObservation = {
  source: "fake", version: "fixture", runtimeVersion: "fixture", scope: "call", precision: "reported", coverage: "fixture",
  inputSemantics: "inclusive_cache_subset", reasoningSemantics: "unknown", threadId: null, resultId: null, truncated: false,
  costUsd: 0, costPrecision: "reported", mainLoop: null,
  models: [{ model: "fixture-model", canonicalModel: null, provider: null, counters: { input: 10, output: 2, cachedInput: 4, cacheWriteInput: 0, reasoningOutput: 1 } }],
};
