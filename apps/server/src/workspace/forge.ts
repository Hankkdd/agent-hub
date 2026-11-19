import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { PrRevision, Workspace } from "@agent-hub/shared";

const exec = promisify(execFile);

export type PrState = "open" | "merged" | "closed";

export interface PullRequest {
  number: number;
  url: string;
  state: PrState;
}

export type IssueState = "open" | "closed";

export interface IssueSummary {
  number: number;
  title: string;
  state: IssueState;
  labels: string[];
}

export interface Issue extends IssueSummary {
  url: string;
  body: string;
  comments: { author: string; date: string; text: string }[];
}

export interface IssueComment { id: number; url: string }
export type CommentReconciliation = { state: "found"; comment: IssueComment } | { state: "unknown" };
export class CommentWriteError extends Error {
  constructor(readonly definite: boolean) { super(definite ? "GitHub rejected the comment" : "GitHub comment outcome is uncertain"); }
}

function commentResult(value: unknown, repo: string, number: number, body: string): IssueComment {
  const v = value as { id?: unknown; html_url?: unknown; body?: unknown; issue_url?: unknown } | null;
  if (!v || !Number.isSafeInteger(v.id) || (v.id as number) < 1 || v.body !== body ||
    typeof v.issue_url !== "string" || v.issue_url.toLowerCase() !== `https://api.github.com/repos/${repo}/issues/${number}`.toLowerCase() ||
    typeof v.html_url !== "string" || v.html_url.toLowerCase() !== `https://github.com/${repo}/issues/${number}#issuecomment-${v.id}`.toLowerCase()) throw new CommentWriteError(false);
  return { id: v.id as number, url: v.html_url as string };
}

/**
 * Where a task's branch is published and reviewed: the source of truth once a pull request exists
 * (merges happen there, not on this machine). The Hub talks only to this interface, so tests run on a
 * fake and another host (Gitea, GitLab) is one more implementation.
 *
 * Every call here runs on the HOST with the user's own git and gh credentials; an agent never gets them.
 */
export interface Forge {
  /** "owner/name" when this repository lives on this forge, else null. */
  repoOf(repoPath: string): Promise<string | null>;
  /** Read-only issue access, using host credentials. Pull requests are excluded. */
  listIssues(repo: string, state: IssueState | "all", limit: number): Promise<IssueSummary[]>;
  readIssue(repo: string, number: number): Promise<Issue>;
  /** Optional capability: older/non-GitHub providers retain read/PR behavior without comment writes. */
  createIssueComment?(repo: string, number: number, body: string): Promise<IssueComment>;
  reconcileIssueComment?(repo: string, number: number, body: string, operationId: string): Promise<CommentReconciliation>;
  /** Push the task branch (creating it remotely on the first push). */
  push(ws: Workspace, options?: { signal: AbortSignal; sha: string }): Promise<void>;
  openPullRequest(ws: Workspace, repo: string, title: string, body: string): Promise<PullRequest>;
  state(repo: string, number: number): Promise<PrState>;
  inspectPullRequest?(repo: string, number: number, signal?: AbortSignal): Promise<PrRevision & { state: PrState; mergeable: "CONFLICTING" | "MERGEABLE" | "UNKNOWN" }>;
  /** Close without merging, and delete the remote branch. */
  close(repo: string, number: number): Promise<void>;
}

/** A remote URL on github.com, ssh or https, as "owner/name". */
export function parseGithubRemote(url: string): string | null {
  const m = url.trim().match(/^(?:git@github\.com:|(?:https?|ssh):\/\/(?:[^/@\s]+@)?github\.com\/)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

export class GitHubForge implements Forge {
  async createIssueComment(repo: string, number: number, body: string): Promise<IssueComment> {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-hub-comment-"));
    const bodyFile = path.join(directory, "body.json");
    let sent = false;
    try {
      const account = await exec("gh", ["api", "--hostname", "github.com", "user"], {
        cwd: os.homedir(), timeout: 10000, maxBuffer: 65536,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1" },
      });
      const login: unknown = JSON.parse(account.stdout).login;
      if (typeof login !== "string" || !login) throw new Error("Host account unavailable");
      fs.writeFileSync(bodyFile, JSON.stringify({ body }), { mode: 0o600 });
      sent = true;
      const { stdout } = await exec("gh", ["api", "--hostname", "github.com", `repos/${repo}/issues/${number}/comments`, "--method", "POST", "--input", bodyFile], {
        cwd: os.homedir(), timeout: 30000, maxBuffer: 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1" },
      });
      const result = JSON.parse(stdout);
      if (result?.user?.login !== login) throw new CommentWriteError(false);
      return commentResult(result, repo, number, body);
    } catch (error) {
      if (error instanceof CommentWriteError) throw error;
      // Only explicit rejection is safe to retry. Timeouts/5xx/invalid success can hide an accepted POST.
      const stderr = (error as { stderr?: string }).stderr ?? "";
      throw new CommentWriteError(!sent || /\(HTTP (?:400|401|403|404|422|429)\)/.test(stderr));
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  }

  async reconcileIssueComment(repo: string, number: number, body: string, operationId: string): Promise<CommentReconciliation> {
    const deadline = Date.now() + 30000;
    const { stdout } = await run("gh", ["api", "--hostname", "github.com", "user"], os.homedir(), 10000);
    const login: unknown = JSON.parse(stdout).login;
    if (typeof login !== "string" || !login) return { state: "unknown" };
    const marker = `<!-- agent-hub-requirements:${operationId} -->`;
    const matches: IssueComment[] = [];
    let conflict = false;
    // Ten pages / 1000 comments / 30 seconds total at most; incomplete search never proves absence.
    for (let page = 1; page <= 10; page++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { state: "unknown" };
      const result = await run("gh", ["api", "--hostname", "github.com", `repos/${repo}/issues/${number}/comments?per_page=100&page=${page}`], os.homedir(), Math.min(remaining, 10000));
      const comments: unknown = JSON.parse(result.stdout);
      if (!Array.isArray(comments) || comments.length > 100) return { state: "unknown" };
      for (const comment of comments) {
        if (typeof comment?.body !== "string" || !comment.body.includes(marker)) continue;
        try {
          if (comment.user?.login !== login) { conflict = true; continue; }
          matches.push(commentResult(comment, repo, number, body));
        } catch { conflict = true; }
      }
      if (comments.length < 100) return !conflict && matches.length === 1 ? { state: "found", comment: matches[0]! } : { state: "unknown" };
    }
    return { state: "unknown" };
  }

  async listIssues(repo: string, state: IssueState | "all", limit: number): Promise<IssueSummary[]> {
    // gh issue list excludes PRs and applies the limit to issues, rather than mixed REST results.
    const { stdout } = await run("gh", ["issue", "list", "--repo", `github.com/${repo}`, "--state", state, "--limit", String(limit), "--json", "number,title,state,labels"], os.homedir(), 30_000);
    const issues = JSON.parse(stdout) as { number: number; title: string; state: string; labels: { name: string }[] }[];
    return issues.map((issue) => ({ ...issue, state: issue.state.toLowerCase() as IssueState, labels: issue.labels.map((label) => label.name) }));
  }

  async readIssue(repo: string, number: number): Promise<Issue> {
    const endpoint = `repos/${repo}/issues/${number}`;
    const { stdout } = await run("gh", ["api", "--hostname", "github.com", endpoint], os.homedir(), 30_000);
    const issue = JSON.parse(stdout) as { number: number; title: string; state: IssueState; labels: { name: string }[]; html_url: string; body: string | null; pull_request?: unknown };
    if (issue.pull_request) throw new Error(`#${number} is a pull request, not an issue`);
    // REST pagination includes every comment; a single GraphQL connection can silently stop at 100.
    // --slurp needs a newer gh than the host's 2.45.0; --jq emits one JSON object per line instead.
    const comments = await run("gh", ["api", "--hostname", "github.com", `${endpoint}/comments?per_page=100`, "--paginate", "--jq", '.[] | {author: (.user.login // "deleted"), date: .created_at, text: (.body // "")}'], os.homedir(), 30_000);
    return {
      number: issue.number, title: issue.title, state: issue.state, labels: issue.labels.map((label) => label.name),
      url: issue.html_url, body: issue.body ?? "",
      comments: comments.stdout.split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line) as Issue["comments"][number]),
    };
  }

  async repoOf(repoPath: string): Promise<string | null> {
    try {
      const { stdout } = await exec("git", ["remote", "get-url", "origin"], { cwd: repoPath, timeout: 10000, maxBuffer: 65536 });
      return parseGithubRemote(stdout);
    } catch {
      return null; // no origin
    }
  }

  async push(ws: Workspace, options?: { signal: AbortSignal; sha: string }): Promise<void> {
    if (!options) {
      await run("git", ["push", "-u", "origin", ws.remoteBranch ? `${ws.branch}:refs/heads/${ws.remoteBranch}` : ws.branch], ws.worktreePath);
      return;
    }
    await exec("git", ["push", "origin", `${options.sha}:refs/heads/${ws.remoteBranch ?? ws.branch}`], {
      cwd: ws.worktreePath, signal: options.signal, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, timeout: 60_000,
    });
  }

  async openPullRequest(ws: Workspace, repo: string, title: string, body: string): Promise<PullRequest> {
    // The body goes through a file: it is long, multi-line Markdown, and must never be shell-parsed.
    const bodyFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agent-hub-pr-")), "body.md");
    fs.writeFileSync(bodyFile, body);
    try {
      const { stdout } = await run("gh", ["pr", "create", "--repo", repo, "--head", ws.remoteBranch ?? ws.branch, "--base", ws.prBase ?? ws.baseRef, "--title", title, "--body-file", bodyFile], ws.repoPath);
      const url = stdout.trim().split("\n").pop()!.trim();
      const number = Number(url.match(/\/pull\/(\d+)/)?.[1]);
      if (!number) throw new Error(`gh did not return a pull request URL: ${stdout.trim()}`);
      return { number, url, state: "open" };
    } finally {
      fs.rmSync(path.dirname(bodyFile), { recursive: true, force: true });
    }
  }

  async inspectPullRequest(repo: string, number: number, signal?: AbortSignal) {
    const [owner, name] = repo.split("/");
    const query = "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){state mergeable isCrossRepository baseRefName headRefName headRefOid baseRef{target{oid}}}}}";
    const { stdout } = await run("gh", ["api", "graphql", "-f", `query=${query}`, "-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `number=${number}`], os.homedir(), 30_000, signal);
    const value = JSON.parse(stdout)?.data?.repository?.pullRequest;
    if (!value || !["OPEN", "MERGED", "CLOSED"].includes(value.state) ||
      ![value.baseRef?.target?.oid, value.headRefOid].every((sha) => typeof sha === "string" && /^[a-f0-9]{40}$/.test(sha)) ||
      ![value.baseRefName, value.headRefName].every((ref) => typeof ref === "string" && ref.length > 0) || typeof value.isCrossRepository !== "boolean")
      throw new Error("Invalid pull request revision data");
    return { state: value.state.toLowerCase() as PrState, mergeable: value.mergeable === "CONFLICTING" ? "CONFLICTING" as const : value.mergeable === "MERGEABLE" ? "MERGEABLE" as const : "UNKNOWN" as const,
      head: value.headRefName as string, headSha: value.headRefOid as string, target: value.baseRefName as string, targetSha: value.baseRef?.target?.oid as string, crossRepository: value.isCrossRepository as boolean };
  }

  async state(repo: string, number: number): Promise<PrState> {
    const { stdout } = await run("gh", ["pr", "view", String(number), "--repo", repo, "--json", "state"], os.homedir());
    const s = String(JSON.parse(stdout).state).toUpperCase();
    return s === "MERGED" ? "merged" : s === "CLOSED" ? "closed" : "open";
  }

  async close(repo: string, number: number): Promise<void> {
    await run("gh", ["pr", "close", String(number), "--repo", repo, "--delete-branch"], os.homedir());
  }
}

async function run(cmd: string, args: string[], cwd: string, timeout?: number, signal?: AbortSignal): Promise<{ stdout: string }> {
  try {
    return await exec(cmd, args, { cwd, timeout, signal, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1" } });
  } catch (err) {
    const e = err as { stderr?: string; message: string };
    throw new Error(`${cmd} ${args[0]} ${args[1] ?? ""} failed: ${(e.stderr || e.message).trim()}`);
  }
}
