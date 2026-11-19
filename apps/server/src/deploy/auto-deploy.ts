import type { DeployStatus } from "@agent-hub/shared";

// One pass of continuous deployment, run by a systemd timer on the production host. The host pulls
// instead of GitHub pushing: nothing on the tailnet is exposed, and a deploy waits for the Hub to
// be idle, which a CI job could only do by holding a runner. Deploys go through the Hub's own
// POST /api/deploy, so they get the same checks and the same lock as the sidebar button.

export interface CheckRun { name: string; status: string; conclusion: string | null }
export type CiState = "success" | "pending" | "failure";
export interface AutoDeployState { reported?: string }
export interface AutoDeployDeps {
  hub(method: "GET" | "POST", body?: unknown): Promise<{ status: number; body: unknown }>;
  /** Calls the GitHub REST API for the production repository; `path` is relative to the repository. */
  github(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown>;
  readState(): Promise<AutoDeployState>;
  writeState(state: AutoDeployState): Promise<void>;
  log(message: string): void;
  /** Check runs that must exist and pass; their absence means CI has not reported yet. */
  requiredChecks: string[];
}
export type AutoDeployResult =
  | "disabled" | "busy" | "up_to_date" | "dirty" | "failed_before" | "ci_pending" | "ci_failed" | "refused" | "started";

const PASSING = new Set(["success", "skipped", "neutral"]);

export function ciState(runs: CheckRun[], required: string[]): CiState {
  if (runs.some((run) => run.status === "completed" && !PASSING.has(run.conclusion ?? ""))) return "failure";
  if (runs.some((run) => run.status !== "completed")) return "pending";
  if (required.some((name) => !runs.some((run) => run.name === name))) return "pending";
  return "success";
}

/** owner/name from an SSH or HTTPS GitHub remote URL. */
export function githubRepo(remote: string): string {
  const match = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(remote.trim());
  if (!match) throw new Error("origin is not a GitHub repository");
  return `${match[1]}/${match[2]}`;
}

const message = (err: unknown) => err instanceof Error ? err.message : String(err);

// Mirrors the outcome of every deploy, including ones started from the sidebar, as a GitHub
// deployment, so the repository shows which commit production runs. Reporting is best effort: it
// never blocks a deploy, and an unreported outcome is retried on the next pass.
async function report(last: DeployStatus["last"], deps: AutoDeployDeps): Promise<void> {
  if (!last || last.outcome === "running") return;
  const key = `${last.sha} ${last.requestedAt}`;
  const state = await deps.readState();
  if (state.reported === key) return;
  // The first pass records a baseline instead of reporting history: the last button deploy may be
  // long superseded by deploys made with the script, and GitHub would then show the wrong commit.
  if (state.reported === undefined) { await deps.writeState({ ...state, reported: key }); return; }
  try {
    const deployment = await deps.github("POST", "deployments", {
      ref: last.sha, environment: "production", production_environment: true,
      auto_merge: false, required_contexts: [], description: "Agent Hub deploy",
    }) as { id?: unknown };
    if (typeof deployment?.id !== "number") throw new Error("GitHub did not return a deployment id");
    await deps.github("POST", `deployments/${deployment.id}/statuses`, {
      state: last.outcome === "succeeded" ? "success" : "failure",
      description: last.outcome === "succeeded" ? "Deployed" : `Failed (${last.result ?? "unknown"})`,
    });
    await deps.writeState({ ...state, reported: key });
  } catch (err) {
    deps.log(`Could not report deploy of ${last.sha} to GitHub: ${message(err)}`);
  }
}

export async function autoDeployOnce(deps: AutoDeployDeps): Promise<AutoDeployResult> {
  const response = await deps.hub("GET");
  if (response.status !== 200) throw new Error(`GET /api/deploy returned HTTP ${response.status}`);
  const status = response.body as DeployStatus;
  await report(status.last, deps);
  if (!status.enabled) { deps.log(`Deploy disabled: ${status.disabledReason ?? "unknown"}`); return "disabled"; }
  if (status.deploying || status.last?.outcome === "running") return "busy";
  if (!status.target || status.pending.length === 0) return "up_to_date";
  if (status.dirty) { deps.log("Production checkout is dirty; not deploying"); return "dirty"; }
  const sha = status.target.sha;
  // A failed deploy has already been rolled back; retrying the same commit would fail the same
  // way and restart the Hub every pass. The next commit on main, or the sidebar button, moves on.
  if (status.last?.sha === sha && status.last.outcome === "failed") {
    deps.log(`Deploy of ${sha} failed before; waiting for a new commit on main`);
    return "failed_before";
  }
  const runs = await deps.github("GET", `commits/${sha}/check-runs?per_page=100`) as { check_runs?: CheckRun[] };
  const ci = ciState(runs.check_runs ?? [], deps.requiredChecks);
  if (ci === "pending") return "ci_pending";
  if (ci === "failure") { deps.log(`CI failed for ${sha}; not deploying`); return "ci_failed"; }
  const started = await deps.hub("POST", { sha });
  // 409 covers running tasks, a moved main and a concurrent deploy: all resolve on a later pass.
  if (started.status === 409) {
    const reason = (started.body as { error?: string } | null)?.error ?? "conflict";
    deps.log(`Hub refused deploy of ${sha}: ${reason}`);
    return "refused";
  }
  if (started.status !== 200) throw new Error(`POST /api/deploy returned HTTP ${started.status}`);
  deps.log(`Started deploy of ${sha}: ${status.target.subject}`);
  return "started";
}
