import { expect, it } from "vitest";
import { defaults, repositoryChoice } from "./new-task-defaults";

it("prefills implement and proposal review choices from the shared defaults", () => {
  for (const workflow of ["implement", "review"] as const) {
    expect(defaults(workflow)).toEqual({
      main: { agent: "codex", effort: "medium", model: "" },
      reviewer: { agent: "claude", effort: "medium", model: "sonnet" },
    });
  }
});

it("applies repository defaults independently and preserves edited pickers", () => {
  const baseline = defaults("review");
  const override = { agent: "claude", model: "opus", effort: "medium" } as const;
  const custom = { agent: "codex", model: "chosen-model", effort: "high" } as const;
  expect(repositoryChoice(baseline.reviewer, false, baseline.reviewer, override)).toEqual(override);
  expect(repositoryChoice(custom, true, baseline.reviewer, override)).toBe(custom);
  expect(repositoryChoice(custom, true, baseline.main, { effort: "low" })).toBe(custom);
  expect(repositoryChoice(baseline.main, false, baseline.main, { effort: "high" })).toEqual({ ...baseline.main, effort: "high" });
});

it("restores shared defaults for unedited pickers when moving to an unconfigured repository", () => {
  const baseline = defaults("review").reviewer;
  const teamChoice = repositoryChoice(baseline, false, baseline, { model: "opus" });
  expect(repositoryChoice(teamChoice, false, baseline)).toEqual(baseline);
  expect(repositoryChoice(teamChoice, false, baseline, { agent: "codex" })).toEqual({ ...baseline, agent: "codex", model: "" });
});
