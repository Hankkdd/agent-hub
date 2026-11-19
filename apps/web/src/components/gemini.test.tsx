import { afterEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ProviderQuota, QuotaResponse, Task, WorkflowId } from "@agent-hub/shared";
import { setLanguage, t } from "@/i18n";
import { taskAgents } from "./new-task-defaults";
import { QuotaSummary } from "./quota-summary";
import { quotaPauseText, usageLimitText } from "./status";
import { handoffControlState } from "./switch-agent-dialog";

vi.mock("@/i18n", async original => ({ ...await original<object>(), useLanguage: () => "en" }));
vi.mock("@/lib/client", () => ({ client: {}, label: (agent: string) => agent }));
afterEach(() => setLanguage("zh-TW"));

it("offers Gemini only for chat and only when its adapter is available", () => {
  expect(taskAgents("chat", true)).toContain("gemini");
  expect(taskAgents("chat", false)).not.toContain("gemini");
  for (const workflow of ["implement", "review", "plan", "video", "custom"] as WorkflowId[]) expect(taskAgents(workflow, true)).not.toContain("gemini");
});
it.each(["en", "zh-TW"] as const)("uses the Gemini name and restrictions in %s", language => {
  setLanguage(language);
  expect(t("agent.gemini")).toBe("Gemini");
  expect(quotaPauseText({ agent: "gemini", resetsAt: null })).toContain("Gemini");
  expect(usageLimitText({ agent: "gemini", resetsAt: null })).toContain("Gemini");
  expect(t("newTask.geminiHint")).toContain("Gemini");
});
it.each(["en", "zh-TW"] as const)("shows unknown Gemini quota only when configured in %s", language => {
  setLanguage(language);
  const provider: ProviderQuota = { provider: "claude", status: "unknown", windows: [], updatedAt: null, stale: false, nextRefreshAt: "", manualRefreshAt: "" };
  const data: QuotaResponse = { claude: provider, codex: { ...provider, provider: "codex" } };
  const render = () => renderToStaticMarkup(<QuotaSummary state={{ data, loading: false, error: false, now: 0 }} refresh={() => {}} />);
  expect(render()).not.toContain("Gemini");
  data.gemini = { ...provider, provider: "gemini" };
  expect(render()).toContain("Gemini");
  expect(render()).toContain(t("quota.unknown"));
});
it("does not offer a Gemini chat as a source for handoff summary generation", () => {
  const task = { workflow: "chat", options: {}, sessions: [{ id: "s", agent: "gemini", role: "main" }] } as Task;
  expect(handoffControlState(task, []).eligible).toBe(false);
});
