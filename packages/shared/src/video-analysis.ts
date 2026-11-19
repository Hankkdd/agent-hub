/** Versioned, read-only extraction. Citation validation is not semantic or human confirmation. */
export type VideoAnalysisKind = "assignment-spec";
export type AssignmentCategory = "required" | "prohibited" | "suggested" | "uncertain";
export interface VideoEvidence {
  unitId: string;
  start: number;
  excerpt: string;
  url?: string;
}
export interface AssignmentItem {
  id: string;
  content: string;
  variants: string[];
  category: AssignmentCategory;
  review: "pending" | "uncertain" | "conflict";
  detail: "deadline" | "submission" | "output_format" | null;
  evidence: VideoEvidence[];
  conflicts: string[];
}
export interface VideoAnalysis {
  version: 1;
  operationId: string;
  kind: VideoAnalysisKind;
  status: "requested" | "running" | "complete" | "incomplete";
  source: { version: 1; fingerprint: string; precision: "segment" | "paragraph" } | null;
  coverage: { totalUnits: number; processedUnits: number; totalChunks: number; processedChunks: number; totalCharacters: number; processedCharacters: number };
  limits: { inputCharacters: number; chunkCharacters: number; chunks: number; outputCharacters: number; items: number; runtimeMs: number };
  items: AssignmentItem[];
  missing: Record<"deadline" | "submission" | "output_format", "not_mentioned" | "mentioned" | "unknown">;
  reason?: string;
}

/** Events are authoritative; snapshots include partial evidence so replay needs no artifact/model. */
export function latestVideoAnalysis(events: readonly { type: string; analysis?: VideoAnalysis }[]): VideoAnalysis | undefined {
  return events.filter(e => e.type === "video_analysis").at(-1)?.analysis;
}
