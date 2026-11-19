import { Children, isValidElement, type ReactElement, type ReactNode, type FormEvent } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import type { AntigravityStatus } from "@agent-hub/shared";
import { AntigravityDialog } from "./antigravity-dialog";
import { en } from "@/i18n/en";
import { zhTW } from "@/i18n/zh-TW";
const h = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, input: vi.fn(), start: vi.fn(), logout: vi.fn(), cancel: vi.fn(), status: vi.fn() }));
vi.mock("@/lib/client", () => ({ client: { antigravityInput: h.input, antigravityStart: h.start, antigravityLogout: h.logout, antigravityCancel: h.cancel, antigravityStatus: h.status } }));
vi.mock("@/i18n", () => ({ useLanguage: () => "en", t: (key: string) => key }));
vi.mock("react", async original => ({ ...await original<object>(), useEffect: () => {}, useState: (initial: unknown) => {
  const index = h.cursor++;
  if (!(index in h.values)) h.values[index] = initial;
  return [h.values[index], (next: unknown) => { h.values[index] = typeof next === "function" ? next(h.values[index]) : next; }];
} }));
function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (!isValidElement<{ children?: ReactNode }>(node)) return [];
  return [node as ReactElement<Record<string, unknown>>, ...Children.toArray(node.props.children).flatMap(elements)];
}
function render(status?: AntigravityStatus) {
  if (status) h.values[0] = status;
  h.cursor = 0;
  return elements(AntigravityDialog({ open: true, onOpenChange: vi.fn() }));
}
function button(nodes: ReturnType<typeof render>, label: string) { return nodes.find(node => node.props.children === label && typeof node.props.onClick === "function")!; }
const running: AntigravityStatus = { available: true, credentials: "present-unverified", session: {
  state: "running", screen: ["Choose login", "Enter code:"], links: ["https://accounts.example.invalid/oauth"], startedAt: 1, expiresAt: Date.now() + 600_000,
} };
beforeEach(() => { h.values = []; h.cursor = 0; vi.clearAllMocks(); });
it("shows availability reasons and disables starting on an unsupported host", () => {
  const nodes = render({ ...running, available: false, reason: "unsupported-arch", credentials: "absent", session: { state: "idle", screen: [], links: [], startedAt: null, expiresAt: null } });
  expect(JSON.stringify(nodes)).toContain("antigravity.unsupported-arch");
  expect(JSON.stringify(nodes)).toContain("antigravity.credentials.absent");
  expect(button(nodes, "antigravity.start").props.disabled).toBe(true);
  expect(JSON.stringify(nodes)).toContain("antigravity.warning");
});
it("shows the screen, secure link buttons, navigation keys and time remaining", async () => {
  const nodes = render(running);
  expect(nodes.find(node => node.type === "pre")?.props.children).toBe("Choose login\nEnter code:");
  expect(nodes.find(node => node.type === "pre")?.props.className).toContain("overflow-x-auto");
  expect(nodes.find(node => node.type === "pre")?.props.className).toContain("whitespace-pre");
  expect(nodes.find(node => node.type === "a")?.props).toMatchObject({ href: running.session.links[0], target: "_blank", rel: "noopener noreferrer" });
  expect(JSON.stringify(nodes)).toContain("antigravity.remaining");
  expect(button(nodes, "antigravity.logout").props.disabled).toBe(true);
  expect(button(nodes, "antigravity.start").props.disabled).toBe(true);
  h.input.mockResolvedValue({ ok: true });
  (button(nodes, "antigravity.key.down").props.onClick as () => void)();
  await vi.waitFor(() => expect(h.input).toHaveBeenCalledWith({ key: "down" }));
});
it("sends a code with the Enter toggle and clears the input", async () => {
  render(running);
  h.values[1] = "one-time-code"; h.values[2] = false;
  h.input.mockResolvedValue({ ok: true });
  const form = render().find(node => node.type === "form")!;
  const preventDefault = vi.fn();
  (form.props.onSubmit as (event: FormEvent) => void)({ preventDefault } as unknown as FormEvent);
  await vi.waitFor(() => expect(h.input).toHaveBeenCalledWith({ text: "one-time-code", submit: false }));
  expect(preventDefault).toHaveBeenCalledOnce();
  expect(h.values[1]).toBe("");
});
it("requires sign out confirmation before deleting credentials", async () => {
  const nodes = render({ ...running, session: { ...running.session, state: "exited", exitCode: 0 } });
  (button(nodes, "antigravity.logout").props.onClick as () => void)();
  expect(h.logout).not.toHaveBeenCalled();
  h.logout.mockResolvedValue({ ...running, credentials: "absent" });
  const confirm = render();
  expect(JSON.stringify(confirm)).toContain("antigravity.confirmLogout");
  const destructive = confirm.find(node => node.props.variant === "destructive")!;
  (destructive.props.onClick as () => void)();
  await vi.waitFor(() => expect(h.logout).toHaveBeenCalledOnce());
});
it("has both dictionaries for every panel string", () => {
  for (const key of Object.keys(en).filter(key => key.startsWith("antigravity.")) as (keyof typeof en)[]) expect(zhTW[key]).toBeTruthy();
});


it.each(["availability", "cleanup", "prepare", "create", "attach", "start", "wait", "remove"] as const)("localizes the %s failure stage", failedStage => {
  const nodes = render({ ...running, session: { ...running.session, state: "failed", failedStage } });
  expect(nodes.some(node => node.props.role === "alert" && node.props.children === `antigravity.failedStage.${failedStage}`)).toBe(true);
  expect(en[`antigravity.failedStage.${failedStage}`]).toBeTruthy();
  expect(zhTW[`antigravity.failedStage.${failedStage}`]).toBeTruthy();
});
