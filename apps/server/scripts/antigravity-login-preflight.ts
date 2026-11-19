import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { constants } from "node:fs";
import { z } from "zod";
import { stripVTControlCharacters } from "node:util";
import { IMAGE, VERSION, cleanupOwned } from "./antigravity-prototype";
import { imageTag } from "../src/docker/images";

const LIMIT = 64 * 1024;
type Code = "EXIT" | "PROCESS_UNAVAILABLE" | "PROCESS_FAILED" | "CLEANUP_DEADLINE" | "TIMEOUT" | "CANCELLED" | "OUTPUT_LIMIT" | "BOUNDARY" | "UNSAFE_OUTPUT";
export interface Screen {
  googleSelection: boolean;
  linkBoundary: boolean;
  inputBoundary: boolean;
  authorizationEndpoint?: string;
  unsafe: boolean;
}
export function screen(raw: string, final = false): Screen {
  const text = stripVTControlCharacters(raw);
  const result: Screen = {
    googleSelection: /(?:sign in|log in|login|continue) with google/i.test(text),
    linkBoundary: false,
    inputBoundary: /(?:enter|paste|input)[^\r\n]{0,60}(?:authorization|verification|auth) code/i.test(text),
    unsafe: /(?:access_token|refresh_token|id_token|Bearer\s|BEGIN .*PRIVATE KEY|model request|tool_call)/i.test(text),
  };
  // Never report arbitrary URL components, even from a Google-looking hostname.
  for (const match of text.matchAll(/https?:\/\/[^\s<>"'\x1b]+/g)) {
    if (!final && match.index + match[0].length === text.length) continue;
    try {
      const url = new URL(match[0]);
      if (url.protocol === "https:" && !url.username && !url.password && !url.port &&
          url.hostname === "accounts.google.com" &&
          ["/o/oauth2/auth", "/o/oauth2/v2/auth"].includes(url.pathname)) {
        result.linkBoundary = true;
        result.authorizationEndpoint = `https://accounts.google.com${url.pathname}`;
      } else result.unsafe = true;
    } catch { result.unsafe = true; }
  }
  return result;
}
export interface Result { code: Code; stdout: string; stderr: string; exitCode: number | null }
export interface Options { signal?: AbortSignal; timeoutMs?: number; observe?: boolean; imageCheckTemp?: string }
export type Execute = (command: string, args: string[], options?: Options) => Promise<Result>;

// Raw bytes never leave this runner except in transient internal results. Stdin has no write path.
export const execute: Execute = (command, args, options = {}) => new Promise(resolve => {
  if (options.signal?.aborted) { resolve({ code: "CANCELLED", stdout: "", stderr: "", exitCode: null }); return; }
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
    env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: "C.UTF-8",
      ...(options.imageCheckTemp ? { TMPDIR: options.imageCheckTemp } : {}) } });
  let stdout = "", stderr = "", transcript = "", bytes = 0, done = false;
  let reason: Code | undefined;
  let escalation: ReturnType<typeof setTimeout> | undefined;
  const stop = (code: Code) => {
    if (reason) {
      if (reason === "BOUNDARY" && ["OUTPUT_LIMIT", "UNSAFE_OUTPUT", "CANCELLED"].includes(code)) reason = code;
      return;
    }
    reason = code;
    if (options.imageCheckTemp) {
      // The prototype handles SIGTERM and has its own independent ten-second container cleanup.
      child.kill("SIGTERM");
      escalation = setTimeout(() => {
        reason = "CLEANUP_DEADLINE";
        try { if (child.pid) process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
      }, 12_000);
    } else child.kill("SIGKILL");
  };
  const abort = () => stop("CANCELLED");
  const timer = setTimeout(() => stop("TIMEOUT"), options.timeoutMs ?? 10_000);
  options.signal?.addEventListener("abort", abort, { once: true });
  const finish = (exitCode: number | null) => {
    if (done) return;
    done = true; clearTimeout(timer); clearTimeout(escalation); options.signal?.removeEventListener("abort", abort);
    resolve({ code: reason ?? (exitCode === 0 ? "EXIT" : "PROCESS_FAILED"), stdout, stderr, exitCode });
  };
  child.on("error", () => { reason = "PROCESS_UNAVAILABLE"; finish(null); });
  child.on("close", finish);
  for (const channel of ["stdout", "stderr"] as const) {
    child[channel].setEncoding("utf8");
    child[channel].on("data", (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > LIMIT) { stop("OUTPUT_LIMIT"); return; }
      if (channel === "stdout") stdout += chunk; else stderr += chunk;
      if (options.observe) {
        transcript += chunk;
        const state = screen(transcript);
        if (state.unsafe) stop("UNSAFE_OUTPUT");
        else if (state.linkBoundary || state.inputBoundary || state.googleSelection) stop("BOUNDARY");
      }
    });
  }
});

const diagnosticsSchema = z.discriminatedUnion("availability", [
  z.object({
    availability: z.literal("AVAILABLE"),
    output: z.enum(["EMPTY", "CONTROL_ONLY", "UNRECOGNIZED_VISIBLE", "RECOGNIZED_BOUNDARY", "UNSAFE", "CAPTURE_LIMIT"]),
    capturedBytes: z.number().int().min(0).max(LIMIT), visibleCharacters: z.number().int().min(0).max(LIMIT),
    exitCode: z.number().int().min(0).max(255).nullable(),
    streamLayout: z.enum(["SEPARATE", "TTY_MERGED_WITH_CLIENT_STDERR"]),
    errorCategory: z.enum(["NONE_RECOGNIZED", "DOCKER_DAEMON_DIAGNOSTIC", "PERMISSION_DIAGNOSTIC", "EXECUTION_DIAGNOSTIC",
      "READ_ONLY_FILESYSTEM_DIAGNOSTIC", "NO_SPACE_DIAGNOSTIC", "TTY_DIAGNOSTIC", "PROCESS_UNAVAILABLE"]),
  }).strict(),
  z.object({ availability: z.literal("UNAVAILABLE_HISTORICAL"), output: z.literal("UNAVAILABLE"),
    capturedBytes: z.null(), visibleCharacters: z.null(), exitCode: z.null(),
    streamLayout: z.literal("UNAVAILABLE"), errorCategory: z.literal("UNAVAILABLE") }).strict(),
]);
export type Diagnostics = z.infer<typeof diagnosticsSchema>;
function historicalDiagnostics(): Diagnostics {
  return { availability: "UNAVAILABLE_HISTORICAL", output: "UNAVAILABLE", capturedBytes: null,
    visibleCharacters: null, exitCode: null, streamLayout: "UNAVAILABLE", errorCategory: "UNAVAILABLE" };
}
export function diagnose(result: Result, tty: boolean): Diagnostics {
  // Counts describe retained capture, never reconstructed vendor text or inferred child exit codes.
  const text = `${stripVTControlCharacters(result.stdout)}\n${stripVTControlCharacters(result.stderr)}`;
  const visibleCharacters = Array.from(text.replace(/[\p{Cc}\p{Cf}\s]/gu, "")).length;
  const capturedBytes = Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr);
  const state = screen(`${result.stdout}\n${result.stderr}`, true);
  let errorCategory: Diagnostics["errorCategory"] = "NONE_RECOGNIZED";
  if (result.code === "PROCESS_UNAVAILABLE") errorCategory = "PROCESS_UNAVAILABLE";
  else if (/Cannot connect to the Docker daemon|error during connect|Error response from daemon/i.test(text)) errorCategory = "DOCKER_DAEMON_DIAGNOSTIC";
  else if (/read-only file system/i.test(text)) errorCategory = "READ_ONLY_FILESYSTEM_DIAGNOSTIC";
  else if (/no space left on device/i.test(text)) errorCategory = "NO_SPACE_DIAGNOSTIC";
  else if (/not a tty|requires? (?:a )?(?:tty|terminal)|inappropriate ioctl for device/i.test(text)) errorCategory = "TTY_DIAGNOSTIC";
  else if (/cannot execute|exec format error|executable file not found|failed to exec/i.test(text)) errorCategory = "EXECUTION_DIAGNOSTIC";
  else if (/permission denied|operation not permitted/i.test(text)) errorCategory = "PERMISSION_DIAGNOSTIC";
  return { availability: "AVAILABLE", capturedBytes: Math.min(LIMIT, capturedBytes),
    visibleCharacters: Math.min(LIMIT, visibleCharacters), exitCode: result.exitCode,
    streamLayout: tty ? "TTY_MERGED_WITH_CLIENT_STDERR" : "SEPARATE", errorCategory,
    output: result.code === "OUTPUT_LIMIT" ? "CAPTURE_LIMIT" : state.unsafe ? "UNSAFE" : capturedBytes === 0 ? "EMPTY" :
      visibleCharacters === 0 ? "CONTROL_ONLY" : state.googleSelection || state.linkBoundary || state.inputBoundary ? "RECOGNIZED_BOUNDARY" : "UNRECOGNIZED_VISIBLE" };
}

const UNKNOWN = ["credential-persistence", "post-consent-completion", "code-reprompt", "student-entitlement",
  "refresh", "complete-tool-removal", "model-free-completion-or-status-command", "consumer-plan-wrapping-restriction"];
function emptySummary() {
  return { evidence: "NOT_RUN", fixtureExpectations: "NOT_EXECUTED_NO_VENDOR_CLAIMS", authentication: "NOT_RUN", status: "BLOCKED", code: "NOT_RUN",
    dockerAccess: "NOT_CHECKED", architecture: "UNVERIFIED", version: "UNVERIFIED", help: "UNVERIFIED",
    ttyRequired: "UNVERIFIED", network: "bridge", execution: "not-started",
    reservedAttempts: { "non-tty": "UNVERIFIED" as number | "UNVERIFIED", "docker-tty": "UNVERIFIED" as number | "UNVERIFIED" }, inputSubmitted: false, modelRequests: 0,
    observations: [] as Array<{ mode: string; code: string; googleSelection: boolean; linkBoundary: boolean;
      inputBoundary: boolean; authorizationEndpoint?: string; diagnostics?: Diagnostics }>, unresolved: UNKNOWN,
    futureParticipation: "PLANNER_REQUIRES_FRESH_AUTHORIZATION", cleanup: "NOT_NEEDED" };
}
type Summary = ReturnType<typeof emptySummary>;
const defaultHost = () => ({ architecture: os.arch(), uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 });
// The historical two-mode harness is test-only; real dispatch below selects only the TTY mode.
export const observeWithFakeTransport = (run: Execute, signal: AbortSignal | undefined,
  host: ReturnType<typeof defaultHost>, reserve: () => Promise<void>) => observeModes(run, signal, host, reserve, [false, true]);
async function observeModes(run: Execute, signal: AbortSignal | undefined,
  host: ReturnType<typeof defaultHost>, reserve: () => Promise<void>, modes: readonly boolean[]) {
  const summary = emptySummary();
  const fail = (code: string) => { summary.status = "BLOCKED"; summary.code = code; return summary; };
  const docker = (args: string[], options: Options = {}) => run("docker", args, { signal, ...options });
  try {
    const info = await docker(["info", "--format", "{{.Architecture}}"]);
    if (info.code !== "EXIT") {
      summary.dockerAccess = "BLOCKED";
      return fail(info.code === "PROCESS_UNAVAILABLE" ? "DOCKER_CLI_MISSING" :
        /permission denied|access denied/i.test(info.stderr) ? "DOCKER_PERMISSION_DENIED" :
          info.code === "PROCESS_FAILED" ? "DOCKER_DAEMON_UNAVAILABLE" : info.code);
    }
    summary.dockerAccess = "PASS";
    if (host.architecture !== "arm64" || !["aarch64", "arm64"].includes(info.stdout.trim())) return fail("ARM64_REQUIRED");
    summary.architecture = "arm64";
    if (host.uid === 0 || host.gid === 0) return fail("NON_ROOT_REQUIRED");
    // The existing explicit image check owns its build, version/help and cleanup contract.
    let check: Result;
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "hub-agy-login-preflight-"));
    try {
      check = await run(process.execPath, [fileURLToPath(import.meta.resolve("tsx/cli")),
        fileURLToPath(new URL("./antigravity-prototype.ts", import.meta.url)), "image-check"], { signal, timeoutMs: 360_000, imageCheckTemp: temporary });
    } finally {
      const deadline = Date.now() + 10_000;
      const state = path.join(temporary, `hub-agy-prototype-image-check-${host.uid}`, "antigravity-prototype");
      const owner = createHash("sha256").update(state).digest("hex").slice(0, 24);
      try {
        // Recover even if the image-check child could not finish its own finalizer.
        await cleanupOwned(async (args) => {
          if (Date.now() >= deadline) throw new Error("CLEANUP_DEADLINE");
          const result = await docker(args, { signal: undefined, timeoutMs: deadline - Date.now() });
          if (result.code !== "EXIT") throw new Error("CLEANUP_FAILED");
          return result;
        }, owner);
        summary.cleanup = "PASS";
      } catch { summary.cleanup = "FAILED"; }
      try { await fs.rm(temporary, { recursive: true, force: true, maxRetries: 0 }); }
      catch { summary.cleanup = "FAILED"; }
    }
    if (summary.cleanup === "FAILED") return fail("IMAGE_CHECK_CLEANUP_FAILED");
    if (check.code !== "EXIT") return fail(check.code === "PROCESS_FAILED" ? "IMAGE_CHECK_FAILED" : check.code);
    if (!check.stdout.split("\n").some(line => {
      try { const value = JSON.parse(line); return value.evidence === "real-container-without-model" &&
        value.transport === "PASS" && value.version === VERSION && value.architecture === "arm64"; } catch { return false; }
    })) return fail("IMAGE_CHECK_UNCONFIRMED");
    summary.evidence = "real-image-check";
    summary.version = VERSION;
    summary.help = "PASS";
    if (signal?.aborted) return fail("CANCELLED");
    await reserve();
    summary.reservedAttempts = { "non-tty": modes.includes(false) ? 1 : 0, "docker-tty": 1 };
    summary.execution = "fresh";
    const tag = imageTag(IMAGE);
    for (const tty of modes) {
      if (signal?.aborted) return fail("CANCELLED");
      const name = `hub-agy-login-preflight-${randomUUID()}`;
      let primary: string | undefined;
      let createdSuccessfully = false;
      try {
        summary.cleanup = "PENDING";
        const args = ["create", "--name", name, "--label", "io.agent-hub.antigravity-login-preflight=true",
          "--label", `io.agent-hub.antigravity-login-preflight.owner=${name}`,
          "--user", `${host.uid}:${host.gid}`, "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges",
          "--pids-limit=64", "--memory=1g", "--cpus=2", "--network=bridge", "--log-driver=none",
          "--workdir=/work", "--env=HOME=/home/prototype", "--env=AGY_CLI_DISABLE_AUTO_UPDATE=true",
          "--env=GEMINI_FORCE_FILE_STORAGE=true", "--env=TERM=xterm-256color"];
        for (const [dir, size] of [["/tmp", "64m"], ["/home/prototype", "64m"], ["/work", "1m"]]) {
          args.push("--tmpfs", `${dir}:rw,noexec,nosuid,size=${size},uid=${host.uid},gid=${host.gid},mode=700`);
        }
        if (tty) args.push("--tty", "--interactive");
        args.push("--entrypoint=agy", tag);
        const created = await docker(args);
        if (created.code !== "EXIT") primary = created.code;
        else {
          createdSuccessfully = true;
          summary.evidence = "real-container-observation";
          const observed = await docker(["start", "--attach", name], { timeoutMs: 30_000, observe: true });
          const state = screen(`${observed.stdout}\n${observed.stderr}`, true);
          summary.observations.push({ mode: tty ? "docker-tty" : "non-tty", code: state.unsafe ? "UNSAFE_OUTPUT" : observed.code,
            googleSelection: state.googleSelection, linkBoundary: state.linkBoundary, inputBoundary: state.inputBoundary, diagnostics: diagnose(observed, tty),
            ...(state.authorizationEndpoint ? { authorizationEndpoint: state.authorizationEndpoint } : {}) });
          if (observed.code === "PROCESS_FAILED" && /Error response from daemon|Cannot connect to the Docker daemon|permission denied while trying to connect|error during connect|No such container/i.test(observed.stderr)) primary = "DOCKER_START_FAILED";
          if (state.unsafe || ["CANCELLED", "OUTPUT_LIMIT", "UNSAFE_OUTPUT", "PROCESS_UNAVAILABLE"].includes(observed.code)) primary = state.unsafe ? "UNSAFE_OUTPUT" : observed.code;
        }
      } finally {
        // Independent deadline and no cancelled signal: removal also destroys the private tmpfs profile.
        const deadline = Date.now() + 10_000;
        const clean = (args: string[]) => docker(args, { signal: undefined, timeoutMs: Math.max(1, deadline - Date.now()) });
        let mayRemove = createdSuccessfully;
        if (!mayRemove) {
          // A timed-out create may have reached the daemon. Verify our nonce before deleting anything.
          const inspected = await clean(["inspect", "--format", '{{ index .Config.Labels "io.agent-hub.antigravity-login-preflight.owner" }}', name]);
          mayRemove = inspected.code === "EXIT" && inspected.stdout.trim() === name;
          summary.cleanup = inspected.code === "PROCESS_FAILED" && /No such (?:object|container)/i.test(inspected.stderr) ? "PASS" : "FAILED";
        }
        if (mayRemove) {
          const removed = await clean(["rm", "--force", name]);
          summary.cleanup = removed.code === "EXIT" || (removed.code === "PROCESS_FAILED" && /No such container/i.test(removed.stderr)) ? "PASS" : "FAILED";
        }
      }
      if (summary.cleanup === "FAILED") return fail("CLEANUP_FAILED");
      if (primary) return fail(primary);
    }
    if (signal?.aborted) return fail("CANCELLED");
    const boundary = summary.observations.some(item => item.linkBoundary || item.inputBoundary);
    summary.status = boundary ? "PASS" : "INCONCLUSIVE";
    summary.code = boundary ? "STARTUP_BOUNDARY_OBSERVED_NO_LOGIN" : "ONLINE_STARTUP_CONTRACT_UNVERIFIED";
    return summary;
  } catch {
    if (summary.cleanup === "PENDING") { summary.cleanup = "FAILED"; return fail("CLEANUP_FAILED"); }
    return fail("LOCAL_PREFLIGHT_FAILED");
  }
}

// This identity is one authorization, not a profile selector or a renewable request budget.
export const EXPERIMENT = "d8a2a301-login-startup-online";
const MODES = ["non-tty", "docker-tty"] as const;
const STOP_CODES = ["EXIT", "PROCESS_UNAVAILABLE", "PROCESS_FAILED", "CLEANUP_DEADLINE", "TIMEOUT", "CANCELLED",
  "OUTPUT_LIMIT", "BOUNDARY", "UNSAFE_OUTPUT"] as const;
const summarySchema = z.object({
  evidence: z.enum(["NOT_RUN", "real-image-check", "real-container-observation"]),
  fixtureExpectations: z.literal("NOT_EXECUTED_NO_VENDOR_CLAIMS"), authentication: z.literal("NOT_RUN"),
  status: z.enum(["PASS", "BLOCKED", "INCONCLUSIVE"]),
  code: z.enum([...STOP_CODES, "NOT_RUN", "DOCKER_CLI_MISSING", "DOCKER_PERMISSION_DENIED", "DOCKER_DAEMON_UNAVAILABLE",
    "ARM64_REQUIRED", "NON_ROOT_REQUIRED", "IMAGE_CHECK_CLEANUP_FAILED", "IMAGE_CHECK_FAILED", "IMAGE_CHECK_UNCONFIRMED",
    "CLEANUP_FAILED", "DOCKER_START_FAILED", "STARTUP_BOUNDARY_OBSERVED_NO_LOGIN", "ONLINE_STARTUP_CONTRACT_UNVERIFIED",
    "LOCAL_PREFLIGHT_FAILED"]),
  dockerAccess: z.enum(["NOT_CHECKED", "BLOCKED", "PASS"]), architecture: z.enum(["UNVERIFIED", "arm64"]),
  version: z.enum(["UNVERIFIED", VERSION]), help: z.enum(["UNVERIFIED", "PASS"]), ttyRequired: z.literal("UNVERIFIED"),
  network: z.literal("bridge"), execution: z.literal("fresh"),
  reservedAttempts: z.object({ "non-tty": z.literal(1), "docker-tty": z.literal(1) }).strict(),
  inputSubmitted: z.literal(false), modelRequests: z.literal(0),
  observations: z.array(z.object({ mode: z.enum(MODES), code: z.enum(STOP_CODES),
    googleSelection: z.boolean(), linkBoundary: z.boolean(), inputBoundary: z.boolean(),
    diagnostics: diagnosticsSchema.optional(),
    authorizationEndpoint: z.enum(["https://accounts.google.com/o/oauth2/auth", "https://accounts.google.com/o/oauth2/v2/auth"]).optional(),
  }).strict()).max(2).refine(items => new Set(items.map(item => item.mode)).size === items.length),
  unresolved: z.array(z.string()).refine(items => JSON.stringify(items) === JSON.stringify(UNKNOWN)),
  futureParticipation: z.literal("PLANNER_REQUIRES_FRESH_AUTHORIZATION"), cleanup: z.enum(["NOT_NEEDED", "PASS", "FAILED"]),
}).strict();
const checkpointSchema = z.object({ experiment: z.literal(EXPERIMENT),
  reservedAttempts: z.object({ "non-tty": z.literal(1), "docker-tty": z.literal(1) }).strict(),
  result: summarySchema.optional(),
}).strict();

async function verifyPrivateDirectory(directory: string) {
  const absolute = path.resolve(directory);
  let cursor = path.parse(absolute).root;
  for (const part of absolute.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    const stat = await fs.lstat(cursor);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("UNSAFE_CHECKPOINT");
  }
  const stat = await fs.lstat(absolute);
  if (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw new Error("UNSAFE_CHECKPOINT");
}
async function readPrivateJson(filename: string): Promise<unknown> {
  let handle;
  try { handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || stat.size > 8192) throw new Error("UNSAFE_CHECKPOINT");
    const buffer = Buffer.alloc(8193);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 8192) throw new Error("UNSAFE_CHECKPOINT");
    return JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")) as unknown;
  } finally { await handle.close(); }
}

async function readCheckpoint(filename: string) {
  const value = await readPrivateJson(filename);
  return value === undefined ? undefined : checkpointSchema.parse(value);
}
const configuredRoot = () => process.env.AGENT_HUB_ANTIGRAVITY_PREFLIGHT_DATA ?? process.env.AGENT_HUB_DATA ??
  fileURLToPath(new URL("../../../data", import.meta.url));
export async function preflight(dataRoot = configuredRoot()): Promise<Summary & { reuseOnly: true }> {
  const blocked = (code: string): Summary & { reuseOnly: true } => ({ ...emptySummary(), status: "BLOCKED", code, reuseOnly: true });
  if (!path.isAbsolute(dataRoot)) return blocked("ABSOLUTE_CHECKPOINT_ROOT_REQUIRED");
  const checkout = fileURLToPath(new URL("../../../", import.meta.url));
  const relative = path.relative(checkout, dataRoot);
  if (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative) &&
      relative !== "data" && !relative.startsWith(`data${path.sep}`)) return blocked("CHECKPOINT_ROOT_NOT_DURABLE_IGNORED_DATA");
  const directory = path.join(dataRoot, "antigravity-login-preflight", EXPERIMENT);
  try {
    // Read-only, including missing-state outcomes: no directory creation, lock or reservation write.
    await verifyPrivateDirectory(path.join(dataRoot, "antigravity-login-preflight"));
    await verifyPrivateDirectory(directory);
    const saved = await readCheckpoint(path.join(directory, "checkpoint.json"));
    if (!saved) return blocked("CHECKPOINT_MISSING_REUSE_ONLY");
    if (!saved.result) return { ...blocked("EXPERIMENT_INCOMPLETE_NO_RETRY"), reservedAttempts: saved.reservedAttempts };
    return { ...saved.result, reuseOnly: true, evidence: "reused-online-experiment", execution: "reused",
      observations: saved.result.observations.map(item => ({ ...item, diagnostics: item.diagnostics ?? historicalDiagnostics() })) };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return blocked(code === "ENOENT" ? "CHECKPOINT_MISSING_REUSE_ONLY" :
      code === "EACCES" || code === "EPERM" ? "CHECKPOINT_INACCESSIBLE_REUSE_ONLY" : "CHECKPOINT_INVALID_OR_UNSAFE_REUSE_ONLY");
  }
}

// Fresh authorization after finalSeq 131; this fixed identity is never caller-selectable.
export const DIAGNOSTIC_EXPERIMENT = "d8a2a301-login-startup-tty-diagnostics-1";
const diagnosticSummarySchema = summarySchema.extend({
  experiment: z.literal(DIAGNOSTIC_EXPERIMENT), entryMode: z.literal("ONE_USE_TTY_DIAGNOSTIC"),
  code: summarySchema.shape.code.or(z.literal("TTY_DIAGNOSTIC_STARTUP_UNVERIFIED")),
  reservedAttempts: z.object({ "non-tty": z.literal(0), "docker-tty": z.literal(1) }).strict(),
  observations: z.array(summarySchema.shape.observations.element.extend({ mode: z.literal("docker-tty"),
    diagnostics: diagnosticsSchema.refine(value => value.availability === "AVAILABLE"),
  })).max(1),
}).strict().refine(value => value.status === "BLOCKED" || value.observations.length === 1);
const diagnosticCheckpointSchema = z.object({ experiment: z.literal(DIAGNOSTIC_EXPERIMENT),
  reservedAttempts: z.object({ "docker-tty": z.literal(1) }).strict(),
  result: diagnosticSummarySchema.optional(),
}).strict();
async function writeExclusive(filename: string, value: unknown) {
  const handle = await fs.open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
}
async function syncDirectory(directory: string) {
  const handle = await fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}
export async function diagnosticPreflight(run: Execute = execute, signal?: AbortSignal,
  host = defaultHost(), dataRoot = configuredRoot()) {
  const base = () => ({ ...emptySummary(), experiment: DIAGNOSTIC_EXPERIMENT, entryMode: "ONE_USE_TTY_DIAGNOSTIC" });
  const blocked = (code: string) => ({ ...base(), status: "BLOCKED", code });
  // Preserve the original reader and require its completed safe evidence before any new mutation or process.
  const old = await preflight(dataRoot);
  if (old.status === "BLOCKED") {
    const reasons: Record<string, string> = { CHECKPOINT_MISSING_REUSE_ONLY: "OLD_CHECKPOINT_MISSING",
      EXPERIMENT_INCOMPLETE_NO_RETRY: "OLD_CHECKPOINT_INCOMPLETE", CHECKPOINT_INACCESSIBLE_REUSE_ONLY: "OLD_CHECKPOINT_INACCESSIBLE",
      CHECKPOINT_INVALID_OR_UNSAFE_REUSE_ONLY: "OLD_CHECKPOINT_INVALID", ABSOLUTE_CHECKPOINT_ROOT_REQUIRED: "ABSOLUTE_CHECKPOINT_ROOT_REQUIRED",
      CHECKPOINT_ROOT_NOT_DURABLE_IGNORED_DATA: "CHECKPOINT_ROOT_NOT_DURABLE_IGNORED_DATA" };
    return blocked(reasons[old.code] ?? "OLD_CHECKPOINT_NOT_SAFE_COMPLETE");
  }
  if (old.cleanup !== "PASS" || old.version !== VERSION || old.help !== "PASS" || old.architecture !== "arm64" ||
      old.dockerAccess !== "PASS" || old.observations.length !== 2 ||
      !MODES.every(mode => old.observations.some(item => item.mode === mode))) return blocked("OLD_CHECKPOINT_NOT_SAFE_COMPLETE");
  const parent = path.join(dataRoot, "antigravity-login-preflight");
  const directory = path.join(parent, DIAGNOSTIC_EXPERIMENT);
  const filename = path.join(directory, "checkpoint.json");
  let reserved = false;
  try {
    if (signal?.aborted) return blocked("CANCELLED");
    try { await fs.mkdir(directory, { mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await verifyPrivateDirectory(directory);
      const value = await readPrivateJson(filename);
      if (value === undefined) return blocked("DIAGNOSTIC_INCOMPLETE_NO_RETRY");
      const saved = diagnosticCheckpointSchema.parse(value);
      if (!saved.result) return { ...blocked("DIAGNOSTIC_INCOMPLETE_NO_RETRY"), reservedAttempts: { "non-tty": 0, "docker-tty": 1 } };
      return { ...saved.result, evidence: "reused-tty-diagnostic-experiment", execution: "reused" };
    }
    // Exclusive directory creation is the one-use claim. Even an empty/partial claim is never repaired.
    await writeExclusive(filename, { experiment: DIAGNOSTIC_EXPERIMENT, reservedAttempts: { "docker-tty": 1 } });
    await syncDirectory(directory);
    await syncDirectory(parent);
    reserved = true;
    // Reservation precedes even prerequisite containers; only the single TTY startup can be dispatched.
    const observed = await observeModes(run, signal, host, async () => {}, [true]);
    const result = diagnosticSummarySchema.parse({ ...observed, experiment: DIAGNOSTIC_EXPERIMENT,
      entryMode: "ONE_USE_TTY_DIAGNOSTIC", execution: "fresh", reservedAttempts: { "non-tty": 0, "docker-tty": 1 },
      code: observed.status === "INCONCLUSIVE" ? "TTY_DIAGNOSTIC_STARTUP_UNVERIFIED" : observed.code });
    const temporary = path.join(directory, "result.tmp");
    try {
      await writeExclusive(temporary, { experiment: DIAGNOSTIC_EXPERIMENT, reservedAttempts: { "docker-tty": 1 }, result });
      await fs.rename(temporary, filename);
      await syncDirectory(directory);
    } catch { return { ...blocked("DIAGNOSTIC_RESULT_WRITE_FAILED_NO_RETRY"), reservedAttempts: { "non-tty": 0, "docker-tty": 1 } }; }
    return result;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { ...blocked(code === "EACCES" || code === "EPERM" ? "DIAGNOSTIC_CHECKPOINT_INACCESSIBLE_NO_RETRY" :
      reserved ? "DIAGNOSTIC_FAILED_NO_RETRY" : "DIAGNOSTIC_STATE_INVALID_OR_UNAVAILABLE_NO_RETRY"),
      ...(reserved ? { reservedAttempts: { "non-tty": 0, "docker-tty": 1 } } : {}) };
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
  const result = process.argv.length === 2 ? await diagnosticPreflight(execute, controller.signal) :
    { status: "BLOCKED", code: "NO_ARGUMENTS_ALLOWED", entryMode: "ONE_USE_TTY_DIAGNOSTIC" };
  process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel);
  console.log(JSON.stringify(result));
  process.exitCode = result.status === "BLOCKED" ? 1 : 0;
}
