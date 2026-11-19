import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { AppliedRule } from "@agent-hub/shared";

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Settings reads validate operator configuration without depending on mutable pack files. */
export function validateRuleSettings(repository: string, rules: unknown): asserts rules is Record<string, Record<string, string>> {
  const fail = (tag: string, problem: string): never => { throw new Error(`${repository}: rules ${tag}: ${problem}`); };
  if (!object(rules)) return fail("<tags>", "must be an object");
  for (const [tag, values] of Object.entries(rules)) {
    if (!/^[a-z][a-z0-9-]*$/.test(tag)) fail(tag, "invalid tag name");
    if (!object(values)) return fail(tag, "parameters must be an object");
    for (const [param, value] of Object.entries(values)) {
      if (typeof value !== "string" || !value.trim() || value.length > 500 || /[\r\n\0]/.test(value)) fail(tag, `parameter ${param} must be a nonempty single-line string (at most 500 characters)`);
    }
  }
}

/** Validate and resolve together so the hash and text always describe the same bytes. */
export function resolveRulePacks(dataDir: string, repository: string, rules: unknown): AppliedRule[] {
  const fail = (tag: string, problem: string): never => { throw new Error(`${repository}: rules ${tag}: ${problem}`); };
  validateRuleSettings(repository, rules);
  return Object.entries(rules).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([tag, values]) => {
    let raw: Buffer;
    try { raw = fs.readFileSync(path.join(dataDir, "rules", `${tag}.md`)); }
    catch { return fail(tag, "pack file is missing or unreadable"); }
    const content = raw.toString("utf8").replace(/\r\n/g, "\n");
    const front = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(content);
    if (!front) return fail(tag, "invalid or missing frontmatter");
    const metadata = new Map<string, string>();
    for (const line of front[1]!.split("\n")) {
      if (!line.trim()) continue;
      const field = /^([A-Za-z][A-Za-z0-9-]*):[ \t]*(.*)$/.exec(line);
      if (!field) continue;
      const key = field[1]!;
      if (!["tag", "roles", "params"].includes(key)) continue;
      if (metadata.has(key)) return fail(tag, `duplicate frontmatter ${key}`);
      metadata.set(key, field[2]!.trim());
    }
    if (!metadata.has("tag") || !/^[a-z][a-z0-9-]*$/.test(metadata.get("tag")!)) fail(tag, "invalid or missing frontmatter tag");
    if (metadata.get("tag") !== tag) fail(tag, "frontmatter tag does not match file name");
    const list = (key: string): string[] => {
      const value = metadata.get(key);
      if (!value || !/^\[[^\[\]]*\]$/.test(value)) return fail(tag, `invalid or missing ${key} list`);
      const inside = value.slice(1, -1).trim();
      const items = inside ? inside.split(",").map((s) => s.trim()) : [];
      if (new Set(items).size !== items.length) fail(tag, `duplicate ${key}`);
      return items;
    };
    const params = list("params");
    if (params.some((p) => !/^[A-Za-z][A-Za-z0-9]*$/.test(p))) fail(tag, "invalid params name");
    const roles = list("roles");
    if (!roles.length || roles.some((r) => !["author", "reviewer", "planner"].includes(r))) fail(tag, "invalid roles: expected a non-empty subset of author, reviewer, planner");
    const supplied = values;
    for (const param of params) if (!Object.hasOwn(supplied, param)) fail(tag, `missing parameter ${param}`);
    for (const param of Object.keys(supplied)) {
      if (!params.includes(param)) fail(tag, `undeclared parameter ${param}`);
    }
    const body = content.slice(front[0].length);
    const lines = body.split("\n");
    let title = -1, firstSection = -1, mandatory = false, hasMandatory = false;
    let fence: string | undefined;
    const injected: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
      if (marker && !fence) fence = marker;
      else if (fence && new RegExp(`^ {0,3}${fence[0]}{${fence.length},}\\s*$`).test(line)) fence = undefined;
      else if (!fence) {
        if (title < 0 && /^#\s+/.test(line)) title = i;
        const heading = /^##[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/.exec(line);
        if (heading) {
          if (firstSection < 0) firstSection = i;
          mandatory = ["必守", "Mandatory"].includes(heading[1]!);
          hasMandatory ||= mandatory;
        }
      }
      if (mandatory) injected.push(line);
    }
    const intro = title >= 0 && (firstSection < 0 || title < firstSection) ? lines.slice(title, firstSection < 0 ? undefined : firstSection).join("\n").trim() : "";
    const text = hasMandatory ? [intro, injected.join("\n").trim()].filter(Boolean).join("\n\n") : "";
    return { tag, sha256: createHash("sha256").update(raw).digest("hex"), roles: roles as AppliedRule["roles"],
      text: text.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (token, name: string) => params.includes(name) ? supplied[name] as string : token) };
  });
}
