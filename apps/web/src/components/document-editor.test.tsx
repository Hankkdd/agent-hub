import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DocumentEditor } from "./document-editor";
import { createEditorSession, editorInput, editorSelection } from "@/lib/document-editor-state";
import type { DocumentWorkspaceModel } from "@/lib/document-workspace-model";
import { t } from "@/i18n";

const model = { input: vi.fn(), composing: vi.fn(), select: vi.fn(), title: vi.fn(), save: vi.fn(), editorLocked: () => false, canStartSuggestion: () => false, getSnapshot: () => ({ suggestions: { draft: null } }) } as unknown as DocumentWorkspaceModel;
function session(content: string) {
  return createEditorSession({ id: "doc", createdAt: "2026-10-20", updatedAt: "2026-10-20", currentRevision: {
    id: "r1", documentId: "doc", revisionNumber: 1, contentFormat: "plain_text", content, title: "Fictional SOP", createdAt: "2026-10-20", restoredFromRevisionId: null,
  } });
}
const props = { model, active: true, pending: null, authorized: true, modal: false, onConvert: vi.fn(), onDiscard: vi.fn(), onHistory: vi.fn(), onPrompt: vi.fn(), onSuggestions: vi.fn(), pendingCount: null };
it("renders non-LF content readonly without marking its projection dirty", () => {
  const html = renderToStaticMarkup(<DocumentEditor {...props} session={session("A\r\n\rB")} />);
  expect(html).toContain("readOnly"); expect(html).toContain(t("documents.convert")); expect(html).toContain(t("documents.clean"));
  expect(html).not.toContain(`>${t("documents.dirty")}<`);
});
it("keeps invalid/oversized visible input and disables saving with a concrete error", () => {
  const html = renderToStaticMarkup(<DocumentEditor {...props} session={editorInput(session(""), "x".repeat(262145))} />);
  expect(html).toContain("x".repeat(262145)); expect(html).toContain(t("documents.content_too_large")); expect(html).toContain(t("documents.dirty"));
});
it("renders Unicode statistics and a flexible native textarea with manual save", () => {
  const html = renderToStaticMarkup(<DocumentEditor {...props} session={session("Hello 中文😀\n")} />);
  expect(html).toContain("textarea"); expect(html).toContain("Hello 中文😀"); expect(html).not.toContain("readOnly");
  expect(html).toContain(t("documents.stats", { words: 1, characters: 10, bytes: 17 }));
  expect(html).toContain(t("documents.statsShort", { characters: 10 }));
});
it("explains why a selection in a dirty draft cannot start a revision instead of only disabling the button", () => {
  const dirty = editorInput(session("Hello\n"), "Hello world\n");
  const html = renderToStaticMarkup(<DocumentEditor {...props} session={{ ...dirty, selection: editorSelection(dirty, 0, 5) }} />);
  expect(html).toContain("data-suggestion-gate"); expect(html).toContain(t("suggestions.gateDirty"));
  expect(renderToStaticMarkup(<DocumentEditor {...props} session={session("Hello\n")} />)).not.toContain("data-suggestion-gate");
});
