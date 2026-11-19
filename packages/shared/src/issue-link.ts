import type { IssueCompletion, IssueLink } from "./index";

export function validateIssueSelection(issue: unknown, completion: unknown): void {
  if (issue !== undefined && issue !== null && (!Number.isSafeInteger(issue) || (issue as number) <= 0))
    throw new Error("Issue must be a positive integer or null");
  if (completion !== undefined && completion !== "partial" && completion !== "complete")
    throw new Error("Issue completion must be partial or complete");
}

/** Missing legacy metadata deliberately retains Closes. */
export function issueRelationship(link: IssueLink): string | undefined {
  return link.issue ? `${link.issueCompletion === "partial" ? "Refs" : "Closes"} #${link.issue.number}` : undefined;
}

export function managedIssueBlock(link: IssueLink): string | undefined {
  const line = issueRelationship(link);
  return line ? `\n\n<!-- agent-hub:issue -->\n${line}\n<!-- /agent-hub:issue -->` : undefined;
}

/** Exact replacement only: human prose and its whitespace are never normalized. */
export function updateManagedIssue(body: string, previous: string | undefined, next: string | undefined): string {
  const count = (text: string) => body.split(text).length - 1;
  const conflict = () => { throw new Error("The managed issue relationship was edited. In the draft editor, restore the saved Hub issue block, then change the issue selection; or make the block exactly match the selected relationship before saving."); };
  const legacySuffix = previous && !previous.includes("<!-- agent-hub:issue -->");
  if (previous && (legacySuffix ? body.endsWith(previous) : count(previous) === 1)) {
    const result = legacySuffix ? body.slice(0, -previous.length) + (next ?? "") : body.replace(previous, next ?? "");
    for (const marker of ["<!-- agent-hub:issue -->", "<!-- /agent-hub:issue -->"]) {
      if ((result.split(marker).length - 1) !== (next?.includes(marker) ? 1 : 0)) conflict();
    }
    return result;
  }
  // The editor may already have applied the structured selection to the exact block.
  if (next && count(next) === 1 && count("<!-- agent-hub:issue -->") === 1 && count("<!-- /agent-hub:issue -->") === 1) return body;
  if (body.includes("<!-- agent-hub:issue -->") || body.includes("<!-- /agent-hub:issue -->")) conflict();
  if (previous && (next || legacySuffix)) conflict();
  return next ? body + next : body;
}
