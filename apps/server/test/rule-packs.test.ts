import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, it } from "vitest";
import { resolveRulePacks } from "../src/core/rule-packs";
import { readRepoSettings } from "../src/core/repo-settings";
import { findingsPrompt, parseReview, rulesPrompt } from "../src/core/prompts";

let dataDir: string;
const repository = "/example/repository";
const pack = "---\ntag: sample\nparams: [docsRoot]\nroles: [author, reviewer, planner]\nsource: invented example\n---\n\n# Sample\n\nIntro {docsRoot} {literal}.\n\n## Mandatory\n\n- **sc-1 Example**: Use {docsRoot}.\n\n## Reference\n\nNever inject this.\n\n## Other\n\nNot mandatory.\n";
function write(content = pack) { fs.writeFileSync(path.join(dataDir, "rules/sample.md"), content); }
function settings(rules: unknown) { fs.writeFileSync(path.join(dataDir, "repos.json"), JSON.stringify({ [repository]: { rules } })); }
beforeEach(() => { dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "hub-rule-packs-")); fs.mkdirSync(path.join(dataDir, "rules")); write(); });
afterEach(() => fs.rmSync(dataDir, { recursive: true, force: true }));

it("resolves declared params once, hashes raw bytes and excludes reference and unrelated sections", () => {
  const [applied] = resolveRulePacks(dataDir, repository, { sample: { docsRoot: "$&{literal}" } });
  expect(applied).toEqual({ tag: "sample", sha256: createHash("sha256").update(pack).digest("hex"), roles: ["author", "reviewer", "planner"], text: "# Sample\n\nIntro $&{literal} {literal}.\n\n## Mandatory\n\n- **sc-1 Example**: Use $&{literal}." });
  write("changed");
  expect(rulesPrompt([applied!], "author")).toContain(applied!.text);
  expect(rulesPrompt([applied!], "reviewer")).toContain("Process rules");
  expect(rulesPrompt([applied!], "planner")).not.toContain("Process rules");
});

it("sorts packs and filters role-specific and empty packs", () => {
  write(pack.replace("roles: [author, reviewer, planner]", "roles: [planner]"));
  fs.writeFileSync(path.join(dataDir, "rules/empty.md"), "---\ntag: empty\nparams: []\nroles: [author]\n---\n# Empty\nIntro\n## Reference\nBackground");
  const applied = resolveRulePacks(dataDir, repository, { sample: { docsRoot: "/docs" }, empty: {} });
  expect(applied.map(p => p.tag)).toEqual(["empty", "sample"]);
  expect(applied[0]!.text).toBe("");
  expect(rulesPrompt(applied, "author")).toBe("");
  expect(rulesPrompt(applied, "planner")).toContain("# Sample");
  expect(rulesPrompt(undefined, "author")).toBe("");
});

it("supports both heading languages, repeated sections, CRLF, and fenced reference headings", () => {
  write(pack.replace(/\n/g, "\r\n").replace("## Mandatory", "## 必守").replace("## Reference", "## 參考"));
  expect(resolveRulePacks(dataDir, repository, { sample: { docsRoot: "/docs" } })[0]!.text).toContain("## 必守");
  write(pack.replace("## Reference", "```markdown\n## Reference\n```\n## Reference") + "\n## Mandatory\nsc-2 Second\n");
  const text = resolveRulePacks(dataDir, repository, { sample: { docsRoot: "/docs" } })[0]!.text;
  expect(text).toContain("```markdown\n## Reference\n```");
  expect(text).toContain("sc-2 Second");
  expect(text).not.toContain("Never inject");
});

it.each([
  [null, "<tags>", "must be an object"], [[], "<tags>", "must be an object"],
  [{ sample: null }, "sample", "parameters must be an object"], [{ sample: [] }, "sample", "parameters must be an object"],
  [{ "../escape": {} }, "../escape", "invalid tag"],
  ...["", " ", "line\nbreak", "line\rbreak", "null\0byte", "x".repeat(501), 42].map(value => [{ sample: { docsRoot: value } }, "sample", "nonempty single-line"]),
] as [unknown, string, string][])("rejects invalid settings %j with repository and tag", (rules, tag, problem) => {
  settings(rules);
  try { readRepoSettings(dataDir, repository); throw new Error("Unexpected success"); }
  catch (error) { expect(String(error)).toContain(repository); expect(String(error)).toContain(tag); expect(String(error)).toContain(problem); }
});

it.each([
  ["tag: sample\n", ""], ["tag: sample", "tag: Bad"], ["tag: sample", "tag: other"],
  ["params: [docsRoot]", "params: docsRoot"], ["params: [docsRoot]", "params: [bad-name]"],
  ["params: [docsRoot]", "params: [docsRoot, docsRoot]"], ["params: [docsRoot]\n", ""],
  ["roles: [author, reviewer, planner]", "roles: []"], ["roles: [author, reviewer, planner]", "roles: [unknown]"],
  ["roles: [author, reviewer, planner]\n", ""], ["roles: [author, reviewer, planner]", "roles: author"],
  ["---\n", ""], ["tag: sample", "tag: sample\ntag: sample"],
])("rejects invalid frontmatter %s -> %s", (from, to) => {
  write(pack.replace(from, to)); settings({ sample: { docsRoot: "/docs" } });
  expect(readRepoSettings(dataDir, repository)).toEqual({ rules: { sample: { docsRoot: "/docs" } } });
  expect(() => resolveRulePacks(dataDir, repository, { sample: { docsRoot: "/docs" } })).toThrow(/\/example\/repository: rules sample:/);
});

it("rejects unreadable packs and accepts maximum-length values", () => {
  expect(resolveRulePacks(dataDir, repository, { sample: { docsRoot: "x".repeat(500) } })).toHaveLength(1);
  fs.unlinkSync(path.join(dataDir, "rules/sample.md")); fs.mkdirSync(path.join(dataDir, "rules/sample.md"));
  expect(() => resolveRulePacks(dataDir, repository, { sample: {} })).toThrow(/sample: pack file is missing or unreadable/);
});

it("parses optional rule IDs without changing legacy findings and renders them in author feedback", () => {
  const parsed = parseReview("VERDICT: changes\nFINDINGS:\n- [high] [sc-12] src/example.ts:9 - Broken rule\n- [low] old.ts:2 - Old finding\n- [medium] General finding");
  expect(parsed?.findings).toEqual([
    { severity: "high", rule: "sc-12", location: "src/example.ts:9", message: "Broken rule" },
    { severity: "low", location: "old.ts:2", message: "Old finding" },
    { severity: "medium", location: "", message: "General finding" },
  ]);
  expect(findingsPrompt("Reviewer", parsed!.findings, 1)).toContain("- [high] [sc-12] src/example.ts:9 - Broken rule");
  expect(parseReview("VERDICT: changes\n- [low] [BAD-1] a.ts:1 - Invalid ID")?.findings[0]).not.toHaveProperty("rule");
});

it.each([
  [{ missing: {} }, "missing", "pack file is missing or unreadable"],
  [{ sample: {} }, "sample", "missing parameter docsRoot"],
  [{ sample: { docsRoot: "/docs", extra: "value" } }, "sample", "undeclared parameter extra"],
] as [Record<string, Record<string, string>>, string, string][])("defers pack validation until resolution: %j", (rules, tag, problem) => {
  settings(rules);
  expect(readRepoSettings(dataDir, repository)).toEqual({ rules });
  expect(() => resolveRulePacks(dataDir, repository, rules)).toThrow(`${repository}: rules ${tag}: ${problem}`);
});
