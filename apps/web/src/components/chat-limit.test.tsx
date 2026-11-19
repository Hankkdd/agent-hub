import { afterEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Task, TaskEvent } from "@agent-hub/shared";
import { ChatTab } from "./chat-tab";
import { setLanguage, t } from "@/i18n";

vi.mock("@/lib/client", () => ({ client: {}, label: (agent: string) => agent === "codex" ? "Codex" : "Claude" }));

const task = { id: "task", workflow: "chat", status: "failed", options: {}, sessions: [] } as unknown as Task;
afterEach(() => { setLanguage("zh-TW"); vi.useRealTimers(); });
it.each(["zh-TW", "en"] as const)("renders localized quota warnings and secondary raw errors in %s", language => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 9, 15, 8));
  setLanguage(language);
  for (const day of [null, 15, 16]) {
    const event: TaskEvent = { id: "result", taskId: task.id, sessionId: null, seq: 1, createdAt: "", type: "turn_result", ok: false, error: "Raw provider error", limit: { agent: "codex", resetsAt: day ? new Date(2026, 9, day, 21, 41).toISOString() : null } };
    const html = renderToStaticMarkup(<ChatTab task={task} events={[event]} onSelectTask={() => {}} />);
    const time = day === 16 ? "10/16 21:41" : "21:41";
    expect(html).toContain(t(day ? "chat.usageLimitReset" : "chat.usageLimitUnknown", { agent: "Codex", time }));
    expect(html).toMatch(/<pre class="[^"]*text-muted-foreground">Raw provider error<\/pre>/);
  }
});

it.each([{ result: [1, true] }, null, false, 0])("renders structured output as formatted JSON: %j", output => {
  const event: TaskEvent = { id: "result", taskId: task.id, sessionId: null, seq: 1, createdAt: "", type: "turn_result", ok: true, output };
  const html = renderToStaticMarkup(<ChatTab task={task} events={[event]} onSelectTask={() => {}} />);
  expect(html).toContain("<code>");
  expect(html).toContain(JSON.stringify(output, null, 2).replaceAll('"', "&quot;"));
});
