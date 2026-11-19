import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it } from "vitest";

const exec = promisify(execFile);
const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
let root: string, prod: string, data: string, bin: string, log: string, oldSha: string, newSha: string;
let server: http.Server, port: number, db: Database.Database;
let tasks: unknown, httpStatus: number, requests: number, failAfterRestart: boolean, failNewVersion: boolean;

function executable(name: string, body: string) {
  fs.writeFileSync(path.join(bin, name), `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`, { mode: 0o755 });
}

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-hub-deploy-"));
  prod = path.join(root, "production checkout");
  data = path.join(root, "external data's directory");
  bin = path.join(root, "bin");
  log = path.join(root, "commands");
  fs.mkdirSync(bin);
  fs.mkdirSync(data);
  fs.writeFileSync(log, "");
  const upstream = path.join(root, "upstream");
  fs.mkdirSync(upstream);
  git(upstream, "init", "-q", "-b", "main");
  git(upstream, "config", "user.name", "Test");
  git(upstream, "config", "user.email", "test@example.invalid");
  fs.cpSync(path.join(source, "scripts"), path.join(upstream, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(upstream, ".gitignore"), "node_modules\n");
  fs.mkdirSync(path.join(upstream, "apps/server"), { recursive: true });
  fs.writeFileSync(path.join(upstream, "apps/server/package.json"), "{}");
  git(upstream, "add", ".");
  git(upstream, "commit", "-qm", "initial");
  oldSha = git(upstream, "rev-parse", "HEAD");
  git(root, "clone", "-q", upstream, prod);
  // Exercise fetching a new target and replacing the script currently executing.
  fs.rmSync(path.join(upstream, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(upstream, "new-version"), "updated\n");
  git(upstream, "add", "-A");
  git(upstream, "commit", "-qm", "next version");
  newSha = git(upstream, "rev-parse", "HEAD");
  fs.symlinkSync(path.join(source, "apps/server/node_modules"), path.join(prod, "apps/server/node_modules"));
  fs.writeFileSync(path.join(data, "token"), "deployment-test-token\n");
  db = new Database(path.join(data, "agent-hub.db"));
  db.pragma("journal_mode = WAL");
  db.exec("CREATE TABLE sample (value TEXT); INSERT INTO sample VALUES ('committed WAL data')");
  tasks = [{ status: "done" }];
  httpStatus = 200;
  requests = 0;
  failAfterRestart = false;
  failNewVersion = false;
  server = http.createServer((req, res) => {
    requests++;
    expect(req.url).toBe("/api/tasks");
    expect(req.headers.authorization).toBe("Bearer deployment-test-token");
    const restarted = fs.readFileSync(log, "utf8").includes("systemctl");
    const broken = (failAfterRestart && restarted) || (failNewVersion && fs.existsSync(path.join(prod, "new-version")));
    res.writeHead(broken ? 503 : httpStatus);
    res.end(JSON.stringify(tasks));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;
  executable("mise", `
[[ "$1" == exec && "$2" == -- ]]
shift 2
if [[ "$1" == pnpm ]]; then
  printf '%s\\n' "$*" >> "$TEST_COMMAND_LOG"
  if [[ "$2" == install && "\${TEST_INSTALL_FAIL:-0}" == 1 ]]; then exit 1; fi
  if [[ "$2" == --filter && "\${TEST_BUILD_FAIL:-0}" == 1 ]]; then exit 1; fi
else
  exec "$@"
fi`);
  executable("systemctl", `printf 'systemctl %s\\n' "$*" >> "$TEST_COMMAND_LOG"
exit "\${TEST_RESTART_FAIL:-0}"`);
  executable("journalctl", `printf 'journalctl %s\\n' "$*" >> "$TEST_COMMAND_LOG"
echo 'example service failure'`);
  // Advance only the readiness process's clock to exercise its full timeout without a minute's wait.
  fs.writeFileSync(path.join(root, "clock.cjs"), `
if (process.env.TEST_EXPIRE_WAIT === '1' && process.argv.at(-1) === 'wait') {
  let now = Date.now();
  Date.now = () => (now += 20_000);
}`);
});

afterEach(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

async function deploy(args: string[] = [], env: NodeJS.ProcessEnv = {}) {
  try {
    const result = await exec("bash", [path.join(prod, "scripts/deploy.sh"), ...args], {
      cwd: root,
      env: {
        ...process.env, PATH: `${bin}:${process.env.PATH}`, AGENT_HUB_PROD_DIR: prod,
        AGENT_HUB_DATA: data, AGENT_HUB_PORT: String(port), AGENT_HUB_HOST: "", TEST_COMMAND_LOG: log,
        NODE_OPTIONS: `--require=${path.join(root, "clock.cjs")}`, ...env,
      },
    });
    return { code: 0, output: result.stdout + result.stderr };
  } catch (error) {
    const result = error as { code: number; stdout: string; stderr: string };
    return { code: result.code, output: result.stdout + result.stderr };
  }
}

function unchanged() {
  expect(git(prod, "rev-parse", "HEAD")).toBe(oldSha);
  expect(fs.readFileSync(log, "utf8")).toBe("");
  expect(fs.existsSync(path.join(data, "backups"))).toBe(false);
  expect(fs.existsSync(path.join(data, "deploy-history"))).toBe(false);
}

it("fetches and deploys the default ref, backs up WAL data under the old SHA, prunes to ten, and restarts after building", async () => {
  const backups = path.join(data, "backups");
  fs.mkdirSync(backups);
  for (let day = 1; day <= 11; day++) {
    fs.writeFileSync(path.join(backups, `agent-hub-202001${String(day).padStart(2, "0")}T000000.000Z-abc1234.db`), "old");
  }
  fs.writeFileSync(path.join(backups, "keep.txt"), "unrelated");
  const result = await deploy();
  expect(result.code, result.output).toBe(0);
  expect(git(prod, "rev-parse", "HEAD")).toBe(newSha);
  expect(git(prod, "rev-parse", "--abbrev-ref", "HEAD")).toBe("HEAD");
  const files = fs.readdirSync(backups);
  expect(files.filter(file => file.endsWith(".db"))).toHaveLength(10);
  expect(files).toContain("keep.txt");
  expect(files.some(file => file.includes("20200101"))).toBe(false);
  const backup = files.find(file => file.endsWith(`-${oldSha.slice(0, 7)}.db`))!;
  const copy = new Database(path.join(backups, backup), { readonly: true });
  expect(copy.prepare("SELECT value FROM sample").pluck().get()).toBe("committed WAL data");
  expect(copy.pragma("integrity_check", { simple: true })).toBe("ok");
  copy.close();
  expect(fs.readFileSync(path.join(data, "deploy-history"), "utf8")).toMatch(new RegExp(`^\\S+ ${newSha}\\n$`));
  expect(fs.readFileSync(log, "utf8").trim().split("\n")).toEqual([
    "pnpm install --frozen-lockfile", "pnpm --filter @agent-hub/web build", "systemctl --user restart agent-hub-prod",
  ]);
  expect(requests).toBe(2);
});

it.each(["running", "waiting_user"])("refuses a %s task before modifying anything", async status => {
  tasks = [{ status }];
  const result = await deploy();
  expect(result.code).not.toBe(0);
  expect(result.output).toContain("running or waiting");
  unchanged();
});

it.each(["tracked", "untracked"])("refuses %s production changes even with --force", async kind => {
  fs.writeFileSync(path.join(prod, kind === "tracked" ? ".gitignore" : "new-file"), "dirty");
  const result = await deploy(["--force"]);
  expect(result.code).not.toBe(0);
  expect(result.output).toContain("uncommitted changes");
  expect(requests).toBe(0);
  unchanged();
});

it.each(["relative", "inside", "metadata", "symlink", "missing"])("rejects %s data paths", async kind => {
  const inside = path.join(prod, "data");
  fs.mkdirSync(inside);
  fs.symlinkSync(inside, path.join(root, "linked-data"));
  const values: Record<string, string> = {
    relative: "data", inside, metadata: path.join(prod, ".git"), symlink: path.join(root, "linked-data"), missing: "",
  };
  const value = values[kind];
  const result = await deploy([], { AGENT_HUB_DATA: value });
  expect(result.code).not.toBe(0);
  expect(result.output).toContain("AGENT_HUB_DATA");
  unchanged();
});

it.each(["unauthorized", "invalid", "offline"])("fails closed when the server is %s", async kind => {
  if (kind === "unauthorized") httpStatus = 401;
  if (kind === "invalid") tasks = { error: "not a task list" };
  if (kind === "offline") await new Promise<void>(resolve => server.close(() => resolve()));
  const result = await deploy();
  expect(result.code).not.toBe(0);
  unchanged();
});

it("checks the address the server binds, and loopback for a wildcard bind", async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.2", resolve));
  const bound = String((server.address() as { port: number }).port);
  const wildcard = await deploy([], { AGENT_HUB_PORT: bound, AGENT_HUB_HOST: "0.0.0.0" });
  expect(wildcard.code).not.toBe(0);
  unchanged();
  const result = await deploy([], { AGENT_HUB_PORT: bound, AGENT_HUB_HOST: "127.0.0.2" });
  expect(result.code, result.output).toBe(0);
  expect(git(prod, "rev-parse", "HEAD")).toBe(newSha);
});

it("allows --force to bypass the task check and accepts an explicit SHA", async () => {
  tasks = [{ status: "waiting_user" }];
  const result = await deploy([oldSha, "--force"]);
  expect(result.code, result.output).toBe(0);
  expect(git(prod, "rev-parse", "HEAD")).toBe(oldSha);
  expect(requests).toBe(1);
});

it("does not fetch or change revisions when the database backup fails", async () => {
  db.close();
  fs.rmSync(path.join(data, "agent-hub.db"));
  db = new Database(":memory:");
  expect((await deploy()).code).not.toBe(0);
  expect(git(prod, "rev-parse", "HEAD")).toBe(oldSha);
  expect(git(prod, "rev-parse", "origin/main")).toBe(oldSha);
  expect(fs.readFileSync(log, "utf8")).toBe("");
});

it.each(["TEST_INSTALL_FAIL", "TEST_BUILD_FAIL"])("does not record history or restart after %s", async flag => {
  expect((await deploy([], { [flag]: "1" })).code).not.toBe(0);
  expect(git(prod, "rev-parse", "HEAD")).toBe(newSha);
  expect(fs.existsSync(path.join(data, "deploy-history"))).toBe(false);
  expect(fs.readFileSync(log, "utf8")).not.toContain("systemctl");
});

it.each(["restart", "readiness"])("prints service logs, tries to roll back, and fails when %s fails", async kind => {
  failAfterRestart = kind === "readiness";
  const result = await deploy([], kind === "restart" ? { TEST_RESTART_FAIL: "1" } : { TEST_EXPIRE_WAIT: "1" });
  expect(result.code).not.toBe(0);
  expect(result.output).toContain("example service failure");
  if (kind === "readiness") expect(result.output).toContain("within 60 seconds");
  expect(result.output).toContain("manual recovery required");
  expect(fs.readFileSync(log, "utf8")).toContain("journalctl --user -u agent-hub-prod -n 50 --no-pager");
  expect(fs.readFileSync(path.join(data, "deploy-history"), "utf8")).toContain(newSha);
  expect(git(prod, "rev-parse", "HEAD")).toBe(oldSha);
});

it("rolls back to the running revision when the new one never becomes ready, keeping the database", async () => {
  failNewVersion = true;
  const result = await deploy([], { TEST_EXPIRE_WAIT: "1" });
  expect(result.code).not.toBe(0);
  expect(result.output).toContain(`rolled back to ${oldSha}`);
  expect(git(prod, "rev-parse", "HEAD")).toBe(oldSha);
  const history = fs.readFileSync(path.join(data, "deploy-history"), "utf8").trim().split("\n");
  expect(history.map(line => line.split(" ")[1])).toEqual([newSha, oldSha]);
  expect(fs.readdirSync(data).some(name => name.startsWith("failed-db-"))).toBe(false);
  expect(fs.readFileSync(log, "utf8").trim().split("\n").filter(line => !line.startsWith("journalctl"))).toEqual([
    "pnpm install --frozen-lockfile", "pnpm --filter @agent-hub/web build", "systemctl --user restart agent-hub-prod",
    "pnpm install --frozen-lockfile", "pnpm --filter @agent-hub/web build", "systemctl --user restart agent-hub-prod",
  ]);
});

it("restores the pre-deploy database when the failed revision added migrations", async () => {
  const upstream = path.join(root, "upstream");
  fs.mkdirSync(path.join(upstream, "apps/server/drizzle"), { recursive: true });
  fs.writeFileSync(path.join(upstream, "apps/server/drizzle/0001_new.sql"), "ALTER TABLE sample ADD extra TEXT;\n");
  git(upstream, "add", "-A");
  git(upstream, "commit", "-qm", "migration");
  failNewVersion = true;
  const result = await deploy([], { TEST_EXPIRE_WAIT: "1" });
  expect(result.code).not.toBe(0);
  expect(result.output).toContain("Restored database from");
  expect(git(prod, "rev-parse", "HEAD")).toBe(oldSha);
  const saved = fs.readdirSync(data).find(name => name.startsWith("failed-db-"))!;
  expect(fs.existsSync(path.join(data, saved, "agent-hub.db"))).toBe(true);
  const restored = new Database(path.join(data, "agent-hub.db"), { readonly: true });
  expect(restored.prepare("SELECT value FROM sample").pluck().get()).toBe("committed WAL data");
  restored.close();
  expect(fs.readFileSync(log, "utf8")).toContain("systemctl --user stop agent-hub-prod");
});

it("installs both services, preserves existing settings, and only enables development", async () => {
  const home = path.join(root, "home");
  const config = path.join(home, ".config/agent-hub");
  fs.mkdirSync(config, { recursive: true });
  fs.writeFileSync(path.join(config, "env"), "AGENT_HUB_DATA=/external/data\n");
  executable("loginctl", "echo yes");
  const result = await exec("bash", [path.join(source, "deploy/install.sh")], {
    env: { ...process.env, HOME: home, USER: "<user>", PATH: `${bin}:${process.env.PATH}`, TEST_COMMAND_LOG: log },
  });
  for (const unit of ["agent-hub.service", "agent-hub-prod.service", "agent-hub-auto-deploy.service", "agent-hub-auto-deploy.timer"]) {
    expect(fs.readFileSync(path.join(home, ".config/systemd/user", unit), "utf8"))
      .toBe(fs.readFileSync(path.join(source, "deploy", unit), "utf8"));
  }
  expect(fs.readFileSync(path.join(config, "env"), "utf8")).toBe("AGENT_HUB_DATA=/external/data\n");
  expect(fs.readFileSync(log, "utf8").trim().split("\n")).toEqual([
    "systemctl --user daemon-reload", "systemctl --user enable agent-hub.service",
  ]);
  expect(result.stdout).toContain("systemctl --user disable --now agent-hub.service");
  expect(result.stdout).toContain("systemctl --user enable --now agent-hub-prod.service");
});
