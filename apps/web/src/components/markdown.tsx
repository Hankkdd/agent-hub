import { Children, isValidElement } from "react";
import { t, useLanguage } from "@/i18n";
import { Mermaid } from "./mermaid";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** Recognize only the exact Hub-owned suffix; general raw HTML remains disabled. */
export function splitBriefingAppendix(text: string): { main: string; briefing: string } | null {
  const match = /\n\n<details data-agent-hub-briefing="[a-f0-9-]{36}">\n<summary>([^\n<>]{1,100})<\/summary>\n\n([\s\S]*)\n\n<\/details>$/.exec(text);
  if (!match || match[1] !== t("briefing.appendixSummary") || /<\/?(?:details|summary)\b/i.test(match[2]!)) return null;
  return { main: text.slice(0, match.index), briefing: match[2]! };
}

/** Agent prose is Markdown. Styled by hand instead of the typography plugin to keep it compact. */
export function Markdown({ children }: { children: string }) {
  useLanguage();
  const appendix = splitBriefingAppendix(children);
  if (appendix) return <><Markdown>{appendix.main}</Markdown><details><summary>{t("briefing.appendixSummary")}</summary><Markdown>{appendix.briefing}</Markdown></details></>;
  return (
    <div className="markdown space-y-2 text-sm leading-relaxed [&_a]:underline [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.85em] [&_h1]:text-base [&_h1]:font-semibold [&_h2]:pt-1 [&_h2]:text-sm [&_h2]:font-semibold [&_h3]:font-medium [&_ol]:list-decimal [&_ol]:pl-5 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-3 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_table]:text-xs [&_td]:border [&_td]:px-2 [&_th]:border [&_th]:px-2 [&_ul]:list-disc [&_ul]:pl-5">
      <ReactMarkdown skipHtml remarkPlugins={[remarkGfm]} components={{
        pre: ({ children }) => Children.toArray(children).some((child) => isValidElement<{ className?: string }>(child) && child.props.className === "language-mermaid")
          ? <div className="overflow-x-auto rounded-md bg-muted p-3">{children}</div> : <pre>{children}</pre>,
        code: ({ className, children }) => className === "language-mermaid" ? <Mermaid source={String(children).trimEnd()} /> : <code className={className}>{children}</code>,
      }}>{children}</ReactMarkdown>
    </div>
  );
}
