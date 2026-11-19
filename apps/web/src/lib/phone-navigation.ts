export type PhoneView = { screen: "list" | "devices" | "new-chat" } | { screen: "task"; taskId: string } | { screen: "documents"; documentId?: string };
type NavigationHistory = Pick<History, "state" | "pushState" | "replaceState" | "back">;

export function readPhoneView(state: unknown): PhoneView | null {
  if (!state || typeof state !== "object" || !("agentHubPhone" in state)) return null;
  const view = state.agentHubPhone;
  if (!view || typeof view !== "object" || !("screen" in view)) return null;
  if (view.screen === "list" || view.screen === "devices" || view.screen === "new-chat") return { screen: view.screen };
  if (view.screen === "task" && "taskId" in view && typeof view.taskId === "string" && view.taskId) return { screen: "task", taskId: view.taskId };
  if (view.screen === "documents") {
    const id = "documentId" in view ? view.documentId : undefined;
    if (id === undefined || typeof id === "string" && id.length > 0) return { screen: "documents", ...(id ? { documentId: id } : {}) };
  }
  return null;
}

function entry(history: NavigationHistory, view: PhoneView) {
  return { ...(history.state && typeof history.state === "object" ? history.state : {}), agentHubPhone: view };
}

export function phoneViewUrl(href: string, view: PhoneView): string {
  const url = new URL(href);
  // Authentication belongs to the client; never copy its bootstrap token into a new history entry.
  url.searchParams.delete("token");
  if (view.screen === "task") url.searchParams.set("task", view.taskId);
  else url.searchParams.delete("task");
  if (view.screen === "documents") {
    url.searchParams.set("view", "documents");
    if (view.documentId) url.searchParams.set("document", view.documentId); else url.searchParams.delete("document");
  } else { url.searchParams.delete("view"); url.searchParams.delete("document"); }
  return `${url.pathname}${url.search}${url.hash}`;
}

export function initializePhoneHistory(history: NavigationHistory, view: PhoneView, href: string): PhoneView {
  const existing = readPhoneView(history.state);
  if (existing) return existing;
  const list: PhoneView = { screen: "list" };
  history.replaceState(entry(history, list), "", phoneViewUrl(href, list));
  // A direct task link also needs a list entry behind it so Back stays inside the app.
  if (view.screen !== "list") history.pushState(entry(history, view), "", phoneViewUrl(href, view));
  return view;
}

export function navigatePhoneHistory(history: NavigationHistory, view: PhoneView, href: string) {
  const current = readPhoneView(history.state);
  if (view.screen === "list" && current && current.screen !== "list") {
    history.back();
  } else if (current?.screen === "list" && view.screen !== "list") {
    history.pushState(entry(history, view), "", phoneViewUrl(href, view));
  } else {
    // Switching between content views keeps navigation two levels deep.
    history.replaceState(entry(history, view), "", phoneViewUrl(href, view));
  }
}

/** Desktop view changes replace the current entry; they do not form a browser Back stack. */
export function navigateDesktopHistory(history: NavigationHistory, current: PhoneView, view: PhoneView, href: string) {
  if (current.screen === "documents" || view.screen === "documents") {
    history.replaceState(entry(history, view), "", phoneViewUrl(href, view));
  }
}
