import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { GoogleDialog, containsDriveUrl, googleErrorMessage } from "./google-dialog";
import type { GoogleStatus } from "@agent-hub/shared";
import { en } from "@/i18n/en";
import { zhTW } from "@/i18n/zh-TW";
const h = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, status: vi.fn(), connect: vi.fn(), complete: vi.fn(), disconnect: vi.fn() }));
vi.mock("@/lib/client", () => ({ client: { googleStatus: h.status, googleConnect: h.connect, googleComplete: h.complete, googleDisconnect: h.disconnect } }));
vi.mock("@/i18n", () => ({ useLanguage: () => "en", t: (key: string) => key }));
vi.mock("react", async (original) => ({ ...await original<object>(), useEffect: () => {}, useState: (initial: unknown) => {
  const index = h.cursor++;
  if (!(index in h.values)) h.values[index] = initial;
  return [h.values[index], (next: unknown) => { h.values[index] = typeof next === "function" ? next(h.values[index]) : next; }];
} }));
function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (!isValidElement<{ children?: ReactNode }>(node)) return [];
  return [node as ReactElement<Record<string, unknown>>, ...Children.toArray(node.props.children).flatMap(elements)];
}
function render(status?: GoogleStatus) {
  if (status) h.values[0] = status;
  h.cursor = 0;
  return elements(GoogleDialog({ open: true, onOpenChange: vi.fn() }));
}
function button(nodes: ReturnType<typeof render>, label: string) { return nodes.find((n) => n.props.children === label && typeof n.props.onClick === "function")!; }
const connected: GoogleStatus = { storageError: false, configured: true, mode: "paste", configError: null, account: { email: "viewer@example.invalid", capabilities: ["drive.read"], needsReauthorization: false } };
beforeEach(() => { h.values = []; h.cursor = 0; vi.clearAllMocks(); });
it("shows absent configuration and disables connecting", () => {
  const nodes = render({ storageError: false, configured: false, mode: null, configError: "Create google/client.json", account: null });
  expect(button(nodes, "google.connect").props.disabled).toBe(true);
  expect(JSON.stringify(nodes)).toContain("google.notConfigured");
  expect(JSON.stringify(nodes)).toContain("google.configHelp");
  expect(JSON.stringify(nodes)).not.toContain("Create google/client.json");
});
it("offers a paste box only in paste mode and requires disconnect confirmation", async () => {
  const nodes = render(connected);
  expect(nodes.some((n) => n.props["aria-label"] === "google.pasteLabel")).toBe(true);
  (button(nodes, "google.disconnect").props.onClick as () => void)();
  expect(h.disconnect).not.toHaveBeenCalled();
  const confirmation = render();
  expect(JSON.stringify(confirmation)).toContain("google.confirmDisconnect");
  h.disconnect.mockResolvedValue({ ...connected, account: null });
  await (button(confirmation, "google.disconnect").props.onClick as () => Promise<void>)();
  await vi.waitFor(() => expect(h.disconnect).toHaveBeenCalledOnce());
  expect(render({ ...connected, mode: "callback" }).some((n) => n.props["aria-label"] === "google.pasteLabel")).toBe(false);
});
it("identifies supported links without accepting lookalikes or encoded traversal", () => {
  expect(containsDriveUrl("Please summarize https://drive.google.com/open?id=abcDEF_0123456789")).toBe(true);
  expect(containsDriveUrl("https://drive.google.com/file/d/abcDEF_0123456789/preview?resourcekey=resourceKey_12345")).toBe(true);
  for (const value of ["http://drive.google.com/open?id=abcDEF_0123456789", "https://drive.google.com.evil.example/open?id=abcDEF_0123456789", "https://user@drive.google.com/open?id=abcDEF_0123456789", "https://drive.google.com/file/d/abcDEF_0123456789/%2e%2e/view"]) expect(containsDriveUrl(value)).toBe(false);
});
it("provides both dictionaries for every Google string and callback result", () => {
  for (const key of Object.keys(en).filter((k) => k.startsWith("google.")) as (keyof typeof en)[]) expect(zhTW[key]).toBeTruthy();
  for (const result of ["connected", "denied", "expired_state", "failed"] as const) expect(en[`google.${result}`]).toBeTruthy();
});

it.each([
  "not_configured", "not_connected", "missing_capability", "reauthorize", "expired_state",
  "denied", "failed", "invalid_url", "wrong_mode", "unknown_capability", "storage_error",
] as const)("renders only the localized message for %s", async (code) => {
  const failure = Object.assign(new Error("raw-server-secret"), { code });
  expect(googleErrorMessage(failure)).toBe(`google.error.${code}`);
  h.connect.mockRejectedValueOnce(failure);
  const nodes = render(connected);
  (button(nodes, "google.connect").props.onClick as () => void)();
  await vi.waitFor(() => expect(render().some((n) =>
    n.props.role === "alert" && n.props.children === `google.error.${code}`,
  )).toBe(true));
  expect(JSON.stringify(render())).not.toContain("raw-server-secret");
});

it.each([
  new Error("raw-network-secret"),
  { code: "unknown-provider-code", message: "raw-server-secret" },
  { code: "__proto__", message: "raw-server-secret" },
  { code: 400, message: "raw-server-secret" },
  null,
])("falls back to a fixed local message for unknown errors: %j", (failure) => {
  expect(googleErrorMessage(failure)).toBe("google.requestFailed");
});

it("offers confirmed disconnect recovery even without a readable account", async () => {
  const broken = { ...connected, storageError: true, account: null };
  const nodes = render(broken);
  expect(nodes.some((n) => n.props.role === "alert" && n.props.children === "google.error.storage_error")).toBe(true);
  expect(button(nodes, "google.connect").props.disabled).toBe(true);
  (button(nodes, "google.disconnect").props.onClick as () => void)();
  expect(h.disconnect).not.toHaveBeenCalled();
  h.disconnect.mockResolvedValueOnce({ ...broken, storageError: false });
  (button(render(), "google.disconnect").props.onClick as () => void)();
  await vi.waitFor(() => expect(h.disconnect).toHaveBeenCalledOnce());
  await vi.waitFor(() => expect(JSON.stringify(render())).not.toContain("google.error.storage_error"));
});
