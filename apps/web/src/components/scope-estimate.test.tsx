import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { scopeExceeded, validateScopeEstimate } from "@agent-hub/shared";
import { ScopeEstimate, estimateInput } from "./scope-estimate";

it("preserves partial estimates and distinguishes explicit clearing from inherited omissions", () => {
  expect(estimateInput("", "")).toBeNull();
  expect(estimateInput("3", "")).toEqual({ maxFiles: 3 });
  expect(estimateInput("", "20")).toEqual({ maxChangedLines: 20 });
  expect(validateScopeEstimate(undefined)).toBeUndefined();
  expect(validateScopeEstimate(null)).toBeUndefined();
  for (const value of [0, -1, 1.1, Number.MAX_SAFE_INTEGER + 1, "2", [], { maxFiles: 0 }, { maxFiles: null }, { extra: 2 }]) expect(() => validateScopeEstimate(value)).toThrow();
  for (const value of ["0", "-1", "1.5", "1e3", "9007199254740992"]) expect(() => estimateInput(value, "")).toThrow();
});
it("uses cumulative additions plus deletions, permits equality and clears warnings", () => {
  const estimate = { maxFiles: 2, maxChangedLines: 10 };
  expect(scopeExceeded(estimate, { filesChanged: 2, additions: 5, deletions: 5 })).toBe(false);
  expect(scopeExceeded(estimate, { filesChanged: 2, additions: 6, deletions: 5 })).toBe(true);
  expect(scopeExceeded(estimate, { filesChanged: 3, additions: 0, deletions: 0 })).toBe(true);
  expect(scopeExceeded(undefined, { filesChanged: 999, additions: 999, deletions: 999 })).toBe(false);
  expect(scopeExceeded(JSON.parse(JSON.stringify(estimate)), { filesChanged: 1, additions: 1, deletions: 0 })).toBe(false);
});
it("renders one responsive presentation for snapshots, reports and both screen sizes", () => {
  const html = renderToStaticMarkup(<ScopeEstimate estimate={{ maxFiles: 1, maxChangedLines: 3 }} filesChanged={2} additions={2} deletions={2} binaryFiles={1} />);
  expect(html).toContain('role="status"'); expect(html).not.toContain("hidden");
  expect(html).toMatch(/2/); expect(html).toMatch(/4/); expect(html).toMatch(/1/);
  const within = renderToStaticMarkup(<ScopeEstimate estimate={{ maxFiles: 2 }} filesChanged={2} additions={2} deletions={2} />);
  expect(within).not.toContain('role="status"');
});
