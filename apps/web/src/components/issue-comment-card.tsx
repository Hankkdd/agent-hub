import { useState } from "react";
import type { TaskEvent } from "@agent-hub/shared";
import { Markdown } from "./markdown";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
import { client } from "@/lib/client";
import { t, useLanguage } from "@/i18n";
import { issueCommentProjection, issueCommentVersion } from "./issue-comment-projection";

export function IssueCommentCard({ taskId, proposalId, events }: { taskId: string; proposalId: string; events: TaskEvent[] }) {
  useLanguage();
  const value = issueCommentProjection(events, proposalId);
  if (!value) return null;
  // Remount local editor on durable revision changes, including changes streamed from another device.
  return <CommentEditor key={`${value.draft.draftId}/${value.draft.revision}`} taskId={taskId} value={value} />;
}
function CommentEditor({ taskId, value }: { taskId: string; value: NonNullable<ReturnType<typeof issueCommentProjection>> }) {
  const { draft, state, outcome, superseded } = value;
  const [editing, setEditing] = useState(false);
  const [content, setContent] = useState(draft.content);
  const [awaitRevision, setAwaitRevision] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const version = issueCommentVersion(draft);
  const editable = !superseded && (state === "draft" || state === "failed");
  const act = async (action: "edit" | "confirm" | "reconcile") => {
    setBusy(true); setError("");
    try {
      await client.issueComment(taskId, action, action === "edit" ? { ...version, content } : version);
      // The saved event arrives through SSE. Never apply a potentially older HTTP response to the card.
      if (action === "edit") setAwaitRevision(true);
    } catch (err) { setError(String(err)); }
    finally { setBusy(false); }
  };
  return <section aria-label={t("issueComment.title")} className="mt-3 min-w-0 rounded-lg border p-3 text-sm break-words">
    <div className="font-semibold">{t("issueComment.title")}</div>
    <a href={draft.issue.url} target="_blank" rel="noreferrer" className="text-primary underline">{draft.repo} #{draft.issue.number}: {draft.issue.title}</a>
    <div className="my-2 text-xs text-muted-foreground break-all">{t("issueComment.source")}: {draft.sourceReference} · {t("issueComment.revision", { revision: draft.revision })}</div>
    <p className="mb-2 text-xs text-muted-foreground">{t("issueComment.independent")}</p>
    <div role="status" className="mb-2">{t(`issueComment.${state}`)}</div>
    <Markdown>{draft.body}</Markdown>
    <details className="my-2"><summary className="cursor-pointer">{t("issueComment.exact")}</summary><pre className="whitespace-pre-wrap break-all text-xs">{draft.body}</pre></details>
    {outcome?.error && <p className="my-2" role="status">{state === "uncertain" ? t("issueComment.unknownHelp") : t("issueComment.failedHelp")}</p>}
    {state === "published" && outcome?.comment && <a href={outcome.comment.url} target="_blank" rel="noreferrer" className="text-primary underline">{t("issueComment.link")}</a>}
    {editing && editable ? <div className="mt-2 space-y-2">
      <label className="block">{t("issueComment.editLabel")}<Textarea value={content} onChange={(e) => setContent(e.target.value)} maxLength={24000} rows={12} disabled={busy || awaitRevision} /></label>
      <p className="text-xs text-muted-foreground">{t("issueComment.saveHelp")}</p>
      <div className="flex flex-wrap gap-2"><Button disabled={busy || awaitRevision || !content.trim()} onClick={() => void act("edit")}>{t("issueComment.save")}</Button><Button variant="outline" disabled={busy || awaitRevision} onClick={() => { setContent(draft.content); setEditing(false); }}>{t("issueComment.cancel")}</Button></div>
    </div> : <div className="mt-3 flex flex-wrap gap-2">
      {editable && <><Button variant="outline" disabled={busy || awaitRevision} onClick={() => setEditing(true)}>{t("issueComment.edit")}</Button><Button disabled={busy || awaitRevision} onClick={() => void act("confirm")}>{t("issueComment.confirm")}</Button></>}
      {state === "uncertain" && <Button variant="outline" disabled={busy || awaitRevision} onClick={() => void act("reconcile")}>{t("issueComment.reconcile")}</Button>}
    </div>}
    {error && <p role="alert" className="mt-2 text-destructive">{error}</p>}
  </section>;
}
