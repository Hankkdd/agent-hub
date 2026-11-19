import { beforeEach, expect, it, vi } from "vitest";
import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import type { Task, TaskEvent } from "@agent-hub/shared";
import { TaskView } from "./task-view";
import { ChatTab } from "./chat-tab";
import { QuotaPauseBanner } from "./quota-pause-banner";
import { Composer } from "./composer";
import { AskCard } from "./ask-card";
import { SwitchAgentDialog } from "./switch-agent-dialog";
import { TabsContent } from "./ui/tabs";
import { Button } from "./ui/button";
import { setLanguage, t } from "@/i18n";

const harness = vi.hoisted(() => ({
  values: [] as unknown[], cursor: 0, events: [] as TaskEvent[], phone: false,
  continueNow: vi.fn(), stopWaiting: vi.fn(), sendMessage: vi.fn(), stopTask: vi.fn(),
}));
vi.mock("react", async (original) => ({
  ...await original<object>(),
  useState: (initial: unknown) => {
    const index = harness.cursor++;
    if (!(index in harness.values)) harness.values[index] = initial;
    return [harness.values[index], (next: unknown) => { harness.values[index] = next; }];
  },
  useRef: () => ({ current: { focus: focusComposer } }),
  useEffect: () => {},
}));
const focusComposer = vi.fn();
vi.mock("@/i18n", async (original) => ({ ...await original<object>(), useLanguage: () => "en" }));
vi.mock("@/lib/use-phone", () => ({ usePhone: () => harness.phone }));
vi.mock("@/lib/client", () => ({
  client: { continueNow: harness.continueNow, stopWaiting: harness.stopWaiting, sendMessage: harness.sendMessage, stopTask: harness.stopTask },
  useEvents: () => harness.events, useTasks: () => [], label: (agent: string) => agent,
}));
const task: Task = {
  id: "paused-task", title: "Paused task", status: "paused", activity: null, workflow: "chat",
  cwd: "/tmp/example", workspace: null, sessions: [], createdAt: "", updatedAt: "",
  options: { quotaPause: { agent: "codex", resetsAt: null, since: "" } },
};
const ask: Extract<TaskEvent, { type: "ask" }> = {
  id: "ask", taskId: task.id, sessionId: null, seq: 1, createdAt: "", type: "ask", question: "Choose an option",
};
function nodes(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (!isValidElement<{ children?: ReactNode }>(node)) return [];
  return [node as ReactElement<Record<string, unknown>>, ...Children.toArray(node.props.children).flatMap(nodes)];
}
function view(selected = task) {
  harness.cursor = 0;
  return TaskView({ task: selected, onSelectTask: () => {}, onBack: () => {} });
}
function banner() {
  harness.cursor = 0;
  return QuotaPauseBanner({ task, events: harness.events });
}
function control(tree: ReactNode, key: "quotaPause.continueNow" | "quotaPause.stopWaiting") {
  return nodes(tree).find((node) => node.type === Button && node.props.children === t(key))!;
}
beforeEach(() => {
  harness.values = []; harness.cursor = 0; harness.events = []; harness.phone = false;
  vi.clearAllMocks(); harness.continueNow.mockResolvedValue(undefined); harness.stopWaiting.mockResolvedValue(undefined);
  setLanguage("en");
});

it.each([false, true])("places exactly one quota card in a bounded sibling footer before Composer (phone=%s)", (phone) => {
  harness.phone = phone;
  harness.events = Array.from({ length: 200 }, (_, index): TaskEvent => ({
    id: `message-${index}`, taskId: task.id, sessionId: null, seq: index + 1, createdAt: "",
    type: "agent_text", text: `Historical message ${index}`,
  }));
  const tree = view();
  const children = Children.toArray(tree.props.children).filter(isValidElement) as ReactElement<Record<string, unknown>>[];
  const footer = children.find((node) => String(node.props.className).includes("task-action-footer"))!;
  expect(children.indexOf(footer)).toBe(children.findIndex((node) => node.type === Composer) - 1);
  expect(nodes(footer).filter((node) => node.type === QuotaPauseBanner)).toHaveLength(1);
  expect(nodes(tree).filter((node) => node.type === QuotaPauseBanner)).toHaveLength(1);
  expect(footer.props.className).toContain("max-h-[min(40%,40dvh)]");
  expect(footer.props.className).toContain("shrink-0");
  expect(footer.props.className).toContain("overflow-y-auto");
  for (const content of nodes(tree).filter((node) => node.type === TabsContent)) {
    expect(nodes(content).some((node) => node.type === QuotaPauseBanner)).toBe(false);
  }
  harness.cursor = 0;
  const transcript = ChatTab({ task, events: harness.events, onSelectTask: () => {} });
  expect(nodes(transcript).some((node) => node.type === QuotaPauseBanner)).toBe(false);
  expect(nodes(transcript).filter((node) => !!node.props.event)).toHaveLength(200);
});

it("clears the card on tab/status changes and binds a fresh card to the selected task", () => {
  const changeTab = view().props.onValueChange!;
  for (const tab of ["diff", "events"]) {
    changeTab(tab);
    expect(nodes(view()).some((node) => node.type === QuotaPauseBanner)).toBe(false);
  }
  changeTab("chat");
  for (const status of ["idle", "running", "waiting_user", "done", "failed", "interrupted"] as const) {
    expect(nodes(view({ ...task, status })).some((node) => node.type === QuotaPauseBanner)).toBe(false);
  }
  const first = nodes(view()).find((node) => node.type === QuotaPauseBanner)!;
  const nextTask = { ...task, id: "other-paused-task" };
  const second = nodes(view(nextTask)).find((node) => node.type === QuotaPauseBanner)!;
  expect(first.key).not.toBe(second.key);
  expect(second.props.task).toBe(nextTask);
  expect(nodes(view({ ...nextTask, status: "idle" })).some((node) => node.type === QuotaPauseBanner)).toBe(false);
});

it("shares one bounded footer with an open AskCard and preserves composer focus/send/stop", async () => {
  harness.events = [ask];
  const tree = view();
  const footer = nodes(tree).find((node) => String(node.props.className).includes("task-action-footer"))!;
  const askNode = nodes(footer).find((node) => node.type === AskCard)!;
  expect(askNode.props.event).toBe(ask);
  expect(nodes(footer).filter((node) => node.type === QuotaPauseBanner)).toHaveLength(1);
  (askNode.props.onOther as () => void)();
  expect(focusComposer).toHaveBeenCalledOnce();
  const composer = nodes(tree).find((node) => node.type === Composer)!;
  await (composer.props.onSend as (text: string, images: unknown[]) => Promise<void>)("Reply", []);
  await (composer.props.onStop as () => Promise<void>)();
  expect(harness.sendMessage).toHaveBeenCalledWith(task.id, "Reply", []);
  expect(harness.stopTask).toHaveBeenCalledWith(task.id);
  expect(nodes(view({ ...task, status: "waiting_user" })).some((node) => node.type === AskCard)).toBe(true);
  harness.events = [{ ...ask, answer: "Answered" }];
  expect(nodes(view()).some((node) => node.type === AskCard)).toBe(false);
});

it.each(["quotaPause.continueNow", "quotaPause.stopWaiting"] as const)("preserves %s callbacks, pending disables, and error feedback", async (key) => {
  let reject!: (error: Error) => void;
  const request = new Promise<void>((_, fail) => { reject = fail; });
  const action = key === "quotaPause.continueNow" ? harness.continueNow : harness.stopWaiting;
  action.mockReturnValueOnce(request);
  const click = control(banner(), key).props.onClick as () => Promise<void>;
  const pending = click();
  expect(action).toHaveBeenCalledWith(task.id);
  for (const name of ["quotaPause.continueNow", "quotaPause.stopWaiting"] as const) expect(control(banner(), name).props.disabled).toBe(true);
  reject(new Error("Request failed")); await pending;
  expect(nodes(banner()).some((node) => node.props.children === "Request failed")).toBe(true);
  expect(control(banner(), key).props.disabled).toBe(false);
  await (control(banner(), key).props.onClick as () => Promise<void>)();
  expect(nodes(banner()).some((node) => node.props.children === "Request failed")).toBe(false);
});

it("passes the selected task/events to the existing switch control and wraps action buttons", () => {
  const tree = banner();
  const switchControl = nodes(tree).find((node) => node.type === SwitchAgentDialog)!;
  expect(switchControl.props.task).toBe(task);
  expect(switchControl.props.events).toBe(harness.events);
  expect((switchControl.props.triggerLabel as (target: string) => string)("claude")).toBe(t("quotaPause.switchTo", { agent: "claude" }));
  expect(nodes(tree).some((node) => String(node.props.className).includes("flex-wrap") && String(node.props.className).includes("[&_button]:whitespace-normal"))).toBe(true);
});


it.each(["zh-TW", "en"] as const)("explains quota queueing in the paused composer in %s", language => {
  setLanguage(language);
  const composer = nodes(view()).find(node => node.type === Composer)!;
  expect(composer.props.placeholder).toBe(t("composer.quotaPlaceholder"));
  expect(composer.props.running).toBe(false);
  const resumed = nodes(view({ ...task, status: "running", options: {} })).find(node => node.type === Composer)!;
  expect(resumed.props.placeholder).toBeUndefined();
});

it("shows applied pack tags with short hashes and hides metadata without packs", () => {
  const applied = { tag: "sample-checks", sha256: "abcdef1234567890", roles: ["author"] as const, text: "" };
  const selected = { ...task, options: { appliedRules: [{ ...applied, roles: [...applied.roles] }] } };
  const badges = nodes(view(selected)).filter(node => node.props.title === t("task.appliedRule"));
  expect(badges).toHaveLength(1);
  expect(Children.toArray(badges[0]!.props.children as ReactNode).join("")).toBe("sample-checks · abcdef1");
  expect(nodes(view()).filter(node => node.props.title === t("task.appliedRule"))).toHaveLength(0);
});
