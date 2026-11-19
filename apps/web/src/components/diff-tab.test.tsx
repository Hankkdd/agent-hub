import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import type { Task, TaskEvent } from "@agent-hub/shared";
import { DiffTab } from "./diff-tab";
import { client } from "@/lib/client";
import { setLanguage, t } from "@/i18n";

const state = vi.hoisted(() => ({ setters: [] as ReturnType<typeof vi.fn>[], phone: false, started: null as { id: string; afterSeq: number } | null }));
vi.mock("react", async (original) => ({ ...await original<typeof import("react")>(),
  useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
  useEffect: vi.fn(), useCallback: (fn: unknown) => fn,
  useState: (initial: unknown) => {
    const setter = vi.fn(); state.setters.push(setter);
    return [state.setters.length === 10 && state.started ? state.started : typeof initial === "function" ? initial() : initial, setter];
  },
}));
vi.mock("@/lib/use-phone", () => ({ usePhone: () => state.phone }));
vi.mock("@/lib/client", () => ({ client: { abandonPrUpdate: vi.fn(), updatePr: vi.fn(), diff: vi.fn(async () => []), explanations: vi.fn(async () => ({ event: null })) } }));
const revision = { head: "feature/task", headSha: "a".repeat(40), target: "release/v2", targetSha: "b".repeat(40), crossRepository: false };
const task: Task = { id: "worker", title: "Worker", workflow: "implement", status: "idle", activity: null, cwd: "/example/worktree", options: {}, sessions: [], createdAt: "", updatedAt: "", workspace: { id: "ws", repoPath: "/example/repo", worktreePath: "/example/worktree", branch: revision.head, baseRef: "release/v1", baseSha: "c".repeat(40), state: "active", github: "example/repo", pr: { number: 41, url: "https://github.com/example/repo/pull/41", state: "open", revision } } };
type Node = ReactElement<{ children?: unknown; onClick?: () => void; disabled?: boolean; href?: string; className?: string }>;
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as Node;
  return [node, ...nodes(node.props.children)];
}
function texts(value: unknown): string {
  if (Array.isArray(value)) return value.map(texts).join("");
  if (value && typeof value === "object" && "props" in value) return texts((value as Node).props.children);
  return typeof value === "string" ? value : "";
}
function view(current = task, events: TaskEvent[] = []) {
  state.setters = [];
  const root = DiffTab({ task: current, events, onShowChat: vi.fn() });
  const all = nodes(root);
  return { root, all, abandon: all.find(node => texts(node.props.children) === t("diff.abandonUpdate") && node.props.onClick), update: all.find(node => texts(node.props.children) === t("diff.updatePr") && node.props.onClick)! };
}
beforeEach(() => {
  state.setters = []; state.phone = false; state.started = null;
  vi.clearAllMocks();
  vi.stubGlobal("document", { documentElement: { classList: { contains: () => false } } });
  vi.stubGlobal("window", { confirm: vi.fn(() => true) });
  vi.mocked(client.updatePr).mockResolvedValue({ id: "operation", pr: { repo: "example/repo", number: 41 }, revision, stage: "intent" });
  vi.mocked(client.abandonPrUpdate).mockResolvedValue({ id: "abandon-operation", pr: { repo: "example/repo", number: 41 }, revision, stage: "abandoning" });
});
afterEach(() => { vi.unstubAllGlobals(); setLanguage("zh-TW"); });

it.each(["en", "zh-TW"] as const)("shows actual target and explicit confirmation in %s at desktop and phone widths", async (language) => {
  setLanguage(language);
  for (const phone of [false, true]) {
    state.phone = phone;
    const rendered = view();
    expect(texts(rendered.root)).toContain(t("diff.updateTarget", { target: revision.target }));
    expect(rendered.all.some(n => n.props.className?.includes("flex-wrap"))).toBe(true);
    expect(rendered.update.props.disabled).toBe(false);
    vi.mocked(window.confirm).mockReturnValueOnce(false);
    rendered.update.props.onClick!();
    expect(client.updatePr).not.toHaveBeenCalled();
  }
  const rendered = view(); rendered.update.props.onClick!();
  expect(window.confirm).toHaveBeenLastCalledWith(t("diff.updateConfirm", { target: revision.target, number: 41 }));
  await vi.waitFor(() => expect(client.updatePr).toHaveBeenCalledExactlyOnceWith(task.id, revision));
});
it("directs planning-owned tasks to the original conversation and disables busy or unknown-target actions", () => {
  const owned = view({ ...task, options: { reportsTo: "original-plan" } });
  expect(owned.update.props.disabled).toBe(true);
  expect(owned.all.some(n => n.props.href === "?task=original-plan" && texts(n.props.children) === t("diff.updateInPlan"))).toBe(true);
  expect(view({ ...task, status: "running" }).update.props.disabled).toBe(true);
  expect(view({ ...task, workspace: { ...task.workspace!, pr: { ...task.workspace!.pr!, revision: undefined } } }).update.props.disabled).toBe(true);
});
it("records loading and server errors and clears loading after failure", async () => {
  vi.mocked(client.updatePr).mockRejectedValueOnce(new Error("Target changed; refresh"));
  view().update.props.onClick!();
  expect(state.setters[4]).toHaveBeenCalledWith("update");
  await vi.waitFor(() => expect(state.setters[3]).toHaveBeenCalledWith("Target changed; refresh"));
  expect(state.setters[4]).toHaveBeenLastCalledWith(null);
});

const retained: TaskEvent = { id: "retained", taskId: task.id, seq: 10, sessionId: null, createdAt: "", type: "pr_update",
  update: { id: "old-update", pr: { repo: "example/repo", number: 41 }, revision, stage: "failed", owned: true, preSha: revision.headSha, previousBase: { baseSha: "c".repeat(40) } } };
it.each(["en", "zh-TW"] as const)("confirms abandonment explicitly and keeps planning-owned and uncertain updates protected in %s", async language => {
  setLanguage(language);
  for (const phone of [false, true]) {
    state.phone = phone;
    const current = view(task, [retained]);
    expect(current.abandon?.props.disabled).toBe(false);
    vi.mocked(window.confirm).mockReturnValueOnce(false);
    current.abandon!.props.onClick!();
    expect(client.abandonPrUpdate).not.toHaveBeenCalled();
  }
  view(task, [retained]).abandon!.props.onClick!();
  expect(window.confirm).toHaveBeenLastCalledWith(t("diff.abandonUpdateConfirm"));
  await vi.waitFor(() => expect(client.abandonPrUpdate).toHaveBeenCalledExactlyOnceWith(task.id));
  expect(state.setters[9]).toHaveBeenCalledWith({ id: "abandon-operation", afterSeq: 10 });
  expect(view({ ...task, options: { reportsTo: "plan" } }, [retained]).abandon?.props.disabled).toBe(true);
  const uncertain: TaskEvent = { ...retained, update: { ...retained.update, publication: "uncertain" } };
  expect(view(task, [uncertain]).abandon).toBeUndefined();
  expect(view(task).abandon).toBeUndefined();
});
it("bridges the API/stream gap as running and clears request loading without treating intent as completion", async () => {
  view().update.props.onClick!();
  await vi.waitFor(() => expect(state.setters[9]).toHaveBeenCalledWith({ id: "operation", afterSeq: 0 }));
  expect(state.setters[4]).toHaveBeenLastCalledWith(null);
  state.started = { id: "operation", afterSeq: 0 };
  expect(view().update.props.disabled).toBe(true);
  expect(view(task, [{ ...retained, seq: 1, update: { ...retained.update, id: "operation", owned: false, stage: "abandoned" } }]).update.props.disabled).toBe(false);
});
it("shows abandonment errors and releases request loading while leaving the retained operation available", async () => {
  vi.mocked(client.abandonPrUpdate).mockRejectedValueOnce(new Error("Remote head changed; reconcile first"));
  view(task, [retained]).abandon!.props.onClick!();
  expect(state.setters[4]).toHaveBeenCalledWith("abandon");
  await vi.waitFor(() => expect(state.setters[3]).toHaveBeenCalledWith("Remote head changed; reconcile first"));
  expect(state.setters[4]).toHaveBeenLastCalledWith(null);
});

it.each(["en", "zh-TW"] as const)("shows retained files and their bounded count in %s on desktop and phone", language => {
  setLanguage(language);
  const abandoned: TaskEvent = { ...retained, update: { ...retained.update, stage: "abandoned", owned: false,
    retainedUntracked: { paths: ["unfinished/integration.txt"], total: 3 } } };
  for (const phone of [false, true]) {
    state.phone = phone;
    const current = view(task, [abandoned]);
    expect(texts(current.root)).toContain("unfinished/integration.txt");
    expect(texts(current.root)).toContain(t("prUpdate.leftovers", { count: 3 }));
    expect(texts(current.root)).toContain(t("prUpdate.leftoversTruncated", { count: 2 }));
    expect(current.all.some(node => node.props.className?.includes("overflow-auto"))).toBe(true);
    const empty = view(task, [{ ...abandoned, update: { ...abandoned.update, retainedUntracked: { paths: [], total: 0 } } }]);
    expect(texts(empty.root)).not.toContain(t("prUpdate.leftovers", { count: 0 }));
  }
});
