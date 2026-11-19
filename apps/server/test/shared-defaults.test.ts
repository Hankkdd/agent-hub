import { describe, expect, it } from "vitest";
import { defaultAgent, defaultEffort, defaultModel } from "@agent-hub/shared";

describe("shared workflow defaults", () => {
  it.each(["implement", "review"] as const)("uses Codex medium and Claude sonnet medium for %s", (workflow) => {
    for (const role of ["main", "author"] as const) {
      expect([defaultAgent(workflow, role), defaultEffort(workflow, role), defaultModel(workflow, role)]).toEqual(["codex", "medium", undefined]);
    }
    expect([defaultAgent(workflow, "reviewer"), defaultEffort(workflow, "reviewer"), defaultModel(workflow, "reviewer")]).toEqual(["claude", "medium", "sonnet"]);
  });
  it.each([['chat', 'low'], ['plan', 'medium'], ['video', 'medium']] as const)("keeps %s defaults", (workflow, effort) => {
    expect([defaultAgent(workflow), defaultEffort(workflow), defaultModel(workflow)]).toEqual(["codex", effort, undefined]);
  });
  it.each(["chat", "plan", "implement", "review", "video", "custom"] as const)("keeps the %s explainer defaults", (workflow) => {
    expect([defaultAgent(workflow, "explainer"), defaultEffort(workflow, "explainer"), defaultModel(workflow, "explainer")]).toEqual(["codex", "low", undefined]);
  });
});
