import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { validateHome } from "../src/antigravity/login";
import { OWNER_LABEL } from "../src/antigravity/docker";
import { repairSeededConfig, selectImage } from "./antigravity-prototype";
import { readLedger, writeLedger, type Ledger } from "./antigravity-prototype/ledger";
import { docker, ownedContainer, type Docker } from "./antigravity-prototype/process";
import { PrototypeError, SYNTHETIC_PROMPT } from "./antigravity-prototype/protocol";

import { inspectHeadlessProtocol, LOGIN_PATTERN, STREAM_CHECKS } from "./antigravity-prototype/headless-protocol";

const REASONS = ["NONE", "NOT_RUN", "UNKNOWN", "INVALID_MODEL", "LOGIN_REQUIRED", "QUOTA_EXHAUSTED",
  "TIMEOUT", "CLI_ERROR", "PROTOCOL_ERROR", "CANCELLED", "INTERRUPTED", ...STREAM_CHECKS] as const;
const CLI_ARGUMENTS = ["--agent", "hub-prototype", "--output-format", "stream-json", "-p"];
const legacyRequestSchema = z.object({
  status: z.enum(["PASS", "FAIL", "TIMEOUT", "NOT_RUN"]),
  advertisedTools: z.literal(0).nullable(), observedToolEvents: z.literal(0).nullable(),
  steps: z.number().int().nonnegative().nullable(), terminal: z.literal("SUCCESS").nullable(),
  structuredHunks: z.literal(1).nullable(), strictIsolation: z.literal("UNVERIFIED"),
  loginRequested: z.boolean().nullable(), homeFilesChanged: z.number().int().nonnegative().nullable(),
}).strict();
const headlessFields = {
  auth: z.enum(["PASS", "FAIL"]).nullable(), completed: z.boolean().nullable(),
  protocol: z.enum(["PASS", "FAIL"]).nullable(), answerShape: z.enum(["MATCH", "MISMATCH"]).nullable(),
};
const requestSchema = legacyRequestSchema.extend({ reasonCode: z.enum(REASONS), ...headlessFields,
  advertisedTools: z.number().int().nonnegative().nullable(), observedToolEvents: z.number().int().nonnegative().nullable(),
}).strict();
const storedRequestSchema = requestSchema.extend({ reasonCode: z.enum(REASONS).optional(),
  auth: headlessFields.auth.optional(), completed: headlessFields.completed.optional(),
  protocol: headlessFields.protocol.optional(), answerShape: headlessFields.answerShape.optional(),
}).strict();
const legacySummarySchema = z.object({
  code: z.enum(["COMPLETE", "COMPLETE_WITH_UNVERIFIED_HISTORY", "HOME_MISSING_OR_EMPTY", "LOGIN_SESSION_RUNNING", "DOCKER_UNAVAILABLE", "ARM64_REQUIRED",
    "STATE_UNAVAILABLE", "INCOMPLETE_NO_RETRY", "REQUEST_FAILED", "REQUEST_TIMEOUT", "CANCELLED", "CONTAINER_FAILED",
    "CLEANUP_FAILED", "NO_ARGUMENTS_ALLOWED"]),
  cleanup: z.enum(["NOT_NEEDED", "PASS", "FAIL"]), requests: z.array(storedRequestSchema).length(3),
}).strict();
const summarySchema = legacySummarySchema.extend({ requests: z.array(requestSchema).length(3) }).strict();
function storedResult(value: unknown) {
  const result = legacySummarySchema.parse(value);
  return summarySchema.parse({ ...result, requests: result.requests.map(request => ({ ...request,
    auth: request.auth === undefined ? (request.status === "PASS" && request.terminal === "SUCCESS" ? "PASS" : null) : request.auth,
    completed: request.completed === undefined ? (request.terminal === "SUCCESS" ? true : null) : request.completed,
    protocol: request.protocol === undefined ? (request.status === "PASS" && request.terminal === "SUCCESS" ? "PASS" : null) : request.protocol,
    answerShape: request.answerShape === undefined ? (request.structuredHunks === 1 ? "MATCH" : null) : request.answerShape,
    reasonCode: request.reasonCode ?? (request.status === "PASS" ? "NONE" : request.status === "NOT_RUN" ? "NOT_RUN" : "UNKNOWN"),
  })) });
}
function eligibleForMigration(saved: Ledger): boolean {
  if (saved.version !== undefined && saved.version !== 1 || saved.attempts !== 1 || saved.completed !== 0 || !saved.result) return false;
  const result = legacySummarySchema.parse(saved.result);
  const first = result.requests[0]!;
  const noEvidence = [first.advertisedTools, first.observedToolEvents, first.steps, first.terminal, first.structuredHunks].every(value => value === null);
  return result.code === "REQUEST_FAILED" && result.cleanup === "PASS" && first.status === "FAIL" &&
    noEvidence && (first.reasonCode === "INVALID_MODEL" || first.reasonCode === undefined && first.loginRequested === false) &&
    result.requests.slice(1).every(request => request.status === "NOT_RUN" && request.advertisedTools === null &&
      request.observedToolEvents === null && request.steps === null && request.terminal === null && request.structuredHunks === null &&
      request.loginRequested === null && request.homeFilesChanged === null && (request.reasonCode === undefined || request.reasonCode === "NOT_RUN"));
}
function eligibleForContinuation(saved: Ledger): boolean {
  if (saved.version !== 2 || saved.attempts !== 1 || saved.completed !== 0 || saved.continuation !== undefined || !saved.result) return false;
  if (saved.modelChoice !== undefined && saved.modelChoice !== "ACCOUNT_DEFAULT") return false;
  if (saved.cliArguments !== undefined && JSON.stringify(saved.cliArguments) !== JSON.stringify(["agy", ...CLI_ARGUMENTS])) return false;
  const result = storedResult(saved.result);
  const first = result.requests[0]!;
  return result.code === "REQUEST_FAILED" && result.cleanup === "PASS" && first.status === "FAIL" &&
    first.reasonCode === "PROTOCOL_ERROR" && first.loginRequested === false &&
    [first.auth, first.completed, first.protocol, first.answerShape, first.advertisedTools,
      first.observedToolEvents, first.steps, first.terminal, first.structuredHunks].every(value => value === null) &&
    result.requests.slice(1).every(request => Object.entries(emptyRequest()).every(([key, value]) => request[key as keyof typeof request] === value));
}
async function syncDirectory(directory: string) {
  const handle = await fs.open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}
function failureReason(error: unknown, output: string): z.infer<typeof requestSchema>["reasonCode"] {
  if (error instanceof PrototypeError && error.code === "TIMEOUT") return "TIMEOUT";
  if (error instanceof PrototypeError && error.code === "CANCELLED") return "CANCELLED";
  if (/invalid model selection|model.{0,160}(?:not recognized|unknown model)|unknown model|unsupported model/i.test(output)) return "INVALID_MODEL";
  if (LOGIN_PATTERN.test(output)) return "LOGIN_REQUIRED";
  if (/RESOURCE_EXHAUSTED|quota.{0,60}(?:exhausted|exceeded|depleted)|(?:usage|rate) limit.{0,40}(?:reached|exceeded)/i.test(output)) return "QUOTA_EXHAUSTED";
  if (error instanceof PrototypeError && !["PROCESS_FAILED", "PROCESS_UNAVAILABLE", "OUTPUT_LIMIT"].includes(error.code)) return "PROTOCOL_ERROR";
  return "CLI_ERROR";
}
type Summary = z.infer<typeof summarySchema>;
const emptyRequest = (): z.infer<typeof requestSchema> => ({ status: "NOT_RUN", reasonCode: "NOT_RUN", auth: null, completed: null, protocol: null, answerShape: null, advertisedTools: null,
  observedToolEvents: null, steps: null, terminal: null, structuredHunks: null, strictIsolation: "UNVERIFIED",
  loginRequested: null, homeFilesChanged: null });
const empty = (code: Summary["code"]): Summary => ({ code, cleanup: "NOT_NEEDED",
  requests: Array.from({ length: 3 }, emptyRequest) });

async function snapshot(home: string, directory = home, files = new Map<string, string>(), budget = { entries: 0, bytes: 0 }) {
  for (const entry of await fs.readdir(directory)) {
    if (++budget.entries > 4096) throw new Error("HOME_LIMIT");
    const filename = path.join(directory, entry);
    const stat = await fs.lstat(filename);
    if (stat.isDirectory()) await snapshot(home, filename, files, budget);
    else {
      // CLI-created links and sockets are entries to compare, never paths to follow or read.
      let fingerprint = "metadata-only";
      if (stat.isFile()) {
        budget.bytes += stat.size;
        if (stat.size > 16 * 1024 * 1024 || budget.bytes > 64 * 1024 * 1024) throw new Error("HOME_LIMIT");
        const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const opened = await handle.stat();
          if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size) {
            throw new Error("HOME_CHANGED_DURING_SNAPSHOT");
          }
          // An open regular file can still grow; cap the read independently of its initial stat.
          const buffer = Buffer.alloc(opened.size + 1);
          let length = 0;
          while (length < buffer.length) {
            const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
            if (!bytesRead) break;
            length += bytesRead;
          }
          const after = await handle.stat();
          if (length !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) {
            throw new Error("HOME_CHANGED_DURING_SNAPSHOT");
          }
          fingerprint = createHash("sha256").update(buffer.subarray(0, length)).digest("hex");
        } finally { await handle.close(); }
      }
      files.set(path.relative(home, filename), `${fingerprint}:${stat.mode}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.ino}`);
    }
  }
  return files;
}
async function optionalSnapshot(home: string): Promise<Map<string, string> | null> {
  try { return await snapshot(home); }
  catch { return null; }
}
const changed = (before: Map<string, string>, after: Map<string, string>) =>
  [...new Set([...before.keys(), ...after.keys()])].filter(key => before.get(key) !== after.get(key)).length;

export async function headlessCheck(dataRoot: string, transport: Docker = docker,
  signal: AbortSignal = new AbortController().signal,
  host = { architecture: os.arch(), uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0 }): Promise<Summary> {
  const root = path.resolve(dataRoot, "antigravity-headless-check");
  const state = path.join(root, "v2");
  let summary = empty("STATE_UNAVAILABLE");
  let ledger: Ledger | undefined;
  let claimed = false;
  let resuming = false;
  let historicalFirst: z.infer<typeof storedRequestSchema> | undefined;
  const continuationPath = path.join(state, "remaining-requests-claim");
  const refuse = (code: Summary["code"]): Summary => resuming ? { ...summary, code } : empty(code);
  const save = async () => {
    if (!claimed || !ledger) return;
    const result = summarySchema.parse(summary);
    // Keep the original request object unchanged; unknown new evidence is only added to output.
    ledger.result = historicalFirst ? { ...result, requests: [historicalFirst, ...result.requests.slice(1)] } : result;
    await writeLedger(state, ledger);
  };
  try {
    let migrating = false;
    let rootExists = false;
    try {
      const stat = await fs.lstat(root);
      rootExists = true;
      if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(root) !== root) return summary;
      try {
        const version = await fs.lstat(state);
        if (!version.isDirectory() || version.isSymbolicLink()) return summary;
        const saved = await readLedger(state);
        if (saved.result === undefined) return empty("INCOMPLETE_NO_RETRY");
        if (!eligibleForContinuation(saved)) return storedResult(saved.result);
        try { await fs.lstat(continuationPath); return storedResult(saved.result); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        resuming = true;
        summary = storedResult(saved.result);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return summary; }
      if (!resuming) {
        const saved = await readLedger(root);
        if (saved.result === undefined) return empty("INCOMPLETE_NO_RETRY");
        migrating = eligibleForMigration(saved);
        if (!migrating) return storedResult(saved.result);
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return summary; }
    const home = validateHome(dataRoot, path.resolve(dataRoot, "antigravity/home"));
    let before: Map<string, string> | null;
    try {
      if (!(await fs.readdir(home)).length) return refuse("HOME_MISSING_OR_EMPTY");
      before = await optionalSnapshot(home);
      if (before?.size === 0) return refuse("HOME_MISSING_OR_EMPTY");
    } catch (error) {
      return refuse((error as NodeJS.ErrnoException).code === "ENOENT" ? "HOME_MISSING_OR_EMPTY" : "STATE_UNAVAILABLE");
    }
    let architecture: string;
    try {
      architecture = (await transport(["info", "--format", "{{.Architecture}}"], { signal, timeoutMs: 10_000 })).stdout.trim();
      // Match the panel's names as well as its ownership label (including sessions from another Hub).
      for (const filter of [`name=agent-hub-agy-login-`, `label=${OWNER_LABEL}`]) {
        if ((await transport(["ps", "-q", "--filter", filter], { signal, timeoutMs: 10_000 })).stdout.trim()) {
          return refuse("LOGIN_SESSION_RUNNING");
        }
      }
    } catch { return refuse(signal.aborted ? "CANCELLED" : "DOCKER_UNAVAILABLE"); }
    if (host.architecture !== "arm64" || !["arm64", "aarch64"].includes(architecture)) return refuse("ARM64_REQUIRED");
    if (!host.uid || !host.gid || home.includes(",")) return summary;
    if (signal.aborted) return refuse("CANCELLED");
    if (resuming) {
      try { await fs.mkdir(continuationPath, { mode: 0o700 }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const saved = await readLedger(state);
        return saved.result === undefined ? refuse("INCOMPLETE_NO_RETRY") : storedResult(saved.result);
      }
      // The permanent claim precedes every mutation and survives a crash before the next charge.
      await syncDirectory(state);
      const saved = await readLedger(state);
      if (!eligibleForContinuation(saved)) return saved.result === undefined ? refuse("INCOMPLETE_NO_RETRY") : storedResult(saved.result);
      await fs.copyFile(path.join(state, "ledger.json"), path.join(continuationPath, "ledger-before-continuation.json"), constants.COPYFILE_EXCL);
      const backup = await fs.open(path.join(continuationPath, "ledger-before-continuation.json"), "r");
      try { await backup.sync(); } finally { await backup.close(); }
      await syncDirectory(continuationPath);
      ledger = { ...saved, continuation: "REQUESTS_2_AND_3_REPLACEMENT_CONTAINER",
        cliArguments: ["agy", ...CLI_ARGUMENTS], modelChoice: "ACCOUNT_DEFAULT" };
      historicalFirst = legacySummarySchema.parse(saved.result).requests[0]!;
      summary = storedResult(saved.result);
      summary.code = "INCOMPLETE_NO_RETRY";
      claimed = true;
    } else {
      try {
        if (!rootExists) await fs.mkdir(root, { mode: 0o700 });
        await fs.mkdir(state, { mode: 0o700 });
      }
      catch { return empty("INCOMPLETE_NO_RETRY"); }
      claimed = true;
      ledger = { version: 2, cliArguments: ["agy", ...CLI_ARGUMENTS], modelChoice: "ACCOUNT_DEFAULT", attempts: 0, completed: 0 };
      summary = empty("INCOMPLETE_NO_RETRY");
    }
    await save();
    for (const directory of [root, path.dirname(root)]) await syncDirectory(directory);
    if (migrating) {
      // The v2 claim is durable before archiving; an interrupted migration never starts over.
      const archive = path.join(root, "archive-v1");
      await fs.mkdir(archive, { mode: 0o700 });
      await fs.rename(path.join(root, "ledger.json"), path.join(archive, "ledger.json"));
      for (const directory of [archive, root]) {
        const handle = await fs.open(directory, "r");
        try { await handle.sync(); } finally { await handle.close(); }
      }
    }
    const parent = await fs.open(path.dirname(state), "r");
    try { await parent.sync(); } finally { await parent.close(); }
    await repairSeededConfig(home);
    before = await optionalSnapshot(home);
    const tag = await selectImage(signal, transport, host.architecture);
    const args = ["--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--pids-limit=64",
      "--memory=1g", "--cpus=2", "--network=bridge", "--log-driver=none", "--user", `${host.uid}:${host.gid}`,
      "--env", "HOME=/home/prototype", "--env", "AGY_CLI_DISABLE_AUTO_UPDATE=true", "--env", "GEMINI_FORCE_FILE_STORAGE=true",
      "--workdir=/work", "--tmpfs", `/tmp:rw,noexec,nosuid,size=64m,uid=${host.uid},gid=${host.gid},mode=700`,
      "--tmpfs", `/work:rw,noexec,nosuid,size=1m,uid=${host.uid},gid=${host.gid},mode=700`,
      "--mount", `type=bind,src=${home},dst=/home/prototype`, "--entrypoint", "/bin/sleep", tag, "infinity"];
    let stopped = false;
    for (const indices of (resuming ? [[1], [2]] : [[0, 1], [2]])) {
      if (stopped) break;
      if (signal.aborted) { summary.code = "CANCELLED"; stopped = true; break; }
      const name = `hub-agy-headless-check-${randomUUID()}`;
      let removalFailed = false;
      let failedRequest: number | undefined;
      const monitored: Docker = async (command, options) => {
        try { return await transport(command, options); }
        catch (error) { if (command[0] === "rm") removalFailed = true; throw error; }
      };
      summary.cleanup = "FAIL";
      try {
        await ownedContainer(monitored, name, args, async () => {
          for (const index of indices) {
            if (signal.aborted) { summary.code = "CANCELLED"; stopped = true; break; }
            const request = summary.requests[index]!;
            // Charge before dispatch. A crash leaves FAIL and unused slots NOT_RUN; none are retried.
            request.status = "FAIL";
            request.reasonCode = "INTERRUPTED";
            summary.code = "INCOMPLETE_NO_RETRY";
            ledger!.attempts++;
            if (ledger!.attempts > 3) throw new Error("BUDGET_EXHAUSTED");
            await save();
            let output = "";
            request.loginRequested = false;
            try {
              const result = await transport(["exec", name, "/bin/sh", "-c", 'umask 077; exec agy "$@"', "prototype",
                ...CLI_ARGUMENTS, SYNTHETIC_PROMPT],
              { signal, timeoutMs: 60_000, onOutput: chunk => { if (output.length < 65536) output += chunk; } });
              output += result.stdout + result.stderr;
              Object.assign(request, inspectHeadlessProtocol(result.stdout, result.stderr));
              if (request.auth === "PASS" && request.completed === true) {
                request.status = "PASS";
                ledger!.completed++;
              } else {
                if (request.loginRequested) request.reasonCode = "LOGIN_REQUIRED";
                request.status = "FAIL";
                summary.code = "REQUEST_FAILED";
                stopped = true;
                failedRequest = index;
              }
            } catch (error) {
              request.reasonCode = failureReason(error, output);
              request.auth = /silent auth succeeded/i.test(output) && !LOGIN_PATTERN.test(output) ? "PASS" : "FAIL";
              request.completed = false;
              request.protocol = "FAIL";
              request.answerShape = "MISMATCH";
              request.status = error instanceof PrototypeError && error.code === "TIMEOUT" ? "TIMEOUT" : "FAIL";
              summary.code = signal.aborted ? "CANCELLED" : request.status === "TIMEOUT" ? "REQUEST_TIMEOUT" : "REQUEST_FAILED";
              stopped = true;
              failedRequest = index;
            }
            request.loginRequested = LOGIN_PATTERN.test(output);
            if (!stopped) {
              const after = await optionalSnapshot(home);
              request.homeFilesChanged = before && after ? changed(before, after) : null;
              before = after;
            }
            await save();
            if (stopped) break;
          }
        }, signal);
      } catch { summary.code = removalFailed ? "CLEANUP_FAILED" : "CONTAINER_FAILED"; stopped = true; }
      summary.cleanup = removalFailed ? "FAIL" : "PASS";
      // Failed exec clients may leave the CLI alive; measure only after container removal.
      if (failedRequest !== undefined && !removalFailed) {
        const after = await optionalSnapshot(home);
        summary.requests[failedRequest]!.homeFilesChanged = before && after ? changed(before, after) : null;
      }
      await save();
    }
    if (!stopped) summary.code = resuming ? "COMPLETE_WITH_UNVERIFIED_HISTORY" : "COMPLETE";
    await save();
    return summary;
  } catch {
    summary.code = signal.aborted ? "CANCELLED" : "STATE_UNAVAILABLE";
    try { await save(); } catch { /* The permanent claim still prevents another dispatch. */ }
    return summary;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
  const result = process.argv.length === 2 ? await headlessCheck(process.env.AGENT_HUB_DATA ??
    fileURLToPath(new URL("../../../data", import.meta.url)), docker, controller.signal) : empty("NO_ARGUMENTS_ALLOWED");
  process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel);
  console.log(JSON.stringify(result));
  process.exitCode = ["COMPLETE", "COMPLETE_WITH_UNVERIFIED_HISTORY"].includes(result.code) ? 0 : 1;
}
