import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { DocumentSuggestionPrompt } from "./document-suggestion-prompt";
import { DocumentWorkspaceModel, type DocumentApi } from "@/lib/document-workspace-model";
import type { SuggestionApi } from "@/lib/document-suggestions";
import { copyText } from "@/lib/copy";
import { t } from "@/i18n";
const hooks = vi.hoisted(() => ({ slots: [] as unknown[], cursor: 0, refs: [] as Array<{ current: unknown }> }));
vi.mock("@/lib/copy", () => ({ copyText: vi.fn() }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useRef: () => { const r = { current: null }; hooks.refs.push(r); return r; },
  useState: (initial: unknown) => { const i = hooks.cursor++; if (!(i in hooks.slots)) hooks.slots[i] = initial;
    return [hooks.slots[i], (next: unknown) => { hooks.slots[i] = next; }]; },
}));
function nodes(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (!isValidElement<{ children?: ReactNode }>(node)) return [];
  return [node as ReactElement<Record<string, unknown>>, ...Children.toArray(node.props.children).flatMap(nodes)];
}
let model: DocumentWorkspaceModel;
beforeEach(async () => {
  hooks.slots = []; hooks.cursor = 0; hooks.refs = []; vi.mocked(copyText).mockReset();
  const base = { id: "D", createdAt: "now", updatedAt: "now", currentRevision: { id: "R", documentId: "D", revisionNumber: 1, title: "Fictional", contentFormat: "plain_text", content: "original 中文😀", createdAt: "now", restoredFromRevisionId: null } };
  model = new DocumentWorkspaceModel({ getDocument: vi.fn().mockResolvedValue(base) } as unknown as DocumentApi, {} as SuggestionApi);
  await model.open("D"); model.select(0, 8); model.startSuggestion(); model.updateSuggestionDraft({ instructions: "Improve" }); model.generatePrompt();
});
// useState slots: 0 discard, 1 convert, 2 step.
const go = (step: number) => { hooks.slots[2] = step; };
function tree() { hooks.cursor = 0; hooks.refs = []; return nodes(DocumentSuggestionPrompt({ model, state: model.getSnapshot() })); }
function button(label: string) { return tree().find(n => n.props.children === label)!; }
function field(id: string) { return tree().find(n => n.props.id === id)!; }
const click = async (label: string) => { await (button(label).props.onClick as () => Promise<void>)(); };
it("runs clipboard success and failure handlers without modifying the frozen target or editor", async () => {
  const before = model.getSnapshot().editor, target = model.getSnapshot().suggestions.draft!.intent;
  vi.mocked(copyText).mockResolvedValueOnce(undefined); await click(t("suggestions.copy")); expect(model.getSnapshot().suggestions.draft!.copy).toBe("copied");
  vi.mocked(copyText).mockRejectedValueOnce(new Error("denied")); await click(t("suggestions.copy")); expect(model.getSnapshot().suggestions.draft!.copy).toBe("failed");
  expect(model.getSnapshot().editor).toBe(before); expect(model.getSnapshot().suggestions.draft!.intent).toBe(target);
});
it("manual select-all focuses only the visible prompt textarea", async () => {
  const list = tree(), fake = { focus: vi.fn(), select: vi.fn() }; hooks.refs[0]!.current = fake;
  const select = list.find(n => n.props.children === t("suggestions.selectAll"))!;
  await (select.props.onClick as () => void)(); expect(fake.focus).toHaveBeenCalledTimes(1); expect(fake.select).toHaveBeenCalledTimes(1);
});
it("instruction/advanced edits require explicit regeneration before Copy; no default internal IDs leak", async () => {
  go(2); model.updateSuggestionDraft({ advanced: true }); expect(button(t("suggestions.copy")).props.disabled).toBe(true);
  await click(t("suggestions.copy")); expect(copyText).not.toHaveBeenCalled();
  model.generatePrompt(); expect(model.getSnapshot().suggestions.draft!.prompt).toContain('"documentId"');
  model.updateSuggestionDraft({ advanced: false }); expect(button(t("suggestions.copy")).props.disabled).toBe(true);
  model.generatePrompt(); expect(model.getSnapshot().suggestions.draft!.prompt).not.toContain('"documentId"');
});
it("resumes on the step the retained material supports and Next generates the prompt", () => {
  tree(); expect(hooks.slots[2]).toBe(2);
  model.updateSuggestionDraft({ instructions: "Shorter" }); go(1);
  (button(t("suggestions.next")).props.onClick as () => void)();
  expect(hooks.slots[2]).toBe(2); expect(model.getSnapshot().suggestions.draft!.promptStale).toBe(false);
  expect(model.getSnapshot().suggestions.draft!.prompt).toContain("Shorter");
  model.updateSuggestionDraft({ instructions: " " }); go(1); expect(button(t("suggestions.next")).props.disabled).toBe(true);
  model.updateSuggestionDraft({ replacement: "candidate" }); hooks.slots = []; tree(); expect(hooks.slots[2]).toBe(3);
});
it("keeps invalid candidate raw input through the real change handler and blocks import", () => {
  go(3);
  const invalid = "NUL\0unpaired\ud800";
  (field("suggestion-replacement").props.onChange as (e: unknown) => void)({ currentTarget: { value: invalid } });
  expect(model.getSnapshot().suggestions.draft!.replacement).toBe(invalid); expect(button(t("suggestions.import")).props.disabled).toBe(true);
});
it("intercepts a CR paste without rewriting it and requires explicit local LF confirmation", async () => {
  go(3);
  const event = { clipboardData: { getData: () => "A\r\n\rB" }, currentTarget: { selectionStart: 0, selectionEnd: 0 }, preventDefault: vi.fn() };
  (field("suggestion-replacement").props.onPaste as (e: unknown) => void)(event);
  expect(event.preventDefault).toHaveBeenCalled(); expect(model.getSnapshot().suggestions.draft!.replacement).toBe("A\r\n\rB");
  expect(field("suggestion-replacement").props.readOnly).toBe(true); expect(model.canImportSuggestion()).toBe(false);
  await click(t("suggestions.candidateConvert")); await click(t("documents.confirm"));
  expect(model.getSnapshot().suggestions.draft!.replacement).toBe("A\n\nB"); expect(model.getSnapshot().editor!.base.currentRevision.content).toBe("original 中文😀");
});
it("closing preserves memory-only material and discard requires a separate explicit confirmation", async () => {
  const draft = model.getSnapshot().suggestions.draft;
  model.closeSuggestions(); expect(model.getSnapshot().suggestions.draft).toBe(draft); model.resumeSuggestion();
  await click(t("suggestions.discard")); expect(model.getSnapshot().suggestions.draft).not.toBeNull();
  await click(t("suggestions.discard")); expect(model.getSnapshot().suggestions.draft).toBeNull();
});
