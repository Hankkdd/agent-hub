import type { Workspace } from "@agent-hub/shared";
import { execFile } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GitHubForge } from "../src/workspace/forge";

// Keep the host command boundary covered without credentials or network access.
vi.mock("node:child_process", async () => {
  const { promisify } = await import("node:util");
  const execFile = vi.fn();
  Object.assign(execFile, {
    [promisify.custom]: (...args: unknown[]) => new Promise((resolve, reject) => {
      execFile(...args, (error: Error | null, stdout: string, stderr: string) => error ? reject(error) : resolve({ stdout, stderr }));
    }),
  });
  return { execFile };
});

const command = vi.mocked(execFile);
function reply(value: unknown) {
  replyOutput(JSON.stringify(value));
}

function replyOutput(stdout: string) {
  command.mockImplementationOnce((...args: unknown[]) => {
    const callback = args.at(-1) as (error: Error | null, stdout: string, stderr: string) => void;
    callback(null, stdout, "");
    return undefined as never;
  });
}

beforeEach(() => command.mockReset());

describe("GitHub issue commands", () => {
  it.each(["open", "closed", "all"] as const)("lists %s issues through the issue-only command with the requested limit", async (state) => {
    reply([{ number: 7, title: "A todo", state: "OPEN", labels: [{ name: "bug" }] }]);
    expect(await new GitHubForge().listIssues("example/project", state, 100)).toEqual([
      { number: 7, title: "A todo", state: "open", labels: ["bug"] },
    ]);
    expect(command).toHaveBeenCalledWith("gh", ["issue", "list", "--repo", "github.com/example/project", "--state", state, "--limit", "100", "--json", "number,title,state,labels"], expect.objectContaining({
      timeout: 30_000,
      env: expect.objectContaining({ GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1" }),
    }), expect.any(Function));
  });

  it("reads the body and parses line-delimited comments across pages, pinning the API hostname", async () => {
    reply({ number: 7, title: "A todo", state: "closed", labels: [{ name: "bug" }], html_url: "https://github.com/example/project/issues/7", body: "Requirements" });
    const comment = { author: "example", date: "2026-01-01T00:00:00Z", text: 'Details\nwith "quotes"' };
    const lastComment = { ...comment, author: "deleted", text: "" };
    replyOutput([...Array.from({ length: 100 }, () => comment), lastComment].map((comment) => JSON.stringify(comment)).join("\n") + "\n");
    const issue = await new GitHubForge().readIssue("example/project", 7);
    expect(issue).toMatchObject({ number: 7, title: "A todo", state: "closed", labels: ["bug"], url: "https://github.com/example/project/issues/7", body: "Requirements" });
    expect(issue.comments).toHaveLength(101);
    expect(issue.comments[0]).toEqual(comment);
    expect(issue.comments[100]).toEqual(lastComment);
    expect(command.mock.calls.map((call) => call[1])).toEqual([
      ["api", "--hostname", "github.com", "repos/example/project/issues/7"],
      ["api", "--hostname", "github.com", "repos/example/project/issues/7/comments?per_page=100", "--paginate", "--jq", '.[] | {author: (.user.login // "deleted"), date: .created_at, text: (.body // "")}'],
    ]);
    for (const call of command.mock.calls) expect(call[2]).toMatchObject({ timeout: 30_000, env: { GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1" } });
  });

  it.each(["", "\n \n"])("parses empty comment output %j as no comments", async (output) => {
    reply({ number: 7, title: "A todo", state: "open", labels: [], html_url: "https://github.com/example/project/issues/7", body: null });
    replyOutput(output);
    expect((await new GitHubForge().readIssue("example/project", 7)).comments).toEqual([]);
  });

  it("rejects a PR number without fetching its comments", async () => {
    reply({ number: 8, pull_request: { url: "https://api.github.com/repos/example/project/pulls/8" } });
    await expect(new GitHubForge().readIssue("example/project", 8)).rejects.toThrow("#8 is a pull request, not an issue");
    expect(command).toHaveBeenCalledTimes(1);
  });

  it("reports gh errors clearly", async () => {
    command.mockImplementationOnce((...args: unknown[]) => {
      const callback = args.at(-1) as (error: Error) => void;
      callback(Object.assign(new Error("command failed"), { stderr: "Not Found (HTTP 404)" }));
      return undefined as never;
    });
    await expect(new GitHubForge().readIssue("example/project", 999)).rejects.toThrow("gh api --hostname failed: Not Found (HTTP 404)");
  });
});


describe("GitHub PR publication commands", () => {
  const workspace: Workspace = { id: "ws", repoPath: "/example/repo", worktreePath: "/example/worktree", branch: "agent-hub/private", remoteBranch: "feat/ACME-84-durable-recovery-status", baseRef: "origin/main", prBase: "main", baseSha: "base", state: "active" };

  it("pushes an explicit local-to-remote refspec and opens the PR against the remote branch's base", async () => {
    replyOutput("");
    await new GitHubForge().push(workspace);
    expect(command.mock.calls[0]![1]).toEqual(["push", "-u", "origin", "agent-hub/private:refs/heads/feat/ACME-84-durable-recovery-status"]);
    replyOutput("https://github.com/example/project/pull/11\n");
    expect(await new GitHubForge().openPullRequest(workspace, "example/project", "[ACME-84] feat: Add recovery", "English body")).toMatchObject({ number: 11 });
    const args = command.mock.calls[1]![1] as string[];
    expect(args.slice(0, 10)).toEqual(["pr", "create", "--repo", "example/project", "--head", workspace.remoteBranch, "--base", "main", "--title", "[ACME-84] feat: Add recovery"]);
    expect(args[10]).toBe("--body-file");
  });

  it("keeps the original branch and base arguments when there is no remote branch setting", async () => {
    replyOutput("");
    const original = { ...workspace, remoteBranch: undefined, baseRef: "origin/local-feature", prBase: undefined };
    await new GitHubForge().push(original);
    expect(command.mock.calls[0]![1]).toEqual(["push", "-u", "origin", "agent-hub/private"]);
    replyOutput("https://github.com/example/project/pull/11\n");
    await new GitHubForge().openPullRequest(original, "example/project", "Original title", "Original body");
    expect(command.mock.calls[1]![1]).toEqual(expect.arrayContaining(["--head", "agent-hub/private", "--base", "origin/local-feature"]));
  });
});

// These tests inspect exact execFile inputs; shell-looking Markdown is never executed.
describe("host-owned requirement comment transport", () => {
  const repo = "example/project";
  const body = '## 驗收條件\n\n1. `$(touch /never)` "$HOME" \'quotes\'\n<!-- agent-hub-requirements:operation -->';
  const remote = (extra = {}) => ({ id: 42, html_url: "https://github.com/example/project/issues/7#issuecomment-42", issue_url: "https://api.github.com/repos/example/project/issues/7", body, user: { login: "host-account" }, ...extra });
  it("serializes multiline Unicode Markdown as protected JSON in a cleaned temporary file, with finite process/output limits", async () => {
    const fs = await import("node:fs");
    let file = "";
    reply({ login: "host-account" });
    command.mockImplementationOnce((...args: unknown[]) => {
      expect(args[0]).toBe("gh");
      const argv = args[1] as string[];
      expect(argv.slice(0, 7)).toEqual(["api", "--hostname", "github.com", "repos/example/project/issues/7/comments", "--method", "POST", "--input"]);
      file = argv[7]!;
      expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ body });
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      expect(args[2]).toMatchObject({ timeout: 30000, maxBuffer: 1024 * 1024 });
      (args.at(-1) as Function)(null, JSON.stringify(remote()), "");
      return undefined as never;
    });
    expect(await new GitHubForge().createIssueComment(repo, 7, body)).toEqual({ id: 42, url: remote().html_url });
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync((await import("node:path")).dirname(file))).toBe(false);
  });
  it.each(["timeout", "invalid success", "wrong destination", "wrong author", "rejection"])("classifies %s conservatively and cleans files", async (kind) => {
    const fs = await import("node:fs"); let file = "";
    reply({ login: "host-account" });
    command.mockImplementationOnce((...args: unknown[]) => {
      file = (args[1] as string[]).at(-1)!;
      const cb = args.at(-1) as Function;
      if (kind === "timeout") cb(Object.assign(new Error("timed out"), { killed: true }));
      else if (kind === "rejection") cb(Object.assign(new Error("rejected"), { stderr: "Forbidden (HTTP 403)" }));
      else cb(null, kind === "invalid success" ? "not JSON" : JSON.stringify(remote(kind === "wrong author" ? { user: { login: "attacker" } } : { issue_url: "https://api.github.com/repos/other/project/issues/7" })), "");
      return undefined as never;
    });
    await expect(new GitHubForge().createIssueComment(repo, 7, body)).rejects.toMatchObject({ definite: kind === "rejection" });
    expect(fs.existsSync(file)).toBe(false);
  });
  it("recovers exactly one matching body/marker/destination by the host account after bounded complete pagination", async () => {
    reply({ login: "host-account" }); reply(Array(100).fill({ body: "other" })); reply([remote()]);
    expect(await new GitHubForge().reconcileIssueComment(repo, 7, body, "operation")).toEqual({ state: "found", comment: { id: 42, url: remote().html_url } });
    expect(command.mock.calls.map((call) => call[1])).toEqual([
      ["api", "--hostname", "github.com", "user"],
      ["api", "--hostname", "github.com", "repos/example/project/issues/7/comments?per_page=100&page=1"],
      ["api", "--hostname", "github.com", "repos/example/project/issues/7/comments?per_page=100&page=2"],
    ]);
    for (const call of command.mock.calls) expect((call[2] as { timeout: number }).timeout).toBeLessThanOrEqual(10000);
  });
  it.each(["absent", "body mismatch", "wrong author", "duplicate", "wrong destination", "conflict"])("keeps %s uncertain without POST/edit/delete", async (kind) => {
    reply({ login: "host-account" });
    const items = kind === "absent" ? [] : kind === "duplicate" ? [remote(), remote({ id: 43, html_url: "https://github.com/example/project/issues/7#issuecomment-43" })] : kind === "wrong author" ? [remote({ user: { login: "attacker" } })] : kind === "body mismatch" ? [remote({ body: body + " changed" })] : kind === "wrong destination" ? [remote({ issue_url: "other" })] : [remote(), remote({ body: body + "conflict" })];
    reply(items);
    expect(await new GitHubForge().reconcileIssueComment(repo, 7, body, "operation")).toEqual({ state: "unknown" });
    expect(command.mock.calls.flatMap((call) => call[1] as string[])).not.toContain("POST");
  });
  it("never treats a truncated ten-page search as complete, even with a candidate match", async () => {
    reply({ login: "host-account" });
    for (let page = 0; page < 10; page++) reply([...(page === 0 ? [remote()] : [{ body: "other" }]), ...Array(99).fill({ body: "other" })]);
    expect(await new GitHubForge().reconcileIssueComment(repo, 7, body, "operation")).toEqual({ state: "unknown" });
    expect(command).toHaveBeenCalledTimes(11);
  });
});

describe("GitHub PR update observations", () => {
  const observed = { state: "OPEN", mergeable: "CONFLICTING", baseRefName: "release/v2", baseRef: { target: { oid: "a".repeat(40) } }, headRefName: "feat/example", headRefOid: "b".repeat(40), isCrossRepository: false };
  const response = (pullRequest: unknown) => ({ data: { repository: { pullRequest } } });
  it.each(["CONFLICTING", "MERGEABLE", "UNKNOWN", null, "PENDING"])("reads actual branches and immutable revisions with mergeability %s", async (mergeable) => {
    reply(response({ ...observed, mergeable }));
    const signal = new AbortController().signal;
    const value = await new GitHubForge().inspectPullRequest("example/project", 41, signal);
    expect(value).toEqual({ state: "open", mergeable: mergeable === "CONFLICTING" ? "CONFLICTING" : mergeable === "MERGEABLE" ? "MERGEABLE" : "UNKNOWN", head: observed.headRefName, headSha: observed.headRefOid, target: observed.baseRefName, targetSha: observed.baseRef.target.oid, crossRepository: false });
    expect(command).toHaveBeenCalledWith("gh", ["api", "graphql", "-f", "query=query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){state mergeable isCrossRepository baseRefName headRefName headRefOid baseRef{target{oid}}}}}", "-f", "owner=example", "-f", "name=project", "-F", "number=41"], expect.objectContaining({
      signal, timeout: 30_000,
      env: expect.objectContaining({ GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1" }),
    }), expect.any(Function));
  });
  it.each(["OPEN", "MERGED", "CLOSED"])("maps lifecycle state %s", async (state) => {
    reply(response({ ...observed, state }));
    expect((await new GitHubForge().inspectPullRequest("example/project", 41)).state).toBe(state.toLowerCase());
  });
  it.each([
    null,
    { ...observed, baseRef: null },
    { ...observed, baseRef: undefined },
    { ...observed, baseRef: { target: null } },
    { ...observed, baseRef: { target: { oid: "bad" } } },
    { ...observed, baseRef: { target: { oid: "g".repeat(40) } } },
    { ...observed, headRefOid: "b".repeat(39) },
    { ...observed, headRefOid: null },
    { ...observed, baseRefName: undefined },
    { ...observed, baseRefName: "" },
    { ...observed, headRefName: "" },
    { ...observed, isCrossRepository: "false" },
    { ...observed, isCrossRepository: undefined },
    { ...observed, state: "INVALID" },
  ])("rejects malformed revision data %j instead of guessing the target", async (value) => {
    reply(response(value));
    await expect(new GitHubForge().inspectPullRequest("example/project", 41)).rejects.toThrow("Invalid pull request revision data");
  });
  it.each([{}, { data: null }, { data: { repository: null } }, { data: { repository: {} } }])("rejects missing pull requests in %j", async (value) => {
    reply(value);
    await expect(new GitHubForge().inspectPullRequest("example/project", 41)).rejects.toThrow("Invalid pull request revision data");
  });
  it("pushes only the validated SHA using a cancellable ordinary non-force push", async () => {
    const ws: Workspace = { id: "ws", repoPath: "/example/repo", worktreePath: "/example/worktree", branch: "local/task", remoteBranch: "feature/task", baseRef: "release", baseSha: "a".repeat(40), state: "active" };
    replyOutput("");
    const signal = new AbortController().signal;
    await new GitHubForge().push(ws, { sha: "b".repeat(40), signal });
    expect(command.mock.calls[0]![1]).toEqual(["push", "origin", `${"b".repeat(40)}:refs/heads/feature/task`]);
    expect(command.mock.calls[0]![2]).toMatchObject({ signal, cwd: ws.worktreePath });
  });
});
