import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import type { Task } from "@agent-hub/shared";
import { setLanguage } from "@/i18n";
import { SidebarTaskRow } from "./sidebar-task-row";

vi.mock("@/i18n", async (original) => ({ ...await original<object>(), useLanguage: () => "en" }));
const task: Task = { id: "child-id", title: "Worker", workflow: "review", status: "running", activity: null, cwd: null, workspace: null, options: {}, sessions: [], createdAt: "", updatedAt: "" };
function buttons(node: ReactNode): ReactElement<{ onClick: () => void; children?: ReactNode }>[] {
  if (!isValidElement<{ children?: ReactNode }>(node)) return [];
  const descendants = Children.toArray(node.props.children).flatMap(buttons);
  return node.type === "button" ? [node as ReturnType<typeof buttons>[number], ...descendants] : descendants;
}
it.each(["en", "zh-TW"] as const)("uses visible native keyboard/touch buttons, localized task identity and authoritative pressed/pending/error states in %s", (language) => {
  setLanguage(language);
  for (const pinned of [false, true]) {
    const current = { ...task, options: pinned ? { pinnedAt: "2026-01-01" } : {} };
    const html = renderToStaticMarkup(<SidebarTaskRow task={current} state="running" depth={0} selectedId={null} onSelect={() => {}} onPin={() => {}} pinState={{ pending: true }} context="project · Parent: Plan" />);
    expect(html.match(/<button /g)).toHaveLength(2);
    expect(html).not.toMatch(/<button[^>]*>(?:(?!<\/button>)[\s\S])*<button/);
    expect(html).toContain(`aria-pressed="${pinned}"`);
    expect(html).toContain('aria-busy="true"'); expect(html).toContain('disabled=""');
    expect(html).toContain('role="status"'); expect(html).toContain("Worker (child-id)");
    expect(html).toContain(language === "en" ? (pinned ? "Unpin Worker" : "Pin Worker") : (pinned ? "取消置頂 Worker" : "置頂 Worker"));
    expect(html).not.toContain("group-hover");
    const error = renderToStaticMarkup(<SidebarTaskRow task={current} state="running" depth={1} selectedId={task.id} onSelect={() => {}} onPin={() => {}} pinState={{ error: true }} />);
    expect(error).toContain('role="alert"'); expect(error).not.toContain('disabled=""');
    expect(error).toContain(language === "en" ? "Could not save pin" : "無法儲存置頂狀態");
  }
  setLanguage("zh-TW");
});
it("keeps pin and exact-task selection handlers on sibling buttons with no clickable wrapper", () => {
  const select = vi.fn(), pin = vi.fn();
  const row = SidebarTaskRow({ task, state: "running", depth: 0, selectedId: null, onSelect: select, onPin: pin });
  expect(row.type).toBe("div");
  expect(row.props).not.toHaveProperty("onClick");
  const [selection, control] = buttons(row);
  control!.props.onClick();
  expect(pin).toHaveBeenCalledWith(task); expect(select).not.toHaveBeenCalled();
  selection!.props.onClick();
  expect(select).toHaveBeenCalledWith("child-id"); expect(pin).toHaveBeenCalledTimes(1);
});

it("labels transcript-only video tasks and nothing else", () => {
  for (const language of ["en", "zh-TW"] as const) {
    setLanguage(language);
    const label = language === "en" ? "Transcript only" : "只抓逐字稿";
    const api = renderToStaticMarkup(<SidebarTaskRow task={{ ...task, workflow: "video", options: { transcriptOnly: true } }} state="apiTranscripts" depth={0} selectedId={null} onSelect={() => {}} onPin={() => {}} />);
    expect(api).toContain(label);
    const plain = renderToStaticMarkup(<SidebarTaskRow task={{ ...task, workflow: "video", options: {} }} state="standby" depth={0} selectedId={null} onSelect={() => {}} onPin={() => {}} />);
    expect(plain).not.toContain(label);
  }
  setLanguage("zh-TW");
});
