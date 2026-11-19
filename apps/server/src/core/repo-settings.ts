import { validateRuleSettings } from "./rule-packs";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { validateToolchain } from "../docker/toolchain";
import { CHANGE_TYPES, EFFORT_LEVELS, type PrDraft, type RepoSettings } from "@agent-hub/shared";

export function repoPath(value: string): string {
  return path.resolve(value === "~" ? os.homedir() : value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value);
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Read on every request: this file belongs to the operator, outside all repositories. */
export function readRepoSettings(dataDir: string, repository: string): RepoSettings | null {
  const file = path.join(dataDir, "repos.json");
  if (!fs.existsSync(file)) return null;
  try {
    const entries: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!object(entries)) throw new Error("expected an object keyed by absolute repository paths");
    const normalized = new Map<string, RepoSettings>();
    for (const [key, value] of Object.entries(entries)) {
      if (!path.isAbsolute(key) && key !== "~" && !key.startsWith("~/")) throw new Error(`repository path must be absolute: ${key}`);
      if (!object(value)) throw new Error(`${key}: expected a settings object`);
      const allowed = ["base", "ticket", "branch", "commit", "prTitle", "prLanguage", "prTemplate", "testCommand", "toolchain", "agents", "documentsDir", "findings", "rules"];
      for (const name of Object.keys(value)) if (!allowed.includes(name)) throw new Error(`${key}: unknown setting ${name}`);
      for (const name of allowed.filter((name) => name !== "ticket" && name !== "toolchain" && name !== "agents" && name !== "findings" && name !== "rules")) {
        if (value[name] !== undefined && (typeof value[name] !== "string" || !(value[name] as string).trim() || /[\r\n\0]/.test(value[name] as string))) {
          throw new Error(`${key}: ${name} must be a nonempty single-line string`);
        }
      }
      if (value.rules !== undefined) validateRuleSettings(key, value.rules);
      if (value.findings !== undefined) {
        const f = value.findings;
        if (!object(f) || Object.keys(f).some((k) => k !== "owner") || typeof f.owner !== "string" || !f.owner.trim() || f.owner.length > 200 || /[\x00-\x1f\x7f\x85\u2028\u2029]/.test(f.owner)) throw new Error(`${key}: findings.owner must be a nonempty single-line string (at most 200 characters)`);
        f.owner = f.owner.trim();
      }
      if (value.documentsDir !== undefined) {
        const dir = value.documentsDir as string;
        if (!path.isAbsolute(dir) && !dir.startsWith("~/")) throw new Error(`${key}: documentsDir must be an absolute directory or ~/ path`);
        value.documentsDir = repoPath(dir);
      }
      if (value.agents !== undefined) {
        if (!object(value.agents)) throw new Error(`${key}: agents must be an object`);
        for (const [role, defaults] of Object.entries(value.agents)) {
          if (!["author", "reviewer"].includes(role)) throw new Error(`${key}: unknown agents role ${role}`);
          if (!object(defaults)) throw new Error(`${key}: agents.${role} must be an object`);
          if (Object.keys(defaults).some((name) => !["agent", "model", "effort"].includes(name))) throw new Error(`${key}: unknown agents.${role} setting`);
          // Gemini is chat-only, never a repository author or reviewer.
          if (defaults.agent !== undefined && defaults.agent !== "codex" && defaults.agent !== "claude") throw new Error(`${key}: agents.${role}.agent must be codex or claude`);
          if (defaults.effort !== undefined && !EFFORT_LEVELS.includes(defaults.effort as typeof EFFORT_LEVELS[number])) throw new Error(`${key}: agents.${role}.effort must be one of ${EFFORT_LEVELS.join(", ")}`);
          if (defaults.model !== undefined && (typeof defaults.model !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(defaults.model))) throw new Error(`${key}: agents.${role}.model must be 1-128 letters, digits, dots, underscores or hyphens, starting with a letter or digit`);
        }
      }
      if (value.toolchain !== undefined) validateToolchain(value.toolchain);
      if (value.base !== undefined) {
        if (!(value.base as string).startsWith("origin/")) throw new Error(`${key}: base must be an origin/<branch> ref`);
        try { execFileSync("git", ["check-ref-format", `refs/remotes/${value.base}`], { stdio: "ignore" }); }
        catch { throw new Error(`${key}: base must be a valid origin/<branch> ref`); }
      }
      if (value.prLanguage !== undefined && value.prLanguage !== "en" && value.prLanguage !== "zh-TW") throw new Error(`${key}: prLanguage must be en or zh-TW`);
      if (value.prTemplate !== undefined) validateRelativePath(value.prTemplate as string);
      if (value.ticket !== undefined) {
        const ticket = value.ticket;
        if (!object(ticket) || typeof ticket.required !== "boolean" || typeof ticket.pattern !== "string" || !ticket.pattern) throw new Error(`${key}: ticket needs required (boolean) and pattern (regex string)`);
        if (Object.keys(ticket).some((name) => !["required", "pattern", "url"].includes(name))) throw new Error(`${key}: unknown ticket setting`);
        new RegExp(ticket.pattern);
        if (ticket.url !== undefined) {
          if (typeof ticket.url !== "string" || !ticket.url.includes("{ticket}") || /[{}\s\0]/.test(ticket.url.replaceAll("{ticket}", ""))) throw new Error(`${key}: ticket.url must be an http(s) URL with {ticket} as its only placeholder`);
          const url = new URL(ticket.url.replaceAll("{ticket}", "TICKET-1"));
          if (!["https:", "http:"].includes(url.protocol)) throw new Error(`${key}: ticket.url must use http or https`);
        }
      }
      for (const name of ["branch", "commit", "prTitle"]) {
        const template = value[name];
        if (typeof template !== "string") continue;
        for (const token of template.matchAll(/\{([^{}]*)\}/g)) {
          if (!["type", "ticket", "slug", "summary"].includes(token[1]!)) throw new Error(`${key}: unknown placeholder ${token[0]} in ${name}`);
          if (token[1] === "ticket" && !value.ticket) throw new Error(`${key}: ${name} uses {ticket} without ticket settings`);
        }
        if (/[{}]/.test(template.replace(/\{(?:type|ticket|slug|summary)\}/g, ""))) throw new Error(`${key}: invalid ${name} template`);
      }
      const expanded = repoPath(key);
      if (normalized.has(expanded)) throw new Error(`duplicate repository path: ${key}`);
      normalized.set(expanded, value as RepoSettings);
    }
    return normalized.get(repoPath(repository)) ?? null;
  } catch (err) {
    throw new Error(`Invalid repos.json: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function validateTicket(settings: RepoSettings | null, value: unknown): string | undefined {
  if (value !== undefined && typeof value !== "string") throw new Error("Ticket must be a string");
  const ticket = typeof value === "string" ? value.trim() : "";
  if (!ticket) {
    if (settings?.ticket?.required) throw new Error("Ticket is required for this repository");
    return undefined;
  }
  if (ticket.length > 128 || /[\s\0]/.test(ticket) || (settings?.ticket && !new RegExp(settings.ticket.pattern).test(ticket))) {
    throw new Error(`Invalid Ticket${settings?.ticket ? `: expected ${settings.ticket.pattern}` : ""}`);
  }
  return ticket;
}

function validateRelativePath(value: string): void {
  if (path.isAbsolute(value) || value.split(/[\\/]/).includes("..")) throw new Error("prTemplate must stay inside the worktree");
}

export function readPrTemplate(worktree: string, settings: RepoSettings): string {
  if (!settings.prTemplate) return "";
  validateRelativePath(settings.prTemplate);
  const root = fs.realpathSync(worktree);
  const file = fs.realpathSync(path.join(root, settings.prTemplate));
  const relative = path.relative(root, file);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("prTemplate must stay inside the worktree (including symlinks)");
  return fs.readFileSync(file, "utf8");
}

export function fillConvention(template: string, draft: Pick<PrDraft, "type" | "summary" | "slug">, ticket?: string): string {
  return template.replace(/\{(type|summary|slug|ticket)\}/g, (_, name: string) => name === "ticket" ? ticket ?? "" : draft[name as keyof typeof draft]);
}

export function parsePrDraft(text: string, ticket?: string): PrDraft {
  let value: unknown;
  try { value = JSON.parse(text.trim()); } catch { throw new Error("Invalid PR JSON: expected a JSON object only"); }
  if (object(value) && typeof value.type === "string" && typeof value.slug === "string" && value.slug.startsWith(`${value.type}-`)) value.slug = value.slug.slice(value.type.length + 1);
  if (!object(value) || Object.keys(value).some((key) => !["type", "summary", "slug", "body"].includes(key)) ||
    !CHANGE_TYPES.includes(value.type as PrDraft["type"]) ||
    typeof value.summary !== "string" || !value.summary.trim() || value.summary.length > 200 || /[\r\n\0]/.test(value.summary) || !/^[A-Za-z]/.test(value.summary) || /[^\x20-\x7e]/.test(value.summary) || (ticket && value.summary.includes(ticket)) ||
    typeof value.slug !== "string" || !/^[a-z]+(?:-[a-z]+){1,5}$/.test(value.slug) ||
    typeof value.body !== "string" || !value.body.trim() || value.body.length > 100_000 || value.body.includes("\0")) {
    throw new Error("Invalid PR JSON: expected type (feat|fix|docs|refactor|ci|test|chore), English summary without Ticket, slug (2-6 lowercase kebab words), and nonempty body");
  }
  return { type: value.type as PrDraft["type"], summary: value.summary.trim(), slug: value.slug, body: value.body.trim() };
}

function changesSection(text: string): string {
  const heading = /^## Type of changes[ \t]*\r?$/m.exec(text);
  if (!heading) return "";
  return text.slice(heading.index + heading[0].length).split(/^## /m)[0]!;
}

export function validatePrBody(template: string, draft: PrDraft): void {
  for (const heading of template.matchAll(/^#{1,6} .+$/gm)) {
    if (!draft.body.split(/\r?\n/).includes(heading[0].trim())) throw new Error(`Invalid PR JSON: body is missing template section ${heading[0].trim()}`);
  }
  const names = { feat: "Feature", fix: "Fix", docs: "Docs", refactor: "Refactor", ci: "CI", test: "Test", chore: "Chore" };
  if (/\[[ xX]\]\s*(?:Feature|Fix|Docs|Refactor|CI|Test|Chore)\b/.test(changesSection(template))) {
    const selected = [...changesSection(draft.body).matchAll(/\[[xX]\]\s*(Feature|Fix|Docs|Refactor|CI|Test|Chore)\b/g)];
    if (selected.length !== 1 || selected[0]![1] !== names[draft.type]) throw new Error(`Invalid PR JSON: Type of changes must select only ${names[draft.type]}`);
  }
}

export function withTicketLink(body: string, ticket?: string, url?: string): string {
  if (!ticket || !url) return body;
  const link = `[${ticket}](${url})`;
  const purpose = /^## Purpose[ \t]*\r?$/m.exec(body);
  if (!purpose) return `${body}\n\n## Purpose\n\n${link}`;
  const start = purpose.index + purpose[0].length;
  const end = body.slice(start).search(/^## /m);
  const section = body.slice(start, end < 0 ? undefined : start + end);
  return section.includes(link) ? body : `${body.slice(0, start)}\n\n${link}\n\n${body.slice(start).replace(/^[\r\n]+/, "")}`;
}
