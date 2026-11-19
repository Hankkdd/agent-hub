import { IssueLinkFields, initialIssueChoice, changeIssueChoice, issueChoiceInput } from "./issue-link";
import type { GoogleStatus } from "@agent-hub/shared";
import { containsDriveUrl } from "./google-dialog";
import type { TranslationKey } from "@/i18n/en";
import { t, useLanguage } from "@/i18n";
import { useEffect, useState } from "react";
import {
  EFFORT_LEVELS,
  type AgentKind,
  type EffortLevel,
  type ModelCatalog,
  type ModelChoice,
  type NewTaskInput,
  type RepoSettings,
  type WorkflowId,
} from "@agent-hub/shared";
import { client } from "@/lib/client";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { effortLabel, workflowLabel } from "@/components/status";

import { estimateInput } from "./scope-estimate";
import { defaults, repositoryChoice, taskAgents, type AgentChoice } from "./new-task-defaults";

const WORKFLOWS: { id: WorkflowId; hint: TranslationKey }[] = [
  { id: "chat", hint: "newTask.chatHint" },
  { id: "plan", hint: "newTask.planHint" },
  { id: "implement", hint: "newTask.implementHint" },
  { id: "review", hint: "newTask.reviewHint" },
  { id: "video", hint: "newTask.videoHint" },
];

/** Radix Select cannot hold an empty value, so "the agent's default model" needs a name. */
const DEFAULT_MODEL = "__default";

// The repo used last, so the next coding task starts where the previous one did. Falls back to the
// documented install location, which is where Agent Hub develops itself. localStorage can throw
// (private windows, blocked storage); the dialog works without it.
const LAST_REPO_KEY = "agent-hub.lastRepo";
const DEFAULT_REPO = "~/agent-hub";
function lastRepo(): string {
  try {
    return localStorage.getItem(LAST_REPO_KEY) || DEFAULT_REPO;
  } catch {
    return DEFAULT_REPO;
  }
}
function rememberRepo(repo: string): void {
  try {
    localStorage.setItem(LAST_REPO_KEY, repo);
  } catch {
    // not remembered; the default still applies next time
  }
}

export type TaskPrefill = Pick<NewTaskInput, "title" | "repoPath" | "message" | "testCommand" | "fromProposal" | "ticket" | "base" | "scopeEstimate" | "issue" | "issueCompletion">;

export function NewTaskDialog(props: { onGoogle?: () => void; open: boolean; onOpenChange: (open: boolean) => void; onCreate: (input: NewTaskInput) => Promise<void>; prefill?: TaskPrefill }) {
  useLanguage();
  const [google, setGoogle] = useState<GoogleStatus | null>(null);
  useEffect(() => {
    if (!props.open) return;
    let cancelled = false;
    const refresh = () => { void client.googleStatus().then((s) => { if (!cancelled) setGoogle(s); }, () => {}); };
    refresh(); window.addEventListener("focus", refresh);
    return () => { cancelled = true; window.removeEventListener("focus", refresh); };
  }, [props.open]);
  const [title, setTitle] = useState("");
  const [workflow, setWorkflow] = useState<WorkflowId>("chat");
  const [main, setMain] = useState<AgentChoice>(defaults("chat").main);
  const [reviewer, setReviewer] = useState<AgentChoice>(defaults("chat").reviewer);
  const [repoPath, setRepoPath] = useState("");
  const [maxRounds, setMaxRounds] = useState("3");
  const [testCommand, setTestCommand] = useState("");
  const [base, setBase] = useState("");
  const [estimateFiles, setEstimateFiles] = useState("");
  const [estimateLines, setEstimateLines] = useState("");
  const [issueChoice, setIssueChoice] = useState(initialIssueChoice);
  const issue = issueChoice.issue;
  const [ticket, setTicket] = useState("");
  const [settingsResult, setSettingsResult] = useState<{ path: string; settings: RepoSettings | null; error?: string } | null>(null);
  const [mainEdited, setMainEdited] = useState(false);
  const [reviewerEdited, setReviewerEdited] = useState(false);
  const [testEdited, setTestEdited] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  useEffect(() => {
    if (!props.open) return;
    setTicket(props.prefill?.ticket ?? "");
    setIssueChoice(initialIssueChoice(props.prefill));
    setEstimateFiles(String(props.prefill?.scopeEstimate?.maxFiles ?? ""));
    setEstimateLines(String(props.prefill?.scopeEstimate?.maxChangedLines ?? ""));
    setMainEdited(false);
    setReviewerEdited(false);
    setSettingsResult(null);
    const initial = defaults(props.prefill ? "review" : workflow);
    setMain(initial.main);
    setReviewer(initial.reviewer);
    setTestEdited(!!props.prefill?.testCommand);
    setCatalog(null);
    void client.models().then(setCatalog, () => setCatalog(null));
    if (props.prefill) {
      setWorkflow("review");
      setMain(defaults("review").main);
      setReviewer(defaults("review").reviewer);
      setTitle(props.prefill.title);
      setRepoPath(props.prefill.repoPath ?? "");
      setMessage(props.prefill.message);
      setTestCommand(props.prefill.testCommand ?? "");
      setBase(props.prefill.base ?? "");
      setMaxRounds("3");
      setError(null);
    }
  }, [props.open, props.prefill]);

  const needsRepo = workflow === "implement" || workflow === "review" || workflow === "plan";
  useEffect(() => {
    if (needsRepo) setRepoPath((current) => current.trim() || lastRepo());
  }, [needsRepo]);
  useEffect(() => {
    if (!props.open || !needsRepo || !repoPath.trim()) return;
    let cancelled = false;
    setSettingsResult(null);
    const timer = setTimeout(() => {
      void client.repoSettings(repoPath.trim()).then((settings) => {
        if (!cancelled) setSettingsResult({ path: repoPath.trim(), settings });
      }, (err) => {
        if (!cancelled) setSettingsResult({ path: repoPath.trim(), settings: null, error: err instanceof Error ? err.message : String(err) });
      });
    }, 250);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [props.open, needsRepo, repoPath]);
  const settings = needsRepo && settingsResult?.path === repoPath.trim() ? settingsResult.settings : null;
  const settingsError = needsRepo && settingsResult?.path === repoPath.trim() ? settingsResult.error : undefined;
  useEffect(() => {
    if (!testEdited) setTestCommand(settings?.testCommand ?? props.prefill?.testCommand ?? "");
  }, [settings, testEdited, props.prefill?.testCommand]);
  useEffect(() => {
    if (!props.open || (workflow !== "implement" && workflow !== "review")) return;
    const baseline = defaults(workflow);
    setMain((current) => repositoryChoice(current, mainEdited, baseline.main, settings?.agents?.author));
    setReviewer((current) => repositoryChoice(current, reviewerEdited, baseline.reviewer, settings?.agents?.reviewer));
  }, [props.open, workflow, settings, mainEdited, reviewerEdited]);
  const ticketValid = !settings?.ticket || (!ticket.trim() ? workflow === "plan" || !settings.ticket.required : new RegExp(settings.ticket.pattern).test(ticket.trim()));
  const isVideo = workflow === "video";
  let estimateValid = true;
  try { estimateInput(estimateFiles, estimateLines); } catch { estimateValid = false; }
  const issueValid = !issue || (Number.isSafeInteger(Number(issue)) && Number(issue) > 0);
  const valid = issueValid && estimateValid && message.trim() && (!needsRepo || (repoPath.trim() && settingsResult?.path === repoPath.trim() && !settingsError)) && ticketValid && (!isVideo || /https?:\/\/\S+/.test(message));

  // Changing workflows starts with that workflow's shared defaults.
  const changeWorkflow = (w: WorkflowId) => {
    setWorkflow(w);
    setMainEdited(false);
    setReviewerEdited(false);
    const d = defaults(w);
    setMain(d.main);
    setReviewer(d.reviewer);
  };

  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      const review = workflow === "review";
      await props.onCreate({
        title: title.trim() || message.trim().split("\n")[0]!.slice(0, 60),
        workflow,
        agent: main.agent,
        effort: effortFor(main, catalog),
        model: main.model.trim() || undefined,
        reviewer: review ? reviewer.agent : undefined,
        reviewerEffort: review ? effortFor(reviewer, catalog) : undefined,
        reviewerModel: review ? reviewer.model.trim() : undefined,
        maxRounds: review ? Number(maxRounds) || undefined : undefined,
        testCommand: review || workflow === "implement" ? testCommand.trim() : undefined,
        ticket: settings?.ticket ? ticket.trim() || undefined : undefined,
        base: review || workflow === "implement" || workflow === "plan" ? base.trim() || undefined : undefined,
        repoPath: isVideo || main.agent === "gemini" ? undefined : repoPath.trim() || undefined,
        message: message.trim(),
        fromProposal: props.prefill?.fromProposal,
        ...(needsRepo ? issueChoiceInput(issueChoice) : {}),
        scopeEstimate: review || workflow === "implement" ? estimateInput(estimateFiles, estimateLines) : undefined,
      });
      if (needsRepo && repoPath.trim()) rememberRepo(repoPath.trim());
      setTitle("");
      setMessage("");
      setBase("");
      props.onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("newTask.title")}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4">
          <Field label={t("newTask.workflow")}>
            <Select value={workflow} onValueChange={(v) => changeWorkflow(v as WorkflowId)}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {WORKFLOWS.map((w) => (
                  <SelectItem key={w.id} value={w.id}>
                    {workflowLabel(w.id)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{t(WORKFLOWS.find((w) => w.id === workflow)!.hint)}</p>
          </Field>

          <AgentRow
            label={workflow === "review" ? t("role.author") : t("role.agent")}
            agents={taskAgents(workflow, catalog?.gemini !== undefined)}
            value={main}
            models={catalog?.[main.agent]}
            onChange={(v) => {
              setMainEdited(true);
              setMain(v);
            }}
          />
          {workflow === "review" && (
            <>
              <AgentRow label={t("role.reviewer")} value={reviewer} models={catalog?.[reviewer.agent]} onChange={(v) => { setReviewerEdited(true); setReviewer(v); }} />
              <div className="grid grid-cols-[6rem_1fr] gap-3">
                <Field label={t("newTask.maxRounds")}>
                  <Input type="number" min={1} max={10} value={maxRounds} onChange={(e) => setMaxRounds(e.target.value)} />
                </Field>
                <Field label={t("newTask.testCommand")}>
                  <Input value={testCommand} onChange={(e) => { setTestEdited(true); setTestCommand(e.target.value); }} placeholder={t("newTask.testPlaceholder")} />
                </Field>
              </div>
            </>
          )}

          {(workflow === "review" || workflow === "implement" || workflow === "plan") && (
            <Field label={t("newTask.base")}>
              <Input value={base} onChange={(e) => setBase(e.target.value)} placeholder={settings?.base ?? t("newTask.basePlaceholder")} />
            </Field>
          )}

          {workflow === "implement" && settings && (
            <Field label={t("newTask.testCommand")}>
              <Input value={testCommand} onChange={(e) => { setTestEdited(true); setTestCommand(e.target.value); }} placeholder={t("newTask.testPlaceholder")} />
            </Field>
          )}
          {(workflow === "implement" || workflow === "review") && <div className="grid grid-cols-2 gap-3">
            <Field label={t("scope.maxFiles")}><Input type="number" min={1} step={1} value={estimateFiles} aria-invalid={!estimateValid} onChange={(e) => setEstimateFiles(e.target.value)} /></Field>
            <Field label={t("scope.maxLines")}><Input type="number" min={1} step={1} value={estimateLines} aria-invalid={!estimateValid} onChange={(e) => setEstimateLines(e.target.value)} /></Field>
          </div>}
          {main.agent === "gemini" && <p className="text-xs text-muted-foreground">{t("newTask.geminiHint")}</p>}
          {!isVideo && main.agent !== "gemini" && (
            <Field label={needsRepo ? t("newTask.repository") : t("newTask.directory")}>
              <Input
                value={repoPath}
                onChange={(e) => setRepoPath(e.target.value)}
                placeholder={workflow === "plan" ? t("newTask.planRepoPlaceholder") : needsRepo ? t("newTask.repoPlaceholder") : t("newTask.directoryPlaceholder")}
              />
            </Field>
          )}
          {needsRepo && <IssueLinkFields issue={issue} completion={issueChoice.completion ?? (issue ? "complete" : "partial")} onChange={(number, mode, field) => setIssueChoice(current => changeIssueChoice(current, number, mode, field, props.prefill))} />}
          <Field label={t("newTask.optionalTitle")}>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t("newTask.titlePlaceholder")} />
          </Field>
          {settings?.ticket && (
            <Field label={t(settings.ticket.required && workflow !== "plan" ? "newTask.ticketRequired" : "newTask.ticket")}>
              <Input value={ticket} required={settings.ticket.required && workflow !== "plan"} aria-invalid={!ticketValid} onChange={(e) => setTicket(e.target.value)} />
              {ticket.trim() && !ticketValid && <p className="text-xs text-red-600">{t("newTask.ticketPattern", { pattern: settings.ticket.pattern })}</p>}
            </Field>
          )}
          <Field label={isVideo ? t("newTask.videoUrl") : t("newTask.request")}>
            <Textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={isVideo ? 3 : 5}
              // The field grows with its content (field-sizing-content); a spec from a proposal can be
              // pages long, which pushed the dialog's buttons a long scroll away. Cap it and scroll inside.
              className="max-h-[35dvh] overflow-y-auto"
              placeholder={isVideo ? t("newTask.videoPlaceholder") : t("newTask.describe")}
            />
          </Field>
          {isVideo && containsDriveUrl(message) && google && (!google.configured || google.account?.needsReauthorization || !google.account?.capabilities.includes("drive.read")) && <div className="text-sm">
            <p>{t("google.videoHint")}</p><Button variant="outline" onClick={props.onGoogle}>{t("google.connect")}</Button>
          </div>}
          {settingsError && <div className="text-sm text-red-600 dark:text-red-400">{settingsError}</div>}
          {error && <div className="text-sm text-red-600 dark:text-red-400">{error}</div>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => props.onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button onClick={() => void submit()} disabled={!valid || busy}>
            {busy ? t("newTask.starting") : t("newTask.start")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Agent, model and effort for one role, on one line. The models are the agent's own live list; the
 * effort choices are the ones the chosen model accepts, so a level it would ignore is never offered.
 */
function AgentRow({ label, value, models, onChange, agents = taskAgents("review", false) }: { agents?: AgentKind[]; label: string; value: AgentChoice; models?: ModelChoice[]; onChange: (v: AgentChoice) => void }) {
  useLanguage();
  // An agent's own "default" entry (Claude has one) names the default option instead of being listed twice.
  const builtinDefault = models?.find((m) => m.id === "default");
  const listed = (models ?? []).filter((m) => m.id !== "default");
  const chosen = value.model ? listed.find((m) => m.id === value.model) : builtinDefault;
  const levels = chosen ? chosen.effortLevels : [...EFFORT_LEVELS];
  const noEffort = !!chosen && !chosen.effortLevels?.length;

  const pickModel = (id: string) => {
    const model = id === DEFAULT_MODEL ? "" : id;
    const m = model ? listed.find((x) => x.id === model) : builtinDefault;
    // Keep the effort if the new model takes it; otherwise its own default, else the nearest it has.
    const ok = m?.effortLevels;
    const effort = !ok || ok.includes(value.effort) ? value.effort : (m!.defaultEffort ?? ok[Math.min(ok.length - 1, 1)]!);
    onChange({ ...value, model, effort });
  };

  return (
    <div className={value.agent === "gemini" ? "grid gap-3" : "grid grid-cols-[1fr_1.6fr_7rem] gap-3 max-sm:grid-cols-2"}>
      <Field label={label}>
        <Select value={value.agent} onValueChange={(v) => onChange({ ...value, agent: v as AgentKind, model: "" })}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {agents.map(agent => <SelectItem key={agent} value={agent}>{t(`agent.${agent}`)}</SelectItem>)}
          </SelectContent>
        </Select>
      </Field>
      {value.agent !== "gemini" && <>
        <Field label={t("newTask.model")}>
          <Select value={value.model || DEFAULT_MODEL} onValueChange={pickModel}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={DEFAULT_MODEL}>
                {builtinDefault ? `${builtinDefault.label}` : t("common.default")}
                {builtinDefault?.description && <span className="text-muted-foreground"> · {builtinDefault.description.split(" · ")[0]}</span>}
              </SelectItem>
              {models === undefined && (
                <SelectItem value="__loading" disabled>
                  {t("newTask.loadingModels")}
                </SelectItem>
              )}
              {listed.map((m) => (
                <SelectItem key={m.id} value={m.id}>
                  <span className="flex flex-col">
                    <span>{m.label}</span>
                    {m.description && <span className="text-xs text-muted-foreground">{m.description}</span>}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label={t("newTask.effort")} className="max-sm:col-span-2">
          <Select value={noEffort ? "__none" : value.effort} onValueChange={(v) => onChange({ ...value, effort: v as EffortLevel })} disabled={noEffort}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {noEffort ? (
                <SelectItem value="__none">{t("newTask.noEffort")}</SelectItem>
              ) : (
                (levels ?? EFFORT_LEVELS).map((e) => (
                  <SelectItem key={e} value={e}>
                    {effortLabel(e)}
                  </SelectItem>
                ))
              )}
            </SelectContent>
          </Select>
        </Field>
      </>}
    </div>
  );
}

function Field({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={`grid gap-1.5 ${className ?? ""}`}>
      <Label>{label}</Label>
      {children}
    </div>
  );
}

/** A model that takes no effort setting (e.g. Haiku) gets none rather than one it would reject. */
function effortFor(c: AgentChoice, catalog: ModelCatalog | null): EffortLevel | undefined {
  const m = c.model ? catalog?.[c.agent]?.find((x) => x.id === c.model) : undefined;
  return c.agent === "gemini" || m && !m.effortLevels?.length ? undefined : c.effort;
}
