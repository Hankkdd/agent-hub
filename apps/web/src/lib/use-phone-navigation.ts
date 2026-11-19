import { useEffect, useRef, useState } from "react";
import { initializePhoneHistory, navigatePhoneHistory, navigateDesktopHistory, readPhoneView, type PhoneView } from "./phone-navigation";
import { usePhone } from "./use-phone";

export function usePhoneNavigation() {
  const phone = usePhone();
  const [view, setView] = useState<PhoneView>(() => {
    const query = new URLSearchParams(window.location.search);
    if (query.get("view") === "documents") return { screen: "documents", ...(query.get("document") ? { documentId: query.get("document")! } : {}) };
    const taskId = new URLSearchParams(window.location.search).get("task");
    return taskId ? { screen: "task", taskId } : { screen: "list" };
  });
  const current = useRef(view);
  current.current = view;

  useEffect(() => {
    if (phone) setView(initializePhoneHistory(window.history, current.current, window.location.href));
    const pop = (event: PopStateEvent) => setView(readPhoneView(event.state) ?? { screen: "list" });
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, [phone]);

  const navigate = (next: PhoneView) => {
    if (phone) navigatePhoneHistory(window.history, next, window.location.href);
    else navigateDesktopHistory(window.history, current.current, next, window.location.href);
    setView(next);
  };
  return { phone, view, navigate, back: () => navigate({ screen: "list" }) };
}
