import { findingNotesZhTW as prose } from "./finding-notes.zh-TW";
import { createHash } from "node:crypto";
import type { FindingInput, FindingSummary, TaskEvent } from "@agent-hub/shared";

export const findingHash = (text: string): string => createHash("sha256").update(text).digest("hex");
export const findingIdentity = (project: string, topic: string): string => findingHash(`${project}\0${topic}`);
export type RecordedFinding = Extract<TaskEvent, { type: "finding_recorded" }>;
export type ExportEvent = Extract<TaskEvent, { type: "finding_export" }>;

export function documentReference(value: string): boolean {
  return value.length <= 1024 && !/[\\\0\r\n:#?%]/.test(value) && !value.startsWith("/") &&
    value.split("/").every((part) => !!part && part !== "." && part !== ".." && part !== ".git" && part !== "jira-ticket") && /\.md$/.test(value);
}

export function validateFinding(value: FindingInput): FindingInput {
  if (!value || Object.keys(value).some((k) => !["topic", "title", "evidence", "locations", "followUp", "existingDocument"].includes(k))) throw new Error("Invalid finding fields");
  if (typeof value.topic !== "string" || value.topic.length > 80 || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value.topic)) throw new Error("Topic must be 1-80 lowercase kebab-case characters, never a path");
  const bounded = (s: unknown, max: number, single = false) => typeof s === "string" && !!s.trim() && s.length <= max && !s.includes("\0") && (!single || !/[\r\n]/.test(s));
  if (!bounded(value.title, 200, true) || !bounded(value.evidence, 6000) || (value.followUp !== undefined && !bounded(value.followUp, 2000))) throw new Error("Finding text is empty, invalid or too long");
  if (value.locations !== undefined && (!Array.isArray(value.locations) || value.locations.length > 20 || value.locations.some((s) => !bounded(s, 300, true) || /^[\\/]/.test(s) || /\\/.test(s) || s.split("/").includes("..") || /^[A-Za-z]:/.test(s)))) throw new Error("Locations must be bounded code-relative references");
  if (value.existingDocument !== undefined && (typeof value.existingDocument !== "string" || !documentReference(value.existingDocument))) throw new Error("Invalid existing document reference");
  return { topic: value.topic, title: value.title.trim(), evidence: value.evidence.trim(), ...(value.locations ? { locations: value.locations } : {}), ...(value.followUp ? { followUp: value.followUp.trim() } : {}), ...(value.existingDocument ? { existingDocument: value.existingDocument } : {}) };
}

export function findingCatalogue(history: TaskEvent[], project: string): FindingSummary[] {
  const topics = new Map<string, FindingSummary>();
  const exports = history.filter((e): e is ExportEvent => e.type === "finding_export");
  for (const e of history) {
    if (e.type !== "finding_recorded" || e.project !== project) continue;
    const previous = topics.get(e.findingId);
    const result = exports.filter((x) => x.findingId === e.findingId && x.observationIds.includes(e.id)).at(-1);
    topics.set(e.findingId, { findingId: e.findingId, topic: e.topic, title: e.title,
      state: result?.state ?? (e.exportConfigured === false ? "unconfigured" : "pending"), document: result?.document ?? e.existingDocument ?? previous?.document, reason: result?.reason });
  }
  return [...topics.values()].sort((a, b) => a.topic.localeCompare(b.topic));
}

/** Input prose is preserved as data; it is never evaluated as a template or command. */
export function renderFinding(observations: RecordedFinding[], owner: string, previous?: string): string {
  const first = observations[0]!;
  const latest = observations.at(-1)!;
  const created = previous?.match(/^Created: (\d{4}-\d{2}-\d{2})$/m)?.[1] ?? first.createdAt.slice(0, 10);
  const field = (s: string) => s.replace(/[\r\n]/g, " ");
  const related = [...new Set(observations.flatMap((e) => e.existingDocument ? [e.existingDocument] : []))];
  const header = [`# ${field(latest.title)}`, "", "Type: Tech Debt", "Status: Draft", `Source-of-truth: [${prose.canonicalNote}](./${first.topic}.md)`, `Created: ${created}`,
    ...(previous ? [`Updated: ${latest.createdAt.slice(0, 10)}`] : []), `Owner: ${field(owner)}`,
    ...([...new Set(observations.flatMap((e) => e.ticket ? [e.ticket] : []))].map((t) => `Ticket: ${field(t)}`)),
    ...(related.length ? [`Related: ${related.map((r) => `[${r}](../../${r})`).join(", ")}`] : []), "", "---", "", `<!-- agent-hub-finding: ${first.findingId} -->`, "",
    `[${prose.governance}](../../README.md)`, "", prose.draftNotice, "", prose.provenanceNotice, ""];
  for (const e of observations) header.push(`## ${e.createdAt.slice(0, 10)} · ${e.title}`, "", e.evidence, "",
    ...(e.locations?.length ? [prose.locations, ...e.locations.map((l) => `- ${l}`), ""] : []),
    `${prose.source}task ${e.taskId}; finding ${e.findingId}; observation ${e.id}; session ${e.sessionId ?? "unknown"}; agent ${e.agent}; revision ${e.revision ?? "unavailable"}`, "",
    ...(e.followUp ? [prose.followUp, e.followUp, ""] : []));
  const content = header.join("\n");
  if (Buffer.byteLength(content) > 512_000) throw new Error("Managed note size limit reached; observations remain durable");
  return content;
}
