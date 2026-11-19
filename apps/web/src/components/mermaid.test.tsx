import { afterEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { diagramLifecycle, Mermaid, MERMAID_SECURITY, renderDiagram, validateDiagram } from "./mermaid";
const mocked = vi.hoisted(() => ({ initialize: vi.fn(), render: vi.fn(async (id: string) => ({ svg: `<svg id="${id}"></svg>` })) }));
vi.mock("mermaid", () => ({ default: mocked }));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
it("allows a real parsable flowchart subset and rejects directives/frontmatter/interactions/resources/complexity", async () => {
  const source = 'flowchart TD\n Request["Request"] --> Change["Changed component"]';
  expect(() => validateDiagram(source)).not.toThrow();
  const actual = await vi.importActual<typeof import("mermaid")>("mermaid");
  expect(await actual.default.parse("flowchart TD\n A --> B")).toBeTruthy();
  for (const hostile of ["---\nconfig:\n securityLevel: loose\n---\nflowchart TD\n A --> B", "%%{init: {'securityLevel':'loose'}}%%\nflowchart TD\n A --> B", "flowchart TD\n A --> B\n click A href https://example.invalid", 'flowchart TD\n A["<img src=x>"] --> B', "flowchart TD\n A --> B\n style A fill:url(https://example.invalid)", "flowchart TD\n A[icon:external] --> B", "flowchart TD\n A --> B\n".repeat(101), "flowchart TD\n" + "A".repeat(6000)]) expect(() => validateDiagram(hostile)).toThrow();
});
it("shows accessible source fallback without browser crypto or a successful diagram renderer", () => {
  vi.stubGlobal("crypto", undefined);
  const html = renderToStaticMarkup(<Mermaid source="flowchart TD\n A --> B" />);
  expect(html).toContain("<details open"); expect(html).toContain("overflow-x-auto"); expect(html).toContain("A --&gt; B");
});
it("serializes global renderer/configuration, uses safe unique IDs over HTTP and cleans up containers", async () => {
  const remove = vi.fn(); const append = vi.fn();
  vi.stubGlobal("crypto", undefined);
  vi.stubGlobal("document", { createElement: () => ({ style: { cssText: "" }, remove }), body: { appendChild: append } });
  vi.stubGlobal("DOMParser", class { parseFromString() { return { querySelector: () => null, querySelectorAll: () => [] }; } });
  const [first, second] = await Promise.all([renderDiagram("flowchart TD\n A --> B", false), renderDiagram("flowchart TD\n C --> D", true)]);
  expect(first).not.toBe(second); expect(remove).toHaveBeenCalledTimes(2);
  expect(mocked.initialize.mock.calls.map(([config]) => config)).toEqual([{ ...MERMAID_SECURITY, theme: "default" }, { ...MERMAID_SECURITY, theme: "dark" }]);
  expect(MERMAID_SECURITY.securityLevel).toBe("strict"); expect(MERMAID_SECURITY.secure).toContain("securityLevel"); expect(MERMAID_SECURITY.flowchart.htmlLabels).toBe(false);
  expect(mocked.render.mock.calls.map(([id]) => id)).toEqual([expect.stringMatching(/^hub-mermaid-\d+$/), expect.stringMatching(/^hub-mermaid-\d+$/)]);
  const calls = mocked.render.mock.calls.length; expect(() => renderDiagram("%%{init: bad}%%", false)).toThrow(); expect(mocked.render).toHaveBeenCalledTimes(calls);
});
it("localizes errors, ignores superseded results and ignores all completion after unmount", async () => {
  const resolve: ((svg: string) => void)[] = []; const result = vi.fn(); const error = vi.fn();
  const lifecycle = diagramLifecycle(result, error, () => new Promise<string>((r) => resolve.push(r)));
  lifecycle.update("old", false); lifecycle.update("new", true); await Promise.resolve();
  resolve[1]!("new svg"); await Promise.resolve(); await Promise.resolve(); resolve[0]!("old svg"); await Promise.resolve(); await Promise.resolve();
  expect(result).toHaveBeenCalledExactlyOnceWith("new svg");
  lifecycle.update("unmounted", false); await Promise.resolve(); lifecycle.dispose(); resolve[2]!("late svg"); await Promise.resolve(); await Promise.resolve(); expect(result).toHaveBeenCalledTimes(1);
  const failed = diagramLifecycle(result, error, async () => { throw new Error("bad syntax"); }); failed.update("bad", false); await vi.waitFor(() => expect(error).toHaveBeenCalledOnce());
});

it("keeps scheme matching at token boundaries without accepting dangerous diagram schemes or directives", () => {
  for (const label of ["metadata: value", "userData: value"]) expect(() => validateDiagram(`flowchart TD\n A["${label}"] --> B`)).not.toThrow();
  for (const label of ["https:payload", "HTTP:payload", "javascript:payload", "DATA:payload"]) expect(() => validateDiagram(`flowchart TD\n A["${label}"] --> B`)).toThrow();
  expect(() => validateDiagram("%%{init: bad}%%\nflowchart TD\n A --> B")).toThrow();
});
