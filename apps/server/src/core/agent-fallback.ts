import type { AgentKind, ProviderQuota, QuotaResponse } from "@agent-hub/shared";
import { classifyAgentError, limitResetsAt } from "../agents/errors";

export type AgentLimit = { agent: AgentKind; resetsAt: string | null };
export type AgentChoice = { agent: AgentKind; fallbackFrom?: AgentLimit };
export interface FallbackDeps {
  quota(force?: boolean): Promise<QuotaResponse | undefined>;
}

export function exhausted(quota: ProviderQuota | undefined, now: number): { resetsAt: string } | null {
  const resetsAt = limitResetsAt(quota, null, now);
  return resetsAt ? { resetsAt } : null;
}

/** True while any window is empty and has not reached its reset, including windows with an unknown reset. */
export function stillLimited(quota: ProviderQuota | undefined, now: number): boolean {
  return !!quota?.windows.some((w) => w.remainingPercent !== null && w.remainingPercent <= 0 && (w.resetsAt === null || Date.parse(w.resetsAt) > now));
}

export function configuredAgents(agents: Partial<Record<AgentKind, unknown>>): AgentKind[] {
  // General auxiliary generation and quota fallback exclude Gemini. Diff explanations opt in separately.
  return (["claude", "codex"] as const).filter((agent) => !!agents[agent]);
}

export function otherAgent(agent: AgentKind): AgentKind {
  if (agent === "gemini") throw new Error("Gemini supports chat only; quota fallback is unavailable");
  return agent === "claude" ? "codex" : "claude";
}

export function chooseAgent(primary: AgentKind, available: AgentKind[], quotas: QuotaResponse | undefined, now: number): AgentChoice {
  if (primary === "gemini") throw new Error("Gemini supports chat only; auxiliary generation is unavailable");
  const limit = exhausted(quotas?.[primary], now);
  const other = otherAgent(primary);
  return limit && available.includes(other) && !exhausted(quotas?.[other], now)
    ? { agent: other, fallbackFrom: { agent: primary, resetsAt: limit.resetsAt } }
    : { agent: primary };
}

export class AuxiliaryUsageLimit extends Error {
  constructor(message: string, readonly limit: AgentLimit, readonly otherUnavailable: boolean) {
    super(message);
  }
}

type FallbackPurpose = "auxiliary" | "explanations";

function fallbackCandidates(agent: AgentKind, purpose: FallbackPurpose): AgentKind[] {
  return purpose === "explanations" && agent === "gemini" ? ["codex", "claude"] : [otherAgent(agent)];
}

/** Each action shares one quota snapshot and at most one forced refresh, including its retry. */
export async function withAgentFallback<T>(
  primary: AgentKind, available: AgentKind[], deps: FallbackDeps, signal: AbortSignal,
  run: (choice: AgentChoice) => Promise<T>,
  purpose: FallbackPurpose = "auxiliary",
): Promise<{ value: T } & AgentChoice> {
  let quotas = await deps.quota().catch(() => undefined);
  let choice: AgentChoice = purpose === "explanations" && primary === "gemini"
    ? { agent: primary } : chooseAgent(primary, available, quotas, Date.now());
  let refreshed = false;
  for (;;) {
    if (signal.aborted) throw new Error("Generation interrupted");
    try { return { value: await run(choice), ...choice }; }
    catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const parsed = classifyAgentError(message);
      if (signal.aborted || (err instanceof Error && ["AbortError", "TimeoutError"].includes(err.name)) || /\b(?:timed out|timeout|interrupted|aborted)\b/i.test(message) || parsed.kind !== "usage_limit") throw err;
      if (!refreshed) {
        refreshed = true;
        quotas = await deps.quota(true).catch(() => undefined);
      }
      if (signal.aborted) throw err;
      const limit = { agent: choice.agent, resetsAt: limitResetsAt(quotas?.[choice.agent], parsed.resetsAt) };
      const candidates = fallbackCandidates(choice.agent, purpose);
      const other = candidates.find(agent => available.includes(agent) && !(purpose === "explanations"
        ? stillLimited(quotas?.[agent], Date.now()) : exhausted(quotas?.[agent], Date.now())));
      if (choice.fallbackFrom || !other) {
        throw new AuxiliaryUsageLimit(message, limit, !candidates.some(agent => available.includes(agent)));
      }
      choice = { agent: other, fallbackFrom: limit };
    }
  }
}
