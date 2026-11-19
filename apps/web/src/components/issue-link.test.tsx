import { afterEach, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { IssueLinkFields, IssueLinkLabel } from "./issue-link";
import { setLanguage, t } from "@/i18n";

afterEach(() => setLanguage("zh-TW"));
it.each(["en", "zh-TW"] as const)("exposes effective issue/mode/none and editable controls in %s", language => {
  setLanguage(language);
  const issue = { number: 7, url: "https://github.com/example/project/issues/7" };
  const label = (completion?: "partial" | "complete") => renderToStaticMarkup(<IssueLinkLabel issue={issue} completion={completion} />);
  expect(label("partial")).toContain(t("issueLink.partial"));
  expect(label("complete")).toContain(t("issueLink.complete"));
  expect(label()).toContain(t("issueLink.complete"));
  expect(label()).toContain(issue.url);
  expect(renderToStaticMarkup(<IssueLinkLabel />)).toContain(t("issueLink.none"));
  const fields = renderToStaticMarkup(<IssueLinkFields issue="7" completion="partial" onChange={() => {}} />);
  expect(fields).toContain('value="7"');
  expect(fields).toContain('value="partial" selected=""');
  expect(fields).toContain(t("issueLink.noneHint"));
  const detached = renderToStaticMarkup(<IssueLinkFields issue="" completion="partial" onChange={() => {}} />);
  expect(detached).toContain('disabled=""');
});

it("propagates legacy dialog number and mode events into creation payloads without inheriting a closing mode on replacement", async () => {
  const { Children, isValidElement } = await import("react");
  const { initialIssueChoice, changeIssueChoice, issueChoiceInput } = await import("./issue-link");
  const source = { issue: 7 };
  let choice = initialIssueChoice(source);
  const payload = () => JSON.parse(JSON.stringify(issueChoiceInput(choice)));
  const fields = () => IssueLinkFields({ issue: choice.issue, completion: choice.completion ?? (choice.issue ? "complete" : "partial"),
    onChange: (issue, completion, field) => { choice = changeIssueChoice(choice, issue, completion, field, source); } });
  // Invoke the real Input/select event handlers, rerendering their controlled props between events.
  const fire = (kind: "number" | "select", value: string) => {
    let handler: ((event: { target: { value: string } }) => void) | undefined;
    const visit = (node: import("react").ReactNode) => {
      Children.forEach(node, child => {
        if (!isValidElement<{ type?: string; children?: import("react").ReactNode; onChange?: typeof handler }>(child)) return;
        if (kind === "select" ? child.type === "select" : child.props.type === "number") handler = child.props.onChange;
        visit(child.props.children);
      });
    };
    visit(fields()); expect(handler).toBeDefined(); handler!({ target: { value } });
  };
  expect(payload()).toEqual({ issue: 7 });
  fire("number", "8"); expect(payload()).toEqual({ issue: 8, issueCompletion: "partial" });
  fire("select", "complete"); expect(payload()).toEqual({ issue: 8, issueCompletion: "complete" });
  fire("number", "08"); expect(payload()).toEqual({ issue: 8, issueCompletion: "complete" });
  fire("number", ""); expect(payload()).toEqual({ issue: null });
  fire("number", "8"); expect(payload()).toEqual({ issue: 8, issueCompletion: "partial" });
  fire("number", "7"); expect(payload()).toEqual({ issue: 7 });
  fire("select", "partial"); expect(payload()).toEqual({ issue: 7, issueCompletion: "partial" });
  fire("select", "complete"); expect(payload()).toEqual({ issue: 7, issueCompletion: "complete" });
});
