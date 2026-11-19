import { useEffect, useRef, useState } from "react";
import { t, useLanguage } from "@/i18n";

export const MERMAID_SECURITY = {
  startOnLoad: false,
  securityLevel: "strict" as const,
  secure: ["secure", "securityLevel", "startOnLoad", "maxTextSize", "maxEdges", "suppressErrorRendering", "htmlLabels", "flowchart"],
  maxTextSize: 6000,
  maxEdges: 100,
  suppressErrorRendering: true,
  htmlLabels: false,
  flowchart: { htmlLabels: false },
};

/** Deliberately small flowchart subset: no directives, frontmatter, HTML, styles or interactions. */
export function validateDiagram(source: string): void {
  if (source.length > 6000 || source.split("\n").length > 100 || !/^flowchart (TD|LR)\s/.test(source) || /[<`{};&]|%%|\b(click|href|style|classDef|linkStyle|image|icon|accDescr)\b|\b(?:https?|javascript|data):/im.test(source) || (source.match(/-->/g)?.length ?? 0) > 100) throw new Error("Unsafe diagram");
  const label = '[\\p{L}\\p{N} _./()#:\\-]';
  const node = `[A-Za-z][A-Za-z0-9_]{0,39}(?:\\[(?:"${label}{1,120}"|${label}{1,120})\\])?`;
  const line = new RegExp(`^${node}(?:\\s*-->(?:\\|${label}{1,80}\\|)?\\s*${node})*$`, "u");
  if (source.trim().split("\n").slice(1).some((s) => s.trim() && !line.test(s.trim()))) throw new Error("Unsupported diagram syntax");
}

let nextId = 0;
let rendering: Promise<unknown> = Promise.resolve();
/** Mermaid initialization is global. Serialize initialize/render so concurrent diagrams retain their theme. */
export function renderDiagram(source: string, dark: boolean): Promise<string> {
  validateDiagram(source);
  const job = rendering.catch(() => {}).then(async () => {
    const { default: mermaid } = await import("mermaid");
    mermaid.initialize({ ...MERMAID_SECURITY, theme: dark ? "dark" : "default" });
    const container = document.createElement("div");
    container.style.cssText = "position:fixed;left:-100000px;top:0;visibility:hidden";
    document.body.appendChild(container);
    try {
      const { svg } = await mermaid.render(`hub-mermaid-${++nextId}`, source, container);
      const parsed = new DOMParser().parseFromString(svg, "image/svg+xml");
      if (parsed.querySelector("parsererror,script,foreignObject,image,a")) throw new Error("Unsafe rendered diagram");
      for (const element of parsed.querySelectorAll("*")) {
        for (const attribute of [...element.attributes]) {
          if (/^on/i.test(attribute.name) || (/href$/i.test(attribute.name) && !attribute.value.startsWith("#")) || /(?:\b(?:https?|javascript|data):|@import)/i.test(attribute.value) && !/^xmlns(?::xlink)?$/.test(attribute.name)) throw new Error("External diagram resource");
        }
      }
      if (/@import|url\(\s*["']?(?!#)[^)]/i.test([...parsed.querySelectorAll("style")].map((s) => s.textContent).join("\n"))) throw new Error("External diagram style");
      return svg;
    } finally { container.remove(); }
  });
  rendering = job;
  return job;
}

/** Invalidate outstanding results on source/theme changes and unmount without cancelling other cards. */
export function diagramLifecycle(result: (svg: string) => void, error: () => void, render = renderDiagram) {
  let live = true;
  let revision = 0;
  return {
    update(source: string, dark: boolean) {
      const current = ++revision;
      void Promise.resolve().then(() => render(source, dark)).then(
        (svg) => { if (live && current === revision) result(svg); },
        () => { if (live && current === revision) error(); },
      );
    },
    dispose() { live = false; revision++; },
  };
}

export function Mermaid({ source }: { source: string }) {
  useLanguage();
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const target = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const lifecycle = diagramLifecycle(setSvg, () => setError(true));
    const render = () => {
      setSvg(null); setError(false);
      lifecycle.update(source, document.documentElement.classList.contains("dark"));
    };
    render();
    const observer = new MutationObserver(render);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => { lifecycle.dispose(); observer.disconnect(); };
  }, [source]);
  return <div className="min-w-0" ref={target}>
    {svg && <div className="overflow-x-auto" role="img" aria-label={t("briefing.diagram")} dangerouslySetInnerHTML={{ __html: svg }} />}
    {error && <p role="status">{t("briefing.diagramError")}</p>}
    <details open={!svg}><summary>{t("briefing.diagramSource")}</summary><pre className="overflow-x-auto"><code>{source}</code></pre></details>
  </div>;
}
