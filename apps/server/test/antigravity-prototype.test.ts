import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PrototypeError, verifyProtocol } from "../scripts/antigravity-prototype/protocol";
import { ContainerCleanupError, runProcess, ownedContainer, type Docker } from "../scripts/antigravity-prototype/process";
import { cleanupOwned, containerArgs, prepareState, IMAGE, liveRequests, verifyCliHelp } from "../scripts/antigravity-prototype";
import { imageTag } from "../src/docker/images";
const init = { event: "init", conversation_id: "fake", init: { cwd: "/work", agent: "hub-prototype", tools: [] as string[] } };
const result = { event: "result", result: { conversation_id: "fake", status: "SUCCESS", response: JSON.stringify({ hunks: [{ id: "synthetic-1", explanation: "Synthetic fixture: \u589e\u52a0\u91cd\u8a66\u6b21\u6578\u3002" }] }) } };
const encode = (...events: unknown[]) => events.map(e => JSON.stringify(e)).join("\n");
describe("prototype protocol (fixtures only)", () => {
  it("requires zero advertised tools and leaves complete removal unverified", () => {
    expect(verifyProtocol(encode(init, result))).toMatchObject({ advertisedTools: 0, observedToolEvents: 0, strictIsolation: "UNVERIFIED" });
    for (const tool of ["read_file", "mcp/server/tool", "browse", "invoke_subagent", "ask_permission"]) {
      expect(() => verifyProtocol(encode({ ...init, init: { ...init.init, tools: [tool] } }, result))).toThrow("INHERITED_TOOLS");
    }
    expect(() => verifyProtocol(encode({ ...init, init: { ...init.init, tools: undefined } }, result))).toThrow();
    expect(() => verifyProtocol(encode({ ...init, init: { ...init.init, plugins: [] } }, result))).toThrow();
    expect(() => verifyProtocol(encode({ ...init, init: { ...init.init, agent: "default" } }, result))).toThrow();
  });
  it("rejects attempted, executed and denied tools even with an empty init", () => {
    for (const step of [{ step_type: "tool" }, { step_type: "agent_response", tool_info: {} },
      { step_type: "agent_response", subagent_info: {} }, { step_type: "agent_response", warning: "denied" }]) {
      expect(() => verifyProtocol(encode(init, { event: "step_update", step_update: { state: "DONE", ...step } }, result))).toThrow("TOOL_OR_UNKNOWN_ACTIVITY");
    }
    expect(() => verifyProtocol(encode(init, result), "action denied")).toThrow("PROVIDER_DIAGNOSTIC");
  });
  it("uses final response alone despite duplicate and partial deltas", () => {
    const step = { event: "step_update", step_update: { step_type: "agent_response", state: "ACTIVE", text_delta: "incomplete{" } };
    expect(verifyProtocol(encode(init, step, step, result)).steps).toBe(2);
    expect(() => verifyProtocol(encode(init, step, { ...result, result: { ...result.result, status: "SUCCESS", response: "{" } }))).toThrow("MALFORMED_RESPONSE");
  });
  it("rejects malformed, missing, repeated and non-success terminal results", () => {
    for (const text of ["not-json", encode(init), encode(result), encode(init, init, result), encode(init, result, result),
      encode(init, { event: "new_vendor_event" }), encode(init, { ...result, result: { ...result.result, status: "TIMEOUT" } }),
      encode(init, { ...result, result: { ...result.result, error: "quota secret@example.invalid token=secret" } })]) {
      expect(() => verifyProtocol(text)).toThrow();
    }
  });
  it("never includes auth/quota diagnostics or provider response in errors", () => {
    for (const diagnostic of ["authentication required secret@example.invalid", "quota exhausted token=secret"]) {
      try { verifyProtocol(encode(init, result), diagnostic); throw new Error("expected failure"); }
      catch (error) { expect(String(error)).toBe("Error: PROVIDER_DIAGNOSTIC"); }
    }
    expect(() => verifyProtocol("x".repeat(65537))).toThrow("OUTPUT_LIMIT");
  });
});
describe("scripted processes and owned container lifecycle", () => {
  it("accepts successful help on either stream, including Go-style stderr help", async () => {
    for (const channel of ["stdout", "stderr"]) {
      const output = await runProcess(process.execPath, ["-e", `process.${channel}.write('--agent --output-format --print')`]);
      expect(() => verifyCliHelp(output)).not.toThrow();
    }
    expect(() => verifyCliHelp({ stdout: "--agent", stderr: "--output-format --print" })).not.toThrow();
    expect(() => verifyCliHelp({ stdout: "--agent", stderr: "--print" })).toThrow("UNSUPPORTED_CLI_FLAGS");
    // Help handling must not relax the model protocol's diagnostic policy.
    expect(() => verifyProtocol(encode(init, result), "--agent --output-format --print")).toThrow("PROVIDER_DIAGNOSTIC");
  });
  it("bounds stdout and stderr without leaking output", async () => {
    for (const channel of ["stdout", "stderr"]) await expect(runProcess(process.execPath, ["-e", `process.${channel}.write('secret'.repeat(10000))`], { maxBytes: 50 })).rejects.toThrow("OUTPUT_LIMIT");
  });
  it("handles timeout, signals and cancellation", async () => {
    await expect(runProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], { timeoutMs: 30 })).rejects.toThrow("TIMEOUT");
    await expect(runProcess(process.execPath, ["-e", "process.kill(process.pid,'SIGTERM')"])).rejects.toThrow("PROCESS_FAILED");
    const controller = new AbortController();
    const pending = runProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow("CANCELLED");
    await expect(runProcess(process.execPath, [], { signal: controller.signal })).rejects.toThrow("CANCELLED");
  });
  it("removes containers after success, failure, partial startup and cancellation", async () => {
    for (const scenario of ["success", "failure", "startup", "cancel"]) {
      const calls: string[][] = [];
      const transport: Docker = async args => { calls.push(args); if (scenario === "startup" && args[0] === "run") throw new Error("start failed"); return { stdout: "", stderr: "" }; };
      const action = ownedContainer(transport, "owned", ["image"], async () => {
        if (scenario !== "success") throw new Error(scenario); return 1;
      });
      if (scenario === "success") expect(await action).toBe(1); else await expect(action).rejects.toThrow();
      expect(calls.at(-1)).toEqual(["rm", "--force", "owned"]);
    }
  });
  it("limits orphan cleanup to both prototype and state-owner labels", async () => {
    const calls: string[][] = [];
    const transport: Docker = async args => { calls.push(args); return { stdout: args[0] === "ps" ? "abcdef123456\n" : "", stderr: "" }; };
    expect(await cleanupOwned(transport, "state-owner")).toBe(1);
    expect(calls[0]).toContain("label=io.agent-hub.antigravity-prototype=true");
    expect(calls[0]).toContain("label=io.agent-hub.antigravity-prototype.owner=state-owner");
    expect(calls[1]).toEqual(["rm", "--force", "abcdef123456"]);
  });
  it("reports cleanup failure rather than claiming cleanup passed", async () => {
    const transport: Docker = async args => { if (args[0] === "rm") throw new Error("cleanup failed"); return { stdout: "", stderr: "" }; };
    await expect(ownedContainer(transport, "owned", [], async () => 1)).rejects.toThrow("cleanup failed");
  });
  it("preserves both failures while reporting only safe diagnostic codes", async () => {
    const primary = new PrototypeError("TIMEOUT");
    const cleanup = new PrototypeError("PROCESS_FAILED");
    const transport: Docker = async args => { if (args[0] === "rm") throw cleanup; return { stdout: "", stderr: "" }; };
    const failure = await ownedContainer(transport, "owned", [], async () => { throw primary; }).catch(error => error);
    expect(failure).toBeInstanceOf(ContainerCleanupError);
    expect(failure.cause.errors).toEqual([primary, cleanup]);
    expect(failure).toMatchObject({ code: "CONTAINER_CLEANUP_FAILED", primaryCode: "TIMEOUT", cleanupCode: "PROCESS_FAILED" });
    const secret = new Error("fake-token=fake-secret account@example.invalid");
    const redacted = new ContainerCleanupError(secret, secret);
    expect(JSON.stringify({ code: redacted.code, primaryCode: redacted.primaryCode, cleanupCode: redacted.cleanupCode })).not.toContain("fake-secret");
    expect(redacted.primaryCode).toBe("LOCAL_PREREQUISITE_FAILED");
  });
});
describe("isolated state (temporary paths, no accounts)", () => {
  it("reuses only intended state and overwrites configuration on fresh invocations", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "agy-test-"));
    try {
      const state = await prepareState(root);
      await fs.writeFile(path.join(state, "auth", "fake-credential"), "fake-only", { mode: 0o600 });
      await fs.writeFile(path.join(state, "settings.json"), '{"useG1Credits":true}');
      await fs.writeFile(path.join(state, "config", "agents", "inherited.md"), "unexpected inherited agent");
      expect(await prepareState(root)).toBe(state);
      expect(await fs.readFile(path.join(state, "auth", "fake-credential"), "utf8")).toBe("fake-only");
      await expect(fs.stat(path.join(state, "config", "agents", "inherited.md"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(JSON.parse(await fs.readFile(path.join(state, "settings.json"), "utf8")).useG1Credits).toBe(false);
      expect((await fs.stat(state)).mode & 0o777).toBe(0o700);
      expect((await fs.stat(path.join(state, "settings.json"))).mode & 0o777).toBe(0o600);
      const args = containerArgs(state, "pinned-image", "owner");
      expect(args.filter(arg => arg.startsWith("type=bind"))).toHaveLength(3);
      for (const mount of args.filter(arg => arg.startsWith("type=bind"))) expect(mount).toContain(`src=${state}/`);
      expect(args).toContain("--read-only"); expect(args).toContain("--log-driver=none");
      expect(args).not.toContain("--privileged");
      expect(imageTag(IMAGE)).toMatch(/^agent-hub-antigravity-prototype:1\.3\.6-[a-f0-9]{10}$/);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  it("rejects public or aliased credential files without reading them", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "agy-permissions-"));
    try {
      const state = await prepareState(root);
      const credential = path.join(state, "auth", "fake-only");
      await fs.writeFile(credential, "fake-only", { mode: 0o644 });
      await expect(prepareState(root)).rejects.toThrow("UNSAFE_AUTH_STATE");
      await fs.chmod(credential, 0o600);
      await fs.symlink(credential, path.join(state, "auth", "alias"));
      await expect(prepareState(root)).rejects.toThrow("UNSAFE_AUTH_STATE");
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  it("rejects state aliases and credential/config symlinks", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "agy-test-"));
    try {
      await fs.symlink(root, path.join(root, "alias"));
      await expect(prepareState(path.join(root, "alias"))).rejects.toThrow("UNSAFE_STATE_PATH");
      const state = await prepareState(root);
      await fs.rm(path.join(state, "settings.json"));
      await fs.symlink(path.join(state, "config", "config.json"), path.join(state, "settings.json"));
      await expect(prepareState(root)).rejects.toThrow("UNSAFE_STATE_PATH");
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});

// The transport returns scripted protocol only; these tests never start Docker or a model.
describe("live sequence budget and restart bookkeeping (fake transport)", () => {
  it("runs two fresh CLI processes, then one recreated-container request in a new runner", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "agy-sequence-"));
    try {
      const state = await prepareState(root);
      const calls: string[][] = [], evidence: unknown[] = [];
      const transport: Docker = async args => { calls.push(args); return { stdout: encode(init, result), stderr: "" }; };
      await liveRequests(transport, state, "container-one", "live-initial", "runner-one", undefined, e => evidence.push(e));
      expect(calls).toHaveLength(2);
      expect(calls.every(args => args[1] === "container-one" && args.includes("--print") === false && args.includes("-p"))).toBe(true);
      await expect(liveRequests(transport, state, "container-two", "live-restart", "runner-one")).rejects.toThrow("INITIAL_NOT_VERIFIED");
      await liveRequests(transport, state, "container-two", "live-restart", "runner-two", undefined, e => evidence.push(e));
      expect(calls).toHaveLength(3); expect(calls[2]?.[1]).toBe("container-two");
      expect(evidence).toHaveLength(3);
      await expect(liveRequests(transport, state, "container-three", "live-initial", "runner-three")).rejects.toThrow("INITIAL_ALREADY_ATTEMPTED");
      await expect(liveRequests(transport, state, "container-three", "live-restart", "runner-three")).rejects.toThrow("INITIAL_NOT_VERIFIED");
      expect(calls).toHaveLength(3);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
  it("charges failed attempts before dispatch and refuses to infer auth from a file", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "agy-sequence-"));
    try {
      const state = await prepareState(root);
      await fs.writeFile(path.join(state, "auth", "fake-token"), "fake-only");
      let calls = 0;
      const transport: Docker = async () => { calls++; return { stdout: "", stderr: "authentication required fake-secret" }; };
      await expect(liveRequests(transport, state, "one", "live-initial", "runner-one")).rejects.toThrow("PROVIDER_DIAGNOSTIC");
      expect(JSON.parse(await fs.readFile(path.join(state, "ledger.json"), "utf8"))).toMatchObject({ attempts: 1, completed: 0 });
      await expect(liveRequests(transport, state, "two", "live-restart", "runner-two")).rejects.toThrow("INITIAL_NOT_VERIFIED");
      expect(calls).toBe(1);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});
