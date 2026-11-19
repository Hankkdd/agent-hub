import { expect, it, vi } from "vitest";
import type * as Monaco from "monaco-editor";
vi.mock("@/lib/monaco", () => ({}));
import { mountSuggestionDiff } from "./document-suggestion-monaco";
function engine(fail = false) {
  const models: Array<{ content: string; dispose: ReturnType<typeof vi.fn> }> = [];
  const createModel = vi.fn((content: string) => { const model = { content, dispose: vi.fn() }; models.push(model); return model; });
  const diff = { setModel: vi.fn(), dispose: vi.fn() };
  const createDiffEditor = vi.fn(() => { if (fail) throw new Error("FICTIONAL_PRIVATE_CAUSE"); return diff; });
  return { models, diff, createModel, createDiffEditor, api: { editor: { createModel, createDiffEditor } } as unknown as typeof Monaco };
}
it("creates independent anonymous plaintext models, uses read-only options and disposes both without retaining task URIs", () => {
  const e = engine(), container = {} as HTMLElement;
  const dispose = mountSuggestionDiff(e.api, container, "原文😀<script>", "候選\n", false);
  expect(e.createModel.mock.calls).toEqual([["原文😀<script>", "plaintext"], ["候選\n", "plaintext"]]);
  expect(e.createDiffEditor).toHaveBeenCalledWith(container, expect.objectContaining({ readOnly: true, originalEditable: false, wordWrap: "on" }));
  dispose(); expect(e.diff.setModel).toHaveBeenLastCalledWith(null); expect(e.diff.dispose).toHaveBeenCalledTimes(1);
  for (const model of e.models) expect(model.dispose).toHaveBeenCalledTimes(1);
});
it("disposes partial models on construction failure and exposes only a fixed safe failure", () => {
  const e = engine(true); expect(() => mountSuggestionDiff(e.api, {} as HTMLElement, "private original", "private replacement", false)).toThrow("Diff unavailable");
  for (const model of e.models) expect(model.dispose).toHaveBeenCalledTimes(1);
});
