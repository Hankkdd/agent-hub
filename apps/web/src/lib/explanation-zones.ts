import type { editor } from "monaco-editor";
import type { DiffExplanation } from "@agent-hub/shared";
import { matchingHunks } from "./diff-explanations";

export function attachExplanations(diff: editor.IStandaloneDiffEditor, path: string, explanations: DiffExplanation | null, stale: boolean,
  labels: { hint: string; explanation: string; stale: string }, inline = false) {
  const original = diff.getOriginalEditor();
  const modified = diff.getModifiedEditor();
  const decorations = [original.createDecorationsCollection(), modified.createDecorationsCollection()];
  const open = new Map<string, { editor: editor.IStandaloneCodeEditor; id: string; observer: ResizeObserver; layout: { dispose(): void } }>();
  let blocks: { key: string; side: number; start: number; end: number; inlineAnchor: number; texts: string[]; ranges: { side: number; start: number; end: number }[] }[] = [];
  const close = (key: string) => {
    const zone = open.get(key);
    if (!zone) return;
    zone.observer.disconnect();
    zone.layout.dispose();
    zone.editor.changeViewZones((a) => a.removeZone(zone.id));
    open.delete(key);
  };
  const closeAll = () => [...open.keys()].forEach(close);
  const update = () => {
    closeAll();
    const items = new Map(explanations?.items.map((i) => [i.id, i.explanation]) ?? []);
    const hunks = explanations?.hunks.filter((h) => h.path === path && items.has(h.id)) ?? [];
    blocks = (diff.getLineChanges() ?? []).flatMap((change) => {
      const matches = matchingHunks(change, hunks);
      if (!matches.length) return [];
      const side = change.modifiedEndLineNumber === 0 ? 0 : 1;
      const start = side ? change.modifiedStartLineNumber : change.originalStartLineNumber;
      const end = side ? change.modifiedEndLineNumber : change.originalEndLineNumber;
      const ranges = [
        ...(change.originalEndLineNumber ? [{ side: 0, start: change.originalStartLineNumber, end: change.originalEndLineNumber }] : []),
        ...(change.modifiedEndLineNumber ? [{ side: 1, start: change.modifiedStartLineNumber, end: change.modifiedEndLineNumber }] : []),
      ];
      const inlineAnchor = change.modifiedEndLineNumber === 0 ? change.modifiedStartLineNumber : change.modifiedStartLineNumber - 1;
      return [{ key: `${side}:${start}:${end}`, side, start, end, inlineAnchor, texts: matches.map((h) => items.get(h.id)!), ranges }];
    });
    decorations.forEach((collection, side) => collection.set(blocks.flatMap((b) => b.ranges.filter((r) => r.side === side)).map((r) => ({
      range: { startLineNumber: r.start, startColumn: 1, endLineNumber: r.end, endColumn: Number.MAX_SAFE_INTEGER },
      options: { isWholeLine: true, className: "diff-explain-clickable", inlineClassName: "diff-explain-clickable", glyphMarginClassName: "diff-explain-marker", hoverMessage: { value: labels.hint }, glyphMarginHoverMessage: { value: labels.hint } },
    }))));
  };
  const listeners = [original, modified].map((codeEditor, side) => codeEditor.onMouseDown((e) => {
    if (e.event.rightButton || e.event.middleButton) return;
    // Inline deletions are view zones in the modified editor, not original model lines.
    const target = e.target;
    const anchor = inline && side === 1 && (target.type === 8 || target.type === 5)
      && target.element?.closest(".line-delete, .inline-deleted-margin-view-zone") ? target.detail.afterLineNumber : null;
    const block = anchor !== null
      ? blocks.find((b) => b.inlineAnchor === anchor && b.ranges.some((r) => r.side === 0))
      : e.target.position ? blocks.find((b) => b.ranges.some((r) => r.side === side && e.target.position!.lineNumber >= r.start && e.target.position!.lineNumber <= r.end)) : undefined;
    if (!block) return;
    if (open.has(block.key)) { close(block.key); return; }
    const zoneEditor = inline || block.side ? modified : original;
    const node = document.createElement("div");
    node.className = "diff-explanation-zone";
    const content = document.createElement("div");
    content.className = "diff-explanation-content";
    const label = document.createElement("div");
    label.className = "diff-explanation-label";
    label.textContent = labels.explanation + (stale ? ` · ${labels.stale}` : "");
    content.append(label);
    for (const text of block.texts) {
      const p = document.createElement("p");
      p.textContent = text; // Model output is untrusted text, never HTML.
      content.append(p);
    }
    node.append(content);
    // Wrap within the visible pane even when long code lines make Monaco's scroll width larger.
    const fitWidth = () => { content.style.maxWidth = `${Math.max(80, zoneEditor.getLayoutInfo().contentWidth - 24)}px`; };
    fitWidth();
    const layout = zoneEditor.onDidLayoutChange(fitWidth);
    let id = "";
    let height = 80;
    const zone: editor.IViewZone = {
      afterLineNumber: inline && block.side === 0 ? block.inlineAnchor : block.end,
      // Monaco's inline deleted lines share this anchor with a default ordinal of 10000.
      ...(inline && block.side === 0 ? { ordinal: 10001 } : {}),
      heightInPx: height, domNode: node, suppressMouseDown: true,
    };
    const resize = () => {
      const next = Math.ceil(content.getBoundingClientRect().height) + 12;
      if (next === height || !id) return;
      height = next;
      zone.heightInPx = next;
      zoneEditor.changeViewZones((a) => a.layoutZone(id));
    };
    const observer = new ResizeObserver(resize);
    zoneEditor.changeViewZones((a) => { id = a.addZone(zone); });
    observer.observe(content);
    open.set(block.key, { editor: zoneEditor, id, observer, layout });
    resize();
  }));
  const updated = diff.onDidUpdateDiff(update);
  const escape = (e: KeyboardEvent) => { if (e.key === "Escape") closeAll(); };
  window.addEventListener("keydown", escape);
  update();
  return () => {
    closeAll();
    decorations.forEach((d) => d.clear());
    listeners.forEach((l) => l.dispose());
    updated.dispose();
    window.removeEventListener("keydown", escape);
  };
}
