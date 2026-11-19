import { defaultAgent, defaultEffort, defaultModel, type AgentKind, type EffortLevel, type RepoAgentDefaults, type WorkflowId } from "@agent-hub/shared";

export interface AgentChoice {
  agent: AgentKind;
  effort: EffortLevel;
  model: string;
}

export function defaults(workflow: WorkflowId): { main: AgentChoice; reviewer: AgentChoice } {
  const choice = (role: "main" | "author" | "reviewer"): AgentChoice => ({
    agent: defaultAgent(workflow, role), effort: defaultEffort(workflow, role), model: defaultModel(workflow, role) ?? "",
  });
  return { main: choice(workflow === "review" ? "author" : "main"), reviewer: choice("reviewer") };
}

export function repositoryChoice(current: AgentChoice, edited: boolean, baseline: AgentChoice, override?: RepoAgentDefaults): AgentChoice {
  if (edited) return current;
  // Model names belong to their agent; an agent override cannot inherit another agent's model.
  const model = override?.agent && override.agent !== baseline.agent ? "" : baseline.model;
  return { ...baseline, model, ...override };
}

/** Gemini is chat-only and absent unless its adapter is connected. */
export function taskAgents(workflow: WorkflowId, geminiAvailable: boolean): AgentKind[] {
  return ["claude", "codex", ...(workflow === "chat" && geminiAvailable ? ["gemini" as const] : [])];
}
