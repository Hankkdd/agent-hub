import { describe, expect, it } from "vitest";
import { initializePhoneHistory, navigatePhoneHistory, navigateDesktopHistory, phoneViewUrl, readPhoneView, type PhoneView } from "./phone-navigation";

class MemoryHistory {
  entries: { state: unknown; url: string }[] = [{ state: { other: "preserved" }, url: "/" }];
  index = 0;
  get state() { return this.entries[this.index]!.state; }
  pushState(state: unknown, _title: string, url?: string | URL | null) {
    this.entries.splice(++this.index, this.entries.length, { state, url: String(url) });
  }
  replaceState(state: unknown, _title: string, url?: string | URL | null) { this.entries[this.index] = { state, url: String(url) }; }
  back() { this.index = Math.max(0, this.index - 1); }
  forward() { this.index = Math.min(this.entries.length - 1, this.index + 1); }
}
const href = "http://localhost/?language=en#section";
const list: PhoneView = { screen: "list" };
const task: PhoneView = { screen: "task", taskId: "task-1" };

describe("phone navigation history", () => {
  it("starts with the full task list without adding a history entry", () => {
    const history = new MemoryHistory();
    expect(initializePhoneHistory(history, list, href)).toEqual(list);
    expect(history.entries).toHaveLength(1);
    expect(history.state).toEqual({ other: "preserved", agentHubPhone: list });
  });

  it("opens a task and supports browser Back and Forward", () => {
    const history = new MemoryHistory();
    initializePhoneHistory(history, list, href);
    navigatePhoneHistory(history, task, href);
    expect(readPhoneView(history.state)).toEqual(task);
    expect(history.entries[1]!.url).toBe("/?language=en&task=task-1#section");
    history.back();
    expect(readPhoneView(history.state)).toEqual(list);
    history.forward();
    expect(readPhoneView(history.state)).toEqual(task);
  });

  it("keeps task, devices and new chat navigation two levels deep", () => {
    const history = new MemoryHistory();
    initializePhoneHistory(history, list, href);
    navigatePhoneHistory(history, { screen: "new-chat" }, href);
    navigatePhoneHistory(history, task, href);
    navigatePhoneHistory(history, { screen: "devices" }, href);
    expect(history.entries).toHaveLength(2);
    expect(readPhoneView(history.state)).toEqual({ screen: "devices" });
    navigatePhoneHistory(history, list, href);
    expect(readPhoneView(history.state)).toEqual(list);
    navigatePhoneHistory(history, task, href);
    expect(history.entries).toHaveLength(2);
  });

  it("gives a direct task link a list entry and does not duplicate entries on remount or reload", () => {
    const history = new MemoryHistory();
    expect(initializePhoneHistory(history, task, href)).toEqual(task);
    expect(initializePhoneHistory(history, list, href)).toEqual(task);
    expect(history.entries).toHaveLength(2);
    navigatePhoneHistory(history, list, href);
    expect(readPhoneView(history.state)).toEqual(list);
  });

  it("validates popstate data rather than accepting foreign or malformed states", () => {
    for (const state of [null, 1, "task", {}, { agentHubPhone: null }, { agentHubPhone: { screen: "other" } }, { agentHubPhone: { screen: "task" } }, { agentHubPhone: { screen: "task", taskId: "" } }]) {
      expect(readPhoneView(state)).toBeNull();
    }
  });

  it("preserves other query parameters and fragments, encodes task IDs and removes bootstrap tokens", () => {
    expect(phoneViewUrl("http://localhost/app?task=old&token=secret&language=en#section", list)).toBe("/app?language=en#section");
    expect(phoneViewUrl(href, { screen: "task", taskId: "id /?" })).toBe("/?language=en&task=id+%2F%3F#section");
  });
});

it("keeps document deep links and drafts reachable through Back/Forward without token history", () => {
  const history = new MemoryHistory();
  const documents: PhoneView = { screen: "documents", documentId: "doc /1" };
  initializePhoneHistory(history, documents, "http://localhost/?view=documents&document=old&token=secret");
  expect(history.entries[1]!.url).toBe("/?view=documents&document=doc+%2F1");
  history.back(); expect(readPhoneView(history.state)).toEqual(list);
  history.forward(); expect(readPhoneView(history.state)).toEqual(documents);
  navigatePhoneHistory(history, { screen: "documents" }, href);
  expect(history.entries).toHaveLength(2);
  expect(readPhoneView(history.state)).toEqual({ screen: "documents" });
  expect(phoneViewUrl("http://localhost/?view=documents&document=old", task)).toBe("/?task=task-1");
  expect(readPhoneView({ agentHubPhone: { screen: "documents", documentId: 2 } })).toBeNull();
});

it("desktop Documents replace the current entry and Browser Back skips internal view switches", () => {
  const history = new MemoryHistory();
  history.pushState({ other: "preserved" }, "", "/hub?language=en");
  const first: PhoneView = { screen: "documents", documentId: "first" };
  const second: PhoneView = { screen: "documents", documentId: "second" };
  navigateDesktopHistory(history, list, first, "http://localhost/hub?language=en&token=secret");
  navigateDesktopHistory(history, first, second, "http://localhost/hub?language=en&view=documents&document=first");
  expect(history.entries).toHaveLength(2); expect(history.index).toBe(1);
  expect(history.state).toEqual({ other: "preserved", agentHubPhone: second });
  expect(history.entries[1]!.url).toBe("/hub?language=en&view=documents&document=second");
  history.back(); expect(history.index).toBe(0);
  history.forward(); expect(readPhoneView(history.state)).toEqual(second);
  navigateDesktopHistory(history, second, task, "http://localhost/hub?language=en&view=documents&document=second");
  expect(history.entries[1]!.url).toBe("/hub?language=en&task=task-1"); expect(history.entries).toHaveLength(2);
});

it("desktop non-document navigation keeps the existing in-memory-only strategy", () => {
  const history = new MemoryHistory(); const before = [...history.entries];
  navigateDesktopHistory(history, list, task, href);
  navigateDesktopHistory(history, task, { screen: "devices" }, href);
  expect(history.entries).toEqual(before);
});
