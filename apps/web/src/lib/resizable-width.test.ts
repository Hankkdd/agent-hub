import { afterEach, expect, test, vi } from "vitest";
import { clampWidth, readWidth, saveWidth } from "./resizable-width";

afterEach(() => {
  vi.unstubAllGlobals();
});

function storage(value: unknown) {
  vi.stubGlobal("localStorage", value);
}

test("both panels respect their bounds and the window limit", () => {
  for (const [min, max, initial] of [[200, 520, 288], [160, 600, 256]] as const) {
    expect(clampWidth(-100, min, max, 1600)).toBe(min);
    expect(clampWidth(2000, min, max, 1600)).toBe(max);
    expect(clampWidth(initial, min, max, 1600)).toBe(initial);
    expect(clampWidth(600, min, max, 768)).toBe(768 * 0.6);
    expect(clampWidth(600, min, max, 800)).toBe(480);
  }
});

test("independent widths persist across reloads and can reset to defaults", () => {
  const values = new Map<string, string>();
  storage({ getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) });
  expect(readWidth("sidebar", 288)).toBe(288);
  expect(readWidth("files", 256)).toBe(256);
  saveWidth("sidebar", 400);
  saveWidth("files", 350);
  expect(readWidth("sidebar", 288)).toBe(400);
  expect(readWidth("files", 256)).toBe(350);
  saveWidth("sidebar", 288);
  expect(readWidth("sidebar", 288)).toBe(288);
  expect(readWidth("files", 256)).toBe(350);
});

test("invalid stored widths use the default", () => {
  for (const value of [null, "", " ", "broken", "NaN", "Infinity", "0", "-10"]) {
    storage({ getItem: () => value });
    expect(readWidth("sidebar", 288)).toBe(288);
  }
});

test("blocked storage reads, writes, and property access never throw", () => {
  storage({ getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("full"); } });
  expect(readWidth("sidebar", 288)).toBe(288);
  expect(saveWidth("sidebar", 400)).toBeUndefined();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, get: () => { throw new Error("blocked"); } });
  expect(readWidth("files", 256)).toBe(256);
  expect(saveWidth("files", 350)).toBeUndefined();
});
