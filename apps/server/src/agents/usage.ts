import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { TOKEN_FIELDS, type TokenCounters, type UsageModel, type UsageObservation } from "@agent-hub/shared";

const require = createRequire(import.meta.url);
export const emptyCounters = (): TokenCounters => ({ input: null, output: null, cachedInput: null, cacheWriteInput: null, reasoningOutput: null });
export const counter = (n: unknown): number | null => typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : null;
export const dollars = (n: unknown): number | null => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= Number.MAX_SAFE_INTEGER ? n : null;
const text = (s: unknown): string | null => typeof s === "string" && s.length > 0 && s.length <= 200 ? s : null;
const object = (x: unknown): Record<string, unknown> => x !== null && typeof x === "object" ? x as Record<string, unknown> : {};
export function packageVersion(name: string, field = "version"): string | null {
  try {
    for (const directory of require.resolve.paths(name) ?? []) {
      const file = path.join(directory, name, "package.json");
      if (fs.existsSync(file)) {
        const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
        if (pkg.name === name) return text(pkg[field]);
      }
    }
  } catch { /* Unresolved producers remain explicitly unknown. */ }
  return null;
}
export function claudeUsage(raw: unknown): UsageObservation {
  const r = object(raw), entries = Object.entries(object(r.modelUsage));
  const models: UsageModel[] = entries.slice(0, 16).map(([model, raw]) => {
    const m = object(raw);
    return { model: text(model), canonicalModel: text(m.canonicalModel), provider: text(m.provider), counters: {
      input: counter(m.inputTokens), output: counter(m.outputTokens), cachedInput: counter(m.cacheReadInputTokens),
      cacheWriteInput: counter(m.cacheCreationInputTokens), reasoningOutput: counter(m.thinkingTokens),
    } };
  });
  const main = object(r.usage);
  return { source: "claude.result.modelUsage", version: packageVersion("@anthropic-ai/claude-agent-sdk") ?? "unknown",
    runtimeVersion: packageVersion("@anthropic-ai/claude-agent-sdk", "claudeCodeVersion"), scope: packageVersion("@anthropic-ai/claude-agent-sdk") === "0.3.296" ? "session_cumulative" : "unknown", precision: "reported",
    coverage: "query_pipeline_excluding_helpers", inputSemantics: "fresh_separate_cache_buckets", reasoningSemantics: "included_in_output_partial",
    threadId: text(r.session_id), resultId: text(r.uuid), models, truncated: entries.length > 16,
    costUsd: dollars(r.total_cost_usd), costPrecision: dollars(r.total_cost_usd) === null ? "unknown" : "estimated",
    mainLoop: { input: counter(main.input_tokens), output: counter(main.output_tokens), cachedInput: counter(main.cache_read_input_tokens),
      cacheWriteInput: counter(main.cache_creation_input_tokens), reasoningOutput: null } };
}
/** The CLI emits a thread total, but its SDK cannot prove a counter origin/epoch or exclusive writes. */
export function codexUsage(raw: unknown, runtimeVersion: string | null,
  thread: { mode: "start" | "resume"; id: string | null; binding: "matched" | "missing" | "conflict" } | null = null): UsageObservation {
  const u = object(raw);
  return { source: "codex.turn.completed.usage", version: packageVersion("@openai/codex-sdk") ?? "unknown", runtimeVersion,
    scope: "unknown", precision: "reported", coverage: "producer_reported_unknown", inputSemantics: "unknown", reasoningSemantics: "unknown",
    threadId: thread?.binding === "matched" ? text(thread.id) : null, resultId: null, truncated: false, costUsd: null, costPrecision: "unknown", mainLoop: null,
    models: [], threadAggregate: { model: null, counters: { input: counter(u.input_tokens), output: counter(u.output_tokens),
      cachedInput: counter(u.cached_input_tokens), cacheWriteInput: counter(u.cache_write_input_tokens), reasoningOutput: counter(u.reasoning_output_tokens) } },
    codex: { threadMode: thread?.mode ?? "unknown", threadBinding: thread?.binding ?? "missing", runtimeVerification: "unverified" } };
}
export function sumCounters(models: UsageModel[]): TokenCounters {
  const counters = emptyCounters();
  for (const field of TOKEN_FIELDS) {
    const values = models.map(m => m.counters[field]);
    if (values.length && values.every(v => v !== null)) counters[field] = counter(values.reduce<number>((a, v) => a + v!, 0));
  }
  return counters;
}
