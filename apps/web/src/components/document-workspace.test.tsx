import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { DocumentCreateForm, DocumentCreateWarning, DocumentWorkspace } from "./document-workspace";
import { DocumentWorkspaceModel, type DocumentApi, type DocumentFailure } from "@/lib/document-workspace-model";
import { Button } from "./ui/button";
import { t } from "@/i18n";

vi.mock("@/lib/client", () => ({ client: { reconnect: vi.fn() } }));
function nodes(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (!isValidElement<{ children?: ReactNode }>(node)) return [];
  return [node as ReactElement<Record<string, unknown>>, ...Children.toArray(node.props.children).flatMap(nodes)];
}
const props = () => ({ title: "Fictional new SOP", onTitle: vi.fn(), unknown: 1 as number | null, acknowledged: null as number | null,
  onAcknowledge: vi.fn(), error: null as DocumentFailure | null, pending: false, authorized: true, onInspect: vi.fn(), onCreate: vi.fn(async (_version?: number) => {}) });
const createButton = (value: ReturnType<typeof props>) => nodes(DocumentCreateForm(value)).find(n => n.type === Button)!;

it("unknown create risk requires explicit checkbox confirmation before another submit", async () => {
  const value = props();
  expect(createButton(value).props.disabled).toBe(true);
  await (createButton(value).props.onClick as () => Promise<void>)(); expect(value.onCreate).not.toHaveBeenCalled();
  const checkbox = nodes(DocumentCreateForm(value)).find(n => n.type === "input" && n.props.type === "checkbox")!;
  (checkbox.props.onChange as (event: unknown) => void)({ currentTarget: { checked: true } });
  expect(value.onAcknowledge).toHaveBeenCalledWith(1);
  value.acknowledged = 1; expect(createButton(value).props.disabled).toBe(false);
  await (createButton(value).props.onClick as () => Promise<void>)(); expect(value.onCreate).toHaveBeenCalledWith(1);
  value.unknown = 2; expect(createButton(value).props.disabled).toBe(true);
  const html = renderToStaticMarkup(<DocumentCreateForm {...value} />);
  expect(html).toContain(t("documents.createRisk")); expect(html).toContain(t("documents.createUnknown"));
});

it("known create failures do not require a duplicate-risk acknowledgment and 401 still blocks submit", () => {
  const value = { ...props(), unknown: null, error: { status: 400, unknownWrite: false } };
  expect(createButton(value).props.disabled).toBe(false);
  expect(renderToStaticMarkup(<DocumentCreateForm {...value} />)).not.toContain('type="checkbox"');
  value.authorized = false; expect(createButton(value).props.disabled).toBe(true);
});

it("offers list inspection without treating a missing entry as proof of failure", () => {
  const onInspect = vi.fn();
  const tree = DocumentCreateWarning({ onInspect, disabled: false });
  (nodes(tree).find(n => n.type === Button)!.props.onClick as () => void)(); expect(onInspect).toHaveBeenCalledOnce();
  expect(renderToStaticMarkup(tree)).toContain(t("documents.createUnknown"));
});

it("renders the independent warning with no active editor and no open create dialog", async () => {
  const api = { createDocument: vi.fn().mockRejectedValue(new Error("network")) } as unknown as DocumentApi;
  const model = new DocumentWorkspaceModel(api); await model.create("Fictional new SOP");
  const html = renderToStaticMarkup(<DocumentWorkspace model={model} state={model.getSnapshot()} active onDocument={() => {}} onBack={() => {}} />);
  expect(model.getSnapshot().editor).toBeNull(); expect(html).toContain("data-document-create-unknown");
  expect(html).toContain(t("documents.inspectCreates"));
  expect(html).not.toContain(t("documents.remote"));
  model.setAuthorized(false);
  const unauthorized = renderToStaticMarkup(<DocumentWorkspace model={model} state={model.getSnapshot()} active onDocument={() => {}} onBack={() => {}} />);
  expect(unauthorized).toContain("data-document-create-unknown"); expect(unauthorized).toContain(t("documents.auth"));
});

it("UI submission uses the model's current risk version rather than reusing a checked checkbox", async () => {
  const api = { createDocument: vi.fn().mockRejectedValue(new Error("network")) } as unknown as DocumentApi;
  const model = new DocumentWorkspaceModel(api); await model.create("Fictional new SOP");
  const value = { ...props(), unknown: model.getSnapshot().createUnknown, acknowledged: model.getSnapshot().createUnknown,
    onCreate: vi.fn(async (acknowledged?: number) => { await model.create("Fictional new SOP", true, acknowledged); }) };
  await (createButton(value).props.onClick as () => Promise<void>)(); expect(api.createDocument).toHaveBeenCalledTimes(2);
  value.unknown = model.getSnapshot().createUnknown;
  expect(createButton(value).props.disabled).toBe(true);
  await (createButton(value).props.onClick as () => Promise<void>)(); expect(api.createDocument).toHaveBeenCalledTimes(2);
});
