import { useEffect, useRef } from "react";
import { loader } from "@monaco-editor/react";
import type * as Monaco from "monaco-editor";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import "@/lib/monaco";

/** The preview owns both anonymous models. Nothing is shared with task/Git model URIs. */
export function mountSuggestionDiff(monaco: typeof Monaco, container: HTMLElement, original: string, replacement: string, dark: boolean) {
  const before = monaco.editor.createModel(original, "plaintext");
  let after: Monaco.editor.ITextModel | undefined;
  let diff: Monaco.editor.IStandaloneDiffEditor | undefined;
  try {
    after = monaco.editor.createModel(replacement, "plaintext");
    diff = monaco.editor.createDiffEditor(container, { readOnly: true, originalEditable: false, renderSideBySide: true,
      wordWrap: "on", minimap: { enabled: false }, automaticLayout: true, scrollBeyondLastLine: false,
      links: false, contextmenu: false, theme: dark ? "vs-dark" : "vs", fontSize: 14, renderWhitespace: "selection", diffWordWrap: "on" });
    diff.setModel({ original: before, modified: after });
    return () => { diff?.setModel(null); diff?.dispose(); before.dispose(); after?.dispose(); };
  } catch {
    diff?.dispose(); before.dispose(); after?.dispose(); throw new Error("Diff unavailable");
  }
}
export default function DocumentSuggestionMonaco({ original, replacement, onUnavailable }: { original: string; replacement: string; onUnavailable: () => void }) {
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let active = true, dispose: (() => void) | undefined, probe: Worker | undefined;
    const fail = () => { if (active) onUnavailable(); };
    try {
      // Verify this preview's local worker can load; never alter the global Git-diff worker factory.
      probe = new EditorWorker(); probe.addEventListener("error", fail);
      void loader.init().then(monaco => {
        if (!active || !container.current) return;
        try { dispose = mountSuggestionDiff(monaco, container.current, original, replacement, document.documentElement.classList.contains("dark")); }
        catch { fail(); }
      }, fail);
    } catch { fail(); }
    return () => { active = false; probe?.removeEventListener("error", fail); probe?.terminate(); dispose?.(); };
  }, [original, replacement, onUnavailable]);
  return <div ref={container} data-suggestion-monaco="" className="h-72 min-h-0 w-full" />;
}
