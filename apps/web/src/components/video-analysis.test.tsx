import { afterEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { latestVideoAnalysis, type Task, type TaskEvent, type VideoAnalysis } from "@agent-hub/shared";
import { setLanguage, t } from "@/i18n";
import { VideoAnalysisPanel, VideoAnalysisResult } from "./video-analysis";
vi.mock("@/i18n", async original => ({ ...await original<object>(), useLanguage: () => "en" }));
vi.mock("@/lib/client", () => ({ client: { analyzeVideo: vi.fn() } }));
afterEach(() => setLanguage("zh-TW"));
const analysis: VideoAnalysis = {
  version: 1, kind: "assignment-spec", operationId: "operation", status: "complete",
  source: { version: 1, fingerprint: "fingerprint", precision: "paragraph" },
  coverage: { totalUnits: 3, processedUnits: 3, totalChunks: 2, processedChunks: 2, totalCharacters: 170000, processedCharacters: 170000 },
  limits: { inputCharacters: 2000000, chunkCharacters: 16000, chunks: 128, outputCharacters: 48000, items: 2000, runtimeMs: 600000 },
  items: [{ id: "stable", content: "必須使用八個 Bubble Sort 工作", category: "required", review: "conflict", variants: ["需要八個葉節點工作"], detail: null,
    evidence: [{ unitId: "original@0", start: 61, excerpt: "Use eight Bubble Sort jobs.", url: "https://youtu.be/fixture123?t=61" }, { unitId: "legacy@0", start: 120, excerpt: "Original Drive evidence" }], conflicts: ["other-rule"] }],
  missing: { deadline: "not_mentioned", submission: "not_mentioned", output_format: "not_mentioned" },
};
it.each(["en", "zh-TW"] as const)("shows translated read-only coverage, precision, all categories, review, excerpts and transcription warning (%s)", language => {
  setLanguage(language);
  const html = renderToStaticMarkup(<VideoAnalysisResult analysis={analysis} />);
  for (const key of ["action", "warning", "precision.paragraph", "review.conflict", "category.required", "category.prohibited", "category.suggested", "category.uncertain", "missing.not_mentioned"] as const) expect(html).toContain(t(`videoAnalysis.${key}`));
  expect(html).toContain(analysis.items[0]!.content); expect(html).toContain("Original Drive evidence"); expect(html).toContain("Use eight Bubble Sort jobs.");
  expect(html).toContain('href="https://youtu.be/fixture123?t=61"'); expect(html).not.toContain("drive.google.com");
  expect(html).toContain("1:01"); expect(html).toContain("170000"); expect(html).toContain("original@0"); expect(html).toContain("other-rule");
  expect(html).not.toMatch(/<(input|textarea|button)\b/); expect(html).toContain("overflow-wrap:anywhere");
});
it("separates complete no-match results from incomplete/no-evidence results", () => {
  const complete = renderToStaticMarkup(<VideoAnalysisResult analysis={{ ...analysis, items: [] }} />);
  expect(complete).toContain(t("videoAnalysis.empty"));
  const incomplete = renderToStaticMarkup(<VideoAnalysisResult analysis={{ ...analysis, status: "incomplete", items: [], reason: "No transcript evidence", missing: { deadline: "unknown", submission: "unknown", output_format: "unknown" } }} />);
  expect(incomplete).toContain(t("videoAnalysis.partial")); expect(incomplete).not.toContain(t("videoAnalysis.empty"));
  expect(incomplete).not.toContain(t("videoAnalysis.missing.not_mentioned")); expect(incomplete).toContain("No transcript evidence");
});
it("projects event snapshots after reconnect, offers an explicit action, disables it while busy", () => {
  const events = [{ type: "video_analysis", seq: 1, analysis: { ...analysis, status: "requested" } }, { type: "video_analysis", seq: 2, analysis }] as TaskEvent[];
  const restored = latestVideoAnalysis(JSON.parse(JSON.stringify(events)))!;
  expect(restored).toEqual(analysis);
  const task = { id: "task", workflow: "video", status: "idle" } as Task;
  const html = renderToStaticMarkup(<VideoAnalysisPanel task={task} events={events} />);
  expect(html).toContain(t("videoAnalysis.intro")); expect(html).toContain(analysis.items[0]!.content); expect(html).not.toContain('disabled=""');
  for (const status of ["running", "waiting_user", "paused"] as const) {
    expect(renderToStaticMarkup(<VideoAnalysisPanel task={{ ...task, status }} events={[]} />)).toContain('disabled=""');
  }
});
