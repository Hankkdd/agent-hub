import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { editor } from "monaco-editor";
import type { DiffExplanation } from "@agent-hub/shared";
import type { LineChange } from "./diff-explanations";
import { attachExplanations } from "./explanation-zones";

// Only the DOM operations used by zones; code models and Monaco itself remain outside this harness.
class Node {
  className = "";
  textContent = "";
  children: Node[] = [];
  style = { maxWidth: "" };
  append(...children: Node[]) { this.children.push(...children); }
  getBoundingClientRect() { return { height: 60 }; }
}
class CodeEditor {
  zones = new Map<string, editor.IViewZone>();
  decorationList: editor.IModelDeltaDecoration[] = [];
  listener: ((event: editor.IEditorMouseEvent) => void) | null = null;
  next = 0;
  getLayoutInfo() { return { contentWidth: 500 }; }
  onDidLayoutChange() { return { dispose: () => {} }; }
  createDecorationsCollection() {
    return { set: (d: editor.IModelDeltaDecoration[]) => { this.decorationList = d; }, clear: () => { this.decorationList = []; } };
  }
  onMouseDown(listener: (event: editor.IEditorMouseEvent) => void) { this.listener = listener; return { dispose: () => { this.listener = null; } }; }
  changeViewZones(callback: (accessor: editor.IViewZoneChangeAccessor) => void) {
    callback({ addZone: (z) => { const id = String(++this.next); this.zones.set(id, z); return id; }, removeZone: (id) => { this.zones.delete(id); }, layoutZone: () => {} });
  }
  click(lineNumber: number, rightButton = false) {
    this.listener?.({ target: { position: { lineNumber } }, event: { rightButton, middleButton: false } } as editor.IEditorMouseEvent);
  }
  clickDeletion(afterLineNumber: number) {
    this.listener?.({ target: { type: 8, position: null, detail: { afterLineNumber }, element: { closest: () => ({}) } }, event: { rightButton: false, middleButton: false } } as unknown as editor.IEditorMouseEvent);
  }
}
const labels = { hint: "Click to explain", explanation: "Explanation", stale: "May be outdated" };
const range = (start: number, end: number): LineChange => ({ originalStartLineNumber: start, originalEndLineNumber: end, modifiedStartLineNumber: start, modifiedEndLineNumber: end });
const hunk = (start: number) => ({ id: `file:${start}:${start}`, path: "file", oldStart: start, oldLines: 3, newStart: start, newLines: 3 });
const explanations: DiffExplanation = { sha: "fixture-sha", hunks: [hunk(1), hunk(10)], items: [{ id: hunk(1).id, path: "file", explanation: "<script>untrusted text</script>" }, { id: hunk(10).id, path: "file", explanation: "Second explanation" }] };
let original: CodeEditor;
let modified: CodeEditor;
let changes: LineChange[];
let update: (() => void) | null;
let cleanup: (() => void) | undefined;
const disconnect = vi.fn();
beforeEach(() => {
  original = new CodeEditor(); modified = new CodeEditor(); changes = [range(2, 3), range(11, 12)]; update = null;
  vi.stubGlobal("document", { createElement: () => new Node() });
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect = disconnect; });
});
afterEach(() => { cleanup?.(); cleanup = undefined; vi.unstubAllGlobals(); });
function attach(value = explanations, stale = false, inline = false) {
  const diff = { getOriginalEditor: () => original, getModifiedEditor: () => modified, getLineChanges: () => changes, onDidUpdateDiff: (cb: () => void) => { update = cb; return { dispose: () => { update = null; } }; } } as unknown as editor.IStandaloneDiffEditor;
  cleanup = attachExplanations(diff, "file", value, stale, labels, inline);
}
const nodeText = (node: Node): string => [node.textContent, ...node.children.map(nodeText)].join(" ");

describe("inline explanation view zones", () => {
  it("adds hints and toggles instant text beneath a changed block without replacing code", () => {
    attach();
    expect(modified.decorationList).toHaveLength(2);
    expect(modified.decorationList[0]!.options).toMatchObject({ inlineClassName: "diff-explain-clickable", glyphMarginClassName: "diff-explain-marker", hoverMessage: { value: labels.hint } });
    modified.click(3);
    expect(modified.zones.size).toBe(1);
    const zone = [...modified.zones.values()][0]!;
    expect(zone.afterLineNumber).toBe(3);
    expect(zone.heightInPx).toBe(72);
    expect(nodeText(zone.domNode as unknown as Node)).toContain("<script>untrusted text</script>");
    expect(original.zones.size).toBe(0);
    modified.click(2);
    expect(modified.zones.size).toBe(0);
    modified.click(5);
    expect(modified.zones.size).toBe(0);
    modified.click(2, true);
    expect(modified.zones.size).toBe(0);
  });

  it("opens the explanation on the modified side when a replacement is clicked on either side", () => {
    attach(); original.click(2);
    expect(modified.zones.size).toBe(1);
    expect(original.zones.size).toBe(0);
    modified.click(2);
    expect(modified.zones.size).toBe(0);
  });

  it("allows several open blocks and Escape removes every zone", () => {
    attach(); modified.click(2); modified.click(11);
    expect(modified.zones.size).toBe(2);
    const escape = new Event("keydown");
    Object.defineProperty(escape, "key", { value: "Escape" });
    window.dispatchEvent(escape);
    expect(modified.zones.size).toBe(0);
  });

  it("uses the original side for pure deletion and visibly labels stale explanations", () => {
    changes = [{ ...range(2, 3), modifiedStartLineNumber: 1, modifiedEndLineNumber: 0 }];
    attach(explanations, true);
    original.click(2);
    expect(original.zones.size).toBe(1);
    expect(modified.zones.size).toBe(0);
    const zone = [...original.zones.values()][0]!;
    expect(zone.afterLineNumber).toBe(3);
    expect(nodeText(zone.domNode as unknown as Node)).toContain(labels.stale);
  });

  it("opens pure inline deletions in the visible modified editor and toggles them on a second tap", () => {
    changes = [{ ...range(2, 3), modifiedStartLineNumber: 1, modifiedEndLineNumber: 0 }];
    attach(explanations, false, true);
    modified.clickDeletion(1);
    expect(original.zones.size).toBe(0);
    expect(modified.zones.size).toBe(1);
    expect([...modified.zones.values()][0]!).toMatchObject({ afterLineNumber: 1, ordinal: 10001 });
    modified.clickDeletion(1);
    expect(modified.zones.size).toBe(0);
    modified.clickDeletion(9);
    expect(modified.zones.size).toBe(0);
  });

  it("opens inline replacements from the removed lines beneath the modified block", () => {
    attach(explanations, false, true);
    modified.clickDeletion(1);
    expect(modified.zones.size).toBe(1);
    expect([...modified.zones.values()][0]!.afterLineNumber).toBe(3);
    expect(original.zones.size).toBe(0);
  });

  it("includes every overlapping hunk in order when Monaco combines them", () => {
    changes = [range(2, 12)];
    attach(); modified.click(8);
    const text = nodeText([...modified.zones.values()][0]!.domNode as unknown as Node);
    expect(text.indexOf("untrusted")).toBeLessThan(text.indexOf("Second explanation"));
  });

  it("clears zones on diff recomputation and detaches listeners, hints, and observers on cleanup", () => {
    attach(); modified.click(2); update?.();
    expect(modified.zones.size).toBe(0);
    modified.click(11); cleanup?.(); cleanup = undefined;
    expect(modified.zones.size).toBe(0);
    expect(modified.decorationList).toEqual([]);
    expect(modified.listener).toBeNull();
    expect(update).toBeNull();
    expect(disconnect).toHaveBeenCalled();
  });
});
