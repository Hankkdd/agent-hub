import { describe, expect, it } from "vitest";
import { inspectHeadlessProtocol } from "../scripts/antigravity-prototype/headless-protocol";

const secret = "fixture@example.invalid token=fake-token response-text";
const init = { event: "init", conversation_id: secret, init: { tools: [], agent: "hub-prototype", cwd: "/work" } };
const result = { event: "result", result: { status: "SUCCESS", conversation_id: secret,
  response: JSON.stringify({ hunks: [{ id: "synthetic-1", explanation: "\u6e2c\u8a66" }] }) } };
const encode = (...events: unknown[]) => events.map(event => JSON.stringify(event)).join("\n");

describe("headless protocol evidence (fixtures only)", () => {
  it("separates successful auth and completion from a mismatched answer", () => {
    const evidence = inspectHeadlessProtocol(encode(init, { ...result, result: { ...result.result, response: secret } }), "Print mode: silent auth succeeded");
    expect(evidence).toMatchObject({ auth: "PASS", completed: true, protocol: "PASS", answerShape: "MISMATCH", reasonCode: "NONE" });
    expect(JSON.stringify(evidence)).not.toContain(secret);
  });

  it("reuses the synthetic shape check and reports a match", () => {
    expect(inspectHeadlessProtocol(encode(init, result))).toMatchObject({ auth: "PASS", completed: true,
      protocol: "PASS", answerShape: "MATCH", structuredHunks: 1 });
  });

  it("reports tool metadata without failing authentication or completion", () => {
    const evidence = inspectHeadlessProtocol(encode({ ...init, init: { ...init.init, tools: ["fixture-tool"] } },
      { event: "step_update", step_update: { step_type: "tool", state: "DONE", tool_info: { response: secret } } }, result));
    expect(evidence).toMatchObject({ auth: "PASS", completed: true, protocol: "PASS", advertisedTools: 1, observedToolEvents: 1 });
    expect(JSON.stringify(evidence)).not.toContain(secret);
    expect(JSON.stringify(evidence)).not.toContain("fixture-tool");
  });

  it.each([
    [encode(result), "NO_INIT_EVENT"],
    [encode(init), "NO_RESULT_EVENT"],
    [encode(init, { event: "result", result: { status: "FAILURE", error: secret } }), "RESULT_NOT_SUCCESS"],
    [encode(init, { event: "unknown_fixture", details: secret }, result), "UNEXPECTED_EVENT"],
    [`${secret}\n${encode(init, result)}`, "MALFORMED_JSON"],
    [encode({ event: "init", init: null }, result), "INVALID_INIT_EVENT"],
    [encode(init, { event: "result", result: null }), "MALFORMED_RESULT"],
    [encode(init, { ...result, result: { ...result.result, conversation_id: "different-fixture" } }), "CONVERSATION_MISMATCH"],
    [encode(init, result, result), "AFTER_RESULT"],
    ["x".repeat(65537), "OUTPUT_LIMIT"],
  ])("returns a fixed stream check: %s", (stdout, reasonCode) => {
    const evidence = inspectHeadlessProtocol(stdout);
    expect(evidence.protocol).toBe("FAIL");
    expect(evidence.reasonCode).toBe(reasonCode);
    expect(JSON.stringify(evidence)).not.toContain(secret);
  });

  it("does not let benign stderr diagnostics invalidate parsed stream-json", () => {
    expect(inspectHeadlessProtocol(encode(init, result), `Fetching quota summary ${secret}`)).toMatchObject({
      auth: "PASS", completed: true, protocol: "PASS", answerShape: "MATCH", reasonCode: "NONE",
    });
  });

  it("keeps explicit login failures distinct from terminal success", () => {
    expect(inspectHeadlessProtocol(encode(init, result), "Authentication required")).toMatchObject({
      auth: "FAIL", completed: true, protocol: "PASS", loginRequested: true,
    });
    expect(inspectHeadlessProtocol(encode(init), "Print mode: silent auth succeeded")).toMatchObject({
      auth: "PASS", completed: false, protocol: "FAIL", reasonCode: "NO_RESULT_EVENT",
    });
  });

  it("retains success evidence when a separate stream check fails", () => {
    expect(inspectHeadlessProtocol(encode(init, { event: "unknown_fixture" }, result))).toMatchObject({
      auth: "PASS", completed: true, protocol: "FAIL", reasonCode: "UNEXPECTED_EVENT",
    });
  });
});
