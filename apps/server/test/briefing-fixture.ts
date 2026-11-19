import type { AgentRunInput } from "../src/agents/types";
import type { FakeStep } from "../src/agents/fake";
import type { BriefingCapture } from "../src/core/briefing";

/** Scripted structured output from the supplied immutable material, never a real model. */
export function briefingFixture(input: AgentRunInput): FakeStep[] | null {
  if (!input.systemPrompt?.startsWith("Generate a whole-change reference card")) return null;
  const captured = JSON.parse(input.prompt) as BriefingCapture;
  const text = JSON.stringify({
    problem: `修正指定行為 ${captured.context.issue ? `#${captured.context.issue.number}` : ""} ${captured.context.ticket ?? ""}`,
    before: "變更前尚未具備此行為。", after: "變更後依照要求提供行為。",
    diagram: "flowchart TD\n  Request --> Change",
    tour: captured.change.files.map((f) => {
      const common = { path: f.path, revision: f.deleted ? "base" : "head", supporting: false, explanation: (f.generated ? "此為產生的鎖定檔，完整差異已提供，未變更的其餘來源未提供。" : "") + "此檔案依照已保存的要求變更，測試與文件也包含在閱讀順序中。" };
      if (f.text === "") return { ...common, kind: "file" };
      const lines = f.text.split("\n");
      const index = Math.max(0, lines.findIndex((s) => /[a-zA-Z0-9_]+/.test(s)));
      return { ...common, line: index + 1, symbol: lines[index]!.match(/[a-zA-Z0-9_]+/)?.[0] ?? "" };
    }),
    rationale: "依據已保存的使用者要求與提供的變更來源。", alternatives: "未提供歷史決策，其他替代方案的取捨未知。",
    risks: "測試證據僅限提供的 test_result；實際模型的解釋品質仍需人工確認。",
    questions: [{ question: "如何確認行為？", answer: "可參考閱讀順序所列的來源與已保存的測試結果。" }],
    references: [
      { section: "rationale", kind: "source", source: "event:0" },
      { section: "alternatives", kind: "unknown", source: "" },
      { section: "risks", kind: "inference", source: `file:${captured.change.files[0]!.path}` },
      { section: "questions", kind: "source", source: `file:${captured.change.files[0]!.path}` },
    ],
    uncertainty: "無其他已知來源缺漏；來源之外的歷史為未知。",
  });
  return [{ type: "text_delta", text }, { type: "done", ok: true }];
}
