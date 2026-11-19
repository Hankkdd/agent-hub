import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { execute, preflight, diagnosticPreflight, DIAGNOSTIC_EXPERIMENT, observeWithFakeTransport, diagnose, EXPERIMENT, screen, type Execute, type Result } from "../scripts/antigravity-login-preflight";

const roots: string[] = [];
async function temporaryRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hub-preflight-synthetic-"));
  roots.push(root);
  return root;
}
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
async function fixtureObservation(run: Execute, signal?: AbortSignal, machine = host) {
  return observeWithFakeTransport(run, signal, machine, async () => {});
}
// All vendor screens and identities below are synthetic placeholders, never captured sessions.
const ok = (stdout = "", stderr = ""): Result => ({ code: "EXIT", stdout, stderr, exitCode: 0 });
const host = { architecture: "arm64", uid: 1000, gid: 1000 };
const imageEvidence = JSON.stringify({ evidence: "real-container-without-model", transport: "PASS", version: "1.3.6", architecture: "arm64" });
function fixture(startup = ok("Synthetic unsupported screen"), override?: (args: string[]) => Result | undefined) {
  const calls: Array<{ command: string; args: string[]; signal?: AbortSignal; timeoutMs?: number }> = [];
  const run: Execute = async (command, args, options) => {
    calls.push({ command, args, ...options });
    const special = override?.(args);
    if (special) return special;
    if (command !== "docker") return ok(imageEvidence);
    if (args[0] === "info") return ok("aarch64\n");
    if (args[0] === "start") return startup;
    return ok();
  };
  return { run, calls };
}
describe("synthetic login startup facts", () => {
  it("accepts only exact authorization endpoints and drops all query/state", () => {
    const raw = "\x1b[32mhttps://accounts.google.com/o/oauth2/v2/auth?state=SYNTHETIC&code=SYNTHETIC\x1b[0m\n";
    expect(screen(raw)).toMatchObject({ linkBoundary: true, authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth", unsafe: false });
    expect(JSON.stringify(screen(raw))).not.toContain("SYNTHETIC");
    for (const url of ["https://accounts.google.com.evil.invalid/o/oauth2/auth", "http://accounts.google.com/o/oauth2/auth",
      "https://placeholder@accounts.google.com/o/oauth2/auth", "https://accounts.google.com/unknown?state=SYNTHETIC",
      "https://accounts.google.com:444/o/oauth2/auth"]) expect(screen(`${url}\n`).unsafe).toBe(true);
  });
  it("does not classify an incomplete URL and recognizes fixed screens", () => {
    expect(screen("https://accounts.google.com/o/oauth2/v2/au").linkBoundary).toBe(false);
    expect(screen("Sign in with Google").googleSelection).toBe(true);
    expect(screen("Enter authorization code:").inputBoundary).toBe(true);
    expect(screen("refresh_token=SYNTHETIC").unsafe).toBe(true);
  });
  it("describes two finite observations using fake transports only, with owned non-root tmpfs and no input path", async () => {
    const fake = fixture(ok("Sign in with Google\n"));
    const result = await fixtureObservation(fake.run, undefined, host);
    expect(result.status).toBe("INCONCLUSIVE");
    expect(result.observations).toHaveLength(2);
    expect(fake.calls.filter(c => c.args[0] === "start").every(c => c.timeoutMs === 30_000)).toBe(true);
    const containers = fake.calls.filter(c => c.args[0] === "create");
    expect(containers).toHaveLength(2);
    expect(containers[0]!.args).not.toContain("--tty");
    expect(containers[1]!.args).toContain("--tty");
    for (const call of containers) {
      expect(call.args).toContain("1000:1000");
      expect(call.args).toContain("--network=bridge");
      expect(call.args).toContain("--log-driver=none");
      expect(call.args).toContain(`io.agent-hub.antigravity-login-preflight.owner=${call.args[2]}`);
      expect(call.args).not.toContain("--mount");
      expect(call.args).not.toContain("--privileged");
      expect(call.args.at(-1)).toMatch(/^agent-hub-antigravity-prototype:1\.3\.6-/);
    }
    expect(fake.calls.filter(c => c.args[0] === "rm")).toHaveLength(2);
    expect(fake.calls.some(c => c.args.includes("image-check"))).toBe(true);
    expect(result.inputSubmitted).toBe(false);
    expect(result.unresolved).toContain("post-consent-completion");
    expect(fake.calls.filter(c => c.command === "docker").every(c => ["info", "ps", "create", "start", "rm"].includes(c.args[0]!))).toBe(true);
  });
  it("reports observed boundary without claiming login and never prints synthetic secrets", async () => {
    const fake = fixture(ok("https://accounts.google.com/o/oauth2/auth?state=SYNTHETIC\nEnter authorization code:"));
    const result = await fixtureObservation(fake.run, undefined, host);
    expect(result.status).toBe("PASS");
    expect(result.code).toBe("STARTUP_BOUNDARY_OBSERVED_NO_LOGIN");
    expect(JSON.stringify(result)).not.toContain("SYNTHETIC");
  });
  it.each(["PROCESS_UNAVAILABLE", "PROCESS_FAILED", "TIMEOUT", "CANCELLED"] as const)("reports Docker blocker %s", async code => {
    const fake = fixture(ok(), args => args[0] === "info" ? { ...ok(), code } : undefined);
    expect((await fixtureObservation(fake.run, undefined, host)).status).toBe("BLOCKED");
    expect(fake.calls).toHaveLength(1);
  });
  it("distinguishes permission, architecture, root and failed image check", async () => {
    const denied = fixture(ok(), args => args[0] === "info" ? { ...ok("", "permission denied SYNTHETIC"), code: "PROCESS_FAILED" } : undefined);
    expect((await fixtureObservation(denied.run, undefined, host)).code).toBe("DOCKER_PERMISSION_DENIED");
    expect((await fixtureObservation(fixture().run, undefined, { ...host, architecture: "x64" })).code).toBe("ARM64_REQUIRED");
    expect((await fixtureObservation(fixture().run, undefined, { ...host, uid: 0 })).code).toBe("NON_ROOT_REQUIRED");
    const failed = fixture(ok(), args => args.includes("image-check") ? { ...ok("SYNTHETIC"), code: "PROCESS_FAILED" } : undefined);
    expect((await fixtureObservation(failed.run, undefined, host)).code).toBe("IMAGE_CHECK_FAILED");
  });
  it.each(["CANCELLED", "OUTPUT_LIMIT", "UNSAFE_OUTPUT"] as const)("stops without retry and cleans on %s", async code => {
    const fake = fixture({ ...ok(), code });
    const result = await fixtureObservation(fake.run, undefined, host);
    expect(result.status).toBe("BLOCKED");
    expect(fake.calls.filter(c => c.args[0] === "start")).toHaveLength(1);
    const cleanup = fake.calls.find(c => c.args[0] === "rm");
    expect(cleanup?.signal).toBeUndefined();
    expect(cleanup?.timeoutMs).toBeLessThanOrEqual(10_000);
  });
  it("surfaces cleanup failure, including cancelled create", async () => {
    const fake = fixture(ok(), args => ["create", "rm"].includes(args[0]!) ? { ...ok("SYNTHETIC"), code: "TIMEOUT" } : undefined);
    expect((await fixtureObservation(fake.run, undefined, host)).code).toBe("CLEANUP_FAILED");
  });
  it("removes image-check temporary state and verifies ownership after ambiguous create", async () => {
    let temp: string | undefined;
    const fake = fixture();
    const run: Execute = async (command, args, options) => {
      if (options?.imageCheckTemp) {
        temp = options.imageCheckTemp;
        expect((await fs.stat(temp)).isDirectory()).toBe(true);
      }
      return fake.run(command, args, options);
    };
    await fixtureObservation(run, undefined, host);
    expect(temp).toBeDefined();
    await expect(fs.stat(temp!)).rejects.toMatchObject({ code: "ENOENT" });
    const ambiguous = fixture(ok(), args => {
      if (args[0] === "create") return { ...ok(), code: "CANCELLED" };
      if (args[0] === "inspect") return ok("foreign-synthetic-owner");
      return undefined;
    });
    expect((await fixtureObservation(ambiguous.run, undefined, host)).code).toBe("CLEANUP_FAILED");
    expect(ambiguous.calls.some(c => c.args[0] === "rm")).toBe(false);
  });
  it("treats timeout or unsupported output as inconclusive, unsafe output as blocked", async () => {
    expect((await fixtureObservation(fixture({ ...ok(), code: "TIMEOUT" }).run, undefined, host)).status).toBe("INCONCLUSIVE");
    expect((await fixtureObservation(fixture(ok("https://unexpected.invalid/?secret=SYNTHETIC\n")).run, undefined, host)).code).toBe("UNSAFE_OUTPUT");
    const unavailable = fixture({ ...ok("", "Error response from daemon: SYNTHETIC"), code: "PROCESS_FAILED" });
    expect((await fixtureObservation(unavailable.run, undefined, host)).code).toBe("DOCKER_START_FAILED");
  });
});

describe("synthetic diagnostic metadata", () => {
  it("distinguishes silence, control-only output, visible unknown text and a recognized boundary", () => {
    expect(diagnose(ok(), false)).toMatchObject({ output: "EMPTY", capturedBytes: 0, visibleCharacters: 0, exitCode: 0 });
    expect(diagnose(ok("\x1b[2J\x1b[H\r\n\t\x00"), false)).toMatchObject({ output: "CONTROL_ONLY", visibleCharacters: 0 });
    expect(diagnose(ok("Synthetic screen"), false)).toMatchObject({ output: "UNRECOGNIZED_VISIBLE", capturedBytes: 16, visibleCharacters: 15 });
    expect(diagnose(ok("Sign in with Google"), true)).toMatchObject({ output: "RECOGNIZED_BOUNDARY", streamLayout: "TTY_MERGED_WITH_CLIENT_STDERR" });
  });
  it("keeps actual nullable client exit codes separate from fixed termination codes", async () => {
    const silent = await fixtureObservation(fixture(ok()).run);
    const timeout = await fixtureObservation(fixture({ ...ok(), code: "TIMEOUT", exitCode: null }).run);
    expect(silent.observations[0]).toMatchObject({ code: "EXIT", diagnostics: { output: "EMPTY", exitCode: 0 } });
    expect(timeout.observations[0]).toMatchObject({ code: "TIMEOUT", diagnostics: { output: "EMPTY", exitCode: null } });
    expect(diagnose({ ...ok(), code: "PROCESS_FAILED", exitCode: 7 }, false).exitCode).toBe(7);
  });
  it.each([
    ["Error response from daemon: SYNTHETIC", "DOCKER_DAEMON_DIAGNOSTIC"],
    ["Permission denied: /synthetic/private", "PERMISSION_DIAGNOSTIC"],
    ["cannot execute SYNTHETIC", "EXECUTION_DIAGNOSTIC"],
    ["Read-only file system SYNTHETIC", "READ_ONLY_FILESYSTEM_DIAGNOSTIC"],
    ["No space left on device SYNTHETIC", "NO_SPACE_DIAGNOSTIC"],
    ["input device is not a TTY SYNTHETIC", "TTY_DIAGNOSTIC"],
  ])("classifies only a fixed category for %s", (text, category) => {
    const metadata = diagnose({ ...ok("", text), code: "PROCESS_FAILED", exitCode: 1 }, false);
    expect(metadata.errorCategory).toBe(category);
    expect(JSON.stringify(metadata)).not.toContain("SYNTHETIC");
    expect(JSON.stringify(metadata)).not.toContain("/synthetic/private");
  });
  it("excludes identities, URLs, query/state, tokens and raw text from all retained summaries", async () => {
    const raw = "SYNTHETIC@example.invalid https://accounts.google.com/o/oauth2/auth?state=SYNTHETIC#SYNTHETIC\nrefresh_token=SYNTHETIC";
    const result = await fixtureObservation(fixture(ok(raw)).run);
    expect(result.code).toBe("UNSAFE_OUTPUT");
    const retained = JSON.stringify(result);
    expect(retained).not.toContain("SYNTHETIC");
    expect(retained).not.toContain("state=");
    expect(retained).not.toContain("refresh_token");
    expect(retained).not.toContain("example.invalid");
    expect(result.observations[0]?.diagnostics?.output).toBe("UNSAFE");
  });
});

describe("reuse-only existing experiment checkpoint", () => {
  const journal = (root: string) => path.join(root, "antigravity-login-preflight", EXPERIMENT, "checkpoint.json");
  async function stored(root: string, historical = true) {
    let starts = 0;
    const fake = fixture(ok(), args => args[0] === "start" && ++starts === 2 ? { ...ok(), code: "TIMEOUT", exitCode: null } : undefined);
    const result = await fixtureObservation(fake.run);
    if (historical) for (const item of result.observations) delete item.diagnostics;
    await fs.mkdir(path.dirname(journal(root)), { recursive: true, mode: 0o700 });
    await fs.writeFile(journal(root), JSON.stringify({ experiment: EXPERIMENT,
      reservedAttempts: { "non-tty": 1, "docker-tty": 1 }, result }), { mode: 0o600 });
    return result;
  }
  it("reuses historical results without inventing diagnostics, writing or clearing reservations", async () => {
    const root = await temporaryRoot();
    const result = await stored(root);
    const before = await fs.readFile(journal(root), "utf8");
    await fs.mkdir(path.join(path.dirname(journal(root)), "lock"), { mode: 0o700 });
    const writing = vi.spyOn(fs, "writeFile").mockRejectedValue(new Error("Synthetic writes prohibited"));
    const creating = vi.spyOn(fs, "mkdir").mockRejectedValue(new Error("Synthetic creation prohibited"));
    const reused = await preflight(root);
    expect(reused).toMatchObject({ evidence: "reused-online-experiment", execution: "reused", reuseOnly: true,
      status: result.status, reservedAttempts: { "non-tty": 1, "docker-tty": 1 } });
    expect(reused.observations[0]).toMatchObject({ code: "EXIT", diagnostics: {
      availability: "UNAVAILABLE_HISTORICAL", output: "UNAVAILABLE", capturedBytes: null,
      visibleCharacters: null, exitCode: null, streamLayout: "UNAVAILABLE", errorCategory: "UNAVAILABLE" } });
    expect(reused.observations[1]).toMatchObject({ code: "TIMEOUT", diagnostics: { exitCode: null, output: "UNAVAILABLE" } });
    expect(await fs.readFile(journal(root), "utf8")).toBe(before);
    expect((await fs.stat(path.join(path.dirname(journal(root)), "lock"))).isDirectory()).toBe(true);
    expect(writing).not.toHaveBeenCalled();
    expect(creating).not.toHaveBeenCalled();
    expect((await preflight(root)).execution).toBe("reused");
  });
  it("accepts new safe fixture diagnostics without changing the stored file", async () => {
    const root = await temporaryRoot();
    const original = await stored(root, false);
    expect((await preflight(root)).observations).toEqual(original.observations);
  });
  it("blocks missing and incomplete state without creating or resuming anything", async () => {
    const root = await temporaryRoot();
    expect((await preflight(root)).code).toBe("CHECKPOINT_MISSING_REUSE_ONLY");
    expect(await fs.readdir(root)).toEqual([]);
    await fs.mkdir(path.dirname(journal(root)), { recursive: true, mode: 0o700 });
    expect((await preflight(root)).code).toBe("CHECKPOINT_MISSING_REUSE_ONLY");
    await fs.writeFile(journal(root), JSON.stringify({ experiment: EXPERIMENT,
      reservedAttempts: { "non-tty": 1, "docker-tty": 1 } }), { mode: 0o600 });
    const before = await fs.readFile(journal(root), "utf8");
    expect((await preflight(root)).code).toBe("EXPERIMENT_INCOMPLETE_NO_RETRY");
    expect(await fs.readFile(journal(root), "utf8")).toBe(before);
  });
  it("reports inaccessible roots and rejects relative/unignored roots without a fallback", async () => {
    expect((await preflight("relative-data")).code).toBe("ABSOLUTE_CHECKPOINT_ROOT_REQUIRED");
    const unsafeRoot = fileURLToPath(new URL("../../../synthetic-untracked-checkpoint", import.meta.url));
    expect((await preflight(unsafeRoot)).code).toBe("CHECKPOINT_ROOT_NOT_DURABLE_IGNORED_DATA");
    vi.spyOn(fs, "lstat").mockRejectedValue(Object.assign(new Error("SYNTHETIC"), { code: "EACCES" }));
    expect((await preflight(await temporaryRoot())).code).toBe("CHECKPOINT_INACCESSIBLE_REUSE_ONLY");
  });
  it.each(["corrupt", "extra-field", "public", "symlink", "unsafe-diagnostic", "unsafe-link", "trace-field", "invented-historical"])("rejects %s state without disclosing its contents", async kind => {
    const root = await temporaryRoot();
    await stored(root, false);
    const file = journal(root);
    const value = JSON.parse(await fs.readFile(file, "utf8"));
    if (kind === "corrupt") await fs.writeFile(file, "SYNTHETIC");
    if (kind === "extra-field") { value.raw = "SYNTHETIC"; await fs.writeFile(file, JSON.stringify(value)); }
    if (kind === "public") await fs.chmod(file, 0o644);
    if (kind === "symlink") { await fs.unlink(file); await fs.symlink(path.join(root, "synthetic-missing"), file); }
    if (kind === "unsafe-diagnostic") { value.result.observations[0].diagnostics.errorCategory = "SYNTHETIC"; await fs.writeFile(file, JSON.stringify(value)); }
    if (kind === "unsafe-link") { value.result.observations[0].authorizationEndpoint = "https://accounts.google.com/o/oauth2/auth?state=SYNTHETIC"; await fs.writeFile(file, JSON.stringify(value)); }
    if (kind === "trace-field") { value.result.observations[0].diagnostics.raw = "SYNTHETIC"; await fs.writeFile(file, JSON.stringify(value)); }
    if (kind === "invented-historical") { value.result.observations[0].diagnostics.availability = "UNAVAILABLE_HISTORICAL"; await fs.writeFile(file, JSON.stringify(value)); }
    const result = await preflight(root);
    expect(result.code).toBe("CHECKPOINT_INVALID_OR_UNSAFE_REUSE_ONLY");
    expect(JSON.stringify(result)).not.toContain("SYNTHETIC");
  });
  it.each(["missing", "incomplete", "invalid", "complete", "extra-argument"])("the saved-command entry invokes no fake Docker for %s state", async kind => {
    const root = await temporaryRoot();
    const fakeBin = path.join(root, "bin");
    const marker = path.join(root, "unexpected-process");
    await fs.mkdir(fakeBin);
    await fs.writeFile(path.join(fakeBin, "docker"), `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'synthetic'); process.exit(99);`, { mode: 0o700 });
    if (["incomplete", "invalid", "complete"].includes(kind)) {
      await stored(root);
      if (kind === "incomplete") {
        const value = JSON.parse(await fs.readFile(journal(root), "utf8"));
        delete value.result;
        await fs.writeFile(journal(root), JSON.stringify(value));
      }
      if (kind === "invalid") await fs.writeFile(journal(root), "SYNTHETIC");
    }
    if (kind === "complete") await diagnosticPreflight(fixture(ok()).run, undefined, host, root);
    const entry = fileURLToPath(new URL("../scripts/antigravity-login-preflight.ts", import.meta.url));
    const args = ["--import", fileURLToPath(import.meta.resolve("tsx")), entry];
    if (kind === "extra-argument") args.push("--observe");
    const result = await promisify(execFile)(process.execPath, args, {
      env: { PATH: fakeBin, HOME: root, AGENT_HUB_ANTIGRAVITY_PREFLIGHT_DATA: root }, timeout: 5000,
    }).catch(error => error as { code: number; stdout: string; stderr: string });
    const expected = { missing: "OLD_CHECKPOINT_MISSING", incomplete: "OLD_CHECKPOINT_INCOMPLETE",
      invalid: "OLD_CHECKPOINT_INVALID", complete: "TTY_DIAGNOSTIC_STARTUP_UNVERIFIED", "extra-argument": "NO_ARGUMENTS_ALLOWED" };
    expect(JSON.parse(result.stdout)).toMatchObject({ status: kind === "complete" ? "INCONCLUSIVE" : "BLOCKED", code: expected[kind as keyof typeof expected], entryMode: "ONE_USE_TTY_DIAGNOSTIC" });
    await expect(fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await fs.readdir(root)).sort()).toEqual(["incomplete", "invalid", "complete"].includes(kind) ? ["antigravity-login-preflight", "bin"] : ["bin"]);
  });
});

describe("single authorized diagnostic experiment with synthetic transports", () => {
  const oldFile = (root: string) => path.join(root, "antigravity-login-preflight", EXPERIMENT, "checkpoint.json");
  const newDirectory = (root: string) => path.join(root, "antigravity-login-preflight", DIAGNOSTIC_EXPERIMENT);
  const newFile = (root: string) => path.join(newDirectory(root), "checkpoint.json");
  async function seeded() {
    const root = await temporaryRoot();
    const previous = fixture(ok());
    const result = await fixtureObservation(previous.run);
    for (const item of result.observations) delete item.diagnostics;
    await fs.mkdir(path.dirname(oldFile(root)), { recursive: true, mode: 0o700 });
    await fs.mkdir(path.join(path.dirname(oldFile(root)), "lock"), { mode: 0o700 });
    await fs.writeFile(oldFile(root), JSON.stringify({ experiment: EXPERIMENT,
      reservedAttempts: { "non-tty": 1, "docker-tty": 1 }, result }), { mode: 0o600 });
    return { root, previous, before: await fs.readFile(oldFile(root), "utf8") };
  }
  it("reserves before any process, dispatches exactly one unchanged TTY, and reuses without Docker", async () => {
    const { root, previous, before } = await seeded();
    const fake = fixture({ ...ok("\x1b[2J\x1b[H"), code: "TIMEOUT", exitCode: null });
    const run: Execute = async (command, args, options) => {
      const reservation = JSON.parse(await fs.readFile(newFile(root), "utf8"));
      expect(reservation).toEqual({ experiment: DIAGNOSTIC_EXPERIMENT, reservedAttempts: { "docker-tty": 1 } });
      return fake.run(command, args, options);
    };
    const result = await diagnosticPreflight(run, undefined, host, root);
    expect(result).toMatchObject({ experiment: DIAGNOSTIC_EXPERIMENT, status: "INCONCLUSIVE", execution: "fresh",
      code: "TTY_DIAGNOSTIC_STARTUP_UNVERIFIED", reservedAttempts: { "non-tty": 0, "docker-tty": 1 } });
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]).toMatchObject({ mode: "docker-tty", code: "TIMEOUT", diagnostics: {
      output: "CONTROL_ONLY", capturedBytes: 7, visibleCharacters: 0, exitCode: null, streamLayout: "TTY_MERGED_WITH_CLIENT_STDERR" } });
    const creations = fake.calls.filter(c => c.args[0] === "create");
    expect(creations).toHaveLength(1);
    const normalize = (args: string[]) => args.map(arg => arg.startsWith("hub-agy-login-preflight-") ? "synthetic-owned" :
      arg.startsWith("io.agent-hub.antigravity-login-preflight.owner=") ? "synthetic-owner-label" : arg);
    expect(normalize(creations[0]!.args)).toEqual(normalize(previous.calls.filter(c => c.args[0] === "create")[1]!.args));
    expect(fake.calls.filter(c => c.args[0] === "start")).toEqual([expect.objectContaining({ args: ["start", "--attach", creations[0]!.args[2]], timeoutMs: 30_000, observe: true })]);
    const count = fake.calls.length;
    const reused = await diagnosticPreflight(fake.run, undefined, host, root);
    expect(reused).toMatchObject({ evidence: "reused-tty-diagnostic-experiment", execution: "reused", observations: result.observations });
    expect(fake.calls).toHaveLength(count);
    expect(await fs.readFile(oldFile(root), "utf8")).toBe(before);
    expect((await fs.stat(path.join(path.dirname(oldFile(root)), "lock"))).isDirectory()).toBe(true);
    expect((await fs.stat(newFile(root))).mode & 0o777).toBe(0o600);
  });
  it("serializes concurrent dispatch with a durable exclusive claim", async () => {
    const { root } = await seeded();
    const fake = fixture(ok());
    let ready!: () => void;
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { ready = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const run: Execute = async (command, args, options) => {
      if (args[0] === "info") { ready(); await gate; }
      return fake.run(command, args, options);
    };
    const first = diagnosticPreflight(run, undefined, host, root);
    await waiting;
    expect((await diagnosticPreflight(fake.run, undefined, host, root)).code).toBe("DIAGNOSTIC_INCOMPLETE_NO_RETRY");
    release();
    await first;
    expect(fake.calls.filter(c => c.args[0] === "start")).toHaveLength(1);
  });
  it.each(["missing", "incomplete", "corrupt", "inaccessible"])("blocks %s old evidence without new state or processes", async kind => {
    const { root, before } = await seeded();
    if (kind === "missing") await fs.unlink(oldFile(root));
    if (kind === "incomplete") { const value = JSON.parse(before); delete value.result; await fs.writeFile(oldFile(root), JSON.stringify(value)); }
    if (kind === "corrupt") await fs.writeFile(oldFile(root), "SYNTHETIC");
    if (kind === "inaccessible") {
      const original = fs.open.bind(fs);
      vi.spyOn(fs, "open").mockImplementation((...args: Parameters<typeof fs.open>) => args[0] === oldFile(root) ?
        Promise.reject(Object.assign(new Error("SYNTHETIC"), { code: "EACCES" })) : original(...args));
    }
    const fake = fixture();
    const result = await diagnosticPreflight(fake.run, undefined, host, root);
    expect(result.code).toBe({ missing: "OLD_CHECKPOINT_MISSING", incomplete: "OLD_CHECKPOINT_INCOMPLETE", corrupt: "OLD_CHECKPOINT_INVALID", inaccessible: "OLD_CHECKPOINT_INACCESSIBLE" }[kind]);
    expect(fake.calls).toHaveLength(0);
    await expect(fs.stat(newDirectory(root))).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.stringify(result)).not.toContain("SYNTHETIC");
  });
  it.each(["empty", "reserved", "corrupt", "inaccessible"])("never repairs or retries %s new state", async kind => {
    const { root } = await seeded();
    await fs.mkdir(newDirectory(root), { mode: 0o700 });
    if (kind !== "empty") await fs.writeFile(newFile(root), kind === "corrupt" ? "SYNTHETIC" : JSON.stringify({ experiment: DIAGNOSTIC_EXPERIMENT, reservedAttempts: { "docker-tty": 1 } }), { mode: 0o600 });
    if (kind === "inaccessible") {
      const original = fs.open.bind(fs);
      vi.spyOn(fs, "open").mockImplementation((...args: Parameters<typeof fs.open>) => args[0] === newFile(root) ?
        Promise.reject(Object.assign(new Error("SYNTHETIC"), { code: "EACCES" })) : original(...args));
    }
    const fake = fixture();
    const result = await diagnosticPreflight(fake.run, undefined, host, root);
    expect(result.status).toBe("BLOCKED");
    expect(result.code).toBe(kind === "inaccessible" ? "DIAGNOSTIC_CHECKPOINT_INACCESSIBLE_NO_RETRY" :
      kind === "corrupt" ? "DIAGNOSTIC_STATE_INVALID_OR_UNAVAILABLE_NO_RETRY" : "DIAGNOSTIC_INCOMPLETE_NO_RETRY");
    expect(fake.calls).toHaveLength(0);
  });
  it.each(["TIMEOUT", "CANCELLED", "OUTPUT_LIMIT", "UNSAFE_OUTPUT", "BOUNDARY"] as const)("records %s safely, cleans independently and never repeats", async code => {
    const { root, before } = await seeded();
    const controller = new AbortController();
    const raw = code === "BOUNDARY" ? "https://accounts.google.com/o/oauth2/auth?state=SYNTHETIC\n" :
      code === "UNSAFE_OUTPUT" ? "refresh_token=SYNTHETIC" : "";
    const fake = fixture({ ...ok(raw), code, exitCode: null }, args => {
      if (args[0] === "start" && code === "CANCELLED") controller.abort();
      return undefined;
    });
    const result = await diagnosticPreflight(fake.run, controller.signal, host, root);
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]?.code).toBe(code);
    expect(result.cleanup).toBe("PASS");
    const cleanups = fake.calls.filter(c => c.args[0] === "rm");
    expect(cleanups).toHaveLength(1);
    expect(cleanups[0]!.signal).toBeUndefined();
    expect(cleanups[0]!.timeoutMs).toBeLessThanOrEqual(10_000);
    expect(await fs.readFile(newFile(root), "utf8")).not.toContain("SYNTHETIC");
    expect(await fs.readFile(newFile(root), "utf8")).not.toContain("state=");
    expect(JSON.stringify(result)).not.toContain("SYNTHETIC");
    const count = fake.calls.length;
    expect((await diagnosticPreflight(fake.run, undefined, host, root)).execution).toBe("reused");
    expect(fake.calls).toHaveLength(count);
    expect(await fs.readFile(oldFile(root), "utf8")).toBe(before);
  });
  it("consumes failed prerequisites, create and cleanup without redispatch", async () => {
    for (const stage of ["info", "create", "rm"]) {
      const { root } = await seeded();
      const fake = fixture(ok(), args => args[0] === stage ? { ...ok(), code: "PROCESS_UNAVAILABLE" } : undefined);
      const result = await diagnosticPreflight(fake.run, undefined, host, root);
      expect(result.status).toBe("BLOCKED");
      if (stage === "rm") expect(result.cleanup).toBe("FAILED");
      const count = fake.calls.length;
      const reused = await diagnosticPreflight(fake.run, undefined, host, root);
      expect(reused.execution).toBe("reused");
      expect(reused.status).toBe("BLOCKED");
      expect(fake.calls).toHaveLength(count);
    }
  });
  it("a failed reservation write leaves a consumed directory claim without any process", async () => {
    const { root, before } = await seeded();
    const fake = fixture();
    const original = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation((...args: Parameters<typeof fs.open>) => args[0] === newFile(root) ?
      Promise.reject(Object.assign(new Error("SYNTHETIC"), { code: "EIO" })) : original(...args));
    expect((await diagnosticPreflight(fake.run, undefined, host, root)).code).toBe("DIAGNOSTIC_STATE_INVALID_OR_UNAVAILABLE_NO_RETRY");
    vi.restoreAllMocks();
    expect((await diagnosticPreflight(fake.run, undefined, host, root)).code).toBe("DIAGNOSTIC_INCOMPLETE_NO_RETRY");
    expect(fake.calls).toHaveLength(0);
    expect(await fs.readFile(oldFile(root), "utf8")).toBe(before);
  });
  it("a result-write failure leaves a spent reservation, not a renewable attempt", async () => {
    const { root } = await seeded();
    const fake = fixture(ok());
    vi.spyOn(fs, "rename").mockRejectedValue(new Error("SYNTHETIC"));
    expect((await diagnosticPreflight(fake.run, undefined, host, root)).code).toBe("DIAGNOSTIC_RESULT_WRITE_FAILED_NO_RETRY");
    vi.restoreAllMocks();
    const count = fake.calls.length;
    expect((await diagnosticPreflight(fake.run, undefined, host, root)).code).toBe("DIAGNOSTIC_INCOMPLETE_NO_RETRY");
    expect(fake.calls).toHaveLength(count);
    expect(fake.calls.filter(c => c.args[0] === "start")).toHaveLength(1);
  });
});

describe("model-free fake child processes", () => {
  it("collects split ANSI output until a complete URL boundary", async () => {
    const code = `process.stdout.write('\\x1b[32mhttps://accounts.google.com/o/oauth2/v2/au'); setTimeout(() => process.stdout.write('th?state=SYNTHETIC\\x1b[0m\\n'), 20); setInterval(() => {}, 1000);`;
    const result = await execute(process.execPath, ["-e", code], { observe: true, timeoutMs: 2000 });
    expect(result.code).toBe("BOUNDARY");
    expect(screen(result.stdout, true).authorizationEndpoint).toBe("https://accounts.google.com/o/oauth2/v2/auth");
  });
  it("enforces timeout, cancellation, output limit and missing executable", async () => {
    expect((await execute(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { timeoutMs: 30 })).code).toBe("TIMEOUT");
    const controller = new AbortController();
    const pending = execute(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { signal: controller.signal });
    controller.abort();
    expect((await pending).code).toBe("CANCELLED");
    expect((await execute(process.execPath, ["-e", "process.stdout.write('x'.repeat(65537))"])).code).toBe("OUTPUT_LIMIT");
    expect((await execute("/nonexistent-synthetic-preflight-command", [])).code).toBe("PROCESS_UNAVAILABLE");
  });
  it("allows the image-check process to finalize after cancellation", async () => {
    const result = await execute(process.execPath, ["-e", "process.on('SIGTERM', () => { console.log('synthetic-cleaned'); process.exit(0); }); setInterval(() => {}, 1000);"],
      { timeoutMs: 500, imageCheckTemp: "/tmp" });
    expect(result.code).toBe("TIMEOUT");
    expect(result.stdout).toContain("synthetic-cleaned");
  });
  it("classifies split ANSI-only and stderr output without persisting terminal text", async () => {
    const result = await execute(process.execPath, ["-e", "process.stdout.write('\\x1b['); setTimeout(() => process.stdout.write('2J\\x1b[H'), 20);"], { timeoutMs: 2000 });
    expect(diagnose(result, true)).toMatchObject({ output: "CONTROL_ONLY", visibleCharacters: 0, exitCode: 0 });
    const stderr = await execute(process.execPath, ["-e", "process.stderr.write('Synthetic screen');"], { timeoutMs: 2000 });
    expect(diagnose(stderr, false)).toMatchObject({ output: "UNRECOGNIZED_VISIBLE", streamLayout: "SEPARATE" });
  });
  it("cannot write a code or prompt into stdin", async () => {
    const result = await execute(process.execPath, ["-e", "process.stdin.on('data', () => process.exit(9)); process.stdin.on('end', () => process.exit(0)); process.stdin.resume();"]);
    expect(result.code).toBe("EXIT");
  });
});
