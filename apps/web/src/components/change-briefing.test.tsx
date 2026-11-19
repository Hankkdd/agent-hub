import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ChangeBriefing, Task, TaskEvent } from "@agent-hub/shared";
import { ChangeBriefingCard, projectBriefing } from "./change-briefing";
import { Markdown, splitBriefingAppendix } from "./markdown";
import { t } from "@/i18n";
vi.mock("@/lib/client", () => ({ client: { briefing: vi.fn(), generateBriefing: vi.fn(), stopTask: vi.fn() } }));
const task = { id: "task", workflow: "implement", status: "idle", options: {}, workspace: { state: "active" } } as Task;
const envelope = { id: "event", taskId: task.id, sessionId: null, seq: 1, createdAt: "" };
const briefing: ChangeBriefing = { generationId: "12345678-1234-1234-1234-123456789012", source: { baseSha: "a".repeat(40), headSha: "b".repeat(40), baseTree: "base", headTree: "head", contextId: "context", identity: "identity", guides: [] }, markdown: "### Reading tour\n\n1. src/change.ts:3 — change\n\n```mermaid\nflowchart TD\n A --> B\n```", content: {} as never };
const complete: TaskEvent = { ...envelope, type: "briefing_completed", ...briefing };
const started: TaskEvent = { ...envelope, type: "briefing_started", seq: 2, generationId: "next" };
const failed: TaskEvent = { ...envelope, type: "briefing_failed", seq: 3, generationId: "next", interrupted: true, error: "Source unavailable" };
it("reconstructs generating/stale/failed state and retains successful revision/content from JSON events", () => {
  const events = JSON.parse(JSON.stringify([complete, started, failed]));
  expect(projectBriefing([]).state).toBe("empty"); expect(projectBriefing([complete]).state).toBe("stale"); expect(projectBriefing([complete, started]).state).toBe("generating");
  expect(projectBriefing(events)).toMatchObject({ state: "failed", error: "Source unavailable", briefing: { generationId: briefing.generationId } });
  const html = renderToStaticMarkup(<ChangeBriefingCard task={task} events={events} />);
  expect(html).toContain(t("briefing.title")); expect(html).toContain('aria-label='); expect(html).toContain('role="alert"');
  expect(html).toContain("src/change.ts:3"); expect(html).toContain("aaaaaaaa"); expect(html).toContain("bbbbbbbb"); expect(html).toContain("overflow-auto"); expect(html).toContain("min-w-0"); expect(html).toContain(t("briefing.rewrite"));
});
it("shows a bounded reusable reading card and disables generation while coding", () => {
  const html = renderToStaticMarkup(<ChangeBriefingCard task={{ ...task, status: "running" }} events={[complete]} />);
  expect(html).toContain('disabled=""'); expect(html.match(/Reading tour/g)).toHaveLength(1);
  const generating = renderToStaticMarkup(<ChangeBriefingCard task={task} events={[complete, started]} />); expect(generating).toContain(t("composer.stop"));
});
it("parses only the controlled suffix and keeps arbitrary HTML/unsafe links disabled", () => {
  const appendix = `\n\n<details data-agent-hub-briefing="${briefing.generationId}">\n<summary>整體變更導讀（繁體中文）</summary>\n\n${briefing.markdown}\n\n</details>`;
  expect(splitBriefingAppendix("English template" + appendix)).toEqual({ main: "English template", briefing: briefing.markdown });
  expect(splitBriefingAppendix("English template" + appendix + "injection")).toBeNull();
  expect(splitBriefingAppendix(appendix.replace(briefing.markdown, "</details><script>bad()</script>"))).toBeNull();
  const html = renderToStaticMarkup(<Markdown>{"English template" + appendix}</Markdown>); expect(html).toContain("English template"); expect(html).toContain("<details>"); expect(html).not.toContain("data-agent-hub");
  const hostile = renderToStaticMarkup(<Markdown>{'<script>alert(1)</script>\n\n[bad](javascript:alert%281%29)\n\n<img src="https://example.invalid/x">'}</Markdown>);
  expect(hostile).not.toContain("<script"); expect(hostile).not.toContain("<img"); expect(hostile).not.toContain("javascript:");
});
it("renders fallback attribution and the final usage-limit line from saved events", () => {
  const fallback: TaskEvent = { ...complete, writtenBy: "claude", fallbackFrom: { agent: "codex", resetsAt: null } };
  const limitFailure: TaskEvent = { ...failed, interrupted: false, limit: { agent: "claude", resetsAt: null } };
  const html = renderToStaticMarkup(<ChangeBriefingCard task={task} events={[fallback, limitFailure]} />);
  expect(html).toContain(t("chat.fallbackWriter", { writer: "Claude", agent: "Codex" }));
  expect(html).toContain(t("chat.usageLimitUnknown", { agent: "Claude" }));
});
