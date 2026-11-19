import { expect, it } from "vitest";
import { issueRelationship, managedIssueBlock, updateManagedIssue } from "@agent-hub/shared";

it("keeps legacy missing modes distinct from new partial and ignores human reference prose", () => {
  const issue = { number: 7, url: "https://github.com/example/project/issues/7" };
  expect(issueRelationship({ issue })).toBe("Closes #7");
  expect(issueRelationship({ issue, issueCompletion: "partial" })).toBe("Refs #7");
  expect(issueRelationship({ issue, issueCompletion: "complete" })).toBe("Closes #7");
  expect(issueRelationship({ issue: null, issueCompletion: "complete" })).toBeUndefined();
  const human = "Closes #7\nRefs #8\n\n  Exact formatting.\n";
  const partial = managedIssueBlock({ issue, issueCompletion: "partial" })!;
  const complete = managedIssueBlock({ issue, issueCompletion: "complete" })!;
  expect(updateManagedIssue(human + partial, partial, complete)).toBe(human + complete);
  expect(updateManagedIssue(human + complete, complete, undefined)).toBe(human);
  expect(updateManagedIssue(human + partial, partial, partial)).toBe(human + partial);
  expect(() => updateManagedIssue(human + partial + partial, partial, complete)).toThrow(/managed issue relationship was edited/);
  expect(() => updateManagedIssue(human + partial.replace("Refs #7", "Refs #8"), partial, undefined)).toThrow(/managed issue relationship was edited/);
});

it("replaces only the precise legacy host suffix even when human prose has an identical paragraph", () => {
  const suffix = "\n\nCloses #7";
  const human = "Purpose\n\nCloses #7\n\nHuman explanation with trailing spaces.  ";
  const next = managedIssueBlock({ issue: { number: 7, url: "" }, issueCompletion: "partial" });
  expect(updateManagedIssue(human + suffix, suffix, suffix)).toBe(human + suffix);
  expect(updateManagedIssue(human + suffix, suffix, next)).toBe(human + next);
  expect(updateManagedIssue(human + suffix, suffix, undefined)).toBe(human);
});


it("rejects a human-edited legacy managed line when detaching instead of keeping a hidden close", () => {
  expect(() => updateManagedIssue("Human prose\n\nCloses #55", "\n\nCloses #7", undefined))
    .toThrow(/managed issue relationship was edited/);
});
