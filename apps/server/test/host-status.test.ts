import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeployStatus } from "@agent-hub/shared";
import { Deployer, type CommandRunner } from "../src/deploy/deployer";
import { HostStatus } from "../src/deploy/host-status";
import { PLANNER_SYSTEM } from "../src/core/prompts";

let dir: string;
const sha = "a".repeat(40);
const target = "b".repeat(40);
const production: DeployStatus = {
  enabled: true, current: { sha, subject: "Current commit" }, target: { sha: target, subject: "Target commit" },
  pending: Array.from({ length: 12 }, (_, i) => ({ sha: target, subject: `Pending ${i}` })), dirty: false,
  last: { sha: target, requestedAt: "2026-01-01T00:00:00Z", outcome: "running" }, history: null, deploying: true,
};
const defaultRun: CommandRunner = async (file, args) => {
  if (file === "systemctl") return "ActiveState=active\nSubState=running\nActiveEnterTimestamp=fixture-time";
  if (file === "journalctl") return "fixture log";
  const command = args.slice(2).join(" ");
  switch (command) {
    case "fetch origin": return "";
    case "rev-parse HEAD": return sha;
    case "log -1 --format=%s HEAD": return "Local commit";
    case "rev-parse --abbrev-ref HEAD": return "feature";
    case "symbolic-ref --short refs/remotes/origin/HEAD": return "origin/main";
    case "rev-list --left-right --count HEAD...origin/main":
    case "rev-list --left-right --count HEAD...origin/release": return "2\t7";
    case "status --porcelain": return " M private-name\n?? another-name";
    default: throw new Error(`Unexpected command: ${file} ${args.join(" ")}`);
  }
};
function fixture(run: CommandRunner = defaultRun, now?: () => number) {
  const deployer = new Deployer({ enabled: true, checkout: dir, dataDir: dir, run });
  const status = vi.spyOn(deployer, "status").mockResolvedValue(production);
  const runner = vi.fn(run);
  return { host: new HostStatus({ deployer, dataDir: dir, run: runner, now }), runner, status };
}
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "host-status-")); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

describe("host status", () => {
  it("reports independent production, history, service and repository sections using argument arrays", async () => {
    await fs.writeFile(path.join(dir, "deploy-history"), Array.from({ length: 8 }, (_, i) => `history-${i}`).join("\n") + "\n");
    const { host, runner } = fixture();
    const text = await host.status("/fixture/repo", "origin/release");
    for (const expected of ["Production:", "Deployment enabled", "Current: aaaaaaaa Current commit", "origin/main: bbbbbbbb Target commit", "Pending commits: 12", "Pending 9", "Checkout: clean", "Last button deploy: bbbbbbbb requested 2026-01-01T00:00:00Z, running", "Deploy running: yes", "Deploy history:", "history-3", "history-7", "Service:", "agent-hub-prod: active (running) since fixture-time", "Planning repository:", "HEAD: feature aaaaaaaa Local commit", "Compare ref: origin/release", "Ahead: 2, behind: 7", "dirty (2 entries)"]) expect(text).toContain(expected);
    for (const hidden of ["history-2", "Pending 10", "private-name", "another-name"]) expect(text).not.toContain(hidden);
    expect(runner.mock.calls).toEqual([
      ["systemctl", ["--user", "show", "agent-hub-prod.service", "-p", "ActiveState", "-p", "SubState", "-p", "ActiveEnterTimestamp"]],
      ...[["fetch", "origin"], ["rev-parse", "HEAD"], ["log", "-1", "--format=%s", "HEAD"], ["rev-parse", "--abbrev-ref", "HEAD"], ["rev-list", "--left-right", "--count", "HEAD...origin/release"], ["status", "--porcelain"]].map((args) => ["git", ["-C", "/fixture/repo", ...args]]),
    ]);
  });

  it("uses origin/HEAD without a base, handles clean state and disabled deployment", async () => {
    const { host, status, runner } = fixture(async (file, args) => args.at(-1) === "--porcelain" ? "" : defaultRun(file, args));
    status.mockResolvedValue({ ...production, enabled: false, disabledReason: "not_enabled", dirty: true, last: null, deploying: false, fetchError: "offline" });
    const text = await host.status("/fixture/repo", undefined);
    for (const expected of ["Deployment disabled: not_enabled", "Checkout: dirty", "Fetch error: offline", "Last button deploy: none recorded", "Deploy running: no", "none recorded", "Compare ref: origin/main", "Working tree: clean"]) expect(text).toContain(expected);
    expect(runner).toHaveBeenCalledWith("git", ["-C", "/fixture/repo", "symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
    expect(await host.status(undefined, undefined)).not.toContain("Planning repository:");
  });

  it.each(["production", "history", "service", "repository"])("isolates %s failures", async (failed) => {
    const { host, status } = fixture(async (file, args) => {
      if ((failed === "service" && file === "systemctl") || (failed === "repository" && file === "git")) throw new Error("fixture failure");
      return defaultRun(file, args);
    });
    if (failed === "production") status.mockRejectedValue(new Error("fixture failure"));
    if (failed === "history") await fs.mkdir(path.join(dir, "deploy-history"));
    const text = await host.status("/fixture/repo", undefined);
    expect(text).toContain(failed === "history" ? "Deploy history: unavailable:" : "fixture failure");
    if (failed !== "production") expect(text).toContain("Current: aaaaaaaa");
    if (failed !== "service") expect(text).toContain("agent-hub-prod: active");
    if (failed !== "repository") expect(text).toContain("Ahead: 2, behind: 7");
  });

  it("throttles concurrent and failed fetches per path for 60 seconds, preserving existing refs", async () => {
    let now = 0;
    const { host, runner } = fixture(async (file, args) => {
      if (args.includes("fetch")) throw new Error("offline");
      return defaultRun(file, args);
    }, () => now);
    const outputs = await Promise.all([host.status("/one", undefined), host.status("/one", undefined)]);
    for (const text of outputs) { expect(text).toContain("Fetch error: offline"); expect(text).toContain("Ahead: 2, behind: 7"); }
    now = 59_999;
    await host.status("/one", undefined);
    await host.status("/two", undefined);
    expect(runner.mock.calls.filter(([, args]) => args.includes("fetch"))).toHaveLength(2);
    now = 60_000;
    await host.status("/one", undefined);
    expect(runner.mock.calls.filter(([, args]) => args.includes("fetch"))).toHaveLength(3);
  });

  it("reports malformed ahead/behind output", async () => {
    const { host } = fixture(async (file, args) => args.includes("rev-list") ? "bad" : defaultRun(file, args));
    expect(await host.status("/fixture/repo", undefined)).toContain("Invalid ahead/behind counts");
  });
});

describe("service logs", () => {
  it.each([[undefined, 80], [900, 300], [0, 1], [12, 12]] as const)("defaults or clamps %s to %s lines", async (lines, expected) => {
    const { host, runner } = fixture(async () => Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n"));
    const text = await host.serviceLog({ unit: "prod", lines });
    expect(runner).toHaveBeenCalledExactlyOnceWith("journalctl", ["--user", "-u", "agent-hub-prod.service", "-n", String(expected), "--no-pager", "-o", "short-iso"]);
    expect(text.split("\n")).toHaveLength(expected);
    expect(text).toMatch(/line 399$/);
  });

  it("filters literal terms with case-insensitive OR and keeps the last matches", async () => {
    const { host, runner } = fixture(async () => "first [FAIL]\nignore F\nsecond a+b\nthird [fail]\nlast A+B\nignored ab");
    expect(await host.serviceLog({ unit: "prod", lines: 3, grep: ["[fail]", "a+b"] })).toBe("second a+b\nthird [fail]\nlast A+B");
    expect(runner).toHaveBeenCalledExactlyOnceWith("journalctl", ["--user", "-u", "agent-hub-prod.service", "-n", "2000", "--no-pager", "-o", "short-iso"]);
  });

  it("selects only a validated latest deploy request", async () => {
    const { host, runner } = fixture();
    for (const raw of [null, "{", "null", JSON.stringify({ sha: "../bad", requestedAt: "2026-01-01" }), JSON.stringify({ sha, requestedAt: "bad" })]) {
      if (raw !== null) await fs.writeFile(path.join(dir, "deploy-request.json"), raw);
      expect(await host.serviceLog({ unit: "deploy" })).toContain("No valid latest deploy request");
    }
    expect(runner).not.toHaveBeenCalled();
    await fs.writeFile(path.join(dir, "deploy-request.json"), JSON.stringify({ sha, requestedAt: "2026-01-01T00:00:00Z" }));
    expect(await host.serviceLog({ unit: "deploy" })).toBe("fixture log");
    expect(runner).toHaveBeenCalledExactlyOnceWith("journalctl", ["--user", "-u", `agent-hub-deploy@${sha}.service`, "-n", "80", "--no-pager", "-o", "short-iso"]);
  });

  it("redacts the token file and every supported secret pattern", async () => {
    const secrets = ["literal.$token", "bearer-value", "auth-value", ...["p", "o", "u", "s", "r"].map((c) => `gh${c}_${"a".repeat(20)}`), `github_pat_${"a_".repeat(20)}`, `sk-${"a_-".repeat(20)}`, "https://discord.com/api/webhooks/123/secret", "https://discordapp.com/api/webhooks/123/secret", "token-value", "secret-value", "password-value", "api-value", "key-value", "plainkey-value"];
    await fs.writeFile(path.join(dir, "token"), "literal.$token\n");
    const raw = [secrets[0], `Bearer ${secrets[1]}`, `Authorization: ${secrets[2]}`, ...secrets.slice(3, 12), `token=${secrets[12]}`, `secret=${secrets[13]}`, `password=${secrets[14]}`, `api_key=${secrets[15]}`, `api-key=${secrets[16]}`, `apikey=${secrets[17]}`].join("\n");
    const { host } = fixture(async () => raw);
    const text = await host.serviceLog({ unit: "prod" });
    for (const secret of secrets) expect(text).not.toContain(secret);
    expect(text.match(/\[redacted\]/g)).toHaveLength(secrets.length);
  });

  it.each(["\n", " \t\n"])("preserves log line breaks with a whitespace-only token %j", async (token) => {
    await fs.writeFile(path.join(dir, "token"), token);
    const log = "first line\nsecond line\nthird line";
    const { host } = fixture(async () => log);
    expect(await host.serviceLog({ unit: "prod" })).toBe(log);
  });

  it.each(['"', "'"])("redacts JSON-style secret fields with %s quotes", async (quote) => {
    const fields = ["token", "SECRET", "Password", "api_key", "API-KEY", "apikey"];
    const entries = fields.map((key, index) => {
      const separator = index % 2 ? " : " : ":";
      return `${quote}${key}${quote}${separator}${quote}private-${index}${quote}`;
    });
    const unchanged = `${quote}tokens_used${quote}: 5`;
    const { host } = fixture(async () => `{${[...entries, unchanged].join(", ")}}`);
    const expected = entries.map((entry, index) => entry.replace(`private-${index}`, "[redacted]"));
    expect(await host.serviceLog({ unit: "prod" })).toBe(`{${[...expected, unchanged].join(", ")}}`);
  });

  it("preserves quoted field formatting while redacting escaped quotes in values", async () => {
    const { host } = fixture(async () => String.raw`{"token":"escaped\"value", 'secret': 'escaped\'value'}`);
    expect(await host.serviceLog({ unit: "prod" })).toBe(`{"token":"[redacted]", 'secret': '[redacted]'}`);
  });

  it("redacts errors, fails closed on unreadable tokens and caps output after redaction", async () => {
    const { host } = fixture(async () => { throw new Error("Bearer private-value"); });
    expect(await host.serviceLog({ unit: "prod" })).toBe("Service log unavailable: Bearer [redacted]");
    await fs.mkdir(path.join(dir, "token"));
    expect(await host.serviceLog({ unit: "prod" })).toContain("token redaction could not be loaded");
    await fs.rm(path.join(dir, "token"), { recursive: true });
    const long = fixture(async () => "x".repeat(40_000));
    const text = await long.host.serviceLog({ unit: "prod" });
    expect(text).toHaveLength(32_000);
    expect(text).toMatch(/\n\[truncated\]$/);
  });
});

it("instructs planners to use host tools and finish with Hub options when blocked", () => {
  expect(PLANNER_SYSTEM).toContain("Never ask the user to run commands on the host");
  expect(PLANNER_SYSTEM).toContain("Use host_status, read_service_log");
  expect(PLANNER_SYSTEM).toContain("say exactly where you are blocked and end with ask");
  expect(PLANNER_SYSTEM).toContain("options the user can press in the Hub");
});
