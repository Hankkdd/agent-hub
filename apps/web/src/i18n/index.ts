import { useSyncExternalStore } from "react";
import { en, type TranslationKey } from "./en";
import { zhTW } from "./zh-TW";

export type Language = "zh-TW" | "en";
const STORAGE_KEY = "agent-hub-language";
const dictionaries = { "zh-TW": zhTW, en };
const listeners = new Set<() => void>();

function savedLanguage(): Language {
  try {
    return localStorage.getItem(STORAGE_KEY) === "en" ? "en" : "zh-TW";
  } catch {
    return "zh-TW";
  }
}

let language = savedLanguage();
function applyLanguage() {
  if (typeof document !== "undefined") document.documentElement.lang = language;
}
applyLanguage();

export function getLanguage(): Language {
  return language;
}

export function setLanguage(next: Language): void {
  language = next;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // The switch still works when browser storage is unavailable.
  }
  applyLanguage();
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useLanguage(): Language {
  return useSyncExternalStore(subscribe, getLanguage, () => "zh-TW");
}

export function t(key: TranslationKey, params?: Record<string, string | number>): string {
  return dictionaries[language][key].replace(/\{(\w+)\}/g, (placeholder, name: string) =>
    params && Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : placeholder,
  );
}
