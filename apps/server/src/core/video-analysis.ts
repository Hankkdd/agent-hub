import { randomUUID } from "node:crypto";
import type { AssignmentItem, VideoAnalysis, VideoEvidence } from "@agent-hub/shared";
import { digest, evidenceLink, loadVideoSource, type AnalysisSource, type SourceUnit } from "../media/video-source";
import { ASSIGNMENT_SYSTEM, assignmentPrompt, CONSOLIDATE_SYSTEM } from "./video-analysis-prompt";

export const ANALYSIS_LIMITS = { inputCharacters: 2_000_000, chunkCharacters: 16_000, chunks: 128, outputCharacters: 48_000, items: 2000, runtimeMs: 600_000 } as const;
export interface AnalysisChunk { units: SourceUnit[] }
/** Slices carry actual source starts; UTF-16 surrogate pairs are never cut in half. */
export function partitionSource(source: AnalysisSource): AnalysisChunk[] {
  const out: AnalysisChunk[] = [];
  let current: SourceUnit[] = [], length = 0;
  for (const unit of source.units) {
    let offset = 0;
    while (offset < unit.text.length) {
      let end = Math.min(offset + ANALYSIS_LIMITS.chunkCharacters, unit.text.length);
      if (end < unit.text.length && /[\uD800-\uDBFF]/.test(unit.text[end - 1]!)) end--;
      const text = unit.text.slice(offset, end);
      // Stable split identities prevent accepting a citation from an unprocessed part of a unit.
      const part = { ...unit, id: `${unit.id}@${offset}`, text };
      if (length + text.length > ANALYSIS_LIMITS.chunkCharacters || current.length >= 128) { out.push({ units: current }); current = []; length = 0; }
      current.push(part); length += text.length; offset = end;
    }
  }
  if (current.length) out.push({ units: current });
  return out;
}
const categories = ["required", "prohibited", "suggested", "uncertain"];
const reviews = ["pending", "uncertain", "conflict"];
const details = [null, "deadline", "submission", "output_format"];
function exact(o: unknown, keys: string[]): asserts o is Record<string, any> {
  if (!o || typeof o !== "object" || Array.isArray(o) || Object.keys(o).sort().join() !== keys.sort().join()) throw new Error("Invalid analysis schema");
}
function normalized(s: string): string { return s.normalize("NFKC").toLowerCase().replace(/[\p{P}\p{Z}\s]/gu, ""); }
function stableId(item: Pick<AssignmentItem, "content" | "category" | "detail" | "evidence">, fingerprint: string): string {
  const refs = item.evidence.map(e => `${e.unitId}:${e.start}:${e.excerpt}`).sort();
  return `as-${digest(JSON.stringify([fingerprint, normalized(item.content), item.category, item.detail, refs])).slice(0, 32)}`;
}
export function validateExtraction(raw: string, chunk: AnalysisChunk, source: AnalysisSource): AssignmentItem[] {
  if (raw.length > ANALYSIS_LIMITS.outputCharacters) throw new Error("Analysis output limit exceeded");
  const data: unknown = JSON.parse(raw);
  exact(data, ["version", "items"]);
  if (data.version !== 1 || !Array.isArray(data.items) || data.items.length > 128) throw new Error("Invalid analysis schema/version");
  return data.items.map((item: unknown) => {
    exact(item, ["content", "category", "review", "detail", "evidence"]);
    if (typeof item.content !== "string" || !item.content.trim() || item.content.length > 1200 || !/[\u3400-\u9fff]/.test(item.content) ||
      !categories.includes(item.category) || !reviews.includes(item.review) || !details.includes(item.detail) ||
      !Array.isArray(item.evidence) || !item.evidence.length || item.evidence.length > 8) throw new Error("Invalid analysis item");
    const evidence: VideoEvidence[] = item.evidence.map((ref: unknown) => {
      exact(ref, ["unitId", "excerpt"]);
      const unit = chunk.units.find(u => u.id === ref.unitId);
      if (!unit || typeof ref.excerpt !== "string" || !ref.excerpt.trim() || ref.excerpt.length > 240 || !unit.text.includes(ref.excerpt)) throw new Error("Invalid or fabricated citation");
      return { unitId: unit.id, start: unit.start, excerpt: ref.excerpt, ...(evidenceLink(source, unit.start) ? { url: evidenceLink(source, unit.start) } : {}) };
    });
    const result: AssignmentItem = { content: item.content.trim(), variants: [], category: item.category, review: item.category === "uncertain" ? "uncertain" : item.review,
      detail: item.detail, evidence: uniqueEvidence(evidence), conflicts: [], id: "" };
    result.id = stableId(result, source.fingerprint);
    return result;
  });
}
function uniqueEvidence(refs: VideoEvidence[]): VideoEvidence[] {
  return [...new Map(refs.map(e => [JSON.stringify([e.unitId, e.start, e.excerpt]), e])).values()].sort((a, b) => a.unitId.localeCompare(b.unitId) || a.excerpt.localeCompare(b.excerpt));
}
/** Conservative local normalization; model consolidation may add equivalences but cannot delete content. */
export function mergeExact(items: AssignmentItem[], fingerprint: string): AssignmentItem[] {
  const map = new Map<string, AssignmentItem>();
  for (const item of items) {
    const key = JSON.stringify([normalized(item.content), item.category, item.detail]);
    const previous = map.get(key);
    if (!previous) map.set(key, structuredClone(item));
    else {
      previous.evidence = uniqueEvidence([...previous.evidence, ...item.evidence]);
      if (previous.content !== item.content) previous.variants = [...new Set([...previous.variants, item.content])];
      if (item.review === "conflict") previous.review = "conflict";
      else if (item.review === "uncertain" && previous.review !== "conflict") previous.review = "uncertain";
    }
  }
  return [...map.values()].map(item => ({ ...item, id: stableId(item, fingerprint) }));
}
export function consolidate(raw: string, items: AssignmentItem[], fingerprint: string): AssignmentItem[] {
  if (raw.length > ANALYSIS_LIMITS.outputCharacters) throw new Error("Consolidation output limit exceeded");
  const data: unknown = JSON.parse(raw);
  exact(data, ["version", "merges", "conflicts"]);
  if (data.version !== 1 || !Array.isArray(data.merges) || !Array.isArray(data.conflicts) || data.merges.length + data.conflicts.length > 2000) throw new Error("Invalid consolidation schema");
  const known = new Map(items.map(i => [i.id, structuredClone(i)]));
  const validate = (group: unknown): string[] => {
    if (!Array.isArray(group) || group.length < 2 || group.length > items.length || group.some(id => typeof id !== "string" || !known.has(id)) || new Set(group).size !== group.length) throw new Error("Invalid consolidation references");
    return group;
  };
  const merges = data.merges.map(validate) as string[][];
  const conflicts = data.conflicts.map(validate) as string[][];
  const conflicted = new Set(conflicts.flat());
  const consumed = new Set<string>(), replacement = new Map<string, string>();
  const out: AssignmentItem[] = [];
  for (const group of merges) {
    const entries = group.map(id => known.get(id)!);
    if (group.some(id => consumed.has(id) || conflicted.has(id)) || entries.some(i => i.category !== entries[0]!.category || i.detail !== entries[0]!.detail || i.review === "conflict")) throw new Error("Unsafe consolidation merge");
    const item = structuredClone(entries.slice().sort((a, b) => a.id.localeCompare(b.id))[0]!);
    item.variants = [...new Set(entries.flatMap(i => [i.content, ...i.variants]))].filter(s => s !== item.content).sort();
    item.evidence = uniqueEvidence(entries.flatMap(i => i.evidence));
    if (entries.some(i => i.review === "uncertain")) item.review = "uncertain";
    item.id = stableId({ ...item, content: [item.content, ...item.variants].sort().join("\n") }, fingerprint);
    for (const id of group) { consumed.add(id); replacement.set(id, item.id); }
    out.push(item);
  }
  out.push(...[...known.values()].filter(i => !consumed.has(i.id)));
  for (const group of conflicts) for (const id of group) {
    const item = out.find(i => i.id === (replacement.get(id) ?? id))!;
    item.review = "conflict";
    item.conflicts = [...new Set([...item.conflicts, ...group.filter(other => other !== id).map(other => replacement.get(other) ?? other)])].sort();
  }
  return out;
}
export function requestedAnalysis(): VideoAnalysis {
  return { version: 1, operationId: randomUUID(), kind: "assignment-spec", status: "requested", source: null,
    coverage: { totalUnits: 0, processedUnits: 0, totalChunks: 0, processedChunks: 0, totalCharacters: 0, processedCharacters: 0 }, limits: { ...ANALYSIS_LIMITS }, items: [],
    missing: { deadline: "unknown", submission: "unknown", output_format: "unknown" } };
}
export interface AnalysisDeps {
  generate(prompt: string, system: string): Promise<string>;
  persist(analysis: VideoAnalysis): void;
  signal: AbortSignal;
}
export async function runVideoAnalysis(dir: string, initial: VideoAnalysis, deps: AnalysisDeps): Promise<VideoAnalysis> {
  let result = structuredClone(initial);
  const save = () => deps.persist(structuredClone(result));
  try {
    const source = loadVideoSource(dir);
    result.source = { version: 1, fingerprint: source.fingerprint, precision: source.precision };
    result.coverage.totalUnits = source.units.length;
    result.coverage.totalCharacters = source.units.reduce((n, u) => n + u.text.length, 0);
    if (!source.units.length) throw new Error("No transcript evidence");
    if (result.coverage.totalCharacters > ANALYSIS_LIMITS.inputCharacters) throw new Error("Transcript input character limit exceeded");
    const chunks = partitionSource(source);
    result.coverage.totalChunks = chunks.length;
    result.status = "running"; save();
    const completed = new Set<string>();
    const needed = new Map<string, number>();
    for (const c of chunks) for (const u of c.units) { const original = u.id.split("@")[0]!; needed.set(original, (needed.get(original) ?? 0) + 1); }
    for (const [index, chunk] of chunks.entries()) {
      deps.signal.throwIfAborted();
      if (index >= ANALYSIS_LIMITS.chunks) throw new Error("Transcript chunk/call limit exceeded");
      const items = validateExtraction(await deps.generate(assignmentPrompt(chunk), ASSIGNMENT_SYSTEM), chunk, source);
      deps.signal.throwIfAborted();
      if (result.items.length + items.length > ANALYSIS_LIMITS.items) throw new Error("Analysis item limit exceeded");
      result.items = mergeExact([...result.items, ...items], source.fingerprint);
      result.coverage.processedChunks++;
      result.coverage.processedCharacters += chunk.units.reduce((n, u) => n + u.text.length, 0);
      for (const u of chunk.units) { const original = u.id.split("@")[0]!; needed.set(original, needed.get(original)! - 1); if (!needed.get(original)) completed.add(original); }
      result.coverage.processedUnits = completed.size;
      save();
    }
    if (result.items.length > 1) {
      const input = JSON.stringify(result.items.map(({ id, content, variants, category, detail, review }) => ({ id, content, variants, category, detail, review })));
      if (input.length > 100_000) throw new Error("Consolidation input limit exceeded");
      result.items = consolidate(await deps.generate(input, CONSOLIDATE_SYSTEM), result.items, source.fingerprint);
    }
    deps.signal.throwIfAborted();
    result.status = "complete";
    for (const detail of ["deadline", "submission", "output_format"] as const) result.missing[detail] = result.items.some(i => i.detail === detail) ? "mentioned" : "not_mentioned";
  } catch (err) {
    result.status = "incomplete";
    result.reason = deps.signal.aborted ? "Analysis stopped, interrupted or timed out; partial evidence retained. Select the action again to retry explicitly." : err instanceof Error ? err.message : String(err);
  }
  save();
  return result;
}
