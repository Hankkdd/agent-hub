import { afterEach, expect, it, vi } from "vitest";
import { copyText } from "./copy";
afterEach(() => vi.unstubAllGlobals());
it("reports secure clipboard success and propagates refusal without claiming success", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined); vi.stubGlobal("window", { isSecureContext: true }); vi.stubGlobal("navigator", { clipboard: { writeText } });
  await copyText("fictional prompt"); expect(writeText).toHaveBeenCalledWith("fictional prompt");
  writeText.mockRejectedValueOnce(new Error("denied")); await expect(copyText("kept prompt")).rejects.toThrow("denied");
});
it.each(["success", "false", "throw"])("cleans the HTTP fallback and restores dialog focus on %s", async outcome => {
  const ta = { value: "", style: {}, setAttribute: vi.fn(), select: vi.fn(), remove: vi.fn() }, dialog = { appendChild: vi.fn() }, body = { appendChild: vi.fn() };
  const focused = { focus: vi.fn(), closest: vi.fn(() => dialog) };
  vi.stubGlobal("window", { isSecureContext: false }); vi.stubGlobal("navigator", {});
  vi.stubGlobal("document", { body, activeElement: focused, createElement: () => ta, execCommand: () => { if (outcome === "throw") throw new Error("refused"); return outcome === "success"; } });
  if (outcome === "success") await copyText("Fictional"); else await expect(copyText("Fictional")).rejects.toThrow();
  expect(dialog.appendChild).toHaveBeenCalledWith(ta); expect(body.appendChild).not.toHaveBeenCalled(); expect(ta.remove).toHaveBeenCalledTimes(1); expect(focused.focus).toHaveBeenCalledTimes(1);
});
