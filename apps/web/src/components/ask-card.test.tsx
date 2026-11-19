import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { TaskEvent } from "@agent-hub/shared";
import { AskCard } from "./ask-card";
import { t } from "@/i18n";
vi.mock("@/lib/client", () => ({ client: { sendMessage: vi.fn() } }));
const ask = { id: "ask", taskId: "task", sessionId: "session", seq: 1, createdAt: "2026-10-15", type: "ask", question: "Confirm the PR draft" } as Extract<TaskEvent, { type: "ask" }>;
it("offers a free answer as 'something else' only when there are options to differ from", () => {
  const bare = renderToStaticMarkup(<AskCard event={ask} />);
  expect(bare).toContain(t("ask.typeAnswer")); expect(bare).not.toContain(t("ask.other"));
  const choices = renderToStaticMarkup(<AskCard event={{ ...ask, options: [{ label: "Yes", detail: "Publish it" }] }} />);
  expect(choices).toContain(t("ask.other")); expect(choices).not.toContain(t("ask.typeAnswer"));
});
