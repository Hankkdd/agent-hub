// Monaco bundled locally (no CDN), with syntax highlighting only: the diff view needs colours, not
// language services, and leaving those out avoids shipping their web workers.
import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor/editor/editor.api";
import "monaco-editor/basic-languages/monaco.contribution";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
// The icon font (gutter +/- markers, widget icons). editor.main imports it; editor.api does not, and the
// package's exports map has no path to a .css file, hence the relative import.
import "../../node_modules/monaco-editor/esm/vs/base/browser/ui/codicons/codicon/codicon.css";

self.MonacoEnvironment = { getWorker: () => new EditorWorker() };
loader.config({ monaco });

const EXT_LANG: Record<string, string> = {
  ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  json: "json", md: "markdown", py: "python", go: "go", rs: "rust", java: "java", kt: "kotlin", rb: "ruby",
  sh: "shell", bash: "shell", yml: "yaml", yaml: "yaml", toml: "ini", ini: "ini", css: "css", scss: "scss",
  html: "html", vue: "html", sql: "sql", c: "c", h: "c", cpp: "cpp", hpp: "cpp", cs: "csharp", php: "php",
  swift: "swift", dockerfile: "dockerfile", tf: "hcl", xml: "xml",
};

export function languageFor(file: string): string {
  const base = file.split("/").pop()!.toLowerCase();
  if (base === "dockerfile") return "dockerfile";
  return EXT_LANG[base.split(".").pop() ?? ""] ?? "plaintext";
}
