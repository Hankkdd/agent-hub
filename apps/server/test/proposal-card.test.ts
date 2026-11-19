import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { Task, TaskEvent } from "@agent-hub/shared";

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "proposal-card-vite-")); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

it("renders a linked proposal with its persisted issue URL and keeps ordinary proposals unchanged", async () => {
  // Load the real web components through Vite without including browser source in server typechecks.
  const web = path.resolve(import.meta.dirname, "../../web");
  const { createServer } = await import(path.join(web, "node_modules/vite/dist/node/index.js"));
  const server = await createServer({
    root: web, configFile: false,
    resolve: { alias: { "@": path.join(web, "src") } },
    esbuild: { jsx: "automatic" },
    // This SSR-only contract check does not need browser dependency discovery or optimization.
    optimizeDeps: { noDiscovery: true, include: [] },
    cacheDir: path.join(root, "vite-cache"),
    plugins: [{
      name: "fixture-client",
      load(id: string) {
        // Rendering a proposal must not start the browser's API/SSE connection in this test.
        if (id === path.join(web, "src/lib/client.ts")) return 'let events = []; export const setEvents = (value) => { events = value; }; export const client = {}; export const label = (agent) => agent; export const useConnection = () => "live"; export const useEvents = () => events; export const useTasks = () => [{ id: "plan", title: "Planning conversation" }];';
        // Expose dialog contents for static rendering without a browser or portal.
        if (id === path.join(web, "src/components/ui/dialog.tsx")) return `
          import { createElement } from "react";
          let visible = false;
          export const showDialogs = (value) => { visible = value; };
          export const Dialog = ({ children }) => visible ? children : null;
          const container = ({ children }) => createElement("div", null, children);
          export const DialogContent = container;
          export const DialogFooter = container;
          export const DialogHeader = container;
          export const DialogTitle = container;
        `;
        if (id === path.join(web, "src/lib/use-phone.ts")) return "export const usePhone = () => false;";
      },
    }],
    server: { middlewareMode: true, hmr: false, watch: null },
  });
  try {
    const { ChatTab } = await server.ssrLoadModule("/src/components/chat-tab.tsx");
    const requireWeb = createRequire(path.join(web, "package.json"));
    const { createElement } = requireWeb("react");
    const { renderToStaticMarkup } = requireWeb("react-dom/server");
    const task: Task = {
      id: "plan", title: "Plan", workflow: "plan", status: "idle", activity: null,
      cwd: "/example/repo", workspace: null, options: {}, sessions: [], createdAt: "", updatedAt: "",
    };
    const event: TaskEvent = {
      id: "proposal", taskId: task.id, sessionId: null, seq: 1, createdAt: "", type: "task_proposal",
      title: "Implement a todo", spec: "Requirements", issue: { number: 7, url: "https://github.com/example/project/issues/7" },
    };
    const render = (event: TaskEvent) => renderToStaticMarkup(createElement(ChatTab, { task, events: [event], onSelectTask: () => {} }));
    expect(render(event)).toMatch(/href="https:\/\/github.com\/example\/project\/issues\/7"[^>]*>#7<\/a>/);
    expect(render({ ...event, issue: undefined })).not.toContain("/issues/7");
    // Manual dispatch remains explicit and opens the editable proposal-derived dialog.
    expect(render(event)).toContain("開始實作");
    const started: TaskEvent = { ...event, type: "task_started", task: "worker", title: "Implement a todo" };
    expect(render(started)).toContain('href="?task=worker"');
    const report: TaskEvent = { ...event, type: "task_report", report: {
      taskId: "worker", title: "Implement a todo", outcome: "ready", finalSeq: 10, rounds: 1,
      lastVerdict: "approve", findings: [], test: "passed", filesChanged: 1, additions: 1, deletions: 0,
      branch: "agent-hub/worker", pr: { number: 8, url: "https://github.com/example/project/pull/8" },
    } };
    expect(render(report)).toContain('href="?task=worker"');
    expect(render(report)).toContain('href="https://github.com/example/project/pull/8"');
    expect(render(report)).toContain("任務完成，等你確認");
    expect(render({ ...report, report: { ...report.report, outcome: "failed" } })).toContain("任務失敗");
    const draft: TaskEvent = { id: "draft", taskId: task.id, sessionId: null, seq: 2, createdAt: "", type: "pr_draft", by: "agent", briefingId: "fixture-generation", changeType: "feat", branch: "feat/add-deployment", commitMessage: "feat: Add deployment", title: "Deployment", body: "Complete PR body" };
    const draftTask = { ...task, workspace: { state: "active" } };
    const renderDraft = (events: TaskEvent[], current = draftTask) => renderToStaticMarkup(createElement(ChatTab, { task: current, events, onSelectTask: () => {} }));
    expect(renderDraft([draft])).toContain("確認並建立 PR");
    expect(renderDraft([draft])).toContain("feat/add-deployment");
    expect(renderDraft([{ ...draft, briefingId: undefined }])).toContain("重新準備");
    expect(renderDraft([{ ...draft, briefingId: undefined }])).not.toContain("確認並建立 PR");
    const snapshot: TaskEvent = { ...draft, id: "snapshot", seq: 3, type: "diff_snapshot", round: 2, filesChanged: 1, additions: 1, deletions: 0 };
    expect(renderDraft([draft, snapshot])).not.toContain("確認並建立 PR");
    expect(renderDraft([draft, snapshot])).toContain("重新準備");
    expect(renderDraft([draft], { ...draftTask, status: "running" })).not.toContain("確認並建立 PR");
    expect(renderDraft([{ ...draft, by: "user" }])).toContain("你編輯的版本");
    expect(renderDraft([draft, { ...draft, id: "newer", seq: 4 }]).match(/確認並建立 PR/g)).toHaveLength(1);
    const dialogs = await server.ssrLoadModule("/src/components/ui/dialog.tsx");
    dialogs.showDialogs(true);
    const editable = renderDraft([draft]);
    expect(editable).toMatch(/<label[^>]*>[^<]*<textarea[^>]*>feat: Add deployment<\/textarea><\/label>/);
    expect(editable).toMatch(/<input[^>]*value="feat\/add-deployment"/);
    const published = renderDraft([{ ...draft, published: true, commitMessage: undefined }]);
    expect(published.match(/<textarea/g)).toHaveLength(1); // Only the PR body remains editable.
    expect(published).toMatch(/<input[^>]*readOnly=""[^>]*value="feat\/add-deployment"/);
    expect(published.match(/<label/g)).toHaveLength(5); // Branch, title, body and issue selection/mode.
    dialogs.showDialogs(false);
    const { TaskView } = await server.ssrLoadModule("/src/components/task-view.tsx");
    const worker: Task = { ...task, id: "worker", title: "Implement a todo", workflow: "review", options: { reportsTo: task.id } };
    const header = renderToStaticMarkup(createElement(TaskView, { task: worker, onSelectTask: () => {}, onBack: () => {} }));
    expect(header).toContain("回報給：");
    expect(header).toMatch(/href="\?task=plan"[^>]*>Planning conversation<\/a>/);
    expect(header).toContain("由「Planning conversation」管理：請到該對話回覆");
    expect(header).toContain('placeholder="由「Planning conversation」管理：請到規劃對話回覆"');
    const ordinary = renderToStaticMarkup(createElement(TaskView, { task: { ...worker, options: {} }, onSelectTask: () => {}, onBack: () => {} }));
    expect(ordinary).not.toContain("管理：請到");
    const { AskCard } = await server.ssrLoadModule("/src/components/ask-card.tsx");
    const ask: TaskEvent = { id: "ask", taskId: task.id, sessionId: null, seq: 3, createdAt: "", type: "ask", question: "Fix or publish?", context: "Full **report** context", items: [{ text: "Missing edge case", severity: "high", suggestion: "Add coverage" }], options: [{ label: "Fix first", detail: "Safer but takes longer" }, { label: "Publish now", detail: "Faster but leaves work" }], recommended: "Fix first" };
    const renderAsk = (event: TaskEvent) => renderToStaticMarkup(createElement(AskCard, { event, onOther: () => {} }));
    const card = renderAsk(ask);
    for (const text of ["Fix or publish?", "Missing edge case", "Add coverage", "Fix first", "Safer but takes longer", "Publish now", "Faster but leaves work", "建議選項", "其他答案…"]) expect(card).toContain(text);
    expect(card.match(/建議選項/g)).toHaveLength(1);
    const transcript = render(ask);
    expect(transcript).toContain("Full <strong>report</strong> context");
    expect(transcript).not.toContain("Fix or publish?"); // The open card is pinned outside the scroll area.
    expect(renderAsk({ ...ask, answer: "Fix first" })).toContain("回覆：Fix first");
    expect(renderAsk({ ...ask, superseded: true })).toContain("已由新的問題取代");
    expect(renderAsk({ ...ask, answer: "Fix first" })).not.toContain("其他答案…");
    const fixture = await server.ssrLoadModule("/src/lib/client.ts");
    fixture.setEvents([ask]);
    const pinned = renderToStaticMarkup(createElement(TaskView, { task, onSelectTask: () => {}, onBack: () => {} }));
    expect(pinned).toContain("Fix or publish?");
    expect(pinned.indexOf("Full <strong>report</strong> context")).toBeLessThan(pinned.indexOf("Fix or publish?"));
    expect(pinned.indexOf("Fix or publish?")).toBeLessThan(pinned.indexOf('class="composer '));
    fixture.setEvents([{ ...ask, answer: "Fix first" }]);
    const answered = renderToStaticMarkup(createElement(TaskView, { task, onSelectTask: () => {}, onBack: () => {} }));
    expect(answered.match(/Fix or publish\?/g)).toHaveLength(1);
    expect(answered).not.toContain("其他答案…");
  } finally {
    await server.close();
  }
});
