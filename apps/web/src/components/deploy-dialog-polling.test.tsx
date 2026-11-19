import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import type { DeployStatus } from "@agent-hub/shared";
import { DeployDialog } from "./deploy-dialog";
import { Button } from "./ui/button";

const harness = vi.hoisted(() => ({
  values: [] as unknown[], cursor: 0, effects: [] as (() => void)[],
  status: vi.fn(), deploy: vi.fn(),
}));
vi.mock("@/lib/client", () => ({ client: { deployStatus: harness.status, deploy: harness.deploy } }));
vi.mock("@/i18n", async (original) => ({ ...await original<object>(), useLanguage: () => "en" }));
vi.mock("react", async (original) => ({
  ...await original<object>(),
  useState: (initial: unknown) => {
    const index = harness.cursor++;
    if (!(index in harness.values)) harness.values[index] = initial;
    return [harness.values[index], (next: unknown) => { harness.values[index] = next; }];
  },
  useRef: (initial: unknown) => {
    const index = harness.cursor++;
    if (!(index in harness.values)) harness.values[index] = { current: initial };
    return harness.values[index];
  },
  useEffect: (effect: () => (() => void) | undefined, deps: unknown[]) => {
    const index = harness.cursor++;
    const previous = harness.values[index] as { deps: unknown[]; cleanup?: () => void } | undefined;
    if (previous && deps.every((value, at) => value === previous.deps[at])) return;
    harness.effects.push(() => {
      previous?.cleanup?.();
      harness.values[index] = { deps, cleanup: effect() };
    });
  },
}));
const sha = "b".repeat(40);
const initial: DeployStatus = {
  enabled: true, current: { sha: "a".repeat(40), subject: "Old" }, target: { sha, subject: "New" },
  pending: [{ sha, subject: "New" }], dirty: false, last: null, history: null, deploying: false,
};
const last = { sha, requestedAt: "2026-01-01T00:00:00Z", outcome: "running" as const };
function nodes(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (!isValidElement<{ children?: ReactNode }>(node)) return [];
  return [node as ReactElement<Record<string, unknown>>, ...Children.toArray(node.props.children).flatMap(nodes)];
}
function render(open = true) {
  harness.cursor = 0;
  const tree = DeployDialog({ open, onOpenChange: () => {}, tasks: [] });
  for (const effect of harness.effects.splice(0)) effect();
  return nodes(tree);
}
function confirm() { return render().find((node) => node.type === Button)!; }
beforeEach(() => {
  vi.useFakeTimers(); harness.values = []; harness.effects = []; harness.cursor = 0;
  harness.status.mockReset().mockResolvedValue(initial);
  harness.deploy.mockReset().mockResolvedValue({ ...initial, deploying: true, last });
});
afterEach(() => { render(false); vi.useRealTimers(); });
it.each(["succeeded", "failed"] as const)("confirms the displayed SHA and polls through restart errors until %s", async (outcome) => {
  render(); await vi.advanceTimersByTimeAsync(0);
  expect(confirm().props.disabled).toBe(false);
  await (confirm().props.onClick as () => Promise<void>)();
  expect(harness.deploy).toHaveBeenCalledWith(sha);
  harness.status.mockRejectedValue(new Error("server restarting"));
  render(); await vi.advanceTimersByTimeAsync(3000);
  expect(confirm().props.disabled).toBe(true);
  const calls = harness.status.mock.calls.length;
  harness.status.mockResolvedValue({ ...initial, current: initial.target, last: { ...last, outcome, log: outcome === "failed" ? "build failed" : undefined }, deploying: false });
  await vi.advanceTimersByTimeAsync(3000);
  const result = render();
  expect(harness.status.mock.calls.length).toBeGreaterThan(calls);
  const finalCalls = harness.status.mock.calls.length;
  await vi.advanceTimersByTimeAsync(9000);
  expect(harness.status).toHaveBeenCalledTimes(finalCalls);
  if (outcome === "failed") expect(result.some((node) => node.type === "pre" && node.props.children === "build failed")).toBe(true);
});
it("keeps polling when a delayed response contains an older failure for the same SHA", async () => {
  render(); await vi.advanceTimersByTimeAsync(0);
  await (confirm().props.onClick as () => Promise<void>)();
  harness.status.mockResolvedValue({ ...initial, last: { ...last, requestedAt: "2025-01-01T00:00:00Z", outcome: "failed" } });
  render(); await vi.advanceTimersByTimeAsync(0); render();
  const calls = harness.status.mock.calls.length;
  await vi.advanceTimersByTimeAsync(3000);
  expect(harness.status.mock.calls.length).toBeGreaterThan(calls);
  expect(confirm().props.disabled).toBe(true);
});
