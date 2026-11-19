import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createServer } from "node:net";
import { headlessCheck } from "../scripts/antigravity-headless-check";
import { PrototypeError, SYNTHETIC_PROMPT } from "../scripts/antigravity-prototype/protocol";
import type { Docker } from "../scripts/antigravity-prototype/process";
import { repairSeededConfig, prepareState } from "../scripts/antigravity-prototype";
import { DOCKER_DIR } from "../src/docker/images";
import { writeLedger } from "../scripts/antigravity-prototype/ledger";

const host = { architecture: "arm64" as const, uid: 1000, gid: 1000 };
const sensitive = "fixture@example.invalid token=fake-token response-text";
const stdout = [
  { event: "init", conversation_id: sensitive, init: { agent: "hub-prototype", cwd: "/work", tools: [] } },
  { event: "result", result: { conversation_id: sensitive, status: "SUCCESS",
    response: JSON.stringify({ hunks: [{ id: "synthetic-1", explanation: `測試 ${sensitive}` }] }) } },
].map(value => JSON.stringify(value)).join("\n");
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function fixture(populate = true) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agy-headless-"));
  roots.push(root);
  const home = path.join(root, "antigravity/home");
  await fs.mkdir(home, { recursive: true });
  if (populate) await fs.writeFile(path.join(home, "fixture"), "fake credential");
  return { root, home, baseState: path.join(root, "antigravity-headless-check"), state: path.join(root, "antigravity-headless-check/v2") };
}
function fake(override?: Docker) {
  const calls: string[][] = [];
  const transport: Docker = async (args, options) => {
    calls.push(args);
    if (override) return override(args, options);
    return { stdout: args[0] === "info" ? "aarch64" : args[0] === "exec" ? stdout : "", stderr: "" };
  };
  return { calls, transport };
}
const check = (root: string, transport: Docker, signal?: AbortSignal) => headlessCheck(root, transport, signal, host);

const oldRequest = () => ({ status: "NOT_RUN", advertisedTools: null, observedToolEvents: null, steps: null,
  terminal: null, structuredHunks: null, strictIsolation: "UNVERIFIED", loginRequested: null, homeFilesChanged: null });
function oldFailure(reasonCode?: string) {
  const first = { ...oldRequest(), status: "FAIL", loginRequested: false, homeFilesChanged: 3,
    ...(reasonCode === undefined ? {} : { reasonCode }) };
  return { code: "REQUEST_FAILED", cleanup: "PASS", requests: [first, oldRequest(), oldRequest()] };
}

describe("headless credential check (scripted transport only)", () => {
  it("charges before each of three requests, reuses then recreates the container, and reprints without a fourth", async () => {
    const { root, home, state } = await fixture();
    let count = 0;
    const { calls, transport } = fake(async (args, options) => {
      if (args[0] === "exec") {
        count++;
        expect(JSON.parse(await fs.readFile(path.join(state, "ledger.json"), "utf8")).attempts).toBe(count);
        expect(options?.timeoutMs).toBe(60_000);
        expect(args).toContain(SYNTHETIC_PROMPT);
        expect(args).not.toContain("--model");
        expect(args).not.toContain("flash");
        const saved = JSON.parse(await fs.readFile(path.join(state, "ledger.json"), "utf8"));
        expect(saved.version).toBe(2);
        expect(saved.modelChoice).toBe("ACCOUNT_DEFAULT");
        expect(saved.cliArguments).toEqual(["agy", "--agent", "hub-prototype", "--output-format", "stream-json", "-p"]);
        expect(JSON.stringify(saved)).not.toContain(SYNTHETIC_PROMPT);
        await fs.writeFile(path.join(home, "fixture"), `changed ${count}`);
      }
      return { stdout: args[0] === "info" ? "arm64" : args[0] === "exec" ? stdout : "", stderr: "" };
    });
    const result = await check(root, transport);
    expect(result.code).toBe("COMPLETE");
    expect(result.cleanup).toBe("PASS");
    expect(result.requests.map(request => request.status)).toEqual(["PASS", "PASS", "PASS"]);
    expect(result.requests.every(request => request.homeFilesChanged === 1 && request.loginRequested === false)).toBe(true);
    const lifecycle = calls.filter(args => ["run", "exec", "rm"].includes(args[0]!));
    expect(lifecycle.map(args => args[0])).toEqual(["run", "exec", "exec", "rm", "run", "exec", "rm"]);
    expect(lifecycle[1]![1]).toBe(lifecycle[2]![1]);
    expect(lifecycle[5]![1]).not.toBe(lifecycle[1]![1]);
    for (const run of calls.filter(args => args[0] === "run")) {
      expect(run).toContain(`type=bind,src=${home},dst=/home/prototype`);
      expect(run).toContain("--log-driver=none");
    }
    const length = calls.length;
    expect(await check(root, transport)).toEqual(result);
    expect(calls).toHaveLength(length);
    expect(count).toBe(3);
    const output = JSON.stringify(result);
    for (const secret of ["fixture@example.invalid", "fake-token", "response-text", "conversation_id", home]) expect(output).not.toContain(secret);
    expect(Object.keys(result).sort()).toEqual(["cleanup", "code", "requests"]);
    expect(Object.keys(result.requests[0]!).sort()).toEqual(["advertisedTools", "homeFilesChanged", "loginRequested",
      "observedToolEvents", "steps", "strictIsolation", "structuredHunks", "terminal", "status", "reasonCode", "auth", "completed", "protocol", "answerShape"].sort());
    expect(result.requests[0]).toMatchObject({ advertisedTools: 0, observedToolEvents: 0, steps: 0,
      terminal: "SUCCESS", structuredHunks: 1, strictIsolation: "UNVERIFIED" });
  });

  it("accepts CLI socket entries without trying to open them", async () => {
    const { root, home } = await fixture();
    const socket = createServer();
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.listen(path.join(home, "fixture.sock"), resolve);
    });
    try {
      const { transport } = fake();
      const result = await check(root, transport);
      expect(result.code).toBe("COMPLETE");
      expect(result.requests.map(request => request.homeFilesChanged)).toEqual([0, 0, 0]);
    } finally { await new Promise<void>((resolve, reject) => socket.close(error => error ? reject(error) : resolve())); }
  });

  it("counts CLI symlink changes without following targets outside the home", async () => {
    const { root, home } = await fixture();
    const outside = path.join(root, "outside");
    // Following this target would exceed the snapshot limit and invalidate the evidence.
    const handle = await fs.open(outside, "w");
    try { await handle.truncate(16 * 1024 * 1024 + 1); } finally { await handle.close(); }
    const link = path.join(home, "fixture-link");
    await fs.symlink(outside, link);
    let requests = 0;
    const { transport } = fake(async args => {
      if (args[0] === "exec" && ++requests === 2) {
        await fs.unlink(link);
        await fs.symlink(path.join(root, "missing-target"), link);
      }
      return { stdout: args[0] === "info" ? "arm64" : args[0] === "exec" ? stdout : "", stderr: "" };
    });
    const result = await check(root, transport);
    expect(result.code).toBe("COMPLETE");
    expect(result.requests.map(request => request.homeFilesChanged)).toEqual([0, 1, 0]);
    expect(JSON.stringify(result)).not.toContain(outside);
  });

  it("keeps file evidence unknown when snapshots exceed their limit, without blocking requests", async () => {
    const { root, home } = await fixture();
    const handle = await fs.open(path.join(home, "large-cache"), "w");
    try { await handle.truncate(16 * 1024 * 1024 + 1); } finally { await handle.close(); }
    const { transport, calls } = fake();
    const result = await check(root, transport);
    expect(result.code).toBe("COMPLETE");
    expect(result.requests.map(request => request.status)).toEqual(["PASS", "PASS", "PASS"]);
    expect(result.requests.map(request => request.homeFilesChanged)).toEqual([null, null, null]);
    expect(calls.filter(args => args[0] === "exec")).toHaveLength(3);
  });

  it("does not compare against an older snapshot after an unavailable observation", async () => {
    const { root, home } = await fixture();
    const large = path.join(home, "large-cache");
    let requests = 0;
    const { transport } = fake(async args => {
      if (args[0] === "exec") {
        requests++;
        if (requests === 1) {
          const handle = await fs.open(large, "w");
          try { await handle.truncate(16 * 1024 * 1024 + 1); } finally { await handle.close(); }
        } else if (requests === 2) await fs.unlink(large);
      }
      return { stdout: args[0] === "info" ? "arm64" : args[0] === "exec" ? stdout : "", stderr: "" };
    });
    const result = await check(root, transport);
    expect(result.code).toBe("COMPLETE");
    expect(result.requests.map(request => request.homeFilesChanged)).toEqual([null, null, 0]);
  });

  it.each(["missing", "empty", "directories-only"])("refuses a %s home before any Docker operation", async mode => {
    const { root, home } = await fixture(false);
    if (mode === "missing") await fs.rm(home, { recursive: true });
    if (mode === "directories-only") await fs.mkdir(path.join(home, "empty"));
    const { transport, calls } = fake();
    expect((await check(root, transport)).code).toBe("HOME_MISSING_OR_EMPTY");
    expect(calls).toHaveLength(0);
  });

  it.each(["name", "label", "docker", "daemon-arm", "host-arm"])("refuses unavailable prerequisites: %s", async mode => {
    const { root } = await fixture();
    const { calls, transport } = fake(async args => {
      if (mode === "docker") throw new Error(sensitive);
      return { stdout: args[0] === "info" ? mode === "daemon-arm" ? "x86_64" : "arm64" :
        args[0] === "ps" && args.at(-1)?.startsWith(`${mode}=`) ? "abcdef123456" : "", stderr: "" };
    });
    const result = await headlessCheck(root, transport, undefined, { ...host, architecture: mode === "host-arm" ? "x64" : "arm64" });
    expect(result.code).toBe(mode === "docker" ? "DOCKER_UNAVAILABLE" : mode.endsWith("arm") ? "ARM64_REQUIRED" : "LOGIN_SESSION_RUNNING");
    expect(result.requests.every(request => request.status === "NOT_RUN")).toBe(true);
    expect(calls.some(args => ["run", "exec", "rm"].includes(args[0]!))).toBe(false);
    expect(JSON.stringify(result)).not.toContain(sensitive);
  });

  it.each(["TIMEOUT", "PROCESS_FAILED", "CANCELLED", "login", "protocol"])("stops and cleans up after %s without retrying", async mode => {
    const { root } = await fixture();
    const controller = new AbortController();
    const { calls, transport } = fake(async (args, options) => {
      if (args[0] === "exec") {
        options?.onOutput?.(`Please sign in: ${sensitive}`);
        if (mode === "CANCELLED") controller.abort();
        if (mode !== "login" && mode !== "protocol") throw new PrototypeError(mode);
        return { stdout: mode === "protocol" ? sensitive : "", stderr: `Authentication required ${sensitive}` };
      }
      if (args[0] === "rm") expect(options?.signal).toBeUndefined();
      return { stdout: args[0] === "info" ? "arm64" : "", stderr: "" };
    });
    const result = await check(root, transport, controller.signal);
    expect(result.requests.map(request => request.status)).toEqual([mode === "TIMEOUT" ? "TIMEOUT" : "FAIL", "NOT_RUN", "NOT_RUN"]);
    expect(result.requests[0]!.loginRequested).toBe(true);
    expect(result.requests[0]!.reasonCode).toBe(mode === "TIMEOUT" ? "TIMEOUT" : mode === "CANCELLED" ? "CANCELLED" : "LOGIN_REQUIRED");
    expect(result.cleanup).toBe("PASS");
    expect(calls.filter(args => args[0] === "rm")).toHaveLength(1);
    expect(calls.filter(args => args[0] === "exec")).toHaveLength(1);
    const length = calls.length;
    expect(await check(root, transport)).toEqual(result);
    expect(calls).toHaveLength(length);
    expect(JSON.stringify(result)).not.toContain(sensitive);
  });

  it("counts writes made by a timed-out CLI through container removal", async () => {
    const { root, home } = await fixture();
    const { transport } = fake(async args => {
      if (args[0] === "exec") throw new PrototypeError("TIMEOUT");
      if (args[0] === "rm") await fs.writeFile(path.join(home, "late-write"), "fake refresh");
      return { stdout: args[0] === "info" ? "arm64" : "", stderr: "" };
    });
    const result = await check(root, transport);
    expect(result.requests[0]).toMatchObject({ status: "TIMEOUT", homeFilesChanged: 1 });
    expect(result.cleanup).toBe("PASS");
  });

  it("removes the container if a ledger write fails before dispatch and never repairs the claim", async () => {
    const { root, state } = await fixture();
    const { transport, calls } = fake(async args => {
      if (args[0] === "run") await fs.writeFile(path.join(state, "ledger.next"), "interrupted write");
      return { stdout: args[0] === "info" ? "arm64" : "", stderr: "" };
    });
    const result = await check(root, transport);
    expect(result.cleanup).toBe("PASS");
    expect(calls.filter(args => args[0] === "rm")).toHaveLength(1);
    expect(calls.filter(args => args[0] === "exec")).toHaveLength(0);
    const length = calls.length;
    expect((await check(root, transport)).code).toBe("INCOMPLETE_NO_RETRY");
    expect(calls).toHaveLength(length);
  });

  it.each(["run", "rm", "second-run"])("handles container failure at %s and attempts cleanup", async mode => {
    const { root } = await fixture();
    let runs = 0;
    const { transport, calls } = fake(async args => {
      if (args[0] === "run") runs++;
      if (args[0] === mode || mode === "second-run" && args[0] === "run" && runs === 2) throw new Error(sensitive);
      return { stdout: args[0] === "info" ? "arm64" : args[0] === "exec" ? stdout : "", stderr: "" };
    });
    const result = await check(root, transport);
    expect(result.code).toBe(mode === "rm" ? "CLEANUP_FAILED" : "CONTAINER_FAILED");
    expect(result.cleanup).toBe(mode === "rm" ? "FAIL" : "PASS");
    expect(calls.filter(args => args[0] === "rm")).toHaveLength(mode === "second-run" ? 2 : 1);
    expect(result.requests[2]!.status).toBe("NOT_RUN");
  });

  it("does not resume an interrupted ledger, even with only one charged attempt", async () => {
    const { root, state } = await fixture();
    await fs.mkdir(state, { recursive: true });
    await writeLedger(state, { attempts: 1, completed: 0 });
    const { transport, calls } = fake();
    expect((await check(root, transport)).code).toBe("INCOMPLETE_NO_RETRY");
    expect(calls).toHaveLength(0);
  });

  it("does not repair empty, invalid, or aliased claims and never returns unvalidated stored fields", async () => {
    const { root, state } = await fixture();
    const { transport, calls } = fake();
    await fs.mkdir(state, { recursive: true });
    expect((await check(root, transport)).code).toBe("INCOMPLETE_NO_RETRY");
    await fs.writeFile(path.join(state, "ledger.json"), sensitive);
    expect((await check(root, transport)).code).toBe("STATE_UNAVAILABLE");
    await fs.rm(path.join(state, "ledger.json"));
    await writeLedger(state, { attempts: 3, completed: 3, result: { email: sensitive } });
    expect(JSON.stringify(await check(root, transport))).not.toContain(sensitive);
    await fs.rm(state, { recursive: true });
    await fs.symlink(path.join(root, "antigravity"), state);
    expect((await check(root, transport)).code).toBe("STATE_UNAVAILABLE");
    expect(calls).toHaveLength(0);
  });

  it.each([undefined, "INVALID_MODEL"])("archives an authorized old invalid-model attempt (%s) once", async reason => {
    const { root, baseState, state } = await fixture();
    await fs.mkdir(baseState);
    const previous = { attempts: 1, completed: 0, result: oldFailure(reason) };
    await writeLedger(baseState, previous);
    const original = await fs.readFile(path.join(baseState, "ledger.json"));
    const { transport, calls } = fake();
    const result = await check(root, transport);
    expect(result.code).toBe("COMPLETE");
    expect(result.requests.map(request => request.reasonCode)).toEqual(["NONE", "NONE", "NONE"]);
    expect(await fs.readFile(path.join(baseState, "archive-v1/ledger.json"))).toEqual(original);
    expect(JSON.parse(await fs.readFile(path.join(state, "ledger.json"), "utf8"))).toMatchObject({ version: 2, attempts: 3, completed: 3 });
    const length = calls.length;
    expect(await check(root, transport)).toEqual(result);
    expect(calls).toHaveLength(length);
    expect(calls.filter(args => args[0] === "exec")).toHaveLength(3);
  });

  it.each(["LOGIN_REQUIRED", "QUOTA_EXHAUSTED", "CLI_ERROR", "TIMEOUT", "UNKNOWN"])("reprints an old %s failure without migration", async reason => {
    const { root, baseState } = await fixture();
    await fs.mkdir(baseState);
    await writeLedger(baseState, { attempts: 1, completed: 0, result: oldFailure(reason) });
    const { transport, calls } = fake();
    expect((await check(root, transport)).requests[0]!.reasonCode).toBe(reason);
    expect(calls).toHaveLength(0);
    await expect(fs.stat(path.join(baseState, "archive-v1"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["evidence", "login", "two-attempts", "new-version", "later-request"])("does not migrate ambiguous history: %s", async mode => {
    const { root, baseState } = await fixture();
    await fs.mkdir(baseState);
    const result = oldFailure();
    if (mode === "evidence") Object.assign(result.requests[0]!, { advertisedTools: 0 });
    if (mode === "login") Object.assign(result.requests[0]!, { loginRequested: true });
    if (mode === "later-request") result.requests[1]!.status = "FAIL";
    await writeLedger(baseState, { attempts: mode === "two-attempts" || mode === "later-request" ? 2 : 1,
      completed: 0, result, ...(mode === "new-version" ? { version: 2 } : {}) });
    const { transport, calls } = fake();
    expect((await check(root, transport)).requests[0]!.status).toBe("FAIL");
    expect(calls).toHaveLength(0);
  });

  it("never renews a v2 invalid-model failure", async () => {
    const { root, state } = await fixture();
    await fs.mkdir(state, { recursive: true });
    await writeLedger(state, { version: 2, attempts: 1, completed: 0, result: oldFailure("INVALID_MODEL") });
    const { transport, calls } = fake();
    expect((await check(root, transport)).requests[0]!.reasonCode).toBe("INVALID_MODEL");
    expect(calls).toHaveLength(0);
  });

  it("does not resume an interrupted migration", async () => {
    const { root, baseState, state } = await fixture();
    await fs.mkdir(state, { recursive: true });
    await writeLedger(baseState, { attempts: 1, completed: 0, result: oldFailure() });
    const { transport, calls } = fake();
    expect((await check(root, transport)).code).toBe("INCOMPLETE_NO_RETRY");
    expect(calls).toHaveLength(0);
  });

  it("allows only one concurrent migration and preserves the archived bytes", async () => {
    const { root, baseState } = await fixture();
    await fs.mkdir(baseState);
    await writeLedger(baseState, { attempts: 1, completed: 0, result: oldFailure() });
    const original = await fs.readFile(path.join(baseState, "ledger.json"));
    const { transport, calls } = fake();
    await Promise.all([check(root, transport), check(root, transport)]);
    expect(calls.filter(args => args[0] === "exec")).toHaveLength(3);
    expect(await fs.readFile(path.join(baseState, "archive-v1/ledger.json"))).toEqual(original);
  });

  it.each([
    ["Print mode: invalid model selection (--model flash --effort empty): model flash is not recognized", "INVALID_MODEL"],
    ["Authentication required", "LOGIN_REQUIRED"],
    ["Quota exhausted", "QUOTA_EXHAUSTED"],
    ["RESOURCE_EXHAUSTED", "QUOTA_EXHAUSTED"],
    ["Fetching quota summary", "CLI_ERROR"],
    ["Unexpected failure", "CLI_ERROR"],
  ])("classifies bounded CLI diagnostics: %s", async (diagnostic, reason) => {
    const { root } = await fixture();
    const { transport } = fake(async (args, options) => {
      if (args[0] === "exec") {
        options?.onOutput?.(`${diagnostic} ${sensitive}`);
        throw new PrototypeError("PROCESS_FAILED");
      }
      return { stdout: args[0] === "info" ? "arm64" : "", stderr: "" };
    });
    const result = await check(root, transport);
    expect(result.requests[0]!.reasonCode).toBe(reason);
    expect(result.requests.slice(1).every(request => request.reasonCode === "NOT_RUN")).toBe(true);
    expect(JSON.stringify(result)).not.toContain(sensitive);
    expect(JSON.stringify(result)).not.toContain(diagnostic);
  });

  it("passes authenticated completions despite answer mismatch and advertised tools", async () => {
    const { root } = await fixture();
    const stream = [
      { event: "init", conversation_id: sensitive, init: { tools: ["fixture-tool"] } },
      { event: "step_update", step_update: { step_type: "tool", tool_info: { text: sensitive } } },
      { event: "result", result: { conversation_id: sensitive, status: "SUCCESS", response: sensitive } },
    ].map(event => JSON.stringify(event)).join("\n");
    const { transport } = fake(async args => ({ stdout: args[0] === "info" ? "arm64" : args[0] === "exec" ? stream : "",
      stderr: args[0] === "exec" ? "Fetching quota summary" : "" }));
    const result = await check(root, transport);
    expect(result.code).toBe("COMPLETE");
    for (const request of result.requests) expect(request).toMatchObject({ status: "PASS", auth: "PASS", completed: true,
      protocol: "PASS", answerShape: "MISMATCH", advertisedTools: 1, observedToolEvents: 1 });
    expect(JSON.stringify(result)).not.toContain(sensitive);
  });

  it("reports a fixed parse check independently from authenticated completion", async () => {
    const { root } = await fixture();
    const { transport } = fake(async args => ({ stdout: args[0] === "info" ? "arm64" : args[0] === "exec" ?
      stdout.split("\n")[0] + '\n{"event":"unknown_fixture"}\n' + stdout.split("\n")[1] : "", stderr: "" }));
    const result = await check(root, transport);
    expect(result.code).toBe("COMPLETE");
    expect(result.requests.every(request => request.status === "PASS" && request.auth === "PASS" && request.completed === true &&
      request.protocol === "FAIL" && request.reasonCode === "UNEXPECTED_EVENT")).toBe(true);
  });

  it("keeps request 1 unchanged and sends exactly the two remaining requests", async () => {
    const { root, state } = await fixture();
    await fs.mkdir(state, { recursive: true });
    const previous = { version: 2, attempts: 1, completed: 0, result: oldFailure("PROTOCOL_ERROR") };
    await writeLedger(state, previous);
    const original = await fs.readFile(path.join(state, "ledger.json"));
    let dispatched = 1;
    const { transport, calls } = fake(async args => {
      if (args[0] === "exec") {
        dispatched++;
        const saved = JSON.parse(await fs.readFile(path.join(state, "ledger.json"), "utf8"));
        expect(saved.attempts).toBe(dispatched);
        expect(saved.result.requests[0]).toEqual(previous.result.requests[0]);
        expect(saved.continuation).toBe("REQUESTS_2_AND_3_REPLACEMENT_CONTAINER");
      }
      return { stdout: args[0] === "info" ? "arm64" : args[0] === "exec" ? stdout : "", stderr: "" };
    });
    const result = await check(root, transport);
    expect(result.code).toBe("COMPLETE_WITH_UNVERIFIED_HISTORY");
    expect(result.requests[0]).toMatchObject({ ...previous.result.requests[0], auth: null,
      completed: null, protocol: null, answerShape: null });
    expect(result.requests.slice(1).every(request => request.status === "PASS" && request.auth === "PASS" &&
      request.completed === true && request.protocol === "PASS" && request.answerShape === "MATCH")).toBe(true);
    expect(calls.filter(args => ["run", "exec", "rm"].includes(args[0]!)).map(args => args[0])).toEqual(["run", "exec", "rm", "run", "exec", "rm"]);
    const requests = calls.filter(args => args[0] === "exec");
    expect(requests).toHaveLength(2);
    expect(requests[0]![1]).not.toBe(requests[1]![1]);
    const saved = JSON.parse(await fs.readFile(path.join(state, "ledger.json"), "utf8"));
    expect(saved).toMatchObject({ version: 2, attempts: 3, completed: 2 });
    expect(saved.result.requests[0]).toEqual(previous.result.requests[0]);
    expect(await fs.readFile(path.join(state, "remaining-requests-claim/ledger-before-continuation.json"))).toEqual(original);
    const length = calls.length;
    expect(await check(root, transport)).toEqual(result);
    expect(calls).toHaveLength(length);
  });

  it("allows only one concurrent continuation", async () => {
    const { root, state } = await fixture();
    await fs.mkdir(state, { recursive: true });
    await writeLedger(state, { version: 2, attempts: 1, completed: 0, result: oldFailure("PROTOCOL_ERROR") });
    const { transport, calls } = fake();
    const results = await Promise.all([check(root, transport), check(root, transport), check(root, transport)]);
    expect(results.some(result => result.code === "COMPLETE_WITH_UNVERIFIED_HISTORY")).toBe(true);
    expect(calls.filter(args => args[0] === "exec")).toHaveLength(2);
    expect(JSON.parse(await fs.readFile(path.join(state, "ledger.json"), "utf8")).attempts).toBe(3);
  });

  it("never repairs an empty continuation claim left by an interruption", async () => {
    const { root, state } = await fixture();
    await fs.mkdir(path.join(state, "remaining-requests-claim"), { recursive: true });
    await writeLedger(state, { version: 2, attempts: 1, completed: 0, result: oldFailure("PROTOCOL_ERROR") });
    const { transport, calls } = fake();
    const result = await check(root, transport);
    expect(result.requests[0]!.reasonCode).toBe("PROTOCOL_ERROR");
    expect(calls).toHaveLength(0);
  });

  it.each(["image", "run", "timeout", "cancel", "after-second", "third-timeout"])("never restarts a continuation interrupted at %s", async mode => {
    const { root, state } = await fixture();
    await fs.mkdir(state, { recursive: true });
    const previous = oldFailure("PROTOCOL_ERROR");
    await writeLedger(state, { version: 2, attempts: 1, completed: 0, result: previous });
    const controller = new AbortController();
    let requests = 0;
    const { transport, calls } = fake(async args => {
      if (mode === "image" && args[0] === "info" && (await fs.stat(path.join(state, "remaining-requests-claim")).catch(() => null))) throw new Error(sensitive);
      if (mode === "run" && args[0] === "run") throw new Error(sensitive);
      if (args[0] === "exec") {
        requests++;
        if (mode === "timeout" || mode === "third-timeout" && requests === 2) throw new PrototypeError("TIMEOUT");
        if (mode === "cancel") { controller.abort(); throw new PrototypeError("CANCELLED"); }
      }
      if (mode === "after-second" && args[0] === "rm") controller.abort();
      return { stdout: args[0] === "info" ? "arm64" : args[0] === "exec" ? stdout : "", stderr: "" };
    });
    const result = await check(root, transport, controller.signal);
    expect(result.code).not.toBe("COMPLETE_WITH_UNVERIFIED_HISTORY");
    expect(requests).toBe(mode === "image" || mode === "run" ? 0 : mode === "third-timeout" ? 2 : 1);
    expect(result.requests[0]).toMatchObject(previous.requests[0]!);
    const saved = JSON.parse(await fs.readFile(path.join(state, "ledger.json"), "utf8"));
    expect(saved.attempts).toBe(1 + requests);
    expect(saved.result.requests[0]).toEqual(previous.requests[0]);
    expect(calls.filter(args => args[0] === "rm")).toHaveLength(mode === "image" ? 0 : mode === "third-timeout" ? 2 : 1);
    const length = calls.length;
    expect(await check(root, transport)).toEqual(result);
    expect(calls).toHaveLength(length);
  });

  it.each(["two-attempts", "completed", "cleanup", "reason", "login", "evidence", "used-slot", "version", "model", "continuation"])("does not continue an ineligible ledger: %s", async mode => {
    const { root, state } = await fixture();
    await fs.mkdir(state, { recursive: true });
    const result = oldFailure(mode === "reason" ? "CLI_ERROR" : "PROTOCOL_ERROR");
    if (mode === "cleanup") result.cleanup = "FAIL";
    if (mode === "login") Object.assign(result.requests[0]!, { loginRequested: true });
    if (mode === "evidence") Object.assign(result.requests[0]!, { protocol: "FAIL" });
    if (mode === "used-slot") result.requests[1]!.status = "FAIL";
    const saved = { version: mode === "version" ? 1 : 2, attempts: mode === "two-attempts" ? 2 : 1,
      completed: mode === "completed" ? 1 : 0, result,
      ...(mode === "model" ? { modelChoice: "OVERRIDE" } : {}),
      ...(mode === "continuation" ? { continuation: "REQUESTS_2_AND_3_REPLACEMENT_CONTAINER" as const } : {}) };
    await writeLedger(state, saved);
    const original = await fs.readFile(path.join(state, "ledger.json"));
    const { transport, calls } = fake();
    expect((await check(root, transport)).requests[0]!.status).toBe("FAIL");
    expect(calls).toHaveLength(0);
    expect(await fs.readFile(path.join(state, "ledger.json"))).toEqual(original);
  });

  it("does not consume the continuation claim on a prerequisite refusal", async () => {
    const { root, state } = await fixture();
    await fs.mkdir(state, { recursive: true });
    await writeLedger(state, { version: 2, attempts: 1, completed: 0, result: oldFailure("PROTOCOL_ERROR") });
    const original = await fs.readFile(path.join(state, "ledger.json"));
    const refused = fake(async () => { throw new Error(sensitive); });
    const result = await check(root, refused.transport);
    expect(result.code).toBe("DOCKER_UNAVAILABLE");
    expect(result.requests[0]!.status).toBe("FAIL");
    expect(await fs.readFile(path.join(state, "ledger.json"))).toEqual(original);
    await expect(fs.stat(path.join(state, "remaining-requests-claim"))).rejects.toMatchObject({ code: "ENOENT" });
    const { transport, calls } = fake();
    expect((await check(root, transport)).code).toBe("COMPLETE_WITH_UNVERIFIED_HISTORY");
    expect(calls.filter(args => args[0] === "exec")).toHaveLength(2);
  });

  it("classifies protocol failures without retaining provider text", async () => {
    const { root } = await fixture();
    const { transport } = fake(async args => ({ stdout: args[0] === "info" ? "arm64" : args[0] === "exec" ? sensitive : "", stderr: "" }));
    const result = await check(root, transport);
    expect(result.requests[0]!.reasonCode).toBe("MALFORMED_JSON");
    expect(JSON.stringify(result)).not.toContain(sensitive);
  });

  it("repairs only the repository-owned protobuf config seed", async () => {
    const { root, home } = await fixture();
    const config = path.join(home, ".gemini/config/config.json");
    await fs.mkdir(path.dirname(config), { recursive: true });
    await fs.copyFile(path.join(DOCKER_DIR, "antigravity-prototype/settings.json"), config);
    const { transport } = fake();
    expect((await check(root, transport)).code).toBe("COMPLETE");
    expect(await fs.readFile(config, "utf8")).toBe("{}\n");
    const cliOwned = '{"modelConfig":{"customModels":{}}}';
    await fs.writeFile(config, cliOwned);
    await repairSeededConfig(home);
    expect(await fs.readFile(config, "utf8")).toBe(cliOwned);
    const prototype = await prepareState(path.join(root, "prototype"));
    expect(await fs.readFile(path.join(prototype, "config/config.json"), "utf8")).toBe("{}\n");
  });

  it("does not follow config symlinks during seed repair", async () => {
    const { root, home } = await fixture();
    const outside = path.join(root, "outside-config");
    const seed = await fs.readFile(path.join(DOCKER_DIR, "antigravity-prototype/settings.json"));
    await fs.writeFile(outside, seed);
    await fs.mkdir(path.join(home, ".gemini/config"), { recursive: true });
    await fs.symlink(outside, path.join(home, ".gemini/config/config.json"));
    await expect(repairSeededConfig(home)).rejects.toThrow();
    expect(await fs.readFile(outside)).toEqual(seed);
  });

  it("serializes concurrent invocations with a permanent exclusive claim", async () => {
    const { root } = await fixture();
    const { transport, calls } = fake();
    const results = await Promise.all([check(root, transport), check(root, transport)]);
    expect(results.filter(result => result.code === "COMPLETE")).toHaveLength(1);
    expect(calls.filter(args => args[0] === "exec")).toHaveLength(3);
  });
});
