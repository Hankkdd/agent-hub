import type { IssueCompletion, IssueReference, NewTaskInput } from "@agent-hub/shared";
import { t } from "@/i18n";
import { Input } from "./ui/input";

export function IssueLinkLabel({ issue, completion }: { issue?: IssueReference | null; completion?: IssueCompletion }) {
  return <span>{issue ? <><a href={issue.url} target="_blank" rel="noreferrer" className="text-primary underline">#{issue.number}</a>{" · "}{t(completion === "partial" ? "issueLink.partial" : "issueLink.complete")}</> : t("issueLink.none")}</span>;
}

export function IssueLinkFields({ issue, completion, onChange }: { issue: string; completion: IssueCompletion; onChange: (issue: string, completion: IssueCompletion, field: "issue" | "completion") => void }) {
  return <fieldset className="grid gap-2">
    <legend>{t("issueLink.heading")}</legend>
    <label>{t("issueLink.number")}<Input type="number" min={1} step={1} value={issue} onChange={event => onChange(event.target.value, completion, "issue")} /></label>
    <p className="text-xs text-muted-foreground">{t("issueLink.noneHint")}</p>
    <label>{t("issueLink.mode")}<select className="ml-2 rounded border bg-background p-2" disabled={!issue} value={completion} onChange={event => onChange(issue, event.target.value as IssueCompletion, "completion")}>
      <option value="partial">{t("issueLink.partial")}</option>
      <option value="complete">{t("issueLink.complete")}</option>
    </select></label>
  </fieldset>;
}


export type IssueChoiceSource = Pick<NewTaskInput, "issue" | "issueCompletion">;
export interface IssueChoice { issue: string; completion?: IssueCompletion }

export function initialIssueChoice(source?: IssueChoiceSource): IssueChoice {
  return { issue: String(source?.issue ?? ""), completion: source?.issue ? source.issueCompletion : undefined };
}

/** A mode belongs to its selected association; a different issue starts as one step. */
export function changeIssueChoice(current: IssueChoice, issue: string, completion: IssueCompletion, field: "issue" | "completion", source?: IssueChoiceSource): IssueChoice {
  if (field === "completion") return { ...current, completion };
  if (issue === current.issue || (issue && current.issue && Number(issue) === Number(current.issue))) return { ...current, issue };
  return { issue, completion: !issue ? undefined : Number(issue) === source?.issue ? source.issueCompletion : "partial" };
}

export function issueChoiceInput(choice: IssueChoice): IssueChoiceSource {
  return { issue: choice.issue ? Number(choice.issue) : null, issueCompletion: choice.issue ? choice.completion : undefined };
}
