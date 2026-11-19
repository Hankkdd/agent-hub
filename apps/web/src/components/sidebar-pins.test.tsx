import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import type { Task } from "@agent-hub/shared";
import { Sidebar } from "./sidebar";
import { SidebarTaskRow } from "./sidebar-task-row";
import { SidebarProject } from "./sidebar-project";

// Exercise the existing component callbacks without adding a browser/DOM framework.
const harness = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, pin: vi.fn() }));
vi.mock("@/lib/client", () => ({ client: { setPinned: harness.pin }, useTaskSummaries: () => [] }));
vi.mock("@/i18n", async (original) => ({ ...await original<object>(), useLanguage: () => "en" }));
vi.mock("react", async (original) => ({
  ...await original<object>(), useEffect: () => {},
  useRef: (initial: unknown) => {
    const index = harness.cursor++;
    harness.values[index] ??= { current: initial };
    return harness.values[index];
  },
  useState: (initial: unknown) => {
    const index = harness.cursor++;
    if (!(index in harness.values)) harness.values[index] = typeof initial === "function" ? initial() : initial;
    return [harness.values[index], (next: unknown) => {
      harness.values[index] = typeof next === "function" ? next(harness.values[index]) : next;
    }];
  },
}));
const task: Task = { id: "task", title: "Plan", workflow: "plan", status: "idle", activity: null, cwd: null, workspace: null, options: { pinnedAt: "2026-01-01" }, sessions: [], createdAt: "", updatedAt: "" };
function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (!isValidElement<{ children?: ReactNode }>(node)) return [];
  return [node as ReactElement<Record<string, unknown>>, ...Children.toArray(node.props.children).flatMap(elements)];
}
function render(tasks = [task]) {
  harness.cursor = 0;
  return Sidebar({ tasks, selectedId: null, onSelect: vi.fn(), onNew: vi.fn(), onNewChat: vi.fn(), onDevices: vi.fn(), devicesOpen: false,
    quota: {} as Parameters<typeof Sidebar>[0]["quota"], refreshQuota: vi.fn(), connection: "live" });
}
function presentations() {
  const nodes = elements(render());
  const shortcut = nodes.find((n) => n.type === SidebarTaskRow)!;
  const group = nodes.find((n) => typeof n.type === "function" && Array.isArray(n.props.tasks) && (n.props.tasks as unknown[]).length > 0)!;
  const original = elements((group.type as (props: unknown) => ReactNode)(group.props)).find((n) => n.type === SidebarTaskRow)!;
  return { shortcut, original };
}
beforeEach(() => { harness.values = []; harness.cursor = 0; harness.pin.mockReset(); });
it("shares pending/error state across both rows, coalesces rapid actions, and allows retry", async () => {
  let reject!: (error: Error) => void;
  harness.pin.mockImplementation(() => new Promise((_, fail) => { reject = fail; }));
  const { shortcut, original } = presentations();
  const pin = shortcut.props.onPin as (task: Task) => Promise<void>;
  const pending = pin(task);
  await (original.props.onPin as typeof pin)(task);
  expect(harness.pin).toHaveBeenCalledTimes(1);
  expect(harness.pin).toHaveBeenCalledWith(task.id, false);
  const saving = presentations();
  expect(saving.shortcut.props.pinState).toEqual({ pending: true });
  expect(saving.original.props.pinState).toBe(saving.shortcut.props.pinState);
  reject(new Error("failure")); await pending;
  const failed = presentations();
  expect(failed.shortcut.props.pinState).toEqual({ error: true });
  expect(failed.original.props.pinState).toBe(failed.shortcut.props.pinState);
  harness.pin.mockResolvedValue(undefined);
  await (failed.original.props.onPin as typeof pin)(task);
  expect(presentations().shortcut.props.pinState).toEqual({});
  expect(task.options.pinnedAt).toBe("2026-01-01");
});
it("hides the empty section and inserts shortcuts before all unchanged original project groups", () => {
  const nodes = elements(render());
  expect(nodes.findIndex((n) => n.type === SidebarTaskRow)).toBeLessThan(nodes.findIndex((n) => n.type === SidebarProject));
  const withoutPins = elements(render([{ ...task, options: {} }]));
  expect(withoutPins.filter((n) => n.type === SidebarTaskRow)).toHaveLength(0);
  expect(withoutPins.filter((n) => n.type === SidebarProject)).toHaveLength(1);
});
