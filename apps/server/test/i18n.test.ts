import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Import at runtime so the server typecheck does not include browser-only source files.
const modulePath = path.resolve(import.meta.dirname, "../../web/src/i18n/index.ts");
const load = () => import(modulePath);

beforeEach(() => {
  vi.resetModules();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("web language", () => {
  it.each([null, "unsupported"])("defaults to Traditional Chinese with stored choice %s", async (choice) => {
    vi.stubGlobal("localStorage", { getItem: () => choice });
    const { getLanguage, t } = await load();
    expect(getLanguage()).toBe("zh-TW");
    expect(t("newTask.title")).toBe("新增任務");
  });

  it("restores English, switches immediately, interpolates values, and persists the choice", async () => {
    const values = new Map([["agent-hub-language", "en"]]);
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key),
      setItem: (key: string, value: string) => values.set(key, value),
    });
    const document = { documentElement: { lang: "" } };
    vi.stubGlobal("document", document);
    const { getLanguage, setLanguage, t } = await load();
    expect(getLanguage()).toBe("en");
    expect(document.documentElement.lang).toBe("en");
    expect(t("task.deleteConfirm", { title: "{example}", note: "" })).toBe('Delete "{example}" and its history?');
    setLanguage("zh-TW");
    expect(t("newTask.title")).toBe("新增任務");
    expect(t("composer.imageLimit", { count: 4 })).toBe("每則訊息最多可附上 4 張圖片");
    expect(document.documentElement.lang).toBe("zh-TW");
    vi.resetModules();
    expect((await load()).getLanguage()).toBe("zh-TW");
    expect(values.get("agent-hub-language")).toBe("zh-TW");
  });

  it("keeps switching when storage reads and writes throw", async () => {
    vi.stubGlobal("localStorage", {
      getItem: () => { throw new Error("storage blocked"); },
      setItem: () => { throw new Error("storage blocked"); },
    });
    const { getLanguage, setLanguage, t } = await load();
    expect(getLanguage()).toBe("zh-TW");
    expect(() => setLanguage("en")).not.toThrow();
    expect(t("newTask.title")).toBe("New task");
  });

  it("provides both dictionaries with matching interpolation parameters", async () => {
    const directory = path.dirname(modulePath);
    const { en } = await import(path.join(directory, "en.ts"));
    const { zhTW } = await import(path.join(directory, "zh-TW.ts"));
    expect(Object.keys(zhTW).sort()).toEqual(Object.keys(en).sort());
    const params = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const [key, value] of Object.entries(en)) {
      expect(params(zhTW[key]), key).toEqual(params(value as string));
    }
  });
});
