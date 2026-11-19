import { useEffect, useState } from "react";
import { DiffEditor } from "@monaco-editor/react";
import type { editor } from "monaco-editor";
import type { DiffExplanation, FileContents } from "@agent-hub/shared";
import { usePhone } from "@/lib/use-phone";
import { languageFor } from "@/lib/monaco";
import { attachExplanations } from "@/lib/explanation-zones";
import { t, useLanguage } from "@/i18n";

/** View zones reveal explanations below the code, leaving both diff models intact. */
export default function MonacoDiff({ file, dark, taskId, explanations, stale }: {
  file: FileContents; dark: boolean; taskId: string; explanations: DiffExplanation | null; stale: boolean;
}) {
  const language = useLanguage();
  const phone = usePhone();
  const [diff, setDiff] = useState<editor.IStandaloneDiffEditor | null>(null);
  useEffect(() => {
    if (!diff) return;
    return attachExplanations(diff, file.path, explanations, stale, {
      hint: t("diff.explainHint"), explanation: t("diff.explanation"), stale: t("diff.explainStale"),
    }, phone);
  }, [diff, file.path, explanations, stale, language, phone]);

  return (
    <DiffEditor
      // Reuse each task/file's models to avoid disposing them before the diff widget is reset.
      keepCurrentOriginalModel
      keepCurrentModifiedModel
      originalModelPath={`agent-hub://${taskId}/original/${file.path}`}
      modifiedModelPath={`agent-hub://${taskId}/modified/${file.path}`}
      original={file.original}
      modified={file.modified}
      language={languageFor(file.path)}
      theme={dark ? "vs-dark" : "vs"}
      onMount={setDiff}
      options={{
        readOnly: true,
        renderSideBySide: !phone,
        // Monaco keeps omitted options, so restore the desktop defaults after a viewport resize.
        wordWrap: phone ? "on" : "off",
        lineNumbersMinChars: phone ? 3 : 5,
        renderOverviewRuler: !phone,
        folding: !phone,
        experimental: { useTrueInlineView: false },
        renderSideBySideInlineBreakpoint: 600,
        glyphMargin: true,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        fontSize: 12,
        automaticLayout: true,
      }}
    />
  );
}
