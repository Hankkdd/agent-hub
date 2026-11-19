import type { DeployStatus } from "@agent-hub/shared";
import { beforeEach, expect, it } from "vitest";
import { autoDeployOnce, ciState, githubRepo, type AutoDeployDeps, type AutoDeployState, type CheckRun } from "../src/deploy/auto-deploy";

const current = "a".repeat(40), target = "b".repeat(40);
let status: DeployStatus, runs: CheckRun[], postStatus: number, state: AutoDeployState;
let calls: string[], logs: string[], githubFails: boolean;

const passing: CheckRun[] = [
  { name: "check", status: "completed", conclusion: "success" },
  { name: "images", status: "completed", conclusion: "skipped" },
];

beforeEach(() => {
  status = {
    enabled: true, current: { sha: current, subject: "Current" }, target: { sha: target, subject: "Target" },
    pending: [{ sha: target, subject: "Target" }], dirty: false, deploying: false, history: null, last: null,
  };
  runs = passing;
  postStatus = 200;
  state = { reported: "" };
  calls = [];
  logs = [];
  githubFails = false;
});

const deps = (): AutoDeployDeps => ({
  async hub(method, body) {
    calls.push(`hub ${method}${body ? ` ${JSON.stringify(body)}` : ""}`);
    if (method === "GET") return { status: 200, body: status };
    return { status: postStatus, body: postStatus === 409 ? { error: "Finish running and waiting tasks before deploying" } : status };
  },
  async github(method, path, body) {
    calls.push(`github ${method} ${path}${body ? ` ${JSON.stringify(body)}` : ""}`);
    if (githubFails) throw new Error("gh: not logged in");
    if (path.startsWith("commits/")) return { check_runs: runs };
    if (path === "deployments") return { id: 7 };
    return {};
  },
  async readState() { return state; },
  async writeState(next) { state = next; },
  log: (line) => logs.push(line),
  requiredChecks: ["check"],
});

it("deploys origin/main once its CI passed", async () => {
  expect(await autoDeployOnce(deps())).toBe("started");
  expect(calls).toEqual([
    "hub GET", `github GET commits/${target}/check-runs?per_page=100`, `hub POST {"sha":"${target}"}`,
  ]);
});

it.each([
  ["nothing is pending", () => { status.pending = []; }, "up_to_date"],
  ["deploy is disabled", () => { status.enabled = false; status.disabledReason = "unit_not_installed"; }, "disabled"],
  ["a deploy is in progress", () => { status.deploying = true; }, "busy"],
  ["the last deploy is still running", () => { status.last = { sha: target, requestedAt: "2026-01-01T00:00:00Z", outcome: "running" }; }, "busy"],
  ["the checkout is dirty", () => { status.dirty = true; }, "dirty"],
] as const)("does not touch GitHub or deploy when %s", async (_, arrange, result) => {
  arrange();
  expect(await autoDeployOnce(deps())).toBe(result);
  expect(calls).toEqual(["hub GET"]);
});

it.each([
  ["still running", [{ name: "check", status: "in_progress", conclusion: null }], "ci_pending"],
  ["not reported yet", [], "ci_pending"],
  ["failing", [{ name: "check", status: "completed", conclusion: "failure" }], "ci_failed"],
  ["failing in another job", [...passing, { name: "images", status: "completed", conclusion: "cancelled" }], "ci_failed"],
] as const)("waits when CI is %s", async (_, checkRuns, result) => {
  runs = [...checkRuns];
  expect(await autoDeployOnce(deps())).toBe(result);
  expect(calls.some((call) => call.startsWith("hub POST"))).toBe(false);
});

it("does not retry a commit whose deploy already failed", async () => {
  status.last = { sha: target, requestedAt: "2026-01-01T00:00:00Z", outcome: "failed", result: "exit-code" };
  state.reported = `${target} 2026-01-01T00:00:00Z`;
  expect(await autoDeployOnce(deps())).toBe("failed_before");
  expect(calls).toEqual(["hub GET"]);
});

it("treats a refusal from the Hub, such as running tasks, as try again later", async () => {
  postStatus = 409;
  expect(await autoDeployOnce(deps())).toBe("refused");
  expect(logs.at(-1)).toContain("Finish running and waiting tasks");
});

it("fails loudly on an unexpected Hub response", async () => {
  postStatus = 500;
  await expect(autoDeployOnce(deps())).rejects.toThrow("HTTP 500");
});

it("reports each finished deploy to GitHub once, including sidebar deploys", async () => {
  status.pending = [];
  status.last = { sha: current, requestedAt: "2026-01-01T00:00:00Z", outcome: "succeeded" };
  await autoDeployOnce(deps());
  expect(calls).toEqual([
    "hub GET",
    `github POST deployments {"ref":"${current}","environment":"production","production_environment":true,"auto_merge":false,"required_contexts":[],"description":"Agent Hub deploy"}`,
    `github POST deployments/7/statuses {"state":"success","description":"Deployed"}`,
  ]);
  expect(state.reported).toBe(`${current} 2026-01-01T00:00:00Z`);
  calls = [];
  await autoDeployOnce(deps());
  expect(calls).toEqual(["hub GET"]);
});

it("reports a failed deploy as a failure and retries reporting after a GitHub error", async () => {
  status.pending = [];
  status.last = { sha: current, requestedAt: "2026-01-01T00:00:00Z", outcome: "failed", result: "exit-code" };
  githubFails = true;
  await autoDeployOnce(deps());
  expect(state.reported).toBe("");
  expect(logs.at(-1)).toContain("Could not report");
  githubFails = false;
  calls = [];
  await autoDeployOnce(deps());
  expect(calls.at(-1)).toBe(`github POST deployments/7/statuses {"state":"failure","description":"Failed (exit-code)"}`);
});

it("records the deploy it finds on its first pass as a baseline without reporting it", async () => {
  state = {};
  status.pending = [];
  status.last = { sha: current, requestedAt: "2026-01-01T00:00:00Z", outcome: "succeeded" };
  await autoDeployOnce(deps());
  expect(calls).toEqual(["hub GET"]);
  expect(state.reported).toBe(`${current} 2026-01-01T00:00:00Z`);
});

it("requires every named check to exist and pass", () => {
  expect(ciState(passing, ["check"])).toBe("success");
  expect(ciState(passing, ["check", "build"])).toBe("pending");
  expect(ciState([{ name: "check", status: "completed", conclusion: "neutral" }], ["check"])).toBe("success");
});

it("reads the repository from SSH and HTTPS remotes", () => {
  expect(githubRepo("git@github.com:owner/repo.git\n")).toBe("owner/repo");
  expect(githubRepo("https://github.com/owner/repo")).toBe("owner/repo");
  expect(() => githubRepo("git@example.invalid:owner/repo.git")).toThrow("not a GitHub repository");
});
